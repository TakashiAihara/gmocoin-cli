import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { startRecorder, type Recorder, type RecorderOptions, type Subscription } from "./record.ts";
import { recordPath } from "./sink.ts";
import {
  readRawLines,
  readRecords,
  startFakeServer,
  startSilentTcpServer,
  tempDir,
  waitFor,
  type FakeServer,
} from "./test-helpers.ts";

// UTC 日付で分けることを、ローカル日付と食い違う TZ で確かめる (CI の既定は UTC)
process.env.TZ = "Asia/Tokyo";

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
let fatals: Error[];

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
    onFatal: (e) => fatals.push(e),
    ...over,
  });
  return recorder;
}

function sentOn(conn: number) {
  return server.received.filter((r) => r.conn === conn);
}

function subscribeCommands(subs: Subscription[]) {
  return subs.map((s) =>
    s.channel === "trades"
      ? { command: "subscribe", channel: s.channel, symbol: s.symbol, option: "TAKER_ONLY" }
      : { command: "subscribe", channel: s.channel, symbol: s.symbol },
  );
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
    .sort();
}

function setup() {
  server = startFakeServer();
  dir = tempDir();
  logs = [];
  fatals = [];
  recorder = undefined;
}

afterEach(async () => {
  await recorder?.stop();
  // recordPath のテストは setup を呼ばない
  server?.stop();
  dir?.cleanup();
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
    // JST では 2026-10-13 05:00
    expect(recordPath("/x", "trades", "BTC", new Date("2026-10-12T20:00:00.000Z"))).toBe(
      "/x/trades/BTC/2026-10-12.jsonl.gz",
    );
  });
});

