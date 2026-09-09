import { CookieJar } from "tough-cookie";
export declare function parseJsonSequence(text: string): unknown[];
export declare function loadCookieJar(path: string): Promise<CookieJar>;
