# ペーパートレード

## 結論

- ペーパートレードは「実際の板を記録し続け、後からその板で戦略を回す」形で行う。注文は出さない
- 記録は常駐させたホストで `gmocoin record` を回し続ける (systemd の例は下)。落ちたことは外から気づける形にする (記録が書かれていないと通知が来る外形監視)
- 評価は `gmocoin backtest --source record --warmup-days 60` で、記録した板を食って成行を約定させる。同じ期間を約定 CSV (`--source csv --slippage-bps 5`) で回した結果との差が、バックテストの約定モデルの甘さになる
- 戦略の売買だけでは成行の標本が足りない (trend-ensemble は 2 週間で数回)。滑りは `strategies/slippage-probe.ts` (毎時に決まった量を買い、次の時間に売る) を同じ記録で回して測る

## 記録の常駐

```ini
# /etc/systemd/system/gmocoin-record.service
[Unit]
Description=gmocoin record (BTC orderbooks and trades)
Wants=network-online.target
After=network-online.target

[Service]
User=<実行ユーザー>
ExecStart=/usr/local/bin/bun run <clone>/src/cli.ts record --out <data>
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- 負荷は RSS 約 40 MB、CPU 1% 未満、板の gzip JSONL は約 20 MB/日 (2026-10-14 に実測)
- `Restart=always` は落ちたプロセスを上げ直すだけで、繋がったまま書かれない状態には効かない。最新のファイルの更新時刻を見て、新しいときだけ外形監視に生存を送る形にする

## 評価のしかた

```bash
bun src/cli.ts backtest --strategy strategies/trend-ensemble.ts --data <data> --from <開始日> --to <終了日> --warmup-days 60 --source record
bun src/cli.ts backtest --strategy strategies/trend-ensemble.ts --data <data> --from <開始日> --to <終了日> --warmup-days 60 --source csv --slippage-bps 5
bun src/cli.ts backtest --strategy strategies/slippage-probe.ts --data <data> --from <開始日> --to <終了日> --source record
```

- `--from` は記録が丸 1 日そろっている最初の日 (UTC)。`--to` は最後の約定 CSV が公開済みの日まで (CSV は温めと csv 側で使う)
- 温めは 60 日。trend-ensemble は 56 日の SMA を使い、20 日のボラティリティはその内側に収まるので、56 日に数日の余裕を足した
- 見る値は `pnl` / `maxDrawdownPct` / `fills` と `takerSlippageBps`。バックテストは滑り 5bps を置いており、20bps で利益が消える (`docs/strategies.md`)
- 滑りの量はプローブの `PROBE_SIZE` (既定 0.0003 BTC) に依存する。戦略の注文の大きさに合わせる
- 記録の欠けはファイルの時間範囲で数える (`docs/design/record.md`)。欠けた間は直前の板のまま進むので、欠けが長い期間は評価に使わない
- 記録のディレクトリを実行ユーザー以外 (root 等) で回すと、CSV のキャッシュがそのユーザーの所有で残る。記録と同じユーザーで回す

## 捨てた案

- 実時間で判断するプロセスを別に常駐させる: 注文を出さない限り、約定は記録した板で回すのと同じエンジンで決まるので、結果は後から記録を回したものと変わらない。常駐の判断ループは注文を出す段階で Private API と一緒に作る
