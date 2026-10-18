import { expect, test } from "bun:test";
import {
  runBacktest,
  type Action,
  type Ctx,
  type Fill,
  type FillModel,
  type MarketEvent,
  type Reject,
  type Side,
} from "./backtest.ts";

const tr = (t: number, side: Side, price: number, size: number): MarketEvent => ({
  kind: "trade",
  t,
  side,
  price,
  size,
});

const lv = (levels: [number, number][]) => levels.map(([price, size]) => ({ price, size }));

const bk = (t: number, asks: [number, number][], bids: [number, number][]): MarketEvent => ({
  kind: "book",
  t,
  asks: lv(asks),
  bids: lv(bids),
});

// 指定した時刻のイベントでアクションを 1 度だけ返す戦略。約定・拒否・ctx を記録する
function scripted(plan: Record<number, Action[]>, onFill?: (f: Fill, ctx: Ctx) => Action[] | void) {
  const fills: Fill[] = [];
  const rejects: Reject[] = [];
  const seen: { t: number; ctx: Ctx }[] = [];
  const done = new Set<number>();
  const on = (t: number, ctx: Ctx) => {
    seen.push({ t, ctx: { ...ctx, openOrders: [...ctx.openOrders] } });
    if (done.has(t) || !plan[t]) return;
    done.add(t);
    return plan[t];
  };
  return {
    fills,
    rejects,
    seen,
    strategy: {
      onTrade: (x: { t: number }, ctx: Ctx) => on(x.t, ctx),
      onBook: (x: { t: number }, ctx: Ctx) => on(x.t, ctx),
      onFill: (f: Fill, ctx: Ctx) => {
        fills.push(f);
        return onFill?.(f, ctx);
      },
      onReject: (r: Reject) => {
        rejects.push(r);
      },
    },
  };
}

async function run(
  events: MarketEvent[],
  plan: Record<number, Action[]>,
  fillModel: FillModel,
  opts: {
    capital?: number;
    latencyMs?: number;
    slippageBps?: number;
    makerFeeBps?: number;
    takerFeeBps?: number;
  } = {},
  onFill?: (f: Fill, ctx: Ctx) => Action[] | void,
) {
  const s = scripted(plan, onFill);
  const result = await runBacktest({
    events,
    strategy: s.strategy,
    fillModel,
    capital: opts.capital ?? 10_000,
    latencyMs: opts.latencyMs,
    slippageBps: opts.slippageBps,
    makerFeeBps: opts.makerFeeBps,
    takerFeeBps: opts.takerFeeBps,
  });
  return { ...s, result };
}

test("trades model: a market buy fills at the next trade price plus slippage and pays the taker fee", async () => {
  const { fills, result } = await run(
    [tr(1, "BUY", 1_000_000, 0.1), tr(2, "SELL", 1_200_000, 0.1)],
    { 1: [{ type: "market", side: "BUY", size: 0.001, id: "b1" }] },
    "trades",
    { slippageBps: 10 },
  );
  expect(fills).toHaveLength(1);
  expect(fills[0]!.id).toBe("b1");
  expect(fills[0]!.t).toBe(2);
  expect(fills[0]!.liquidity).toBe("taker");
  expect(fills[0]!.price).toBeCloseTo(1_201_200, 6);
  expect(fills[0]!.feeJpy).toBeCloseTo(0.6006, 9);
  expect(result.endCash).toBeCloseTo(10_000 - 1201.2 - 0.6006, 9);
  expect(result.endPosition).toBeCloseTo(0.001, 12);
  // 期末に残った 0.001 BTC は 1,200,000 で売ったものとして Taker 手数料 0.6 を引く
  expect(result.endEquity).toBeCloseTo(10_000 - 1201.2 - 0.6006 + 1200 - 0.6, 9);
  expect(result.takerFills).toBe(1);
  expect(result.makerFills).toBe(0);
  expect(result.volumeJpy).toBeCloseTo(1201.2, 9);
  expect(result.feesJpy).toBeCloseTo(0.6006, 9);
});

