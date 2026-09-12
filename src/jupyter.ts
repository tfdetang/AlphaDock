import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { CookieJar } from "tough-cookie";
import { CliError } from "./errors.js";
import { safeCauseCode } from "./transport-diagnostics.js";
import {
  startNotebookServer,
  type ServerStartReport,
} from "./notebook-startup.js";
import { SafeHttp, parseJson } from "./http.js";
import type { Platform } from "./storage.js";

export interface ExecutionResult {
  state: "completed" | "failed";
  reply: string;
  idle: boolean;
  streams: Array<{ name: string; text: string }>;
  displays: Array<{ mimeTypes: string[]; text?: string }>;
  errors: Array<{ name: string; value: string }>;
}
export interface NotebookExecutionReport {
  ok: boolean;
  platform: Platform;
  kernelId: string;
  temporary: boolean;
  cleanedUp?: boolean;
  execution: ExecutionResult;
}
export function notebookExecutionReport(
  platform: Platform,
  kernelId: string,
  temporary: boolean,
  execution: ExecutionResult,
  cleanedUp?: boolean,
): NotebookExecutionReport {
  return {
    ok: execution.state === "completed" && (!temporary || cleanedUp === true),
    platform,
    kernelId,
    temporary,
    ...(temporary ? { cleanedUp: cleanedUp === true } : {}),
    execution,
  };
}
export interface NotebookSession {
  base: string;
  serverStart?: ServerStartReport;
  kernels: Array<{ id: string; name?: string; execution_state?: string }>;
  defaultKernel?: string;
}
export interface JupyterMessage {
  parent_header?: { msg_id?: unknown };
  header?: { msg_type?: unknown };
  msg_type?: unknown;
  content?: Record<string, unknown>;
}
interface SocketLike {
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error?: unknown) => void): this;
  once(event: "close", listener: (code?: number) => void): this;
  on(event: "message", listener: (raw: Buffer) => void): this;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (
  url: URL,
  options: {
    headers: Record<string, string>;
    handshakeTimeout: number;
    maxPayload: number;
  },
) => SocketLike;

export function consumeExecutionMessage(
  result: ExecutionResult,
  message: JupyterMessage,
  messageId: string,
): boolean {
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
      text: String(content.text ?? ""),
    });
  else if (type === "error")
    result.errors.push({
      name: String(content.ename ?? "Error"),
      value: String(content.evalue ?? ""),
    });
  else if (type === "display_data" || type === "execute_result") {
    const data: Record<string, unknown> =
      content.data && typeof content.data === "object"
        ? (content.data as Record<string, unknown>)
        : {};
    const plain = data["text/plain"];
    result.displays.push({
      mimeTypes: Object.keys(data),
      ...(typeof plain === "string" ? { text: plain } : {}),
    });
  }
  return Boolean(result.reply && result.idle);
}

function userBase(platform: Platform, url: URL): string | undefined {
  const pattern =
    platform === "joinquant"
      ? /^(\/user\/[^/]+\/)/
      : /^(\/notebook\/user\/[^/]+\/)/;
  const found = pattern.exec(url.pathname);
  return found ? `${url.origin}${found[1]}` : undefined;
}
export async function notebookSession(
  platform: Platform,
  http: SafeHttp,
  options: { startServer?: boolean; jar?: CookieJar } = {},
): Promise<NotebookSession> {
  if (options.startServer && !options.jar)
    throw new CliError(
      "STARTUP_CONTEXT_REQUIRED",
      "input",
      "Startup requires the authenticated cookie jar",
    );
  let response;
  if (platform === "joinquant") {
    const bootstrap = await http.request(
      "https://www.joinquant.com/default/research/redirect",
      { redirects: 0 },
    );
    const mob = /\bvar\s+mob\s*=\s*["']([^"']+)["']/.exec(bootstrap.body)?.[1];
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
  let base = userBase(platform, response.url);
  let serverStart: ServerStartReport | undefined;
  if (/\/spawn(?:-pending)?(?:\/|$)/.test(response.url.pathname)) {
    if (!options.startServer || !options.jar)
      throw new CliError(
        "SERVER_NOT_READY",
        "auth",
        "Notebook server is not ready; authorized agents may use --start-server",
      );
    const started = await startNotebookServer(
      platform,
      response,
      http,
      options.jar,
    );
    base = started.base;
    serverStart = started.report;
  }
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
  let kernelsValue: unknown;
  try {
    kernelsValue = JSON.parse(kernelsResponse.body);
  } catch {
    throw new CliError(
      "RESPONSE_INVALID",
      "protocol",
      "Kernel list is not valid JSON",
    );
  }
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
    ...(serverStart ? { serverStart } : {}),
    kernels: kernelsValue.filter(
      (v): v is { id: string } =>
        !!v &&
        typeof v === "object" &&
        typeof (v as { id?: unknown }).id === "string",
    ),
    ...(typeof specs.default === "string"
      ? { defaultKernel: specs.default }
      : {}),
  };
}

export async function createKernel(
  session: NotebookSession,
  http: SafeHttp,
  jar: CookieJar,
): Promise<string> {
  if (!session.defaultKernel)
    throw new CliError(
      "KERNEL_CREATE_UNVERIFIED",
      "protocol",
      "Default kernel specification is unknown",
    );
  const headers: Record<string, string> = {};
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
export async function deleteKernel(
  session: NotebookSession,
  id: string,
  http: SafeHttp,
  jar: CookieJar,
): Promise<boolean> {
  const url = `${session.base}api/kernels/${encodeURIComponent(id)}`;
  const cookies = await jar.getCookies(url);
  const xsrf = cookies.find((c) => c.key === "_xsrf");
  const response = await http.request(url, {
    method: "DELETE",
    headers: xsrf ? { "x-xsrftoken": decodeURIComponent(xsrf.value) } : {},
  });
  return response.status === 204;
}

export const DEFAULT_NOTEBOOK_BYTES = 1_000_000;
export const MAX_NOTEBOOK_BYTES = 64_000_000;

export function notebookByteLimit(value: string | number): number {
  const number =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > MAX_NOTEBOOK_BYTES
  )
    throw new CliError(
      "INVALID_OUTPUT_LIMIT",
      "input",
      "Notebook byte limits must be integers from 1 to 64000000",
    );
  return number;
}

