import type { Strategy } from "../src/backtest.ts";

// 比較の基準。資金の HOLD_RATIO (既定 1) ぶん BTC を成行で買い、そのまま持つ
const RATIO = Number(process.env.HOLD_RATIO ?? 1);
const SIZE_STEP = 0.00001;

export default function hold(): Strategy {
  // 買ったかどうかは自分で覚えず ctx から読む。拒否されたら次の約定で出し直し、--warmup-days の間に出した (捨てられた) 注文も数えない
  return {
    onTrade(trade, ctx) {
      if (ctx.position > 0 || ctx.pending.length > 0) return;
      // 成行の手数料と滑りのぶん現金を残す
      const size = Math.floor((RATIO * ctx.cash * 0.995) / trade.price / SIZE_STEP) * SIZE_STEP;
      if (size < SIZE_STEP) return;
      return [{ type: "market", side: "BUY", size: Number(size.toFixed(5)) }];
    },
  };
}
