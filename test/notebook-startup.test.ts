import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import { SafeHttp, type HttpResponse, type Transport } from "../src/http.js";
import { CliError, publicError } from "../src/errors.js";
import { startNotebookServer } from "../src/notebook-startup.js";
import { notebookSession } from "../src/jupyter.js";

const origin = "https://supermind.10jqka.com.cn";
const form = '<form method="post" action="/notebook/hub/spawn"><label><input name="profile" type="radio" value="py35" checked>Python 3.5 默认环境</label><label><input name="profile" type="radio" value="opaque38">Python 3.8 升级Python环境</label><input type="submit" value="Start"></form>';
const page = (body = form): HttpResponse => ({ status: 200, url: new URL(origin + "/notebook/hub/spawn"), headers: new Headers(), body });
const state = (ready = false, pending: string | null = null) => JSON.stringify({ name: "fixture", server: ready ? "/notebook/user/fixture/" : null, pending, servers: {} });
const response = (body: string, status = 200, headers = {}) => ({ status, headers: new Headers(headers), body: new Response(body).body });
const controls = { polls: 2, pause: async () => {} };

async function isolated(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "alphadock-start-test-"));
  const previous = process.env.ALPHADOCK_HOME;
  process.env.ALPHADOCK_HOME = dir;
  try { await run(dir); }
  finally {
    if (previous === undefined) delete process.env.ALPHADOCK_HOME;
    else process.env.ALPHADOCK_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("approved Python 3.8 startup submits once, journals before POST and releases only on ready", async () => {
  await isolated(async dir => {
    let posts = 0, reads = 0;
    const jar = new CookieJar();
    await jar.setCookie("_xsrf=fixture-token; Path=/notebook/", origin);
    const http = new SafeHttp("supermind", jar, async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        assert.equal(url, origin + "/notebook/hub/spawn");
        assert.equal(new URLSearchParams(String(init.body)).get("profile"), "opaque38");
        assert.equal(new Headers(init.headers).get("x-xsrftoken"), "fixture-token");
        const files = await readdir(join(dir, "operations"));
        assert.equal(files.length, 1);
        const journal = JSON.parse(await readFile(join(dir, "operations", files[0]!), "utf8"));
        assert.equal(journal.stage, "starting");
        assert.equal(journal.parameters.profile, "python38");
        assert.doesNotMatch(JSON.stringify(journal), /fixture-token|opaque38/);
        return response("", 302, { location: "/notebook/hub/spawn-pending/fixture" });
      }
      assert.equal(url, origin + "/notebook/hub/api/user");
      assert.equal(new Headers(init?.headers).get("origin"), origin);
      assert.equal(new Headers(init?.headers).get("referer"), origin + "/notebook/hub/spawn");
      reads++;
      return response(state(posts > 0));
    });
    const started = await startNotebookServer("supermind", page(), http, jar, controls);
    assert.equal(started.report.profile, "python38");
    assert.equal(started.report.submitted, true);
    assert.equal(posts, 1);
    assert.equal(reads, 3);
    assert.equal((await readdir(join(dir, "server-start-locks"))).length, 0);
  });
});

test("unknown POST outcomes and timeouts retain the lock across another invocation", async () => {
  for (const mode of ["dropped", "timeout", "307"] as const) await isolated(async dir => {
    let posts = 0;
    const jar = new CookieJar();
    const http = new SafeHttp("supermind", jar, async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        if (mode === "dropped") throw new Error("private-network-message");
        if (mode === "307") return response("", 307, { location: "/notebook/hub/spawn" });
        return response("", 202);
      }
      return response(state());
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(startNotebookServer("supermind", page(), http, jar, controls), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "SERVER_START_UNVERIFIED");
        assert.doesNotMatch(JSON.stringify(publicError(error)), /private-/);
        return true;
      });
    }
    assert.equal(posts, 1);
    assert.equal((await readdir(join(dir, "server-start-locks"))).length, 1);
  });
});

