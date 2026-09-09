export type ErrorStage = "input" | "config" | "auth" | "transport" | "protocol" | "journal" | "output" | "remote";
export interface TransportDiagnostics {
    operation: string;
    method?: string;
    hostname?: string;
    failurePhase: "request" | "response_body" | "channel";
    elapsedMs: number;
    timeoutMs: number;
    redirectHop?: number;
    causeCode: string;
    receivedBytes?: number;
    receivedMessages?: number;
    maxMessageBytes?: number;
    maxTotalBytes?: number;
    reply?: "ok" | "error" | "abort" | "unknown" | "missing";
    idle?: boolean;
    closeCode?: number;
}
export declare class CliError extends Error {
    readonly code: string;
    readonly stage: ErrorStage;
    readonly diagnostics?: TransportDiagnostics | undefined;
    constructor(code: string, stage: ErrorStage, message: string, diagnostics?: TransportDiagnostics | undefined);
}
export declare function publicError(error: unknown): {
    ok: false;
    error: {
        code: string;
        stage: ErrorStage;
        message: string;
        diagnostics?: TransportDiagnostics;
    };
};
export declare function assertId(value: string, label: string): string;
export declare function parseDate(value: string, label: string): string;
export declare function parsePositive(value: string): number;