describe("subscribing", () => {
  test("subscribes every pair in order, spaced by the subscribe interval", async () => {
    setup();
    const subs: Subscription[] = [
      { channel: "orderbooks", symbol: "BTC" },
      { channel: "trades", symbol: "BTC" },
      { channel: "trades", symbol: "BTC_JPY" },
    ];
    start({ subscriptions: subs });
    await waitFor(() => server.received.length >= 3);

    expect(server.received.map((r) => JSON.parse(r.text))).toEqual(subscribeCommands(subs));
    const at = server.received.map((r) => r.at);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(140);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(140);
  });

  test("subscribes a repeated pair only once", async () => {
    setup();
    start({
      subscriptions: [
        { channel: "trades", symbol: "BTC" },
        { channel: "trades", symbol: "BTC" },
        { channel: "orderbooks", symbol: "BTC" },
      ],
    });
    await waitFor(() => server.received.length >= 2);
    await Bun.sleep(400);
    expect(server.received.map((r) => JSON.parse(r.text))).toEqual(
      subscribeCommands([
        { channel: "trades", symbol: "BTC" },
        { channel: "orderbooks", symbol: "BTC" },
      ]),
    );
  });

  test("abandons the rest of the sequence when the connection drops mid-way, and keeps the spacing across connections", async () => {
    setup();
    const subs: Subscription[] = [
      { channel: "orderbooks", symbol: "BTC" },
      { channel: "trades", symbol: "BTC" },
      { channel: "trades", symbol: "BTC_JPY" },
    ];
    start({ subscriptions: subs });
    await waitFor(() => sentOn(0).length === 1);
    server.closeConn(0);

    await waitFor(() => sentOn(1).length === 3);
    await Bun.sleep(500);
    expect(sentOn(0).length).toBe(1);
    expect(sentOn(1).map((r) => JSON.parse(r.text))).toEqual(subscribeCommands(subs));
    expect(server.opened).toBe(2);
    const at = server.received.map((r) => r.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(140);
  });
});

describe("writing", () => {
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

  test("keeps the received text as is, without re-serializing it", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    const raw = '{"symbol":"BTC", "channel":"trades","price":1.0,"big":12345678901234567890}';
    server.send(raw);
    await Bun.sleep(150);
    await recorder!.stop();

    expect(readRawLines(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz"))).toEqual([
      `{"recv_at":"2026-10-12T10:00:00.000Z","msg":${raw}}`,
    ]);
  });

  test("turns line breaks inside the received JSON into spaces so a record stays one line", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(TRADE_BTC, null, 2).replaceAll("\n", "\r\n"));
    await Bun.sleep(150);
    await recorder!.stop();

    const lines = readRawLines(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz"));
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).msg).toEqual(TRADE_BTC);
  });

  test("starts a new file when the UTC date of the receive time changes", async () => {
    setup();
    let current = new Date("2026-10-12T23:59:59.900Z");
    // flush を挟まない。日付は書き込み時刻ではなく受信時刻で決まる
    start({
      subscriptions: [{ channel: "trades", symbol: "BTC" }],
      now: () => current,
      flushIntervalMs: 60_000,
    });
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

  test("makes flushed records readable on disk while still running", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(TRADE_BTC));
    const path = join(dir.path, "trades/BTC/2026-10-12.jsonl.gz");
    await waitFor(() => {
      try {
        return readRecords(path).length === 1;
      } catch {
        return false;
      }
    }, 1000);
  });

  test("stop writes what is buffered without waiting for the flush interval", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({
      subscriptions: [{ channel: "trades", symbol: "BTC" }],
      now: () => recvAt,
      flushIntervalMs: 60_000,
    });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(TRADE_BTC));
    await Bun.sleep(100);
    await recorder!.stop();
    expect(readRecords(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz")).length).toBe(1);
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

  test("moves a day file with a broken tail aside before writing, instead of appending after it", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    const path = join(dir.path, "trades/BTC/2026-10-12.jsonl.gz");
    mkdirSync(join(dir.path, "trades/BTC"), { recursive: true });
    const earlier = `{"recv_at":"2026-10-12T09:00:00.000Z","msg":${JSON.stringify(TRADE_BTC)}}\n`;
    const cut = gzipSync(earlier);
    // 完結したメンバーの後ろに、途中で切れたメンバーが残っている状態
    writeFileSync(path, Buffer.concat([cut, cut.subarray(0, cut.length - 6)]));

    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify({ ...TRADE_BTC, size: "0.555" }));
    await Bun.sleep(150);
    await recorder!.stop();

    expect(readRecords(path).map((r) => r.msg.size)).toEqual(["0.555"]);
    const moved = listFiles(dir.path).filter((f) =>
      /^trades\/BTC\/2026-10-12\.jsonl\.gz\.corrupt-/.test(f),
    );
    expect(moved.length).toBe(1);
    expect(readFileSync(join(dir.path, moved[0]!)).subarray(0, cut.length)).toEqual(cut);
    expect(logs.some((l) => l.includes(".corrupt-"))).toBe(true);
  });

  test("keeps appending to a day file that is intact", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    const path = join(dir.path, "trades/BTC/2026-10-12.jsonl.gz");
    mkdirSync(join(dir.path, "trades/BTC"), { recursive: true });
    writeFileSync(
      path,
      gzipSync(`{"recv_at":"2026-10-12T09:00:00.000Z","msg":${JSON.stringify(TRADE_BTC)}}\n`),
    );

    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], now: () => recvAt });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify({ ...TRADE_BTC, size: "0.555" }));
    await Bun.sleep(150);
    await recorder!.stop();

    expect(readRecords(path).map((r) => r.msg.size)).toEqual(["0.0001", "0.555"]);
    expect(listFiles(dir.path)).toEqual(["trades/BTC/2026-10-12.jsonl.gz"]);
  });

  test("reports a write failure through onFatal and stops recording", async () => {
    setup();
    // trades のディレクトリを作れないように、同じ名前の通常ファイルを置く
    writeFileSync(join(dir.path, "trades"), "");
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }] });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(TRADE_BTC));
    await waitFor(() => fatals.length === 1, 1000);
    expect(fatals[0]).toBeInstanceOf(Error);
    expect(logs.some((l) => /dropped 1 line/.test(l))).toBe(true);
    await waitFor(() => server.closed === 1, 1000);
    await Bun.sleep(300);
    expect(server.opened).toBe(1);
  });
});