// SAFETY: SocketLike is the exact event/send/close subset implemented by ws; the narrower fixture seam intentionally omits unused overloads.
export async function executeKernel(
  session: NotebookSession,
  kernelId: string,
  code: string,
  jar: CookieJar,
  timeoutMs = 90_000,
  maxBytes = DEFAULT_NOTEBOOK_BYTES,
  socketFactory: SocketFactory = (url, options) =>
    new WebSocket(url, options) as unknown as SocketLike,
  maxMessageBytes = DEFAULT_NOTEBOOK_BYTES,
): Promise<ExecutionResult> {
  notebookByteLimit(maxBytes);
  notebookByteLimit(maxMessageBytes);
  const messageId = randomUUID(),
    sessionId = randomUUID();
  let endpoint: URL;
  let origin: string;
  try {
    endpoint = new URL(
      `${session.base}api/kernels/${encodeURIComponent(kernelId)}/channels`,
    );
    origin = endpoint.origin;
  } catch {
    throw new CliError("URL_INVALID", "input", "Notebook base is invalid");
  }
  endpoint.protocol = "wss:";
  endpoint.searchParams.set("session_id", sessionId);
  const cookie = await jar.getCookieString(endpoint.href);
  const result: ExecutionResult = {
    state: "failed",
    reply: "",
    idle: false,
    streams: [],
    displays: [],
    errors: [],
  };
  let bytes = 0;
  let messages = 0;
  const startedAt = performance.now();
  const failure = (
    code: string,
    message: string,
    causeCode = "UNKNOWN",
    closeCode?: number,
  ) =>
    new CliError(code, "remote", message, {
      operation: "notebook_execute",
      failurePhase: "channel",
      causeCode,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timeoutMs,
      receivedBytes: bytes,
      receivedMessages: messages,
      maxMessageBytes,
      maxTotalBytes: maxBytes,
      reply:
        result.reply === "ok" ||
        result.reply === "error" ||
        result.reply === "abort"
          ? result.reply
          : result.reply
            ? "unknown"
            : "missing",
      idle: result.idle,
      ...(typeof closeCode === "number" &&
      Number.isInteger(closeCode) &&
      closeCode >= 1000 &&
      closeCode <= 4999
        ? { closeCode }
        : {}),
    });
  return new Promise((resolve, reject) => {
    let socket: SocketLike | undefined;
    let settled = false;
    const finish = (error?: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closing an already failed socket must not replace the original failure.
      try {
        socket?.close();
      } catch {
        /* no retry or second settlement */
      }
      if (error) reject(error);
      else {
        result.state =
          result.reply === "ok" && result.idle && result.errors.length === 0
            ? "completed"
            : "failed";
        resolve(result);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          failure(
            "EXECUTION_UNVERIFIED",
            "Notebook execution timed out; it was not retried",
            "TIMEOUT",
          ),
        ),
      timeoutMs,
    );
    try {
      socket = socketFactory(endpoint, {
        headers: { cookie, origin },
        handshakeTimeout: 20_000,
        maxPayload: maxMessageBytes,
      });
    } catch (error) {
      finish(
        failure(
          "EXECUTION_UNVERIFIED",
          "Notebook channel could not be opened",
          safeCauseCode(error),
        ),
      );
      return;
    }
    socket.once("open", () => {
      if (settled || !socket) return;
      try {
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
        );
      } catch (error) {
        finish(
          failure(
            "EXECUTION_UNVERIFIED",
            "Notebook channel send failed; execution was not retried",
            safeCauseCode(error),
          ),
        );
      }
    });
    socket.on("message", (raw) => {
      if (settled) return;
      const size = raw.byteLength;
      bytes += size;
      messages++;
      if (size > maxMessageBytes || bytes > maxBytes)
        return finish(
          failure(
            "OUTPUT_LIMIT",
            "Notebook output exceeded the safe limit; execution may be incomplete",
            size > maxMessageBytes
              ? "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              : "TOTAL_BYTES_LIMIT",
          ),
        );
      let message: JupyterMessage;
      try {
        message = JSON.parse(raw.toString()) as JupyterMessage;
      } catch {
        return finish(
          new CliError(
            "CHANNEL_FRAME_INVALID",
            "protocol",
            "Notebook channel returned an unsupported frame",
            failure("CHANNEL_FRAME_INVALID", "Unsupported frame").diagnostics,
          ),
        );
      }
      if (!message || typeof message !== "object" || Array.isArray(message))
        return finish(
          failure(
            "CHANNEL_FRAME_INVALID",
            "Notebook channel returned an unsupported frame",
          ),
        );
      if (consumeExecutionMessage(result, message, messageId)) finish();
    });
    socket.once("error", (error) => {
      const cause = safeCauseCode(error);
      finish(
        failure(
          cause === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            ? "OUTPUT_LIMIT"
            : "EXECUTION_UNVERIFIED",
          "Notebook channel failed; execution was not retried",
          cause,
        ),
      );
    });
    socket.once("close", (code) => {
      if (!settled)
        finish(
          failure(
            "EXECUTION_UNVERIFIED",
            "Notebook channel closed before completion",
            "UNKNOWN",
            code,
          ),
        );
    });
  });
}
