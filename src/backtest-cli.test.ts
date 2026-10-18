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
  // 期末に残った 0.0001 BTC は Taker 手数料を引いて評価する (10,000,000 で 0.5、9,000,000 で 0.45)
  expect(train.pnl).toBeCloseTo(-1, 9);
  expect(testPeriod.from).toBe("2026-10-12T12:00:00.000Z");
  expect(testPeriod.to).toBe("2026-10-13T00:00:00.000Z");
  expect(testPeriod.fills).toBe(1);
  expect(testPeriod.events).toBe(4);
  expect(testPeriod.pnl).toBeCloseTo(-201, 9);
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
  expect(out.periods[0].pnl).toBeCloseTo(98.85, 9);
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
  expect(p.pnl).toBeCloseTo(1200 - 1111 - 1111 * 0.0005 - 0.6, 9);
  // 判断した 13:00 の 10,000,000 に対して 14:00 の 11,000,000 × 1.01 で約定した
  expect(p.takerSlippageBps).toBeCloseTo(1110, 9);
});

test("backtest charges --taker-fee-bps on fills and on the end-of-period valuation", async () => {
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
      "--maker-fee-bps",
      "3",
      "--taker-fee-bps",
      "12",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const p = JSON.parse(r.stdout).periods[0];
  // 11,000,000 で 0.0001 BTC を買い (手数料 1.32)、12,000,000 で評価する (手数料 1.44)
  expect(p.pnl).toBeCloseTo(1200 - 1100 - 1.32 - 1.44, 9);
  expect(p.feesJpy).toBeCloseTo(1.32, 9);
});

