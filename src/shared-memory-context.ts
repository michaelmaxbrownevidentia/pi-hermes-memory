import * as fs from "node:fs";
import * as path from "node:path";
import { detectProject } from "./project.js";
import type { MemoryScope } from "./store/shared-memory-journal.js";

export interface SharedScopeRule { scope: `org:${string}`; pathPrefixes: string[]; }
export interface SharedMemoryConfig {
  enabled: boolean;
  sharedRoot: string;
  localIndexDir: string;
  writerHost: string;
  scopeRules?: SharedScopeRule[];
  activeWorkflows?: string[];
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : path.resolve(value);
}

export function normalizeSharedMemoryConfig(config: SharedMemoryConfig): SharedMemoryConfig {
  return { ...config, sharedRoot: expandHome(config.sharedRoot), localIndexDir: expandHome(config.localIndexDir) };
}

export function repoScopeForCwd(cwd?: string): MemoryScope | null {
  const project = detectProject("projects-memory", cwd);
  if (!project.name) return null;
  const name = project.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name ? `repo:${name}` : null;
}

export function activeMemoryScopes(config: SharedMemoryConfig, cwd?: string): MemoryScope[] {
  const resolved = cwd ? path.resolve(cwd) : process.cwd();
  const scopes = new Set<MemoryScope>(["global", `host:${config.writerHost.toLowerCase()}`]);
  const repo = repoScopeForCwd(resolved); if (repo) scopes.add(repo);
  for (const rule of config.scopeRules ?? []) {
    if (rule.pathPrefixes.some((prefix) => {
      const base = expandHome(prefix);
      return resolved === base || resolved.startsWith(base + path.sep);
    })) scopes.add(rule.scope.toLowerCase() as MemoryScope);
  }
  for (const workflow of config.activeWorkflows ?? []) scopes.add(`workflow:${workflow.toLowerCase()}`);
  return [...scopes].sort();
}

export function defaultWriteScope(config: SharedMemoryConfig, target: "memory" | "user" | "failure" | "project", cwd?: string): MemoryScope {
  if (target === "project") return repoScopeForCwd(cwd) ?? `host:${config.writerHost.toLowerCase()}`;
  if (target === "user") return "global";
  const active = activeMemoryScopes(config, cwd);
  return active.find((scope) => scope.startsWith("repo:"))
    ?? active.find((scope) => scope.startsWith("org:"))
    ?? `host:${config.writerHost.toLowerCase()}`;
}

export function assertSharedRootSafe(config: SharedMemoryConfig): void {
  fs.mkdirSync(config.sharedRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.localIndexDir, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(config.sharedRoot);
  const index = fs.realpathSync(config.localIndexDir);
  if (root === index || index.startsWith(root + path.sep)) throw new Error("localIndexDir must not be inside sharedRoot");
}