test("payment, resource choices, ambiguous profiles and foreign targets block without POST", async () => {
  for (const body of [
    form + '<p>需要支付</p>', form + '<p>验证码</p>',
    form.replace('</form>', '<select name="size"><option>GPU</option></select></form>'),
    form.replace('Python 3.8 升级Python环境', 'Python 3.11(Beta) 升级Python环境'),
    form.replace('</form>', '<label><input type="radio" name="profile" value="duplicate">Python 3.8 升级Python环境</label></form>'),
    form.replace('/notebook/hub/spawn', 'https://example.com/notebook/hub/spawn'),
    form.replace('</form>', '<input name="purchase" value="yes"></form>'),
  ]) await isolated(async () => {
    let posts = 0;
    const jar = new CookieJar();
    const http = new SafeHttp("supermind", jar, async (_url, init) => { if (init?.method === "POST") posts++; return response(state()); });
    await assert.rejects(startNotebookServer("supermind", page(body), http, jar, controls), (error: unknown) => error instanceof CliError && error.code === "SERVER_START_BLOCKED");
    assert.equal(posts, 0);
  });
});

test("existing pending startup is polled without submitting or claiming a Python version", async () => {
  await isolated(async () => {
    let reads = 0, posts = 0;
    const jar = new CookieJar();
    const http = new SafeHttp("supermind", jar, async (_url, init) => {
      if (init?.method === "POST") posts++;
      return response(++reads === 1 ? state(false, "spawn") : state(true));
    });
    const result = await startNotebookServer("supermind", page(), http, jar, controls);
    assert.equal(result.report.submitted, false);
    assert.equal(result.report.profile, undefined);
    assert.equal(posts, 0);
  });
});

test("a delayed contender rechecks after lock acquisition and cannot submit using stale stopped state", async () => {
  await isolated(async () => {
    let running = false, fastPosts = 0, slowPosts = 0, slowReads = 0;
    let captured!: () => void;
    let release!: () => void;
    const capturedRead = new Promise<void>(resolve => { captured = resolve; });
    const releaseRead = new Promise<void>(resolve => { release = resolve; });
    const fastJar = new CookieJar(), slowJar = new CookieJar();
    const fast = new SafeHttp('supermind', fastJar, async (_url, init) => {
      if (init?.method === 'POST') { fastPosts++; running = true; return response('', 202); }
      return response(state(running));
    });
    const slow = new SafeHttp('supermind', slowJar, async (_url, init) => {
      if (init?.method === 'POST') { slowPosts++; return response('', 202); }
      if (++slowReads === 1) { captured(); await releaseRead; return response(state(false)); }
      return response(state(running));
    });
    const delayed = startNotebookServer('supermind', page(), slow, slowJar, controls);
    await capturedRead;
    try {
      const first = await startNotebookServer('supermind', page(), fast, fastJar, controls);
      assert.equal(first.report.submitted, true);
    } finally { release(); }
    const second = await delayed;
    assert.equal(second.report.submitted, false);
    assert.equal(second.report.profile, undefined);
    assert.equal(fastPosts, 1);
    assert.equal(slowPosts, 0);
    assert.equal(slowReads, 2);
  });
});

test("session startup is opt-in and verifies kernels after ready, without code execution", async () => {
  await isolated(async () => {
    let posts = 0;
    const jar = new CookieJar();
    const transport: Transport = async (url, init) => {
      if (url.endsWith('/hub/login')) return response('', 302, { location: '/notebook/hub/spawn' });
      if (url.endsWith('/hub/spawn')) {
        if (init?.method === 'POST') { posts++; return response('', 202); }
        return response(form);
      }
      if (url.endsWith('/hub/api/user')) return response(state(posts > 0));
      if (url.endsWith('/api/kernels')) return response('[]');
      if (url.endsWith('/api/kernelspecs')) return response('{"default":"python3"}');
      throw new Error('Unexpected request');
    };
    const http = new SafeHttp('supermind', jar, transport);
    await assert.rejects(notebookSession('supermind', http), (error: unknown) => error instanceof CliError && error.code === 'SERVER_NOT_READY');
    assert.equal(posts, 0);
    const session = await notebookSession('supermind', http, { startServer: true, jar });
    assert.equal(session.serverStart?.submitted, true);
    assert.equal(session.defaultKernel, 'python3');
    assert.equal(posts, 1);
  });
});
