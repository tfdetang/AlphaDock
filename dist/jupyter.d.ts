import type { CookieJar } from "tough-cookie";
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
export declare function notebookExecutionReport(
    platform: Platform,
    kernelId: string,
    temporary: boolean,
    execution: ExecutionResult,
    cleanedUp?: boolean,
): NotebookExecutionReport;
export interface NotebookSession {
    base: string;
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
    once(event: "open" | "error" | "close", listener: () => void): this;
    on(event: "message", listener: (raw: Buffer) => void): this;
    send(data: string): void;
    close(): void;
}
export type SocketFactory = (
    url: URL,
    options: {
        headers: Record<string, string>;
        handshakeTimeout: number;
        maxPayload: number;
    },
) => SocketLike;
export declare function consumeExecutionMessage(
    result: ExecutionResult,
    message: JupyterMessage,
    messageId: string,
): boolean;
export declare function notebookSession(
    platform: Platform,
    http: SafeHttp,
): Promise<NotebookSession>;
export declare function createKernel(
    session: NotebookSession,
    http: SafeHttp,
    jar: CookieJar,
): Promise<string>;
export declare function deleteKernel(
    session: NotebookSession,
    id: string,
    http: SafeHttp,
    jar: CookieJar,
): Promise<boolean>;
export declare function executeKernel(
    session: NotebookSession,
    kernelId: string,
    code: string,
    jar: CookieJar,
    timeoutMs?: number,
    maxBytes?: number,
    socketFactory?: SocketFactory,
): Promise<ExecutionResult>;
