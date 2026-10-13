// 仕様は docs/design/backtest.md の「入力の形」「取得とキャッシュ」
import type { MarketEvent } from "./backtest.ts";

export const DEFAULT_TRADES_CSV_URL = "https://api.coin.z.com/data/trades";

// [from, to) を覆う日次 CSV の日付 (YYYYMMDD)。ファイル D は UTC の前日 21:00 から D の 21:00
export function csvFileDates(_from: number, _to: number): string[] {
  throw new Error("not implemented");
}

// 無ければ <dataDir>/csv/<symbol>/<date>_<symbol>.csv.gz に取得してそのパスを返す
export async function ensureCsv(_opts: {
  dataDir: string;
  symbol: string;
  date: string;
  baseUrl: string;
}): Promise<string> {
  throw new Error("not implemented");
}

export function csvEvents(_opts: {
  paths: string[];
  from: number;
  to: number;
}): AsyncIterable<MarketEvent> {
  throw new Error("not implemented");
}

export function recordEvents(_opts: {
  dataDir: string;
  symbol: string;
  from: number;
  to: number;
  log?: (line: string) => void;
}): AsyncIterable<MarketEvent> {
  throw new Error("not implemented");
}
