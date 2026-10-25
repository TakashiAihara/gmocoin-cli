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
  const code = await p.exited;
  return {
    code,
    stdout: await new Response(p.stdout).text(),
    stderr: await new Response(p.stderr).text(),
  };
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

test("replay --source record merges books and trades by time, trades first on a tie", async () => {
  dir = tempDir();
  const data = join(dir.path, "rec");
  const rec = (channel: string, msg: { timestamp: string }) => {
    mkdirSync(join(data, channel, "BTC"), { recursive: true });
    writeFileSync(
      join(data, channel, "BTC", "2026-10-13T000000.000Z.jsonl.gz"),
      gzipSync(JSON.stringify({ recv_at: msg.timestamp, msg }) + "\n"),
      { flag: "a" },
    );
  };
  rec("orderbooks", {
    asks: [{ price: "5001000", size: "0.5" }],
    bids: [{ price: "4999000", size: "1" }],
    timestamp: "2026-10-13T00:00:02.000Z",
  } as { timestamp: string });
  rec("trades", {
    price: "5000000",
    side: "BUY",
    size: "0.01",
    timestamp: "2026-10-13T00:00:01.000Z",
  } as {
    timestamp: string;
  });
  rec("trades", {
    price: "5002000",
    side: "SELL",
    size: "0.02",
    timestamp: "2026-10-13T00:00:02.000Z",
  } as {
    timestamp: string;
  });

  const r = await replay([
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
  const t = (s: string) => Date.parse(s);
  expect(lines(r.stdout)).toEqual([
    { kind: "trade", t: t("2026-10-13T00:00:01Z"), side: "BUY", price: 5000000, size: 0.01 },
    { kind: "trade", t: t("2026-10-13T00:00:02Z"), side: "SELL", price: 5002000, size: 0.02 },
    {
      kind: "book",
      t: t("2026-10-13T00:00:02Z"),
      asks: [{ price: 5001000, size: 0.5 }],
      bids: [{ price: 4999000, size: 1 }],
    },
  ]);
});

test("replay exits 1 when the range has no market data instead of printing nothing", async () => {
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
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no market data");
  expect(r.stdout).toBe("");
});

test("replay rejects a range that ends before it starts", async () => {
  dir = tempDir();
  const r = await replay([
    "--source",
    "record",
    "--data",
    dir.path,
    "--from",
    "2026-10-14",
    "--to",
    "2026-10-13",
  ]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--to must be after --from");
});