test("trades model: a market sell fills below the trade price by the slippage", async () => {
  const { fills } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "BUY", 1_000_000, 1), tr(3, "BUY", 1_300_000, 1)],
    {
      1: [{ type: "market", side: "BUY", size: 0.001 }],
      2: [{ type: "market", side: "SELL", size: 0.001 }],
    },
    "trades",
    { slippageBps: 10 },
  );
  expect(fills.map((f) => f.side)).toEqual(["BUY", "SELL"]);
  expect(fills[1]!.price).toBeCloseTo(1_298_700, 6);
});

test("an order takes effect only after the latency", async () => {
  const { fills } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(300, "BUY", 1_111_111, 1), tr(600, "BUY", 1_222_222, 1)],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "trades",
    { latencyMs: 500 },
  );
  expect(fills).toHaveLength(1);
  expect(fills[0]!.t).toBe(600);
  expect(fills[0]!.price).toBe(1_222_222);
});

test("trades model: a limit buy fills only on a trade below its price, at its price, with the maker rebate", async () => {
  const { fills, result } = await run(
    [
      tr(1, "BUY", 1_000_000, 1),
      tr(2, "SELL", 990_000, 5),
      tr(3, "BUY", 990_000, 5),
      tr(4, "BUY", 989_999, 0.00001),
    ],
    { 1: [{ type: "limit", side: "BUY", price: 990_000, size: 0.002 }] },
    "trades",
  );
  expect(fills).toHaveLength(1);
  expect(fills[0]!.t).toBe(4);
  expect(fills[0]!.size).toBeCloseTo(0.002, 12);
  expect(fills[0]!.price).toBe(990_000);
  expect(fills[0]!.liquidity).toBe("maker");
  expect(fills[0]!.feeJpy).toBeCloseTo(-0.198, 9);
  expect(result.endCash).toBeCloseTo(10_000 - 1980 + 0.198, 9);
  expect(result.makerFills).toBe(1);
  expect(result.feesJpy).toBeCloseTo(-0.198, 9);
});

test("trades model: takerFeeBps sets the fee on market fills and on the end-of-period valuation", async () => {
  const { fills, result } = await run(
    [tr(1, "BUY", 1_000_000, 0.1), tr(2, "SELL", 1_200_000, 0.1)],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "trades",
    { takerFeeBps: 12, makerFeeBps: 3 },
  );
  expect(fills[0]!.feeJpy).toBeCloseTo(1.44, 9);
  expect(result.endEquity).toBeCloseTo(10_000 - 1200 - 1.44 + 1200 - 1.44, 9);
});

test("trades model: makerFeeBps sets the fee on limit fills", async () => {
  const { fills } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "SELL", 990_000, 5), tr(4, "BUY", 989_999, 0.00001)],
    { 1: [{ type: "limit", side: "BUY", price: 990_000, size: 0.002 }] },
    "trades",
    { takerFeeBps: 12, makerFeeBps: 3 },
  );
  expect(fills[0]!.liquidity).toBe("maker");
  expect(fills[0]!.feeJpy).toBeCloseTo(0.594, 9);
});

test("trades model: a positive makerFeeBps is held back with a limit buy's cash", async () => {
  const events = [tr(1, "BUY", 1_000_000, 1), tr(2, "SELL", 980_000, 1)];
  const plan = {
    1: [
      { type: "limit" as const, side: "BUY" as const, price: 990_000, size: 0.0005 },
      { type: "limit" as const, side: "BUY" as const, price: 990_000, size: 0.0005 },
    ],
  };
  // 代金 495 円 × 2 は資金 1,000 円に収まるが、手数料 2% を足すと 2 本目は 1,009.8 円になる
  const withFee = await run(events, plan, "trades", { capital: 1_000, makerFeeBps: 200 });
  expect(withFee.rejects.map((r) => r.reason)).toEqual(["insufficient cash"]);
  expect(withFee.result.endCash).toBeCloseTo(1_000 - 495 * 1.02, 9);
  const rebate = await run(events, plan, "trades", { capital: 1_000 });
  expect(rebate.rejects).toHaveLength(0);
  expect(rebate.fills).toHaveLength(2);
});

