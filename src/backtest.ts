// 仕様は docs/design/backtest.md

export type Side = "BUY" | "SELL";

export type Trade = { t: number; side: Side; price: number; size: number };

export type Level = { price: number; size: number };

// asks は安い順、bids は高い順
export type Book = { t: number; asks: Level[]; bids: Level[] };

export type MarketEvent = ({ kind: "trade" } & Trade) | ({ kind: "book" } & Book);

export type OrderAction =
  | { type: "market"; side: Side; size: number; id?: string }
  | { type: "limit"; side: Side; price: number; size: number; id?: string };

export type Action = OrderAction | { type: "cancel"; id: string };

export type OpenOrder = { id: string; side: Side; price: number; size: number; filled: number };

export type Fill = {
  id: string;
  t: number;
  side: Side;
  price: number;
  size: number;
  liquidity: "maker" | "taker";
  feeJpy: number;
};

export type Reject = { id: string; t: number; action: Action; reason: string };

export type Ctx = {
  time: number;
  cash: number;
  position: number;
  lastPrice: number | undefined;
  book: Book | undefined;
  openOrders: readonly OpenOrder[];
  // まだ効いていない (latency 待ちの) 注文と取消。同じ注文の出し直しを避けるために見る
  pending: readonly Action[];
};

type Actions = Action[] | void;

export type Strategy = {
  onTrade?(trade: Trade, ctx: Ctx): Actions;
  onBook?(book: Book, ctx: Ctx): Actions;
  onFill?(fill: Fill, ctx: Ctx): Actions;
  onReject?(reject: Reject, ctx: Ctx): Actions;
};

export type StrategyFactory = () => Strategy;

export type FillModel = "book" | "trades";

export type BacktestOptions = {
  events: AsyncIterable<MarketEvent> | Iterable<MarketEvent>;
  strategy: Strategy;
  fillModel: FillModel;
  capital: number;
  latencyMs?: number;
  slippageBps?: number;
};

export type BacktestResult = {
  startEquity: number;
  endEquity: number;
  pnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  fills: number;
  makerFills: number;
  takerFills: number;
  rejects: number;
  feesJpy: number;
  volumeJpy: number;
  events: number;
  firstEventAt: string | undefined;
  lastEventAt: string | undefined;
  endPosition: number;
  endCash: number;
};

export const TAKER_FEE = 0.0005;
export const MAKER_FEE = -0.0001;
export const SIZE_STEP = 0.00001;
export const TICK_SIZE = 1;

const EPS = 1e-9;

type Resting = {
  id: string;
  side: Side;
  price: number;
  size: number;
  filled: number;
  queueAhead: number;
};

type Pending = { activeAt: number; action: Action };

type Waiting = { id: string; action: OrderAction };

