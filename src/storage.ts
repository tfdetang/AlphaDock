import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  chmod,
  lstat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CliError } from "./errors.js";

export type Platform = "joinquant" | "supermind";
interface Config {
  platforms?: Partial<Record<Platform, { cookieFile: string }>>;
}
export interface Journal {
  operationId: string;
  kind: string;
  platform: Platform;
  stage: string;
  createdAt: string;
  parameters: Record<string, unknown>;
  sourceSha256?: string;
  strategyId?: string;
  strategyIds?: string[];
  backtestId?: string;
}

export function home(): string {
  return resolve(
    process.env.ALPHADOCK_HOME ||
      join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "alphadock",
      ),
  );
}
export function configPath(): string {
  return join(home(), "config.json");
}

async function ensureHome(): Promise<void> {
  const target = home();
  try {
    await mkdir(target, { recursive: true, mode: 0o700 });
  } catch {
    throw new CliError(
      "STATE_HOME_UNSAFE",
      "config",
      "AlphaDock state directory cannot be created safely",
    );
  }
  let state;
  try {
    state = await lstat(target);
  } catch {
    throw new CliError(
      "STATE_HOME_UNSAFE",
      "config",
      "AlphaDock state directory cannot be inspected safely",
    );
  }
  const wrongOwner =
    typeof process.getuid === "function" && state.uid !== process.getuid();
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    wrongOwner ||
    (state.mode & 0o077) !== 0
  )
    throw new CliError(
      "STATE_HOME_UNSAFE",
      "config",
      "AlphaDock state directory must be private and owned by the current user",
    );
}
export async function atomicPrivateWrite(
  path: string,
  data: string,
): Promise<void> {
  await ensureHome();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const current = await lstat(path);
    if (
      typeof process.getuid === "function" &&
      current.uid !== process.getuid()
    )
      throw new CliError(
        "OWNER_MISMATCH",
        "config",
        "Refusing to replace a file owned by another user",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}
export async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(
      "CONFIG_INVALID",
      "config",
      "Configuration cannot be read",
    );
  }
}
export async function configure(
  platform: Platform,
  cookieFile: string,
): Promise<void> {
  const path = resolve(cookieFile);
  await readFile(path, "utf8");
  const config = await readConfig();
  config.platforms ??= {};
  config.platforms[platform] = { cookieFile: path };
  await atomicPrivateWrite(
    configPath(),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}
export async function cookieFileFor(platform: Platform): Promise<string> {
  const env =
    process.env[
      `ALPHADOCK_${platform === "joinquant" ? "JOINQUANT" : "SUPERMIND"}_COOKIE_FILE`
    ];
  const value = env || (await readConfig()).platforms?.[platform]?.cookieFile;
  if (!value)
    throw new CliError(
      "AUTH_NOT_CONFIGURED",
      "config",
      `No cookie-file reference configured for ${platform}`,
    );
  return resolve(value);
}
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export async function createJournal(
  kind: string,
  platform: Platform,
  parameters: Record<string, unknown>,
  source?: string,
): Promise<{ path: string; value: Journal }> {
  await ensureHome();
  const sourceSha256 = source === undefined ? undefined : sha256(source);
  const operationId = sha256(
    JSON.stringify({ kind, platform, parameters, sourceSha256 }),
  ).slice(0, 32);
  const dir = join(home(), "operations");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${operationId}.json`);
  const value: Journal = {
    operationId,
    kind,
    platform,
    stage: "prepared",
    createdAt: new Date().toISOString(),
    parameters,
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
  };
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError(
        "DUPLICATE_OPERATION",
        "journal",
        `Operation ${operationId} already exists and will not be replayed`,
      );
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, value };
}
export async function updateJournal(
  path: string,
  value: Journal,
): Promise<void> {
  await atomicPrivateWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
function outputFailure(error: unknown): CliError {
  return (error as NodeJS.ErrnoException).code === "EEXIST"
    ? new CliError("OUTPUT_EXISTS", "output", "Output file already exists")
    : new CliError(
        "OUTPUT_UNAVAILABLE",
        "output",
        "Output destination is not safely writable",
      );
}
async function ensureOutputParent(target: string): Promise<void> {
  try {
    await mkdir(dirname(target), { recursive: true });
  } catch {
    throw new CliError(
      "OUTPUT_UNAVAILABLE",
      "output",
      "Output destination is not safely writable",
    );
  }
}
export async function exclusiveOutput(
  path: string,
  value: unknown,
): Promise<void> {
  const target = resolve(path);
  await ensureOutputParent(target);
  let file;
  try {
    file = await open(target, "wx", 0o600);
  } catch (error) {
    throw outputFailure(error);
  }
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw outputFailure(error);
  }
  await file.close();
}
export async function assertOutputAvailable(path?: string): Promise<void> {
  if (!path) return;
  const target = resolve(path);
  await ensureOutputParent(target);
  let file;
  try {
    file = await open(target, "wx", 0o600);
  } catch (error) {
    throw outputFailure(error);
  }
  try {
    await file.close();
    await unlink(target);
  } catch (error) {
    throw outputFailure(error);
  }
}
