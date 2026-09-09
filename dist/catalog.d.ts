import type { Platform } from "./storage.js";
export interface ApiEntry {
    platform: Platform;
    name: string;
    category: string;
    environment: string;
    example: string;
    source: string;
    provenance: string;
}
export declare const catalog: ApiEntry[];
export declare function selectCatalog(platform: Platform, query?: string, category?: string): ApiEntry[];
export declare function renderCatalog(entries: ApiEntry[]): string;
