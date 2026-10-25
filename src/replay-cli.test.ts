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

async function replay(args: string[], url = "http://127.0.0.1:9/none") {
  const p = Bun.spawn(["bun", CLI, "replay", ...args], {
    env: { ...process.env, GMOCOIN_TRADES_CSV_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  // 出力がパイプの容量を超えても詰まらないよう、終わりを待つ前から読む
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

const lines = (s: string) =>
  s
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

test("replay prints the CSV trades inside [from, to) as JSONL", async () => {
  dir = tempDir();
  const csv = [
    "symbol,side,size,price,timestamp",
    "BTC,BUY,0.0010,10000000.000,2026-10-12 00:59:59.999",
    "BTC,SELL,0.0020,10001000.000,2026-10-12 01:00:00.000",
    "BTC,BUY,0.0030,10002000.000,2026-10-12 01:30:00.000",
    "BTC,BUY,0.0040,10003000.000,2026-10-12 02:00:00.000",
    "",
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      return new URL(req.url).pathname === "/data/trades/BTC/2026/10/20261012_BTC.csv.gz"
        ? new Response(gzipSync(csv))
        : new Response("no", { status: 404 });
    },
  });
  const r = await replay(
    [
      "--data",
      join(dir.path, "data"),
      "--from",
      "2026-10-12T01:00:00Z",
      "--to",
      "2026-10-12T02:00:00Z",
    ],
    `http://127.0.0.1:${server.port}/data/trades`,
  );
  expect(r.code).toBe(0);
  expect(lines(r.stdout)).toEqual([
    {
      kind: "trade",
      t: Date.parse("2026-10-12T01:00:00Z"),
      side: "SELL",
      price: 10001000,
      size: 0.002,
    },
    {
      kind: "trade",
      t: Date.parse("2026-10-12T01:30:00Z"),
      side: "BUY",
      price: 10002000,
      size: 0.003,
    },
  ]);
});

test("replay --source record merges books and trades by time inside [from, to), trades first on a tie", async () => {
  dir = tempDir();
  const data = join(dir.path, "rec");
  // BTC 以外も読めることを見るため BTC_JPY で書く
  const rec = (channel: string, file: string, msg: { timestamp: string }) => {
    mkdirSync(join(data, channel, "BTC_JPY"), { recursive: true });
    writeFileSync(
      join(data, channel, "BTC_JPY", file),
      gzipSync(JSON.stringify({ recv_at: msg.timestamp, msg }) + "\n"),
      { flag: "a" },
    );
  };
  const book = (timestamp: string, ask: string) => ({
    asks: [{ price: ask, size: "0.5" }],
    bids: [{ price: "4999000", size: "1" }],
    timestamp,
  });
  const trade = (timestamp: string, price: string) => ({
    price,
    side: "BUY",
    size: "0.01",
    timestamp,
  });
  // 期間の外 (前日の名前のファイルに入った行と、to ちょうどの行) は出さない
  rec("trades", "2026-10-12T235959.000Z.jsonl.gz", trade("2026-10-12T23:59:59.999Z", "4900000"));
  rec("orderbooks", "2026-10-13T000000.000Z.jsonl.gz", book("2026-10-13T00:00:00.500Z", "5001000"));
  rec("orderbooks", "2026-10-13T000000.000Z.jsonl.gz", book("2026-10-13T00:00:02.000Z", "5003000"));
  rec("orderbooks", "2026-10-13T000000.000Z.jsonl.gz", book("2026-10-14T00:00:00.000Z", "5009000"));
  rec("trades", "2026-10-13T000000.000Z.jsonl.gz", trade("2026-10-13T00:00:01.000Z", "5000000"));
  rec("trades", "2026-10-13T000000.000Z.jsonl.gz", trade("2026-10-13T00:00:02.000Z", "5002000"));
  rec("trades", "2026-10-13T000000.000Z.jsonl.gz", trade("2026-10-13T00:00:03.000Z", "5004000"));

  const r = await replay([
    "--source",
    "record",
    "--data",
    data,
    "--symbol",
    "BTC_JPY",
    "--from",
    "2026-10-13",
    "--to",
    "2026-10-14",
  ]);
  expect(r.code).toBe(0);
  expect(
    lines(r.stdout).map((e) => [e.kind, new Date(e.t).toISOString(), e.price ?? e.asks[0].price]),
  ).toEqual([
    ["book", "2026-10-13T00:00:00.500Z", 5001000],
    ["trade", "2026-10-13T00:00:01.000Z", 5000000],
    ["trade", "2026-10-13T00:00:02.000Z", 5002000],
    ["book", "2026-10-13T00:00:02.000Z", 5003000],
    ["trade", "2026-10-13T00:00:03.000Z", 5004000],
  ]);
  expect(lines(r.stdout)[0]).toEqual({
    kind: "book",
    t: Date.parse("2026-10-13T00:00:00.500Z"),
    asks: [{ price: 5001000, size: 0.5 }],
    bids: [{ price: 4999000, size: 1 }],
  });
});

test("replay exits 3 when the range has no market data instead of printing nothing", async () => {
  dir = tempDir();
  const r = await replay([
    "--source",
    "record",
    "--data",
    dir.path,
    "--from",
    "2026-10-13",
    "--to",
    "2026-10-14",
  ]);
  expect(r.code).toBe(3);
  expect(r.stderr).toContain("no market data");
  expect(r.stdout).toBe("");
});

test("replay rejects a range that ends before it starts or is empty", async () => {
  dir = tempDir();
  for (const to of ["2026-10-13", "2026-10-14"]) {
    const args = ["--source", "record", "--data", dir.path, "--from", "2026-10-14", "--to", to];
    const r = await replay(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--to must be after --from");
  }
});

test("replay exits 0 without errors when the reader closes early", async () => {
  dir = tempDir();
  const rows = Array.from({ length: 200_000 }, (_, i) => {
    const ms = String(i % 1000).padStart(3, "0");
    const s = String(Math.floor(i / 1000) % 60).padStart(2, "0");
    return `BTC,BUY,0.0010,10000000.000,2026-10-12 01:0${Math.floor(i / 60_000)}:${s}.${ms}`;
  });
  const csv = ["symbol,side,size,price,timestamp", ...rows, ""].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(gzipSync(csv)),
  });
  const p = Bun.spawn(
    [
      "bun",
      CLI,
      "replay",
      "--data",
      join(dir.path, "data"),
      "--from",
      "2026-10-12T01:00:00Z",
      "--to",
      "2026-10-12T02:00:00Z",
    ],
    {
      env: {
        ...process.env,
        GMOCOIN_TRADES_CSV_URL: `http://127.0.0.1:${server.port}/data/trades`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = p.stdout.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  await reader.cancel();
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(stderr).toBe("fetching CSV 20261012 (1/1)\n");
  expect(code).toBe(0);
});
