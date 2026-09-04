import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SharedMemoryJournal } from "../../src/store/shared-memory-journal.js";
import { registerSharedMemoryTools } from "../../src/tools/shared-memory-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("shared memory search scope boundary", () => {
  it("rejects inactive explicit scopes unless all_scopes is explicit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-tools-")); roots.push(root);
    const config = { enabled: true, sharedRoot: path.join(root, "shared"), localIndexDir: path.join(root, "local"), writerHost: "dev" };
    const journal = new SharedMemoryJournal(config);
    journal.add({ scope: "host:laptop", target: "memory", content: "private laptop needle" });
    const tools = new Map<string, any>();
    registerSharedMemoryTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any, journal, config);
    const search = tools.get("memory_search");
    const blocked = await search.execute("id", { query: "needle", scopes: ["host:laptop"] }, undefined, undefined, { cwd: root });
    assert.equal(blocked.details.success, false); assert.match(blocked.details.error, /outside the active context/);
    const explicit = await search.execute("id", { query: "needle", all_scopes: true }, undefined, undefined, { cwd: root });
    assert.equal(explicit.details.success, true); assert.equal(explicit.details.count, 1);
    journal.close();
  });
});
