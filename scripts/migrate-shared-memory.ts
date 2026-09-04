#!/usr/bin/env node
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SharedMemoryJournal, type SharedMemoryTarget } from "../src/store/shared-memory-journal.js";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`missing --${name}`);
  return value.replace(/^~\//, `${process.env.HOME}/`);
}
function sha(data: Buffer | string): string { return createHash("sha256").update(data).digest("hex"); }
function entries(raw: string): string[] { return raw.trim() ? raw.split("§").map((item) => item.trim()).filter(Boolean) : []; }
function visible(raw: string): string { return raw.replace(/\s*<!--\s*created=.*?-->\s*$/s, "").trim(); }
function scopeName(name: string): string { return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); }

const host = arg("host").toLowerCase();
const agentRoot = arg("agent-root", `${process.env.HOME}/.pi/agent`);
const sharedRoot = arg("shared-root", `${process.env.HOME}/.local/share/agent-memory`);
const localIndexDir = arg("local-index-dir", path.join(agentRoot, "pi-hermes-memory"));
const globalDir = path.join(agentRoot, "pi-hermes-memory");
const projectDir = path.join(agentRoot, "projects-memory");
const candidates: Array<{ file: string; target: SharedMemoryTarget; scope: string }> = [];
for (const [name, target] of [["MEMORY.md", "memory"], ["USER.md", "user"], ["failures.md", "failure"]] as const) {
  const file = path.join(globalDir, name); if (fs.existsSync(file)) candidates.push({ file, target, scope: `host:${host}` });
}
if (fs.existsSync(projectDir)) {
  for (const name of fs.readdirSync(projectDir).sort()) {
    const file = path.join(projectDir, name, "MEMORY.md");
    if (fs.existsSync(file)) candidates.push({ file, target: "memory", scope: `repo:${scopeName(name)}` });
  }
}

const allMemoryFiles: string[] = [];
for (const root of [globalDir, projectDir]) {
  if (!fs.existsSync(root)) continue;
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === "shared-migration-backups") continue;
      const child = path.join(directory, item.name);
      if (item.isDirectory()) walk(child);
      else if (/\.md$/i.test(item.name)) allMemoryFiles.push(child);
    }
  };
  walk(root);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(globalDir, "shared-migration-backups", `${stamp}-${host}`);
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const files = allMemoryFiles.sort().map((file) => {
  const relative = path.relative(agentRoot, file);
  const destination = path.join(backupRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  const raw = fs.readFileSync(file);
  return { path: relative, bytes: raw.length, sha256: sha(raw) };
});

const journal = new SharedMemoryJournal({ sharedRoot, localIndexDir, writerHost: host });
let migrated = 0;
for (const candidate of candidates) {
  const raw = fs.readFileSync(candidate.file, "utf8");
  for (const entry of entries(raw)) {
    const content = visible(entry);
    if (!content) continue;
    const entryId = `legacy-${sha(`${candidate.target}\0${candidate.scope}\0${content}`).slice(0, 32)}`;
    journal.add({ scope: candidate.scope, target: candidate.target, content, entryId, timestamp: fs.statSync(candidate.file).mtime.toISOString() });
    migrated++;
  }
}
const state = journal.load();
journal.close();
const manifest = { schema: 1, host, created: new Date().toISOString(), agentRoot, sharedRoot, sourceFiles: files, sourceFileCount: files.length, sourceAggregateHash: sha(files.map((file) => `${file.path}\0${file.sha256}`).join("\n")), candidateEntryCount: migrated, journalOperationCount: state.operationCount, activeEntryCount: state.entries.filter((entry) => !entry.deleted).length, conflictCount: state.conflicts.length, journalHash: state.journalHash, originalsPreserved: files.every((file) => fs.existsSync(path.join(agentRoot, file.path)) && sha(fs.readFileSync(path.join(agentRoot, file.path))) === file.sha256) };
fs.writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const manifestDir = path.join(sharedRoot, "migration-manifests", host);
fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(manifestDir, `${stamp}.json`), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ backupRoot, ...manifest }, null, 2));
