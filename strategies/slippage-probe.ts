import type { Strategy } from "../src/backtest.ts";

// 成行の滑りを測るための戦略。毎時の最初の約定で決まった量を買い、次の時間に売る。
// 損益ではなく takerSlippageBps を見る。trend-ensemble は 2 週間で成行が数回しか出ず、滑りの標本にならない
const BAR_MS = 3_600_000;
// 既定は trend-ensemble が資金 1 万円で出す 1 回の注文と同じ桁 (0.0003 BTC ≒ 5,000 円)
const SIZE = Number(process.env.PROBE_SIZE ?? 0.0003);

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
  };
}