describe("accepting messages", () => {
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
    expect(server.opened).toBe(1);
  });

  test("logs only the head of a skipped message", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }] });
    await waitFor(() => server.opened === 1);
    server.send(`HEAD-${"x".repeat(5000)}-TAIL`);
    await waitFor(() => logs.some((l) => l.includes("HEAD-")), 1000);
    const line = logs.find((l) => l.includes("HEAD-"))!;
    expect(line.includes("-TAIL")).toBe(false);
    expect(line.length).toBeLessThan(400);
  });

  test("never writes outside the output directory for an unexpected channel or symbol", async () => {
    setup();
    // 抜け出しても一時ディレクトリの中に収まる深さに置き、そこだけを数える
    const out = join(dir.path, "a/b/c/out");
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    start({
      subscriptions: [{ channel: "trades", symbol: "BTC" }],
      outDir: out,
      now: () => recvAt,
    });
    await waitFor(() => server.opened === 1);
    for (const bad of [
      { ...TRADE_BTC, channel: "../escaped" },
      { ...TRADE_BTC, symbol: "../../escaped" },
      { ...TRADE_BTC, symbol: "btc" },
      { ...TRADE_BTC, channel: "ticker" },
      { ...TRADE_BTC, symbol: 1 },
    ]) {
      server.send(JSON.stringify(bad));
    }
    for (const bad of ["null", "[]", '"str"', "42"]) server.send(bad);
    server.send(JSON.stringify(TRADE_BTC));
    await Bun.sleep(200);
    await recorder!.stop();

    expect(listFiles(dir.path)).toEqual(["a/b/c/out/trades/BTC/2026-10-12.jsonl.gz"]);
    expect(readRecords(join(out, "trades/BTC/2026-10-12.jsonl.gz")).length).toBe(1);
  });
});

