#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  DEFAULT_MAKER_FEE_BPS,
  DEFAULT_TAKER_FEE_BPS,
  runBacktest,
  type StrategyFactory,
} from "./backtest.ts";
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

// 数量の刻みと値段の刻みは BTC 現物の値で固定している
function parseBacktestSymbol(v: string): string {
  if (v !== "BTC") throw new InvalidArgumentError("backtest supports BTC (spot) only");
  return v;
}

async function loadStrategy(path: string): Promise<StrategyFactory> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error(`${path} must default-export a strategy factory`);
  }
  return mod.default as StrategyFactory;
}

// ranges は [from, to) の並び。重なる日は 1 度だけ取る
async function csvPaths(opts: { data: string; symbol: string; ranges: [number, number][] }) {
  const baseUrl = process.env.GMOCOIN_TRADES_CSV_URL || DEFAULT_TRADES_CSV_URL;
  const paths: string[] = [];
  const dates = [...new Set(opts.ranges.flatMap(([from, to]) => csvFileDates(from, to)))].sort();
  for (const [i, date] of dates.entries()) {
    const cached = existsSync(join(opts.data, "csv", opts.symbol, `${date}_${opts.symbol}.csv.gz`));
    if (!cached) console.error(`fetching CSV ${date} (${i + 1}/${dates.length})`);
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
  makerFeeBps: number;
  takerFeeBps: number;
  warmupDays: number;
};

const DAY_MS = 86_400_000;

async function backtestReport(opts: BacktestOpts) {
  if (opts.from >= opts.to) throw new Error("--to must be after --from");
  if (opts.split !== undefined && (opts.split <= opts.from || opts.split >= opts.to)) {
    throw new Error("--split must be after --from and before --to");
  }
  if (opts.capital <= 0) throw new Error("--capital must be positive");
  if (opts.latencyMs < 0) throw new Error("--latency-ms must not be negative");
  if (opts.slippageBps < 0) throw new Error("--slippage-bps must not be negative");
  if (opts.takerFeeBps < 0 || opts.takerFeeBps >= 10_000) {
    throw new Error("--taker-fee-bps must be at least 0 and below 10000");
  }
  if (Math.abs(opts.makerFeeBps) >= 10_000) {
    throw new Error("--maker-fee-bps must be above -10000 and below 10000");
  }
  if (opts.warmupDays < 0) throw new Error("--warmup-days must not be negative");
  const warmupMs = opts.warmupDays * DAY_MS;

  const periods =
    opts.split === undefined
      ? [{ name: "all", from: opts.from, to: opts.to }]
      : [
          { name: "train", from: opts.from, to: opts.split },
          { name: "test", from: opts.split, to: opts.to },
        ];
  const factory = await loadStrategy(opts.strategy);
  // 戦略の温めは record にも過去分が無いので、どちらの source でも約定 CSV から流す
  const ranges = periods.flatMap((p): [number, number][] => [
    ...(warmupMs > 0 ? [[p.from - warmupMs, p.from] as [number, number]] : []),
    ...(opts.source === "csv" ? [[p.from, p.to] as [number, number]] : []),
  ]);
  const paths = await csvPaths({ data: opts.data, symbol: opts.symbol, ranges });
  // 取得は全期間で 1 回にし、読むのは範囲を覆うファイルだけにする
  const csvRange = (from: number, to: number) => {
    const names = new Set(csvFileDates(from, to).map((d) => `${d}_${opts.symbol}.csv.gz`));
    const found = paths.filter((p) => names.has(basename(p)));
    // 取った日と読む日がずれたら、データが黙って短くなる前に止める
    const missing = [...names].filter((n) => !found.some((p) => basename(p) === n));
    if (missing.length > 0) throw new Error(`CSV ${missing.join(", ")} was not fetched`);
    return csvEvents({ paths: found, from, to });
  };

  const results = [];
  for (const period of periods) {
    const events =
      opts.source === "csv"
        ? csvRange(period.from, period.to)
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
      makerFeeBps: opts.makerFeeBps,
      takerFeeBps: opts.takerFeeBps,
      warmup: warmupMs > 0 ? csvRange(period.from - warmupMs, period.from) : undefined,
    });
    if (result.events === 0) throw new Error(`period "${period.name}" has no market data`);
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

type ReplayOpts = { from: number; to: number; source: Source; data: string; symbol: string };

async function replay(opts: ReplayOpts) {
  if (opts.from >= opts.to) throw new Error("--to must be after --from");
  const events =
    opts.source === "csv"
      ? csvEvents({
          paths: await csvPaths({
            data: opts.data,
            symbol: opts.symbol,
            ranges: [[opts.from, opts.to]],
          }),
          from: opts.from,
          to: opts.to,
        })
      : recordEvents({ dataDir: opts.data, symbol: opts.symbol, from: opts.from, to: opts.to });

  // 1 行ずつ書くと 1,700 万件で遅いので、まとめて書く
  const out = Bun.stdout.writer();
  let n = 0;
  for await (const e of events) {
    out.write(JSON.stringify(e) + "\n");
    if (++n % 10_000 === 0) await out.flush();
  }
  await out.end();
  if (n === 0) throw new Error("no market data in the range");
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
  .option("--symbol <symbol>", "symbol to replay (BTC only)", parseBacktestSymbol, "BTC")
  .option("--capital <jpy>", "starting cash in JPY", parseNumber, 10000)
  .option("--latency-ms <ms>", "order latency in milliseconds", parseNumber, 0)
  .option("--slippage-bps <bps>", "slippage for market orders, csv source only", parseNumber, 0)
  .option(
    "--maker-fee-bps <bps>",
    "fee on maker fills, negative for a rebate",
    parseNumber,
    DEFAULT_MAKER_FEE_BPS,
  )
  .option("--taker-fee-bps <bps>", "fee on taker fills", parseNumber, DEFAULT_TAKER_FEE_BPS)
  .option(
    "--warmup-days <days>",
    "feed the strategy CSV trades for this many days before each period, without trading",
    parseNumber,
    0,
  )
  .action(async (opts: BacktestOpts) => {
    try {
      console.log(JSON.stringify(await backtestReport(opts), null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("replay")
  .description("print market data in [from, to) as JSONL, one trade or book per line in time order")
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
  .option("--source <source>", "csv or record", parseSource, "csv")
  .option("--data <dir>", "data directory (csv cache or record files)", "./data")
  .option("--symbol <symbol>", "symbol to replay", parseSymbol, "BTC")
  .action(async (opts: ReplayOpts) => {
    try {
      await replay(opts);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

await program.parseAsync();
