# 用語集

## 衝突している語

1 つの語が 2 つの別物を指しかけている。文書・コメント・issue では、必ず修飾子を付けて書く。

### 約定

- 市場の約定: 取引所で成立した取引 1 件。CSV の 1 行、record の `trades` の 1 行で、型は `Trade` (`src/backtest.ts`)。`MarketEvent` の `kind: "trade"` として戦略の `onTrade` に流れる。出力 JSON の `events` は市場の約定と板の件数の合計
- 戦略の約定: backtest の仮想口座で戦略の注文が成立したこと。型は `Fill` (`src/backtest.ts`)、戦略には `onFill` で届き、出力 JSON の `fills` / `makerFills` / `takerFills` はこの件数
- 「期間内に約定が 1 件も無い」のような書き方をしない。市場の約定が無いなら `events === 0` (`src/cli.ts` が exit 1 にする)、戦略の約定が無いなら `fills === 0` (exit code は変わらない)

### 板

- 記録の板: record の `orderbooks` の 1 行。型は `Book` (`src/backtest.ts`)、`MarketEvent` の `kind: "book"` として戦略の `onBook` に流れる。`--source record` のときだけある
- 戦略から見える板: `ctx.book`。記録の板から、それ以降に backtest の成行が食った分を引いたもの。次の記録の板が届くまで減ったまま残り、指値の前に並ぶ量もこの板で見る (`docs/design/backtest.md` の成行の節)。`--source csv` では常に `undefined`

### 期間

- 検証の期間: 出力 JSON の `periods[].name` で、`all` (`--split` なし) / `train` / `test` のどれか (`src/cli.ts`)。期間ごとに新しい口座と新しい戦略で回し、`pass` は `train` 以外の最後の期間で決める
- 入力の範囲: `--from` (含む) から `--to` (含まない) まで。`--split` で検証の期間に分ける
- ウォームアップ: 検証の期間の手前 `--warmup-days` 日分の CSV。戦略に流すが、返したアクションは捨てる (`BacktestOptions.warmup`)。検証の期間にも入力の範囲にも数えない

### side

- 市場の約定の side: `Trade.side`。record は GMO の `TAKER_ONLY` で購読するので、taker 側の売買方向になる。CSV は `side` 列をそのまま使う
- 注文の side: `OrderAction.side` / `Fill.side`。戦略が買うか売るか

## 語の一覧

### 市場データ

- source: backtest の入力。`csv` は GMO の日次約定 CSV (`<data>/csv/<symbol>/`、`src/market-data.ts` の `csvEvents`)、`record` は `gmocoin record` の出力 (`recordEvents`)
- record の行: `{"recv_at": ..., "msg": ...}` の gzip JSONL。チャンネル (`Channel`、`src/record.ts`) は `orderbooks` と `trades`
- イベント: `MarketEvent` (`src/backtest.ts`)。市場の約定か記録の板のどちらか
- 約定モデル: `FillModel`。`book` (`--source record`、板の待ち行列で約定させる) か `trades` (`--source csv`、価格を突き抜けた市場の約定で約定させる)

### 注文

- 成行: `OrderAction` の `type: "market"`。約定すると taker
- 指値: `OrderAction` の `type: "limit"`。Post-only (GMO の `SOK`) として扱い、約定すると maker
- maker / taker: `Fill.liquidity`。手数料は `--maker-fee-bps` / `--taker-fee-bps` (既定 -1 / 5、負は受け取り)
- 拒否: `Reject`。戦略には `onReject` で届き、出力 JSON の `rejects` はこの件数
- 刻み: 数量は `SIZE_STEP` (0.00001 BTC)、値段は `TICK_SIZE` (1 円)

### 結果

- 損益: `pnl` (JPY、手数料込み)。`returnPct` は開始時の資産に対する割合
- 資産: `startEquity` / `endEquity`。現金 (`endCash`) と保有 BTC (`endPosition`) の時価の合計
- 最大ドローダウン: `maxDrawdownPct`。資産の高値からの最大の下落率
- 成行の滑り: `takerSlippageBps`。成行の約定価格が、注文を決めた時点の直前の市場の約定の価格からどれだけ不利だったか。`--slippage-bps` は csv で足す値で、こちらは測った値
- pass: 出力 JSON の `pass`。判定する期間で損益 > 0 かつ最大ドローダウン ≤ 20%
