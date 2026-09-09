export type Platform = "joinquant" | "supermind";
interface Config {
    platforms?: Partial<
        Record<
            Platform,
            {
                cookieFile: string;
            }
        >
    >;
}
export interface Journal {
    operationId: string;
    kind: string;
    platform: Platform;
    stage: string;
    createdAt: string;
    parameters: Record<string, unknown>;
    sourceSha256?: string;
    strategyId?: string;
    strategyIds?: string[];
    backtestId?: string;
}
export declare function home(): string;
export declare function configPath(): string;
export declare function atomicPrivateWrite(
    path: string,
    data: string,
): Promise<void>;
export declare function readConfig(): Promise<Config>;
export declare function configure(
    platform: Platform,
    cookieFile: string,
): Promise<void>;
export declare function cookieFileFor(platform: Platform): Promise<string>;
export declare function sha256(value: string): string;
export declare function createJournal(
    kind: string,
    platform: Platform,
    parameters: Record<string, unknown>,
    source?: string,
): Promise<{
    path: string;
    value: Journal;
}>;
export declare function updateJournal(
    path: string,
    value: Journal,
): Promise<void>;
export declare function exclusiveOutput(
    path: string,
    value: unknown,
): Promise<void>;
export declare function assertOutputAvailable(path?: string): Promise<void>;