// NOTE: 浮動小数の誤差で整数からずれるので、単位の整数倍かどうかは近さで判定する
function isStep(x: number, unit: number): boolean {
  const n = x / unit;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

// 同じ値段に並んでいる量。板に無い値段は、内側 (スプレッド内や見えている値段の間) なら誰も並んでいない 0、
// 見えている最も外の値段よりさらに外なら見えない所に前の注文がいるとみなして無限大
function queueAt(levels: Level[], side: Side, price: number): number {
  const exact = levels.find((l) => l.price === price);
  if (exact) return exact.size;
  const best = levels[0];
  const worst = levels[levels.length - 1];
  if (!best || !worst) return 0;
  const beyond = (a: number, b: number) => (side === "BUY" ? a > b : a < b);
  if (beyond(price, best.price)) return 0;
  if (beyond(worst.price, price)) return Infinity;
  return 0;
}

// 板を上から食って約定代金を返す。板の厚さが足りなければ undefined
function walk(levels: Level[], size: number): number | undefined {
  let remaining = size;
  let notional = 0;
  for (const l of levels) {
    const take = Math.min(remaining, l.size);
    notional += take * l.price;
    remaining -= take;
    if (remaining <= EPS) return notional;
  }
  return undefined;
}

function consume(levels: Level[], size: number): Level[] {
  let remaining = size;
  const left: Level[] = [];
  for (const l of levels) {
    const take = Math.min(remaining, l.size);
    remaining -= take;
    if (l.size - take > EPS) left.push({ price: l.price, size: l.size - take });
  }
  return left;
}

export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const { strategy, fillModel, capital, latencyMs = 0, slippageBps = 0 } = opts;
  const bookModel = fillModel === "book";
  const slip = slippageBps / 10_000;

  let cash = capital;
  let position = 0;
  let lastPrice: number | undefined;
  let book: Book | undefined;
  let seq = 0;
  let peak = capital;
  let maxDrawdownPct = 0;
  let count = 0;
  let firstT = 0;
  let lastT = 0;
  const stats = { fills: 0, makerFills: 0, takerFills: 0, rejects: 0, feesJpy: 0, volumeJpy: 0 };
  const pending: Pending[] = [];
  const waiting: Waiting[] = [];
  let resting: Resting[] = [];
  const newFills: Fill[] = [];
  const newRejects: Reject[] = [];

  // 板モードでは最初の約定より前に買えるので、そのときは売れる値段 (最良買い) で評価する
  const markValue = (): number => {
    if (position === 0) return 0;
    const price = lastPrice ?? book?.bids[0]?.price;
    if (price === undefined) throw new Error("holding BTC with no price to value it");
    return position * price;
  };

  const reservedBuy = () =>
    resting.reduce((s, r) => (r.side === "BUY" ? s + r.price * (r.size - r.filled) : s), 0);

  const reservedSell = () =>
    resting.reduce((s, r) => (r.side === "SELL" ? s + (r.size - r.filled) : s), 0);

  const shortfall = (side: Side, size: number, cashNeeded: number): string | undefined => {
    if (side === "BUY") {
      return cashNeeded <= cash - reservedBuy() + EPS ? undefined : "insufficient cash";
    }
    return size <= position - reservedSell() + EPS ? undefined : "insufficient BTC";
  };

  const reject = (id: string, t: number, action: Action, reason: string) => {
    newRejects.push({ id, t, action, reason });
    stats.rejects++;
  };

  const fill = (
    id: string,
    t: number,
    side: Side,
    price: number,
    size: number,
    liquidity: "maker" | "taker",
  ) => {
    const notional = price * size;
    const feeJpy = notional * (liquidity === "maker" ? MAKER_FEE : TAKER_FEE);
    cash += (side === "BUY" ? -notional : notional) - feeJpy;
    position += side === "BUY" ? size : -size;
    stats.fills++;
    if (liquidity === "maker") stats.makerFills++;
    else stats.takerFills++;
    stats.feesJpy += feeJpy;
    stats.volumeJpy += notional;
    newFills.push({ id, t, side, price, size, liquidity, feeJpy });
  };

  const execBookMarket = (id: string, action: OrderAction, t: number) => {
    if (!book) {
      reject(id, t, action, "no book yet");
      return;
    }
    const levels = action.side === "BUY" ? book.asks : book.bids;
    const notional = walk(levels, action.size);
    if (notional === undefined) {
      reject(id, t, action, "order is larger than the visible book");
      return;
    }
    const why = shortfall(action.side, action.size, notional * (1 + TAKER_FEE));
    if (why) {
      reject(id, t, action, why);
      return;
    }
    fill(id, t, action.side, notional / action.size, action.size, "taker");
    // 同じイベントで効く次の成行が、食い終わった板をもう一度食わないように減らしておく
    const left = consume(levels, action.size);
    book = action.side === "BUY" ? { ...book, asks: left } : { ...book, bids: left };
  };

  const execTradeMarket = (w: Waiting, price: number, t: number) => {
    const { id, action } = w;
    const fillPrice = action.side === "BUY" ? price * (1 + slip) : price * (1 - slip);
    const cost = fillPrice * action.size * (1 + TAKER_FEE);
    const why = shortfall(action.side, action.size, cost);
    if (why) {
      reject(id, t, action, why);
      return;
    }
    fill(id, t, action.side, fillPrice, action.size, "taker");
  };

  const activate = (action: Action, t: number) => {
    if (action.type === "cancel") {
      const i = resting.findIndex((r) => r.id === action.id);
      if (i < 0) reject(action.id, t, action, "unknown order id");
      else resting.splice(i, 1);
      return;
    }
    const id = action.id ?? `auto-${++seq}`;
    if (!isStep(action.size, SIZE_STEP) || !(action.size > 0)) {
      reject(id, t, action, "size is not a positive multiple of SIZE_STEP");
      return;
    }
    if (action.type === "market") {
      if (bookModel) execBookMarket(id, action, t);
      else waiting.push({ id, action });
      return;
    }
    if (!(action.price > 0) || !isStep(action.price, TICK_SIZE)) {
      reject(id, t, action, "price is not a positive multiple of TICK_SIZE");
      return;
    }
    if (resting.some((r) => r.id === id)) {
      reject(id, t, action, "id is already open");
      return;
    }
    let cross: number | undefined;
    let queueAhead = 0;
    if (bookModel) {
      if (!book) {
        reject(id, t, action, "no book yet");
        return;
      }
      const levels = action.side === "BUY" ? book.bids : book.asks;
      queueAhead = queueAt(levels, action.side, action.price);
      cross = (action.side === "BUY" ? book.asks[0] : book.bids[0])?.price;
    } else {
      if (lastPrice === undefined) {
        reject(id, t, action, "no trade price yet");
        return;
      }
      cross = lastPrice;
    }
    const crosses =
      cross !== undefined &&
      (action.side === "BUY" ? action.price >= cross : action.price <= cross);
    if (crosses) {
      reject(id, t, action, "post-only order would take liquidity");
      return;
    }
    const why = shortfall(action.side, action.size, action.price * action.size);
    if (why) {
      reject(id, t, action, why);
      return;
    }
    resting.push({
      id,
      side: action.side,
      price: action.price,
      size: action.size,
      filled: 0,
      queueAhead,
    });
  };

  const applyTrade = (e: Trade) => {
    if (!bookModel) {
      for (const w of waiting.splice(0)) execTradeMarket(w, e.price, e.t);
    }
    for (const r of resting) {
      const remaining = r.size - r.filled;
      const through = r.side === "BUY" ? e.price < r.price : e.price > r.price;
      let size = 0;
      if (through) {
        size = remaining;
      } else if (bookModel && e.price === r.price && e.side !== r.side) {
        const use = Math.min(r.queueAhead, e.size);
        r.queueAhead -= use;
        size = Math.min(remaining, e.size - use);
      }
      if (size > EPS) {
        fill(r.id, e.t, r.side, r.price, size, "maker");
        r.filled += size;
      }
    }
    resting = resting.filter((r) => r.size - r.filled > EPS);
    lastPrice = e.price;
  };

  const applyBook = (b: Book) => {
    book = b;
    for (const r of resting) {
      const levels = r.side === "BUY" ? b.bids : b.asks;
      r.queueAhead = Math.min(r.queueAhead, queueAt(levels, r.side, r.price));
    }
  };

  const sample = () => {
    const equity = cash + markValue();
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  };

  const ctx = (t: number): Ctx => ({
    time: t,
    cash,
    position,
    lastPrice,
    book,
    openOrders: resting.map(({ id, side, price, size, filled }) => ({
      id,
      side,
      price,
      size,
      filled,
    })),
    pending: pending.map((p) => p.action),
  });

  const queue = (acts: Action[] | void, t: number) => {
    if (!acts) return;
    for (const action of acts) pending.push({ activeAt: t + latencyMs, action });
  };

  const notify = (t: number) => {
    for (const f of newFills.splice(0)) queue(strategy.onFill?.(f, ctx(t)), t);
    for (const r of newRejects.splice(0)) queue(strategy.onReject?.(r, ctx(t)), t);
  };

  for await (const e of opts.events) {
    count++;
    if (count === 1) firstT = e.t;
    lastT = e.t;

    for (;;) {
      const head = pending[0];
      if (!head || head.activeAt > e.t) break;
      pending.shift();
      activate(head.action, e.t);
    }

    if (e.kind === "trade") {
      applyTrade(e);
      notify(e.t);
      sample();
      const trade = { t: e.t, side: e.side, price: e.price, size: e.size };
      queue(strategy.onTrade?.(trade, ctx(e.t)), e.t);
    } else {
      const b = { t: e.t, asks: e.asks, bids: e.bids };
      applyBook(b);
      notify(e.t);
      sample();
      queue(strategy.onBook?.(b, ctx(e.t)), e.t);
    }
  }

  // 期末に残った BTC は売ったものとして Taker 手数料を引く。引かないと買って持つだけの戦略が出口の手数料を払わずに済む
  const endEquity = cash + markValue() * (1 - TAKER_FEE);
  const pnl = endEquity - capital;
  return {
    startEquity: capital,
    endEquity,
    pnl,
    returnPct: (pnl / capital) * 100,
    maxDrawdownPct,
    fills: stats.fills,
    makerFills: stats.makerFills,
    takerFills: stats.takerFills,
    rejects: stats.rejects,
    feesJpy: stats.feesJpy,
    volumeJpy: stats.volumeJpy,
    events: count,
    firstEventAt: count === 0 ? undefined : new Date(firstT).toISOString(),
    lastEventAt: count === 0 ? undefined : new Date(lastT).toISOString(),
    endPosition: position,
    endCash: cash,
  };
}
