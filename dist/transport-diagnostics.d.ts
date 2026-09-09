import type { TransportDiagnostics } from "./errors.js";
export declare function safeCauseCode(error: unknown): string;
export declare function transportDiagnostics(error: unknown, url: URL, method: string, startedAt: number, redirectHop: number, failurePhase: TransportDiagnostics["failurePhase"]): TransportDiagnostics;