test("trades model: takerFeeBps moves the cash check for a market buy", async () => {
  const events = [tr(1, "BUY", 999_000, 1), tr(2, "BUY", 999_000, 1)];
  const plan = { 1: [{ type: "market" as const, side: "BUY" as const, size: 0.001 }] };
  // 代金 999 円に 0.05% なら 999.5 円で資金 1,000 円に収まり、0.12% なら 1,000.2 円で収まらない
  const gmo = await run(events, plan, "trades", { capital: 1_000 });
  expect(gmo.fills).toHaveLength(1);
  const higher = await run(events, plan, "trades", { capital: 1_000, takerFeeBps: 12 });
  expect(higher.fills).toHaveLength(0);
  expect(higher.rejects.map((r) => r.reason)).toEqual(["insufficient cash"]);
});

test("book model: takerFeeBps moves the cash check for a market buy", async () => {
  const events = [bk(1, [[999_000, 1]], [[998_000, 1]]), tr(2, "BUY", 999_000, 1)];
  const plan = { 1: [{ type: "market" as const, side: "BUY" as const, size: 0.001 }] };
  const gmo = await run(events, plan, "book", { capital: 1_000 });
  expect(gmo.fills).toHaveLength(1);
  const higher = await run(events, plan, "book", { capital: 1_000, takerFeeBps: 12 });
  expect(higher.fills).toHaveLength(0);
  expect(higher.rejects.map((r) => r.reason)).toEqual(["insufficient cash"]);
});

test("trades model: a limit buy at or above the last trade price is rejected as post-only", async () => {
  const { fills, rejects, result } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "SELL", 900_000, 1)],
    { 1: [{ type: "limit", side: "BUY", price: 1_000_000, size: 0.001, id: "x" }] },
    "trades",
  );
  expect(fills).toHaveLength(0);
  expect(rejects).toHaveLength(1);
  expect(rejects[0]!.id).toBe("x");
  expect(result.rejects).toBe(1);
});

test("book model: a market buy walks the asks and pays the volume-weighted price", async () => {
  const { fills, result } = await run(
    [
      bk(
        1,
        [
          [5_000_000, 0.0003],
          [5_000_100, 0.0005],
        ],
        [[4_999_000, 1]],
      ),
      tr(2, "BUY", 5_000_000, 0.0001),
    ],
    { 1: [{ type: "market", side: "BUY", size: 0.0006 }] },
    "book",
  );
  expect(fills).toHaveLength(1);
  expect(fills[0]!.price).toBeCloseTo(5_000_050, 6);
  expect(fills[0]!.size).toBeCloseTo(0.0006, 12);
  expect(fills[0]!.feeJpy).toBeCloseTo(3000.03 * 0.0005, 9);
  expect(result.endCash).toBeCloseTo(10_000 - 3000.03 - 3000.03 * 0.0005, 9);
});

test("book model: a market order larger than the visible book is rejected", async () => {
  const { fills, rejects } = await run(
    [bk(1, [[5_000_000, 0.0003]], [[4_999_000, 1]]), tr(2, "BUY", 5_000_000, 0.0001)],
    { 1: [{ type: "market", side: "BUY", size: 0.0006 }] },
    "book",
  );
  expect(fills).toHaveLength(0);
  expect(rejects).toHaveLength(1);
});

test("book model: a market order before any book is rejected", async () => {
  const { fills, rejects } = await run(
    [tr(1, "BUY", 5_000_000, 1), tr(2, "BUY", 5_000_000, 1)],
    { 1: [{ type: "market", side: "BUY", size: 0.0001 }] },
    "book",
  );
  expect(fills).toHaveLength(0);
  expect(rejects).toHaveLength(1);
});

const BOOK = (t: number, bidSize = 0.002) =>
  bk(
    t,
    [[5_000_000, 1]],
    [
      [4_999_000, bidSize],
      [4_998_000, 1],
    ],
  );

test("book model: a limit buy waits behind the size already at its price", async () => {
  const { fills } = await run(
    [
      BOOK(1),
      tr(2, "SELL", 4_999_000, 0.0015),
      tr(3, "BUY", 4_999_000, 0.01),
      tr(4, "SELL", 4_999_000, 0.0008),
      tr(5, "SELL", 4_999_000, 0.0004),
      tr(6, "SELL", 4_998_000, 0.00001),
    ],
    { 1: [{ type: "limit", side: "BUY", price: 4_999_000, size: 0.001 }] },
    "book",
  );
  expect(fills.map((f) => f.t)).toEqual([4, 5, 6]);
  expect(fills[0]!.size).toBeCloseTo(0.0003, 12);
  expect(fills[1]!.size).toBeCloseTo(0.0004, 12);
  expect(fills[2]!.size).toBeCloseTo(0.0003, 12);
  expect(fills.every((f) => f.price === 4_999_000 && f.liquidity === "maker")).toBe(true);
});

