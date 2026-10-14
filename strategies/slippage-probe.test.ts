import { expect, test } from "bun:test";

import { runBacktest, type MarketEvent } from "../src/backtest.ts";
import slippageProbe from "./slippage-probe.ts";

const HOUR = 3_600_000;

test("毎時 1 回、買いと売りを交互に成行で出し、板の最良値との差を滑りとして数える", async () => {
  const events: MarketEvent[] = [];
  for (let h = 0; h < 4; h++) {
    events.push({
      kind: "book",
      t: h * HOUR,
      asks: [{ price: 10_010_000, size: 1 }],
      bids: [{ price: 9_995_000, size: 1 }],
    });
    events.push({ kind: "trade", t: h * HOUR + 1, side: "BUY", price: 10_000_000, size: 0.01 });
    events.push({ kind: "trade", t: h * HOUR + 2, side: "BUY", price: 10_000_000, size: 0.01 });
  }
  events.push({
    kind: "book",
    t: 4 * HOUR,
    asks: [{ price: 10_010_000, size: 1 }],
    bids: [{ price: 9_995_000, size: 1 }],
  });

  const r = await runBacktest({
    events,
    strategy: slippageProbe(),
    fillModel: "book",
    capital: 10_000,
  });
  expect(r.takerFills).toBe(4);
  expect(r.endPosition).toBeCloseTo(0, 9);
  // 買いは 10bps、売りは 5bps 不利
  expect(r.takerSlippageBps).toBeCloseTo(7.5, 6);
});
