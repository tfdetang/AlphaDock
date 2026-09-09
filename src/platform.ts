import type { CookieJar } from "tough-cookie";
import { loadCookieJar } from "./cookies.js";
import { SafeHttp } from "./http.js";
import { cookieFileFor, type Platform } from "./storage.js";
import { JoinQuantClient } from "./platforms/joinquant.js";
import { SuperMindClient } from "./platforms/supermind.js";

export interface BacktestRequest {
  strategyId: string;
  start: string;
  end: string;
  cash: number;
  frequency: "day" | "minute";
}
export interface RemoteClient {
  authStatus(): Promise<Record<string, unknown>>;
  createStrategy(
    name: string,
    code: string,
    onIdentity: (id: string) => Promise<void>,
  ): Promise<Record<string, unknown>>;
  submitBacktest(
    request: BacktestRequest,
    onIdentity: (id: string) => Promise<void>,
  ): Promise<Record<string, unknown>>;
  backtestStatus(id: string): Promise<Record<string, unknown>>;
  backtestResult(id: string): Promise<Record<string, unknown>>;
}
export async function clientFor(
  platform: Platform,
): Promise<{ client: RemoteClient; http: SafeHttp; jar: CookieJar }> {
  const jar = await loadCookieJar(await cookieFileFor(platform));
  const http = new SafeHttp(platform, jar);
  return {
    client:
      platform === "joinquant"
        ? new JoinQuantClient(http)
        : new SuperMindClient(http),
    http,
    jar,
  };
}
