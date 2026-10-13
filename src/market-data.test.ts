import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { MarketEvent } from "./backtest.ts";
import { csvEvents, csvFileDates, ensureCsv, recordEvents } from "./market-data.ts";
import { tempDir } from "./test-helpers.ts";

let dir: { path: string; cleanup(): void } | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  dir?.cleanup();
  server = undefined;
  dir = undefined;
});

async function collect(it: AsyncIterable<MarketEvent>) {
  const out: MarketEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const T = (s: string) => Date.parse(s);

test("csvFileDates covers the range with files cut at 21:00 UTC", () => {
  expect(csvFileDates(T("2026-10-12T00:00:00Z"), T("2026-10-13T00:00:00Z"))).toEqual([
    "20261012",
    "20261013",
  ]);
  expect(csvFileDates(T("2026-10-11T21:00:00Z"), T("2026-10-12T21:00:00Z"))).toEqual(["20261012"]);
  expect(csvFileDates(T("2026-10-11T20:59:59.999Z"), T("2026-10-12T21:00:00.001Z"))).toEqual([
    "20261011",
    "20261012",
    "20261013",
  ]);
  expect(csvFileDates(T("2026-12-31T21:00:00Z"), T("2027-01-01T00:00:00Z"))).toEqual(["20270101"]);
});

const CSV = [
  "symbol,side,size,price,timestamp",
  "BTC,BUY,0.0002,13240000.000,2026-10-11 21:00:05.745",
  "BTC,SELL,0.0000,13239999.000,2026-10-11 21:01:08.552",
  "BTC,SELL,0.0070,13239998.000,2026-10-12 20:59:56.936",
  "",
].join("\n");

function startCsvServer(files: Record<string, string>) {
  const hits: string[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      const body = files[path];
      return body === undefined
        ? new Response("no", { status: 404 })
        : new Response(gzipSync(body));
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/data/trades`, hits };
}

test("ensureCsv downloads a missing day once and then uses the cache", async () => {
  dir = tempDir();
  const { baseUrl, hits } = startCsvServer({ "/data/trades/BTC/2026/10/20261012_BTC.csv.gz": CSV });
  const opts = { dataDir: dir.path, symbol: "BTC", date: "20261012", baseUrl };

  const path = await ensureCsv(opts);
  expect(path).toBe(join(dir.path, "csv", "BTC", "20261012_BTC.csv.gz"));
  expect(existsSync(path)).toBe(true);
  expect(await ensureCsv(opts)).toBe(path);
  expect(hits).toEqual(["/data/trades/BTC/2026/10/20261012_BTC.csv.gz"]);
});

test("ensureCsv fails with the date when the day is not published and leaves no file", async () => {
  dir = tempDir();
  const { baseUrl } = startCsvServer({});
  await expect(
    ensureCsv({ dataDir: dir.path, symbol: "BTC", date: "20991231", baseUrl }),
  ).rejects.toThrow("20991231");
  const csvDir = join(dir.path, "csv", "BTC");
  expect(existsSync(csvDir) ? readdirSync(csvDir) : []).toEqual([]);
});

test("csvEvents reads the times as UTC and keeps only the range", async () => {
  dir = tempDir();
  const path = join(dir.path, "20261012_BTC.csv.gz");
  writeFileSync(path, gzipSync(CSV));

  const all = await collect(
    csvEvents({ paths: [path], from: T("2026-10-11T00:00:00Z"), to: T("2026-10-13T00:00:00Z") }),
  );
  expect(all).toEqual([
    { kind: "trade", t: T("2026-10-11T21:00:05.745Z"), side: "BUY", price: 13240000, size: 0.0002 },
    { kind: "trade", t: T("2026-10-11T21:01:08.552Z"), side: "SELL", price: 13239999, size: 0 },
    { kind: "trade", t: T("2026-10-12T20:59:56.936Z"), side: "SELL", price: 13239998, size: 0.007 },
  ]);

  const part = await collect(
    csvEvents({
      paths: [path],
      from: T("2026-10-11T21:01:08.552Z"),
      to: T("2026-10-12T20:59:56.936Z"),
    }),
  );
  expect(part.map((e) => e.t)).toEqual([T("2026-10-11T21:01:08.552Z")]);
});

function line(recvAt: string, msg: object) {
  return JSON.stringify({ recv_at: recvAt, msg }) + "\n";
}

const book = (ts: string, ask: string, bid: string) => ({
  channel: "orderbooks",
  asks: [
    { price: ask, size: "0.5" },
    { price: String(Number(ask) + 1000), size: "1.25" },
  ],
  bids: [{ price: bid, size: "0.75" }],
  symbol: "BTC",
  timestamp: ts,
});

const trade = (ts: string, side: string, price: string, size: string) => ({
  channel: "trades",
  price,
  side,
  size,
  symbol: "BTC",
  timestamp: ts,
});

function writeRecord(
  root: string,
  channel: string,
  name: string,
  members: string[],
  tornTail = false,
) {
  const d = join(root, channel, "BTC");
  mkdirSync(d, { recursive: true });
  const parts = members.map((m) => gzipSync(m));
  if (tornTail) parts.push(gzipSync(line("2026-10-13T12:00:00Z", {})).subarray(0, 12));
  writeFileSync(join(d, name), Buffer.concat(parts));
}

test("recordEvents merges books and trades by exchange time, trades first on ties", async () => {
  dir = tempDir();
  // 前日の名前のファイルに当日の行が入る (受信時刻で日付を切るため)
  writeRecord(dir.path, "orderbooks", "2026-10-12T235959.990Z.jsonl.gz", [
    line("2026-10-12T23:59:59.990Z", book("2026-10-12T23:59:59.980Z", "5000000", "4999000")),
    line("2026-10-13T00:00:00.020Z", book("2026-10-13T00:00:00.010Z", "5000001", "4999001")),
  ]);
  writeRecord(dir.path, "orderbooks", "2026-10-13T080000.000Z.jsonl.gz", [
    line("2026-10-13T08:00:00.000Z", book("2026-10-13T08:00:00.000Z", "5000002", "4999002")),
  ]);
  writeRecord(dir.path, "trades", "2026-10-13T000000.500Z.jsonl.gz", [
    line("2026-10-13T00:00:00.500Z", trade("2026-10-13T00:00:00.400Z", "BUY", "5000001", "0.0001")),
    line("2026-10-13T08:00:00.100Z", trade("2026-10-13T08:00:00.000Z", "SELL", "4999002", "0.002")),
  ]);

  const events = await collect(
    recordEvents({
      dataDir: dir.path,
      symbol: "BTC",
      from: T("2026-10-13T00:00:00Z"),
      to: T("2026-10-14T00:00:00Z"),
    }),
  );
  expect(events.map((e) => [e.kind, new Date(e.t).toISOString()])).toEqual([
    ["book", "2026-10-13T00:00:00.010Z"],
    ["trade", "2026-10-13T00:00:00.400Z"],
    ["trade", "2026-10-13T08:00:00.000Z"],
    ["book", "2026-10-13T08:00:00.000Z"],
  ]);
  expect(events[0]).toEqual({
    kind: "book",
    t: T("2026-10-13T00:00:00.010Z"),
    asks: [
      { price: 5000001, size: 0.5 },
      { price: 5001001, size: 1.25 },
    ],
    bids: [{ price: 4999001, size: 0.75 }],
  });
  expect(events[1]).toEqual({
    kind: "trade",
    t: T("2026-10-13T00:00:00.400Z"),
    side: "BUY",
    price: 5000001,
    size: 0.0001,
  });
});

test("recordEvents reads a file up to its torn tail, says so, and goes on to the next file", async () => {
  dir = tempDir();
  writeRecord(
    dir.path,
    "trades",
    "2026-10-13T010000.000Z.jsonl.gz",
    [line("2026-10-13T01:00:00.100Z", trade("2026-10-13T01:00:00.000Z", "BUY", "5000000", "0.1"))],
    true,
  );
  writeRecord(dir.path, "trades", "2026-10-13T020000.000Z.jsonl.gz", [
    line("2026-10-13T02:00:00.100Z", trade("2026-10-13T02:00:00.000Z", "SELL", "5000100", "0.2")),
  ]);
  const logs: string[] = [];

  const events = await collect(
    recordEvents({
      dataDir: dir.path,
      symbol: "BTC",
      from: T("2026-10-13T00:00:00Z"),
      to: T("2026-10-14T00:00:00Z"),
      log: (l) => logs.push(l),
    }),
  );
  expect(events.map((e) => e.t)).toEqual([
    T("2026-10-13T01:00:00.000Z"),
    T("2026-10-13T02:00:00.000Z"),
  ]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("2026-10-13T010000.000Z.jsonl.gz");
});

test("recordEvents ignores files far outside the range and yields nothing when nothing is recorded", async () => {
  dir = tempDir();
  writeRecord(dir.path, "trades", "2026-10-01T000000.000Z.jsonl.gz", [
    line("2026-10-01T00:00:00.100Z", trade("2026-10-01T00:00:00.000Z", "BUY", "5000000", "0.1")),
  ]);
  const events = await collect(
    recordEvents({
      dataDir: dir.path,
      symbol: "BTC",
      from: T("2026-10-13T00:00:00Z"),
      to: T("2026-10-14T00:00:00Z"),
    }),
  );
  expect(events).toEqual([]);
});
