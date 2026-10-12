import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";

export type Received = { conn: number; at: number; text: string };

export type FakeServer = {
  url: string;
  received: Received[];
  connections: ServerWebSocket<{ id: number }>[];
  opened: number;
  closed: number;
  send(text: string, conn?: number): void;
  closeConn(conn?: number): void;
  stop(): void;
};

// 偽の Public WebSocket。テストから送信とサーバー側の切断を操作する
export function startFakeServer(): FakeServer {
  const state: FakeServer = {
    url: "",
    received: [],
    connections: [],
    opened: 0,
    closed: 0,
    send(text, conn) {
      const ws = state.connections[conn ?? state.connections.length - 1];
      if (!ws) throw new Error("no connection");
      ws.send(text);
    },
    closeConn(conn) {
      state.connections[conn ?? state.connections.length - 1]?.close();
    },
    stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve<{ id: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { id: state.opened } })) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        state.connections.push(ws);
        state.opened++;
      },
      message(ws, msg) {
        state.received.push({ conn: ws.data.id, at: Date.now(), text: String(msg) });
      },
      close() {
        state.closed++;
      },
    },
  });
  state.url = `ws://127.0.0.1:${server.port}`;
  return state;
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

export function tempDir(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "gmocoin-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

// 受け付けるだけで黙る TCP サーバー。handshake: false なら upgrade を返さず、true なら
// upgrade だけ返してその後は close フレームにも応えない (応答しなくなった相手を作る)
export function startSilentTcpServer(opts: { handshake?: boolean } = {}): {
  url: string;
  accepts: number[];
  closes: number[];
  stop(): void;
} {
  const accepts: number[] = [];
  const closes: number[] = [];
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        accepts.push(Date.now());
      },
      data(socket, data) {
        if (!opts.handshake) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(data.toString())?.[1];
        if (!key) return;
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      },
      close() {
        closes.push(Date.now());
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${listener.port}`,
    accepts,
    closes,
    stop: () => listener.stop(true),
  };
}

export function readRawLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

export function readRecords(path: string): { recv_at: string; msg: Record<string, unknown> }[] {
  if (!existsSync(path)) return [];
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}
