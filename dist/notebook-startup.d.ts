import type { CookieJar } from "tough-cookie";
import { type HttpResponse, SafeHttp } from "./http.js";
import { type Platform } from "./storage.js";
export interface ServerStartReport {
    profile?: "python38";
    submitted: boolean;
    state: "ready";
    operationId?: string;
}
export declare function startNotebookServer(platform: Platform, page: HttpResponse, http: SafeHttp, jar: CookieJar, controls?: {
    polls?: number;
    pause?: () => Promise<void>;
}): Promise<{
    base: string;
    report: ServerStartReport;
}>;
