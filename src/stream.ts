// gmocoin stream: Public WebSocket の約定 (または板) を replay と同じ形の event で渡し続ける。
// 契約は soba の docs/design/live.md「gmocoin-cli に足すもの」
import type { MarketEvent } from "./backtest.ts";
import { toMarketEvent } from "./market-data.ts";
import type { Channel } from "./record.ts";

export type StreamOptions = {
  url: string;
  symbol: string;
  channel: Channel;
  onEvent: (e: MarketEvent) => void;
  subscribeIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  idleTimeoutMs?: number;
  log?: (line: string) => void;
};

export function startStream(opts: StreamOptions): { stop(): void } {
  const {
    url,
    symbol,
    channel,
    onEvent,
    subscribeIntervalMs = 1100,
    backoffInitialMs = 1000,
    backoffMaxMs = 60_000,
    idleTimeoutMs = 60_000,
    log = (line: string) => console.error(line),
  } = opts;

  // 約定だけだと閑散時に 90 秒届かないことがあり、無通信の判定が正常な接続を切る (issue #3)。
  // 板 (約 1.8 件/秒) も購読して生存の印にし、出すのは指定の channel だけにする
  const subscriptions: Channel[] = channel === "trades" ? ["trades", "orderbooks"] : [channel];

  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = backoffInitialMs;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function closeSocket(sock: WebSocket) {
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try {
      sock.close();
    } catch {}
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (ws) drop(ws, `no message for ${idleTimeoutMs}ms`);
    }, idleTimeoutMs);
  }

  function drop(sock: WebSocket, reason: string) {
    const wait = backoff;
    log(`disconnected: ${reason}, reconnecting in ${wait}ms`);
    closeSocket(sock);
    ws = undefined;
    clearTimeout(idleTimer);
    clearTimeout(subscribeTimer);
    backoff = Math.min(backoff * 2, backoffMaxMs);
    reconnectTimer = setTimeout(connect, wait);
  }

  function subscribe(sock: WebSocket, i: number) {
    const ch = subscriptions[i];
    if (!ch) return;
    const option = ch === "trades" ? { option: "TAKER_ONLY" } : {};
    sock.send(JSON.stringify({ command: "subscribe", channel: ch, symbol, ...option }));
    // 購読は 1 秒に 1 回まで (超えると購読が拒否される)
    subscribeTimer = setTimeout(() => subscribe(sock, i + 1), subscribeIntervalMs);
  }

  function receive(sock: WebSocket, text: string) {
    let msg: { channel?: unknown; symbol?: unknown; timestamp?: unknown; error?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      log(`skipped message: ${text.slice(0, 200).replace(/[\r\n]/g, " ")}`);
      return;
    }
    // 購読の拒否 (ERR-5003 Request too many 等) は、板が届き続けると約定だけ黙って止まる。
    // 繋ぎ直して全部購読し直す
    if (typeof msg.error === "string") {
      drop(sock, `rejected: ${msg.error}`);
      return;
    }
    const ch = subscriptions.find((c) => c === msg.channel);
    if (!ch || msg.symbol !== symbol) {
      log(`skipped message: ${text.slice(0, 200).replace(/[\r\n]/g, " ")}`);
      return;
    }
    armIdle();
    backoff = backoffInitialMs;
    if (ch !== channel) return;

    const t = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
    let event: MarketEvent;
    try {
      if (!Number.isFinite(t)) throw new Error("bad timestamp");
      event = toMarketEvent(ch, msg, t);
    } catch (err) {
      log(`skipped message (${(err as Error).message}): ${text.slice(0, 200)}`);
      return;
    }
    onEvent(event);
  }

  function connect() {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    armIdle();
    sock.onopen = () => subscribe(sock, 0);
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") receive(sock, ev.data);
      else log("skipped message: non-text frame");
    };
    sock.onclose = () => drop(sock, "closed");
    sock.onerror = () => drop(sock, "error");
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(idleTimer);
      clearTimeout(subscribeTimer);
      clearTimeout(reconnectTimer);
      if (ws) closeSocket(ws);
      ws = undefined;
    },
  };
}
