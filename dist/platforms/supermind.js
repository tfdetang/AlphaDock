import { CliError } from "../errors.js";
import { parseJson } from "../http.js";
const ROOT = "https://quant.10jqka.com.cn";
function idOf(value, keys) {
    if (!value || typeof value !== "object")
        return;
    for (const key of keys) {
        const item = value[key];
        if (typeof item === "string" || typeof item === "number")
            return String(item);
    }
}
function objectResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new CliError("RESPONSE_INVALID", "protocol", "SuperMind result has an unexpected shape");
    return value;
}
export class SuperMindClient {
    http;
    constructor(http) {
        this.http = http;
    }
    async call(route, fields) {
        const response = await this.http.form(`${ROOT}${route}`, fields, {
            accept: "application/json",
            origin: ROOT,
            referer: `${ROOT}/view/study-index.html`,
            "x-requested-with": "XMLHttpRequest",
        });
        if (response.status !== 200)
            throw new CliError("REMOTE_REJECTED", "remote", "SuperMind request was rejected");
        if (/消耗积分|扣除积分|付费确认|充值后|购买套餐/.test(response.body))
            throw new CliError("CHARGE_CONFIRMATION_REQUIRED", "remote", "SuperMind requires a charge confirmation; no continuation was attempted");
        const envelope = parseJson(response.body);
        if (envelope.errorcode !== 0)
            throw new CliError("REMOTE_REJECTED", "remote", "SuperMind returned an unsuccessful status");
        return envelope.result;
    }
    async authStatus() {
        const result = objectResult(await this.call("/platform/user/getauthdata", {}));
        return {
            ok: true,
            platform: "supermind",
            authenticated: true,
            verifiedBy: "getauthdata",
            ...(typeof result.engine_enabled === "boolean"
                ? { engineEnabled: result.engine_enabled }
                : {}),
        };
    }
    async createStrategy(name, code, onIdentity) {
        const created = await this.call("/platform/algorithms/add/", {
            folder_id: -1,
            algoName: name,
            stock_market: "STOCK",
            algoCode: code,
        });
        const id = idOf(created, ["_id", "algorithm_id", "algo_id", "id"]);
        if (!id)
            throw new CliError("CREATE_UNVERIFIED", "remote", "Strategy creation outcome is unknown; do not retry automatically");
        await onIdentity(id);
        const readback = objectResult(await this.call("/platform/algorithms/queryinfo/", { algoId: id }));
        if (readback.algo_code !== code)
            throw new CliError("SAVE_UNVERIFIED", "remote", "Strategy code readback did not match; the strategy ID was retained");
        return { platform: "supermind", strategyId: id, codeReadback: true };
    }
    async submitBacktest(request, onIdentity) {
        const strategy = objectResult(await this.call("/platform/algorithms/queryinfo/", {
            algoId: request.strategyId,
        }));
        const code = strategy.algo_code;
        if (typeof code !== "string")
            throw new CliError("CODE_READBACK_FAILED", "protocol", "Saved strategy code could not be read");
        const submitted = await this.call("/platform/backtest/run/", {
            algoId: request.strategyId,
            code,
            frequency: request.frequency === "day" ? "DAILY" : "MINUTE",
            beginDate: request.start,
            endDate: request.end,
            capitalBase: request.cash,
            style: "NORMAL",
            runEnv: "py38",
            breakPoints: "",
        });
        const id = idOf(submitted, ["backtest_id", "backtestid", "_id", "id"]);
        if (!id)
            throw new CliError("SUBMISSION_UNVERIFIED", "remote", "Backtest submission outcome is unknown; do not resubmit automatically");
        await onIdentity(id);
        return {
            platform: "supermind",
            strategyId: request.strategyId,
            backtestId: id,
            accepted: true,
            completed: false,
            codeReadback: true,
        };
    }
    async backtestStatus(id) {
        const info = objectResult(await this.call("/platform/backtest/queryinfo/", { backTestId: id }));
        const returned = idOf(info, ["backtest_id", "_id", "id"]);
        if (returned && returned !== id)
            throw new CliError("IDENTITY_MISMATCH", "protocol", "SuperMind returned a different backtest ID");
        const raw = String(info.status ?? "").toUpperCase();
        const state = raw === "SUCCESS"
            ? "success"
            : ["FAIL", "FAILED", "CANCEL", "CANCELLED"].includes(raw)
                ? "failed"
                : ["COMPILING", "RUNNING", "WAITING", "PENDING", "QUEUED"].includes(raw)
                    ? "running"
                    : "unknown";
        if (state === "unknown")
            throw new CliError("STATUS_UNKNOWN", "protocol", "SuperMind returned an unknown backtest state");
        const parameters = Object.fromEntries(["begin_date", "end_date", "capital_base", "frequency", "run_env"]
            .filter((key) => key in info)
            .map((key) => [key, info[key]]));
        return {
            platform: "supermind",
            backtestId: id,
            state,
            rawState: raw,
            parameters,
        };
    }
    async backtestResult(id) {
        const status = await this.backtestStatus(id);
        if (status.state !== "success" && status.state !== "failed")
            return { ...status, verified: false };
        if (status.state === "failed") {
            const [errorLogs, strategyLogs] = await Promise.all([
                this.call("/platform/backtest/backtestlog/", {
                    backTestId: id,
                    page: 1,
                    num: 100,
                    type: "ERROR",
                }),
                this.call("/platform/backtest/backtestlog/", {
                    backTestId: id,
                    page: 1,
                    num: 100,
                }),
            ]);
            return {
                ...status,
                verified: false,
                metrics: null,
                trades: null,
                errorLogs,
                strategyLogs,
                bounds: { page: 1, pageSize: 100, maxResponseBytes: 4_000_000 },
            };
        }
        const [metrics, trades, errorLogs, strategyLogs] = await Promise.all([
            this.call("/platform/backtest/backtestperformance", { backTestId: id }),
            this.call("/platform/backtest/tradelog", {
                backTestId: id,
                page: 1,
                num: 100,
            }),
            this.call("/platform/backtest/backtestlog/", {
                backTestId: id,
                page: 1,
                num: 100,
                type: "ERROR",
            }),
            this.call("/platform/backtest/backtestlog/", {
                backTestId: id,
                page: 1,
                num: 100,
            }),
        ]);
        const verified = status.state === "success" &&
            !!metrics &&
            typeof metrics === "object" &&
            !Array.isArray(metrics) &&
            Object.keys(metrics).length > 0;
        if (status.state === "success" && !verified)
            throw new CliError("RESULT_UNVERIFIED", "protocol", "Terminal status lacked verified performance metrics");
        return {
            ...status,
            verified,
            metrics,
            trades,
            errorLogs,
            strategyLogs,
            bounds: { page: 1, pageSize: 100, maxResponseBytes: 4_000_000 },
        };
    }
}
//# sourceMappingURL=supermind.js.map