import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { piModule, FakeAgy, until } from "../test/helpers/pi-progress.ts";
import { MODELS } from "../src/models.ts";

async function resources(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "pi-compat-resources-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const skill = join(dir, "skills", "compat-catalog");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: compat-catalog\ndescription: COMPAT_SKILL_CATALOG_MARK\n---\nCOMPAT_SKILL_BODY_NOT_LOADED\n");
  const { DefaultResourceLoader } = await piModule("core/resource-loader");
  const { SettingsManager } = await piModule("core/settings-manager");
  const { ModelRuntime } = await piModule("core/model-runtime");
  const { SessionManager } = await piModule("core/session-manager");
  const { createAgentSession } = await piModule("core/sdk");
  const { AgentSessionRuntime } = await piModule("core/agent-session-runtime");
  const settingsManager = SettingsManager.inMemory({ quietStartup: true, retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../src/index.ts")],
    additionalSkillPaths: [skill],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const registration = loaded.runtime.pendingProviderRegistrations.find((p: any) => p.name === "agy-pool");
  assert(registration, "actual extension entry registered provider");
  const original = registration.config.streamSimple;
  const children: FakeAgy[] = [];
  // Only replace the external child process; keep Pi loading/registration/request machinery.
  registration.config.streamSimple = (m: any, c: any, o: any) => original(m, c, {
    ...o, spawnFn: () => { const child = new FakeAgy(); children.push(child); return child; },
  });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models"), refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), tools: ["read"],
    model: { ...MODELS[0], provider: "agy-pool", api: "agy-pool-api", baseUrl: "agy-pool" } });
  const host = new AgentSessionRuntime(session, { cwd: dir, agentDir: dir }, async () => { throw Error("unexpected replacement"); });
  t.after(() => host.dispose());
  await session.bindExtensions({ mode: "print" });
  return { loader, modelRuntime, session, children };
}

test("compat extension entry loads and registers seven models", async t => {
  const h = await resources(t);
  const provider = h.modelRuntime.getRegisteredProviderConfig("agy-pool");
  assert.equal(provider.api, "agy-pool-api");
  assert.deepEqual(provider.models.map((m: any) => m.id), MODELS.map(m => m.id));
  assert.equal(provider.models.length, 7);
});

test("compat discovered skill catalog reaches the real provider context", async t => {
  const h = await resources(t);
  assert(h.loader.getSkills().skills.some((s: any) => s.name === "compat-catalog"));
  const events: string[] = [];
  h.session.subscribe((event: any) => { events.push(event.type); if (event.assistantMessageEvent) events.push(event.assistantMessageEvent.type); });
  const pending = h.session.prompt("Describe the available catalog without executing a skill.");
  await until(() => h.children.length === 1, "provider spawned");
  const child = h.children[0];
  child.send({ event: "init", conversation_id: "compat-skills" });
  await until(() => child.turns === 1, "bootstrap submitted");
  const records = JSON.parse(child.inputs[0].split("\n").slice(1).join("\n"));
  assert(records.some((r: any) => r.role === "system" && r.content.includes("COMPAT_SKILL_CATALOG_MARK")));
  assert(child.inputs[0].includes("compat-catalog"));
  assert(!child.inputs[0].includes("COMPAT_SKILL_BODY_NOT_LOADED"));
  child.step({ step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "read_file" });
  child.step({ step_type: "tool", step_index: 1, state: "DONE" });
  child.step({ step_type: "agent_response", text_delta: "Catalog observed." });
  child.result();
  await pending;
  assert(!events.some(e => /^(toolcall_|tool_execution|thinking_)/.test(e)));
  assert(!h.session.state.messages.some((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "toolCall")));
});