test("book model: a smaller level in a later book shortens the queue ahead", async () => {
  const { fills } = await run(
    [BOOK(1), BOOK(2, 0.0005), tr(3, "SELL", 4_999_000, 0.0007)],
    { 1: [{ type: "limit", side: "BUY", price: 4_999_000, size: 0.001 }] },
    "book",
  );
  expect(fills).toHaveLength(1);
  expect(fills[0]!.size).toBeCloseTo(0.0002, 12);
});

test("book model: a limit inside the spread has no queue ahead", async () => {
  const { fills } = await run(
    [BOOK(1), tr(2, "SELL", 4_999_500, 0.0004)],
    { 1: [{ type: "limit", side: "BUY", price: 4_999_500, size: 0.001 }] },
    "book",
  );
  expect(fills).toHaveLength(1);
  expect(fills[0]!.size).toBeCloseTo(0.0004, 12);
});

test("book model: a limit deeper than the visible book fills only when the price goes through", async () => {
  const { fills } = await run(
    [BOOK(1), tr(2, "SELL", 4_990_000, 1), tr(3, "SELL", 4_989_999, 0.00001)],
    { 1: [{ type: "limit", side: "BUY", price: 4_990_000, size: 0.001 }] },
    "book",
  );
  expect(fills.map((f) => f.t)).toEqual([3]);
  expect(fills[0]!.size).toBeCloseTo(0.001, 12);
});

test("book model: a limit sell queue is consumed by BUY takers at its price", async () => {
  const { fills } = await run(
    [
      bk(1, [[5_000_000, 0.0001]], [[4_999_000, 1]]),
      bk(
        2,
        [
          [5_001_000, 0.0002],
          [5_002_000, 1],
        ],
        [[4_999_000, 1]],
      ),
      tr(3, "SELL", 5_001_000, 1),
      tr(4, "BUY", 5_001_000, 0.0005),
    ],
    {
      1: [{ type: "market", side: "BUY", size: 0.0001 }],
      2: [{ type: "limit", side: "SELL", price: 5_001_000, size: 0.0001 }],
    },
    "book",
  );
  expect(fills.map((f) => [f.t, f.side, f.liquidity])).toEqual([
    [2, "BUY", "taker"],
    [4, "SELL", "maker"],
  ]);
  expect(fills[1]!.size).toBeCloseTo(0.0001, 12);
});

test("book model: a limit buy at or above the best ask is rejected as post-only", async () => {
  const { fills, rejects } = await run(
    [BOOK(1), tr(2, "SELL", 4_000_000, 1)],
    { 1: [{ type: "limit", side: "BUY", price: 5_000_000, size: 0.001 }] },
    "book",
  );
  expect(fills).toHaveLength(0);
  expect(rejects).toHaveLength(1);
});

test("a buy that costs more than the cash not reserved by open buys is rejected", async () => {
  const { fills, rejects } = await run(
    [BOOK(1), tr(2, "SELL", 4_000_000, 1)],
    {
      1: [
        { type: "limit", side: "BUY", price: 4_999_000, size: 0.0015, id: "a" },
        { type: "limit", side: "BUY", price: 4_999_000, size: 0.0006, id: "b" },
      ],
    },
    "book",
  );
  expect(rejects.map((r) => r.id)).toEqual(["b"]);
  expect(fills.map((f) => f.id)).toEqual(["a"]);
});

test("a market buy whose cost plus fee exceeds the cash is rejected", async () => {
  const { fills, rejects } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "BUY", 1_000_000, 1)],
    { 1: [{ type: "market", side: "BUY", size: 0.01 }] },
    "trades",
  );
  expect(fills).toHaveLength(0);
  expect(rejects).toHaveLength(1);
});

test("a sell larger than the BTC held is rejected", async () => {
  const { fills, rejects } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "BUY", 1_000_000, 1)],
    { 1: [{ type: "market", side: "SELL", size: 0.001 }] },
    "trades",
  );
  expect(fills).toHaveLength(0);
  expect(rejects).toHaveLength(1);
});

