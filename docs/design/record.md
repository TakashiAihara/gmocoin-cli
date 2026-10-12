# record: Public WebSocket の板と約定を記録する

## 結論

- `gmocoin record` は GMO コインの Public WebSocket を購読し、受け取ったメッセージを加工せず gzip の JSONL に追記する
- 1 行は `{"recv_at":"<受信時刻 ISO 8601 UTC>","msg":<受信した JSON そのもの>}`
- ファイルは `<out>/<channel>/<symbol>/<受信時刻の UTC 日付>.jsonl.gz`。同じ日に再起動したら同じファイルに gzip のメンバーを足す (連結した gzip は `zcat` でそのまま読める)
- 切断と無通信は再接続で回復し、購読し直す。プロセスが落ちない限り止まらない

## 使い方

```bash
gmocoin record                                   # BTC の orderbooks と trades を ./data に
gmocoin record --symbol BTC --symbol BTC_JPY --channel orderbooks --out /srv/gmocoin
```

- `--symbol` (複数可、既定 `BTC`): 現物は `BTC`、レバレッジは `BTC_JPY`
- `--channel` (複数可、既定 `orderbooks` と `trades`): この 2 つ以外は拒否する
- `--out` (既定 `./data`)
- 購読は `--symbol` × `--channel` の全組み合わせ
- SIGINT / SIGTERM で書きかけの gzip を閉じてから exit 0
- 接続先は環境変数 `GMOCOIN_PUBLIC_WS_URL` で上書きできる (既定 `wss://api.coin.z.com/ws/public/v1`)

## 実データの形 (2026-10-12 に観測)

- `orderbooks`: `{channel, asks[30], bids[30], symbol, timestamp, grouping}`。BTC で約 2 件/秒、1 件約 2.3KB (無圧縮で約 570MB/日)
- `trades`: `{channel, price, side, size, symbol, timestamp}`。BTC で約 17 件/分
- 価格・数量は文字列で届く。記録は受信した JSON をそのまま残すので、数値への変換はしない

## 守る制約

- subscribe は同一 IP から 1 秒 1 回まで (公式ドキュメント)。購読コマンドの送信間隔は既定 1100ms
- 受信が JSON として読めないもの、`channel` か `symbol` を持たないもの (`{"error": ...}` など) は書かず、stderr に 1 行出して続ける

## 回復

- 切断 (close / error): 待ってから再接続する。待ち時間は 1s から倍々で最大 60s。メッセージを 1 件受け取ったら 1s に戻す
- 無通信: 60 秒何も届かなければ接続を切って再接続する (サーバー側が黙って止まった場合に気づくため)
- 60 秒ごとに stream ごとの起動からの累計受信件数を stderr に 1 行で出す (`stats orderbooks/BTC=1234 trades/BTC=56` の形)。数が増えていなければ止まっていると読める

## やらないこと

- 注文・Private API
- 過去の約定の取得 (日次 CSV `https://api.coin.z.com/data/trades/BTC/YYYY/MM/YYYYMMDD_BTC.csv.gz` が公開されている。別 issue)
- 板の差分化・正規化 (記録は生のまま。再現は読む側でやる)
