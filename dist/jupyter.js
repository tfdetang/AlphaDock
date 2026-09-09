import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { CliError } from "./errors.js";
import { parseJson } from "./http.js";
export function notebookExecutionReport(
    platform,
    kernelId,
    temporary,
    execution,
    cleanedUp,
) {
    return {
        ok:
            execution.state === "completed" &&
            (!temporary || cleanedUp === true),
        platform,
        kernelId,
        temporary,
        ...(temporary ? { cleanedUp: cleanedUp === true } : {}),
        execution,
    };
}
export function consumeExecutionMessage(result, message, messageId) {
    if (message.parent_header?.msg_id !== messageId) return false;
    const type = message.header?.msg_type ?? message.msg_type;
    const content = message.content ?? {};
    if (type === "execute_reply")
        result.reply = String(content.status ?? "unknown");
    else if (type === "status" && content.execution_state === "idle")
        result.idle = true;
    else if (type === "stream")
        result.streams.push({
            name: String(content.name ?? "stdout"),
            text: String(content.text ?? "").slice(0, 100_000),
        });
    else if (type === "error")
        result.errors.push({
            name: String(content.ename ?? "Error"),
            value: String(content.evalue ?? "").slice(0, 10_000),
        });
    else if (type === "display_data" || type === "execute_result") {
        const data =
            content.data && typeof content.data === "object"
                ? content.data
                : {};
        const plain = data["text/plain"];
        result.displays.push({
            mimeTypes: Object.keys(data),
            ...(typeof plain === "string"
                ? { text: plain.slice(0, 100_000) }
                : {}),
        });
    }
    return Boolean(result.reply && result.idle);
}
function userBase(platform, url) {
    const pattern =
        platform === "joinquant"
            ? /^(\/user\/[^/]+\/)/
            : /^(\/notebook\/user\/[^/]+\/)/;
    const found = pattern.exec(url.pathname);
    return found ? `${url.origin}${found[1]}` : undefined;
}
export async function notebookSession(platform, http) {
    let response;
    if (platform === "joinquant") {
        const bootstrap = await http.request(
            "https://www.joinquant.com/default/research/redirect",
            { redirects: 0 },
        );
        const mob = /\bvar\s+mob\s*=\s*["']([^"']+)["']/.exec(
            bootstrap.body,
        )?.[1];
        const token = /\bvar\s+sessionId\s*=\s*["']([^"']+)["']/.exec(
            bootstrap.body,
        )?.[1];
        if (!mob || !token)
            throw new CliError(
                "AUTH_UNVERIFIED",
                "auth",
                "JoinQuant research bootstrap was not recognized",
            );
        response = await http.form("https://www.joinquant.com/hub/login", {
            username: mob,
            token,
        });
    } else
        response = await http.request(
            "https://supermind.10jqka.com.cn/notebook/hub/login",
        );
    if (response.url.pathname.includes("/spawn"))
        throw new CliError(
            "SERVER_NOT_READY",
            "auth",
            "Notebook server is stopped; automatic startup is not supported",
        );
    const base = userBase(platform, response.url);
    if (!base)
        throw new CliError(
            "AUTH_UNVERIFIED",
            "auth",
            "Authenticated notebook base was not verified",
        );
    const kernelsResponse = await http.request(`${base}api/kernels`);
    if (kernelsResponse.status !== 200)
        throw new CliError(
            "NOTEBOOK_LIST_FAILED",
            "remote",
            "Existing kernels could not be listed",
        );
    const kernelsValue = JSON.parse(kernelsResponse.body);
    if (!Array.isArray(kernelsValue))
        throw new CliError(
            "RESPONSE_INVALID",
            "protocol",
            "Kernel list has an unexpected shape",
        );
    const specsResponse = await http.request(`${base}api/kernelspecs`);
    const specs = parseJson(specsResponse.body);
    return {
        base,
        kernels: kernelsValue.filter(
            (v) => !!v && typeof v === "object" && typeof v.id === "string",
        ),
        ...(typeof specs.default === "string"
            ? { defaultKernel: specs.default }
            : {}),
    };
}
export async function createKernel(session, http, jar) {
    if (!session.defaultKernel)
        throw new CliError(
            "KERNEL_CREATE_UNVERIFIED",
            "protocol",
            "Default kernel specification is unknown",
        );
    const headers = {};
    const cookies = await jar.getCookies(`${session.base}api/kernels`);
    const xsrf = cookies.find((c) => c.key === "_xsrf");
    if (xsrf) headers["x-xsrftoken"] = decodeURIComponent(xsrf.value);
    const response = await http.json(
        `${session.base}api/kernels`,
        "POST",
        { name: session.defaultKernel },
        headers,
    );
    if (response.status !== 201)
        throw new CliError(
            "KERNEL_CREATE_UNVERIFIED",
            "remote",
            "Temporary kernel creation was not verified",
        );
    const value = parseJson(response.body);
    if (typeof value.id !== "string")
        throw new CliError(
            "KERNEL_CREATE_UNVERIFIED",
            "protocol",
            "Temporary kernel ID was not returned",
        );
    return value.id;
}
export async function deleteKernel(session, id, http, jar) {
    const url = `${session.base}api/kernels/${encodeURIComponent(id)}`;
    const cookies = await jar.getCookies(url);
    const xsrf = cookies.find((c) => c.key === "_xsrf");
    const response = await http.request(url, {
        method: "DELETE",
        headers: xsrf ? { "x-xsrftoken": decodeURIComponent(xsrf.value) } : {},
    });
    return response.status === 204;
}
// SAFETY: SocketLike is the exact event/send/close subset implemented by ws; the narrower fixture seam intentionally omits unused overloads.
export async function executeKernel(
    session,
    kernelId,
    code,
    jar,
    timeoutMs = 90_000,
    maxBytes = 1_000_000,
    socketFactory = (url, options) => new WebSocket(url, options),
) {
    const messageId = randomUUID(),
        sessionId = randomUUID();
    const endpoint = new URL(
        `${session.base}api/kernels/${encodeURIComponent(kernelId)}/channels`,
    );
    endpoint.protocol = "wss:";
    endpoint.searchParams.set("session_id", sessionId);
    const cookie = await jar.getCookieString(endpoint.href);
    const result = {
        state: "failed",
        reply: "",
        idle: false,
        streams: [],
        displays: [],
        errors: [],
    };
    let bytes = 0;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            if (error) reject(error);
            else {
                result.state =
                    result.reply === "ok" &&
                    result.idle &&
                    result.errors.length === 0
                        ? "completed"
                        : "failed";
                resolve(result);
            }
        };
        const timer = setTimeout(
            () =>
                finish(
                    new CliError(
                        "EXECUTION_UNVERIFIED",
                        "remote",
                        "Notebook execution timed out; it was not retried",
                    ),
                ),
            timeoutMs,
        );
        const socket = socketFactory(endpoint, {
            headers: { cookie, origin: new URL(session.base).origin },
            handshakeTimeout: 20_000,
            maxPayload: maxBytes,
        });
        socket.once("open", () =>
            socket.send(
                JSON.stringify({
                    header: {
                        msg_id: messageId,
                        username: "alphadock",
                        session: sessionId,
                        date: new Date().toISOString(),
                        msg_type: "execute_request",
                        version: "5.3",
                    },
                    parent_header: {},
                    metadata: {},
                    channel: "shell",
                    content: {
                        code,
                        silent: false,
                        store_history: false,
                        user_expressions: {},
                        allow_stdin: false,
                        stop_on_error: true,
                    },
                    buffers: [],
                }),
            ),
        );
        socket.on("message", (raw) => {
            bytes += Buffer.byteLength(raw.toString());
            if (bytes > maxBytes)
                return finish(
                    new CliError(
                        "OUTPUT_LIMIT",
                        "remote",
                        "Notebook output exceeded the safe limit",
                    ),
                );
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return finish(
                    new CliError(
                        "CHANNEL_FRAME_INVALID",
                        "protocol",
                        "Notebook channel returned an unsupported frame",
                    ),
                );
            }
            if (consumeExecutionMessage(result, message, messageId)) finish();
        });
        socket.once("error", () =>
            finish(
                new CliError(
                    "EXECUTION_UNVERIFIED",
                    "remote",
                    "Notebook channel failed; execution was not retried",
                ),
            ),
        );
        socket.once("close", () => {
            if (!settled)
                finish(
                    new CliError(
                        "EXECUTION_UNVERIFIED",
                        "remote",
                        "Notebook channel closed before completion",
                    ),
                );
        });
    });
}
//# sourceMappingURL=jupyter.js.map
