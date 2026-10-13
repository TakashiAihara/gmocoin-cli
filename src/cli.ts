#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { runBacktest, type StrategyFactory } from "./backtest.ts";
import {
  csvEvents,
  csvFileDates,
  DEFAULT_TRADES_CSV_URL,
  ensureCsv,
  recordEvents,
} from "./market-data.ts";
import { CHANNELS, DEFAULT_PUBLIC_WS_URL, startRecorder, type Channel } from "./record.ts";

function collect<T>(parse: (v: string) => T) {
  return (value: string, prev: T[] = []) => [...prev, parse(value)];
}

function parseSymbol(v: string): string {
  if (!/^[A-Z0-9_]+$/.test(v)) {
    throw new InvalidArgumentError("symbol must match ^[A-Z0-9_]+$");
  }
  return v;
}

function parseChannel(v: string): Channel {
  const channel = CHANNELS.find((c) => c === v);
  if (!channel) throw new InvalidArgumentError(`channel must be one of ${CHANNELS.join(", ")}`);
  return channel;
}

type Source = "csv" | "record";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
// 判定の基準。テスト期間の PnL が正で、最大ドローダウンがこの % 以下なら pass
const MAX_DRAWDOWN_PCT = 20;

function parseTime(v: string): number {
  if (!DATE_ONLY.test(v) && !ISO_WITH_ZONE.test(v)) {
    throw new InvalidArgumentError("time must be YYYY-MM-DD (UTC) or ISO 8601 with a zone");
  }
  // ゾーンの無い時刻はローカル時刻として解釈されてしまうので受け付けない
  const ms = Date.parse(DATE_ONLY.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms)) throw new InvalidArgumentError(`not a valid time: ${v}`);
  return ms;
}

function parseSource(v: string): Source {
  if (v !== "csv" && v !== "record") throw new InvalidArgumentError("source must be csv or record");
  return v;
}

function parseNumber(v: string): number {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) throw new InvalidArgumentError(`not a number: ${v}`);
  return n;
}

async function loadStrategy(path: string): Promise<StrategyFactory> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error(`${path} must default-export a strategy factory`);
  }
  return mod.default as StrategyFactory;
}

async function csvPaths(opts: { data: string; symbol: string; from: number; to: number }) {
  const baseUrl = process.env.GMOCOIN_TRADES_CSV_URL || DEFAULT_TRADES_CSV_URL;
  const paths: string[] = [];
  for (const date of csvFileDates(opts.from, opts.to)) {
    paths.push(await ensureCsv({ dataDir: opts.data, symbol: opts.symbol, date, baseUrl }));
  }
  return paths;
}

type BacktestOpts = {
  strategy: string;
  from: number;
  to: number;
  split?: number;
  source: Source;
  data: string;
  symbol: string;
  capital: number;
  latencyMs: number;
  slippageBps: number;
};

async function backtestReport(opts: BacktestOpts) {
  if (opts.from >= opts.to) throw new Error("--to must be after --from");
  if (opts.split !== undefined && (opts.split <= opts.from || opts.split >= opts.to)) {
    throw new Error("--split must be after --from and before --to");
  }
  if (opts.capital <= 0) throw new Error("--capital must be positive");
  if (opts.latencyMs < 0) throw new Error("--latency-ms must not be negative");
  if (opts.slippageBps < 0) throw new Error("--slippage-bps must not be negative");

  const periods =
    opts.split === undefined
      ? [{ name: "all", from: opts.from, to: opts.to }]
      : [
          { name: "train", from: opts.from, to: opts.split },
          { name: "test", from: opts.split, to: opts.to },
        ];
  const factory = await loadStrategy(opts.strategy);
  const paths =
    opts.source === "csv"
      ? await csvPaths({ data: opts.data, symbol: opts.symbol, from: opts.from, to: opts.to })
      : [];

  const results = [];
  for (const period of periods) {
    const events =
      opts.source === "csv"
        ? csvEvents({ paths, from: period.from, to: period.to })
        : recordEvents({
            dataDir: opts.data,
            symbol: opts.symbol,
            from: period.from,
            to: period.to,
          });
    const result = await runBacktest({
      events,
      strategy: factory(),
      fillModel: opts.source === "csv" ? "trades" : "book",
      capital: opts.capital,
      latencyMs: opts.latencyMs,
      slippageBps: opts.slippageBps,
    });
    if (result.fills === 0) throw new Error(`period "${period.name}" has no fills`);
    results.push({
      name: period.name,
      from: new Date(period.from).toISOString(),
      to: new Date(period.to).toISOString(),
      ...result,
    });
  }

  // 学習期間を除いた最後の期間 (分割なしなら唯一の "all") で判定する
  const judged = results.findLast((r) => r.name !== "train");
  const pass = judged !== undefined && judged.pnl > 0 && judged.maxDrawdownPct <= MAX_DRAWDOWN_PCT;
  return { symbol: opts.symbol, source: opts.source, periods: results, pass };
}

const program = new Command().name("gmocoin").description("CLI for the GMO Coin API");

program
  .command("record")
  .description("record Public WebSocket orderbooks and trades as gzip JSONL")
  .option("--symbol <symbol>", "symbol to record, repeatable (default BTC)", collect(parseSymbol))
  .option(
    "--channel <channel>",
    "channel to record, repeatable (default orderbooks and trades)",
    collect(parseChannel),
  )
  .option("--out <dir>", "output directory", "./data")
  .action((opts: { symbol?: string[]; channel?: Channel[]; out: string }) => {
    const symbols = opts.symbol ?? ["BTC"];
    const channels = opts.channel ?? CHANNELS;
    const recorder = startRecorder({
      url: process.env.GMOCOIN_PUBLIC_WS_URL || DEFAULT_PUBLIC_WS_URL,
      outDir: opts.out,
      subscriptions: channels.flatMap((channel) => symbols.map((symbol) => ({ channel, symbol }))),
      onFatal: () => void exitAfterStop(1),
    });

    async function exitAfterStop(code: number) {
      try {
        await recorder.stop();
      } catch (e) {
        console.error(e);
      }
      process.exit(code);
    }

    process.on("SIGINT", () => void exitAfterStop(0));
    process.on("SIGTERM", () => void exitAfterStop(0));
    const crash = (err: unknown) => {
      console.error(err);
      void exitAfterStop(1);
    };
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
  });

program
  .command("backtest")
  .description("replay trades through a strategy over one or two periods and print JSON")
  .requiredOption("--strategy <path>", "strategy file whose default export is a factory")
  .requiredOption(
    "--from <time>",
    "start, inclusive (YYYY-MM-DD as UTC midnight or ISO 8601)",
    parseTime,
  )
  .requiredOption(
    "--to <time>",
    "end, exclusive (YYYY-MM-DD as UTC midnight or ISO 8601)",
    parseTime,
  )
  .option("--split <time>", "train [from, split) and test [split, to)", parseTime)
  .option("--source <source>", "csv or record", parseSource, "csv")
  .option("--data <dir>", "data directory (csv cache or record files)", "./data")
  .option("--symbol <symbol>", "symbol to replay", parseSymbol, "BTC")
  .option("--capital <jpy>", "starting cash in JPY", parseNumber, 10000)
  .option("--latency-ms <ms>", "order latency in milliseconds", parseNumber, 0)
  .option("--slippage-bps <bps>", "slippage for market orders, csv source only", parseNumber, 0)
  .action(async (opts: BacktestOpts) => {
    try {
      console.log(JSON.stringify(await backtestReport(opts), null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

await program.parseAsync();
