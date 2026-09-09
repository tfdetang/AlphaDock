import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
  mkdir,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CookieJar } from "tough-cookie";
import { SafeHttp, type Transport } from "../src/http.js";
import {
  consumeExecutionMessage,
  notebookSession,
  createKernel,
  deleteKernel,
  executeKernel,
  type ExecutionResult,
  notebookExecutionReport,
  type SocketFactory,
} from "../src/jupyter.js";
import {
  createJournal,
  exclusiveOutput,
  assertOutputAvailable,
  updateJournal,
} from "../src/storage.js";
import { prepareRemoteOperation } from "../src/operations.js";
import { assertId, parseDate, parsePositive } from "../src/errors.js";
import { waitForTerminal } from "../src/wait.js";

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: new Headers(headers),
    body: new Blob([text]).stream(),
  };
}

test("both notebook handshakes detect validated bases and list only without spawning", async () => {
  for (const platform of ["joinquant", "supermind"] as const) {
    const calls: string[] = [];
    const transport: Transport = async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      if (path === "/default/research/redirect")
        return response(
          200,
          `var mob='fixture-user'; var sessionId='synthetic-token';`,
        );
      if (path === "/hub/login")
        return response(302, "", { location: "/user/fixture/tree" });
      if (path === "/notebook/hub/login")
        return response(302, "", { location: "/notebook/user/fixture/lab" });
      if (path.endsWith("/api/kernels"))
        return response(200, [{ id: "kernel-fixture", name: "python3" }]);
      if (path.endsWith("/api/kernelspecs"))
        return response(200, {
          default: "python3",
          kernelspecs: { python3: {} },
        });
      return response(200, "lab");
    };
    const session = await notebookSession(
      platform,
      new SafeHttp(platform, new CookieJar(), transport),
    );
    assert.equal(session.kernels[0]?.id, "kernel-fixture");
    assert.match(
      session.base,
      platform === "joinquant"
        ? /\/user\/fixture\/$/
        : /\/notebook\/user\/fixture\/$/,
    );
    assert.equal(
      calls.some(
        (call) => call.startsWith("POST") && call.endsWith("/api/kernels"),
      ),
      false,
    );
    assert.equal(
      calls.some((call) => call.includes("spawn")),
      false,
    );
  }
});

test("notebookSession rejects stopped-server spawn redirect without automatic startup", async () => {
  for (const platform of ["joinquant", "supermind"] as const) {
    const transport: Transport = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/default/research/redirect")
        return response(
          200,
          `var mob='fixture-user'; var sessionId='synthetic-token';`,
        );
      if (path === "/hub/login" || path === "/notebook/hub/login")
        return response(302, "", { location: `/hub/spawn?user=fixture` });
      return response(200, "spawn page");
    };
    const http = new SafeHttp(platform, new CookieJar(), transport);
    await assert.rejects(
      () => notebookSession(platform, http),
      /Notebook server is stopped; automatic startup is not supported/,
    );
  }
});

test("Jupyter correlation requires matching reply and idle in either order and separates output", () => {
  const result: ExecutionResult = {
    state: "failed",
    reply: "",
    idle: false,
    streams: [],
    displays: [],
    errors: [],
  };
  const other = {
    parent_header: { msg_id: "other" },
    header: { msg_type: "execute_reply" },
    content: { status: "ok" },
  };
  assert.equal(consumeExecutionMessage(result, other, "wanted"), false);
  assert.equal(result.reply, "");
  assert.equal(
    consumeExecutionMessage(
      result,
      {
        parent_header: { msg_id: "wanted" },
        header: { msg_type: "status" },
        content: { execution_state: "idle" },
      },
      "wanted",
    ),
    false,
  );
  consumeExecutionMessage(
    result,
    {
      parent_header: { msg_id: "wanted" },
      header: { msg_type: "stream" },
      content: { name: "stderr", text: "warning" },
    },
    "wanted",
  );
  assert.equal(
    consumeExecutionMessage(
      result,
      {
        parent_header: { msg_id: "wanted" },
        header: { msg_type: "execute_reply" },
        content: { status: "ok" },
      },
      "wanted",
    ),
    true,
  );
  assert.deepEqual(result.streams, [{ name: "stderr", text: "warning" }]);
});

