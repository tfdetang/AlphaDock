import { CliError } from "./errors.js";
const ORIGINS = {
    joinquant: new Set(["https://www.joinquant.com"]),
    supermind: new Set([
        "https://quant.10jqka.com.cn",
        "https://supermind.10jqka.com.cn",
    ]),
};
const DOWNGRADE_HEADERS = [
    "content-type",
    "content-length",
    "transfer-encoding",
    "x-xsrftoken",
    "x-csrf-token",
    "authorization",
    "proxy-authorization",
];
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
    "authorization",
    "proxy-authorization",
    "x-xsrftoken",
    "x-csrf-token",
];
async function cancelBody(response) {
    if (!response.body) return;
    try {
        await response.body.cancel();
    } catch {
        /* Discard failures must not expose transport details. */
    }
}
async function readBounded(response, maxBytes) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let output = "";
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new CliError(
                    "RESPONSE_TOO_LARGE",
                    "protocol",
                    "Remote response exceeded the safe limit",
                );
            }
            output += decoder.decode(item.value, { stream: true });
        }
        output += decoder.decode();
        return output;
    } catch (error) {
        if (error instanceof CliError) throw error;
        await reader.cancel().catch(() => undefined);
        throw new CliError(
            "RESPONSE_STREAM_FAILED",
            "transport",
            "Remote response body could not be read",
        );
    } finally {
        reader.releaseLock();
    }
}
export class SafeHttp {
    platform;
    jar;
    transport;
    constructor(platform, jar, transport = fetch) {
        this.platform = platform;
        this.jar = jar;
        this.transport = transport;
    }
    allowed(url) {
        if (
            url.protocol !== "https:" ||
            !ORIGINS[this.platform].has(url.origin)
        )
            throw new CliError(
                "ORIGIN_DENIED",
                "transport",
                "Remote origin is not allowed",
            );
    }
    async request(input, options = {}) {
        let url = new URL(input);
        let method = options.method ?? "GET";
        let requestBody = options.body;
        const redirects = options.redirects ?? 8;
        const requestHeaders = new Headers(options.headers);
        requestHeaders.delete("cookie");
        for (let count = 0; count <= redirects; count++) {
            this.allowed(url);
            const headers = new Headers(requestHeaders);
            headers.delete("cookie");
            const cookie = await this.jar.getCookieString(url.href);
            if (cookie) headers.set("cookie", cookie);
            let response;
            try {
                response = await this.transport(url.href, {
                    method,
                    headers,
                    ...(requestBody === undefined ? {} : { body: requestBody }),
                    redirect: "manual",
                    signal: AbortSignal.timeout(30_000),
                });
            } catch {
                throw new CliError(
                    "TRANSPORT_FAILED",
                    "transport",
                    "Remote request failed",
                );
            }
            const getSetCookie = response.headers.getSetCookie?.() ?? [];
            for (const value of getSetCookie)
                await this.jar.setCookie(value, url.href, {
                    ignoreError: true,
                });
            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                if (count === redirects) {
                    await cancelBody(response);
                    throw new CliError(
                        "REDIRECT_LIMIT",
                        "protocol",
                        "Remote redirect limit exceeded",
                    );
                }
                const next = new URL(location, url);
                try {
                    this.allowed(next);
                } catch (error) {
                    await cancelBody(response);
                    throw error;
                }
                const crossOrigin = url.origin !== next.origin;
                if (crossOrigin && (url.search || location.includes("?"))) {
                    await cancelBody(response);
                    throw new CliError(
                        "CROSS_ORIGIN_TOKEN_REDIRECT",
                        "protocol",
                        "Token-bearing cross-origin redirect refused",
                    );
                }
                if (
                    crossOrigin &&
                    (!["GET", "HEAD"].includes(method) ||
                        requestBody !== undefined ||
                        CROSS_ORIGIN_SENSITIVE_HEADERS.some((name) =>
                            requestHeaders.has(name),
                        ))
                ) {
                    await cancelBody(response);
                    throw new CliError(
                        "CROSS_ORIGIN_SENSITIVE_REDIRECT",
                        "protocol",
                        "Cross-origin redirect with sensitive request state refused",
                    );
                }
                try {
                    await options.onRedirect?.({
                        from: new URL(url),
                        to: new URL(next),
                        status: response.status,
                    });
                } finally {
                    await cancelBody(response);
                }
                if (
                    response.status === 303 ||
                    ((response.status === 301 || response.status === 302) &&
                        method === "POST")
                ) {
                    method = "GET";
                    requestBody = undefined;
                    for (const name of DOWNGRADE_HEADERS)
                        requestHeaders.delete(name);
                }
                url = next;
                continue;
            }
            const body = await readBounded(
                response,
                options.maxBytes ?? 4_000_000,
            );
            return {
                status: response.status,
                url,
                headers: response.headers,
                body,
            };
        }
        throw new CliError(
            "REDIRECT_LIMIT",
            "protocol",
            "Remote redirect limit exceeded",
        );
    }
    async form(url, values, headers = {}) {
        return this.request(url, {
            method: "POST",
            body: new URLSearchParams(
                Object.entries(values).map(([key, value]) => [
                    key,
                    String(value),
                ]),
            ).toString(),
            headers: {
                "content-type":
                    "application/x-www-form-urlencoded; charset=UTF-8",
                ...headers,
            },
        });
    }
    async json(url, method, value, headers = {}) {
        return this.request(url, {
            method,
            ...(value === undefined ? {} : { body: JSON.stringify(value) }),
            headers: {
                accept: "application/json",
                ...(value === undefined
                    ? {}
                    : { "content-type": "application/json" }),
                ...headers,
            },
        });
    }
}
export function parseJson(body) {
    try {
        const value = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
        return value;
    } catch {
        throw new CliError(
            "RESPONSE_INVALID",
            "protocol",
            "Remote response has an unexpected shape",
        );
    }
}
//# sourceMappingURL=http.js.map
