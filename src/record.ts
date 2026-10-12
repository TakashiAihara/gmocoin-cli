export type Channel = "orderbooks" | "trades";

export const CHANNELS: readonly Channel[] = ["orderbooks", "trades"];

export const DEFAULT_PUBLIC_WS_URL = "wss://api.coin.z.com/ws/public/v1";

export type Subscription = { channel: Channel; symbol: string };

export type RecorderOptions = {
  url: string;
  subscriptions: Subscription[];
  outDir: string;
  subscribeIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  idleTimeoutMs?: number;
  statsIntervalMs?: number;
  flushIntervalMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  onFatal?: (err: Error) => void;
};

export type Recorder = {
  stop(): Promise<void>;
};

export function startRecorder(_opts: RecorderOptions): Recorder {
  throw new Error("not implemented");
}
