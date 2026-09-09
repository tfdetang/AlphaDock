import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import { loadCookieJar, parseJsonSequence } from "../src/cookies.js";
import { SafeHttp, type Transport } from "../src/http.js";

async function fixture(value: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alphadock-cookie-"));
  const path = join(dir, "cookies.json");
  await writeFile(path, value);
  return path;
}
function response(
  status: number,
  body = "",
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: new Headers(headers),
    body: new Blob([body]).stream(),
  };
}
function streamedResponse(
  chunks: Uint8Array[],
  hooks: { cancelled?: () => void; failAt?: number } = {},
) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (hooks.failAt === index) {
          controller.error(new Error("synthetic stream failure"));
          return;
        }
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        hooks.cancelled?.();
      },
    },
    { highWaterMark: 0 },
  );
  return { status: 200, headers: new Headers(), body };
}

test("cookie parser supports array, Playwright object, BOM and concatenated objects with escaped braces", async () => {
  const text =
    '\uFEFF[{"name":"host","value":"v}\\"x","domain":"www.joinquant.com","path":"/","secure":true,"hostOnly":true}], {"cookies":[{"name":"domain","value":"d","domain":".joinquant.com","path":"/research"}]} {"name":"expired","value":"x","domain":"www.joinquant.com","expirationDate":1}';
  assert.equal(parseJsonSequence(text).length, 3);
  const jar = await loadCookieJar(await fixture(text));
  assert.match(
    await jar.getCookieString("https://www.joinquant.com/research/a"),
    /host=v%7D%22x|host=/,
  );
  assert.match(
    await jar.getCookieString("https://www.joinquant.com/research/a"),
    /domain=d/,
  );
  assert.doesNotMatch(
    await jar.getCookieString("https://foo.joinquant.com/other"),
    /host=|domain=/,
  );
  assert.doesNotMatch(
    await jar.getCookieString("http://www.joinquant.com/research"),
    /host=/,
  );
  assert.doesNotMatch(
    await jar.getCookieString("https://www.joinquant.com/"),
    /domain=/,
  );
  assert.doesNotMatch(
    await jar.getCookieString("https://www.joinquant.com/"),
    /expired=/,
  );
});

test("cookie parser fails closed on malformed JSON", async () => {
  const path = await fixture('{"name":"x"');
  await assert.rejects(() => loadCookieJar(path), /incomplete JSON/);
});

test("HTTP scopes cookies on every hop and denies malicious redirects", async () => {
  const jar = new CookieJar();
  await jar.setCookie(
    "sid=synthetic; Secure; Path=/",
    "https://www.joinquant.com/",
  );
  const seen: Array<{ url: string; cookie: string | null }> = [];
  const transport: Transport = async (url, init) => {
    const headers = new Headers(init.headers);
    seen.push({ url, cookie: headers.get("cookie") });
    return response(302, "", { location: "https://evil.example/steal" });
  };
  const http = new SafeHttp("joinquant", jar, transport);
  await assert.rejects(
    () => http.request("https://www.joinquant.com/start"),
    /origin is not allowed/,
  );
  assert.equal(seen[0]?.cookie, "sid=synthetic");
  assert.equal(seen.length, 1);
});

