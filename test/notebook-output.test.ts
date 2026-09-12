import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CookieJar } from "tough-cookie";
import { CliError, publicError } from "../src/errors.js";
import {
  executeKernel,
  notebookByteLimit,
  type SocketFactory,
} from "../src/jupyter.js";

const session = {
  base: "https://supermind.10jqka.com.cn/notebook/user/private-user/",
  kernels: [],
};

function fixture(
  run: (
    socket: EventEmitter,
    emit: (type: string, content: object) => void,
  ) => void,
) {
  let sends = 0;
  let closes = 0;
  let payload = 0;
  const factory: SocketFactory = (_url, options) => {
    payload = options.maxPayload;
    const socket = Object.assign(new EventEmitter(), {
      send(data: string) {
        sends++;
        const id = JSON.parse(data).header.msg_id;
        const emit = (type: string, content: object) =>
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                parent_header: { msg_id: id },
                header: { msg_type: type },
                content,
              }),
            ),
          );
        queueMicrotask(() => run(socket, emit));
      },
      close() {
        closes++;
      },
    });
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };
  return { factory, counts: () => ({ sends, closes, payload }) };
}

function completed(emit: (type: string, content: object) => void) {
  emit("execute_reply", { status: "ok" });
  emit("status", { execution_state: "idle" });
}

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

test("large single stream and many streams preserve Unicode, CSV boundary and SHA256 exactly", async () => {
  const text = "CB_BEGIN\n" + "中文😀,value\n".repeat(18000) + "CB_END\n";
  for (const chunks of [[text], text.match(/[\s\S]{1,7000}/g)!]) {
    const mock = fixture((_socket, emit) => {
      for (const chunk of chunks)
        emit("stream", { name: "stdout", text: chunk });
      completed(emit);
      // Events after completion must not mutate the returned report.
      emit("stream", { text: "late-private-data" });
    });
    const result = await executeKernel(
      session,
      "private-kernel",
      "private-code",
      new CookieJar(),
      1000,
      2_000_000,
      mock.factory,
      1_000_000,
    );
    assert.equal(result.state, "completed");
    assert.equal(result.streams.map((s) => s.text).join(""), text);
    assert.equal(
      digest(result.streams.map((s) => s.text).join("")),
      digest(text),
    );
    assert.deepEqual(mock.counts(), {
      sends: 1,
      closes: 1,
      payload: 1_000_000,
    });
  }
});

test("display and error values are not silently shortened either", async () => {
  const text = "长".repeat(110000);
  const mock = fixture((_socket, emit) => {
    emit("display_data", { data: { "text/plain": text } });
    emit("error", { ename: "ValueError", evalue: text });
    completed(emit);
  });
  const result = await executeKernel(
    session,
    "fixture",
    "pass",
    new CookieJar(),
    1000,
    1_000_000,
    mock.factory,
  );
  assert.equal(result.state, "failed");
  assert.equal(result.displays[0]?.text, text);
  assert.equal(result.errors[0]?.value, text);
});

test("total and per-message limits fail explicitly, count UTF-8 wire bytes and never retry", async () => {
  for (const kind of ["total", "message"] as const) {
    const mock = fixture((_socket, emit) => {
      for (let i = 0; i < 10; i++) emit("stream", { text: "中".repeat(100) });
      completed(emit);
    });
    await assert.rejects(
      executeKernel(
        session,
        "fixture",
        "pass",
        new CookieJar(),
        1000,
        kind === "total" ? 800 : 5000,
        mock.factory,
        kind === "message" ? 200 : 600,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "OUTPUT_LIMIT");
        assert.equal(
          error.diagnostics?.causeCode,
          kind === "total"
            ? "TOTAL_BYTES_LIMIT"
            : "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
        );
        assert.equal(error.diagnostics?.reply, "missing");
        assert.equal(error.diagnostics?.idle, false);
        assert.ok(
          error.diagnostics!.receivedBytes! > (kind === "total" ? 800 : 200),
        );
        return true;
      },
    );
    assert.equal(mock.counts().sends, 1);
    assert.equal(mock.counts().closes, 1);
  }
});

test("ws errors and close codes are sanitized without claiming completion", async () => {
  for (const cause of [
    "ECONNRESET",
    "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
    "private-secret",
    "close",
  ]) {
    const mock = fixture((socket, emit) => {
      emit("stream", { text: "private-response" });
      emit("execute_reply", { status: "ok" });
      if (cause === "close")
        socket.emit("close", 1006, Buffer.from("private-reason"));
      else
        socket.emit(
          "error",
          Object.assign(new Error("private-message"), { code: cause }),
        );
    });
    await assert.rejects(
      executeKernel(
        session,
        "private-kernel",
        "private-code",
        new CookieJar(),
        1000,
        5000,
        mock.factory,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(
          error.code,
          cause === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            ? "OUTPUT_LIMIT"
            : "EXECUTION_UNVERIFIED",
        );
        const diag = error.diagnostics!;
        assert.equal(diag.operation, "notebook_execute");
        assert.equal(diag.failurePhase, "channel");
        assert.equal(
          diag.causeCode,
          cause === "close" || cause === "private-secret" ? "UNKNOWN" : cause,
        );
        assert.equal(diag.reply, "ok");
        assert.equal(diag.idle, false);
        assert.equal(diag.receivedMessages, 2);
        if (cause === "close") assert.equal(diag.closeCode, 1006);
        assert.doesNotMatch(JSON.stringify(publicError(error)), /private-/);
        return true;
      },
    );
    assert.equal(mock.counts().sends, 1);
  }
});

test("invalid limits fail before opening a socket, and constructor failures remain safe", async () => {
  for (const value of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    64_000_001,
    "1e6",
    "private",
  ]) {
    assert.throws(() => notebookByteLimit(value), /integers/);
  }
  assert.equal(notebookByteLimit("64000000"), 64_000_000);
  let calls = 0;
  const factory: SocketFactory = () => {
    calls++;
    throw new Error("private-secret");
  };
  await assert.rejects(
    executeKernel(
      session,
      "fixture",
      "pass",
      new CookieJar(),
      1000,
      0,
      factory,
    ),
    /integers/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    executeKernel(
      session,
      "fixture",
      "pass",
      new CookieJar(),
      1000,
      1000,
      factory,
    ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "EXECUTION_UNVERIFIED");
      assert.doesNotMatch(JSON.stringify(publicError(error)), /private-/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("CLI validates byte limits before reading source or authentication", () => {
  for (const flag of ["--max-output-bytes", "--max-message-bytes"]) {
    try {
      execFileSync(
        process.execPath,
        [
          "dist/cli.js",
          "notebook",
          "exec",
          "/nonexistent-source.py",
          "--platform",
          "supermind",
          "--temporary",
          "--confirm-remote-execution",
          flag,
          "64000001",
        ],
        { encoding: "utf8", stdio: "pipe" },
      );
      assert.fail("Expected input rejection");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      assert.ok(stdout);
      assert.equal(JSON.parse(stdout).error.code, "INVALID_OUTPUT_LIMIT");
    }
  }
});
