import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeHttp, type Transport } from "../src/http.js";
import { JoinQuantClient } from "../src/platforms/joinquant.js";
import { SuperMindClient } from "../src/platforms/supermind.js";
import { createJournal, updateJournal } from "../src/storage.js";

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: new Headers(headers),
    body: new Blob([text]).stream(),
  };
}
const jqForm = (code = "") =>
  `<form><input name="algorithm[algorithmId]" value="strategy-fixture"><input name="algorithm[name]" value="fixture"><input name="encrType" value="stale"><textarea id="code" name="algorithm[code]">${code}</textarea></form><script>tokenData={name:'csrf_fixture',value:'synthetic'}</script>`;

test("JoinQuant deterministic HTTP flow preserves IDs, string status, query IDs, and one submit", async () => {
  let saved = false,
    buildCount = 0;
  const calls: string[] = [];
  const transport: Transport = async (url, init) => {
    const parsed = new URL(url);
    calls.push(`${init.method} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname.endsWith("/new"))
      return response(`${jqForm()} algorithmId='strategy-fixture'`);
    if (parsed.pathname.endsWith("/save")) {
      saved = true;
      return response({
        status: "0",
        data: { algorithmId: "strategy-fixture" },
      });
    }
    if (parsed.pathname.endsWith("/edit"))
      return response(jqForm(saved ? "print(&quot;fixture&quot;)" : ""));
    if (parsed.pathname.endsWith("/all")) return response("<table></table>");
    if (parsed.pathname.endsWith("/build")) {
      buildCount++;
      return response({ status: 0, data: { backtestId: "backtest-fixture" } });
    }
    if (parsed.pathname.endsWith("/detail"))
      return response(
        `<input id="backtestId" value="internal-fixture"><script>tokenData={name:'csrf_fixture',value:'synthetic'}</script>`,
      );
    if (parsed.pathname.endsWith("/result"))
      return response({ status: "0", data: { state: "2" } });
    if (parsed.pathname.endsWith("/stats"))
      return response({ status: "0", data: { algorithm_return: 0.01 } });
    if (parsed.pathname.endsWith("/transactionInfo"))
      return response({
        status: "0",
        data: {
          status: 2,
          max: false,
          transaction: [
            {
              date: "2024-01-02",
              time: "09:30:00",
              security: "股票",
              stock: "平安银行(000001.XSHE)",
              transaction: "买",
              type: "市价单",
              amount: "100股",
              price: "7.89",
              total: 789,
              commission: 5,
              status: "全部成交",
            },
          ],
        },
      });
    return response({ status: "0", data: { logArr: [] } });
  };
  const client = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), transport),
  );
  const identities: string[] = [];
  const strategy = await client.createStrategy(
    "fixture",
    'print("fixture")',
    async (id) => {
      identities.push(id);
    },
  );
  assert.equal(strategy.codeReadback, true);
  assert.deepEqual(identities, ["strategy-fixture"]);
  const submitted = await client.submitBacktest(
    {
      strategyId: "strategy-fixture",
      start: "2024-01-02",
      end: "2024-01-05",
      cash: 100000,
      frequency: "day",
    },
    async (id) => {
      identities.push(id);
    },
  );
  assert.equal(submitted.completed, false);
  assert.equal(buildCount, 1);
  const result = await client.backtestResult("backtest-fixture");
  assert.equal(result.verified, true);
  assert.equal(Array.isArray(result.trades), true);
  assert.equal((result.trades as unknown[]).length, 1);
  assert.equal(
    ((result.trades as Record<string, unknown>[])[0] as Record<string, unknown>)
      .stock,
    "平安银行(000001.XSHE)",
  );
  assert.deepEqual((result.bounds as Record<string, unknown>).transactionMeta, {
    returnedCount: 1,
    max: false,
    status: 2,
  });
  assert.ok(
    calls.some((call) => call.includes("/result?backtestId=internal-fixture")),
  );
  assert.ok(
    calls.some((call) =>
      call.includes("/transactionInfo?backtestId=internal-fixture"),
    ),
  );
});

test("JoinQuant build sends exact UTF-8 Base64 saved code and explicit parameters once", async () => {
  const code = "print('你好 🌊')";
  let buildBody = "",
    buildReferer: string | null = null,
    builds = 0;
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/all")) return response("<table></table>");
    if (path.endsWith("/edit")) return response(jqForm(code));
    if (path.endsWith("/build")) {
      builds++;
      buildBody = String(init.body);
      const headers = new Headers(init.headers);
      buildReferer = headers.get("referer");
      return response({
        status: "0",
        data: { backtestId: "backtest-unicode" },
      });
    }
    return response("");
  };
  const client = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), transport),
  );
  await client.submitBacktest(
    {
      strategyId: "strategy-fixture",
      start: "2024-02-01",
      end: "2024-02-29",
      cash: 123456.5,
      frequency: "minute",
    },
    async () => {},
  );
  const form = new URLSearchParams(buildBody);
  assert.equal(
    Buffer.from(form.get("algorithm[code]") ?? "", "base64").toString("utf8"),
    code,
  );
  assert.equal(form.get("encrType"), "base64");
  assert.equal(form.get("backtest[startTime]"), "2024-02-01");
  assert.equal(form.get("backtest[endTime]"), "2024-02-29");
  assert.equal(form.get("backtest[baseCapital]"), "123456.5");
  assert.equal(form.get("backtest[frequency]"), "minute");
  assert.equal(
    buildReferer,
    "https://www.joinquant.com/algorithm/index/edit?algorithmId=strategy-fixture",
  );
  assert.equal(builds, 1);
});

test("JoinQuant backtestResult handles empty transaction array as verified empty data and rejects invalid transaction payloads", async () => {
  const baseTransport =
    (transactionPayload: unknown): Transport =>
    async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/detail"))
        return response(
          `<input id="backtestId" value="internal-fixture"><script>tokenData={name:'csrf_fixture',value:'synthetic'}</script>`,
        );
      if (path.endsWith("/result"))
        return response({ status: "0", data: { state: "2" } });
      if (path.endsWith("/stats"))
        return response({ status: "0", data: { algorithm_return: 0.01 } });
      if (path.endsWith("/transactionInfo"))
        return response({ status: "0", data: transactionPayload });
      return response({ status: "0", data: { logArr: [] } });
    };

  // 1. Empty transaction array -> verified empty data []
  const emptyClient = new JoinQuantClient(
    new SafeHttp(
      "joinquant",
      new CookieJar(),
      baseTransport({ status: 2, max: false, transaction: [] }),
    ),
  );
  const emptyResult = await emptyClient.backtestResult("backtest-fixture");
  assert.equal(emptyResult.verified, true);
  assert.deepEqual(emptyResult.trades, []);
  assert.deepEqual(
    (emptyResult.bounds as Record<string, unknown>).transactionMeta,
    { returnedCount: 0, max: false, status: 2 },
  );

  // 1b. Capped response (max: true) surfaces returnedCount truthfully without fabricating total
  const cappedClient = new JoinQuantClient(
    new SafeHttp(
      "joinquant",
      new CookieJar(),
      baseTransport({
        status: 2,
        max: true,
        transaction: [
          {
            date: "2024-01-02",
            stock: "平安银行(000001.XSHE)",
            amount: 100,
            price: 7.89,
          },
        ],
      }),
    ),
  );
  const cappedResult = await cappedClient.backtestResult("backtest-fixture");
  assert.equal(cappedResult.verified, true);
  assert.equal((cappedResult.trades as unknown[]).length, 1);
  assert.deepEqual(
    (cappedResult.bounds as Record<string, unknown>).transactionMeta,
    { returnedCount: 1, max: true, status: 2 },
  );

  // 2. Malformed / missing transaction array or invalid row records -> fails closed with RESULT_UNVERIFIED
  for (const badPayload of [
    {},
    { transaction: "not-an-array" },
    { transaction: [null] },
    { transaction: [123] },
    { transaction: [[]] },
    { transaction: [{ stock: "", amount: 100, price: 7.89 }] },
    {
      transaction: [
        { stock: "平安银行(000001.XSHE)", amount: null, price: 7.89 },
      ],
    },
    {
      transaction: [{ stock: "平安银行(000001.XSHE)", amount: 100, price: {} }],
    },
    null,
  ]) {
    const badClient = new JoinQuantClient(
      new SafeHttp("joinquant", new CookieJar(), baseTransport(badPayload)),
    );
    await assert.rejects(
      () => badClient.backtestResult("backtest-fixture"),
      /Terminal status lacked verified transaction records|Transaction record has an unexpected shape|Transaction record lacks required trade fields/,
    );
  }

  // 3. Failed backtest: logs retrievable without transactionInfo call and trades is null
  let transactionCalledOnFail = false;
  const failTransport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/detail"))
      return response(
        `<input id="backtestId" value="internal-fixture"><script>tokenData={name:'csrf_fixture',value:'synthetic'}</script>`,
      );
    if (path.endsWith("/result"))
      return response({ status: "0", data: { state: "3" } });
    if (path.endsWith("/stats")) return response({ status: "0", data: {} });
    if (path.endsWith("/error"))
      return response({
        status: "0",
        data: { logArr: ["ValueError: intentional error"] },
      });
    if (path.endsWith("/log"))
      return response({ status: "0", data: { logArr: [] } });
    if (path.endsWith("/transactionInfo")) {
      transactionCalledOnFail = true;
      return response({ status: "0", data: { transaction: [] } });
    }
    return response({ status: "0", data: {} });
  };
  const failClient = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), failTransport),
  );
  const failResult = await failClient.backtestResult("backtest-fixture");
  assert.equal(failResult.state, "failed");
  assert.equal(failResult.verified, false);
  assert.equal(failResult.trades, null);
  assert.equal(transactionCalledOnFail, false);
  assert.deepEqual((failResult.errorLogs as Record<string, unknown>).logArr, [
    "ValueError: intentional error",
  ]);
});

test("JoinQuant auth accepts positive state with shared login bundle and rejects logged-out or ambiguous HTML", async () => {
  const positiveHtml = `<script>g_isLogin=true</script><a href="/algorithm/index/edit?algorithmId=strategy-fixture">edit</a><script src="/dist/static_v2/global/user/login/index/index.module.bundle.js"></script>`;
  const positive = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), async () =>
      response(positiveHtml),
    ),
  );
  assert.equal((await positive.authStatus()).authenticated, true);
  for (const html of [
    `<script>g_isLogin=false</script><a href="/algorithm/index/edit?algorithmId=x">edit</a>`,
    `<a href="/algorithm/index/edit?algorithmId=x">edit</a>`,
  ]) {
    const client = new JoinQuantClient(
      new SafeHttp("joinquant", new CookieJar(), async () => response(html)),
    );
    await assert.rejects(
      () => client.authStatus(),
      /authentication was not verified/,
    );
  }
  const redirected = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), async (url) =>
      new URL(url).pathname.endsWith("/list")
        ? response("", 302, { location: "/user/login" })
        : response(`<form>login</form>`),
    ),
  );
  await assert.rejects(
    () => redirected.authStatus(),
    /authentication was not verified/,
  );
});

test("JoinQuant preserves create redirect identity durably before a failing editor hop", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "alphadock-redirect-journal-"),
  );
  process.env.ALPHADOCK_HOME = directory;
  const operation = await createJournal(
    "strategy-create",
    "joinquant",
    { name: "redirect-fixture" },
    "print(1)",
  );
  let calls = 0;
  const transport: Transport = async () => {
    calls++;
    if (calls === 1)
      return response("unused", 302, {
        location: "/algorithm/index/edit?algorithmId=created-fixture",
      });
    throw new Error("synthetic next-hop failure");
  };
  const client = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), transport),
  );
  await assert.rejects(
    () =>
      client.createStrategy("redirect-fixture", "print(1)", async (id) => {
        operation.value.strategyId = id;
        operation.value.strategyIds = [id];
        operation.value.stage = "identity-preserved";
        await updateJournal(operation.path, operation.value);
      }),
    /Remote request failed/,
  );
  assert.equal(calls, 2);
  const journal = JSON.parse(await readFile(operation.path, "utf8")) as {
    strategyId: string;
    stage: string;
  };
  assert.deepEqual(journal, {
    ...journal,
    strategyId: "created-fixture",
    stage: "identity-preserved",
  });
});

test("JoinQuant preserves a created strategy ID before a save failure", async () => {
  const identities: string[] = [];
  let saveAttempts = 0;
  const transport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/new"))
      return response(
        `${jqForm()} algorithmId='strategy-partial'`.replaceAll(
          "strategy-fixture",
          "strategy-partial",
        ),
      );
    saveAttempts++;
    return response({ status: 1 });
  };
  const client = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), transport),
  );
  await assert.rejects(
    () =>
      client.createStrategy("fixture", "print(1)", async (id) => {
        identities.push(id);
      }),
    /unsuccessful status/,
  );
  assert.deepEqual(identities, ["strategy-partial"]);
  assert.equal(saveAttempts, 1);
});

test("JoinQuant concurrency and charge responses refuse submission without continuation", async () => {
  let builds = 0;
  const concurrencyTransport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/all"))
      return response(
        "<table><tr><td>进行中</td></tr><tr><td>进行中</td></tr></table>",
      );
    builds++;
    return response("");
  };
  const concurrent = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), concurrencyTransport),
  );
  await assert.rejects(
    () =>
      concurrent.submitBacktest(
        {
          strategyId: "strategy-fixture",
          start: "2024-01-02",
          end: "2024-01-05",
          cash: 1,
          frequency: "day",
        },
        async () => {},
      ),
    /two running/,
  );
  assert.equal(builds, 0);
  const chargeTransport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/all")) return response("<table></table>");
    if (path.endsWith("/edit")) return response(jqForm("print(1)"));
    return response({ status: 1, code: "30000" });
  };
  const charged = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), chargeTransport),
  );
  await assert.rejects(
    () =>
      charged.submitBacktest(
        {
          strategyId: "strategy-fixture",
          start: "2024-01-02",
          end: "2024-01-05",
          cash: 1,
          frequency: "day",
        },
        async () => {},
      ),
    /charge or credit confirmation/,
  );
});

test("JoinQuant dropped submit response is not retried", async () => {
  let attempts = 0;
  const transport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/all")) return response("<table></table>");
    if (path.endsWith("/edit")) return response(jqForm('print("x")'));
    if (path.endsWith("/build")) {
      attempts++;
      throw new Error("synthetic drop");
    }
    return response("");
  };
  const client = new JoinQuantClient(
    new SafeHttp("joinquant", new CookieJar(), transport),
  );
  await assert.rejects(
    () =>
      client.submitBacktest(
        {
          strategyId: "strategy-fixture",
          start: "2024-01-02",
          end: "2024-01-05",
          cash: 1,
          frequency: "day",
        },
        async () => {},
      ),
    /Remote request failed/,
  );
  assert.equal(attempts, 1);
});

test("SuperMind deterministic create, readback, submit, status, metrics/trades/log envelopes", async () => {
  let runCount = 0;
  const transport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/getauthdata"))
      return response({ errorcode: 0, result: { engine_enabled: true } });
    if (path.endsWith("/algorithms/add/"))
      return response({ errorcode: 0, result: { _id: "strategy-fixture" } });
    if (path.endsWith("/algorithms/queryinfo/"))
      return response({
        errorcode: 0,
        result: { _id: "strategy-fixture", algo_code: 'print("fixture")' },
      });
    if (path.endsWith("/backtest/run/")) {
      runCount++;
      return response({
        errorcode: 0,
        result: { backtest_id: "backtest-fixture" },
      });
    }
    if (path.endsWith("/backtest/queryinfo/"))
      return response({
        errorcode: 0,
        result: {
          _id: "backtest-fixture",
          status: "SUCCESS",
          begin_date: "2024-01-02",
          end_date: "2024-01-05",
          capital_base: 100000,
          frequency: "DAILY",
          run_env: "py38",
        },
      });
    if (path.endsWith("/backtest/backtestperformance"))
      return response({
        errorcode: 0,
        result: { yield: null, max_drawdown: 0.001 },
      });
    if (path.endsWith("/backtest/tradelog"))
      return response({
        errorcode: 0,
        result: { data: [], total: 0, message: "" },
      });
    return response({ errorcode: 0, result: { total: 4, list: [] } });
  };
  const client = new SuperMindClient(
    new SafeHttp("supermind", new CookieJar(), transport),
  );
  assert.equal((await client.authStatus()).authenticated, true);
  const ids: string[] = [];
  await client.createStrategy("fixture", 'print("fixture")', async (id) => {
    ids.push(id);
  });
  await client.submitBacktest(
    {
      strategyId: "strategy-fixture",
      start: "2024-01-02",
      end: "2024-01-05",
      cash: 100000,
      frequency: "day",
    },
    async (id) => {
      ids.push(id);
    },
  );
  assert.equal(runCount, 1);
  assert.deepEqual(ids, ["strategy-fixture", "backtest-fixture"]);
  const result = await client.backtestResult("backtest-fixture");
  assert.equal(result.verified, true);
  assert.deepEqual((result.metrics as Record<string, unknown>).yield, null);
  assert.deepEqual((result.errorLogs as Record<string, unknown>).list, []);
});

test("SuperMind unknown status fails closed", async () => {
  const transport: Transport = async () =>
    response({
      errorcode: 0,
      result: { _id: "backtest-fixture", status: "MYSTERY" },
    });
  const client = new SuperMindClient(
    new SafeHttp("supermind", new CookieJar(), transport),
  );
  await assert.rejects(
    () => client.backtestStatus("backtest-fixture"),
    /unknown backtest state/,
  );
});

test("SuperMind failed backtest returns logs with null metrics and trades without calling performance", async () => {
  let performanceQueried = false;
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/backtest/queryinfo/"))
      return response({
        errorcode: 0,
        result: {
          _id: "backtest-fail",
          status: "FAIL",
          begin_date: "2024-01-02",
          end_date: "2024-01-05",
          capital_base: 100000,
          frequency: "DAILY",
          run_env: "py38",
        },
      });
    if (path.endsWith("/backtest/backtestperformance")) {
      performanceQueried = true;
      return response({
        errorcode: 404,
        errormsg: "该backtest运行失败,没有数据",
        result: "",
      });
    }
    if (path.endsWith("/backtest/backtestlog/")) {
      const body = String(init?.body ?? "");
      if (body.includes("type=ERROR")) {
        return response({
          errorcode: 0,
          result: {
            total: 1,
            list: [{ type: "ERROR", value: "Intentional failure" }],
          },
        });
      }
      return response({
        errorcode: 0,
        result: {
          total: 2,
          list: [
            { type: "INFO", value: "Start" },
            { type: "ERROR", value: "Intentional failure" },
          ],
        },
      });
    }
    return response({ errorcode: 0, result: {} });
  };
  const client = new SuperMindClient(
    new SafeHttp("supermind", new CookieJar(), transport),
  );
  const result = await client.backtestResult("backtest-fail");
  assert.equal(result.state, "failed");
  assert.equal(result.verified, false);
  assert.equal(result.metrics, null);
  assert.equal(result.trades, null);
  assert.equal(performanceQueried, false);
  assert.equal((result.errorLogs as { total: number }).total, 1);
  assert.equal((result.strategyLogs as { total: number }).total, 2);

  // Assert that log errors (e.g. auth/network error while fetching logs) are not swallowed
  const errorTransport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/backtest/queryinfo/"))
      return response({
        errorcode: 0,
        result: {
          _id: "backtest-fail",
          status: "FAIL",
          begin_date: "2024-01-02",
          end_date: "2024-01-05",
          capital_base: 100000,
          frequency: "DAILY",
          run_env: "py38",
        },
      });
    return response({ errorcode: -1, errormsg: "Session expired" });
  };
  const errorClient = new SuperMindClient(
    new SafeHttp("supermind", new CookieJar(), errorTransport),
  );
  await assert.rejects(
    () => errorClient.backtestResult("backtest-fail"),
    /SuperMind returned an unsuccessful status/,
  );

  // Assert that SUCCESS with unavailable/empty performance metrics still fails closed
  const emptyMetricsTransport: Transport = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/backtest/queryinfo/"))
      return response({
        errorcode: 0,
        result: {
          _id: "backtest-success",
          status: "SUCCESS",
          begin_date: "2024-01-02",
          end_date: "2024-01-05",
          capital_base: 100000,
          frequency: "DAILY",
          run_env: "py38",
        },
      });
    if (path.endsWith("/backtest/backtestperformance"))
      return response({ errorcode: 0, result: {} });
    return response({ errorcode: 0, result: { total: 0, list: [] } });
  };
  const emptyMetricsClient = new SuperMindClient(
    new SafeHttp("supermind", new CookieJar(), emptyMetricsTransport),
  );
  await assert.rejects(
    () => emptyMetricsClient.backtestResult("backtest-success"),
    /Terminal status lacked verified performance metrics/,
  );
});
