import type { Strategy } from "../src/backtest.ts";

const SHORT = 20;
const LONG = 100;
const SIZE = 0.0001;

function average(xs: readonly number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

// 直近の約定価格の短期 SMA が長期 SMA を上抜けたら買い、下抜けたら保有分を売る
export default function smaCross(): Strategy {
  const prices: number[] = [];
  let above: boolean | undefined;

  return {
    onTrade(trade, ctx) {
      prices.push(trade.price);
      if (prices.length > LONG) prices.shift();
      if (prices.length < LONG) return;

      const nowAbove = average(prices.slice(-SHORT)) > average(prices);
      const crossed = above !== undefined && nowAbove !== above;
      above = nowAbove;
      if (!crossed) return;

      if (nowAbove && ctx.position === 0) return [{ type: "market", side: "BUY", size: SIZE }];
      if (!nowAbove && ctx.position > 0) {
        return [{ type: "market", side: "SELL", size: ctx.position }];
      }
    },
  };
}
