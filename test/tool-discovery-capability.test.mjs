import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { routedModel } from "../src/catalog.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { routedModelSearchAvailable } from "../src/search-capability.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = { slug: "fixture", base_instructions: "Synthetic local test.", model_messages: null };
const entry = (metadata = {}) => userModelEntry({ providerId: "custom", upstreamId: "fixture", priority: 100, metadata });
test("tool discovery is an independent curated capability, including explicit opt-out", () => {
  for (const supportsToolSearch of [true, false]) {
    const model = entry({ supportsToolSearch });
    assert.equal(model.supportsToolSearch, supportsToolSearch);
    assert.equal(routedModel(template, model).supports_search_tool, supportsToolSearch);
    assert.equal(routedModelSearchAvailable(model), false, "discovery must not grant web search");
  }
});
test("explicit discovery overrides legacy web-search projection without changing web capability", () => {
  const hosted = { ...entry(), searchTool: { mode: "hosted" } };
  assert.equal(routedModel(template, hosted).supports_search_tool, true);
  assert.equal(routedModel(template, { ...hosted, supportsToolSearch: false }).supports_search_tool, false);
  assert.equal(routedModelSearchAvailable({ ...hosted, supportsToolSearch: false }), true);
  assert.equal(routedModel({ ...template, supports_search_tool: true }, entry()).supports_search_tool, false);
});
test("registry rejects nonboolean discovery metadata and retains explicit booleans", (t) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "tool-discovery-registry-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const registry = path.join(state, "registry.json");
  for (const value of [true, false, "true", 1, null, {}]) {
    writeFileSync(registry, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Custom", kind: "openai-compatible", ownedBy: "custom", authMode: "per-model", perModelEndpoint: true }], models: [{ ...entry(), supportsToolSearch: value, endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true, protocol: "openai-responses" } }] }));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "const m=await import('./src/model-registry.mjs'); console.log(JSON.stringify(m.MODELS.map(x=>x.supportsToolSearch)))"], { cwd: root, encoding: "utf8", env: { ...process.env, CODEX_HOME: path.join(state, "codex"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_REGISTRY: registry, MODEL_ROUTER_USER_MODELS: path.join(state, "missing-users.json"), MODEL_ROUTER_GENERIC_PROVIDERS: path.join(state, "missing-generic.json") } });
    if (typeof value === "boolean") {
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), [value]);
    } else {
      assert.notEqual(child.status, 0, `accepted invalid ${JSON.stringify(value)}`);
      assert.match(child.stderr, /supportsToolSearch/);
    }
  }
});
