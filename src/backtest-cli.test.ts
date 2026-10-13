import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { tempDir } from "./test-helpers.ts";

const CLI = join(import.meta.dir, "cli.ts");

let dir: { path: string; cleanup(): void } | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  dir?.cleanup();
  server = undefined;
  dir = undefined;
});

// 期間ごとに最初の約定で 0.0001 BTC を成行で 1 回だけ買う
const BUY_ONCE = `
export default function () {
  let placed = false;
  return {
    onTrade() {
      if (placed) return;
      placed = true;
      return [{ type: "market", side: "BUY", size: 0.0001 }];
    },
  };
}
`;

const CSV_1012 = [
  "symbol,side,size,price,timestamp",
  "BTC,BUY,0.0010,10000000.000,2026-10-12 01:00:00.000",
  "BTC,BUY,0.0010,10000000.000,2026-10-12 02:00:00.000",
  "BTC,BUY,0.0010,10000000.000,2026-10-12 13:00:00.000",
  "BTC,BUY,0.0010,11000000.000,2026-10-12 14:00:00.000",
  "BTC,BUY,0.0010,12000000.000,2026-10-12 15:00:00.000",
  "",
].join("\n");

const CSV_1013 = [
  "symbol,side,size,price,timestamp",
  "BTC,SELL,0.0010,9000000.000,2026-10-12 22:00:00.000",
  "",
].join("\n");

function setup(files: Record<string, string>) {
  dir = tempDir();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const body = files[new URL(req.url).pathname];
      return body === undefined
        ? new Response("no", { status: 404 })
        : new Response(gzipSync(body));
    },
  });
  const strategy = join(dir.path, "buy-once.ts");
  writeFileSync(strategy, BUY_ONCE);
  return {
    strategy,
    data: join(dir.path, "data"),
    url: `http://127.0.0.1:${server.port}/data/trades`,
  };
}

