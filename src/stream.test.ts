import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { MarketEvent } from "./backtest.ts";
import type { Gap } from "./stream.ts";
import { startStream } from "./stream.ts";
import { startFakeServer, waitFor, type FakeServer } from "./test-helpers.ts";

let fake: FakeServer | undefined;
let stream: { stop(): void } | undefined;

afterEach(() => {
  stream?.stop();
  fake?.stop();
  stream = undefined;
  fake = undefined;
});

const trade = (price: string) =>
  JSON.stringify({
    channel: "trades",
    symbol: "BTC",
    side: "BUY",
    price,
    size: "0.001",
    timestamp: "2026-11-01T00:00:00.123Z",
  });
const book = JSON.stringify({
  channel: "orderbooks",
  symbol: "BTC",
  asks: [{ price: "15000100", size: "0.1" }],
  bids: [{ price: "15000000", size: "0.2" }],
  timestamp: "2026-11-01T00:00:00.100Z",
});

function start(opts: { idleTimeoutMs?: number } = {}) {
  fake = startFakeServer();
  const events: (MarketEvent | Gap)[] = [];
  const logs: string[] = [];
  stream = startStream({
    url: fake.url,
    symbol: "BTC",
    channel: "trades",
    onEvent: (e) => events.push(e),
    subscribeIntervalMs: 20,
    backoffInitialMs: 20,
    log: (l) => logs.push(l),
    ...opts,
  });
  return { events, logs };
}

test("trades are subscribed TAKER_ONLY with books as the liveness signal, and only trades come out", async () => {
  const { events } = start();
  await waitFor(() => fake!.received.length === 2);
  expect(fake!.received.map((r) => JSON.parse(r.text))).toEqual([
    { command: "subscribe", channel: "trades", symbol: "BTC", option: "TAKER_ONLY" },
    { command: "subscribe", channel: "orderbooks", symbol: "BTC" },
  ]);
  fake!.send(book);
  fake!.send(trade("15000050"));
  await waitFor(() => events.length === 1);
  await Bun.sleep(50);
  expect(events).toEqual([
    {
      kind: "trade",
      t: Date.parse("2026-11-01T00:00:00.123Z"),
      side: "BUY",
      price: 15000050,
      size: 0.001,
    },
  ]);
});

test("a dropped connection is logged on one line, reconnected and subscribed again", async () => {
  const { events, logs } = start();
  await waitFor(() => fake!.received.length === 2);
  fake!.closeConn();
  await waitFor(() => fake!.received.length === 4);
  expect(fake!.opened).toBe(2);
  expect(logs.filter((l) => l.includes("reconnecting"))).toEqual([
    "disconnected: closed, reconnecting in 20ms",
  ]);
  fake!.send(trade("15000060"));
  await waitFor(() => events.length === 2);
  expect(events.map((e) => e.kind)).toEqual(["gap", "trade"]);
});

test("books keep a quiet trades stream connected", async () => {
  start({ idleTimeoutMs: 150 });
  await waitFor(() => fake!.opened === 1);
  for (let i = 0; i < 10; i++) {
    fake!.send(book);
    await Bun.sleep(50);
  }
  expect(fake!.opened).toBe(1);
});

test("a silent connection is dropped after the idle timeout", async () => {
  const { logs } = start({ idleTimeoutMs: 100 });
  await waitFor(() => fake!.opened === 2, 2000);
  expect(logs[0]).toBe("disconnected: no message for 100ms, reconnecting in 20ms");
});

test("gmocoin stream prints trades as JSONL on stdout", async () => {
  fake = startFakeServer();
  const p = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "stream"], {
    env: { ...process.env, GMOCOIN_PUBLIC_WS_URL: fake.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // 2 つ目の購読まで待つ (購読の間隔は 1.1 秒)
    await waitFor(() => fake!.received.length === 2, 5000);
    fake.send(trade("15000070"));
    const reader = p.stdout.getReader();
    const { value } = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(value).trim())).toEqual({
      kind: "trade",
      t: Date.parse("2026-11-01T00:00:00.123Z"),
      side: "BUY",
      price: 15000070,
      size: 0.001,
    });
  } finally {
    p.kill();
    await p.exited;
  }
});

test("trades of another symbol or with a broken timestamp are skipped", async () => {
  const { events, logs } = start();
  await waitFor(() => fake!.received.length === 2);
  fake!.send(trade("1").replace('"BTC"', '"ETH"'));
  fake!.send(trade("2").replace("2026-11-01T00:00:00.123Z", "not a time"));
  fake!.send(trade("15000080"));
  await waitFor(() => events.length >= 1);
  await Bun.sleep(50);
  expect(events.map((e) => (e.kind === "trade" ? e.price : 0))).toEqual([15000080]);
  expect(logs.filter((l) => l.startsWith("skipped message")).length).toBe(2);
});

test("a rejected subscribe drops the connection and subscribes again", async () => {
  const { events, logs } = start();
  await waitFor(() => fake!.received.length === 2);
  fake!.send(JSON.stringify({ error: "ERR-5003 Request too many." }));
  await waitFor(() => fake!.received.length === 4);
  expect(fake!.opened).toBe(2);
  expect(logs).toContain(
    "disconnected: rejected: ERR-5003 Request too many., reconnecting in 20ms",
  );
  fake!.send(trade("15000090"));
  await waitFor(() => events.length === 2);
  expect(events.map((e) => e.kind)).toEqual(["gap", "trade"]);
});

test("one gap line spans repeated drops, from the first drop to the first message after", async () => {
  const { events } = start();
  await waitFor(() => fake!.received.length === 2);
  fake!.send(trade("15000000"));
  await waitFor(() => events.length === 1);
  const beforeDrop = Date.now();
  fake!.closeConn();
  await waitFor(() => fake!.opened === 2);
  await Bun.sleep(30);
  const beforeSecondDrop = Date.now();
  fake!.closeConn();
  await waitFor(() => fake!.received.length === 6);
  await Bun.sleep(50);
  const beforeMessage = Date.now();
  fake!.send(book);
  await waitFor(() => events.length === 2);
  fake!.send(book);
  await Bun.sleep(50);

  expect(events.length).toBe(2);
  const gap = events[1] as Gap;
  expect(gap.kind).toBe("gap");
  // since は 1 回目の切断の時刻で、2 回目の切断ではない
  expect(gap.since).toBeGreaterThanOrEqual(beforeDrop);
  expect(gap.since).toBeLessThan(beforeSecondDrop);
  expect(gap.t).toBeGreaterThanOrEqual(beforeMessage);
});
