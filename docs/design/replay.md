# replay: 値動きを JSONL で出す

## 結論

- `gmocoin replay` は期間 `[from, to)` の約定 (と板) を時刻順に 1 行 1 件の JSON で stdout に出す。売買の判断と評価をする別の道具が、GMO の CSV と記録ファイルの形を知らずに値動きを受け取るための口
- 読み方は `backtest` と同じ関数を通す (`docs/design/backtest.md` の「入力の形」「取得とキャッシュ」)。CSV の取得のログと警告は stderr
- 期間に 1 件も無ければ何も出さずに exit 3 (他の失敗は exit 1)。読む側は空の期間を失敗と分けて扱える (soba は温めの期間だけ空を許す)

## 使い方

```bash
gmocoin replay --from 2026-10-12 --to 2026-10-13                      # 約定 CSV (取得してキャッシュ)
gmocoin replay --source record --data /srv/gmocoin --from 2026-10-12 --to 2026-10-13
```

- `--from` / `--to` / `--source` / `--data` は `backtest` と同じ
- `--symbol` (既定 `BTC`): `backtest` と違い BTC に限らない (刻みを使わないため)

## 行の形

```json
{"kind":"trade","t":1792026000000,"side":"BUY","price":13169883,"size":0.0003}
{"kind":"book","t":1792026000123,"asks":[{"price":13170000,"size":0.01}],"bids":[{"price":13169000,"size":0.02}]}
```

- `t` は取引所の時刻 (UNIX ms)。`price` / `size` は数値
- `side` は taker 側。記録は `TAKER_ONLY` で受けたもの、CSV は REST の約定と突き合わせた観測 (`docs/design/backtest.md` の「入力の形」) による
- CSV の数量は小数 4 桁に丸められていて、`size: 0` の約定が出る (2026-10-20 の CSV で 8,658 行中 371 行)
- `asks` は安い順、`bids` は高い順 (受信した板のまま)
- 同じ時刻なら約定を先に出す
- 約定は時刻順。板は受信した順に出し、取引所の時刻がわずかに戻ることがある (trade1 の 2026-10-14〜10-25 の記録で 1,711,271 行中 28 回、最大 11ms)
- 形を変えるときは、読む側 (soba) も同じ変更で直す

## 出し方

- csv は期間の CSV を全部取得してから 1 行目を出す (キャッシュに無ければ 1 日 1 本ずつ。2021 年からなら約 2,100 本)
- exit が 0 でも 3 でもないとき、stdout はそこまでで切れている。読む側は途中まで読んだ行を使わない
- 読む側が途中で閉じたら (`| head` 等)、読むのをやめて exit 0
