# AlphaDock

AlphaDock is a safety-focused TypeScript CLI for using **existing authenticated sessions** on JoinQuant and SuperMind without a browser runtime. It supports notebook execution, dedicated strategy creation, backtest submission/result reads, and an offline curated API catalog.

> Version 0.1.0 is an MVP over undocumented platform web contracts. Test with non-critical accounts and review every remote operation. AlphaDock does not provide first login, CAPTCHA handling, live trading, a local backtest engine, browser fallback, credential refresh, cancellation/deletion, or remote strategy editing.

## Requirements and install

Node.js 22 or newer is required. There is no Python, Playwright, or Chromium runtime dependency and no install-time browser hook.

```sh
npm install
npm run check
npm pack
npm install --global ./alphadock-0.1.0.tgz
alphadock --help
```

The package is `UNLICENSED`. Package contents include `dist/`, this README, package metadata, and `.agents/skills/alphadock/`; tests, `.pi/`, validation reports, config, journals, and credentials are excluded. Pre-compiled JavaScript is included so installation does not require a TypeScript compiler on the user machine.

## Install from GitHub with npm

```sh
npm install --global --allow-git=root git+https://github.com/tfdetang/AlphaDock.git
alphadock --help
```

This installs the CLI and bundled skill through npm directly from GitHub; it does not require an npm registry release named `alphadock` or a local TypeScript build toolchain. On npm 12, pass `--allow-git=root` to explicitly permit this top-level Git dependency for the command. For reproducibility, append `#<commit-sha>` to the Git URL.

## Agent skill

The project skill lives at [`.agents/skills/alphadock/SKILL.md`](.agents/skills/alphadock/SKILL.md). It provides a small entry point with on-demand references for CLI workflows, platform-specific strategy skeletons, and a documentation lookup path when the curated catalog is insufficient.

The skill and all reference files are included in the npm tarball. Installing with npm places the files on disk; agents still need to discover or register them. After the global npm installation above, Pi users can register the package:

```sh
pi install "$(npm root -g)/alphadock"
# Then reload skills in Pi and invoke /skill:alphadock.
```

Alternatively, Pi can install the Git package directly with `pi install git:github.com/tfdetang/AlphaDock`; the `pi.skills` manifest declares the bundled skill. This alternative loads the skill but does not promise a global `alphadock` command—use the npm global install above for that.

In a trusted source checkout, Pi also discovers `.agents/skills/alphadock/` directly. Other Agent Skills-compatible tools can load the entry file or copy the entire `alphadock/` skill directory from `$(npm root -g)/alphadock/.agents/skills/` into their configured skills location. Keep the reference files with `SKILL.md`. Installing a skill does not grant authorization for remote operations.

## Authentication and local state

Export cookies from an already authenticated session as either a JSON cookie array, Playwright `{ "cookies": [...] }`, or concatenated JSON cookie objects. Cookie expiry, Secure, host-only/domain, and path scope are enforced through a cookie jar. TLS verification is always enabled and remote origins are fixed. JoinQuant credentials are scoped to `www.joinquant.com`; SuperMind's `quant.10jqka.com.cn` and `supermind.10jqka.com.cn` scopes remain separate.

```sh
alphadock auth configure --platform joinquant --cookie-file /external/path/joinquant.json
alphadock auth status --platform joinquant
```

Configuration stores only the absolute **reference** to the external cookie file, never cookie values. The input file is unchanged. State lives at `$ALPHADOCK_HOME`, or `$XDG_CONFIG_HOME/alphadock`, or `~/.config/alphadock`; directories/files use mode 0700/0600. Optional environment overrides are path references only:

- `ALPHADOCK_JOINQUANT_COOKIE_FILE`
- `ALPHADOCK_SUPERMIND_COOKIE_FILE`

Auth status uses a guarded authenticated resource and does not treat a bare HTTP 200 login shell as success. AlphaDock does not promise proxy support.

## Commands

Use `alphadock <command> --help` for all options.

