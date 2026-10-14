import { expect, test } from "bun:test";

import { runBacktest, type MarketEvent } from "../src/backtest.ts";
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
  expect(reversed.endPosition).toBeLessThan(1e-8);
});

test("持つ比率はボラティリティの目標で決まり、差が小さければ持ち替えない", async () => {
  const r = await run(market(40, 0));
  // 比率は 0.15 / 年率ボラティリティ (この相場で約 0.4) で頭打ちになり、2 回買った後は差が幅 0.15 に届かない
  expect(r.fills).toBe(2);
  expect(r.endCash).toBeCloseTo(8428.38, 1);
});

test("約定の無い時間も経過時間として数える", async () => {
  // 2 時間に 1 約定。空いた足を数えなければ 20 日ぶんの足が貯まらず、30 日では一度も買わない
  const r = await run(market(30, 0, 2));
  expect(r.endPosition).toBeGreaterThan(0);
});
