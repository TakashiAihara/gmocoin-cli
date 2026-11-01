// gmocoin stream: Public WebSocket の約定 (または板) を replay と同じ形の event で渡し続ける。
// 契約は soba の docs/design/live.md「gmocoin-cli に足すもの」
import type { MarketEvent } from "./backtest.ts";
import { toMarketEvent } from "./market-data.ts";
import type { Channel } from "./record.ts";

// 再接続の間に届かなかった分の印。since は切断を検知した時刻、t は繋ぎ直して最初に受け取った時刻
export type Gap = { kind: "gap"; t: number; since: number };

export type StreamOptions = {
  url: string;
  symbol: string;
  channel: Channel;
  onEvent: (e: MarketEvent | Gap) => void;
  subscribeIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  idleTimeoutMs?: number;
  log?: (line: string) => void;
  // 繋ぎ直しても直らない拒否 (存在しない銘柄など)。呼ぶ側が止まる
  onFatal?: (err: Error) => void;
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
  const onFatal = opts.onFatal ?? ((err: Error) => log(`fatal: ${err.message}`));

  // 約定だけだと閑散時に 90 秒届かないことがあり、無通信の判定が正常な接続を切る (issue #3)。
  // 板 (約 1.8 件/秒) も購読して生存の印にし、出すのは指定の channel だけにする
  const subscriptions: Channel[] = channel === "trades" ? ["trades", "orderbooks"] : [channel];

  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = backoffInitialMs;

  // 繋ぎ直しが続いても、印は最初に切れた時刻から 1 つだけ出す
  let gapSince: number | undefined;
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
    gapSince ??= Date.now();
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
    const skip = (why: string) =>
      log(`skipped message${why}: ${text.slice(0, 200).replace(/[\r\n]/g, " ")}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      skip("");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      skip("");
      return;
    }
    const msg = parsed as {
      channel?: unknown;
      symbol?: unknown;
      timestamp?: unknown;
      error?: unknown;
    };
    // 購読の拒否は、板が届き続けると約定だけ黙って止まるので、繋ぎ直して全部購読し直す。
    // ERR-5106 (Invalid request parameter) は送った銘柄・channel が誤りで、繋ぎ直しても直らない。
    // それ以外 (ERR-5003 Request too many、メンテナンス、未知のコード) は止めずに繋ぎ直す
    if (typeof msg.error === "string") {
      if (msg.error.startsWith("ERR-5106")) {
        stop();
        onFatal(new Error(`subscribe rejected: ${msg.error}`));
        return;
      }
      drop(sock, `rejected: ${msg.error}`);
      return;
    }
    const ch = subscriptions.find((c) => c === msg.channel);
    if (!ch || msg.symbol !== symbol) {
      skip("");
      return;
    }
    // 生存の印に数えるのも、壊れていない中身だけ (板も同じく検査する)
    const t = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
    let event: MarketEvent;
    try {
      if (!Number.isFinite(t)) throw new Error("bad timestamp");
      event = toMarketEvent(ch, msg, t);
    } catch (err) {
      skip(` (${(err as Error).message})`);
      return;
    }

    armIdle();
    // 最後に送る購読の channel にデータが届いたら、それより前の購読への拒否はもう届いていない
    // (1 つの接続の中で frame は順に届く)。それまでは backoff を戻さない
    if (ch === subscriptions[subscriptions.length - 1]) backoff = backoffInitialMs;
    if (gapSince !== undefined) {
      onEvent({ kind: "gap", t: Date.now(), since: gapSince });
      gapSince = undefined;
    }
    if (ch === channel) onEvent(event);
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

  function stop() {
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(subscribeTimer);
    clearTimeout(reconnectTimer);
    if (ws) closeSocket(ws);
    ws = undefined;
  }

  connect();

  return { stop };
}
