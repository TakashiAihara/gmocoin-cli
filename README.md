# gmocoin-cli
CLI for the GMO Coin API (market data recording, backtesting, trading)

## Status

- `record`, `backtest`, `replay` and `stream` work without an API key. `balance`, `order`, `cancel`, `orders` and `executions` call the Private API; they are tested against a fake server, and have not yet been run against a real account.
- This is an unofficial tool, not affiliated with GMO Coin. Backtest results are not investment advice.

## Install

Requires [Bun](https://bun.sh) 1.4 or later (`.mise.toml` pins the version used in development).


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
- `--capital` is the starting cash in JPY (default 10000). `--latency-ms` delays each order (default 0). `--slippage-bps` applies to market orders and is for `--source csv` only (default 0). `--maker-fee-bps` and `--taker-fee-bps` set the fees on limit and market fills (default -1 and 5, GMO Coin spot; a negative fee is a rebate). `--warmup-days` feeds the strategy this many days of CSV trades before each period without trading (default 0); strategies with long lookbacks such as `strategies/trend-ensemble.ts` need it. Each period also reports `takerSlippageBps`, how much worse market fills were than the trade price the order was decided on.
- A period with no market data exits 1. Otherwise the exit code is 0 whether or not the strategy passes.

## replay

Prints market data in `[from, to)` as JSONL on stdout, one trade or order book per line in time order (recorded books can step back by a few ms), for tools that evaluate strategies outside this repo. It reads the same inputs as `backtest`:

```sh
gmocoin replay --from 2026-10-12 --to 2026-10-13
gmocoin replay --source record --data /srv/gmocoin --from 2026-10-12 --to 2026-10-13
```

Each line is `{"kind":"trade","t":<ms>,"side":"BUY"|"SELL","price":<n>,"size":<n>}` or `{"kind":"book","t":<ms>,"asks":[{"price":<n>,"size":<n>}],"bids":[...]}`. A range with no data exits 3; other failures exit 1. The spec is in `docs/design/replay.md`.

## stream

Prints live public WebSocket trades as JSONL on stdout, in the same format as `replay`, until it is stopped. No API key is needed.

```sh
gmocoin stream                         # BTC trades
gmocoin stream --channel orderbooks    # BTC order books
```

Trades are subscribed with `TAKER_ONLY`, as in `record`. With `--channel trades` (the default), order books are subscribed too and used only to tell a quiet market from a dead connection: trades alone can be silent for more than a minute. A dropped connection is reconnected with a backoff, and each drop is logged on stderr as one line. A rejected subscribe is treated as a drop, so every channel is subscribed again, except `ERR-5106` (invalid symbol or channel), which exits 1 because reconnecting cannot fix it. Trades that arrive while reconnecting are lost; the first message after a reconnect is preceded by one line `{"kind":"gap","t":<ms>,"since":<ms>}`, where `since` is when the drop was noticed and `t` is when data came back. While messages arrive (on any subscribed channel, within the last 60 seconds), `{"kind":"alive","t":<ms>}` is printed every 30 seconds; it stops while disconnected or silent, so a reader can tell a quiet market from a dead feed. `t` in gap and alive lines is the local clock.

## Private API

`balance`, `order`, `cancel`, `orders` and `executions` call the GMO Coin Private API. The key and secret are read from `GMOCOIN_API_KEY` and `GMOCOIN_API_SECRET`; `GMOCOIN_PRIVATE_API_URL` overrides the endpoint (default `https://api.coin.z.com/private`). The output contract is the one `soba` depends on (soba `docs/design/live.md`).

```sh
gmocoin balance                                     # [{"symbol":"JPY","amount":10000,"available":10000},...]
gmocoin order --client-order-id a1 --side BUY --type market --size 0.001   # {"orderId":"..."}
gmocoin order --client-order-id a2 --side SELL --type limit --size 0.001 --price 15000000 --post-only
gmocoin cancel 123456789                            # {"orderId":"123456789"}
gmocoin orders                                      # active orders
gmocoin executions --order-id 123456789             # fills of one order, timestamps in ms
gmocoin executions --client-order-id a1             # the same, by the id the caller chose
```

- `--symbol` defaults to `BTC`. `order` takes spot symbols only (no `_`, so not leverage symbols such as `BTC_JPY`). Sizes and prices are sent as written. `--post-only` sends `timeInForce=SOK`.
- stdout is one JSON value. Prices, sizes and fees are numbers; ids are strings. An active market order has `price: null`.
- `order` requires `--client-order-id` (1 to 36 letters or digits, unique in the account). A reused id is refused with `ERR-915` (exit 4), which means an order with that id already exists; an id whose order was rejected may be reused (GMO API docs, `/v1/order`). `order` and `cancel` send exactly one request and never retry. A failure after sending may or may not have placed the order; look it up with `executions --client-order-id` and `orders` (which carries `clientOrderId`).
- Exit codes: 2 when the key or secret is missing (nothing is sent), 4 when the exchange rejects the request (stderr has `{"status":<n>,"messages":[{"message_code":"ERR-...","message_string":"..."}]}`), 1 for a network failure or an unexpected response.

## Develop

```bash
bun install
bun run check   # typecheck, lint, format check and tests
```

Design specs are in `docs/design/`, strategy results in `docs/strategies.md`, the paper trading plan in `docs/paper-trading.md`, and the terms they use in `docs/glossary.md`.

## License

[MIT](LICENSE)
