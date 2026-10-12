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