async function backtest(args: string[], url = "http://127.0.0.1:9/none") {
  const p = Bun.spawn(["bun", CLI, "backtest", ...args], {
    env: { ...process.env, GMOCOIN_TRADES_CSV_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await p.exited;
  return {
    code,
    stdout: await new Response(p.stdout).text(),
    stderr: await new Response(p.stderr).text(),
  };
}

const BOTH_DAYS = {
  "/data/trades/BTC/2026/10/20261012_BTC.csv.gz": CSV_1012,
  "/data/trades/BTC/2026/10/20261013_BTC.csv.gz": CSV_1013,
};

test("--help lists the backtest command", async () => {
  const p = Bun.spawn(["bun", CLI, "--help"], { stdout: "pipe" });
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toContain("backtest");
});

test("backtest splits train and test, runs a fresh strategy in each, and fails the test period that loses", async () => {
  const { strategy, data, url } = setup(BOTH_DAYS);
  const r = await backtest(
    [
      "--strategy",
      strategy,
      "--data",
      data,
      "--from",
      "2026-10-12",
      "--to",
      "2026-10-13",
      "--split",
      "2026-10-12T12:00:00Z",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.symbol).toBe("BTC");
  expect(out.source).toBe("csv");
  expect(out.periods.map((p: { name: string }) => p.name)).toEqual(["train", "test"]);

  const [train, testPeriod] = out.periods;
  expect(train.from).toBe("2026-10-12T00:00:00.000Z");
  expect(train.to).toBe("2026-10-12T12:00:00.000Z");
  expect(train.fills).toBe(1);
  expect(train.pnl).toBeCloseTo(-0.5, 9);
  expect(testPeriod.from).toBe("2026-10-12T12:00:00.000Z");
  expect(testPeriod.to).toBe("2026-10-13T00:00:00.000Z");
  expect(testPeriod.fills).toBe(1);
  expect(testPeriod.events).toBe(4);
  expect(testPeriod.pnl).toBeCloseTo(-200.55, 9);
  // 15:00 の 10,099.45 から 22:00 の 9,799.45 への下落
  expect(testPeriod.maxDrawdownPct).toBeCloseTo((300 / 10_099.45) * 100, 9);
  expect(out.pass).toBe(false);
});

test("backtest passes a single period with a profit and a drawdown within 20%", async () => {
  const { strategy, data, url } = setup(BOTH_DAYS);
  const r = await backtest(
    [
      "--strategy",
      strategy,
      "--data",
      data,
      "--from",
      "2026-10-12T12:00:00Z",
      "--to",
      "2026-10-12T20:00:00Z",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.periods.map((p: { name: string }) => p.name)).toEqual(["all"]);
  expect(out.periods[0].startEquity).toBe(10_000);
  expect(out.periods[0].pnl).toBeCloseTo(99.45, 9);
  expect(out.pass).toBe(true);
});

test("backtest uses --capital and --slippage-bps", async () => {
  const { strategy, data, url } = setup(BOTH_DAYS);
  const r = await backtest(
    [
      "--strategy",
      strategy,
      "--data",
      data,
      "--from",
      "2026-10-12T12:00:00Z",
      "--to",
      "2026-10-12T20:00:00Z",
      "--capital",
      "50000",
      "--slippage-bps",
      "100",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const p = JSON.parse(r.stdout).periods[0];
  expect(p.startEquity).toBe(50_000);
  // 11,000,000 × 1.01 で 0.0001 BTC を買い、12,000,000 で評価する
  expect(p.pnl).toBeCloseTo(1200 - 1111 - 1111 * 0.0005, 9);
});

test("backtest exits 1 naming the day when a CSV is not published", async () => {
  const { strategy, data, url } = setup({
    "/data/trades/BTC/2026/10/20261012_BTC.csv.gz": CSV_1012,
  });
  const r = await backtest(
    ["--strategy", strategy, "--data", data, "--from", "2026-10-12", "--to", "2026-10-13"],
    url,
  );
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("20261013");
  expect(r.stdout).toBe("");
});

test("backtest exits 1 when a period has no trades instead of reporting a zero result", async () => {
  const { strategy, data, url } = setup(BOTH_DAYS);
  const r = await backtest(
    [
      "--strategy",
      strategy,
      "--data",
      data,
      "--from",
      "2026-10-12T03:00:00Z",
      "--to",
      "2026-10-12T20:00:00Z",
      "--split",
      "2026-10-12T12:00:00Z",
    ],
    url,
  );
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("train");
  expect(r.stdout).toBe("");
});

test("backtest rejects a split outside the range and a range that ends before it starts", async () => {
  const { strategy, data } = setup({});
  const bad = [
    ["--from", "2026-10-12", "--to", "2026-10-13", "--split", "2026-10-14"],
    ["--from", "2026-10-13", "--to", "2026-10-12"],
    ["--from", "yesterday", "--to", "2026-10-12"],
  ];
  for (const args of bad) {
    const r = await backtest(["--strategy", strategy, "--data", data, ...args]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
  }
});

test("backtest with --source record fills a market order against the recorded book", async () => {
  dir = tempDir();
  const strategy = join(dir.path, "buy-once.ts");
  writeFileSync(strategy, BUY_ONCE);
  const data = join(dir.path, "rec");
  const rec = (channel: string, msg: object) => {
    mkdirSync(join(data, channel, "BTC"), { recursive: true });
    const ts = (msg as { timestamp: string }).timestamp;
    writeFileSync(
      join(data, channel, "BTC", "2026-10-13T000000.000Z.jsonl.gz"),
      gzipSync(JSON.stringify({ recv_at: ts, msg }) + "\n"),
      { flag: "a" },
    );
  };
  rec("orderbooks", {
    channel: "orderbooks",
    asks: [
      { price: "5000000", size: "0.00004" },
      { price: "5001000", size: "1" },
    ],
    bids: [{ price: "4999000", size: "1" }],
    symbol: "BTC",
    timestamp: "2026-10-13T00:00:01.000Z",
  });
  rec("trades", {
    channel: "trades",
    price: "5000000",
    side: "BUY",
    size: "0.01",
    symbol: "BTC",
    timestamp: "2026-10-13T00:00:02.000Z",
  });
  rec("trades", {
    channel: "trades",
    price: "5001000",
    side: "BUY",
    size: "0.01",
    symbol: "BTC",
    timestamp: "2026-10-13T00:00:03.000Z",
  });

  const r = await backtest([
    "--strategy",
    strategy,
    "--source",
    "record",
    "--data",
    data,
    "--from",
    "2026-10-13",
    "--to",
    "2026-10-14",
  ]);
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.source).toBe("record");
  const p = out.periods[0];
  expect(p.takerFills).toBe(1);
  // 0.00004 @ 5,000,000 + 0.00006 @ 5,001,000
  expect(p.volumeJpy).toBeCloseTo(200 + 300.06, 9);
});
