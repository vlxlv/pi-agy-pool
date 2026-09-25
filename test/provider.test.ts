import { setImmediate as drain } from "node:timers/promises";
import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { registerAgyPoolProvider, DEFAULT_BASE_URL } from "../src/provider.ts";
import { MODELS } from "../src/models.ts";
import { resetActiveProcesses, activeProcesses } from "../src/stream.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("provider.ts: Pi real provider integration", () => {
  it("registers provider with real Pi composeModelProvider validator and resolves all 7 models", async () => {
    let registeredProviderName = "";
    let registeredConfig: any = null;
    const registeredHandlers: Record<string, Function> = {};

    const mockPi: Partial<ExtensionAPI> = {
      registerProvider: (((name: string, config: any) => {
        registeredProviderName = name;
        registeredConfig = config;
      }) as unknown) as ExtensionAPI["registerProvider"],
      on: (((event: string, handler: any) => {
        registeredHandlers[event] = handler;
        return () => {};
      }) as unknown) as ExtensionAPI["on"],
    };

    registerAgyPoolProvider(mockPi as ExtensionAPI);

    assert.strictEqual(registeredProviderName, "agy-pool");
    assert.ok(registeredConfig, "registerProvider was called with config");
    assert.strictEqual(registeredConfig.baseUrl, DEFAULT_BASE_URL);
    assert.strictEqual(registeredConfig.baseUrl, "agy-pool");
    assert.strictEqual(registeredConfig.api, "agy-pool-api");
    assert.strictEqual(typeof registeredConfig.streamSimple, "function");

    // Load Pi's real composeModelProvider function from @earendil-works/pi-coding-agent
    const composerPath = path.resolve(
      import.meta.dirname,
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js",
    );
    const { composeModelProvider } = await import("file://" + composerPath);

    // Call Pi's actual composition logic with our registered provider config
    // This strictly verifies that Pi does not throw "baseUrl is required when defining custom models"
    const composed = composeModelProvider(
      "agy-pool",
      undefined,
      {
        getProviderIds: () => [],
        getProvider: () => null,
        getError: () => null,
      },
      registeredConfig,
    );

    assert.ok(composed, "Provider composition succeeded");
    assert.strictEqual(composed.id, "agy-pool");
    assert.strictEqual(composed.baseUrl, "agy-pool");

    // Verify all 7 canonical models resolve from Pi's getModels()
    const resolvedModels = composed.getModels();
    assert.strictEqual(resolvedModels.length, 7);
    const expectedModelIds = [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ];
    assert.deepStrictEqual(
      resolvedModels.map((m: any) => m.id),
      expectedModelIds,
    );
  });

  it("baseUrl is metadata only and never used for direct HTTP generation", async () => {
    // Intercept global fetch to prove baseUrl is never called via HTTP
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (url: any) => {
      fetchCalled = true;
      throw new Error(`Unexpected HTTP fetch call to ${url}`);
    }) as any;

    try {
      // Execute streamSimple using mock child process
      const { PassThrough } = await import("node:stream");
      const { EventEmitter } = await import("node:events");
      const childEmitter = new EventEmitter() as any;
      childEmitter.stdin = new PassThrough();
      childEmitter.stdout = new PassThrough();
      childEmitter.stderr = new PassThrough();
      childEmitter.killed = false;
      childEmitter.kill = () => {
        childEmitter.killed = true;
        queueMicrotask(() => childEmitter.emit("exit", 0, "SIGTERM"));
        return true;
      };

      const spawnFn = (() => childEmitter) as any;
      const model = {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        baseUrl: "agy-pool",
        api: "agy-pool-api",
        provider: "agy-pool",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      } as any;

      const { streamSimple } = await import("../src/stream.ts");
      const stream = streamSimple(
        model,
        { messages: [{ role: "user", content: "Hi", timestamp: 1 }] } as any,
        { spawnFn },
      );

      childEmitter.stdout.write('{"event":"init","conversation_id":"c-no-http"}\n');
      await drain();
      childEmitter.stdout.write('{"event":"step_update","step_update":{"text_delta":"OK"}}\n');
      childEmitter.stdout.write('{"event":"result","status":"SUCCESS"}\n');

      const res = await stream.result();
      assert.strictEqual(fetchCalled, false, "fetch() must never be called");
      assert.strictEqual(res.stopReason, "stop");
    } finally {
      globalThis.fetch = originalFetch;
      resetActiveProcesses();
    }
  });

  it("unbound Pi session_shutdown preserves unrelated process ownership", () => {
    resetActiveProcesses();

    const registeredHandlers: Record<string, Function> = {};
    const mockPi: Partial<ExtensionAPI> = {
      registerProvider: ((() => {}) as unknown) as ExtensionAPI["registerProvider"],
      on: (((event: string, handler: any) => {
        registeredHandlers[event] = handler;
        return () => {};
      }) as unknown) as ExtensionAPI["on"],
    };

    registerAgyPoolProvider(mockPi as ExtensionAPI);
    assert.ok(
      typeof registeredHandlers["session_shutdown"] === "function",
      "Must register session_shutdown handler",
    );

    // Mock an active process in activeProcesses
    let killed = false;
    const mockProc = {
      kill: () => {
        killed = true;
      },
    } as any;
    activeProcesses.set("conv-lifecycle-test", mockProc);
    assert.strictEqual(activeProcesses.size, 1);

    // Trigger session_shutdown event
    registeredHandlers["session_shutdown"]({ type: "session_shutdown", reason: "quit" });

    assert.strictEqual(killed, false, "An unbound shutdown must not kill another session");
    assert.strictEqual(activeProcesses.size, 1, "Unowned diagnostic entries are not routing authority");
    activeProcesses.delete("conv-lifecycle-test");
  });

  it("real Pi composeModelProvider correctly propagates reasoning and thinkingLevelMap", async () => {
    let registeredConfig: any = null;
    const mockPi: Partial<ExtensionAPI> = {
      registerProvider: (((_name: string, config: any) => {
        registeredConfig = config;
      }) as unknown) as ExtensionAPI["registerProvider"],
      on: (((_event: string, _handler: any) => () => {}) as unknown) as ExtensionAPI["on"],
    };

    registerAgyPoolProvider(mockPi as ExtensionAPI);

    const composerPath = path.resolve(
      import.meta.dirname,
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js",
    );
    const { composeModelProvider } = await import("file://" + composerPath);

    const composed = composeModelProvider(
      "agy-pool",
      undefined,
      {
        getProviderIds: () => [],
        getProvider: () => null,
        getError: () => null,
      },
      registeredConfig,
    );

    const models = composed.getModels();
    const flash38 = models.find((m: any) => m.id === "gemini-3.8-flash");
    assert.ok(flash38);
    assert.strictEqual(flash38.reasoning, true);
    assert.deepStrictEqual(flash38.thinkingLevelMap, {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });

    const pro31 = models.find((m: any) => m.id === "gemini-3.1-pro");
    assert.ok(pro31);
    assert.strictEqual(pro31.reasoning, true);
    assert.deepStrictEqual(pro31.thinkingLevelMap, {
      off: null,
      minimal: null,
      medium: null,
      low: "low",
      high: "high",
      xhigh: null,
      max: null,
    });

    const sonnet = models.find((m: any) => m.id === "claude-sonnet-4-6");
    assert.ok(sonnet);
    assert.strictEqual(sonnet.reasoning, false);
    assert.strictEqual(sonnet.thinkingLevelMap, undefined);

    const gpt = models.find((m: any) => m.id === "gpt-oss-120b-medium");
    assert.ok(gpt);
    assert.strictEqual(gpt.reasoning, false);
    assert.strictEqual(gpt.thinkingLevelMap, undefined);
  });

  it("real Pi composed provider streamSimple maps thinking levels to AGY --effort arguments", async () => {
    resetActiveProcesses();
    const { PassThrough } = await import("node:stream");
    const { EventEmitter } = await import("node:events");

    let registeredConfig: any = null;
    const mockPi: Partial<ExtensionAPI> = {
      registerProvider: (((_name: string, config: any) => {
        registeredConfig = config;
      }) as unknown) as ExtensionAPI["registerProvider"],
      on: (((_event: string, _handler: any) => () => {}) as unknown) as ExtensionAPI["on"],
    };

    registerAgyPoolProvider(mockPi as ExtensionAPI);

    const composerPath = path.resolve(
      import.meta.dirname,
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js",
    );
    const { composeModelProvider } = await import("file://" + composerPath);

    const composed = composeModelProvider(
      "agy-pool",
      undefined,
      {
        getProviderIds: () => [],
        getProvider: () => null,
        getError: () => null,
      },
      registeredConfig,
    );

    const models = composed.getModels();
    const flashModel = models.find((m: any) => m.id === "gemini-3.8-flash");
    const proModel = models.find((m: any) => m.id === "gemini-3.1-pro");
    const claudeModel = models.find((m: any) => m.id === "claude-sonnet-4-6");
    const gptModel = models.find((m: any) => m.id === "gpt-oss-120b-medium");

    const testEffort = async (model: any, reasoning: any, expectedEffort: string | undefined) => {
      resetActiveProcesses();
      let spawnedArgs: string[] = [];
      const childEmitter = new EventEmitter() as any;
      childEmitter.stdin = new PassThrough();
      childEmitter.stdout = new PassThrough();
      childEmitter.stderr = new PassThrough();
      childEmitter.killed = false;
      childEmitter.kill = () => {
        childEmitter.killed = true;
        queueMicrotask(() => childEmitter.emit("exit", 0, "SIGTERM"));
        return true;
      };

      const spawnFn = ((_bin: string, args: string[]) => {
        spawnedArgs = args;
        return childEmitter;
      }) as any;

      const stream = composed.streamSimple(
        model,
        { messages: [{ role: "user", content: "Hi", timestamp: 1 }] } as any,
        { reasoning, spawnFn },
      );

      childEmitter.stdout.write('{"event":"init","conversation_id":"c-test"}\n');
      await drain();
      childEmitter.stdout.write('{"event":"result","status":"SUCCESS"}\n');
      await stream.result();

      if (expectedEffort !== undefined) {
        assert.ok(spawnedArgs.includes("--effort"), `Expected --effort in spawned args: ${spawnedArgs}`);
        const effortIdx = spawnedArgs.indexOf("--effort");
        assert.strictEqual(spawnedArgs[effortIdx + 1], expectedEffort);
      } else {
        assert.strictEqual(
          spawnedArgs.includes("--effort"),
          false,
          `Expected NO --effort for ${model.id} but found in: ${spawnedArgs}`,
        );
      }
    };

    // Gemini Flash: low, medium, high
    await testEffort(flashModel, "low", "low");
    await testEffort(flashModel, "medium", "medium");
    await testEffort(flashModel, "high", "high");

    // Gemini 3.1 Pro: low, high (medium -> high)
    await testEffort(proModel, "low", "low");
    await testEffort(proModel, "high", "high");
    await testEffort(proModel, "medium", "high");

    // Claude and GPT-OSS: must NOT receive --effort even if reasoning is passed
    await testEffort(claudeModel, "high", undefined);
    await testEffort(gptModel, "high", undefined);

    resetActiveProcesses();
  });
});
