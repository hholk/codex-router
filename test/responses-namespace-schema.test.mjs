import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { spawnNodeFixture, waitForNodeFixture } from "./node-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "responses-schema-caller-key-with-sufficient-length";
const internal = "responses-schema-internal-key-with-sufficient-length";

test("Responses routing repairs native namespace union schemas before a strict upstream validates them", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "responses-namespace-schema-"));
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push(body);
    const inventories = [body.tools, ...body.input
      .filter(item => item.type === "tool_search_output").map(item => item.tools)];
    const invalid = inventories.some(tools => tools.some(namespace => namespace.tools.some(tool => {
      const schema = tool.parameters ?? tool.inputSchema;
      return ["oneOf", "anyOf", "allOf"].some(keyword => keyword in schema);
    })));
    response.writeHead(invalid ? 400 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(invalid
      ? { error: { message: "input_schema does not support oneOf, allOf, or anyOf at the top level" } }
      : { id: "resp_schema", object: "response", status: "completed", output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
        ], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const routerPort = await openPort();
  const apiPort = await openPort();
  const providers = path.join(directory, "generic-providers.json");
  const models = path.join(directory, "user-models.json");
  writeFileSync(providers, JSON.stringify({ version: 1, providers: [{
    id: "fixture-responses", displayName: "Fixture", adapter: "openai-responses",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, allowPrivate: true, enabled: true,
  }] }));
  const model = {
    slug: "fixture-responses/opus", gatewayModel: "fixture-responses-opus", compHash: "fixture",
    upstreamModel: "opus", provider: "fixture-responses", displayName: "Fixture Opus", listed: true,
    description: "Synthetic Responses schema validation fixture.",
    priority: 100, defaultEffort: "medium", reasoningLevels: [{ effort: "medium", description: "Medium" }],
    contextWindow: 1000000, autoCompact: 850000, inputModalities: ["text"],
  };
  writeFileSync(models, JSON.stringify({ version: 1, models: [model, { ...model,
    slug: "fixture-responses/wonder", gatewayModel: "fixture-responses-wonder", upstreamModel: "wonder",
    requestProfile: "auto-tool-choice",
  }] }));
  const env = { ...process.env, CODEX_HOME: path.join(directory, "codex"),
    MODEL_ROUTER_STATE_DIR: directory, CODEX_ROUTER_STATE_DIR: directory,
    MODEL_ROUTER_GENERIC_PROVIDERS: providers, MODEL_ROUTER_USER_MODELS: models,
    CODEX_ROUTER_CALLER_KEY: caller, MODEL_ROUTER_CALLER_KEY: caller,
    CODEX_ROUTER_INTERNAL_KEY: internal, MODEL_ROUTER_INTERNAL_KEY: internal,
    CODEX_ROUTER_PORT: String(routerPort), MODEL_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_PORT: String(apiPort), MODEL_ROUTER_API_PORT: String(apiPort),
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${upstream.address().port}/unexpected`,
    CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1" };
  const children = [];
  try {
    for (const script of ["api-forwarder.mjs", "router.mjs"]) {
      children.push(spawnNodeFixture(path.join(root, "src", script), { cwd: root, env }));
    }
    const base = callerBaseUrl(routerPort, caller);
    await waitForNodeFixture(`http://127.0.0.1:${apiPort}/health`, children[0], {
      headers: { Authorization: `Bearer ${internal}` },
    });
    await waitForNodeFixture(`${base}/models`, children[1]);
    for (const upstreamModel of ["opus", "wonder"]) {
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        for (const field of ["parameters", "inputSchema"]) {
          const schema = { [keyword]: [
            { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          ] };
          const tools = [{ type: "namespace", name: "fixture", description: "Fixture tools.",
            tools: [{ type: "function", name: "lookup", [field]: schema, defer_loading: true }] }];
          const response = await fetch(`${base}/responses`, { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({
              model: `fixture-responses/${upstreamModel}`, tool_choice: "required", input: [
                { type: "tool_search_call", call_id: "search_fixture", execution: "client", arguments: { query: "lookup" } },
                { type: "tool_search_output", call_id: "search_fixture", execution: "client", status: "completed", tools },
                { role: "user", content: "Reply OK." },
              ], tools, stream: false,
              reasoning: { effort: "medium" }, prompt_cache_key: "stable-prefix",
            }) });
          const result = await response.json();
          assert.equal(response.status, 200, JSON.stringify(result));
          assert.equal(result.output[0].content[0].text, "OK");
          const sent = received.at(-1);
          assert.equal(sent.model, upstreamModel);
          assert.equal(sent.tool_choice, upstreamModel === "wonder" ? "auto" : "required");
          assert.equal(sent.tools.length, 1, "must not expand the deferred inventory");
          assert.equal(sent.tools[0].type, "namespace");
          assert.equal(sent.tools[0].tools[0].defer_loading, true);
          assert.equal(sent.tools[0].tools[0][field][keyword], undefined);
          assert.deepEqual(Object.keys(sent.tools[0].tools[0][field].properties).sort(), ["id", "query"]);
          assert.equal(sent.prompt_cache_key, "stable-prefix");
          assert.deepEqual(sent.reasoning, { effort: "medium" });
          const discovered = sent.input.find(item => item.type === "tool_search_output");
          assert.equal(discovered.tools[0].tools[0][field][keyword], undefined);
          assert.equal(discovered.tools[0].tools[0].defer_loading, true);
          assert.deepEqual(tools[0].tools[0][field], schema);
        }
      }
    }
    assert.equal(received.length, 12);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise(resolve => child.once("exit", resolve));
      }
    }
    await new Promise(resolve => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
