import type { Strategy } from "../src/backtest.ts";

// 比較の基準。最初の約定で資金の HOLD_RATIO (既定 1) ぶん BTC を成行で買い、そのまま持つ
const RATIO = Number(process.env.HOLD_RATIO ?? 1);
const SIZE_STEP = 0.00001;

export default function hold(): Strategy {
  let bought = false;
  return {
    onTrade(trade, ctx) {
      if (bought) return;
      bought = true;
      // 成行の手数料と滑りのぶん現金を残す
      const size = Math.floor((RATIO * ctx.cash * 0.995) / trade.price / SIZE_STEP) * SIZE_STEP;
      return [{ type: "market", side: "BUY", size: Number(size.toFixed(5)) }];
    },
  };
}
