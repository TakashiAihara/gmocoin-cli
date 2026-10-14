import { expect, test } from "bun:test";

import { runBacktest, type MarketEvent } from "../src/backtest.ts";
import hold from "./hold.ts";

const tr = (t: number, price: number): MarketEvent => ({
  kind: "trade",
  t,
  side: "BUY",
  price,
  size: 1,
});

test("1 度だけ買って持ち、温めの間に出した注文があっても期間に入ってから買う", async () => {
  const events = [tr(10, 10_000_000), tr(11, 10_000_000), tr(12, 10_000_000), tr(13, 10_000_000)];
  const cold = await runBacktest({
    events,
    strategy: hold(),
    fillModel: "trades",
    capital: 10_000,
  });
  const warm = await runBacktest({
    warmup: [tr(1, 9_000_000), tr(2, 9_000_000)],
    events,
    strategy: hold(),
    fillModel: "trades",
    capital: 10_000,
  });
  for (const r of [cold, warm]) {
    expect(r.fills).toBe(1);
    expect(r.endPosition).toBeCloseTo(0.00099, 9);
  }
});

test("注文が効くまでの間 (latency) に次の約定が来ても 2 度買わない", async () => {
  const events = [
    tr(0, 10_000_000),
    tr(10, 10_000_000),
    tr(20, 10_000_000),
    tr(100, 10_000_000),
    tr(110, 10_000_000),
  ];
  process.env.HOLD_RATIO = "0.3";
  try {
    const { default: fresh } = await import(`./hold.ts?ratio=${Date.now()}`);
    const r = await runBacktest({
      events,
      strategy: fresh(),
      fillModel: "trades",
      capital: 10_000,
      latencyMs: 50,
    });
    expect(r.fills).toBe(1);
  } finally {
    delete process.env.HOLD_RATIO;
  }
});
