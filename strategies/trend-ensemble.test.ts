import { expect, test } from "bun:test";

import { runBacktest, type MarketEvent, type Strategy } from "../src/backtest.ts";
import trendEnsemble from "./trend-ensemble.ts";

const HOUR = 3_600_000;

// everyHours 時間に 1 約定。前半の upDays 日は上げ、残りは下げる。揺らぎを入れてボラティリティを 0 にしない
function* market(upDays: number, downDays: number, everyHours = 1): Generator<MarketEvent> {
  let price = 10_000_000;
  for (let h = 0; h < (upDays + downDays) * 24; h++) {
    price *= (h < upDays * 24 ? 1.0015 : 0.9985) * (h % 2 === 0 ? 1.004 : 0.996);
    if (h % everyHours !== 0) continue;
    yield { kind: "trade", t: h * HOUR, side: "BUY", price: Math.round(price), size: 0.01 };
  }
}

function run(events: Iterable<MarketEvent>) {
  return runBacktest({ events, strategy: trendEnsemble(), fillModel: "trades", capital: 10_000 });
}

test("上げ相場では BTC を持ち、下げに転じると手放す", async () => {
  const up = await run(market(40, 0));
  expect(up.endPosition).toBeGreaterThan(0);
  expect(up.pnl).toBeGreaterThan(0);

  const reversed = await run(market(40, 30));
  // 全量を売っても浮動小数の端数 (1e-20 程度) が残る
  expect(reversed.endPosition).toBeCloseTo(0, 8);
});

test("持つ比率はボラティリティの目標で決まり、差が小さければ持ち替えない", async () => {
  const r = await run(market(40, 0));
  // 比率 0.15 / 年率ボラティリティで 1 回買い、値上がりで比率が幅 0.15 を超えて膨らんだぶんを 1 回売る
  expect(r.fills).toBe(2);
  expect(r.endCash).toBeCloseTo(8428.38, 1);
});

test("約定の無い時間も経過時間として数える", async () => {
  // 2 時間に 1 約定。空いた足も数えるので、20 日 (480 本) が経った直後の約定 (482 時間目) で初めて発注する
  const strategy = trendEnsemble();
  let firstOrderHour: number | undefined;
  const watched: Strategy = {
    onTrade(trade, ctx) {
      const actions = strategy.onTrade!(trade, ctx);
      if (actions && firstOrderHour === undefined) firstOrderHour = trade.t / HOUR;
      return actions;
    },
  };
  await runBacktest({
    events: market(30, 0, 2),
    strategy: watched,
    fillModel: "trades",
    capital: 10_000,
  });
  expect(firstOrderHour).toBe(482);
});
