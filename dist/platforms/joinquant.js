import * as cheerio from "cheerio";
import { CliError } from "../errors.js";
import { parseJson } from "../http.js";
const ROOT = "https://www.joinquant.com";
function first(value, keys) {
    if (!value || typeof value !== "object") return;
    for (const key of keys) {
        const found = value[key];
        if (typeof found === "string" || typeof found === "number")
            return String(found);
    }
}
function strategyIdFromEditUrl(url) {
    if (url.origin !== ROOT) return;
    const pathId =
        /^\/algorithm\/index\/edit\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/?$/.exec(
            url.pathname,
        )?.[1];
    if (pathId) return pathId;
    if (url.pathname !== "/algorithm/index/edit") return;
    const queryId = url.searchParams.get("algorithmId");
    return queryId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(queryId)
        ? queryId
        : undefined;
}
function formFromHtml(html) {
    const $ = cheerio.load(html);
    const form = $("form").first();
    if (!form.length)
        throw new CliError(
            "EDITOR_UNRECOGNIZED",
            "protocol",
            "Strategy editor form was not recognized",
        );
    const fields = {};
    let codeField = "";
    form.find("input[name], textarea[name], select[name]").each(
        (_, element) => {
            const node = $(element);
            const name = node.attr("name");
            if (
                !name ||
                node.is(":disabled") ||
                (["checkbox", "radio"].includes(node.attr("type") ?? "") &&
                    !node.is(":checked"))
            )
                return;
            if (node.is("textarea")) {
                fields[name] = node.text();
                if (
                    node.attr("id") === "code" ||
                    name.toLowerCase().includes("code")
                )
                    codeField = name;
            } else fields[name] = node.val()?.toString() ?? "";
        },
    );
    const token =
        /tokenData\s*=\s*\{\s*name:\s*["']([^"']+)["']\s*,\s*value:\s*["']([^"']+)["']/.exec(
            html,
        );
    if (!codeField || !fields["algorithm[algorithmId]"] || !token)
        throw new CliError(
            "EDITOR_UNRECOGNIZED",
            "protocol",
            "Strategy editor fields or CSRF token were not recognized",
        );
    return { fields, codeField, csrf: { [token[1]]: token[2] } };
}
export class JoinQuantClient {
    http;
    constructor(http) {
        this.http = http;
    }
    async editor(id) {
        const response = await this.http.request(
            `${ROOT}/algorithm/index/edit?${new URLSearchParams({ algorithmId: id })}`,
        );
        if (response.status !== 200)
            throw new CliError(
                "STRATEGY_READ_FAILED",
                "remote",
                "Strategy could not be read",
            );
        return formFromHtml(response.body);
    }
    async ajax(route, fields, csrf, extraHeaders) {
        if (
            "useCredit" in fields ||
            Object.keys(fields).some((key) => key.endsWith("[useCredit]"))
        )
            throw new CliError(
                "PAID_PARAMETER_DENIED",
                "input",
                "Credit use is not supported",
            );
        const response = await this.http.form(
            `${ROOT}${route}${route.includes("?") ? "&" : "?"}ajax=1`,
            { ...fields, ...csrf, ajax: "1" },
            {
                accept: "application/json",
                "x-requested-with": "XMLHttpRequest",
                origin: ROOT,
                ...extraHeaders,
            },
        );
        if (response.status !== 200)
            throw new CliError(
                "REMOTE_REJECTED",
                "remote",
                "JoinQuant request was rejected",
            );
        const envelope = parseJson(response.body);
        if (
            String(envelope.code) === "30000" ||
            ["50000", "50001"].includes(String(envelope.msg))
        )
            throw new CliError(
                "CHARGE_CONFIRMATION_REQUIRED",
                "remote",
                "JoinQuant requires a charge or credit confirmation; no continuation was attempted",
            );
        if (String(envelope.status) !== "0" || envelope.redirect)
            throw new CliError(
                "REMOTE_REJECTED",
                "remote",
                "JoinQuant returned an unsuccessful status",
            );
        return envelope.data;
    }
    async authStatus() {
        const response = await this.http.request(
            `${ROOT}/algorithm/index/list`,
        );
        const explicitLoggedIn = /\bg_isLogin\s*=\s*true\b/.test(response.body);
        const explicitLoggedOut =
            /\bg_isLogin\s*=\s*false\b|用户名或密码错误/.test(response.body);
        const strategyResource =
            /\/algorithm\/index\/(?:edit|new)(?:[/?"'])/.test(response.body);
        const logoutControl = /退出登录/.test(response.body);
        if (
            response.status !== 200 ||
            /\/user\/login(?:[/?#]|$)/.test(response.url.pathname) ||
            explicitLoggedOut ||
            !((explicitLoggedIn || logoutControl) && strategyResource)
        )
            throw new CliError(
                "AUTH_UNVERIFIED",
                "auth",
                "JoinQuant authentication was not verified",
            );
        return {
            ok: true,
            platform: "joinquant",
            authenticated: true,
            verifiedBy: "strategy-list",
        };
    }
    async createStrategy(name, code, onIdentity) {
        let preservedId;
        const created = await this.http.request(
            `${ROOT}/algorithm/index/new?restore=0&type=empty&baseCapital=100000`,
            {
                onRedirect: async ({ to }) => {
                    const id = strategyIdFromEditUrl(to);
                    if (id && id !== preservedId) {
                        await onIdentity(id);
                        preservedId = id;
                    }
                },
            },
        );
        const id =
            strategyIdFromEditUrl(created.url) ??
            /algorithmId["'=:\s]+([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/.exec(
                created.body,
            )?.[1];
        if (!id)
            throw new CliError(
                "CREATE_UNVERIFIED",
                "remote",
                "Strategy may have been created, but its ID was not verified; do not repeat automatically",
            );
        if (id !== preservedId) await onIdentity(id);
        const editor = formFromHtml(
            created.body.includes("<form")
                ? created.body
                : (
                      await this.http.request(
                          `${ROOT}/algorithm/index/edit?${new URLSearchParams({ algorithmId: id })}`,
                      )
                  ).body,
        );
        const fields = {
            ...editor.fields,
            "algorithm[name]": name,
            [editor.codeField]: Buffer.from(code).toString("base64"),
            encrType: "base64",
        };
        delete fields.useCredit;
        const saved = await this.ajax(
            "/algorithm/index/save",
            fields,
            editor.csrf,
        );
        const savedId =
            first(saved, ["algorithmId", "algorithm_id", "id"]) ?? id;
        if (savedId !== id) await onIdentity(savedId);
        const readback = await this.editor(savedId);
        const decoded = readback.fields[readback.codeField] ?? "";
        if (decoded.trim() !== code.trim())
            throw new CliError(
                "SAVE_UNVERIFIED",
                "remote",
                "Strategy code readback did not match; the strategy ID was retained",
            );
        return {
            platform: "joinquant",
            strategyId: savedId,
            codeReadback: true,
        };
    }
    async submitBacktest(request, onIdentity) {
        const running = await this.http.request(
            `${ROOT}/algorithm/backtest/all?status=1`,
        );
        const $ = cheerio.load(running.body);
        let count = 0;
        $("tr").each((_, row) => {
            if ($(row).text().includes("进行中")) count++;
        });
        if (count >= 2)
            throw new CliError(
                "CONCURRENCY_LIMIT",
                "remote",
                "JoinQuant already has two running backtests",
            );
        const editor = await this.editor(request.strategyId);
        const savedCode = editor.fields[editor.codeField] ?? "";
        const fields = {
            ...editor.fields,
            [editor.codeField]: Buffer.from(savedCode, "utf8").toString(
                "base64",
            ),
            encrType: "base64",
            "backtest[startTime]": request.start,
            "backtest[endTime]": request.end,
            "backtest[baseCapital]": String(request.cash),
            "backtest[frequency]": request.frequency,
            "backtest[pyVersion]": "3",
            "backtest[type]": "0",
        };
        delete fields.useCredit;
        const referer = `${ROOT}/algorithm/index/edit?${new URLSearchParams({ algorithmId: request.strategyId })}`;
        const data = await this.ajax(
            "/algorithm/index/build",
            fields,
            editor.csrf,
            {
                referer,
            },
        );
        const id = first(data, ["backtestId", "backtest_id", "id"]);
        if (!id)
            throw new CliError(
                "SUBMISSION_UNVERIFIED",
                "remote",
                "Backtest submission outcome is unknown; do not resubmit automatically",
            );
        await onIdentity(id);
        return {
            platform: "joinquant",
            strategyId: request.strategyId,
            backtestId: id,
            accepted: true,
            completed: false,
            codeReadback: true,
        };
    }
    async resultContext(publicId) {
        const page = await this.http.request(
            `${ROOT}/algorithm/backtest/detail?${new URLSearchParams({ backtestId: publicId })}`,
        );
        const $ = cheerio.load(page.body);
        const internalId = $("#backtestId").attr("value") || publicId;
        const token =
            /tokenData\s*=\s*\{\s*name:\s*["']([^"']+)["']\s*,\s*value:\s*["']([^"']+)["']/.exec(
                page.body,
            );
        if (!token)
            throw new CliError(
                "RESULT_UNVERIFIED",
                "protocol",
                "Backtest result CSRF fields were not recognized",
            );
        const parameters = {};
        for (const name of [
            "startDate",
            "endDate",
            "baseCapital",
            "initialCash",
            "frequency",
        ]) {
            const element = $(`#${name}`).first();
            const value = element.attr("value") ?? element.text().trim();
            if (value) parameters[name] = value;
        }
        return { internalId, parameters, csrf: { [token[1]]: token[2] } };
    }
    async resultCall(route, id, offset = 0, cachedContext) {
        const context = cachedContext ?? (await this.resultContext(id));
        const referer = `${ROOT}/algorithm/backtest/detail?${new URLSearchParams({ backtestId: id })}`;
        return this.ajax(
            `${route}?${new URLSearchParams({ backtestId: context.internalId, offset: String(offset) })}`,
            {},
            context.csrf,
            { referer },
        );
    }
    async backtestStatus(id) {
        const data = await this.resultCall("/algorithm/backtest/result", id);
        const state = first(data, ["state", "status"]);
        const normalized =
            state === "2"
                ? "success"
                : state === "3"
                  ? "failed"
                  : ["0", "1"].includes(state ?? "")
                    ? "running"
                    : "unknown";
        if (normalized === "unknown")
            throw new CliError(
                "STATUS_UNKNOWN",
                "protocol",
                "JoinQuant returned an unknown backtest state",
            );
        return {
            platform: "joinquant",
            backtestId: id,
            state: normalized,
            rawState: state,
        };
    }
    async backtestResult(id) {
        const status = await this.backtestStatus(id);
        if (status.state !== "success" && status.state !== "failed")
            return { ...status, verified: false };
        const context = await this.resultContext(id);
        const [rawResult, metrics, errors, logs] = await Promise.all([
            this.resultCall("/algorithm/backtest/result", id, 0, context),
            this.resultCall("/algorithm/backtest/stats", id, 0, context),
            this.resultCall("/algorithm/backtest/error", id, 0, context),
            this.resultCall("/algorithm/backtest/log", id, 0, context),
        ]);
        const verified =
            status.state === "success" &&
            !!metrics &&
            typeof metrics === "object" &&
            Object.keys(metrics).length > 0;
        if (status.state === "success" && !verified)
            throw new CliError(
                "RESULT_UNVERIFIED",
                "protocol",
                "Terminal status lacked verified risk metrics",
            );
        let trades = null;
        let transactionMeta;
        if (status.state === "success") {
            const transactionData = await this.resultCall(
                "/algorithm/backtest/transactionInfo",
                id,
                0,
                context,
            );
            if (!transactionData || typeof transactionData !== "object")
                throw new CliError(
                    "RESULT_UNVERIFIED",
                    "protocol",
                    "Terminal status lacked verified transaction records",
                );
            const dataObj = transactionData;
            const rawList = dataObj.transaction;
            if (!Array.isArray(rawList))
                throw new CliError(
                    "RESULT_UNVERIFIED",
                    "protocol",
                    "Terminal status lacked verified transaction records",
                );
            for (const row of rawList) {
                if (!row || typeof row !== "object" || Array.isArray(row))
                    throw new CliError(
                        "RESULT_UNVERIFIED",
                        "protocol",
                        "Transaction record has an unexpected shape",
                    );
                const record = row;
                const stock = record.stock;
                const amount = record.amount;
                const price = record.price;
                if (
                    typeof stock !== "string" ||
                    !stock.trim() ||
                    (typeof amount !== "string" &&
                        typeof amount !== "number") ||
                    (typeof price !== "string" && typeof price !== "number")
                )
                    throw new CliError(
                        "RESULT_UNVERIFIED",
                        "protocol",
                        "Transaction record lacks required trade fields",
                    );
            }
            trades = rawList;
            transactionMeta = {
                returnedCount: rawList.length,
                ...(dataObj.max === undefined ? {} : { max: dataObj.max }),
                ...(dataObj.status === undefined
                    ? {}
                    : { status: dataObj.status }),
            };
        }
        return {
            ...status,
            verified,
            parameters: context.parameters,
            metrics,
            trades,
            errorLogs: errors,
            strategyLogs: logs,
            rawResult,
            bounds: {
                offsetsRead: [0],
                maxResponseBytes: 4_000_000,
                ...(transactionMeta ? { transactionMeta } : {}),
            },
        };
    }
}
//# sourceMappingURL=joinquant.js.map
