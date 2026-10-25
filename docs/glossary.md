# 用語集

## 衝突している語

1 つの語が 2 つ以上の別物を指しかけている。これから書く文書・コメント・issue では、必ず修飾子を付けて書く。既存の文書 (`docs/strategies.md` の表の列「約定」など) には修飾子の無い箇所が残っている。

### 約定

- 市場の約定: 取引所で成立した取引 1 件。CSV の 1 行、record の `trades` の 1 行で、型は `Trade` (`src/backtest.ts`)。`MarketEvent` の `kind: "trade"` として戦略の `onTrade` に流れる
- 戦略の約定: backtest の仮想口座で戦略の注文の一部か全部が成立したこと。型は `Fill` (`src/backtest.ts`)、戦略には `onFill` で届く。出力 JSON の `fills` / `makerFills` / `takerFills` はこの回数で、1 つの注文が何回かに分けて約定すればその回数だけ数える (注文の数ではない)
- 「期間内に約定が 1 件も無い」のような書き方をしない。期間に市場データ (市場の約定と記録の板) が 1 件も無ければ `events === 0` で、`src/cli.ts` が exit 1 にする。record で板だけある期間は `events > 0` なので exit 1 にならない。戦略の約定が無いのは `fills === 0` で、exit code は変わらない

### 板

- 記録の板: record の `orderbooks` の 1 行。型は `Book` (`src/backtest.ts`)、`MarketEvent` の `kind: "book"` として戦略の `onBook` に流れる。`--source record` のときだけある
- 戦略から見える板: `ctx.book`。最新の記録の板から、それ以降に backtest の成行が食った分を引いたもの。次の記録の板が届くまで減ったまま残り、指値の前に並ぶ量もこの板で見る (`docs/design/backtest.md` の「成行」節)。`--source csv` では常に `undefined`

### 期間

- 期間: `--from` (含む) から `--to` (含まない) まで (`docs/design/backtest.md` の「使い方」節と同じ)
- 学習期間 / 検証期間: `--split` で分けた `[from, split)` と `[split, to)`。出力 JSON の `periods[].name` は `train` / `test` で、`--split` が無ければ期間全体の `all` が 1 つだけ。`periods[]` の要素ごとに新しい口座と新しい戦略で回し、`pass` は `train` 以外の最後の要素で決める (`src/cli.ts`)
- 窓: 戦略の指標が遡る長さ (「56 日の SMA」)。`docs/strategies.md` は「期間 (日)」と書いているが、上の期間とは別物

### 資産

- 期中の資産: 現金と、保有 BTC を直前の市場の約定の価格 (無ければ板の最良の買値) で値付けした額の合計。`maxDrawdownPct` はこの値の高値からの最大の下落率
- 期末の資産: `endEquity`。期中の資産から、期末に残った BTC を売ったとして Taker 手数料を引いた額。`pnl` / `returnPct` はこちらで計算する

### 滑り

- 置く滑り: `--slippage-bps`。`--source csv` の成行の約定価格に、不利な側へ足す値
- 測った滑り: 出力 JSON の `takerSlippageBps`。成行の約定価格が、注文を決めた時点の直前の市場の約定の価格からどれだけ不利だったか。csv では置く滑りと latency の間の値動きを含むので、置く滑りと独立した値ではない。重みと数えない成行は `docs/design/backtest.md` の「結果」節

### side

- 市場の約定の side: `Trade.side`。taker 側の売買方向。record は GMO の `TAKER_ONLY` で購読し、CSV の `side` 列も taker 側として読む (`docs/design/backtest.md` の「日次約定 CSV」節)
- 注文の side: `OrderAction.side` / `Fill.side`。戦略が買うか売るか

## 語の一覧

### 市場データ

- source: backtest の入力。`csv` は GMO の日次約定 CSV (`<data>/csv/<symbol>/`、`src/market-data.ts` の `csvEvents`)、`record` は `gmocoin record` の出力 (`recordEvents`)
- record の行: `{"recv_at": ..., "msg": ...}` の gzip JSONL。チャンネル (`Channel`、`src/record.ts`) は `orderbooks` と `trades`
- 時刻: `Trade.t` / `Book.t` は取引所の時刻 (CSV の `timestamp` 列、record の `msg.timestamp`)。record の `recv_at` は受け取った時刻で、backtest は使わない
- イベント: `MarketEvent` (`src/backtest.ts`)。市場の約定か記録の板のどちらか。出力 JSON の `events` は期間のイベントの件数で、温めの分を含まない
- 温め: 期間ごとに、その開始の手前 `--warmup-days` 日分の CSV の市場の約定を戦略に流すこと。返したアクションは捨てる (`BacktestOptions.warmup`)。板は流さない。`--split` のとき、検証期間の温めは学習期間の末尾と重なる
- 約定モデル: `FillModel`。`book` は `--source record`、`trades` は `--source csv` で使う。中身は `docs/design/backtest.md` の「約定のモデル」節

### 注文

- 成行: `OrderAction` の `type: "market"`。約定すると taker
- 指値: `OrderAction` の `type: "limit"`。Post-only (GMO の `SOK`) として扱い、約定すると maker
- maker / taker: `Fill.liquidity`。手数料は `--maker-fee-bps` / `--taker-fee-bps` (既定 -1 / 5、負は受け取り)
- 拒否: `Reject`。戦略には `onReject` で届き、出力 JSON の `rejects` はこの件数
- 刻み: 数量は `SIZE_STEP` (0.00001 BTC)、値段は `TICK_SIZE` (1 円)

### 結果

- 損益: `pnl` (JPY、手数料込み、期末の資産 − `--capital`)。`returnPct` は `--capital` に対する割合
- pass: 出力 JSON の `pass`。判定する期間で `pnl > 0` かつ `maxDrawdownPct <= 20`
