import type { Strategy } from "../src/backtest.ts";

// 1 時間足で判断する。4 時間足は足の区切り位置だけで 2021〜22 の損益が -6%〜+3% 動いた (docs/strategies.md)
const BAR_MS = 3_600_000;
const BARS_PER_DAY = 24;
// 複数の期間の SMA を多数決にして、期間の選び方への依存を減らす。足りない期間は履歴が貯まるまで数えない
const LOOKBACKS = [7, 14, 28, 56].map((d) => d * BARS_PER_DAY);
const VOL_BARS = 20 * BARS_PER_DAY;
// 年率換算のボラティリティの目標。BTC の年率 50〜80% に対して小さく取り、ドローダウンを 20% 以内に収める
const TARGET_VOL = 0.15;
// 目標と現在の比率の差がこれ未満なら持ち替えない (手数料で削られないように)
const REBALANCE_BAND = 0.15;
const SIZE_STEP = 0.00001;

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function annualVol(closes: readonly number[]): number {
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const m = mean(rets);
  return Math.sqrt(mean(rets.map((r) => (r - m) ** 2)) * 365 * BARS_PER_DAY);
}

// 足の終値が SMA を上回っている期間の割合 × ボラティリティの調整で、BTC を持つ比率を決める。足が変わるたびに 1 回だけ判断する
export default function trendEnsemble(): Strategy {
  const closes: number[] = [];
  let bar: number | undefined;
  let last = 0;

  return {
    onTrade(trade, ctx) {
      const b = Math.floor(trade.t / BAR_MS);
      if (bar === undefined) bar = b;
      if (b === bar) {
        last = trade.price;
        return;
      }
      bar = b;
      closes.push(last);
      last = trade.price;
      if (closes.length > LOOKBACKS.at(-1)!) closes.shift();
      const usable = LOOKBACKS.filter((n) => closes.length >= n);
      if (usable.length === 0 || closes.length <= VOL_BARS || ctx.pending.length > 0) return;

      const close = closes.at(-1)!;
      const votes = usable.filter((n) => close > mean(closes.slice(-n))).length / usable.length;
      const weight = votes * Math.min(1, TARGET_VOL / annualVol(closes.slice(-(VOL_BARS + 1))));

      const price = trade.price;
      const equity = ctx.cash + ctx.position * price;
      const current = (ctx.position * price) / equity;
      if (Math.abs(weight - current) < REBALANCE_BAND && !(weight === 0 && ctx.position > 0))
        return;

      // 成行の手数料と滑りのぶん現金を残す
      const target = Math.floor((weight * equity * 0.995) / price / SIZE_STEP) * SIZE_STEP;
      const diff = Math.round((target - ctx.position) / SIZE_STEP) * SIZE_STEP;
      if (diff >= SIZE_STEP)
        return [{ type: "market", side: "BUY", size: Number(diff.toFixed(5)) }];
      if (diff <= -SIZE_STEP) {
        return [
          { type: "market", side: "SELL", size: Number(Math.min(-diff, ctx.position).toFixed(5)) },
        ];
      }
    },
  };
}
