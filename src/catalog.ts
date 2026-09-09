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
export const catalog: ApiEntry[] = [
  {
    platform: "joinquant",
    name: "get_price",
    category: "data",
    environment: "research/backtest",
    example: `get_price("000001.XSHE", start_date="2024-01-02", end_date="2024-01-05", frequency="daily", fields=["close"], fq=None)`,
    source: "https://www.joinquant.com/help/api/help#api:get_price",
    provenance:
      "Minimal example live-verified 2026-09-09; not a full signature.",
  },
  {
    platform: "joinquant",
    name: "initialize / handle_data",
    category: "strategy",
    environment: "backtest",
    example:
      "def initialize(context):\n    set_benchmark('000300.XSHG')\ndef handle_data(context, data):\n    order('000001.XSHE', 100)",
    source: "https://www.joinquant.com/help/api/help",
    provenance:
      "Curated lifecycle/order/benchmark example; verify current platform docs before use.",
  },
  {
    platform: "joinquant",
    name: "get_backtest",
    category: "backtest",
    environment: "research",
    example:
      "bt = get_backtest(backtest_id)\nbt.get_status(); bt.get_params(); bt.get_risk(); bt.get_orders(); bt.get_results()",
    source: "https://www.joinquant.com/help/api/help",
    provenance:
      "get_status/get_params/get_risk/get_orders live-verified 2026-09-09; get_results cataloged from platform API, not separately live-verified.",
  },
  {
    platform: "joinquant",
    name: "create_backtest",
    category: "backtest",
    environment: "research",
    example:
      "create_backtest(code=code, start_date='2024-01-02', end_date='2024-01-05', initial_cash=100000, python_version=3, use_credit=False)",
    source: "https://www.joinquant.com/help/api/help",
    provenance:
      "Documented and runtime-docstring observed; NOT live-submission-tested by AlphaDock. Minimal example, not a claimed full signature.",
  },
  {
    platform: "supermind",
    name: "get_price",
    category: "data",
    environment: "research/backtest",
    example: `get_price("000001.SZ", "20240102", "20240105", "1d", ["close"], skip_paused=False, fq=None, bar_count=0, is_panel=False)`,
    source: "https://quant.10jqka.com.cn/view/help.html",
    provenance:
      "Minimal example live-verified 2026-09-09; not a full signature.",
  },
  {
    platform: "supermind",
    name: "init / handle_bar",
    category: "strategy",
    environment: "backtest",
    example:
      "def init(context):\n    set_benchmark('000300.SH')\ndef handle_bar(context, bar_dict):\n    order('000001.SZ', 100)",
    source: "https://quant.10jqka.com.cn/view/help.html",
    provenance:
      "Curated lifecycle/order/benchmark subset; verify current platform docs before use.",
  },
  {
    platform: "supermind",
    name: "strategy and backtest web APIs",
    category: "backtest",
    environment: "AlphaDock transport",
    example:
      "alphadock strategy create strategy.py --platform supermind --name demo --confirm-remote-write\nalphadock backtest submit --platform supermind --strategy-id ID --start 2024-01-02 --end 2024-01-05 --cash 100000 --frequency day --confirm-remote-execution",
    source: "https://quant.10jqka.com.cn/",
    provenance:
      "Authenticated HTTP create/readback/submit/status/performance/trades/log flow live-verified 2026-09-09; internal web contract may change.",
  },
];
export function selectCatalog(
  platform: Platform,
  query?: string,
  category?: string,
): ApiEntry[] {
  const needle = query?.toLowerCase();
  return catalog.filter(
    (entry) =>
      entry.platform === platform &&
      (!category || entry.category === category) &&
      (!needle ||
        `${entry.name} ${entry.category} ${entry.example}`
          .toLowerCase()
          .includes(needle)),
  );
}
export function renderCatalog(entries: ApiEntry[]): string {
  if (!entries.length) return "No entries found in AlphaDock's curated subset.";
  return entries
    .map(
      (entry) =>
        `${entry.name} [${entry.category}; ${entry.environment}]\n${entry.example}\nSource: ${entry.source}\nProvenance: ${entry.provenance}`,
    )
    .join("\n\n");
}