test("a size off the 0.00001 step and a price off the 1 JPY tick are rejected", async () => {
  const { fills, rejects } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "SELL", 900_000, 1)],
    {
      1: [
        { type: "market", side: "BUY", size: 0.000015, id: "size" },
        { type: "limit", side: "BUY", price: 950_000.5, size: 0.001, id: "tick" },
        { type: "market", side: "BUY", size: 0, id: "zero" },
      ],
    },
    "trades",
  );
  expect(fills).toHaveLength(0);
  expect(rejects.map((r) => r.id).sort()).toEqual(["size", "tick", "zero"]);
});

test("a cancelled limit does not fill and a cancel of an unknown id is rejected", async () => {
  const { fills, rejects, seen } = await run(
    [
      tr(1, "BUY", 1_000_000, 1),
      tr(2, "BUY", 1_000_000, 1),
      tr(3, "BUY", 1_000_000, 1),
      tr(4, "SELL", 800_000, 1),
    ],
    {
      1: [{ type: "limit", side: "BUY", price: 900_000, size: 0.001, id: "l" }],
      2: [
        { type: "cancel", id: "l" },
        { type: "cancel", id: "nope" },
      ],
    },
    "trades",
  );
  expect(fills).toHaveLength(0);
  expect(rejects.map((r) => r.id)).toEqual(["nope"]);
  expect(seen.find((s) => s.t === 2)!.ctx.openOrders.map((o) => o.id)).toEqual(["l"]);
  expect(seen.find((s) => s.t === 4)!.ctx.openOrders).toEqual([]);
  expect(seen.find((s) => s.t === 4)!.ctx.cash).toBe(10_000);
});

test("orders without an id get distinct ids", async () => {
  const { fills } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "BUY", 1_000_000, 1)],
    {
      1: [
        { type: "market", side: "BUY", size: 0.001 },
        { type: "market", side: "BUY", size: 0.002 },
      ],
    },
    "trades",
  );
  expect(fills).toHaveLength(2);
  expect(fills[0]!.id).not.toBe(fills[1]!.id);
});

test("actions returned from onFill are placed", async () => {
  const { fills } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "BUY", 1_000_000, 1), tr(3, "BUY", 1_100_000, 1)],
    { 1: [{ type: "market", side: "BUY", size: 0.001, id: "in" }] },
    "trades",
    {},
    (f) => (f.id === "in" ? [{ type: "market", side: "SELL", size: 0.001, id: "out" }] : undefined),
  );
  expect(fills.map((f) => [f.id, f.t])).toEqual([
    ["in", 2],
    ["out", 3],
  ]);
});

test("ctx shows the fills made on the same event", async () => {
  const { seen } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(2, "BUY", 1_234_567, 1)],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "trades",
  );
  const at2 = seen.find((s) => s.t === 2)!.ctx;
  expect(at2.position).toBeCloseTo(0.001, 12);
  expect(at2.lastPrice).toBe(1_234_567);
  expect(at2.time).toBe(2);
});

test("max drawdown is measured from the running peak of the marked-to-market equity", async () => {
  const { result } = await run(
    [
      tr(1, "BUY", 5_000_000, 1),
      tr(2, "BUY", 5_000_000, 1),
      tr(3, "SELL", 4_000_000, 1),
      tr(4, "BUY", 6_000_000, 1),
      tr(5, "SELL", 5_500_000, 1),
    ],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "trades",
  );
  expect(result.startEquity).toBe(10_000);
  expect(result.maxDrawdownPct).toBeCloseTo(10.025, 9);
  expect(result.endEquity).toBeCloseTo(4997.5 + 5500 - 2.75, 9);
  expect(result.pnl).toBeCloseTo(494.75, 9);
  expect(result.returnPct).toBeCloseTo(4.9475, 9);
});

test("the result counts events and gives the first and last event times", async () => {
  const { result } = await run(
    [
      bk(Date.UTC(2026, 9, 13, 0, 0, 0, 5), [[2, 1]], [[1, 1]]),
      tr(Date.UTC(2026, 9, 13, 1), "BUY", 2, 1),
    ],
    {},
    "book",
  );
  expect(result.events).toBe(2);
  expect(result.firstEventAt).toBe("2026-10-13T00:00:00.005Z");
  expect(result.lastEventAt).toBe("2026-10-13T01:00:00.000Z");
  expect(result.fills).toBe(0);
  expect(result.endEquity).toBe(10_000);
});

