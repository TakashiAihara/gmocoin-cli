import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { recordPath } from "./sink.ts";

export type Channel = "orderbooks" | "trades";

export const CHANNELS: readonly Channel[] = ["orderbooks", "trades"];

export const DEFAULT_PUBLIC_WS_URL = "wss://api.coin.z.com/ws/public/v1";

export type Subscription = { channel: Channel; symbol: string };

export type RecorderOptions = {
  url: string;
  subscriptions: Subscription[];
  outDir: string;
  subscribeIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  idleTimeoutMs?: number;
  statsIntervalMs?: number;
  flushIntervalMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  onFatal?: (err: Error) => void;
};

export type Recorder = {
  stop(): Promise<void>;
};

const SYMBOL_PATTERN = /^[A-Z0-9_]+$/;

function parseAccepted(text: string): Subscription | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return undefined;

  const { channel, symbol } = msg as Record<string, unknown>;
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) {
    return undefined;
  }
  if (typeof symbol !== "string" || !SYMBOL_PATTERN.test(symbol)) return undefined;

  return { channel: channel as Channel, symbol };
}

export function startRecorder(opts: RecorderOptions): Recorder {
  const {
    url,
    outDir,
    subscribeIntervalMs = 1100,
    backoffInitialMs = 1000,
    backoffMaxMs = 60_000,
    idleTimeoutMs = 60_000,
    statsIntervalMs = 60_000,
    flushIntervalMs = 5000,
    now = () => new Date(),
    log = (line: string) => console.error(line),
  } = opts;
  const onFatal = opts.onFatal ?? ((err: Error) => log(`fatal: ${err.message}`));

  const subscriptions = [
    ...new Map(opts.subscriptions.map((s) => [`${s.channel}/${s.symbol}`, s])).values(),
  ];
  const counts = new Map<string, number>(subscriptions.map((s) => [`${s.channel}/${s.symbol}`, 0]));
  const buffers = new Map<string, string[]>();
  const checkedPaths = new Set<string>();

  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = backoffInitialMs;
  let lastSubscribeAt = Number.NEGATIVE_INFINITY;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const flushTimer = setInterval(flush, flushIntervalMs);
  const statsTimer = setInterval(() => {
    log(`stats ${[...counts].map(([k, n]) => `${k}=${n}`).join(" ")}`);
  }, statsIntervalMs);

  function closeSocket(sock: WebSocket) {
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try {
      sock.close();
    } catch {}
  }

  function halt() {
    stopped = true;
    clearInterval(flushTimer);
    clearInterval(statsTimer);
    clearTimeout(idleTimer);
    clearTimeout(subscribeTimer);
    clearTimeout(reconnectTimer);
    if (ws) closeSocket(ws);
    ws = undefined;
  }

  function quarantineIfTorn(path: string) {
    if (checkedPaths.has(path)) return;
    checkedPaths.add(path);
    if (!existsSync(path)) return;
    try {
      gunzipSync(readFileSync(path));
    } catch {
      const moved = `${path}.corrupt-${now().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(path, moved);
      log(`moved unreadable file aside: ${moved}`);
    }
  }

  function flush() {
    const pending = [...buffers];
    buffers.clear();
    let written = 0;
    try {
      for (const [path, lines] of pending) {
        mkdirSync(dirname(path), { recursive: true });
        quarantineIfTorn(path);
        appendFileSync(path, gzipSync(lines.join("")));
        written++;
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const dropped = pending.slice(written).reduce((n, [, lines]) => n + lines.length, 0);
      halt();
      log(`write failed, dropped ${dropped} line(s): ${err.message}`);
      onFatal(err);
    }
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (ws) drop(ws, `no valid message for ${idleTimeoutMs}ms`);
    }, idleTimeoutMs);
  }

  function drop(sock: WebSocket, reason: string) {
    log(`disconnected: ${reason}`);
    closeSocket(sock);
    ws = undefined;
    clearTimeout(idleTimer);
    clearTimeout(subscribeTimer);

    const wait = backoff;
    backoff = Math.min(backoff * 2, backoffMaxMs);
    reconnectTimer = setTimeout(connect, wait);
  }

  function subscribeAll(sock: WebSocket) {
    let i = 0;
    const next = () => {
      if (i >= subscriptions.length) return;

      const wait = lastSubscribeAt + subscribeIntervalMs - Date.now();
      if (wait > 0) {
        subscribeTimer = setTimeout(next, wait);
        return;
      }
      const sub = subscriptions[i]!;
      const option = sub.channel === "trades" ? { option: "TAKER_ONLY" } : {};
      sock.send(JSON.stringify({ command: "subscribe", ...sub, ...option }));
      lastSubscribeAt = Date.now();
      i++;
      next();
    };
    next();
  }

  function receive(text: string) {
    const at = now();
    const accepted = parseAccepted(text);
    if (!accepted) {
      log(`skipped message: ${text.slice(0, 200)}`);
      return;
    }

    armIdle();
    backoff = backoffInitialMs;

    const key = `${accepted.channel}/${accepted.symbol}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);

    const path = recordPath(outDir, accepted.channel, accepted.symbol, at);
    const line = `{"recv_at":"${at.toISOString()}","msg":${text.replace(/[\r\n]/g, " ")}}\n`;
    const lines = buffers.get(path);
    if (lines) lines.push(line);
    else buffers.set(path, [line]);
  }

  function connect() {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    armIdle();

    sock.onopen = () => subscribeAll(sock);
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") receive(ev.data);
      else log("skipped message: non-text frame");
    };
    sock.onclose = () => drop(sock, "closed");
    sock.onerror = () => drop(sock, "error");
  }

  connect();

  return {
    async stop() {
      if (stopped) return;
      flush();
      halt();
    },
  };
}
