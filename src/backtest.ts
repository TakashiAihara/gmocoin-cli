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

export async function runBacktest(_opts: BacktestOptions): Promise<BacktestResult> {
  throw new Error("not implemented");
}
