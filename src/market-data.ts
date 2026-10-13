// 仕様は docs/design/backtest.md の「入力の形」「取得とキャッシュ」
import { existsSync, createReadStream, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createGunzip } from "node:zlib";
import type { MarketEvent, Side } from "./backtest.ts";

export const DEFAULT_TRADES_CSV_URL = "https://api.coin.z.com/data/trades";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// ファイル D は UTC の前日 21:00 から D の 21:00 まで。3 時間ずらすと UTC の日付になる
const CSV_CUT_SHIFT_MS = 3 * HOUR_MS;
const CSV_HEADER = "symbol,side,size,price,timestamp";
const RECORD_FILE = /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z\.jsonl\.gz$/;

type RawLevel = { price: string; size: string };
type RawBook = { timestamp: string; asks: RawLevel[]; bids: RawLevel[] };
type RawTrade = { timestamp: string; side: string; price: string; size: string };

function csvDay(t: number): number {
  return Math.floor((t + CSV_CUT_SHIFT_MS) / DAY_MS) * DAY_MS;
}

// [from, to) を覆う日次 CSV の日付 (YYYYMMDD)。ファイル D は UTC の前日 21:00 から D の 21:00 まで
export function csvFileDates(from: number, to: number): string[] {
  const dates: string[] = [];
  const last = csvDay(to - 1);
  for (let d = csvDay(from); d <= last; d += DAY_MS) {
    dates.push(new Date(d).toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return dates;
}

// 無ければ <dataDir>/csv/<symbol>/<date>_<symbol>.csv.gz に取得してそのパスを返す
export async function ensureCsv(opts: {
  dataDir: string;
  symbol: string;
  date: string;
  baseUrl: string;
  timeoutMs?: number;
}): Promise<string> {
  const { dataDir, symbol, date, baseUrl, timeoutMs = 60_000 } = opts;
  const dir = join(dataDir, "csv", symbol);
  const path = join(dir, `${date}_${symbol}.csv.gz`);
  if (existsSync(path)) return path;

  const url = `${baseUrl}/${symbol}/${date.slice(0, 4)}/${date.slice(4, 6)}/${date}_${symbol}.csv.gz`;
  // 数千日分を 1 本ずつ取るので、1 本が止まると全体が終わらないまま何も言わなくなる
  let body: Buffer;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`CSV for ${date} is not available (${(err as Error).message}): ${url}`);
  }

  await mkdir(dir, { recursive: true });
  // 途中で切れた取得が cache として残ると次回から壊れたまま使われるので、rename で一度に見せる
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, path);
  return path;
}

function num(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${JSON.stringify(v)}`);
  return n;
}

function sideOf(v: string): Side {
  if (v !== "BUY" && v !== "SELL") throw new Error(`unknown side: ${JSON.stringify(v)}`);
  return v;
}

function levels(ls: RawLevel[]) {
  return ls.map((l) => ({ price: num(l.price), size: num(l.size) }));
}

// 板は 1 日で無圧縮約 360MB になるので、展開しながら行に切る。途中で切れた gzip は zlib のエラー
// (Z_*) で止まるので、そこまでの完成した行を流してから onTorn を呼ぶ
async function* gunzipLines(path: string, onTorn: () => void): AsyncGenerator<string, void> {
  const gunzip = createReadStream(path).pipe(createGunzip());
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of gunzip) {
      const lines = (rest + decoder.decode(chunk as Buffer, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line !== "") yield line;
    }
  } catch (err) {
    if (!String((err as NodeJS.ErrnoException).code ?? "").startsWith("Z_")) throw err;
    onTorn();
    return;
  }
  rest += decoder.decode();
  if (rest !== "") yield rest;
}

export async function* csvEvents(opts: {
  paths: string[];
  from: number;
  to: number;
}): AsyncIterable<MarketEvent> {
  const { paths, from, to } = opts;
  for (const path of paths) {
    let header = true;
    for await (const line of gunzipLines(path, () => {
      throw new Error(`truncated CSV: ${path}`);
    })) {
      if (header) {
        if (line !== CSV_HEADER) throw new Error(`unexpected CSV header: ${path}`);
        header = false;
        continue;
      }
      const f = line.split(",");
      if (f.length !== 5) throw new Error(`bad CSV row in ${path}: ${line}`);
      const [, side, size, price, ts] = f as [string, string, string, string, string];
      const t = Date.parse(ts.replace(" ", () => "T") + "Z");
      if (!Number.isFinite(t)) throw new Error(`bad CSV time in ${path}: ${ts}`);
      if (t < from || t >= to) continue;
      yield { kind: "trade", t, side: sideOf(side), price: num(price), size: num(size) };
    }
  }
}

// ファイル名の時刻は受信の開始時刻 (例: 2026-10-12T235959.990Z.jsonl.gz)
function fileStart(name: string): number {
  const iso = name
    .replace(".jsonl.gz", "")
    .replace(/T(\d{2})(\d{2})(\d{2})/, (_, h, m, s) => `T${h}:${m}:${s}`);
  return Date.parse(iso);
}

async function* recordChannel(opts: {
  dataDir: string;
  symbol: string;
  channel: "orderbooks" | "trades";
  from: number;
  to: number;
  log: (line: string) => void;
}): AsyncGenerator<MarketEvent, void> {
  const { dataDir, symbol, channel, from, to, log } = opts;
  const dir = join(dataDir, channel, symbol);
  if (!existsSync(dir)) return;

  // 前日の名前のファイルに当日の行が入ることがあるので、日付は前後 1 日まで広めに読む
  const lo = Math.floor(from / DAY_MS) * DAY_MS - DAY_MS;
  const hi = Math.floor(to / DAY_MS) * DAY_MS + 2 * DAY_MS;
  const names = readdirSync(dir)
    .filter((n) => RECORD_FILE.test(n))
    .sort();
  for (const name of names) {
    const start = fileStart(name);
    if (start < lo || start >= hi) continue;

    const path = join(dir, name);
    const torn = () => log(`torn tail in ${path}: read up to it and went on`);
    for await (const line of gunzipLines(path, torn)) {
      const { msg } = JSON.parse(line) as { msg: { timestamp: string } };
      const t = Date.parse(msg.timestamp);
      if (!Number.isFinite(t)) throw new Error(`bad timestamp in ${path}: ${msg.timestamp}`);
      if (t < from || t >= to) continue;
      if (channel === "orderbooks") {
        const book = msg as RawBook;
        yield { kind: "book", t, asks: levels(book.asks), bids: levels(book.bids) };
      } else {
        const trade = msg as RawTrade;
        yield {
          kind: "trade",
          t,
          side: sideOf(trade.side),
          price: num(trade.price),
          size: num(trade.size),
        };
      }
    }
  }
}

export async function* recordEvents(opts: {
  dataDir: string;
  symbol: string;
  from: number;
  to: number;
  log?: (line: string) => void;
}): AsyncIterable<MarketEvent> {
  const { dataDir, symbol, from, to, log = (line: string) => console.error(line) } = opts;
  const books = recordChannel({ dataDir, symbol, channel: "orderbooks", from, to, log });
  const trades = recordChannel({ dataDir, symbol, channel: "trades", from, to, log });

  // 同じ時刻なら約定を先に流す
  let b = await books.next();
  let a = await trades.next();
  while (!a.done || !b.done) {
    if (!a.done && (b.done || a.value.t <= b.value.t)) {
      yield a.value;
      a = await trades.next();
    } else if (!b.done) {
      yield b.value;
      b = await books.next();
    }
  }
}
