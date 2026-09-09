export type ErrorStage =
  | "input"
  | "config"
  | "auth"
  | "transport"
  | "protocol"
  | "journal"
  | "output"
  | "remote";

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

export class CliError extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: ErrorStage,
    message: string,
    public readonly diagnostics?: TransportDiagnostics,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function publicError(error: unknown): {
  ok: false;
  error: {
    code: string;
    stage: ErrorStage;
    message: string;
    diagnostics?: TransportDiagnostics;
  };
} {
  if (error instanceof CliError)
    return {
      ok: false,
      error: {
        code: error.code,
        stage: error.stage,
        message: error.message,
        ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      },
    };
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      stage: "protocol",
      message: "Operation failed without verifiable completion",
    },
  };
}

export function assertId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new CliError("INVALID_ID", "input", `${label} has an invalid format`);
  return value;
}

export function parseDate(value: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match)
    throw new CliError("INVALID_DATE", "input", `${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new CliError(
      "INVALID_DATE",
      "input",
      `${label} is not a calendar date`,
    );
  return value;
}

export function parsePositive(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new CliError(
      "INVALID_CASH",
      "input",
      "cash must be a finite positive number",
    );
  return number;
}
