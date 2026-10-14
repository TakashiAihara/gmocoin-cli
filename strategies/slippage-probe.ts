import type { Strategy } from "../src/backtest.ts";

// 成行の滑りを測るための戦略。毎時の最初の約定で決まった量を買い、次の時間に売る。
// 損益ではなく takerSlippageBps を見る。trend-ensemble は 2 週間で成行が数回しか出ず、滑りの標本にならない
const BAR_MS = 3_600_000;
// 既定は trend-ensemble が資金 1 万円で出す 1 回の注文と同じ桁 (0.0003 BTC ≒ 5,000 円)
const SIZE = Number(process.env.PROBE_SIZE ?? 0.0003);
const SIZE_STEP = 0.00001;
// 刻みに合わない量は全注文が拒否され、takerSlippageBps が null のまま正常終了してしまう
if (
  !Number.isFinite(SIZE) ||
  !(SIZE > 0) ||
  Math.abs(SIZE / SIZE_STEP - Math.round(SIZE / SIZE_STEP)) > 1e-6
) {
  throw new Error(
    `PROBE_SIZE must be a positive multiple of ${SIZE_STEP}: ${process.env.PROBE_SIZE}`,
  );
}

export default function slippageProbe(): Strategy {
  let bar: number | undefined;
  return {
    onTrade(trade, ctx) {
      const b = Math.floor(trade.t / BAR_MS);
      if (b === bar || ctx.pending.length > 0) return;
      bar = b;
      const side = ctx.position >= SIZE - 1e-9 ? "SELL" : "BUY";
      return [{ type: "market", side, size: SIZE }];
    },
    onReject(reject) {
      // 板がまだ無いだけなら同じ時間の次の約定で出し直す。現金不足などは出し直しても同じなので次の時間まで待つ
      if (reject.reason === "no book yet") bar = undefined;
    },
  };
}
