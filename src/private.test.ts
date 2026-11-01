import { afterEach, expect, test } from "bun:test";
import { createClient } from "./private.ts";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("a request that gets no answer fails after the timeout, sent once", async () => {
  let received = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      received++;
      return new Promise<Response>(() => {});
    },
  });
  const client = createClient({
    baseUrl: `http://127.0.0.1:${server.port}/private`,
    credentials: { key: "k", secret: "s" },
    timeoutMs: 200,
  });
  // timeout が効かない実装でもテストが止まらないよう、2 秒の締め切りと競わせる
  const outcome = await Promise.race([
    client.post("/v1/order", {}).then(
      () => "answered",
      (err: Error) => err.message,
    ),
    Bun.sleep(2000).then(() => "no timeout"),
  ]);
  expect(outcome).toMatch(/timed out|aborted/i);
  expect(received).toBe(1);
});
