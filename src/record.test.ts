import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startRecorder, type Recorder, type RecorderOptions, type Subscription } from "./record.ts";
import { recordPath } from "./sink.ts";
import { readRecords, startFakeServer, tempDir, waitFor, type FakeServer } from "./test-helpers.ts";

const OB_BTC = {
  channel: "orderbooks",
  asks: [{ price: "13239520", size: "0.27584" }],
  bids: [{ price: "13238001", size: "0.031" }],
  symbol: "BTC",
  timestamp: "2026-10-12T10:16:11.611Z",
  grouping: "0",
};
const TRADE_BTC = {
  channel: "trades",
  price: "13239520",
  side: "BUY",
  size: "0.0001",
  symbol: "BTC",
  timestamp: "2026-10-12T10:16:12.956Z",
};
const TRADE_BTC_JPY = {
  channel: "trades",
  price: "13227962",
  side: "SELL",
  size: "0.02",
  symbol: "BTC_JPY",
  timestamp: "2026-10-12T10:16:30.956Z",
};

let server: FakeServer;
let dir: { path: string; cleanup(): void };
let recorder: Recorder | undefined;
let logs: string[];

function start(over: Partial<RecorderOptions> & { subscriptions: Subscription[] }): Recorder {
  recorder = startRecorder({
    url: server.url,
    outDir: dir.path,
    subscribeIntervalMs: 150,
    backoffInitialMs: 50,
    backoffMaxMs: 400,
    idleTimeoutMs: 10_000,
    statsIntervalMs: 60_000,
    flushIntervalMs: 50,
    log: (l) => logs.push(l),
    ...over,
  });
  return recorder;
}

function subscribesOn(conn: number) {
  return server.received.filter((r) => r.conn === conn);
}

function setup() {
  server = startFakeServer();
  dir = tempDir();
  logs = [];
  recorder = undefined;
}

afterEach(async () => {
  await recorder?.stop();
  server.stop();
  dir.cleanup();
});

describe("recordPath", () => {
  test("places a record under channel/symbol/<UTC date>.jsonl.gz", () => {
    expect(recordPath("/x", "orderbooks", "BTC", new Date("2026-10-12T23:59:59.999Z"))).toBe(
      "/x/orderbooks/BTC/2026-10-12.jsonl.gz",
    );
    expect(recordPath("/x", "trades", "BTC_JPY", new Date("2026-10-13T00:00:00.000Z"))).toBe(
      "/x/trades/BTC_JPY/2026-10-13.jsonl.gz",
    );
  });

  test("uses the UTC date even where the local date differs", () => {
    // JST では 2026-10-13 05:00 になる時刻
    expect(recordPath("/x", "trades", "BTC", new Date("2026-10-12T20:00:00.000Z"))).toBe(
      "/x/trades/BTC/2026-10-12.jsonl.gz",
    );
  });
});

