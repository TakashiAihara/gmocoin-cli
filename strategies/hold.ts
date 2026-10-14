import type { Strategy } from "../src/backtest.ts";

// 比較の基準。資金の HOLD_RATIO (既定 1) ぶん BTC を成行で買い、そのまま持つ
const RATIO = Number(process.env.HOLD_RATIO ?? 1);
const SIZE_STEP = 0.00001;

export default function hold(): Strategy {
  // 出した買いが拒否されたら次の約定で出し直す
  let ordered = false;
  return {
    onTrade(trade, ctx) {
      if (ordered) return;
      // 成行の手数料と滑りのぶん現金を残す
      const size = Math.floor((RATIO * ctx.cash * 0.995) / trade.price / SIZE_STEP) * SIZE_STEP;
      if (size < SIZE_STEP) return;
      ordered = true;
      return [{ type: "market", side: "BUY", size: Number(size.toFixed(5)) }];
    },
    onReject() {
      ordered = false;
    },
  };
}