test("backtest charges --maker-fee-bps on limit fills", async () => {
  const { data, url } = setup(BOTH_DAYS);
  // 最初の約定で 9,500,000 に 0.0001 BTC の指値買いを 1 回だけ置く
  const strategy = join(dir!.path, "limit-once.ts");
  writeFileSync(
    strategy,
    BUY_ONCE.replace(
      `{ type: "market", side: "BUY", size: 0.0001 }`,
      `{ type: "limit", side: "BUY", price: 9_500_000, size: 0.0001 }`,
    ),
  );
  const r = await backtest(
    [
      "--strategy",
      strategy,
      "--data",
      data,
      "--from",
      "2026-10-12T12:00:00Z",
      "--to",
      "2026-10-12T23:00:00Z",
      "--maker-fee-bps",
      "3",
      "--taker-fee-bps",
      "12",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const p = JSON.parse(r.stdout).periods[0];
  // 22:00 の 9,000,000 の約定で 950 円ぶん約定する
  expect(p.makerFills).toBe(1);
  expect(p.feesJpy).toBeCloseTo(0.285, 9);
});

test("backtest defaults to GMO Coin's maker rebate on limit fills", async () => {
  const { data, url } = setup(BOTH_DAYS);
  const strategy = join(dir!.path, "limit-once.ts");
  writeFileSync(
    strategy,
    BUY_ONCE.replace(
      `{ type: "market", side: "BUY", size: 0.0001 }`,
      `{ type: "limit", side: "BUY", price: 9_500_000, size: 0.0001 }`,
    ),
  );
  const r = await backtest(
    [
      "--strategy",
      strategy,
      "--data",
      data,
      "--from",
      "2026-10-12T12:00:00Z",
      "--to",
      "2026-10-12T23:00:00Z",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const p = JSON.parse(r.stdout).periods[0];
  expect(p.makerFills).toBe(1);
  expect(p.feesJpy).toBeCloseTo(-0.095, 9);
});

test("backtest rejects a negative --taker-fee-bps and a fee of 100% or more", async () => {
  for (const args of [
    ["--taker-fee-bps", "-1"],
    ["--taker-fee-bps", "10000"],
    ["--maker-fee-bps", "-10000"],
    ["--maker-fee-bps", "10000"],
  ]) {
    const r = await backtest([
      "--strategy",
      "x.ts",
      "--from",
      "2026-10-12",
      "--to",
      "2026-10-13",
      ...args,
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${args[0]} must`);
  }
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

test("backtest exits 1 when a period has no market data instead of reporting a zero result", async () => {
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
  expect(r.stderr).toContain('period "train" has no market data');
  expect(r.stdout).toBe("");
});

test("backtest rejects a split outside the range and a range that ends before it starts", async () => {
  const { strategy, data, url } = setup(BOTH_DAYS);
  const bad: [string[], string][] = [
    [["--from", "2026-10-12", "--to", "2026-10-13", "--split", "2026-10-14"], "--split"],
    [["--from", "2026-10-12", "--to", "2026-10-13", "--split", "2026-10-12"], "--split"],
    [["--from", "2026-10-13", "--to", "2026-10-12"], "--to must be after"],
    [["--from", "2026-10-12", "--to", "2026-10-12"], "--to must be after"],
    [["--from", "yesterday", "--to", "2026-10-12"], "YYYY-MM-DD"],
    [["--from", "2026-10-12", "--to", "2026-10-13", "--symbol", "ETH"], "BTC"],
  ];
  for (const [args, message] of bad) {
    const r = await backtest(["--strategy", strategy, "--data", data, ...args], url);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(message);
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
  // 判断した時点の約定 5,000,000 に対して 5,000,600 で約定した
  expect(p.takerSlippageBps).toBeCloseTo(1.2, 9);
});

test("backtest reports a period where the strategy never trades instead of failing", async () => {
  const { data, url } = setup(BOTH_DAYS);
  const idle = join(dir!.path, "idle.ts");
  writeFileSync(idle, "export default function () { return {}; }\n");
  const r = await backtest(
    [
      "--strategy",
      idle,
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
  expect(out.periods[0].fills).toBe(0);
  expect(out.periods[0].events).toBe(3);
  expect(out.pass).toBe(false);
});

test("backtest judges the test period, not the train period", async () => {
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
      "2026-10-12T20:00:00Z",
      "--split",
      "2026-10-12T12:00:00Z",
    ],
    url,
  );
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.periods[0].pnl).toBeLessThan(0);
  expect(out.periods[1].pnl).toBeGreaterThan(0);
  expect(out.pass).toBe(true);
});

// 10,000,000 で 0.0001 BTC を買い (1,000 + 手数料 0.5)、drop まで下げてから 12,000,000 に戻す
function drawdownCsv(drop: number) {
  return {
    "/data/trades/BTC/2026/10/20261012_BTC.csv.gz": [
      "symbol,side,size,price,timestamp",
      "BTC,BUY,0.0010,10000000.000,2026-10-12 01:00:00.000",
      "BTC,BUY,0.0010,10000000.000,2026-10-12 02:00:00.000",
      `BTC,SELL,0.0010,${drop}.000,2026-10-12 03:00:00.000`,
      "BTC,BUY,0.0010,12000000.000,2026-10-12 04:00:00.000",
      "",
    ].join("\n"),
  };
}

test("backtest fails a profitable period whose drawdown is over 20% and passes one within it", async () => {
  // 資金 1,250.5 の山から、7,500,000 では 1,000 (20.03% 下落)、7,600,000 では 1,010 (19.23% 下落)
  for (const [drop, pass] of [
    [7_500_000, false],
    [7_600_000, true],
  ] as const) {
    const { strategy, data, url } = setup(drawdownCsv(drop));
    const r = await backtest(
      [
        "--strategy",
        strategy,
        "--data",
        data,
        "--from",
        "2026-10-12",
        "--to",
        "2026-10-12T20:00:00Z",
        "--capital",
        "1250.5",
      ],
      url,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.periods[0].pnl).toBeGreaterThan(0);
    expect(out.pass).toBe(pass);
    server?.stop(true);
    dir?.cleanup();
  }
});

test("--warmup-days feeds earlier CSV trades to the strategy without trading on them", async () => {
  const { strategy, data, url } = setup({
    ...BOTH_DAYS,
    "/data/trades/BTC/2026/10/20261011_BTC.csv.gz": "symbol,side,size,price,timestamp\n",
  });
  const args = ["--strategy", strategy, "--data", data];
  const period = ["--from", "2026-10-12T12:00:00Z", "--to", "2026-10-12T20:00:00Z"];

  const cold = JSON.parse((await backtest([...args, ...period], url)).stdout).periods[0];
  const r = await backtest([...args, ...period, "--warmup-days", "1"], url);
  expect(r.code).toBe(0);
  const warm = JSON.parse(r.stdout).periods[0];
  // BUY_ONCE は最初に見た約定で買う。温めると最初の約定は期間の前 (01:00) になり、その注文は捨てられる
  expect(cold.fills).toBe(1);
  expect(warm.fills).toBe(0);
  expect(warm.takerSlippageBps).toBeNull();
  expect(warm.events).toBe(3);
  expect(warm.firstEventAt).toBe("2026-10-12T13:00:00.000Z");
});

// record の出力を 1 ファイルに書く。msgs は timestamp を持つ受信メッセージ
function writeRecord(data: string, channel: string, msgs: { timestamp: string }[]) {
  mkdirSync(join(data, channel, "BTC"), { recursive: true });
  const lines = msgs.map((msg) => JSON.stringify({ recv_at: msg.timestamp, msg }) + "\n");
  writeFileSync(
    join(data, channel, "BTC", "2026-10-13T000000.000Z.jsonl.gz"),
    gzipSync(lines.join("")),
  );
}

const recTrade = (timestamp: string) => ({
  channel: "trades",
  price: "5000000",
  side: "BUY",
  size: "0.01",
  symbol: "BTC",
  timestamp,
});

const recBook = (timestamp: string) => ({
  channel: "orderbooks",
  asks: [{ price: "5001000", size: "1" }],
  bids: [{ price: "4999000", size: "1" }],
  symbol: "BTC",
  timestamp,
});

test("--warmup-days with --source record reads CSV only before the period", async () => {
  const { strategy, url } = setup(BOTH_DAYS);
  const data = join(dir!.path, "rec");
  writeRecord(data, "orderbooks", [recBook("2026-10-13T00:00:01.000Z")]);
  writeRecord(data, "trades", [
    recTrade("2026-10-13T00:00:02.000Z"),
    recTrade("2026-10-13T00:00:03.000Z"),
  ]);
  const args = ["--strategy", strategy, "--source", "record", "--data", data];
  const period = ["--from", "2026-10-13", "--to", "2026-10-14"];

  const cold = await backtest([...args, ...period]);
  expect(JSON.parse(cold.stdout).periods[0].fills).toBe(1);
  // 期間 (10-13) の CSV 20261014 は置いていないので、取りに行けば exit 1 になる
  const r = await backtest([...args, ...period, "--warmup-days", "1"], url);
  expect(r.stderr).not.toContain("not available");
  expect(r.code).toBe(0);
  const p = JSON.parse(r.stdout).periods[0];
  expect(p.events).toBe(3);
  expect(p.fills).toBe(0);
  expect(p.rejects).toBe(0);
});

test("--source record with --split and no warmup fetches no CSV", async () => {
  dir = tempDir();
  const strategy = join(dir.path, "buy-once.ts");
  writeFileSync(strategy, BUY_ONCE);
  const data = join(dir.path, "rec");
  writeRecord(data, "trades", [
    recTrade("2026-10-13T00:00:02.000Z"),
    recTrade("2026-10-13T12:00:00.000Z"),
  ]);
  // 取得先は届かない URL (backtest の既定) なので、CSV を 1 本でも取りに行けば exit 1
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
    "--split",
    "2026-10-13T06:00:00Z",
  ]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).periods.map((p: { events: number }) => p.events)).toEqual([1, 1]);
});

test("--warmup-days with --split warms each period from the trades just before it", async () => {
  const { strategy, data, url } = setup({
    ...BOTH_DAYS,
    "/data/trades/BTC/2026/10/20261011_BTC.csv.gz": "symbol,side,size,price,timestamp\n",
  });
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
      "--warmup-days",
      "1",
    ],
    url,
  );
  expect(r.code).toBe(0);
  // train の前の 1 日には約定が無いので train は温めても買う。test は train の 01:00 の約定で温まり、買わない
  expect(JSON.parse(r.stdout).periods.map((p: { fills: number }) => p.fills)).toEqual([1, 0]);
});
