# Pi Hermes Memory Extension

## Project Overview

This is a Pi coding agent extension that brings Hermes-style persistent memory and a learning loop to any Pi user. After `pi install`, users get persistent memory across sessions, a background learning loop, and session-end flush.

**v0.1 is complete** (119 tests, v0.1.0 tagged). Current work is **v0.2: Skills + Smart Curation** — see `docs/0.2/TASKS.md`.

## Architecture

- **Language**: TypeScript (loaded directly by Pi)
- **Runtime**: Pi extension API (`@earendil-works/pi-coding-agent`); source/dev runs use Node, while the distributed Pi executable is compiled with Bun
- **Storage**: Markdown memory, an immutable host-partitioned shared journal, and host-local SQLite indexes
- **Entry point**: `src/index.ts` — registers tools, event handlers, and commands

## Key Files

| File | Purpose |
|---|---
| `src/index.ts` | Extension entry point — wires all components together |
| `src/types.ts` | Shared TypeScript interfaces + `getMessageText()` helper |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `src/store/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/store/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/tools/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/handlers/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/handlers/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/handlers/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `PLAN.md` | Full v0.1 implementation plan with Hermes source file reference map |
| `docs/ROADMAP.md` | Full roadmap with Hermes competitive analysis + gap analysis |
| `docs/0.2/TASKS.md` | v0.2 task breakdown — Skills + Smart Curation |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **`pi.exec()` for background review** — Stays within Pi's intended extension API
4. **`§` delimiter** — Same as Hermes for consistency
5. **SQLite is always host-local** — synchronized data uses immutable journal operations; active SQLite databases are never synchronized
6. **Dual-runtime SQLite** — compiled Pi must use `bun:sqlite`; Node source/test runs use `better-sqlite3` through `loadBetterSqlite3()`

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

## Roadmap & Task Tracking

- **Roadmap**: `docs/ROADMAP.md` — full roadmap with Hermes competitive analysis, gap analysis, and phased plan (v0.1 → v0.5 → v1.0)
- **v0.1 tasks** (complete): `docs/0.1/TASKS.md`
- **v0.2 tasks** (current): `docs/0.2/TASKS.md` — Skills, auto-consolidation, correction detection, tool-call-aware nudge

**Workflow:**
1. Pick a task from `docs/0.2/TASKS.md`
2. Mark it `[~]` (in progress)
3. Implement it
4. Mark it `[x]` (done) with the commit hash
5. Move to the next task

**Before starting any work, read `docs/0.2/TASKS.md` to see what's next.**

## Development

### SQLite runtime rule

Never call `require("better-sqlite3")` directly from feature code. Every SQLite entry point must select the runtime lazily:

- compiled Pi / Bun: `isBunRuntime()` and `bun:sqlite`
- Node: `loadBetterSqlite3()` from `src/store/sqlite-native.ts`

Keep native loading out of module scope so one resolver or ABI failure cannot prevent the extension from loading. When adding a new SQLite consumer, follow the adapters in `src/store/db.ts`, `src/store/atomic-lock-coordinator.ts`, or `src/extension-root-migration.ts`.

```bash
npm run check
npm test

# Required after changing SQLite initialization or adapters: exercise the
# checkout under a Bun-compiled Pi binary, not only Node/tsx tests.
PI_BIN=$(command -v pi) || { echo "pi is not installed" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' 'export default function () { if (!("Bun" in globalThis)) throw new Error("This smoke test requires Bun-compiled Pi"); }' >"$tmp/assert-bun.ts"
if ! "$PI_BIN" --no-extensions -e "$tmp/assert-bun.ts" -e ./src/index.ts --mode rpc --offline </dev/null >"$tmp/output" 2>&1; then
  cat "$tmp/output" >&2
  exit 1
fi
if grep -E 'extension_error|ResolveMessage|better-sqlite3' "$tmp/output"; then
  cat "$tmp/output" >&2
  exit 1
fi
```

A Node-only test can pass while compiled Pi still fails, because Bun cannot resolve the extension's native `better-sqlite3` package. The compiled-Pi smoke test is therefore part of the done condition for every SQLite-path change.

## Installation (for users)

```bash
pi install npm:pi-hermes-memory

# or from git
pi install git:github.com/chandra447/pi-hermes-memory
```