test("HTTP response streaming enforces byte caps, preserves split UTF-8, and sanitizes failures", async () => {
  const encoder = new TextEncoder();
  const emoji = encoder.encode("A😀B");
  const utfTransport: Transport = async () =>
    streamedResponse([emoji.slice(0, 3), emoji.slice(3)]);
  assert.equal(
    (
      await new SafeHttp("joinquant", new CookieJar(), utfTransport).request(
        "https://www.joinquant.com/data",
      )
    ).body,
    "A😀B",
  );
  let cancelled = false,
    produced = 0;
  const oversized: Transport = async () => {
    const chunks = [
      encoder.encode("1234"),
      encoder.encode("5678"),
      encoder.encode("never"),
    ];
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          produced++;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { status: 200, headers: new Headers(), body };
  };
  await assert.rejects(
    () =>
      new SafeHttp("joinquant", new CookieJar(), oversized).request(
        "https://www.joinquant.com/data",
        { maxBytes: 5 },
      ),
    /safe limit/,
  );
  assert.equal(cancelled, true);
  assert.equal(produced, 2);
  const failing: Transport = async () =>
    streamedResponse([encoder.encode("ok")], { failAt: 1 });
  await assert.rejects(
    () =>
      new SafeHttp("joinquant", new CookieJar(), failing).request(
        "https://www.joinquant.com/data",
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Remote response body could not be read",
  );
});

test("redirects cancel bodies, refuse cross-origin sensitive forwarding, and persist POST downgrade", async () => {
  for (const status of [307, 308]) {
    let redirectCancelled = false;
    const deniedCalls: string[] = [];
    const denied: Transport = async (url) => {
      deniedCalls.push(url);
      const value = streamedResponse([], {
        cancelled: () => {
          redirectCancelled = true;
        },
      });
      return {
        ...value,
        status,
        headers: new Headers({
          location: "https://supermind.10jqka.com.cn/next",
        }),
      };
    };
    await assert.rejects(
      () =>
        new SafeHttp("supermind", new CookieJar(), denied).request(
          "https://quant.10jqka.com.cn/start",
          {
            method: "POST",
            body: "secret=synthetic",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-xsrftoken": "synthetic",
            },
          },
        ),
      /sensitive request state/,
    );
    assert.equal(deniedCalls.length, 1);
    assert.equal(redirectCancelled, true);
  }
  const hops: Array<{
    method: string;
    contentType: string | null;
    xsrf: string | null;
    body: unknown;
  }> = [];
  const downgrade: Transport = async (url, init) => {
    const headers = new Headers(init.headers);
    hops.push({
      method: String(init.method),
      contentType: headers.get("content-type"),
      xsrf: headers.get("x-xsrftoken"),
      body: init.body,
    });
    return new URL(url).pathname === "/start"
      ? response(302, "unused", { location: "/done" })
      : response(200, "ok");
  };
  assert.equal(
    (
      await new SafeHttp("joinquant", new CookieJar(), downgrade).request(
        "https://www.joinquant.com/start",
        {
          method: "POST",
          body: "x=1",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-xsrftoken": "synthetic",
          },
        },
      )
    ).body,
    "ok",
  );
  assert.deepEqual(hops, [
    {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      xsrf: "synthetic",
      body: "x=1",
    },
    { method: "GET", contentType: null, xsrf: null, body: undefined },
  ]);
});

test("redirect cookie headers are rebuilt from the jar without sibling carryover", async () => {
  const jar = new CookieJar();
  await jar.setCookie(
    "quant=synthetic; Secure; Path=/",
    "https://quant.10jqka.com.cn/",
  );
  const cookies: Array<string | null> = [];
  const transport: Transport = async (url, init) => {
    cookies.push(new Headers(init.headers).get("cookie"));
    return new URL(url).hostname === "quant.10jqka.com.cn"
      ? response(302, "unused", {
          location: "https://supermind.10jqka.com.cn/done",
        })
      : response(200, "ok");
  };
  await new SafeHttp("supermind", jar, transport).request(
    "https://quant.10jqka.com.cn/start",
  );
  assert.deepEqual(cookies, ["quant=synthetic", null]);
});

test("SuperMind sibling hosts remain separate cookie scopes", async () => {
  const jar = new CookieJar();
  await jar.setCookie(
    "quant=synthetic; Secure; Path=/",
    "https://quant.10jqka.com.cn/",
  );
  const cookies: Array<string | null> = [];
  const transport: Transport = async (_url, init) => {
    cookies.push(new Headers(init.headers).get("cookie"));
    return response(200, "{}");
  };
  const http = new SafeHttp("supermind", jar, transport);
  await http.request("https://supermind.10jqka.com.cn/notebook/hub/");
  await http.request("https://quant.10jqka.com.cn/platform/user/getauthdata");
  assert.equal(cookies[0], null);
  assert.equal(cookies[1], "quant=synthetic");
});
