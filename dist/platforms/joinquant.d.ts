import { SafeHttp } from "../http.js";
import type { BacktestRequest, RemoteClient } from "../platform.js";
export declare class JoinQuantClient implements RemoteClient {
    private readonly http;
    constructor(http: SafeHttp);
    private editor;
    private ajax;
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
    private resultContext;
    private resultCall;
    backtestStatus(id: string): Promise<Record<string, unknown>>;
    backtestResult(id: string): Promise<Record<string, unknown>>;
}
