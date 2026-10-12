import { join } from "node:path";
import type { Channel } from "./record.ts";

export function recordPath(
  outDir: string,
  channel: Channel,
  symbol: string,
  firstAt: Date,
): string {
  return join(outDir, channel, symbol, `${firstAt.toISOString().replace(/:/g, "")}.jsonl.gz`);
}
