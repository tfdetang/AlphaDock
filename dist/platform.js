import { loadCookieJar } from "./cookies.js";
import { SafeHttp } from "./http.js";
import { cookieFileFor } from "./storage.js";
import { JoinQuantClient } from "./platforms/joinquant.js";
import { SuperMindClient } from "./platforms/supermind.js";
export async function clientFor(platform) {
    const jar = await loadCookieJar(await cookieFileFor(platform));
    const http = new SafeHttp(platform, jar);
    return {
        client: platform === "joinquant"
            ? new JoinQuantClient(http)
            : new SuperMindClient(http),
        http,
        jar,
    };
}
//# sourceMappingURL=platform.js.map