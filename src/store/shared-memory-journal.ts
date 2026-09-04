import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { scanContent } from "./content-scanner.js";
import type { MemoryCategory } from "../types.js";

export type MemoryScope = `global` | `host:${string}` | `org:${string}` | `repo:${string}` | `workflow:${string}`;
export type SharedMemoryTarget = "memory" | "user" | "failure";
export type JournalAction = "add" | "update" | "delete";

export interface JournalOperation {
  schema: 1;
  opId: string;
  writer: string;
  timestamp: string;
  entryId: string;
  action: JournalAction;
  expectedRevision: number;
  expectedParentOpId?: string;
  scope?: MemoryScope;
  target?: SharedMemoryTarget;
  content?: string;
  category?: MemoryCategory | null;
  failureReason?: string | null;
}

export interface SharedMemoryEntry {
  id: string;
  revision: number;
  headOpId: string;
  owner: string;
  scope: MemoryScope;
  target: SharedMemoryTarget;
  content: string;
  category: MemoryCategory | null;
  failureReason: string | null;
  created: string;
  updated: string;
  deleted: boolean;
}

export interface JournalConflict {
  opId: string;
  entryId: string;
  writer: string;
  reason: string;
  expectedRevision: number;
  actualRevision: number | null;
}

export interface JournalState {
  entries: SharedMemoryEntry[];
  conflicts: JournalConflict[];
  operationCount: number;
  journalHash: string;
}

export interface SharedMemoryJournalOptions {
  sharedRoot: string;
  localIndexDir: string;
  writerHost: string;
}

const SCOPE_PATTERN = /^(global|host:[a-z0-9][a-z0-9._-]*|org:[a-z0-9][a-z0-9._-]*|repo:[a-z0-9][a-z0-9._-]*|workflow:[a-z0-9][a-z0-9._-]*)$/;
const TARGETS = new Set(["memory", "user", "failure"]);
const CATEGORIES = new Set(["failure", "correction", "insight", "preference", "convention", "tool-quirk"]);

export function validateMemoryScope(scope: string): MemoryScope {
  const normalized = scope.trim().toLowerCase();
  if (!SCOPE_PATTERN.test(normalized)) {
    throw new Error("scope must be global, host:<name>, org:<name>, repo:<name>, or workflow:<name>");
  }
  return normalized as MemoryScope;
}

function safeWriter(writer: string): string {
  const normalized = writer.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) throw new Error("writerHost must be a simple host name");
  return normalized;
}

