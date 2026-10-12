# record: Public WebSocket の板と約定を記録する

## 結論

- `gmocoin record` は GMO コインの Public WebSocket を購読し、受け取ったメッセージを加工せず gzip の JSONL に追記する
- 1 行は `{"recv_at":"<受信時刻 ISO 8601 UTC>","msg":<受信した JSON の生テキスト>}`
- ファイルは `<out>/<channel>/<symbol>/<受信時刻の UTC 日付>.jsonl.gz`。flush のたびに完結した gzip のメンバーを 1 つ追記する (連結した gzip は `zcat` でそのまま読める)
- 切断と無通信は再接続で回復する。書き込みに失敗したら exit 1 で止まり、再起動は外 (systemd 等) に任せる

## 使い方

```bash
gmocoin record                                   # BTC の orderbooks と trades を ./data に
gmocoin record --symbol BTC --symbol BTC_JPY --channel orderbooks --out /srv/gmocoin
```

- `--symbol` (複数可、既定 `BTC`): 現物は `BTC`、レバレッジは `BTC_JPY`。`^[A-Z0-9_]+$` 以外は拒否する
- `--channel` (複数可、既定 `orderbooks` と `trades`): この 2 つ以外は拒否する
- 引数の拒否は接続する前に行い、exit は 0 以外
- `--out` (既定 `./data`)
- 購読は `--symbol` × `--channel` の全組み合わせ (重複は 1 つにする)
- SIGINT / SIGTERM で溜まっている分を書いてから exit 0
- 想定していない例外 (uncaughtException / unhandledRejection) は stderr に出して exit 1
- 接続先は環境変数 `GMOCOIN_PUBLIC_WS_URL` で上書きできる (既定 `wss://api.coin.z.com/ws/public/v1`)

## 実データの形 (2026-10-12 に観測)

- `orderbooks`: `{channel, asks[30], bids[30], symbol, timestamp, grouping}`。BTC で約 1.8 件/秒、1 件約 2.3KB (無圧縮で約 360MB/日)。板は常に上下 30 本までなので、31 本目より深い指値の約定は再現できない
- `trades`: `{channel, price, side, size, symbol, timestamp}`。option 無しで購読すると 1 回の約定が BUY と SELL の 2 件で届き、どちらが taker か分からない。`TAKER_ONLY` で購読し、taker 側の 1 件だけを受ける (`side` が aggressor になる)。日次 CSV も 1 約定 1 行
- サーバーの ping には Bun の WebSocket が自動で pong を返す (公式ドキュメントでは pong が 3 回返らないと切断)
- 価格・数量は文字列で届く。記録は受信したテキストをそのまま残すので、数値への変換も再シリアライズもしない

## 書き込み

- 受信した行はファイルごとにメモリに溜め、`flushIntervalMs` (既定 5000) ごとに gzip して 1 回の追記で書く。プロセスが落ちて失うのは最大でこの間隔ぶん
- メンバーを 5 秒ごとに分けるぶん圧縮率は落ちる。BTC の板で 1 本の gzip に通すと約 5.4MB/日、5 秒ごとのメンバーでは約 14.6MB/日 (実測)。落ちたときに失う量を小さくする方を取る
- プロセスがその日のファイルに初めて書く前に、既存のファイルが gzip として最後まで読めるかを確かめる。読めなければ (追記の途中で落ちた / 電源断) `<元の名前>.corrupt-<UTC 時刻>` に改名して stderr に出し、新しいファイルに書き始める。壊れた末尾の後ろに追記すると、普通の読み手 (`zcat` / Python の gzip) はその先を全部読めなくなるため。退避したファイルも、壊れた箇所の手前のメンバーまでは読める
- `stop()` は溜まっている分を書いてから終わる。2 回呼んでもよい
- 生テキストに改行 (CR / LF) が含まれていたら空白に置き換える。JSON の文字列の中に生の改行は入らないので、置き換わるのは JSON の空白だけで意味は変わらない
- 日付の切り替えは受信時刻で決める (書き込んだ時刻ではない)
- 書き込み (ディレクトリ作成 / 追記) に失敗したら、捨てた行数と一緒に stderr に出して `onFatal` を呼び、記録を止める。CLI は exit 1。再試行はしない (再試行の間に溜まる行で、気づかないままメモリを使い切るため)

