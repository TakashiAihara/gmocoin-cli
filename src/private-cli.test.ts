import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");
const KEY = "test-key";
const SECRET = "test-secret";

type Req = { method: string; path: string; query: string; body: string; signOk: boolean };

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

// 偽の Private API。署名を本物と同じ式で検証し、受けたリクエストを全部残す
function fakePrivate(respond: (r: Req) => Response | object) {
  const reqs: Req[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/private/, "");
      const body = await req.text();
      const ts = req.headers.get("API-TIMESTAMP") ?? "";
      const expected = createHmac("sha256", SECRET)
        .update(ts + req.method + path + body)
        .digest("hex");
      const r: Req = {
        method: req.method,
        path,
        query: url.search,
        body,
        signOk: req.headers.get("API-KEY") === KEY && req.headers.get("API-SIGN") === expected,
      };
      reqs.push(r);
      const out = respond(r);
      return out instanceof Response ? out : Response.json(out);
    },
  });
  return { reqs, url: `http://127.0.0.1:${server.port}/private` };
}

async function run(args: string[], url: string, env: Record<string, string | undefined> = {}) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      GMOCOIN_API_KEY: KEY,
      GMOCOIN_API_SECRET: SECRET,
      GMOCOIN_PRIVATE_API_URL: url,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

const ok = (data?: unknown) => ({ status: 0, ...(data === undefined ? {} : { data }) });

test("balance signs the request and prints amounts as numbers", async () => {
  const api = fakePrivate(() =>
    ok([
      { amount: "10000", available: "9000", conversionRate: "1", symbol: "JPY" },
      { amount: "0.0012", available: "0.0012", conversionRate: "15000000", symbol: "BTC" },
    ]),
  );
  const r = await run(["balance"], api.url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([
    { symbol: "JPY", amount: 10000, available: 9000 },
    { symbol: "BTC", amount: 0.0012, available: 0.0012 },
  ]);
  expect(api.reqs).toEqual([
    { method: "GET", path: "/v1/account/assets", query: "", body: "", signOk: true },
  ]);
});

test("a market order sends the size as written and no price", async () => {
  const api = fakePrivate(() => ok("637000"));
  const r = await run(["order", "--side", "BUY", "--type", "market", "--size", "0.0001"], api.url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ orderId: "637000" });
  expect(api.reqs.length).toBe(1);
  expect(api.reqs[0]!.signOk).toBe(true);
  expect(api.reqs[0]!.path).toBe("/v1/order");
  expect(JSON.parse(api.reqs[0]!.body)).toEqual({
    symbol: "BTC",
    side: "BUY",
    executionType: "MARKET",
    size: "0.0001",
  });
});

test("a post-only limit order sends the price and timeInForce SOK", async () => {
  const api = fakePrivate(() => ok("637001"));
  const r = await run(
    [
      "order",
      "--side",
      "SELL",
      "--type",
      "limit",
      "--size",
      "0.001",
      "--price",
      "15000123",
      "--post-only",
    ],
    api.url,
  );
  expect(r.code).toBe(0);
  expect(api.reqs[0]!.signOk).toBe(true);
  expect(JSON.parse(api.reqs[0]!.body)).toEqual({
    symbol: "BTC",
    side: "SELL",
    executionType: "LIMIT",
    size: "0.001",
    price: "15000123",
    timeInForce: "SOK",
  });
});

test("a limit order without --price is refused before anything is sent", async () => {
  const api = fakePrivate(() => ok("1"));
  const r = await run(["order", "--side", "BUY", "--type", "limit", "--size", "0.001"], api.url);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("--price is required for limit orders");
  expect(api.reqs.length).toBe(0);
});

test("a market order with --post-only is refused before anything is sent", async () => {
  const api = fakePrivate(() => ok("1"));
  const r = await run(
    ["order", "--side", "BUY", "--type", "market", "--size", "0.001", "--post-only"],
    api.url,
  );
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("--price and --post-only are for limit orders only");
  expect(api.reqs.length).toBe(0);
});

test("cancel sends the order id as a number and prints it back", async () => {
  const api = fakePrivate(() => ok());
  const r = await run(["cancel", "123456789"], api.url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ orderId: "123456789" });
  expect(api.reqs[0]!.path).toBe("/v1/cancelOrder");
  expect(api.reqs[0]!.signOk).toBe(true);
  expect(JSON.parse(api.reqs[0]!.body)).toEqual({ orderId: 123456789 });
});

const activeOrder = (n: number) => ({
  rootOrderId: n,
  orderId: n,
  symbol: "BTC",
  side: "BUY",
  orderType: "NORMAL",
  executionType: "LIMIT",
  settleType: "OPEN",
  size: "0.002",
  executedSize: "0.0005",
  price: "14990000",
  losscutPrice: "0",
  status: "ORDERED",
  timeInForce: "FAS",
  timestamp: "2026-11-01T01:07:24.217Z",
});

