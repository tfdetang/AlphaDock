export type ErrorStage = "input" | "config" | "auth" | "transport" | "protocol" | "journal" | "output" | "remote";
export declare class CliError extends Error {
    readonly code: string;
    readonly stage: ErrorStage;
    constructor(code: string, stage: ErrorStage, message: string);
}
export declare function publicError(error: unknown): {
    ok: false;
    error: {
        code: string;
        stage: ErrorStage;
        message: string;
    };
};
export declare function assertId(value: string, label: string): string;
export declare function parseDate(value: string, label: string): string;
export declare function parsePositive(value: string): number;
