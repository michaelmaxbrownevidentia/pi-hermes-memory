import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { MemoryCategory } from "../types.js";
import { activeMemoryScopes, defaultWriteScope, type SharedMemoryConfig } from "../shared-memory-context.js";
import { SharedMemoryJournal, validateMemoryScope, type MemoryScope, type SharedMemoryTarget } from "../store/shared-memory-journal.js";

const targetSchema = StringEnum(["memory", "user", "project", "failure"] as const);
const categorySchema = StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const);

function storedTarget(target: string): SharedMemoryTarget { return target === "project" ? "memory" : target as SharedMemoryTarget; }

export function registerSharedMemoryTools(pi: ExtensionAPI, journal: SharedMemoryJournal, config: SharedMemoryConfig): void {
  pi.registerTool({
    name: "memory_add", label: "Memory Add", promptSnippet: "Add scoped durable memory", description: "Add one durable scoped entry to the conflict-safe shared journal. scope is explicit; omit it only to use the active repo/org/host safe default.",
    parameters: Type.Object({
      target: targetSchema,
      content: Type.String(),
      scope: Type.Optional(Type.String({ description: "global, host:<name>, org:<name>, repo:<name>, or workflow:<name>" })),
      category: Type.Optional(categorySchema),
      failure_reason: Type.Optional(Type.String()),
    }),
    async execute(_id, raw: any, _signal, _update, ctx?: { cwd?: string }): Promise<any> {
      try {
        const scope = raw.scope ? validateMemoryScope(raw.scope) : defaultWriteScope(config, raw.target, ctx?.cwd);
        const entry = journal.add({ scope, target: storedTarget(raw.target), content: raw.content, category: raw.category, failureReason: raw.failure_reason });
        const details = { success: true, entry_id: entry.id, revision: entry.revision, head_op_id: entry.headOpId, scope: entry.scope, target: raw.target };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = { success: false, error: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
    },
  });

  pi.registerTool({
    name: "memory_replace", label: "Memory Replace", promptSnippet: "Revision-checked memory update", description: "Replace one entry by stable entry_id, expected_revision, and expected_parent_op_id from search. Optionally supply scope to move/promote it. Substring mutation is intentionally unavailable in shared mode.",
    parameters: Type.Object({ entry_id: Type.String(), expected_revision: Type.Integer({ minimum: 1 }), expected_parent_op_id: Type.String(), content: Type.String(), scope: Type.Optional(Type.String()), category: Type.Optional(categorySchema), failure_reason: Type.Optional(Type.String()) }),
    async execute(_id, raw: any): Promise<any> {
      try {
        const entry = journal.update(raw.entry_id, raw.expected_revision, raw.expected_parent_op_id, { content: raw.content, scope: raw.scope, category: raw.category, failureReason: raw.failure_reason });
        const details = { success: true, entry_id: entry.id, revision: entry.revision, head_op_id: entry.headOpId, scope: entry.scope };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = { success: false, error: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
    },
  });

  pi.registerTool({
    name: "memory_remove", label: "Memory Remove", promptSnippet: "Revision-checked memory deletion", description: "Delete one entry by stable entry_id, expected_revision, and expected_parent_op_id from search. The append-only tombstone remains auditable.",
    parameters: Type.Object({ entry_id: Type.String(), expected_revision: Type.Integer({ minimum: 1 }), expected_parent_op_id: Type.String() }),
    async execute(_id, raw: any): Promise<any> {
      try {
        journal.remove(raw.entry_id, raw.expected_revision, raw.expected_parent_op_id);
        const details = { success: true, entry_id: raw.entry_id, revision: raw.expected_revision + 1 };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = { success: false, error: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
    },
  });

  pi.registerTool({
    name: "memory_search", label: "Memory Search", promptSnippet: "Search safely scoped shared memory", description: "Search shared memory. By default only global plus the active host, organisation, repository and configured workflow scopes are searched. Set all_scopes only for explicit cross-scope audit.",
    parameters: Type.Object({
      query: Type.String(), target: Type.Optional(targetSchema), category: Type.Optional(categorySchema),
      scopes: Type.Optional(Type.Array(Type.String())), all_scopes: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, raw: any, _signal, _update, ctx?: { cwd?: string }): Promise<any> {
      try {
        const state = journal.load();
        let scopes: MemoryScope[];
        if (raw.all_scopes) scopes = [...new Set(state.entries.map((entry) => entry.scope))];
        else if (raw.scopes) scopes = raw.scopes.map(validateMemoryScope);
        else scopes = activeMemoryScopes(config, ctx?.cwd);
        const target = raw.target ? storedTarget(raw.target) : undefined;
        const entries = journal.search(raw.query, scopes, { target, category: raw.category as MemoryCategory | undefined, limit: raw.limit });
        const output = entries.map((entry) => `[entry_id=${entry.id}] [revision=${entry.revision}] [head_op_id=${entry.headOpId}] [scope=${entry.scope}] [target=${entry.target}]${entry.category ? ` [${entry.category}]` : ""} ${entry.content}`).join("\n\n");
        const details = {
          success: true,
          count: entries.length,
          scopes,
          conflict_count: state.conflicts.length,
          conflicts: state.conflicts.slice(0, 20).map((conflict) => ({
            op_id: conflict.opId,
            entry_id: conflict.entryId,
            writer: conflict.writer,
            reason: conflict.reason,
            expected_revision: conflict.expectedRevision,
            actual_revision: conflict.actualRevision,
          })),
          output,
        };
        return { content: [{ type: "text" as const, text: output || "No memories found." }], details };
      } catch (error) {
        const details = { success: false, error: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
    },
  });
}
