#!/usr/bin/env python3
"""trend-ensemble の近傍パラメータを日次約定 CSV の 1 時間足で近似して並べる (docs/strategies.md の探索表)。

usage: scripts/strategy-sweep.py <data>/csv/BTC <from> <to> [<from> <to> ...]

足の終値で持つ比率を決め、その終値で持ち替えたものとして手数料 0.05% + 滑り 5bps を引く近似。
gmocoin backtest より甘く (約定は次の約定価格) 速い。判定は gmocoin backtest で取り直す。
"""
import csv
import gzip
import math
import os
import sys
from datetime import datetime, timedelta

COST = 0.0010
PER_YEAR = 365 * 24


def hourly(csv_dir):
    closes = {}
    for f in sorted(os.listdir(csv_dir)):
        with gzip.open(os.path.join(csv_dir, f), "rt") as fh:
            rows = csv.reader(fh)
            next(rows)
            for row in rows:
                closes[row[4][:13]] = float(row[3])
    hours = sorted(closes)
    # 約定の無い時間は直前の終値で埋める (戦略と同じ扱い)
    t, end, out = datetime.strptime(hours[0], "%Y-%m-%d %H"), datetime.strptime(hours[-1], "%Y-%m-%d %H"), []
    last = closes[hours[0]]
    while t <= end:
        last = closes.get(t.strftime("%Y-%m-%d %H"), last)
        out.append((t.strftime("%Y-%m-%d %H"), last))
        t += timedelta(hours=1)
    return out


def simulate(c, a, b, lbs, tv, band, vol_n=480):
    s = [0.0]
    for x in c:
        s.append(s[-1] + x)
    eq, w, peak, dd, n = 1.0, 0.0, 1.0, 0.0, 0
    for i in range(a, b):
        if i > a:
            g = c[i] / c[i - 1] - 1
            eq *= 1 + w * g
            w = w * (1 + g) / (1 + w * g)
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
        k = i - a + 1
        use = [m for m in lbs if k >= m]
        if not use or k <= vol_n:
            continue
        r = [math.log(c[j] / c[j - 1]) for j in range(i - vol_n + 1, i + 1)]
        m = sum(r) / len(r)
        vol = math.sqrt(sum((x - m) ** 2 for x in r) / len(r) * PER_YEAR)
        # 戦略と同じく、ボラティリティ 0 では上限の 1 を掛ける (TS の tv / 0 は Infinity)
        t = sum(c[i] > (s[i + 1] - s[i + 1 - m]) / m for m in use) / len(use) * (min(1, tv / vol) if vol > 0 else 1)
        if abs(t - w) >= band or (t == 0 and w > 0):
            eq -= abs(t - w) * eq * COST
            w, n = t, n + 1
            dd = max(dd, 1 - eq / peak)
    return eq - 1, dd, n


def main():
    bars = hourly(sys.argv[1])
    days, c = [d for d, _ in bars], [x for _, x in bars]
    periods = [(sys.argv[i], sys.argv[i + 1]) for i in range(2, len(sys.argv), 2)]
    idx = lambda d: next((i for i, x in enumerate(days) if x >= d), len(days))
    for lb in ([5, 10, 20, 40], [7, 14, 28, 56], [10, 20, 40, 80]):
        for tv in (0.1, 0.15, 0.2):
            for band in (0.1, 0.15, 0.2):
                cells = []
                for f, t in periods:
                    r, dd, n = simulate(c, idx(f), idx(t), [d * 24 for d in lb], tv, band)
                    cells.append(f"{f}..{t} ret={r * 100:6.1f}% dd={dd * 100:5.1f}% n={n}")
                print(f"days={lb} target={tv} band={band} | " + " | ".join(cells), flush=True)


if __name__ == "__main__":
    main()
