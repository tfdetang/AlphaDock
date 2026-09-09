import type { CookieJar } from "tough-cookie";
import { SafeHttp } from "./http.js";
import { type Platform } from "./storage.js";
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
export declare function clientFor(platform: Platform): Promise<{
    client: RemoteClient;
    http: SafeHttp;
    jar: CookieJar;
}>;
