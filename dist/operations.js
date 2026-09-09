import { clientFor } from "./platform.js";
import { createJournal } from "./storage.js";
export async function prepareRemoteOperation(kind, platform, parameters, source) {
    // clientFor performs only local config and cookie validation; no transport request occurs in constructors.
    const { client } = await clientFor(platform);
    const operation = await createJournal(kind, platform, parameters, source);
    return { client, operation };
}
//# sourceMappingURL=operations.js.map