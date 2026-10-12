import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ServerWebSocket } from "bun";

export type Received = { conn: number; at: number; text: string };

export type FakeServer = {
  url: string;
  received: Received[];
  connections: ServerWebSocket<{ id: number }>[];
  opened: number;
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

export function readRecords(path: string): { recv_at: string; msg: Record<string, unknown> }[] {
  if (!existsSync(path)) return [];
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}
