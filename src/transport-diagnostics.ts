import type { TransportDiagnostics } from "./errors.js";

// Do not expose arbitrary error messages/codes, request paths, or redirect URLs.
const SAFE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
  "WS_ERR_INVALID_UTF8",
]);
const SAFE_HOSTS = new Set([
  "www.joinquant.com",
  "quant.10jqka.com.cn",
  "supermind.10jqka.com.cn",
]);

interface ErrorFields {
  code?: string;
  name?: string;
  causes: unknown[];
}

function errorFields(value: unknown): ErrorFields {
  if (!value || typeof value !== "object") return { causes: [] };
  try {
    const record = value as Record<string, unknown>;
    const code = record.code;
    const name = record.name;
    const cause = record.cause;
    const errors = record.errors;
    return {
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof name === "string" ? { name } : {}),
      causes: [
        ...(cause ? [cause] : []),
        ...(Array.isArray(errors) ? errors.slice(0, 4) : []),
      ],
    };
  } catch {
    return { causes: [] };
  }
}

export function safeCauseCode(error: unknown): string {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 16; i++) {
    const current = queue[i];
    if (seen.has(current)) continue;
    seen.add(current);
    const { code, name, causes } = errorFields(current);
    if (code && SAFE_CODES.has(code)) return code;
    if (name === "TimeoutError") return "TIMEOUT";
    if (name === "AbortError") return "ABORTED";
    queue.push(...causes);
  }
  return "UNKNOWN";
}

function operation(url: URL, method: string): string {
  const path = url.pathname;
  if (path === "/notebook/hub/spawn" && method === "POST") return "server_start";
  if (path === "/notebook/hub/api/user" && method === "GET") return "server_status";
  if (path === "/notebook/hub/login" || path === "/hub/login")
    return "notebook_login";
  if (path === "/default/research/redirect") return "notebook_bootstrap";
  if (/^\/(?:notebook\/)?user\/[^/]+\/api\/kernels$/.test(path)) {
    if (method === "POST") return "kernel_create";
    if (method === "GET") return "kernel_list";
  }
  if (/^\/(?:notebook\/)?user\/[^/]+\/api\/kernelspecs$/.test(path))
    return "kernelspecs";
  if (
    method === "DELETE" &&
    /^\/(?:notebook\/)?user\/[^/]+\/api\/kernels\/[^/]+$/.test(path)
  )
    return "kernel_delete";
  if (/^\/(?:notebook\/)?(?:hub|user)\//.test(path)) return "notebook_route";
  return "http_request";
}

export function transportDiagnostics(
  error: unknown,
  url: URL,
  method: string,
  startedAt: number,
  redirectHop: number,
  failurePhase: TransportDiagnostics["failurePhase"],
): TransportDiagnostics {
  const safeMethod = [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ].includes(method)
    ? method
    : "OTHER";
  return {
    operation: operation(url, safeMethod),
    method: safeMethod,
    hostname: SAFE_HOSTS.has(url.hostname) ? url.hostname : "OTHER",
    failurePhase,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    timeoutMs: 30_000,
    redirectHop,
    causeCode: safeCauseCode(error),
  };
}
