import { join } from "node:path";
import type { Channel } from "./record.ts";

export function recordPath(outDir: string, channel: Channel, symbol: string, at: Date): string {
  return join(outDir, channel, symbol, `${at.toISOString().slice(0, 10)}.jsonl.gz`);
}
