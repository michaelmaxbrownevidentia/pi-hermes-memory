# Pi Hermes Memory Extension

Use the root [README](README.md) for project overview, architecture, development, runtime compatibility, and installation. Read [v0.2 tasks](docs/0.2/TASKS.md) before selecting feature work; consult [roadmap](docs/ROADMAP.md) for project direction and [PLAN.md](PLAN.md) only when the Hermes source mapping is relevant.

## Invariants

- Memory is a frozen session-start snapshot; writes are atomic (temporary file plus rename).
- Use `pi.exec()` for background review and retain the `§` delimiter.
- SQLite databases remain host-local; synchronized state uses immutable journal operations, never active database files.
- Select SQLite lazily by runtime: compiled Pi/Bun uses `bun:sqlite`; Node uses `loadBetterSqlite3()` from `src/store/sqlite-native.ts`. Never load `better-sqlite3` directly from feature code or at module scope.

## Validation

Run `npm run check` and `npm test` for relevant changes. **A SQLite initialization, adapter, or consumer change is not done until the compiled-Pi SQLite smoke test passes.** Follow the exact command and failure checks in [README: SQLite runtime compatibility](README.md#sqlite-runtime-compatibility); Node tests alone do not cover Bun resolution.

For implementation file roles, current development guidance, installation, and Node ABI recovery, use the relevant sections of the [README](README.md) rather than duplicating inventories or procedures here.
