# gmocoin-cli
CLI for the GMO Coin API (market data recording, backtesting, trading)

## Install

```bash
bun install
bun run install-bin   # links ./src/cli.ts to ~/.local/bin/gmocoin
```

## record

Records the public WebSocket `orderbooks` and `trades` channels as gzip JSONL, one file per channel, symbol and UTC day. No API key is needed and no order is placed.

```bash
gmocoin record                                        # BTC orderbooks and trades into ./data
gmocoin record --symbol BTC --symbol BTC_JPY --out /srv/gmocoin
zcat data/orderbooks/BTC/2026-10-12.jsonl.gz | head -1
```

Each line is `{"recv_at":"<receive time, UTC>","msg":<the message exactly as received>}`. The spec is in `docs/design/record.md`.
