#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    CliError,
    assertId,
    parseDate,
    parsePositive,
    publicError,
} from "./errors.js";
import {
    configure,
    exclusiveOutput,
    assertOutputAvailable,
    updateJournal,
} from "./storage.js";
import { loadCookieJar } from "./cookies.js";
import { clientFor } from "./platform.js";
import {
    notebookSession,
    createKernel,
    deleteKernel,
    executeKernel,
    notebookExecutionReport,
} from "./jupyter.js";
import { catalog, renderCatalog, selectCatalog } from "./catalog.js";
import { waitForTerminal } from "./wait.js";
import { prepareRemoteOperation } from "./operations.js";
function platformOption() {
    return new Option("--platform <platform>", "remote platform")
        .choices(["joinquant", "supermind"])
        .makeOptionMandatory();
}
function emit(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function confirmed(value, code, text) {
    if (value !== true) throw new CliError(code, "input", text);
}
function dateRange(start, end) {
    parseDate(start, "start");
    parseDate(end, "end");
    if (start > end)
        throw new CliError(
            "INVALID_DATE_RANGE",
            "input",
            "start must not be after end",
        );
}
export function buildProgram() {
    const program = new Command()
        .name("alphadock")
        .version("0.1.0")
        .description(
            "Safety-focused CLI for existing JoinQuant and SuperMind sessions",
        )
        .showHelpAfterError()
        .exitOverride();
    const auth = program
        .command("auth")
        .description("Configure and verify cookie-backed authentication");
    auth.command("configure")
        .addOption(platformOption())
        .requiredOption(
            "--cookie-file <path>",
            "external Cookie/Playwright JSON file",
        )
        .action(async ({ platform, cookieFile }) => {
            await loadCookieJar(resolve(cookieFile));
            await configure(platform, cookieFile);
            emit({
                ok: true,
                platform,
                configured: true,
                cookieFile: resolve(cookieFile),
                credentialsStored: false,
            });
        });
    auth.command("status")
        .addOption(platformOption())
        .action(async ({ platform }) => {
            const { client } = await clientFor(platform);
            emit(await client.authStatus());
        });
    const notebook = program
        .command("notebook")
        .description("Use existing remote notebook services");
    notebook
        .command("list")
        .addOption(platformOption())
        .action(async ({ platform }) => {
            const { http } = await clientFor(platform);
            const session = await notebookSession(platform, http);
            emit({
                ok: true,
                platform,
                kernels: session.kernels,
                startedServer: false,
            });
        });
    notebook
        .command("exec")
        .argument("<file>", "local Python file")
        .addOption(platformOption())
        .option("--kernel-id <id>", "explicit existing kernel ID")
        .option(
            "--temporary",
            "create and clean up an AlphaDock-owned temporary kernel",
        )
        .requiredOption(
            "--confirm-remote-execution",
            "acknowledge remote code execution",
        )
        .action(async (file, options) => {
            confirmed(
                options.confirmRemoteExecution,
                "CONFIRMATION_REQUIRED",
                "--confirm-remote-execution is required",
            );
            if (
                Number(Boolean(options.kernelId)) +
                    Number(Boolean(options.temporary)) !==
                1
            )
                throw new CliError(
                    "KERNEL_SELECTION_REQUIRED",
                    "input",
                    "Choose exactly one of --kernel-id or --temporary",
                );
            if (options.kernelId) assertId(options.kernelId, "kernel-id");
            const code = await readFile(resolve(file), "utf8");
            if (!code.trim())
                throw new CliError(
                    "EMPTY_SOURCE",
                    "input",
                    "Python source file is empty",
                );
            const { http, jar } = await clientFor(options.platform);
            const session = await notebookSession(options.platform, http);
            let id = options.kernelId;
            let owned = false;
            if (id && !session.kernels.some((kernel) => kernel.id === id))
                throw new CliError(
                    "KERNEL_NOT_FOUND",
                    "input",
                    "The explicit kernel ID is not in the current session",
                );
            if (options.temporary) {
                id = await createKernel(session, http, jar);
                owned = true;
            }
            if (!id)
                throw new CliError(
                    "KERNEL_SELECTION_REQUIRED",
                    "input",
                    "A kernel must be selected",
                );
            try {
                const result = await executeKernel(session, id, code, jar);
                const cleanedUp = owned
                    ? await deleteKernel(session, id, http, jar).catch(
                          () => false,
                      )
                    : undefined;
                const report = notebookExecutionReport(
                    options.platform,
                    id,
                    owned,
                    result,
                    cleanedUp,
                );
                emit(report);
                if (!report.ok) process.exitCode = 1;
            } catch (error) {
                if (owned) {
                    const cleanedUp = await deleteKernel(
                        session,
                        id,
                        http,
                        jar,
                    ).catch(() => false);
                    if (!cleanedUp)
                        throw new CliError(
                            "EXECUTION_UNVERIFIED",
                            "remote",
                            `Execution was not verified; owned temporary kernel retained or cleanup unverified: ${id}`,
                        );
                }
                throw error;
            }
        });
    const strategy = program
        .command("strategy")
        .description("Create dedicated remote strategies");
    strategy
        .command("create")
        .argument("<file>")
        .addOption(platformOption())
        .requiredOption("--name <name>")
        .requiredOption("--confirm-remote-write")
        .action(async (file, options) => {
            confirmed(
                options.confirmRemoteWrite,
                "CONFIRMATION_REQUIRED",
                "--confirm-remote-write is required",
            );
            if (!options.name.trim() || options.name.length > 120)
                throw new CliError(
                    "INVALID_NAME",
                    "input",
                    "name must contain 1-120 characters",
                );
            const code = await readFile(resolve(file), "utf8");
            if (!code.trim())
                throw new CliError(
                    "EMPTY_SOURCE",
                    "input",
                    "Python source file is empty",
                );
            const { client, operation } = await prepareRemoteOperation(
                "strategy-create",
                options.platform,
                { name: options.name },
                code,
            );
            operation.value.stage = "write-attempted";
            await updateJournal(operation.path, operation.value);
            const result = await client.createStrategy(
                options.name,
                code,
                async (id) => {
                    operation.value.strategyId = assertId(id, "strategy-id");
                    operation.value.strategyIds ??= [];
                    if (
                        !operation.value.strategyIds.includes(
                            operation.value.strategyId,
                        )
                    )
                        operation.value.strategyIds.push(
                            operation.value.strategyId,
                        );
                    operation.value.stage = "identity-preserved";
                    await updateJournal(operation.path, operation.value);
                },
            );
            operation.value.stage = "verified";
            await updateJournal(operation.path, operation.value);
            emit({
                ok: true,
                operationId: operation.value.operationId,
                ...result,
            });
        });
    const backtest = program
        .command("backtest")
        .description("Submit and read existing backtests");
    backtest
        .command("submit")
        .addOption(platformOption())
        .requiredOption("--strategy-id <id>")
        .requiredOption("--start <date>")
        .requiredOption("--end <date>")
        .requiredOption("--cash <amount>")
        .addOption(
            new Option("--frequency <frequency>")
                .choices(["day", "minute"])
                .makeOptionMandatory(),
        )
        .requiredOption("--confirm-remote-execution")
        .action(async (options) => {
            confirmed(
                options.confirmRemoteExecution,
                "CONFIRMATION_REQUIRED",
                "--confirm-remote-execution is required",
            );
            const strategyId = assertId(options.strategyId, "strategy-id");
            dateRange(options.start, options.end);
            const cash = parsePositive(options.cash);
            const parameters = {
                strategyId,
                start: options.start,
                end: options.end,
                cash,
                frequency: options.frequency,
            };
            const { client, operation } = await prepareRemoteOperation(
                "backtest-submit",
                options.platform,
                parameters,
            );
            operation.value.stage = "submit-attempted";
            await updateJournal(operation.path, operation.value);
            const result = await client.submitBacktest(
                parameters,
                async (id) => {
                    operation.value.backtestId = assertId(id, "backtest-id");
                    operation.value.stage = "identity-preserved";
                    await updateJournal(operation.path, operation.value);
                },
            );
            operation.value.stage = "accepted";
            await updateJournal(operation.path, operation.value);
            emit({
                ok: true,
                operationId: operation.value.operationId,
                ...result,
            });
        });
    const addRead = (name) =>
        backtest
            .command(name)
            .addOption(platformOption())
            .requiredOption("--backtest-id <id>")
            .option("--out <file>", "exclusive JSON output file")
            .action(async (options) => {
                const id = assertId(options.backtestId, "backtest-id");
                await assertOutputAvailable(options.out);
                const { client } = await clientFor(options.platform);
                const result =
                    name === "status"
                        ? await client.backtestStatus(id)
                        : await client.backtestResult(id);
                const output = { ok: true, ...result };
                if (options.out) {
                    await exclusiveOutput(options.out, output);
                    emit({
                        ok: true,
                        output: resolve(options.out),
                        backtestId: id,
                    });
                } else emit(output);
            });
    addRead("status");
    addRead("result");
    backtest
        .command("wait")
        .addOption(platformOption())
        .requiredOption("--backtest-id <id>")
        .option("--timeout <seconds>", "bounded wait timeout", "300")
        .option("--interval <seconds>", "poll interval (minimum 20)", "20")
        .option("--out <file>")
        .action(async (options) => {
            const id = assertId(options.backtestId, "backtest-id");
            const timeout = Number(options.timeout),
                interval = Number(options.interval);
            if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86_400)
                throw new CliError(
                    "INVALID_TIMEOUT",
                    "input",
                    "timeout must be between 0 and 86400 seconds",
                );
            if (
                !Number.isFinite(interval) ||
                interval < 20 ||
                interval > timeout
            )
                throw new CliError(
                    "INVALID_INTERVAL",
                    "input",
                    "interval must be at least 20 seconds and no greater than timeout",
                );
            await assertOutputAvailable(options.out);
            const { client } = await clientFor(options.platform);
            let latestState = "unknown";
            const status = await waitForTerminal(
                async () => {
                    const value = await client.backtestStatus(id);
                    latestState = value.state;
                    return value;
                },
                timeout * 1000,
                interval * 1000,
            );
            if (!status) {
                const output = {
                    ok: false,
                    platform: options.platform,
                    backtestId: id,
                    state: "timeout",
                    remoteState: latestState,
                    cancelled: false,
                    failed: false,
                };
                if (options.out) await exclusiveOutput(options.out, output);
                emit(output);
                process.exitCode = 2;
                return;
            }
            const output = { ok: true, ...(await client.backtestResult(id)) };
            if (options.out) {
                await exclusiveOutput(options.out, output);
                emit({
                    ok: true,
                    output: resolve(options.out),
                    backtestId: id,
                });
            } else emit(output);
        });
    const api = program
        .command("api")
        .description(
            "Offline curated API subset (never loads credentials or uses network)",
        );
    const category = new Option("--category <category>").choices([
        "data",
        "strategy",
        "backtest",
    ]);
    api.command("list")
        .addOption(platformOption())
        .addOption(category)
        .action(({ platform, category: selected }) => {
            process.stdout.write(
                `${renderCatalog(selectCatalog(platform, undefined, selected))}\n`,
            );
        });
    api.command("search")
        .argument("<query>")
        .addOption(platformOption())
        .addOption(
            new Option("--category <category>").choices([
                "data",
                "strategy",
                "backtest",
            ]),
        )
        .action((query, { platform, category: selected }) => {
            process.stdout.write(
                `${renderCatalog(selectCatalog(platform, query, selected))}\n`,
            );
        });
    api.command("show")
        .argument("<name>")
        .addOption(platformOption())
        .action((name, { platform }) => {
            process.stdout.write(
                `${renderCatalog(catalog.filter((entry) => entry.platform === platform && entry.name.toLowerCase() === name.toLowerCase()))}\n`,
            );
        });
    return program;
}
export async function main(argv = process.argv) {
    try {
        await buildProgram().parseAsync(argv);
    } catch (error) {
        if (
            error instanceof CommanderError &&
            ["commander.helpDisplayed", "commander.version"].includes(
                error.code,
            )
        )
            return;
        const normalized =
            error instanceof CommanderError
                ? new CliError(
                      "CLI_USAGE",
                      "input",
                      error.message.replace(/^error:\s*/, ""),
                  )
                : error;
        emit(publicError(normalized));
        process.exitCode = 1;
    }
}
void main();
//# sourceMappingURL=cli.js.map
