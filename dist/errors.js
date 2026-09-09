export class CliError extends Error {
    code;
    stage;
    constructor(code, stage, message) {
        super(message);
        this.code = code;
        this.stage = stage;
        this.name = "CliError";
    }
}
export function publicError(error) {
    if (error instanceof CliError)
        return {
            ok: false,
            error: { code: error.code, stage: error.stage, message: error.message },
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
export function assertId(value, label) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
        throw new CliError("INVALID_ID", "input", `${label} has an invalid format`);
    return value;
}
export function parseDate(value, label) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        throw new CliError("INVALID_DATE", "input", `${label} must use YYYY-MM-DD`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day)
        throw new CliError("INVALID_DATE", "input", `${label} is not a calendar date`);
    return value;
}
export function parsePositive(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0)
        throw new CliError("INVALID_CASH", "input", "cash must be a finite positive number");
    return number;
}
//# sourceMappingURL=errors.js.map