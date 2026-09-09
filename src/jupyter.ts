import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { CookieJar } from "tough-cookie";
import { CliError } from "./errors.js";
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
  once(event: "open" | "error" | "close", listener: () => void): this;
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
      text: String(content.text ?? "").slice(0, 100_000),
    });
  else if (type === "error")
    result.errors.push({
      name: String(content.ename ?? "Error"),
      value: String(content.evalue ?? "").slice(0, 10_000),
    });
  else if (type === "display_data" || type === "execute_result") {
    const data: Record<string, unknown> =
      content.data && typeof content.data === "object"
        ? (content.data as Record<string, unknown>)
        : {};
    const plain = data["text/plain"];
    result.displays.push({
      mimeTypes: Object.keys(data),
      ...(typeof plain === "string" ? { text: plain.slice(0, 100_000) } : {}),
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
): Promise<NotebookSession> {
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
  const kernelsValue: unknown = JSON.parse(kernelsResponse.body);
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

// SAFETY: SocketLike is the exact event/send/close subset implemented by ws; the narrower fixture seam intentionally omits unused overloads.
export async function executeKernel(
  session: NotebookSession,
  kernelId: string,
  code: string,
  jar: CookieJar,
  timeoutMs = 90_000,
  maxBytes = 1_000_000,
  socketFactory: SocketFactory = (url, options) =>
    new WebSocket(url, options) as unknown as SocketLike,
): Promise<ExecutionResult> {
  const messageId = randomUUID(),
    sessionId = randomUUID();
  const endpoint = new URL(
    `${session.base}api/kernels/${encodeURIComponent(kernelId)}/channels`,
  );
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
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
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
      let message: JupyterMessage;
      try {
        message = JSON.parse(raw.toString()) as JupyterMessage;
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
