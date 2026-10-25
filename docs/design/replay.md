# replay: 値動きを JSONL で出す

## 結論

- `gmocoin replay` は期間 `[from, to)` の約定 (と板) を時刻順に 1 行 1 件の JSON で stdout に出す。売買の判断と評価をする別の道具が、GMO の CSV と記録ファイルの形を知らずに値動きを受け取るための口
- 読み方は `backtest` と同じ関数を通す (`docs/design/backtest.md` の「入力の形」「取得とキャッシュ」)。CSV の取得のログと警告は stderr
- 期間に 1 件も無ければ何も出さずに exit 1。空の出力を「動きが無かった」と読ませない

## 使い方

```bash
gmocoin replay --from 2026-10-15 --to 2026-10-29                      # 約定 CSV (取得してキャッシュ)
gmocoin replay --source record --data /srv/gmocoin/data --from 2026-10-15 --to 2026-10-29
```

- `--from` / `--to` / `--source` / `--data` は `backtest` と同じ
- `--symbol` (既定 `BTC`): `backtest` と違い BTC に限らない (刻みを使わないため)

## 行の形

```json
{"kind":"trade","t":1760490000000,"side":"BUY","price":13169883,"size":0.0003}
{"kind":"book","t":1760490000123,"asks":[{"price":13170000,"size":0.01}],"bids":[{"price":13169000,"size":0.02}]}
```

- `t` は取引所の時刻 (UNIX ms)。`side` は taker 側。`price` / `size` は数値
- `asks` は安い順、`bids` は高い順 (受信した板のまま)
- 同じ時刻なら約定を先に出す
- 形を変えるときは、読む側 (soba) も同じ変更で直す
