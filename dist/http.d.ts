import type { CookieJar } from "tough-cookie";
export interface ResponseLike {
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
}
export type Transport = (
    url: string,
    init: RequestInit,
) => Promise<ResponseLike>;
export interface HttpResponse {
    status: number;
    url: URL;
    headers: Headers;
    body: string;
}
export interface RedirectInfo {
    from: URL;
    to: URL;
    status: number;
}
declare const ORIGINS: {
    joinquant: Set<string>;
    supermind: Set<string>;
};
export declare class SafeHttp {
    private readonly platform;
    private readonly jar;
    private readonly transport;
    constructor(
        platform: keyof typeof ORIGINS,
        jar: CookieJar,
        transport?: Transport,
    );
    private allowed;
    request(
        input: string | URL,
        options?: {
            method?: string;
            headers?: Record<string, string>;
            body?: string;
            maxBytes?: number;
            redirects?: number;
            onRedirect?: (info: RedirectInfo) => Promise<void>;
        },
    ): Promise<HttpResponse>;
    form(
        url: string,
        values: Record<string, string | number>,
        headers?: Record<string, string>,
    ): Promise<HttpResponse>;
    json(
        url: string,
        method: string,
        value?: unknown,
        headers?: Record<string, string>,
    ): Promise<HttpResponse>;
}
export declare function parseJson(body: string): Record<string, unknown>;
