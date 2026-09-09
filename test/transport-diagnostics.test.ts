import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { SafeHttp, type Transport } from "../src/http.js";
import { CliError, publicError } from "../src/errors.js";

async function failure(http: SafeHttp, url: string, method = "GET") {
  try {
    await http.request(url, {
      method,
      ...(method === "POST" ? { body: "private-sql" } : {}),
    });
  } catch (error) {
    assert.ok(error instanceof CliError);
    return publicError(error);
  }
  throw new Error("Expected a failed request");
}

const base = "https://supermind.10jqka.com.cn";

test("transport diagnostics identify notebook HTTP steps without exposing paths or request data", async () => {
  const cases = [
    ["/notebook/hub/login", "GET", "notebook_login"],
    ["/notebook/user/private-user/api/kernels", "GET", "kernel_list"],
    ["/notebook/user/private-user/api/kernelspecs", "GET", "kernelspecs"],
    ["/notebook/user/private-user/api/kernels", "POST", "kernel_create"],
    [
      "/notebook/user/private-user/api/kernels/private-kernel",
      "DELETE",
      "kernel_delete",
    ],
  ];
  for (const [path, method, operation] of cases) {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      throw new TypeError("private-url private-cookie private-sql", {
        cause: Object.assign(new Error("private-token"), {
          code: "ECONNRESET",
        }),
      });
    };
    const result = await failure(
      new SafeHttp("supermind", new CookieJar(), transport),
      `${base}${path}?token=private-query`,
      method,
    );
    assert.equal(calls, 1, "no retries, including kernel POST");
    assert.equal(result.error.code, "TRANSPORT_FAILED");
    assert.equal(result.error.stage, "transport");
    const diag = result.error.diagnostics!;
    assert.equal(diag.operation, operation);
    assert.equal(diag.method, method);
    assert.equal(diag.hostname, "supermind.10jqka.com.cn");
    assert.equal(diag.causeCode, "ECONNRESET");
    assert.equal(diag.failurePhase, "request");
    assert.equal(diag.redirectHop, 0);
    assert.equal(diag.timeoutMs, 30_000);
    assert.ok(Number.isInteger(diag.elapsedMs) && diag.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(result), /private-|stack|\/notebook/);
  }
});

test("transport cause codes are allowlisted, bounded and cycle-safe", async () => {
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  const cases: Array<[unknown, string]> = [
    [{ code: "ENOTFOUND" }, "ENOTFOUND"],
    [
      new TypeError("fetch failed", {
        cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      }),
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ],
    [
      { cause: { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } } },
      "UND_ERR_CONNECT_TIMEOUT",
    ],
    [new AggregateError([{ code: "ECONNREFUSED" }]), "ECONNREFUSED"],
    [new DOMException("private-message", "TimeoutError"), "TIMEOUT"],
    [new DOMException("private-message", "AbortError"), "ABORTED"],
    [
      { code: "private-token", name: "private-name", cause: "private-cause" },
      "UNKNOWN",
    ],
    [cycle, "UNKNOWN"],
    [null, "UNKNOWN"],
    [
      Object.defineProperty({}, "code", {
        get() {
          throw new Error("private-secret");
        },
      }),
      "UNKNOWN",
    ],
  ];
  for (const [error, code] of cases) {
    const http = new SafeHttp("supermind", new CookieJar(), async () => {
      throw error;
    });
    const result = await failure(http, `${base}/notebook/hub/login`);
    assert.equal(result.error.diagnostics?.causeCode, code);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test("redirect failure reports the current hop and method, not the original login URL", async () => {
  let calls = 0;
  const http = new SafeHttp("supermind", new CookieJar(), async () => {
    if (++calls === 1)
      return {
        status: 303,
        headers: new Headers({
          location: "/notebook/user/private-user/lab?code=private-oauth",
        }),
        body: null,
      };
    throw Object.assign(new Error("private-url"), { code: "EAI_AGAIN" });
  });
  const result = await failure(http, `${base}/notebook/hub/login`, "POST");
  assert.equal(calls, 2);
  assert.equal(result.error.diagnostics?.operation, "notebook_route");
  assert.equal(result.error.diagnostics?.method, "GET");
  assert.equal(result.error.diagnostics?.redirectHop, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("body stream failures preserve their distinct code and carry safe diagnostics", async () => {
  const http = new SafeHttp("supermind", new CookieJar(), async () => ({
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(
          new TypeError("private-response", {
            cause: { code: "UND_ERR_BODY_TIMEOUT" },
          }),
        );
      },
    }),
  }));
  const result = await failure(
    http,
    `${base}/notebook/user/private-user/api/kernelspecs`,
  );
  assert.equal(result.error.code, "RESPONSE_STREAM_FAILED");
  assert.equal(result.error.diagnostics?.failurePhase, "response_body");
  assert.equal(result.error.diagnostics?.operation, "kernelspecs");
  assert.equal(result.error.diagnostics?.causeCode, "UND_ERR_BODY_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("unrelated and unknown errors retain the existing public error shape", () => {
  assert.deepEqual(
    publicError(new CliError("INPUT", "input", "Invalid input")),
    {
      ok: false,
      error: { code: "INPUT", stage: "input", message: "Invalid input" },
    },
  );
  assert.deepEqual(publicError(new Error("private-secret")), {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      stage: "protocol",
      message: "Operation failed without verifiable completion",
    },
  });
});