function scriptedSocket(
  action: "complete" | "failed" | "close" | "large" | "silent",
): SocketFactory {
  return () => {
    const once = new Map<string, () => void>();
    let message: ((raw: Buffer) => void) | undefined;
    const socket = {
      once(event: "open" | "error" | "close", listener: () => void) {
        once.set(event, listener);
        if (event === "open") queueMicrotask(listener);
        return socket;
      },
      on(_event: "message", listener: (raw: Buffer) => void) {
        message = listener;
        return socket;
      },
      send(data: string) {
        const request = JSON.parse(data) as { header: { msg_id: string } };
        const id = request.header.msg_id;
        if (action === "close")
          return queueMicrotask(() => once.get("close")?.());
        if (action === "silent") return;
        if (action === "large")
          return queueMicrotask(() =>
            message?.(
              Buffer.from(
                JSON.stringify({
                  parent_header: { msg_id: id },
                  header: { msg_type: "stream" },
                  content: { text: "x".repeat(500) },
                }),
              ),
            ),
          );
        queueMicrotask(() => {
          if (action === "failed")
            message?.(
              Buffer.from(
                JSON.stringify({
                  parent_header: { msg_id: id },
                  header: { msg_type: "error" },
                  content: { ename: "ValueError", evalue: "synthetic failure" },
                }),
              ),
            );
          message?.(
            Buffer.from(
              JSON.stringify({
                parent_header: { msg_id: id },
                header: { msg_type: "execute_reply" },
                content: { status: action === "failed" ? "error" : "ok" },
              }),
            ),
          );
          message?.(
            Buffer.from(
              JSON.stringify({
                parent_header: { msg_id: id },
                header: { msg_type: "status" },
                content: { execution_state: "idle" },
              }),
            ),
          );
        });
      },
      close() {},
    };
    return socket;
  };
}

test("deterministic WebSocket execution completes once and fails closed on close, timeout, and output limit", async () => {
  const session = {
    base: "https://supermind.10jqka.com.cn/notebook/user/fixture/",
    kernels: [],
  };
  const jar = new CookieJar();
  assert.equal(
    (
      await executeKernel(
        session,
        "kernel-fixture",
        "print(1)",
        jar,
        100,
        1000,
        scriptedSocket("complete"),
      )
    ).state,
    "completed",
  );
  const failed = await executeKernel(
    session,
    "kernel-fixture",
    "print(1)",
    jar,
    100,
    1000,
    scriptedSocket("failed"),
  );
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.errors, [
    { name: "ValueError", value: "synthetic failure" },
  ]);
  await assert.rejects(
    () =>
      executeKernel(
        session,
        "kernel-fixture",
        "print(1)",
        jar,
        100,
        1000,
        scriptedSocket("close"),
      ),
    /closed before completion/,
  );
  await assert.rejects(
    () =>
      executeKernel(
        session,
        "kernel-fixture",
        "print(1)",
        jar,
        5,
        1000,
        scriptedSocket("silent"),
      ),
    /timed out/,
  );
  await assert.rejects(
    () =>
      executeKernel(
        session,
        "kernel-fixture",
        "print(1)",
        jar,
        100,
        100,
        scriptedSocket("large"),
      ),
    /safe limit/,
  );
});

test("temporary kernel create/delete sends XSRF while an existing kernel needs no cleanup", async () => {
  const jar = new CookieJar();
  const base = "https://supermind.10jqka.com.cn/notebook/user/fixture/";
  await jar.setCookie(
    "_xsrf=synthetic-xsrf; Secure; Path=/notebook/user/fixture/",
    base,
  );
  const writes: Array<{ method: string; xsrf: string | null }> = [];
  const transport: Transport = async (_url, init) => {
    const headers = new Headers(init.headers);
    writes.push({
      method: String(init.method),
      xsrf: headers.get("x-xsrftoken"),
    });
    return init.method === "POST"
      ? response(201, { id: "owned-kernel" })
      : response(204, "");
  };
  const http = new SafeHttp("supermind", jar, transport);
  const session = {
    base,
    kernels: [{ id: "existing-kernel" }],
    defaultKernel: "python3",
  };
  assert.equal(writes.length, 0);
  const id = await createKernel(session, http, jar);
  assert.equal(id, "owned-kernel");
  assert.equal(await deleteKernel(session, id, http, jar), true);
  assert.deepEqual(writes, [
    { method: "POST", xsrf: "synthetic-xsrf" },
    { method: "DELETE", xsrf: "synthetic-xsrf" },
  ]);
});

test("completed temporary execution with unverified cleanup is truthful and unsuccessful", async () => {
  const session = {
    base: "https://supermind.10jqka.com.cn/notebook/user/fixture/",
    kernels: [],
  };
  const execution = await executeKernel(
    session,
    "owned-kernel",
    "print(1)",
    new CookieJar(),
    100,
    1000,
    scriptedSocket("complete"),
  );
  const report = notebookExecutionReport(
    "supermind",
    "owned-kernel",
    true,
    execution,
    false,
  );
  assert.equal(report.ok, false);
  assert.equal(report.execution.state, "completed");
  assert.equal(report.cleanedUp, false);
  assert.equal(report.kernelId, "owned-kernel");
});

