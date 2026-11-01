// Private API のサブコマンド。契約 (コマンド・出力・exit code) は soba の docs/design/live.md
// 「gmocoin-cli に足すもの」で、soba の判断ループはこの形だけに依存する
import { createHmac } from "node:crypto";

export const DEFAULT_PRIVATE_API_URL = "https://api.coin.z.com/private";

const TIMEOUT_MS = 10_000;

export type Credentials = { key: string; secret: string };

export type ExchangeMessage = { message_code: string; message_string: string };

// 取引所が status != 0 で返した拒否。soba は message_code で分岐する
export class ExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly messages: ExchangeMessage[],
  ) {
    super(`exchange returned status ${status}`);
  }
}

// キーが無い・使えない。何も送っていない
export class CredentialsError extends Error {}

export function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials {
  const key = env.GMOCOIN_API_KEY?.trim() ?? "";
  const secret = env.GMOCOIN_API_SECRET?.trim() ?? "";
  if (key === "" || secret === "") {
    throw new CredentialsError("GMOCOIN_API_KEY and GMOCOIN_API_SECRET must be set");
  }
  // ヘッダに入らない文字は fetch の例外が値ごと文面に出すので、値を出さずに先に止める
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new CredentialsError("GMOCOIN_API_KEY has characters a header cannot carry");
  }
  return { key, secret };
}

export type Client = {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
};

export function createClient(opts: {
  baseUrl: string;
  credentials: Credentials;
  timeoutMs?: number;
}): Client {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");

  // 1 回の呼び出しで 1 リクエストだけ送り、打ち直さない (発注の二重を避ける。打ち直すかは呼ぶ側)
  async function send(method: "GET" | "POST", path: string, query: string, body: string) {
    const timestamp = Date.now().toString();
    // 署名に query は入れない (公式ドキュメントの activeOrders の例)
    const sign = createHmac("sha256", opts.credentials.secret)
      .update(timestamp + method + path + body)
      .digest("hex");
    const res = await fetch(base + path + query, {
      method,
      headers: {
        "API-KEY": opts.credentials.key,
        "API-TIMESTAMP": timestamp,
        "API-SIGN": sign,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: { status?: unknown; data?: unknown; messages?: unknown } | null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`unexpected response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (typeof json !== "object" || json === null || typeof json.status !== "number") {
      throw new Error(`unexpected response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (json.status !== 0) {
      throw new ExchangeError(
        json.status,
        Array.isArray(json.messages) ? (json.messages as ExchangeMessage[]) : [],
      );
    }
    if (!res.ok) throw new Error(`unexpected HTTP ${res.status} with status 0`);
    return json.data;
  }

  return {
    get: (path, query) => send("GET", path, query ? `?${new URLSearchParams(query)}` : "", ""),
    post: (path, body) => send("POST", path, "", JSON.stringify(body)),
  };
}

function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`unexpected ${field}: ${JSON.stringify(v)}`);
  return n;
}

function ms(v: unknown, field: string): number {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new Error(`unexpected ${field}: ${JSON.stringify(v)}`);
  return t;
}

function id(v: unknown, field: string): string {
  if ((typeof v !== "number" && typeof v !== "string") || String(v) === "") {
    throw new Error(`unexpected ${field}: ${JSON.stringify(v)}`);
  }
  return String(v);
}

function list(data: unknown): Record<string, unknown>[] {
  // 0 件のときは list を持たない data ({}) が返る。data そのものが欠けた応答を 0 件と読まない
  // (呼ぶ側は「約定なし」と読んで打ち直し、二重発注になる)
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`unexpected data: ${JSON.stringify(data)}`);
  }
  const l = (data as { list?: unknown }).list;
  if (l === undefined) return [];
  if (!Array.isArray(l)) throw new Error(`unexpected list: ${JSON.stringify(l)}`);
  return l as Record<string, unknown>[];
}

export async function balance(client: Client) {
  const data = await client.get("/v1/account/assets");
  if (!Array.isArray(data)) throw new Error(`unexpected assets: ${JSON.stringify(data)}`);
  return (data as Record<string, unknown>[]).map((a) => ({
    symbol: id(a.symbol, "symbol"),
    amount: num(a.amount, "amount"),
    available: num(a.available, "available"),
  }));
}

export type OrderRequest = {
  symbol: string;
  side: "BUY" | "SELL";
  type: "market" | "limit";
  size: string;
  price?: string;
  postOnly?: boolean;
  clientOrderId: string;
};

export async function order(client: Client, req: OrderRequest) {
  const body: Record<string, unknown> = {
    symbol: req.symbol,
    side: req.side,
    executionType: req.type === "market" ? "MARKET" : "LIMIT",
    size: req.size,
    clientOrderId: req.clientOrderId,
  };
  if (req.type === "limit") body.price = req.price;
  if (req.postOnly) body.timeInForce = "SOK";
  return { orderId: id(await client.post("/v1/order", body), "orderId") };
}

export async function cancel(client: Client, orderId: string) {
  await client.post("/v1/cancelOrder", { orderId: Number(orderId) });
  return { orderId };
}

const PAGE_SIZE = 100;
// 1 万円の資金で 1 万件の未約定は無い。超えたら取引所の応答の誤り (同じページを返し続ける等) とみなす
const MAX_PAGES = 100;

export async function activeOrders(client: Client, symbol: string) {
  const all: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const l = list(
      await client.get("/v1/activeOrders", {
        symbol,
        page: String(page),
        count: String(PAGE_SIZE),
      }),
    );
    all.push(...l);
    if (l.length < PAGE_SIZE) break;
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages of active orders`);
  }
  return all.map((o) => ({
    orderId: id(o.orderId, "orderId"),
    clientOrderId: clientOrderIdOf(o.clientOrderId),
    side: id(o.side, "side"),
    type: id(o.executionType, "executionType").toLowerCase(),
    // 成行の注文に値段は無い (price を持たない・null・"0" のどれで来ても null にする)
    price: o.executionType === "MARKET" ? null : num(o.price, "price"),
    size: num(o.size, "size"),
    executedSize: num(o.executedSize, "executedSize"),
    status: id(o.status, "status"),
    timestamp: ms(o.timestamp, "timestamp"),
  }));
}

// 呼ぶ側が採番した ID。注文を送ったか分からないとき (exit 1) に、これで約定と未約定を引く
function clientOrderIdOf(v: unknown): string | null {
  // 付けずに出した注文 (Web の画面から等) は、欠ける・null・空文字のどれで来ても null にする
  return v === undefined || v === null || v === "" ? null : id(v, "clientOrderId");
}

export async function executions(
  client: Client,
  by: { orderId: string } | { clientOrderId: string },
) {
  return list(await client.get("/v1/executions", by)).map((e) => ({
    executionId: id(e.executionId, "executionId"),
    orderId: id(e.orderId, "orderId"),
    clientOrderId: clientOrderIdOf(e.clientOrderId),
    side: id(e.side, "side"),
    price: num(e.price, "price"),
    size: num(e.size, "size"),
    fee: num(e.fee, "fee"),
    timestamp: ms(e.timestamp, "timestamp"),
  }));
}
