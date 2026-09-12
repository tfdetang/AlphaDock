import type { CookieJar } from "tough-cookie";
import { type ServerStartReport } from "./notebook-startup.js";
import { SafeHttp } from "./http.js";
import type { Platform } from "./storage.js";
export interface ExecutionResult {
    state: "completed" | "failed";
    reply: string;
    idle: boolean;
    streams: Array<{
        name: string;
        text: string;
    }>;
    displays: Array<{
        mimeTypes: string[];
        text?: string;
    }>;
    errors: Array<{
        name: string;
        value: string;
    }>;
}
export interface NotebookExecutionReport {
    ok: boolean;
    platform: Platform;
    kernelId: string;
    temporary: boolean;
    cleanedUp?: boolean;
    execution: ExecutionResult;
}
export declare function notebookExecutionReport(platform: Platform, kernelId: string, temporary: boolean, execution: ExecutionResult, cleanedUp?: boolean): NotebookExecutionReport;
export interface NotebookSession {
    base: string;
    serverStart?: ServerStartReport;
    kernels: Array<{
        id: string;
        name?: string;
        execution_state?: string;
    }>;
    defaultKernel?: string;
}
export interface JupyterMessage {
    parent_header?: {
        msg_id?: unknown;
    };
    header?: {
        msg_type?: unknown;
    };
    msg_type?: unknown;
    content?: Record<string, unknown>;
}
interface SocketLike {
    once(event: "open", listener: () => void): this;
    once(event: "error", listener: (error?: unknown) => void): this;
    once(event: "close", listener: (code?: number) => void): this;
    on(event: "message", listener: (raw: Buffer) => void): this;
    send(data: string): void;
    close(): void;
}
export type SocketFactory = (url: URL, options: {
    headers: Record<string, string>;
    handshakeTimeout: number;
    maxPayload: number;
}) => SocketLike;
export declare function consumeExecutionMessage(result: ExecutionResult, message: JupyterMessage, messageId: string): boolean;
export declare function notebookSession(platform: Platform, http: SafeHttp, options?: {
    startServer?: boolean;
    jar?: CookieJar;
}): Promise<NotebookSession>;
export declare function createKernel(session: NotebookSession, http: SafeHttp, jar: CookieJar): Promise<string>;
export declare function deleteKernel(session: NotebookSession, id: string, http: SafeHttp, jar: CookieJar): Promise<boolean>;
export declare const DEFAULT_NOTEBOOK_BYTES = 1000000;
export declare const MAX_NOTEBOOK_BYTES = 64000000;
export declare function notebookByteLimit(value: string | number): number;
export declare function executeKernel(session: NotebookSession, kernelId: string, code: string, jar: CookieJar, timeoutMs?: number, maxBytes?: number, socketFactory?: SocketFactory, maxMessageBytes?: number): Promise<ExecutionResult>;
export {};