test("orders reads every page and maps the fields", async () => {
  const api = fakePrivate((r) => {
    const page = new URLSearchParams(r.query).get("page");
    const list =
      page === "1" ? Array.from({ length: 100 }, (_, i) => activeOrder(i + 1)) : [activeOrder(777)];
    return ok({ pagination: { currentPage: Number(page), count: 100 }, list });
  });
  const r = await run(["orders"], api.url);
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.length).toBe(101);
  expect(out[100]).toEqual({
    orderId: "777",
    side: "BUY",
    type: "limit",
    price: 14990000,
    size: 0.002,
    executedSize: 0.0005,
    status: "ORDERED",
    timestamp: Date.parse("2026-11-01T01:07:24.217Z"),
  });
  expect(api.reqs.map((q) => q.query)).toEqual([
    "?symbol=BTC&page=1&count=100",
    "?symbol=BTC&page=2&count=100",
  ]);
  expect(api.reqs.every((q) => q.signOk && q.path === "/v1/activeOrders")).toBe(true);
});

test("orders prints [] when the exchange returns data without a list", async () => {
  const api = fakePrivate(() => ok({}));
  const r = await run(["orders"], api.url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([]);
});

test("executions prints the fills of the order with ms timestamps", async () => {
  const api = fakePrivate(() =>
    ok({
      list: [
        {
          executionId: 72123911,
          orderId: 123456789,
          positionId: 1234567,
          symbol: "BTC",
          side: "BUY",
          settleType: "OPEN",
          size: "0.0007",
          price: "15000000",
          lossGain: "0",
          fee: "4",
          timestamp: "2026-11-01T02:15:06.081Z",
        },
      ],
    }),
  );
  const r = await run(["executions", "--order-id", "123456789"], api.url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([
    {
      executionId: "72123911",
      orderId: "123456789",
      side: "BUY",
      price: 15000000,
      size: 0.0007,
      fee: 4,
      timestamp: Date.parse("2026-11-01T02:15:06.081Z"),
    },
  ]);
  expect(api.reqs[0]!.query).toBe("?orderId=123456789");
  expect(api.reqs[0]!.signOk).toBe(true);
});

for (const missing of ["GMOCOIN_API_KEY", "GMOCOIN_API_SECRET"]) {
  test(`a missing ${missing} exits 2 without sending anything`, async () => {
    const api = fakePrivate(() => ok([]));
    const r = await run(["balance"], api.url, { [missing]: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("GMOCOIN_API_KEY and GMOCOIN_API_SECRET must be set");
    expect(api.reqs.length).toBe(0);
  });
}

test("an exchange rejection exits 4 with the response on stderr, sent once", async () => {
  const messages = [{ message_code: "ERR-201", message_string: "Trading margin is insufficient" }];
  const api = fakePrivate(() => ({ status: 1, messages, responsetime: "2026-11-01T00:00:00Z" }));
  const r = await run(["order", "--side", "BUY", "--type", "market", "--size", "1"], api.url);
  expect(r.code).toBe(4);
  expect(JSON.parse(r.stderr)).toEqual({ status: 1, messages });
  expect(r.stdout).toBe("");
  expect(api.reqs.length).toBe(1);
});

test("an unexpected response exits 1 and the order is not retried", async () => {
  const api = fakePrivate(() => new Response("bad gateway", { status: 502 }));
  const r = await run(["order", "--side", "BUY", "--type", "market", "--size", "1"], api.url);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("unexpected response (HTTP 502)");
  expect(api.reqs.length).toBe(1);
});

test("an unreachable API exits 1", async () => {
  const r = await run(["balance"], "http://127.0.0.1:9/private");
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
});

test("a key a header cannot carry exits 2 without sending anything or echoing it", async () => {
  const api = fakePrivate(() => ok([]));
  const r = await run(["balance"], api.url, { GMOCOIN_API_KEY: "abc def" });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("GMOCOIN_API_KEY has characters a header cannot carry");
  expect(r.stderr).not.toContain("abc def");
  expect(api.reqs.length).toBe(0);
});

test("a response without a status exits 1", async () => {
  const api = fakePrivate(() => ({ data: [] }));
  const r = await run(["balance"], api.url);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("unexpected response (HTTP 200)");
});

test("an HTTP error carrying status 0 exits 1", async () => {
  const api = fakePrivate(() => Response.json({ status: 0, data: [] }, { status: 500 }));
  const r = await run(["balance"], api.url);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("unexpected HTTP 500 with status 0");
});

test("an active order without a price prints price null", async () => {
  const { price: _, ...market } = { ...activeOrder(5), executionType: "MARKET" };
  const api = fakePrivate(() => ok({ list: [market] }));
  const r = await run(["orders"], api.url);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)[0]).toMatchObject({ orderId: "5", type: "market", price: null });
});