function assertRealDirectory(directory: string, root: string): string {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Journal path must be a real directory: ${directory}`);
  const canonical = fs.realpathSync(directory);
  const canonicalRoot = fs.realpathSync(root);
  if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + path.sep)) {
    throw new Error(`Journal path escapes shared root: ${directory}`);
  }
  return canonical;
}

function operationOrder(left: JournalOperation, right: JournalOperation): number {
  return left.timestamp.localeCompare(right.timestamp)
    || left.writer.localeCompare(right.writer)
    || left.opId.localeCompare(right.opId);
}

function scanPersistedText(value: string | null | undefined, field: string, filePath?: string): void {
  if (value == null) return;
  if (typeof value !== "string" || value.length > 50_000) throw new Error(`Invalid ${field}${filePath ? `: ${filePath}` : ""}`);
  const scanError = scanContent(value);
  if (scanError) throw new Error(`Unsafe ${field} rejected${filePath ? `: ${filePath}` : ""}`);
}

function parseOperation(raw: string, filePath: string): JournalOperation {
  const op = JSON.parse(raw) as JournalOperation;
  if (op.schema !== 1 || !op.opId || !op.writer || !op.entryId || !["add", "update", "delete"].includes(op.action)) {
    throw new Error(`Invalid journal operation: ${filePath}`);
  }
  if (!Number.isInteger(op.expectedRevision) || op.expectedRevision < 0) throw new Error(`Invalid expectedRevision: ${filePath}`);
  if (op.scope !== undefined) validateMemoryScope(op.scope);
  if (op.target !== undefined && !TARGETS.has(op.target)) throw new Error(`Invalid target: ${filePath}`);
  if (op.category != null && !CATEGORIES.has(op.category)) throw new Error(`Invalid category: ${filePath}`);
  scanPersistedText(op.content, "content", filePath);
  scanPersistedText(op.failureReason, "failureReason", filePath);
  return op;
}

function conflictFor(op: JournalOperation, reason: string, actualRevision: number | null): JournalConflict {
  return { opId: op.opId, entryId: op.entryId, writer: op.writer, reason, expectedRevision: op.expectedRevision, actualRevision };
}

export function reconcileOperations(operations: JournalOperation[]): JournalState {
  const ordered = [...operations].sort(operationOrder);
  const entries = new Map<string, SharedMemoryEntry>();
  const conflicts: JournalConflict[] = [];
  const hash = createHash("sha256");
  for (const op of ordered) hash.update(JSON.stringify(op));

  const groups = new Map<string, JournalOperation[]>();
  for (const op of ordered) groups.set(op.entryId, [...(groups.get(op.entryId) ?? []), op]);

  for (const [entryId, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const adds = group.filter((op) => op.action === "add").sort(operationOrder);
    const validAdds = adds.filter((op) => op.scope && op.target && op.content?.trim());
    for (const op of adds.filter((candidate) => !validAdds.includes(candidate))) conflicts.push(conflictFor(op, "incomplete_add", null));
    const add = validAdds[0];
    if (!add) {
      for (const op of group.filter((candidate) => candidate.action !== "add")) conflicts.push(conflictFor(op, "missing_entry", null));
      continue;
    }

    let current: SharedMemoryEntry = {
      id: entryId,
      revision: 1,
      headOpId: add.opId,
      owner: add.writer,
      scope: validateMemoryScope(add.scope!),
      target: add.target!,
      content: add.content!.trim(),
      category: add.category ?? null,
      failureReason: add.failureReason?.trim() || null,
      created: add.timestamp,
      updated: add.timestamp,
      deleted: false,
    };
    const equivalentParentOpIds = new Set([add.opId]);
    for (const duplicate of validAdds.slice(1)) {
      const identical = current.scope === duplicate.scope
        && current.target === duplicate.target
        && current.content === duplicate.content!.trim()
        && current.category === (duplicate.category ?? null)
        && current.failureReason === (duplicate.failureReason?.trim() || null);
      if (identical) equivalentParentOpIds.add(duplicate.opId);
      else conflicts.push(conflictFor(duplicate, "entry_exists", current.revision));
    }

    let acceptedParentOpIds = equivalentParentOpIds;
    const mutations = group.filter((op) => op.action !== "add");
    while (!current.deleted) {
      const candidates = mutations.filter((op) =>
        op.expectedRevision === current.revision && op.expectedParentOpId !== undefined && acceptedParentOpIds.has(op.expectedParentOpId)
      ).sort(operationOrder);
      if (candidates.length === 0) break;
      const winner = candidates[0];
      if (winner.action === "update" && !winner.content?.trim()) {
        conflicts.push(conflictFor(winner, "empty_update", current.revision));
        mutations.splice(mutations.indexOf(winner), 1);
        continue;
      }
      current = winner.action === "delete"
        ? { ...current, revision: current.revision + 1, headOpId: winner.opId, updated: winner.timestamp, deleted: true }
        : {
            ...current,
            revision: current.revision + 1,
            headOpId: winner.opId,
            scope: winner.scope ? validateMemoryScope(winner.scope) : current.scope,
            content: winner.content!.trim(),
            category: winner.category === undefined ? current.category : winner.category,
            failureReason: winner.failureReason === undefined ? current.failureReason : winner.failureReason?.trim() || null,
            updated: winner.timestamp,
          };
      acceptedParentOpIds = new Set([winner.opId]);
      mutations.splice(mutations.indexOf(winner), 1);
      for (const loser of candidates.slice(1)) {
        conflicts.push(conflictFor(loser, "revision_mismatch", current.revision));
        mutations.splice(mutations.indexOf(loser), 1);
      }
    }
    for (const op of mutations) conflicts.push(conflictFor(
      op,
      current.deleted ? "entry_deleted" : op.expectedRevision === current.revision ? "parent_mismatch" : "revision_mismatch",
      current.revision,
    ));
    entries.set(entryId, current);
  }

  return { entries: [...entries.values()], conflicts, operationCount: ordered.length, journalHash: hash.digest("hex") };
}

class LocalJournalIndex {
  private db: any;
  constructor(private readonly filePath: string) {}

  private isRebuildable(error: unknown): boolean {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("file is not a database")
      || message.includes("database disk image is malformed")
      || message.includes("malformed database schema")
      || message.includes("no such column: head_op_id")
      || (message.includes("table entries has") && message.includes("columns"));
  }

  private open(): any {
    if (this.db) return this.db;
    try {
      return this.openUnchecked();
    } catch (error) {
      if (!this.isRebuildable(error)) throw error;
      this.quarantine();
      return this.openUnchecked();
    }
  }

  private openUnchecked(): any {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(this.filePath);
    try {
      db.pragma("busy_timeout = 5000");
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY, revision INTEGER NOT NULL, head_op_id TEXT NOT NULL, owner TEXT NOT NULL, scope TEXT NOT NULL,
          target TEXT NOT NULL, content TEXT NOT NULL, category TEXT, failure_reason TEXT,
          created TEXT NOT NULL, updated TEXT NOT NULL, deleted INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
        CREATE TABLE IF NOT EXISTS conflicts (
          op_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, writer TEXT NOT NULL, reason TEXT NOT NULL,
          expected_revision INTEGER NOT NULL, actual_revision INTEGER
        );
      `);
      this.db = db;
      return db;
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
  }

  private quarantine(): void {
    if (this.db) { try { this.db.close(); } catch {} this.db = null; }
    const suffix = `.corrupt-${Date.now()}`;
    for (const sidecar of ["", "-wal", "-shm"]) {
      const source = `${this.filePath}${sidecar}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${this.filePath}${suffix}${sidecar}`);
    }
  }

  rebuild(state: JournalState): void {
    try {
      this.rebuildUnchecked(state);
    } catch (error) {
      if (!this.isRebuildable(error)) throw error;
      this.quarantine();
      this.rebuildUnchecked(state);
    }
  }

  private rebuildUnchecked(state: JournalState): void {
    const db = this.open();
    const current = db.prepare("SELECT value FROM metadata WHERE key='journal_hash'").get()?.value;
    if (current === state.journalHash) return;
    const apply = db.transaction(() => {
      db.exec("DELETE FROM entry_fts; DELETE FROM entries; DELETE FROM conflicts;");
      const insert = db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO entry_fts(id, content) VALUES (?, ?)");
      for (const entry of state.entries) {
        insert.run(entry.id, entry.revision, entry.headOpId, entry.owner, entry.scope, entry.target, entry.content, entry.category, entry.failureReason, entry.created, entry.updated, entry.deleted ? 1 : 0);
        if (!entry.deleted) insertFts.run(entry.id, entry.content);
      }
      const insertConflict = db.prepare("INSERT INTO conflicts VALUES (?, ?, ?, ?, ?, ?)");
      for (const conflict of state.conflicts) insertConflict.run(conflict.opId, conflict.entryId, conflict.writer, conflict.reason, conflict.expectedRevision, conflict.actualRevision);
      db.prepare("INSERT INTO metadata(key,value) VALUES('journal_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(state.journalHash);
    });
    apply();
  }

  search(query: string, scopes: MemoryScope[], options: { target?: SharedMemoryTarget; category?: MemoryCategory; limit: number }): SharedMemoryEntry[] {
    const db = this.open();
    const scopeMarks = scopes.map(() => "?").join(",");
    const conditions = [`e.deleted=0`, `e.scope IN (${scopeMarks})`, "e.id IN (SELECT id FROM entry_fts WHERE entry_fts MATCH ?)"];
    const params: unknown[] = [...scopes, `"${query.trim().replace(/"/g, '""')}"`];
    if (options.target) { conditions.push("e.target=?"); params.push(options.target); }
    if (options.category) { conditions.push("e.category=?"); params.push(options.category); }
    params.push(options.limit);
    return db.prepare(`SELECT * FROM entries e WHERE ${conditions.join(" AND ")} ORDER BY e.updated DESC, e.id LIMIT ?`).all(...params).map((row: any) => ({
      id: row.id, revision: row.revision, headOpId: row.head_op_id, owner: row.owner, scope: row.scope, target: row.target,
      content: row.content, category: row.category, failureReason: row.failure_reason,
      created: row.created, updated: row.updated, deleted: Boolean(row.deleted),
    }));
  }

  close(): void { if (this.db) { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.close(); this.db = null; } }
}

