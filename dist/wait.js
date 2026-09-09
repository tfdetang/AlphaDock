export async function waitForTerminal(
    readStatus,
    timeoutMs,
    intervalMs,
    clock = Date.now,
    sleep = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
    const deadline = clock() + timeoutMs;
    while (true) {
        const status = await readStatus();
        if (status.state === "success" || status.state === "failed")
            return status;
        const remaining = deadline - clock();
        if (remaining <= 0) return undefined;
        await sleep(Math.min(intervalMs, remaining));
    }
}
//# sourceMappingURL=wait.js.map