describe("startRecorder", () => {
  test("subscribes every pair in order, spaced by the subscribe interval", async () => {
    setup();
    const subs: Subscription[] = [
      { channel: "orderbooks", symbol: "BTC" },
      { channel: "trades", symbol: "BTC" },
      { channel: "trades", symbol: "BTC_JPY" },
    ];
    start({ subscriptions: subs });
    await waitFor(() => server.received.length >= 3);

    expect(server.received.map((r) => JSON.parse(r.text))).toEqual(
      subs.map((s) => ({ command: "subscribe", channel: s.channel, symbol: s.symbol })),
    );
    const at = server.received.map((r) => r.at);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(140);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(140);
  });

  test("writes each message verbatim with the receive time to its channel/symbol/day file", async () => {
    setup();
    const recvAt = new Date("2026-03-04T05:06:07.890Z");
    start({
      subscriptions: [
        { channel: "orderbooks", symbol: "BTC" },
        { channel: "trades", symbol: "BTC" },
      ],
      now: () => recvAt,
    });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(OB_BTC));
    server.send(JSON.stringify(TRADE_BTC));
    server.send(JSON.stringify(TRADE_BTC_JPY));
    await Bun.sleep(200);
    await recorder!.stop();

    expect(readRecords(join(dir.path, "orderbooks/BTC/2026-03-04.jsonl.gz"))).toEqual([
      { recv_at: "2026-03-04T05:06:07.890Z", msg: OB_BTC },
    ]);
    expect(readRecords(join(dir.path, "trades/BTC/2026-03-04.jsonl.gz"))).toEqual([
      { recv_at: "2026-03-04T05:06:07.890Z", msg: TRADE_BTC },
    ]);
    // 購読していない組でも、届いたものは捨てずに書く
    expect(readRecords(join(dir.path, "trades/BTC_JPY/2026-03-04.jsonl.gz"))).toEqual([
      { recv_at: "2026-03-04T05:06:07.890Z", msg: TRADE_BTC_JPY },
    ]);
  });

  test("starts a new file when the UTC date of the receive time changes", async () => {
    setup();
    let current = new Date("2026-10-12T23:59:59.900Z");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => current });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(TRADE_BTC));
    await Bun.sleep(150);
    current = new Date("2026-10-13T00:00:00.100Z");
    server.send(JSON.stringify({ ...TRADE_BTC, price: "13300001" }));
    await Bun.sleep(150);
    await recorder!.stop();

    const day1 = readRecords(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz"));
    const day2 = readRecords(join(dir.path, "trades/BTC/2026-10-13.jsonl.gz"));
    expect(day1.map((r) => r.msg.price)).toEqual(["13239520"]);
    expect(day2.map((r) => r.msg.price)).toEqual(["13300001"]);
    expect(day2[0]!.recv_at).toBe("2026-10-13T00:00:00.100Z");
  });

  test("appends to the same day's file after a restart", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(TRADE_BTC));
    await Bun.sleep(150);
    await recorder!.stop();

    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 2);
    server.send(JSON.stringify({ ...TRADE_BTC, side: "SELL", size: "0.777" }));
    await Bun.sleep(150);
    await recorder!.stop();

    const rows = readRecords(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz"));
    expect(rows.map((r) => r.msg.size)).toEqual(["0.0001", "0.777"]);
  });

  test("skips non-JSON and messages without channel/symbol, logs them, and keeps recording", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    server.send("not json at all");
    server.send(JSON.stringify({ error: "ERR-5003 Request too many." }));
    server.send(JSON.stringify(TRADE_BTC));
    await Bun.sleep(200);
    await recorder!.stop();

    expect(readRecords(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz"))).toEqual([
      { recv_at: "2026-10-12T10:00:00.000Z", msg: TRADE_BTC },
    ]);
    expect(logs.some((l) => l.includes("ERR-5003"))).toBe(true);
    expect(logs.some((l) => l.includes("not json at all"))).toBe(true);
  });

  test("reconnects after the server closes the connection and subscribes again", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    const subs: Subscription[] = [
      { channel: "orderbooks", symbol: "BTC" },
      { channel: "trades", symbol: "BTC" },
    ];
    start({ subscriptions: subs, now: () => recvAt });
    await waitFor(() => subscribesOn(0).length === 2);
    server.closeConn(0);

    await waitFor(() => server.opened === 2 && subscribesOn(1).length === 2);
    expect(subscribesOn(1).map((r) => JSON.parse(r.text))).toEqual(
      subs.map((s) => ({ command: "subscribe", channel: s.channel, symbol: s.symbol })),
    );
    server.send(JSON.stringify(TRADE_BTC), 1);
    await Bun.sleep(150);
    await recorder!.stop();
    expect(readRecords(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz")).length).toBe(1);
  });

  test("doubles the reconnect wait up to the maximum and resets it after a message", async () => {
    setup();
    const opens: number[] = [];
    let refuse = true;
    const origOpened = () => server.opened;
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }] });

    // 開いた直後にサーバーが切る状態を 5 回続ける
    let seen = 0;
    while (opens.length < 5) {
      await waitFor(() => origOpened() > seen, 3000);
      seen = origOpened();
      opens.push(Date.now());
      if (refuse) server.closeConn(seen - 1);
    }
    const gaps = opens.slice(1).map((t, i) => t - opens[i]!);
    // 50 → 100 → 200 → 400 (上限)
    expect(gaps[0]!).toBeLessThan(150);
    expect(gaps[2]!).toBeGreaterThanOrEqual(180);
    expect(Math.max(...gaps)).toBeLessThan(400 + 200);

    // 次の接続ではメッセージを 1 件届けてから切る。待ちは初期値に戻る
    refuse = false;
    await waitFor(() => origOpened() > seen, 3000);
    seen = origOpened();
    server.send(JSON.stringify(TRADE_BTC), seen - 1);
    await Bun.sleep(50);
    const closedAt = Date.now();
    server.closeConn(seen - 1);
    await waitFor(() => origOpened() > seen, 3000);
    expect(Date.now() - closedAt).toBeLessThan(150);
  });

  test("reconnects when nothing arrives within the idle timeout", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], idleTimeoutMs: 300 });
    await waitFor(() => server.opened === 1);
    await waitFor(() => server.opened >= 2, 2000);
    expect(server.opened).toBeGreaterThanOrEqual(2);
  });

  test("logs per-stream message counts at the stats interval", async () => {
    setup();
    start({ subscriptions: [{ channel: "orderbooks", symbol: "BTC" }], statsIntervalMs: 100 });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(OB_BTC));
    server.send(JSON.stringify(OB_BTC));
    await waitFor(() => logs.some((l) => /orderbooks\/BTC=2\b/.test(l)), 1000);
  });

  test("stop closes the connection and does not reconnect", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }] });
    await waitFor(() => server.opened === 1);
    await recorder!.stop();
    await Bun.sleep(300);
    expect(server.opened).toBe(1);
  });
});