test("local auth validation precedes journals and corrected configuration is not poisoned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphadock-preflight-"));
  process.env.ALPHADOCK_HOME = directory;
  const missing = join(directory, "missing-cookie.json");
  process.env.ALPHADOCK_JOINQUANT_COOKIE_FILE = missing;
  await assert.rejects(
    () =>
      prepareRemoteOperation(
        "strategy-create",
        "joinquant",
        { name: "fixture" },
        "print(1)",
      ),
    /cannot be read/,
  );
  const source = join(directory, "strategy.py");
  await writeFile(source, "print(1)");
  const missingRun = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "strategy",
      "create",
      source,
      "--platform",
      "joinquant",
      "--name",
      "fixture",
      "--confirm-remote-write",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ALPHADOCK_HOME: directory,
        ALPHADOCK_JOINQUANT_COOKIE_FILE: missing,
      },
    },
  );
  assert.notEqual(missingRun.status, 0);
  assert.equal((await readdir(directory)).includes("operations"), false);
  const malformed = join(directory, "malformed.json");
  await writeFile(malformed, "{");
  process.env.ALPHADOCK_JOINQUANT_COOKIE_FILE = malformed;
  await assert.rejects(
    () =>
      prepareRemoteOperation(
        "strategy-create",
        "joinquant",
        { name: "fixture" },
        "print(1)",
      ),
    /incomplete JSON/,
  );
  const malformedRun = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "backtest",
      "submit",
      "--platform",
      "joinquant",
      "--strategy-id",
      "strategy-fixture",
      "--start",
      "2024-01-01",
      "--end",
      "2024-01-02",
      "--cash",
      "1",
      "--frequency",
      "day",
      "--confirm-remote-execution",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ALPHADOCK_HOME: directory,
        ALPHADOCK_JOINQUANT_COOKIE_FILE: malformed,
      },
    },
  );
  assert.notEqual(malformedRun.status, 0);
  assert.equal((await readdir(directory)).includes("operations"), false);
  const unreadable = join(directory, "unreadable.json");
  await writeFile(unreadable, "[]", { mode: 0o000 });
  process.env.ALPHADOCK_JOINQUANT_COOKIE_FILE = unreadable;
  await assert.rejects(
    () =>
      prepareRemoteOperation("backtest-submit", "joinquant", {
        strategyId: "strategy-fixture",
      }),
    /cannot be read|empty/,
  );
  assert.equal((await readdir(directory)).includes("operations"), false);
  const valid = join(directory, "valid.json");
  await writeFile(
    valid,
    `[{"name":"session","value":"synthetic","domain":"www.joinquant.com","secure":true}]`,
    { mode: 0o600 },
  );
  process.env.ALPHADOCK_JOINQUANT_COOKIE_FILE = valid;
  const prepared = await prepareRemoteOperation(
    "strategy-create",
    "joinquant",
    { name: "fixture" },
    "print(1)",
  );
  assert.equal(prepared.operation.value.stage, "prepared");
  prepared.operation.value.stage = "write-attempted";
  await updateJournal(prepared.operation.path, prepared.operation.value);
  await assert.rejects(
    () =>
      prepareRemoteOperation(
        "strategy-create",
        "joinquant",
        { name: "fixture" },
        "print(1)",
      ),
    /will not be replayed/,
  );
  const backtest = await prepareRemoteOperation(
    "backtest-submit",
    "joinquant",
    {
      strategyId: "strategy-fixture",
      start: "2024-01-01",
      end: "2024-01-02",
      cash: 1,
      frequency: "day",
    },
  );
  assert.equal(backtest.operation.value.stage, "prepared");
  delete process.env.ALPHADOCK_JOINQUANT_COOKIE_FILE;
});

test("pre-existing insecure state home is rejected without chmod while fresh state is private", async () => {
  const parent = await mkdtemp(join(tmpdir(), "alphadock-state-"));
  const insecure = join(parent, "existing");
  await mkdir(insecure, { mode: 0o755 });
  await chmod(insecure, 0o755);
  process.env.ALPHADOCK_HOME = insecure;
  await assert.rejects(
    () => createJournal("strategy-create", "joinquant", { name: "fixture" }),
    /must be private/,
  );
  assert.equal((await stat(insecure)).mode & 0o777, 0o755);
  const fresh = join(parent, "fresh");
  process.env.ALPHADOCK_HOME = fresh;
  await createJournal("strategy-create", "joinquant", { name: "fresh" });
  assert.equal((await stat(fresh)).mode & 0o777, 0o700);
});

