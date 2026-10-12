import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readRecords, startFakeServer, tempDir, waitFor, type FakeServer } from "./test-helpers.ts";

const CLI = join(import.meta.dir, "cli.ts");

let server: FakeServer | undefined;
let dir: { path: string; cleanup(): void } | undefined;

afterEach(() => {
  server?.stop();
  dir?.cleanup();
  server = undefined;
  dir = undefined;
});

function spawnCli(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("--help lists the record command", async () => {
  const p = spawnCli(["--help"]);
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toContain("record");
});

test("record rejects a channel other than orderbooks and trades", async () => {
  const p = spawnCli(["record", "--channel", "ticker"]);
  expect(await p.exited).not.toBe(0);
  expect(await new Response(p.stderr).text()).toContain("ticker");
});

test("record subscribes orderbooks and trades of BTC by default", async () => {
  server = startFakeServer();
  dir = tempDir();
  const p = spawnCli(["record", "--out", dir.path], { GMOCOIN_PUBLIC_WS_URL: server.url });
  await waitFor(() => server!.received.length >= 2, 5000);
  p.kill("SIGINT");
  await p.exited;
  expect(server.received.map((r) => JSON.parse(r.text))).toEqual([
    { command: "subscribe", channel: "orderbooks", symbol: "BTC" },
    { command: "subscribe", channel: "trades", symbol: "BTC" },
  ]);
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

  const today = new Date().toISOString().slice(0, 10);
  const rows = readRecords(join(dir.path, "trades/BTC_JPY", `${today}.jsonl.gz`));
  expect(rows.map((r) => r.msg)).toEqual([trade]);
}, 10_000);