```sh
# Existing sessions only; listing never starts a server or kernel.
alphadock notebook list --platform joinquant

# Exactly one explicit existing kernel or an owned temporary kernel.
alphadock notebook exec research.py --platform supermind --kernel-id KERNEL_ID --confirm-remote-execution
alphadock notebook exec research.py --platform supermind --temporary --confirm-remote-execution

# Always creates a new dedicated strategy; it never modifies an existing strategy.
alphadock strategy create strategy.py --platform joinquant --name "My strategy" --confirm-remote-write

# Reads saved strategy code, explicitly overrides run parameters, and submits once.
alphadock backtest submit --platform supermind --strategy-id STRATEGY_ID \
  --start 2024-01-02 --end 2024-01-05 --cash 100000 --frequency day \
  --confirm-remote-execution

alphadock backtest status --platform supermind --backtest-id BACKTEST_ID
alphadock backtest result --platform supermind --backtest-id BACKTEST_ID --out result.json
alphadock backtest wait --platform supermind --backtest-id BACKTEST_ID --timeout 300 --interval 20

# Offline; these commands do not load config/cookies or use a network.
alphadock api list --platform joinquant
alphadock api search backtest --platform joinquant --category backtest
alphadock api show get_price --platform supermind
```

Operational results and errors are structured JSON on stdout. Help and API catalog output are human-readable. `--out` uses exclusive creation and never overwrites. IDs, dates, positive finite cash, frequency, confirmations, timeout and interval are validated before remote write effects.

Before the first strategy-create/backtest-submit request, AlphaDock durably records a deterministic local request/operation ID, parameter metadata, and source hash (not source code or credentials). Repeating the same operation is refused rather than replayed. It preserves returned remote IDs immediately. A dropped or unverified write response is never automatically replayed. Submission acceptance is distinct from completion. Wait timeout neither cancels nor marks the remote task failed.

Notebook execution sends source directly over Jupyter channels and never creates an `.ipynb`. Completion requires a correlated `execute_reply` with status `ok` plus correlated IOPub `idle`; channel loss/timeout is unverified and execution is not repeated. Existing kernels are never cleaned up. AlphaDock only attempts deletion for a temporary kernel it created, and reports its recoverable ID if cleanup cannot be verified. Output size and execution time are bounded; returned HTML/JavaScript is data and is never evaluated locally.

Backtest result verification requires a recognized terminal status and successful metrics retrieval. Returned metrics retain platform field names and nulls. Trades/logs are bounded to the documented first page/offset in this MVP and the output includes those bounds. JoinQuant public and internal result IDs are resolved deliberately. SuperMind's filtered error-log `total` is not interpreted as an error count.

## Calling from Jupyter or Python

No custom kernel extension is needed. A local notebook can invoke the installed CLI and parse JSON:

```python
import json, subprocess
completed = subprocess.run(
    ["alphadock", "backtest", "status", "--platform", "supermind",
     "--backtest-id", "synthetic-example-id"],
    text=True, capture_output=True, check=False,
)
payload = json.loads(completed.stdout)
if completed.returncode != 0:
    raise RuntimeError(f"AlphaDock {payload['error']['code']} at {payload['error']['stage']}")
```

Do not pass cookie values or inline remote code on the command line.

## API catalog provenance and limitations

`api` is a useful curated subset, not complete documentation. Every entry labels environment, source URL, and provenance. It covers each platform's data and strategy lifecycle/order/benchmark examples; JoinQuant `get_backtest` status/params/risk/orders/results and documented-but-not-live-tested `create_backtest` are called out separately. Examples are minimal verified/documented usage, not invented full signatures.

The prior no-browser validation used temporary Python probes and demonstrates platform feasibility only; it does **not** live-validate this TypeScript implementation. Platform contracts can change. First login, stopped-server startup, long runs, full pagination/export, paid/concurrency edge cases, and automatic session refresh remain unsupported or incompletely validated. When a platform response is ambiguous, AlphaDock fails closed and retains recoverable IDs rather than guessing or retrying.