describe("recovering", () => {
  test("reconnects once after the server closes the connection and subscribes again", async () => {
    setup();
    const recvAt = new Date("2026-10-12T10:00:00.000Z");
    const subs: Subscription[] = [
      { channel: "orderbooks", symbol: "BTC" },
      { channel: "trades", symbol: "BTC" },
    ];
    start({ subscriptions: subs, now: () => recvAt });
    await waitFor(() => sentOn(0).length === 2);
    server.closeConn(0);

    await waitFor(() => server.opened === 2 && sentOn(1).length === 2);
    expect(sentOn(1).map((r) => JSON.parse(r.text))).toEqual(subscribeCommands(subs));
    await Bun.sleep(300);
    expect(server.opened).toBe(2);

    server.send(JSON.stringify(TRADE_BTC), 1);
    await Bun.sleep(150);
    await recorder!.stop();
    expect(readRecords(join(dir.path, "trades/BTC/2026-10-12.jsonl.gz")).length).toBe(1);
  });

  test("doubles the reconnect wait up to the maximum and resets it after a message", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }] });

    // 開いた直後にサーバーが切る状態を 6 回続ける
    const opens: number[] = [];
    let seen = 0;
    while (opens.length < 6) {
      await waitFor(() => server.opened > seen, 3000);
      seen = server.opened;
      opens.push(Date.now());
      server.closeConn(seen - 1);
    }
    const gaps = opens.slice(1).map((t, i) => t - opens[i]!);
    // 50 → 100 → 200 → 400 → 400 (上限)。下限は待ちそのもの、上限は待ち + 余裕
    const expected = [50, 100, 200, 400, 400];
    expected.forEach((ms, i) => {
      expect(gaps[i]!).toBeGreaterThanOrEqual(ms - 10);
      expect(gaps[i]!).toBeLessThan(ms + Math.min(ms, 150));
    });

    // 次の接続ではメッセージを 1 件届けてから切る。待ちは初期値に戻る
    await waitFor(() => server.opened > seen, 3000);
    seen = server.opened;
    server.send(JSON.stringify(TRADE_BTC), seen - 1);
    await Bun.sleep(50);
    const closedAt = Date.now();
    server.closeConn(seen - 1);
    await waitFor(() => server.opened > seen, 3000);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(40);
    expect(Date.now() - closedAt).toBeLessThan(150);
  });

  test("reconnects when nothing arrives within the idle timeout, and closes the idle connection", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], idleTimeoutMs: 300 });
    await waitFor(() => server.opened === 1);
    const firstAt = Date.now();
    await waitFor(() => server.opened >= 2, 2000);
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(250);
    await waitFor(() => server.closed >= 1, 1000);
  });

  test("reconnects only once after an idle timeout", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], idleTimeoutMs: 300 });
    await waitFor(() => server.opened === 2, 2000);
    const timer = setInterval(() => {
      try {
        server.send(JSON.stringify(TRADE_BTC), 1);
      } catch {}
    }, 100);
    await Bun.sleep(800);
    clearInterval(timer);
    expect(server.opened).toBe(2);
  });

  test("does not let invalid messages postpone the idle timeout", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], idleTimeoutMs: 300 });
    await waitFor(() => server.opened === 1);
    const timer = setInterval(() => {
      try {
        server.send(JSON.stringify({ error: "ERR-5003 Request too many." }), 0);
      } catch {}
    }, 100);
    const firstAt = Date.now();
    try {
      await waitFor(() => server.opened >= 2, 1500);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(250);
  });

  test("valid messages keep the connection open past the idle timeout", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], idleTimeoutMs: 300 });
    await waitFor(() => server.opened === 1);
    const timer = setInterval(() => server.send(JSON.stringify(TRADE_BTC), 0), 100);
    await Bun.sleep(900);
    clearInterval(timer);
    expect(server.opened).toBe(1);
  });

  test("cuts an idle connection whose peer no longer answers, without waiting for the close handshake", async () => {
    setup();
    const silent = startSilentTcpServer({ handshake: true });
    try {
      start({
        subscriptions: [{ channel: "trades", symbol: "BTC" }],
        url: silent.url,
        idleTimeoutMs: 300,
        backoffInitialMs: 5000,
      });
      await waitFor(() => silent.accepts.length === 1, 1000);
      await Bun.sleep(300);
      const idleAt = Date.now();
      await waitFor(() => silent.closes.length >= 1, 1000);
      expect(Date.now() - idleAt).toBeLessThan(500);
    } finally {
      await recorder?.stop();
      recorder = undefined;
      silent.stop();
    }
  });

  test("gives up on a connection that never completes the handshake", async () => {
    setup();
    const silent = startSilentTcpServer();
    try {
      start({
        subscriptions: [{ channel: "trades", symbol: "BTC" }],
        url: silent.url,
        idleTimeoutMs: 300,
      });
      await waitFor(() => silent.accepts.length >= 2, 2000);
      expect(silent.accepts[1]! - silent.accepts[0]!).toBeGreaterThanOrEqual(250);
      // 捨てた接続は閉じる (残すと止まった接続が溜まり続ける)
      await waitFor(() => silent.closes.length >= 1, 1000);
    } finally {
      await recorder?.stop();
      recorder = undefined;
      silent.stop();
    }
  });
});

describe("stats", () => {
  test("logs cumulative per-stream counts, including subscribed streams with none", async () => {
    setup();
    start({
      subscriptions: [
        { channel: "orderbooks", symbol: "BTC" },
        { channel: "trades", symbol: "BTC" },
      ],
      statsIntervalMs: 100,
    });
    await waitFor(() => server.opened === 1);
    server.send(JSON.stringify(OB_BTC));
    server.send(JSON.stringify(OB_BTC));
    await waitFor(
      () => logs.some((l) => /orderbooks\/BTC=2\b/.test(l) && /trades\/BTC=0\b/.test(l)),
      1000,
    );
    server.send(JSON.stringify(OB_BTC));
    await waitFor(() => logs.some((l) => /orderbooks\/BTC=3\b/.test(l)), 1000);
  });
});

describe("stop", () => {
  test("closes the connection and does not reconnect", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }] });
    await waitFor(() => server.opened === 1);
    await recorder!.stop();
    await waitFor(() => server.closed === 1, 1000);
    await Bun.sleep(300);
    expect(server.opened).toBe(1);
  });

  test("cancels a pending reconnect", async () => {
    setup();
    start({ subscriptions: [{ channel: "trades", symbol: "BTC" }], backoffInitialMs: 300 });
    await waitFor(() => server.opened === 1);
    server.closeConn(0);
    await waitFor(() => server.closed === 1, 1000);
    await recorder!.stop();
    await Bun.sleep(600);
    expect(server.opened).toBe(1);
  });
});