export class SharedMemoryJournal {
  readonly writerHost: string;
  private readonly index: LocalJournalIndex;

  constructor(private readonly options: SharedMemoryJournalOptions) {
    this.writerHost = safeWriter(options.writerHost);
    fs.mkdirSync(options.sharedRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(options.localIndexDir, { recursive: true, mode: 0o700 });
    const sharedResolved = fs.realpathSync(options.sharedRoot);
    const localResolved = fs.realpathSync(options.localIndexDir);
    if (localResolved === sharedResolved || localResolved.startsWith(sharedResolved + path.sep)) {
      throw new Error("localIndexDir must be outside sharedRoot; active SQLite must never be synchronized");
    }
    this.index = new LocalJournalIndex(path.join(localResolved, "shared-memory.db"));
  }

  private journalRoot(): string { return path.join(this.options.sharedRoot, "journal"); }
  private writerDir(): string { return path.join(this.journalRoot(), this.writerHost); }

  load(): JournalState {
    const operations: JournalOperation[] = [];
    if (fs.existsSync(this.journalRoot())) {
      assertRealDirectory(this.journalRoot(), this.options.sharedRoot);
      for (const writer of fs.readdirSync(this.journalRoot()).sort()) {
        const directory = path.join(this.journalRoot(), writer);
        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink()) throw new Error(`Journal writer partition cannot be a symlink: ${directory}`);
        if (!stat.isDirectory()) continue;
        assertRealDirectory(directory, this.options.sharedRoot);
        for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
          const filePath = path.join(directory, name);
          const fileStat = fs.lstatSync(filePath);
          if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error(`Journal operation must be a regular file: ${filePath}`);
          const operation = parseOperation(fs.readFileSync(filePath, "utf8"), filePath);
          if (operation.writer !== writer) throw new Error(`Journal writer does not match partition: ${filePath}`);
          operations.push(operation);
        }
      }
    }
    const state = reconcileOperations(operations);
    this.index.rebuild(state);
    return state;
  }

  private append(op: JournalOperation): void {
    const journalRoot = this.journalRoot();
    fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
    assertRealDirectory(journalRoot, this.options.sharedRoot);
    const directory = this.writerDir();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertRealDirectory(directory, this.options.sharedRoot);
    const filePath = path.join(directory, `${op.opId}.json`);
    const tempPath = path.join(directory, `.${op.opId}.tmp`);
    const handle = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(op) + "\n");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    try {
      fs.renameSync(tempPath, filePath);
      const directoryHandle = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  add(input: { scope: string; target: SharedMemoryTarget; content: string; category?: MemoryCategory | null; failureReason?: string | null; entryId?: string; timestamp?: string }): SharedMemoryEntry {
    const content = input.content.trim();
    if (!content) throw new Error("content cannot be empty");
    scanPersistedText(content, "content");
    scanPersistedText(input.failureReason, "failureReason");
    const scope = validateMemoryScope(input.scope);
    const entryId = input.entryId ?? randomUUID();
    this.append({ schema: 1, opId: randomUUID(), writer: this.writerHost, timestamp: input.timestamp ?? new Date().toISOString(), entryId, action: "add", expectedRevision: 0, scope, target: input.target, content, category: input.category ?? null, failureReason: input.failureReason ?? null });
    const state = this.load();
    const entry = state.entries.find((item) => item.id === entryId && !item.deleted);
    if (!entry) throw new Error(`add did not reconcile; inspect conflicts for entry ${entryId}`);
    return entry;
  }

  update(entryId: string, expectedRevision: number, expectedParentOpId: string, input: { content: string; scope?: string; category?: MemoryCategory | null; failureReason?: string | null }): SharedMemoryEntry {
    const content = input.content.trim();
    if (!content) throw new Error("content cannot be empty");
    scanPersistedText(content, "content");
    scanPersistedText(input.failureReason, "failureReason");
    const opId = randomUUID();
    this.append({ schema: 1, opId, writer: this.writerHost, timestamp: new Date().toISOString(), entryId, action: "update", expectedRevision, expectedParentOpId, scope: input.scope ? validateMemoryScope(input.scope) : undefined, content, category: input.category, failureReason: input.failureReason });
    const state = this.load();
    const conflict = state.conflicts.find((item) => item.opId === opId);
    if (conflict) throw new Error(`revision conflict for ${entryId}: expected ${expectedRevision}, actual ${conflict.actualRevision ?? "missing"}`);
    const entry = state.entries.find((item) => item.id === entryId && !item.deleted);
    if (!entry) throw new Error(`entry not found: ${entryId}`);
    return entry;
  }

  remove(entryId: string, expectedRevision: number, expectedParentOpId: string): void {
    const opId = randomUUID();
    this.append({ schema: 1, opId, writer: this.writerHost, timestamp: new Date().toISOString(), entryId, action: "delete", expectedRevision, expectedParentOpId });
    const state = this.load();
    const conflict = state.conflicts.find((item) => item.opId === opId);
    if (conflict) throw new Error(`revision conflict for ${entryId}: expected ${expectedRevision}, actual ${conflict.actualRevision ?? "missing"}`);
  }

  search(query: string, scopes: MemoryScope[], options: { target?: SharedMemoryTarget; category?: MemoryCategory; limit?: number } = {}): SharedMemoryEntry[] {
    if (!query.trim() || scopes.length === 0) return [];
    this.load();
    try { return this.index.search(query, scopes, { ...options, limit: Math.min(options.limit ?? 10, 50) }); }
    catch { return this.load().entries.filter((entry) => !entry.deleted && scopes.includes(entry.scope) && entry.content.toLowerCase().includes(query.trim().toLowerCase()) && (!options.target || entry.target === options.target) && (!options.category || entry.category === options.category)).slice(0, options.limit ?? 10); }
  }

  close(): void { this.index.close(); }
}
