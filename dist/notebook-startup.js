import { randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { load } from "cheerio";
import { CliError } from "./errors.js";
import { parseJson } from "./http.js";
import { createJournal, home, sha256, updateJournal, } from "./storage.js";
const ORIGIN = "https://supermind.10jqka.com.cn";
const HUB = `${ORIGIN}/notebook/hub/`;
const PROFILE_LABEL = "Python 3.8 升级Python环境";
function blocked(message) {
    throw new CliError("SERVER_START_BLOCKED", "auth", message);
}
async function serverState(http) {
    const response = await http.request(`${HUB}api/user`, {
        headers: { origin: ORIGIN, referer: `${HUB}spawn` },
        onRedirect: async () => blocked("Server state requires authentication or an unsupported redirect"),
    });
    if (response.status !== 200)
        blocked("Authenticated server state is unavailable");
    const model = parseJson(response.body);
    if (typeof model.name !== "string" ||
        !model.name ||
        model.name.length > 256 ||
        ![null, "spawn", "stop"].includes(model.pending))
        blocked("Server state schema is not recognized");
    const base = `${ORIGIN}/notebook/user/${encodeURIComponent(model.name)}/`;
    // The legacy model exposes server URL + pending; newer hubs also expose ready.
    let ready = model.pending === null &&
        model.server === `/notebook/user/${encodeURIComponent(model.name)}/`;
    if (model.servers && typeof model.servers === "object") {
        const server = model.servers[""];
        if (server && typeof server === "object" && "ready" in server)
            ready = ready && server.ready === true;
    }
    if (model.server !== null && typeof model.server !== "string")
        blocked("Server state schema is not recognized");
    return { name: model.name, base, ready, pending: model.pending !== null };
}
function startupForm(page, name) {
    if (page.status !== 200 || page.url.origin !== ORIGIN)
        blocked("Server startup page is not recognized");
    const allowed = new Set([
        "/notebook/hub/spawn",
        `/notebook/hub/spawn/${encodeURIComponent(name)}`,
    ]);
    if (!allowed.has(page.url.pathname))
        blocked("Only the default research server can be started");
    const $ = load(page.body);
    const text = $("body").text();
    if (/付费|计费|支付|充值|积分|购买|billing|payment|credit\s*card|captcha|验证码/i.test(text) ||
        $("input[type=password],select,textarea").length)
        blocked("Startup requires payment, resource selection or authentication");
    const forms = $("form");
    if (forms.length !== 1)
        blocked("Server startup form is ambiguous");
    const form = forms.first();
    if (form.attr("method")?.toUpperCase() !== "POST")
        blocked("Server startup form is unsupported");
    let target;
    try {
        target = new URL(form.attr("action") || page.url.href, page.url);
    }
    catch {
        return blocked("Server startup target is invalid");
    }
    if (target.origin !== ORIGIN ||
        target.pathname !== "/notebook/hub/spawn" ||
        target.username ||
        target.password)
        blocked("Server startup target is unsupported");
    const values = {};
    let profiles = 0;
    for (const element of form.find("input,button").toArray()) {
        const input = $(element), field = input.attr("name") || "", type = input.attr("type") || "";
        if (field === "profile" && type === "radio") {
            let label = input.closest("label");
            if (!label.length)
                label = $("label").filter((_, el) => $(el).attr("for") === input.attr("id"));
            if (label.text().replace(/\s+/g, " ").trim() === PROFILE_LABEL) {
                profiles++;
                const value = input.attr("value");
                if (!value || value.length > 256)
                    blocked("Python 3.8 profile is invalid");
                values.profile = value;
            }
        }
        else if (field === "_xsrf" &&
            type === "hidden" &&
            values._xsrf === undefined) {
            const value = input.attr("value");
            if (!value || value.length > 4096)
                blocked("Startup CSRF field is invalid");
            values._xsrf = value;
        }
        else if (!(type === "submit" && !field)) {
            blocked("Startup requires unsupported form options");
        }
    }
    if (profiles !== 1)
        blocked("An unambiguous approved Python 3.8 profile is required");
    // Do not forward next/redirect query parameters or any unapproved form fields.
    return { url: target.origin + target.pathname, values };
}
export async function startNotebookServer(platform, page, http, jar, controls = {}) {
    if (platform !== "supermind")
        blocked("Automatic startup is only verified for SuperMind");
    const polls = controls.polls ?? 24;
    if (!Number.isInteger(polls) || polls < 1 || polls > 24)
        throw new CliError("INVALID_POLL_LIMIT", "input", "Startup polling must be bounded");
    const pause = controls.pause ??
        (() => new Promise((resolve) => setTimeout(resolve, 5000)));
    let state = await serverState(http);
    // A pre-existing startup is only observed, never resubmitted or labelled Python 3.8.
    if (state.ready)
        return { base: state.base, report: { submitted: false, state: "ready" } };
    if (state.pending) {
        const identity = state.base;
        for (let i = 0; i < polls; i++) {
            await pause();
            state = await serverState(http);
            if (state.base !== identity)
                blocked("Server identity changed while waiting");
            if (state.ready)
                return {
                    base: state.base,
                    report: { submitted: false, state: "ready" },
                };
        }
        throw new CliError("SERVER_START_UNVERIFIED", "remote", "Existing server transition did not become ready; no startup was submitted");
    }
    const form = startupForm(page, state.name);
    const cookies = await jar.getCookies(form.url);
    const xsrf = cookies.find((cookie) => cookie.key === "_xsrf");
    const headers = {};
    if (xsrf) {
        try {
            headers["x-xsrftoken"] = decodeURIComponent(xsrf.value);
        }
        catch {
            blocked("Startup CSRF cookie is invalid");
        }
    }
    const targetHash = sha256(state.base);
    const journal = await createJournal("server-start", platform, {
        targetHash,
        profile: "python38",
        attempt: randomUUID(),
    });
    const locks = join(home(), "server-start-locks");
    await mkdir(locks, { recursive: true, mode: 0o700 });
    const lock = join(locks, targetHash);
    try {
        await mkdir(lock, { mode: 0o700 });
    }
    catch {
        throw new CliError("SERVER_START_UNVERIFIED", "journal", "A server startup is unresolved or its lock is unavailable; no retry was submitted");
    }
    // Retain the lock on all unknown outcomes, including crashes before/after POST.
    journal.value.stage = "checking";
    await updateJournal(journal.path, journal.value);
    try {
        // Another process may have completed and released its lock since our initial read.
        state = await serverState(http);
        if (sha256(state.base) !== targetHash)
            blocked("Server identity changed before startup");
        let submitted = false;
        if (!state.ready && !state.pending) {
            journal.value.stage = "starting";
            await updateJournal(journal.path, journal.value);
            await http
                .request("https://supermind.10jqka.com.cn/notebook/hub/spawn", {
                method: "POST",
                headers: {
                    ...headers,
                    origin: ORIGIN,
                    referer: `${HUB}spawn`,
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams(form.values).toString(),
                onRedirect: async ({ to, status }) => {
                    if (![302, 303].includes(status) ||
                        to.origin !== ORIGIN ||
                        !(/^\/notebook\/hub\/spawn-pending(?:\/|$)/.test(to.pathname) ||
                            to.pathname ===
                                `/notebook/user/${encodeURIComponent(state.name)}/`))
                        blocked("Startup returned an unapproved redirect; no redirect was followed");
                    // Stop before following any redirect: 307/308 must never replay the POST,
                    // and GET /spawn can itself start a server on some JupyterHub versions.
                    throw new CliError("SERVER_START_REDIRECT", "protocol", "Startup submitted; inspect state without following redirects");
                },
            })
                .then((response) => {
                if (![200, 201, 202].includes(response.status))
                    throw new CliError("SERVER_START_UNVERIFIED", "remote", "Server startup response was not accepted");
                const text = load(response.body)("body").text();
                if (/付费|计费|支付|充值|验证码|billing|payment|captcha/i.test(text))
                    blocked("Startup requires further confirmation");
            })
                .catch((error) => {
                if (!(error instanceof CliError) ||
                    error.code !== "SERVER_START_REDIRECT")
                    throw error;
            });
            submitted = true;
        }
        for (let i = 0; i < polls; i++) {
            if (!state.ready)
                state = await serverState(http);
            if (sha256(state.base) !== targetHash)
                blocked("Server identity changed during startup");
            if (state.ready) {
                journal.value.stage = submitted ? "ready" : "observed_ready";
                await updateJournal(journal.path, journal.value);
                await rmdir(lock);
                return {
                    base: state.base,
                    report: {
                        ...(submitted ? { profile: "python38" } : {}),
                        submitted,
                        state: "ready",
                        operationId: journal.value.operationId,
                    },
                };
            }
            if (i + 1 < polls)
                await pause();
        }
        throw new CliError("SERVER_START_UNVERIFIED", "remote", "Server startup did not become ready within the bounded polls");
    }
    catch (error) {
        // Generic safe message retains operation identity without leaking account paths or page content.
        throw new CliError("SERVER_START_UNVERIFIED", "remote", `Server startup outcome needs inspection; operation ${journal.value.operationId} was not retried`, error instanceof CliError ? error.diagnostics : undefined);
    }
}
//# sourceMappingURL=notebook-startup.js.map