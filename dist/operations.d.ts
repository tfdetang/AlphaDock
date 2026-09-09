import { type RemoteClient } from "./platform.js";
import { type Journal, type Platform } from "./storage.js";
export declare function prepareRemoteOperation(
    kind: string,
    platform: Platform,
    parameters: Record<string, unknown>,
    source?: string,
): Promise<{
    client: RemoteClient;
    operation: {
        path: string;
        value: Journal;
    };
}>;
