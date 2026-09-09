import { SafeHttp } from "../http.js";
import type { BacktestRequest, RemoteClient } from "../platform.js";
export declare class SuperMindClient implements RemoteClient {
    private readonly http;
    constructor(http: SafeHttp);
    private call;
    authStatus(): Promise<Record<string, unknown>>;
    createStrategy(name: string, code: string, onIdentity: (id: string) => Promise<void>): Promise<Record<string, unknown>>;
    submitBacktest(request: BacktestRequest, onIdentity: (id: string) => Promise<void>): Promise<Record<string, unknown>>;
    backtestStatus(id: string): Promise<Record<string, unknown>>;
    backtestResult(id: string): Promise<Record<string, unknown>>;
}
