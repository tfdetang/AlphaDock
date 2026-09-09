import { readFile } from "node:fs/promises";
import { Cookie, CookieJar } from "tough-cookie";
import { CliError } from "./errors.js";
export function parseJsonSequence(text) {
    const source = text.replace(/^\uFEFF/, "");
    const values = [];
    let index = 0;
    while (index < source.length) {
        while (index < source.length && /[\s,;]/.test(source[index])) index++;
        if (index >= source.length) break;
        const start = index;
        let depth = 0;
        let string = false;
        let escaped = false;
        for (; index < source.length; index++) {
            const character = source[index];
            if (string) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') string = false;
                continue;
            }
            if (character === '"') string = true;
            else if (character === "{" || character === "[") depth++;
            else if (character === "}" || character === "]") {
                depth--;
                if (depth === 0) {
                    index++;
                    break;
                }
            } else if (depth === 0 && !/\s/.test(character))
                throw new CliError(
                    "COOKIE_FORMAT_INVALID",
                    "auth",
                    "Cookie file is not supported JSON",
                );
        }
        if (string || depth !== 0)
            throw new CliError(
                "COOKIE_FORMAT_INVALID",
                "auth",
                "Cookie file contains incomplete JSON",
            );
        try {
            values.push(JSON.parse(source.slice(start, index)));
        } catch {
            throw new CliError(
                "COOKIE_FORMAT_INVALID",
                "auth",
                "Cookie file contains malformed JSON",
            );
        }
    }
    if (values.length === 0)
        throw new CliError(
            "COOKIE_FORMAT_INVALID",
            "auth",
            "Cookie file is empty",
        );
    return values;
}
function flatten(values) {
    const output = [];
    for (const value of values) {
        if (Array.isArray(value)) output.push(...value);
        else if (
            value &&
            typeof value === "object" &&
            Array.isArray(value.cookies)
        )
            output.push(...value.cookies);
        else if (value && typeof value === "object") output.push(value);
        else
            throw new CliError(
                "COOKIE_FORMAT_INVALID",
                "auth",
                "Cookie entries must be JSON objects",
            );
    }
    return output;
}
export async function loadCookieJar(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    } catch {
        throw new CliError(
            "COOKIE_FILE_UNREADABLE",
            "auth",
            "Cookie file cannot be read",
        );
    }
    const jar = new CookieJar(undefined, { rejectPublicSuffixes: true });
    const now = Date.now() / 1000;
    for (const item of flatten(parseJsonSequence(text))) {
        if (
            typeof item.name !== "string" ||
            typeof item.value !== "string" ||
            typeof item.domain !== "string"
        )
            throw new CliError(
                "COOKIE_FORMAT_INVALID",
                "auth",
                "Cookie entry lacks name, value, or domain",
            );
        const expiresRaw = item.expirationDate ?? item.expires;
        const expires =
            typeof expiresRaw === "number" &&
            expiresRaw > 0 &&
            item.session !== true
                ? new Date(expiresRaw * 1000)
                : "Infinity";
        if (
            typeof expiresRaw === "number" &&
            expiresRaw > 0 &&
            expiresRaw <= now
        )
            continue;
        const domain = item.domain.replace(/^\./, "");
        const hostOnly =
            item.hostOnly === true ||
            (item.hostOnly === undefined && !item.domain.startsWith("."));
        const cookie = new Cookie({
            key: item.name,
            value: item.value,
            domain,
            path: typeof item.path === "string" ? item.path : "/",
            secure: item.secure === true,
            hostOnly,
            expires,
        });
        try {
            await jar.setCookie(cookie, `https://${domain}${cookie.path}`, {
                ignoreError: false,
            });
        } catch {
            throw new CliError(
                "COOKIE_FORMAT_INVALID",
                "auth",
                "Cookie domain or attributes are invalid",
            );
        }
    }
    return jar;
}
//# sourceMappingURL=cookies.js.map