test("output preflight creates missing parents, preserves modes, and reports stable collisions/errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphadock-output-"));
  const parent = join(root, "existing");
  await mkdir(parent, { mode: 0o750 });
  await chmod(parent, 0o750);
  const nested = join(parent, "new", "result.json");
  await assertOutputAvailable(nested);
  assert.equal((await stat(parent)).mode & 0o777, 0o750);
  await exclusiveOutput(nested, { ok: true });
  await assert.rejects(
    () => assertOutputAvailable(nested),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string; stage?: string }).code === "OUTPUT_EXISTS" &&
      (error as { stage?: string }).stage === "output",
  );
  const invalidParent = join(root, "not-a-directory");
  await writeFile(invalidParent, "fixture");
  await assert.rejects(
    () => assertOutputAvailable(join(invalidParent, "result.json")),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string; stage?: string }).code ===
        "OUTPUT_UNAVAILABLE" &&
      (error as { stage?: string }).stage === "output",
  );
});

test("private operation journals hash source, omit source and credentials, and output is exclusive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphadock-home-"));
  process.env.ALPHADOCK_HOME = directory;
  const operation = await createJournal(
    "strategy-create",
    "joinquant",
    { name: "fixture" },
    "print('secret source')",
  );
  const body = await readFile(operation.path, "utf8");
  assert.doesNotMatch(body, /secret source|cookie|token/i);
  assert.match(body, /sourceSha256/);
  assert.equal((await stat(operation.path)).mode & 0o777, 0o600);
  await assert.rejects(
    () =>
      createJournal(
        "strategy-create",
        "joinquant",
        { name: "fixture" },
        "print('secret source')",
      ),
    /will not be replayed/,
  );
  const output = join(directory, "result.json");
  await exclusiveOutput(output, { ok: true });
  await assert.rejects(
    () => exclusiveOutput(output, { ok: false }),
    /already exists/,
  );
});

function cli(...args: string[]) {
  return spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      ALPHADOCK_HOME: join(tmpdir(), "alphadock-cli-no-config"),
    },
  });
}
test("help and API catalog are offline and CLI validation happens before credentials", () => {
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /notebook|backtest|api/);
  const api = cli("api", "show", "get_price", "--platform", "joinquant");
  assert.equal(api.status, 0);
  assert.match(api.stdout, /live-verified|Minimal example/);
  const invalid = cli(
    "backtest",
    "submit",
    "--platform",
    "supermind",
    "--strategy-id",
    "bad/id",
    "--start",
    "2024-02-30",
    "--end",
    "2024-03-01",
    "--cash",
    "NaN",
    "--frequency",
    "day",
    "--confirm-remote-execution",
  );
  assert.notEqual(invalid.status, 0);
  const parsed = JSON.parse(invalid.stdout) as {
    error: { stage: string; code: string };
  };
  assert.equal(parsed.error.stage, "input");
  assert.equal(parsed.error.code, "INVALID_ID");
});

test("date, cash and ID validators accept valid forms and reject effects-unsafe values", () => {
  assert.equal(assertId("fixture-id_01", "id"), "fixture-id_01");
  assert.equal(parseDate("2024-02-29", "date"), "2024-02-29");
  assert.equal(parsePositive("100000.50"), 100000.5);
  assert.throws(() => assertId("../secret", "id"), /invalid format/);
  assert.throws(() => parseDate("2024-02-30", "date"), /calendar date/);
  assert.throws(() => parsePositive("Infinity"), /finite positive/);
  assert.throws(() => parsePositive("-1"), /finite positive/);
});

test("bounded wait timeout does not mark or cancel a running remote task", async () => {
  let now = 0,
    reads = 0,
    sleeps = 0;
  const status = await waitForTerminal(
    async () => {
      reads++;
      return { state: "running" };
    },
    100,
    20,
    () => now,
    async (milliseconds) => {
      sleeps++;
      now += milliseconds;
    },
  );
  assert.equal(status, undefined);
  assert.equal(reads, 6);
  assert.equal(sleeps, 5);
});

test("unknown platform and unknown flag exit nonzero", () => {
  assert.notEqual(cli("api", "list", "--platform", "other").status, 0);
  assert.notEqual(
    cli("api", "list", "--platform", "joinquant", "--surprise").status,
    0,
  );
});