## 受け付けるメッセージ

- 次をすべて満たすものだけを書く。満たさないものは書かず、生テキストの先頭 200 文字を含めて stderr に 1 行出す (形式が変わって全件が弾かれても、ログが記録と同じ量に膨らまないように)
  - JSON として読め、object である
  - `channel` が `orderbooks` か `trades`
  - `symbol` が `^[A-Z0-9_]+$` (ファイルのパスに使うため。`../` などで `--out` の外に書かせない)
- 購読していない組でも、条件を満たせば書く
- `{"error": ...}` (購読の拒否など) もここで stderr に出る。拒否された stream は stats で 0 のまま増えないので、そこで気づく

## 守る制約

- subscribe は同一 IP から 1 秒 1 回まで (公式ドキュメント)。購読コマンドの送信間隔は既定 1100ms で、再接続をまたいでも直前の送信から数える
- 購読コマンドは `{"command":"subscribe","channel":"orderbooks","symbol":"BTC"}`。trades だけは `"option":"TAKER_ONLY"` を付ける
- 間隔はプロセスの中でしか数えない。同じ IP で 2 つ以上のプロセスを動かさない。systemd で再起動させるなら `RestartSec` を数秒以上にする (既定の 100ms だと、起動直後の購読が続けて飛ぶ)
- 購読の送信は接続ごとの一連の手順で、その接続が切れたら残りは送らない

## 回復

- 再接続の待ちは 1s から倍々で最大 60s。有効なメッセージを 1 件受け取ったら 1s に戻す
- 切断 (close / error) でも無通信でも、再接続は 1 本だけ予約する
- 無通信: 接続を始めてから、または最後の有効なメッセージから 60 秒経ったら、その接続を捨てて再接続する。捨てた接続の close イベントは待たない (相手が応答しないと届かないため)。Bun の `close()` は相手が close フレームに応えなくてもその場で TCP を切る (2026-10-12 実測、0ms) ので、ソケットは残らない。無効なメッセージは無通信の判定を延ばさない
- `--channel trades` だけの購読では、閑散時に無通信で切るたびに再接続の待ちが伸び、最大 60 秒まで延びる (有効なメッセージが来るまで 1 秒に戻らない)。その間の約定は日次 CSV で埋める
- 無通信は接続全体で見る。板が流れている間に約定の stream だけが止まっても再接続はしない。stats でその stream の数が増えないことで気づく
- 60 秒ごとに stream ごとの起動からの累計受信件数を stderr に 1 行で出す (`stats orderbooks/BTC=1234 trades/BTC=0` の形)。購読している stream は 0 件でも出す。数が増えていなければ止まっていると読める
- 再接続から購読し直すまでの間 (購読数 × 1.1 秒前後) は受信できない。trades の欠けは日次 CSV で埋められる。orderbooks は毎回スナップショットなので次の 1 件で戻る

## やらないこと

- 注文・Private API
- 過去の約定の取得 (日次 CSV `https://api.coin.z.com/data/trades/BTC/YYYY/MM/YYYYMMDD_BTC.csv.gz` が公開されている。別 issue)
- 板の差分化・正規化 (記録は生のまま。再現は読む側でやる)
- 60 秒の無通信が普通に起きる購読の調整。`--channel trades` だけだと閑散時に起きる (2026-10-12 20 時台に BTC の約定が 90 秒で 1 件)。既定の板を含む購読では板が約 2 件/秒届くので起きない
- 退避した `.corrupt-` ファイルの修復 (手前のメンバーは読めるので、要るときに人が取り出す)
