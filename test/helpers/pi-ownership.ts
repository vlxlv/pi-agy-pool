import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgyPoolProvider } from "../../src/provider.ts";
import { MODELS } from "../../src/models.ts";
import { piModule, FakeAgy } from "./pi-progress.ts";
export async function ownershipHarness(persist = false, configure?: (pi: any) => void) {
    const dir = await mkdtemp(join(tmpdir(), "pi-ownership-"));
    const { DefaultResourceLoader } = await piModule("core/resource-loader");
    const { SettingsManager } = await piModule("core/settings-manager");
    const { SessionManager } = await piModule("core/session-manager");
    const { ModelRuntime } = await piModule("core/model-runtime");
    const { createAgentSession } = await piModule("core/sdk");
    const { AgentSessionRuntime } = await piModule("core/agent-session-runtime");
    const settingsManager = SettingsManager.inMemory({ quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false, allowModelNetwork: false });
    const model = { ...MODELS[0], provider: "agy-pool", api: "agy-pool-api", baseUrl: "agy-pool" };
    const children: (FakeAgy & {
        args: string[];
        spawnOptions: any;
    })[] = [];
    const events: string[] = [];
    async function create(options: any) {
        const cwd = options.cwd ?? options.sessionManager.getCwd();
        const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [(pi: any) => {
                    for (const name of ["session_start", "session_before_fork", "session_shutdown", "session_tree", "session_before_switch"])
                        pi.on(name, (e: any) => events.push(name + ":" + (e.reason || "")));
                    configure?.(pi);
                    const register = pi.registerProvider;
                    registerAgyPoolProvider({ ...pi, registerProvider(name: string, config: any) { register(name, { ...config, streamSimple(m: any, c: any, o: any) { return config.streamSimple(m, c, { ...o, spawnFn: (_bin: string, args: string[], spawnOptions: any) => { const child = Object.assign(new FakeAgy(), { args, spawnOptions }); children.push(child); return child; } }); } }); } });
                }] });
        await resourceLoader.reload();
        const result = await createAgentSession({ cwd, agentDir: dir, resourceLoader, settingsManager, modelRuntime, model, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "all" });
        return { ...result, services: { cwd, agentDir: dir }, diagnostics: [] };
    }
    const manager = persist ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
    const first = await create({ sessionManager: manager });
    let host = new AgentSessionRuntime(first.session, first.services, create);
    host.setRebindSession((session: any) => session.bindExtensions({ mode: "print" }));
    await first.session.bindExtensions({ mode: "print" });
    return { dir, get host() { return host; }, children, events, create, SessionManager, async reopen(file: string) { const next = await create({ sessionManager: SessionManager.open(file), sessionStartEvent: { type: "session_start", reason: "resume" } }); host = new AgentSessionRuntime(next.session, next.services, create); host.setRebindSession((s: any) => s.bindExtensions({ mode: "print" })); await next.session.bindExtensions({ mode: "print" }); }, get session() { return host.session; }, async close() { await host.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