test("events can be an async iterable", async () => {
  async function* gen() {
    yield tr(1, "BUY", 1_000_000, 1);
    yield tr(2, "BUY", 1_000_000, 1);
  }
  const s = scripted({ 1: [{ type: "market", side: "BUY", size: 0.001 }] });
  const result = await runBacktest({
    events: gen(),
    strategy: s.strategy,
    fillModel: "trades",
    capital: 10_000,
  });
  expect(result.takerFills).toBe(1);
  expect(result.events).toBe(2);
});

test("book model: a position bought before any trade is valued at the best bid", async () => {
  const { fills, result } = await run(
    [bk(1, [[5_000_000, 1]], [[4_000_000, 1]]), bk(2, [[5_000_000, 1]], [[4_000_000, 1]])],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "book",
  );
  expect(fills).toHaveLength(1);
  expect(result.endEquity).toBeCloseTo(10_000 - 5000 - 2.5 + 4000 - 2, 9);
});

test("max drawdown follows a peak above the starting capital", async () => {
  const { result } = await run(
    [
      tr(1, "BUY", 5_000_000, 1),
      tr(2, "BUY", 5_000_000, 1),
      tr(3, "BUY", 7_000_000, 1),
      tr(4, "SELL", 6_000_000, 1),
    ],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "trades",
  );
  // 7,000,000 で 11,997.5 の山、6,000,000 で 10,997.5 に下がる
  expect(result.maxDrawdownPct).toBeCloseTo((1000 / 11_997.5) * 100, 9);
});

test("ctx.pending shows orders that have not taken effect yet", async () => {
  const { seen } = await run(
    [tr(1, "BUY", 1_000_000, 1), tr(100, "BUY", 1_000_000, 1), tr(600, "BUY", 1_000_000, 1)],
    { 1: [{ type: "market", side: "BUY", size: 0.001, id: "m" }] },
    "trades",
    { latencyMs: 500 },
  );
  expect(seen.find((s) => s.t === 100)!.ctx.pending).toEqual([
    { type: "market", side: "BUY", size: 0.001, id: "m" },
  ]);
  expect(seen.find((s) => s.t === 600)!.ctx.pending).toEqual([]);
});

test("book model: market orders taking effect together share the visible book", async () => {
  const { fills, rejects } = await run(
    [
      bk(
        1,
        [
          [5_000_000, 0.0003],
          [5_000_100, 1],
        ],
        [[4_999_000, 1]],
      ),
      tr(2, "BUY", 5_000_000, 0.0001),
    ],
    {
      1: [
        { type: "market", side: "BUY", size: 0.0003, id: "a" },
        { type: "market", side: "BUY", size: 0.0003, id: "b" },
      ],
    },
    "book",
  );
  expect(rejects).toEqual([]);
  expect(fills.map((f) => [f.id, f.price])).toEqual([
    ["a", 5_000_000],
    ["b", 5_000_100],
  ]);
});

test("book model: drawdown is also measured on book events", async () => {
  const { result } = await run(
    [
      bk(1, [[5_000_000, 1]], [[4_999_000, 1]]),
      bk(2, [[5_000_000, 1]], [[4_999_000, 1]]),
      bk(3, [[2_000_001, 1]], [[2_000_000, 1]]),
      bk(4, [[5_000_000, 1]], [[4_999_000, 1]]),
    ],
    { 1: [{ type: "market", side: "BUY", size: 0.001 }] },
    "book",
  );
  // 最良買い 2,000,000 での評価 4,997.5 + 2,000 = 6,997.5 が、資金 10,000 からの谷
  expect(result.maxDrawdownPct).toBeCloseTo(30.025, 9);
});

test("book model: limits at one price share a trade instead of each filling from all of it", async () => {
  const { fills } = await run(
    [BOOK(1), tr(2, "SELL", 4_999_500, 0.0004)],
    {
      1: [
        { type: "limit", side: "BUY", price: 4_999_500, size: 0.001, id: "a" },
        { type: "limit", side: "BUY", price: 4_999_500, size: 0.001, id: "b" },
      ],
    },
    "book",
  );
  expect(fills.map((f) => f.id)).toEqual(["a"]);
  expect(fills[0]!.size).toBeCloseTo(0.0004, 12);
});

