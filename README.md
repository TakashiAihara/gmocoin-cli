# gmocoin-cli
CLI for the GMO Coin API (market data recording, backtesting, trading)

## Install

```bash
bun install
bun run install-bin   # links ./src/cli.ts to ~/.local/bin/gmocoin
```

## record

Records the public WebSocket `orderbooks` and `trades` channels as gzip JSONL. No API key is needed and no order is placed. Trades are subscribed with GMO's `TAKER_ONLY` option, which sends only the taker side. Without it, the same fill was observed arriving as a BUY and a SELL.

```bash
gmocoin record                                        # BTC orderbooks and trades into ./data
gmocoin record --symbol BTC --symbol BTC_JPY --out /srv/gmocoin
```

Each process writes its own files, `<out>/<channel>/<symbol>/<UTC date>T<HHMMSS.mmm>Z.jsonl.gz`, and never appends to an existing one. A restart or a new UTC day starts a new file. Read a day file by file, because `zcat` stops at the first file with a torn tail:

```bash
for f in data/orderbooks/BTC/2026-10-12T*.jsonl.gz; do zcat "$f"; done | head -1
```

Each line is `{"recv_at":"<receive time, UTC>","msg":<the message as received>}`. Line breaks inside the message are replaced with spaces; nothing else is changed. The spec is in `docs/design/record.md`.

### Running unattended

`record` exits 1 when it cannot write, and leaves restarting to a supervisor. Give it an absolute path to `bun`, since systemd's PATH is minimal (the mise shim keeps working across bun upgrades), and a restart delay of a few seconds, since GMO allows one subscribe per second per IP:

```ini
[Service]
WorkingDirectory=/opt/gmocoin-cli
ExecStart=/home/me/.local/share/mise/shims/bun /opt/gmocoin-cli/src/cli.ts record --out /srv/gmocoin
Restart=on-failure
RestartSec=10
```

## backtest

Replays trades through a strategy and prints a JSON result. The strategy is a file whose default export is a factory returning `{ onTrade?, onBook?, onFill?, onReject? }`; see `strategies/sma-cross.ts` for the file format (it only shows the shape: as a taker on every cross it loses most of its capital to fees) and `docs/design/backtest.md` for the contract.

`strategies/trend-ensemble.ts` is the first strategy that passes the test period (2025-01-01 to 2026-10-12); `docs/strategies.md` has the results and the strategies that failed.

Split a long range into a train period and a test period. The test period decides `pass` (PnL above zero and max drawdown at most 20%):

```sh
bun src/cli.ts backtest --strategy strategies/sma-cross.ts --from 2021-01-01 --to 2026-10-01 --split 2025-01-01
```

Replay recorded orderbooks and trades from `record` (books and trades are matched by time, so this only covers days you recorded):

```sh
bun src/cli.ts backtest --strategy strategies/sma-cross.ts --source record --data /srv/gmocoin --from 2026-10-13 --to 2026-10-14
```

- `--from` is inclusive and `--to` is exclusive. A `YYYY-MM-DD` value means UTC midnight; ISO 8601 with a zone is also accepted.
- `--source csv` (default) downloads the daily trade CSVs into `<data>/csv/<symbol>/` on first use. Set `GMOCOIN_TRADES_CSV_URL` to point at another mirror.
- `--capital` is the starting cash in JPY (default 10000). `--latency-ms` delays each order (default 0). `--slippage-bps` applies to market orders and is for `--source csv` only (default 0).
- A period with no market data exits 1. Otherwise the exit code is 0 whether or not the strategy passes.
