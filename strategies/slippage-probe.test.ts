import { expect, test } from "bun:test";

import { runBacktest, type MarketEvent } from "../src/backtest.ts";
import slippageProbe from "./slippage-probe.ts";

const HOUR = 3_600_000;

test("毎時 1 回、買いと売りを交互に成行で出し、判断した約定価格との差を滑りとして数える", async () => {
  const events: MarketEvent[] = [];
  for (let h = 0; h < 4; h++) {
    events.push({
      kind: "book",
      t: h * HOUR,
      asks: [{ price: 10_010_000, size: 1 }],
      bids: [{ price: 9_995_000, size: 1 }],
    });
    events.push({ kind: "trade", t: h * HOUR + 1, side: "BUY", price: 10_000_000, size: 0.01 });
    events.push({ kind: "trade", t: h * HOUR + 2, side: "BUY", price: 10_000_000, size: 0.01 });
  }
  events.push({
    kind: "book",
    t: 4 * HOUR,
    asks: [{ price: 10_010_000, size: 1 }],
    bids: [{ price: 9_995_000, size: 1 }],
  });

  const r = await runBacktest({
    events,
    strategy: slippageProbe(),
    fillModel: "book",
    capital: 10_000,
  });
  expect(r.takerFills).toBe(4);
  expect(r.endPosition).toBeCloseTo(0, 9);
  // 買いは 10bps、売りは 5bps 不利
  expect(r.takerSlippageBps).toBeCloseTo(7.5, 6);
});

test("刻みに合わない PROBE_SIZE は読み込みの時点で止める", async () => {
  const p = Bun.spawn(
    ["bun", "-e", `await import(${JSON.stringify(import.meta.dir + "/slippage-probe.ts")})`],
    {
      env: { ...process.env, PROBE_SIZE: "0.000305" },
      stderr: "pipe",
    },
  );
  expect(await p.exited).not.toBe(0);
  expect(await new Response(p.stderr).text()).toContain("PROBE_SIZE must be");
});

test("板が届く前の約定で拒否されたら、同じ時間の次の約定で出し直す", async () => {
  const book = {
    kind: "book" as const,
    t: 2,
    asks: [{ price: 10_010_000, size: 1 }],
    bids: [{ price: 9_995_000, size: 1 }],
  };
  const events: MarketEvent[] = [
    { kind: "trade", t: 1, side: "BUY", price: 10_000_000, size: 0.01 },
    book,
    { kind: "trade", t: 3, side: "BUY", price: 10_000_000, size: 0.01 },
    { ...book, t: 4 },
  ];
  const r = await runBacktest({
    events,
    strategy: slippageProbe(),
    fillModel: "book",
    capital: 10_000,
  });
  expect(r.rejects).toBe(1);
  expect(r.takerFills).toBe(1);
});

test("現金不足で拒否されたら同じ時間には出し直さない", async () => {
  const events: MarketEvent[] = [
    {
      kind: "book",
      t: 0,
      asks: [{ price: 10_010_000, size: 1 }],
      bids: [{ price: 9_995_000, size: 1 }],
    },
  ];
  for (let i = 1; i <= 20; i++)
    events.push({ kind: "trade", t: i, side: "BUY", price: 10_000_000, size: 0.01 });
  const r = await runBacktest({
    events,
    strategy: slippageProbe(),
    fillModel: "book",
    capital: 1_000,
  });
  expect(r.rejects).toBe(1);
  expect(r.fills).toBe(0);
});