test("book model: market sells taking effect together share the bids", async () => {
  const B = (t: number) =>
    bk(
      t,
      [[5_000_000, 1]],
      [
        [4_999_000, 0.0003],
        [4_998_000, 1],
      ],
    );
  const { fills } = await run(
    [B(1), B(2), B(3)],
    {
      1: [{ type: "market", side: "BUY", size: 0.0006 }],
      2: [
        { type: "market", side: "SELL", size: 0.0003, id: "a" },
        { type: "market", side: "SELL", size: 0.0003, id: "b" },
      ],
    },
    "book",
  );
  expect(fills.filter((f) => f.side === "SELL").map((f) => [f.id, f.price])).toEqual([
    ["a", 4_999_000],
    ["b", 4_998_000],
  ]);
});

test("book model: a limit is rejected when the opposite side of the book is empty", async () => {
  const { fills, rejects } = await run(
    [
      bk(1, [[5_000_000, 0.0003]], [[4_999_000, 1]]),
      tr(2, "BUY", 5_000_000, 1),
      tr(3, "SELL", 5_100_000, 1),
    ],
    {
      1: [
        { type: "market", side: "BUY", size: 0.0003, id: "m" },
        { type: "limit", side: "BUY", price: 6_000_000, size: 0.0001, id: "l" },
      ],
    },
    "book",
  );
  expect(fills.map((f) => f.id)).toEqual(["m"]);
  expect(rejects.map((r) => r.id)).toEqual(["l"]);
});

test("warmup reaches the strategy with the trade price, and its actions are dropped", async () => {
  const seen: { t: number; lastPrice: number | undefined; cash: number }[] = [];
  const result = await runBacktest({
    warmup: [tr(1, "BUY", 9_000_000, 1), tr(2, "SELL", 9_100_000, 1)],
    events: [
      bk(5, [[10_000_000, 1]], [[9_990_000, 1]]),
      tr(10, "BUY", 10_000_000, 1),
      tr(11, "BUY", 10_000_000, 1),
    ],
    strategy: {
      onTrade(trade, ctx) {
        seen.push({ t: trade.t, lastPrice: ctx.lastPrice, cash: ctx.cash });
        if (trade.t < 10) return [{ type: "market", side: "BUY", size: 0.0001 }];
      },
      onBook(book, ctx) {
        seen.push({ t: book.t, lastPrice: ctx.lastPrice, cash: ctx.cash });
      },
    },
    fillModel: "trades",
    capital: 10_000,
  });
  expect(seen).toEqual([
    { t: 1, lastPrice: 9_000_000, cash: 10_000 },
    { t: 2, lastPrice: 9_100_000, cash: 10_000 },
    // 期間の最初の板では、温めの最後の約定価格が直前の約定価格として見える
    { t: 5, lastPrice: 9_100_000, cash: 10_000 },
    { t: 10, lastPrice: 10_000_000, cash: 10_000 },
    { t: 11, lastPrice: 10_000_000, cash: 10_000 },
  ]);
  expect(result.fills).toBe(0);
  expect(result.takerSlippageBps).toBeNull();
  expect(result.events).toBe(3);
  expect(result.firstEventAt).toBe(new Date(5).toISOString());
});

test("book model: taker slippage is measured against the trade price the order was decided on, in both directions", async () => {
  const book = (t: number) => bk(t, [[10_100_000, 1]], [[9_950_000, 1]]);
  const { fills, result } = await run(
    [book(0), tr(1, "BUY", 10_000_000, 1), book(2), tr(3, "SELL", 10_000_000, 1), book(4)],
    {
      1: [{ type: "market", side: "BUY", size: 0.0003 }],
      3: [{ type: "market", side: "SELL", size: 0.0001 }],
    },
    "book",
  );
  expect(fills.map((f) => [f.side, f.price])).toEqual([
    ["BUY", 10_100_000],
    ["SELL", 9_950_000],
  ]);
  // 買いは 100bps、売りは 50bps 不利。代金が 3:1 なので (100×3 + 50×1) / 4 = 87.5bps (単純平均なら 75)
  expect(result.takerSlippageBps).toBeCloseTo(87.5, 9);
});
