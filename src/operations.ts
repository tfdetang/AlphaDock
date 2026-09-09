import { clientFor, type RemoteClient } from "./platform.js";
import { createJournal, type Journal, type Platform } from "./storage.js";

export async function prepareRemoteOperation(
  kind: string,
  platform: Platform,
  parameters: Record<string, unknown>,
  source?: string,
): Promise<{
  client: RemoteClient;
  operation: { path: string; value: Journal };
}> {
  // clientFor performs only local config and cookie validation; no transport request occurs in constructors.
  const { client } = await clientFor(platform);
  const operation = await createJournal(kind, platform, parameters, source);
  return { client, operation };
}
