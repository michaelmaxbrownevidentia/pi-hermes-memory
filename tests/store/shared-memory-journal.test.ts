import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { SharedMemoryJournal, reconcileOperations, type JournalOperation } from "../../src/store/shared-memory-journal.js";
import { activeMemoryScopes, repoScopeForCwd } from "../../src/shared-memory-context.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-memory-")); roots.push(root); return root; }
function journal(root: string, host: string): SharedMemoryJournal { return new SharedMemoryJournal({ sharedRoot: path.join(root, "shared"), localIndexDir: path.join(root, `local-${host}`), writerHost: host }); }

describe("SharedMemoryJournal", () => {
  it("keeps immutable operations in host partitions and stable IDs across local index rebuilds", () => {
    const root = temp(); const dev = journal(root, "dev");
    const added = dev.add({ scope: "global", target: "memory", content: "shared durable fact" });
    const file = fs.readdirSync(path.join(root, "shared/journal/dev"))[0];
    const operation = fs.readFileSync(path.join(root, "shared/journal/dev", file), "utf8");
    const updated = dev.update(added.id, 1, added.headOpId, { content: "shared durable fact updated" });
    assert.equal(updated.id, added.id); assert.equal(updated.revision, 2);
    assert.equal(fs.readFileSync(path.join(root, "shared/journal/dev", file), "utf8"), operation);
    dev.close(); fs.rmSync(path.join(root, "local-dev/shared-memory.db"), { force: true });
    const rebuilt = journal(root, "dev");
    assert.equal(rebuilt.search("durable fact updated", ["global"])[0].id, added.id);
    rebuilt.close();
  });

  it("reconciles offline host writes without loss and surfaces concurrent stale revisions deterministically", () => {
    const root = temp(); const dev = journal(root, "dev"); const laptop = journal(root, "laptop");
    const base = dev.add({ scope: "repo:evidentia-web-app", target: "memory", content: "base fact", timestamp: "2026-01-01T00:00:00.000Z" });
    dev.close();
    const ops: JournalOperation[] = [
      { schema: 1, opId: "a", writer: "dev", timestamp: "2026-01-02T00:00:00.000Z", entryId: base.id, action: "update", expectedRevision: 1, expectedParentOpId: base.headOpId, content: "dev edit" },
      { schema: 1, opId: "b", writer: "laptop", timestamp: "2026-01-02T00:00:00.000Z", entryId: base.id, action: "update", expectedRevision: 1, expectedParentOpId: base.headOpId, content: "laptop edit" },
    ];
    for (const op of ops) { const dir = path.join(root, "shared/journal", op.writer); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${op.opId}.json`), JSON.stringify(op)); }
    laptop.add({ scope: "host:laptop", target: "memory", content: "offline laptop fact" });
    const state = laptop.load();
    assert.ok(state.entries.some((entry) => entry.content === "dev edit"));
    assert.ok(state.entries.some((entry) => entry.content === "offline laptop fact"));
    assert.equal(state.conflicts.length, 1); assert.equal(state.conflicts[0].reason, "revision_mismatch");
    laptop.close();
  });

  it("never applies a losing offline branch descendant to the winner", () => {
    const operations: JournalOperation[] = [
      { schema: 1, opId: "base", writer: "dev", timestamp: "2026-01-01T00:00:00Z", entryId: "id", action: "add", expectedRevision: 0, scope: "global", target: "memory", content: "base" },
      { schema: 1, opId: "winner", writer: "dev", timestamp: "2026-01-02T00:00:00Z", entryId: "id", action: "update", expectedRevision: 1, expectedParentOpId: "base", content: "winner" },
      { schema: 1, opId: "loser", writer: "laptop", timestamp: "2026-01-03T00:00:00Z", entryId: "id", action: "update", expectedRevision: 1, expectedParentOpId: "base", content: "loser" },
      { schema: 1, opId: "descendant", writer: "laptop", timestamp: "2026-01-04T00:00:00Z", entryId: "id", action: "update", expectedRevision: 2, expectedParentOpId: "loser", content: "must not apply" },
    ];
    const state = reconcileOperations(operations);
    assert.equal(state.entries[0].content, "winner");
    assert.deepEqual(state.conflicts.map((item) => item.opId).sort(), ["descendant", "loser"]);
  });

  it("filters unrelated host and organisation scopes by default", () => {
    const root = temp(); const dev = journal(root, "dev");
    dev.add({ scope: "global", target: "memory", content: "needle global" });
    dev.add({ scope: "host:dev", target: "memory", content: "needle dev" });
    dev.add({ scope: "host:laptop", target: "memory", content: "needle laptop" });
    dev.add({ scope: "org:glass", target: "memory", content: "needle glass" });
    const config = { enabled: true, sharedRoot: path.join(root, "shared"), localIndexDir: path.join(root, "local-dev"), writerHost: "dev", scopeRules: [{ scope: "org:evidentia" as const, pathPrefixes: [path.join(root, "Development")] }] };
    const scopes = activeMemoryScopes(config, path.join(root, "Development", "plain"));
    const found = dev.search("needle", scopes).map((entry) => entry.content).sort();
    assert.deepEqual(found, ["needle dev", "needle global"]);
    dev.close();
  });

  it("reconciles by revision dependency despite clock skew", () => {
    const operations: JournalOperation[] = [
      { schema: 1, opId: "add", writer: "dev", timestamp: "2026-01-02T00:00:00Z", entryId: "id", action: "add", expectedRevision: 0, scope: "global", target: "memory", content: "first" },
      { schema: 1, opId: "update", writer: "laptop", timestamp: "2026-01-01T00:00:00Z", entryId: "id", action: "update", expectedRevision: 1, expectedParentOpId: "add", content: "second" },
    ];
    const state = reconcileOperations(operations);
    assert.equal(state.entries[0].content, "second"); assert.equal(state.entries[0].revision, 2); assert.equal(state.conflicts.length, 0);
  });

  it("rejects stale revision updates and preserves the accepted entry", () => {
    const root = temp(); const dev = journal(root, "dev");
    const entry = dev.add({ scope: "host:dev", target: "memory", content: "version one" });
    const updated = dev.update(entry.id, 1, entry.headOpId, { content: "version two" });
    assert.throws(() => dev.update(entry.id, 1, entry.headOpId, { content: "stale overwrite" }), /revision conflict/);
    assert.equal(updated.revision, 2);
    assert.equal(dev.search("version two", ["host:dev"])[0].revision, 2);
    dev.close();
  });

  it("scans failure reasons and rejects canonical index paths inside the shared root", () => {
    const root = temp(); const dev = journal(root, "dev");
    assert.throws(() => dev.add({ scope: "global", target: "failure", content: "safe", failureReason: "OPENAI_API_KEY=sk-123456789012345678901234" }), /Unsafe failureReason/);
    dev.close();
    const inside = path.join(root, "shared", "inside"); fs.mkdirSync(inside, { recursive: true });
    const link = path.join(root, "linked-index"); fs.symlinkSync(inside, link);
    assert.throws(() => new SharedMemoryJournal({ sharedRoot: path.join(root, "shared"), localIndexDir: link, writerHost: "dev" }), /outside sharedRoot/);
  });

  it("gives equivalent repository roots and linked worktrees the same scope", () => {
    const root = temp(); const repo = path.join(root, "Evidentia-Web-App"); const worktree = path.join(root, "worktree");
    fs.mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "x"), "x"); execFileSync("git", ["-C", repo, "add", "x"]); execFileSync("git", ["-C", repo, "commit", "-qm", "x"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree]);
    assert.equal(repoScopeForCwd(repo), "repo:evidentia-web-app");
    assert.equal(repoScopeForCwd(path.join(repo)), repoScopeForCwd(worktree));
  });
});

describe("reconcileOperations", () => {
  it("treats identical deterministic migration adds as idempotent", () => {
    const add = (writer: string): JournalOperation => ({ schema: 1, opId: writer, writer, timestamp: "2026-01-01T00:00:00Z", entryId: "legacy-id", action: "add", expectedRevision: 0, scope: "global", target: "memory", content: "same", category: "insight" });
    const state = reconcileOperations([add("dev"), add("laptop")]);
    assert.equal(state.entries.length, 1); assert.equal(state.conflicts.length, 0);
  });

  it("surfaces differing metadata on duplicate stable IDs", () => {
    const base: JournalOperation = { schema: 1, opId: "dev", writer: "dev", timestamp: "2026-01-01T00:00:00Z", entryId: "legacy-id", action: "add", expectedRevision: 0, scope: "global", target: "failure", content: "same", category: "failure", failureReason: "one" };
    const state = reconcileOperations([base, { ...base, opId: "laptop", writer: "laptop", failureReason: "two" }]);
    assert.equal(state.entries.length, 1); assert.equal(state.conflicts[0].reason, "entry_exists");
  });
});
