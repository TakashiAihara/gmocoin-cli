import { expect, test } from "bun:test";

import { runBacktest, type MarketEvent } from "../src/backtest.ts";
import trendEnsemble from "./trend-ensemble.ts";

const HOUR = 3_600_000;

// 1 時間に 1 約定。前半の days 日は上げ、残りは下げる。揺らぎを入れてボラティリティを 0 にしない
function* market(upDays: number, downDays: number): Generator<MarketEvent> {
  let price = 10_000_000;
  for (let h = 0; h < (upDays + downDays) * 24; h++) {
    price *= (h < upDays * 24 ? 1.0015 : 0.9985) * (h % 2 === 0 ? 1.004 : 0.996);
    yield { kind: "trade", t: h * HOUR, side: "BUY", price: Math.round(price), size: 0.01 };
  }
}

test("上げ相場では BTC を持ち、下げに転じると手放す", async () => {
  const up = await runBacktest({
    events: market(40, 0),
    strategy: trendEnsemble(),
    fillModel: "trades",
    capital: 10_000,
  });
  expect(up.endPosition).toBeGreaterThan(0);
  expect(up.pnl).toBeGreaterThan(0);

  const reversed = await runBacktest({
    events: market(40, 30),
    strategy: trendEnsemble(),
    fillModel: "trades",
    capital: 10_000,
  });
  // 全量を売っても浮動小数の端数 (1e-20 程度) が残る
  expect(reversed.endPosition).toBeLessThan(1e-8);
});

test("ボラティリティの目標で持つ比率を 1 未満に抑える", async () => {
  const r = await runBacktest({
    events: market(40, 0),
    strategy: trendEnsemble(),
    fillModel: "trades",
    capital: 10_000,
  });
  expect(r.endCash).toBeGreaterThan(2_000);
});
