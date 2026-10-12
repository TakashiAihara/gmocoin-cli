import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { readRecords, startFakeServer, tempDir, waitFor, type FakeServer } from "./test-helpers.ts";

const CLI = join(import.meta.dir, "cli.ts");

let server: FakeServer | undefined;
let dir: { path: string; cleanup(): void } | undefined;

let procs: Subprocess[] = [];

afterEach(() => {
  for (const p of procs) p.kill("SIGKILL");
  procs = [];
  server?.stop();
  dir?.cleanup();
  server = undefined;
  dir = undefined;
});

function spawnCli(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(p);
  return p;
}

test("--help lists the record command", async () => {
  const p = spawnCli(["--help"]);
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toContain("record");
});

test("record rejects a channel other than orderbooks and trades before connecting", async () => {
  server = startFakeServer();
  dir = tempDir();
  const out = join(dir.path, "out");
  const p = spawnCli(["record", "--channel", "ticker", "--out", out], {
    GMOCOIN_PUBLIC_WS_URL: server.url,
  });
  expect(await p.exited).not.toBe(0);
  expect(await new Response(p.stderr).text()).toContain("ticker");
  expect(server.opened).toBe(0);
  expect(existsSync(out)).toBe(false);
});

test("record rejects a symbol that is not upper-case letters, digits and underscores", async () => {
  server = startFakeServer();
  const p = spawnCli(["record", "--symbol", "../BTC"], { GMOCOIN_PUBLIC_WS_URL: server.url });
  expect(await p.exited).not.toBe(0);
  expect(await new Response(p.stderr).text()).toContain("../BTC");
  expect(server.opened).toBe(0);
});

test("record writes what it has buffered and exits 0 on SIGTERM", async () => {
  server = startFakeServer();
  dir = tempDir();
  const p = spawnCli(["record", "--channel", "trades", "--out", dir.path], {
    GMOCOIN_PUBLIC_WS_URL: server.url,
  });
  await waitFor(() => server!.received.length >= 1, 5000);
  const trade = {
    channel: "trades",
    price: "13239520",
    side: "BUY",
    size: "0.0001",
    symbol: "BTC",
    timestamp: "2026-10-12T10:16:12.956Z",
  };
  server.send(JSON.stringify(trade));
  // 既定の flush 間隔 (5 秒) より前に止める
  await Bun.sleep(300);
  p.kill("SIGTERM");
  expect(await p.exited).toBe(0);

  const files = readdirSync(join(dir.path, "trades/BTC"));
  expect(files.length).toBe(1);
  expect(readRecords(join(dir.path, "trades/BTC", files[0]!)).map((r) => r.msg)).toEqual([trade]);
}, 10_000);

test("record exits 1 when it cannot write", async () => {
  server = startFakeServer();
  dir = tempDir();
  writeFileSync(join(dir.path, "trades"), "");
  const p = spawnCli(["record", "--channel", "trades", "--out", dir.path], {
    GMOCOIN_PUBLIC_WS_URL: server.url,
  });
  await waitFor(() => server!.received.length >= 1, 5000);
  server.send(
    JSON.stringify({
      channel: "trades",
      price: "13239520",
      side: "BUY",
      size: "0.0001",
      symbol: "BTC",
      timestamp: "2026-10-12T10:16:12.956Z",
    }),
  );
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stderr).text()).toContain("write failed");
}, 15_000);

test("record subscribes orderbooks and trades of BTC by default", async () => {
  server = startFakeServer();
  dir = tempDir();
  const p = spawnCli(["record", "--out", dir.path], { GMOCOIN_PUBLIC_WS_URL: server.url });
  await waitFor(() => server!.received.length >= 2, 5000);
  p.kill("SIGINT");
  await p.exited;
  expect(server.received.map((r) => JSON.parse(r.text))).toEqual([
    { command: "subscribe", channel: "orderbooks", symbol: "BTC" },
    { command: "subscribe", channel: "trades", symbol: "BTC", option: "TAKER_ONLY" },
  ]);
  // GMO の購読は同一 IP から 1 秒 1 回まで
  // 既定は 1100ms。1000ms ちょうどだと同じ 1 秒の窓に 2 回入りうる
  expect(server.received[1]!.at - server.received[0]!.at).toBeGreaterThanOrEqual(1090);
}, 10_000);

test("record writes received messages and exits 0 on SIGINT", async () => {
  server = startFakeServer();
  dir = tempDir();
  const p = spawnCli(["record", "--symbol", "BTC_JPY", "--channel", "trades", "--out", dir.path], {
    GMOCOIN_PUBLIC_WS_URL: server.url,
  });
  await waitFor(() => server!.received.length >= 1, 5000);
  expect(JSON.parse(server.received[0]!.text)).toEqual({
    command: "subscribe",
    channel: "trades",
    symbol: "BTC_JPY",
    option: "TAKER_ONLY",
  });

  const trade = {
    channel: "trades",
    price: "13227962",
    side: "SELL",
    size: "0.02",
    symbol: "BTC_JPY",
    timestamp: "2026-10-12T10:16:30.956Z",
  };
  server.send(JSON.stringify(trade));
  await Bun.sleep(300);
  p.kill("SIGINT");
  expect(await p.exited).toBe(0);

  // 日付は受信時刻で決まるので、UTC 0 時をまたいでも落ちないようにファイル名では探さない
  const files = readdirSync(join(dir.path, "trades/BTC_JPY"));
  expect(files.length).toBe(1);
  const rows = readRecords(join(dir.path, "trades/BTC_JPY", files[0]!));
  expect(rows.map((r) => r.msg)).toEqual([trade]);
}, 10_000);
