import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { registerAgyPoolProvider } from "../../src/provider.ts";
import { MODELS } from "../../src/models.ts";
import type { AgyStepUpdatePayload } from "../../src/agy-events.ts";

// Test-only access to the pinned Pi implementation, including private TUI methods.
export const piModule = (file: string): Promise<any> => import(new URL(
  `../../node_modules/@earendil-works/pi-coding-agent/dist/${file}.js`,
  import.meta.url,
).href);

export async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(10);
  }
}

export class FakeAgy extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  turns = 0;
  constructor() {
    super();
    this.stdin.on("data", () => this.turns++);
  }
  kill(signal = "SIGTERM") {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
  send(event: object) { this.stdout.write(`${JSON.stringify(event)}\n`); }
  step(step_update: AgyStepUpdatePayload) { this.send({ event: "step_update", step_update }); }
  result() { this.send({ event: "result", status: "SUCCESS" }); }
}

export async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), "pi-agy-progress-"));
  const { DefaultResourceLoader } = await piModule("core/resource-loader");
  const { SettingsManager } = await piModule("core/settings-manager");
  const { SessionManager } = await piModule("core/session-manager");
  const { ModelRuntime } = await piModule("core/model-runtime");
  const { createAgentSession } = await piModule("core/sdk");
  const { AgentSessionRuntime } = await piModule("core/agent-session-runtime");
  const settingsManager = SettingsManager.inMemory({
    quietStartup: true, compaction: { enabled: false }, retry: { enabled: false },
  });
  const children: FakeAgy[] = [];
  let provider: any;
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi: any) => {
      // Inject only the external process transport. Registration, hooks, context,
      // provider composition and AgentSession dispatch remain Pi's real code.
      const register = pi.registerProvider;
      registerAgyPoolProvider({ ...pi, registerProvider(name: string, config: any) {
        provider = { ...config, streamSimple(model: any, context: any, options: any) {
          return config.streamSimple(model, context, { ...options, spawnFn: () => {
            const child = new FakeAgy();
            children.push(child);
            return child;
          } });
        } };
        register(name, provider);
      } });
    }],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models"), refreshOnCreate: false, allowModelNetwork: false,
  });
  const model = { ...MODELS[0], provider: "agy-pool", api: "agy-pool-api", baseUrl: "agy-pool" };
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader, settingsManager, modelRuntime, model,
    sessionManager: SessionManager.inMemory(dir), noTools: "all",
  });
  const host = new AgentSessionRuntime(session, { cwd: dir, agentDir: dir }, async () => {
    throw new Error("Unexpected session replacement in test");
  });
  return {
    session, host, model, children, dir,
    get provider() { return provider; },
    async cleanup() {
      for (const child of children) child.kill();
      await host.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export class CaptureTerminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  writes: string[] = [];
  start() {}
  stop() {}
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

export async function attachTui(h: Awaited<ReturnType<typeof createHarness>>) {
  const { InteractiveMode } = await piModule("modes/interactive/interactive-mode");
  const { initTheme } = await piModule("modes/interactive/theme/theme");
  initTheme("dark");
  const terminal = new CaptureTerminal();
  const mode = new InteractiveMode(h.host, { terminal, tuiMode: "regular" });
  // Mount the real components without CLI onboarding / managed binary downloads.
  // Neither UI setters nor the render scheduler nor lifecycle dispatch are mocked.
  mode.mountInteractiveTui(mode.renderer, [mode.chatContainer, mode.statusContainer, mode.editorContainer, mode.footerContainer]);
  mode.isInitialized = true;
  mode.ui.start();
  await h.session.bindExtensions({ mode: "tui", uiContext: mode.createExtensionUIContext() });
  mode.subscribeToAgent();
  return {
    mode, terminal,
    status: () => mode.footerDataProvider.getExtensionStatuses().get("agy-pool"),
    async close() {
      mode.unsubscribe?.();
      mode.clearStatusIndicator();
      mode.ui.stop();
      mode.footerDataProvider.dispose();
      await h.cleanup();
    },
  };
}
