export async function waitForTerminal(
  readStatus: () => Promise<Record<string, unknown>>,
  timeoutMs: number,
  intervalMs: number,
  clock: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<Record<string, unknown> | undefined> {
  const deadline = clock() + timeoutMs;
  while (true) {
    const status = await readStatus();
    if (status.state === "success" || status.state === "failed") return status;
    const remaining = deadline - clock();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(intervalMs, remaining));
  }
}
