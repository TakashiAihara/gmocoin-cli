#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import { CHANNELS, DEFAULT_PUBLIC_WS_URL, startRecorder, type Channel } from "./record.ts";

function collect<T>(parse: (v: string) => T) {
  return (value: string, prev: T[] = []) => [...prev, parse(value)];
}

function parseSymbol(v: string): string {
  if (!/^[A-Z0-9_]+$/.test(v)) {
    throw new InvalidArgumentError("symbol must match ^[A-Z0-9_]+$");
  }
  return v;
}

function parseChannel(v: string): Channel {
  const channel = CHANNELS.find((c) => c === v);
  if (!channel) throw new InvalidArgumentError(`channel must be one of ${CHANNELS.join(", ")}`);
  return channel;
}

const program = new Command().name("gmocoin").description("CLI for the GMO Coin API");

program
  .command("record")
  .description("record Public WebSocket orderbooks and trades as gzip JSONL")
  .option("--symbol <symbol>", "symbol to record, repeatable (default BTC)", collect(parseSymbol))
  .option(
    "--channel <channel>",
    "channel to record, repeatable (default orderbooks and trades)",
    collect(parseChannel),
  )
  .option("--out <dir>", "output directory", "./data")
  .action((opts: { symbol?: string[]; channel?: Channel[]; out: string }) => {
    const symbols = opts.symbol ?? ["BTC"];
    const channels = opts.channel ?? CHANNELS;
    const recorder = startRecorder({
      url: process.env.GMOCOIN_PUBLIC_WS_URL || DEFAULT_PUBLIC_WS_URL,
      outDir: opts.out,
      subscriptions: channels.flatMap((channel) => symbols.map((symbol) => ({ channel, symbol }))),
      onFatal: () => void exitAfterStop(1),
    });

    async function exitAfterStop(code: number) {
      try {
        await recorder.stop();
      } catch (e) {
        console.error(e);
      }
      process.exit(code);
    }

    process.on("SIGINT", () => void exitAfterStop(0));
    process.on("SIGTERM", () => void exitAfterStop(0));
    const crash = (err: unknown) => {
      console.error(err);
      void exitAfterStop(1);
    };
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
  });

await program.parseAsync();
