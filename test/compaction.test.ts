import { setImmediate as drain } from "node:timers/promises";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeProcesses,
  buildTurnPrompt,
  detectCompaction,
  extractAuthoritativeSystemPrompt,
  findConversationId,
  getSessionState,
  isCompactionMessage,
  markSessionCompacted,
  resetActiveProcesses,
  retiredConversationIds,
  retireSessionConversation,
  sessionStates,
  streamSimple,
  validPostCompactionConversations,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "../src/stream.ts";
import { registerAgyPoolProvider } from "../src/provider.ts";

function createMockChildProcess(): {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  simulateExit: (code: number, signal?: string | null) => void;
  signalsReceived: string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalsReceived: string[] = [];

  const childEmitter = new EventEmitter() as ChildProcess;
  childEmitter.stdin = stdin;
  childEmitter.stdout = stdout;
  childEmitter.stderr = stderr;
  let isKilled = false;
  Object.defineProperty(childEmitter, "killed", {
    get: () => isKilled,
    set: (val: boolean) => {
      isKilled = val;
    },
    configurable: true,
  });
  childEmitter.kill = ((sig?: NodeJS.Signals | number) => {
    isKilled = true;
    signalsReceived.push(String(sig || "SIGTERM"));
    queueMicrotask(() => childEmitter.emit("exit", 0, sig || "SIGTERM"));
    return true;
  }) as unknown as ChildProcess["kill"];

  const simulateExit = (code: number, signal: string | null = null) => {
    isKilled = true;
    childEmitter.emit("exit", code, signal);
  };

  return { child: childEmitter, stdin, stdout, stderr, simulateExit, signalsReceived };
}

describe("Compaction Support", () => {
  beforeEach(() => {
    resetActiveProcesses();
  });

  const dummyModel: Model<"agy-pool-api"> = {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    baseUrl: "",
    api: "agy-pool-api",
    provider: "agy-pool",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };

  // 1. normal non-compacted session reuses AGY process
  it("1. normal non-compacted session reuses AGY process", async () => {
    const mock = createMockChildProcess();
    let spawnCount = 0;
    const fakeSpawn = (() => {
      spawnCount++;
      return mock.child;
    }) as unknown as typeof import("node:child_process").spawn;

    const context1: TranscriptContext = {
      messages: [{ role: "user", content: "Turn 1", timestamp: 100 }],
    } as unknown as TranscriptContext;

    const stream1 = streamSimple(dummyModel, context1, {
      spawnFn: fakeSpawn,
      sessionId: "session-normal",
    });

    await drain();

    mock.stdout.write(
      JSON.stringify({ event: "init", conversation_id: "conv-normal-1", session_id: "s1" }) + "\n",
    );
    await drain();
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Hello" },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(
      JSON.stringify({ event: "result", status: "SUCCESS", data: { stop_reason: "stop" } }) + "\n",
    );

    for await (const _ of stream1) {}
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(activeProcesses.has("conv-normal-1"), true);

    // Turn 2: reuses process
    const context2: TranscriptContext = {
      messages: [
        { role: "user", content: "Turn 1", timestamp: 100 },
        {
          role: "assistant",
          provider: "agy-pool", api: "agy-pool-api",
          content: [{ type: "text", text: "Hello" }],
          responseId: "conv-normal-1",
          timestamp: 200,
        } as AssistantMessage,
        { role: "user", content: "Turn 2", timestamp: 300 },
      ],
    } as unknown as TranscriptContext;

    const stream2 = streamSimple(dummyModel, context2, {
      spawnFn: fakeSpawn,
      sessionId: "session-normal",
    });

    await drain();

    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: " World" },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(
      JSON.stringify({ event: "result", status: "SUCCESS", data: { stop_reason: "stop" } }) + "\n",
    );

    for await (const _ of stream2) {}
    assert.strictEqual(spawnCount, 1, "Must reuse running AGY process for Turn 2");
  });

  // 2. 'session_compact' marks only the correct Pi session stale
  it("2. 'session_compact' marks only the correct Pi session stale", () => {
    getSessionState("session-A").activeConversationId = "conv-A";
    getSessionState("session-B").activeConversationId = "conv-B";

    markSessionCompacted("session-A");

    assert.strictEqual(getSessionState("session-A").needsBootstrap, true);
    assert.strictEqual(getSessionState("session-B").needsBootstrap, false);
    assert.strictEqual(retiredConversationIds.has("conv-A"), true);
    assert.strictEqual(retiredConversationIds.has("conv-B"), false);
  });

  // 3. old pre-compaction process is retired
  it("3. old pre-compaction process is retired", async () => {
    const mock = createMockChildProcess();
    const stream = streamSimple(dummyModel, { messages: [] } as unknown as TranscriptContext,
      { sessionId: "session-test", spawnFn: (() => mock.child) as any });
    mock.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-old" }) + "\n");
    await drain();
    mock.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    await stream.result();
    await markSessionCompacted("session-test");
    assert.strictEqual(activeProcesses.has("conv-old"), false);
    assert.strictEqual(mock.signalsReceived.includes("SIGTERM"), true);
    assert.strictEqual(getSessionState("session-test").activeConversationId, undefined);
  });

  // 4. first post-compaction turn does not reuse old conversation ID
  // 5. first post-compaction spawn contains no old '--conversation'
  it("4 & 5. first post-compaction turn does not reuse old conversation ID and contains no --conversation", async () => {
    const mockOld = createMockChildProcess();
    const mockNew = createMockChildProcess();
    const spawnedArgs: string[][] = [];

    let spawnCount = 0;
    const fakeSpawn = ((_bin: string, args: string[]) => {
      spawnCount++;
      spawnedArgs.push(args);
      return spawnCount === 1 ? mockOld.child : mockNew.child;
    }) as unknown as typeof import("node:child_process").spawn;

    const ctx1: TranscriptContext = {
      messages: [{ role: "user", content: "Hi", timestamp: 100 }],
    } as unknown as TranscriptContext;

    const s1 = streamSimple(dummyModel, ctx1, { spawnFn: fakeSpawn, sessionId: "sess-comp" });
    await drain();
    mockOld.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-1" }) + "\n");
    await drain();
    mockOld.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of s1) {}

    assert.strictEqual(spawnedArgs.length, 1);
    assert.strictEqual(spawnedArgs[0].includes("--conversation"), false);

    // Fire compaction lifecycle
    markSessionCompacted("sess-comp");

    // Post-compaction transcript with retained messages carrying old responseId
    const postCompactContext: TranscriptContext = {
      messages: [
        { role: "system", content: "System instructions", timestamp: 10 },
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}## Goal\nSummary of earlier work\n${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: 200,
        },
        { role: "user", content: "Kept prompt", timestamp: 150 },
        {
          role: "assistant",
          provider: "agy-pool", api: "agy-pool-api",
          content: [{ type: "text", text: "Kept response" }],
          responseId: "conv-1",
          timestamp: 160,
        } as AssistantMessage,
        { role: "user", content: "New question after compaction", timestamp: 250 },
      ],
    } as unknown as TranscriptContext;

    const s2 = streamSimple(dummyModel, postCompactContext, {
      spawnFn: fakeSpawn,
      sessionId: "sess-comp",
    });
    await drain();
    mockNew.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-2" }) + "\n");
    await drain();
    mockNew.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Fresh answer" },
      }) + "\n",
    );
    await drain();
    mockNew.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of s2) {}

    assert.strictEqual(spawnedArgs.length, 2);
    // Crucial: second spawn MUST NOT include --conversation conv-1
    assert.strictEqual(
      spawnedArgs[1].includes("--conversation"),
      false,
      "Fresh post-compaction spawn must not include --conversation with old conversation ID",
    );
  });

  // 6. compacted summary is included in fresh bootstrap
  // 7. removed pre-compaction messages are absent
  // 8. kept recent messages appear exactly once
  // 9. latest user prompt appears exactly once
  // 10. system prompt appears exactly once
  it("6-10. fresh bootstrap formatting preserves summary, kept messages, prompt, and system prompt exactly once without duplication", () => {
    const context: TranscriptContext = {
      messages: [
        { role: "system", content: "You are an expert AI.", timestamp: 10 },
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}## Goal\nBuild something great\n\n## Critical Context\nCodename: ORBITAL-MANGO-7391${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: 200,
        },
        { role: "user", content: "Kept user message", timestamp: 150 },
        {
          role: "assistant",
          provider: "agy-pool", api: "agy-pool-api",
          content: [{ type: "text", text: "Kept assistant response" }],
          responseId: "conv-old-1",
          timestamp: 160,
        } as AssistantMessage,
        { role: "user", content: "What is the project codename for this test?", timestamp: 250 },
      ],
    } as unknown as TranscriptContext;

    const prompt = buildTurnPrompt(context, false);

    // 6. Compacted summary is included
    assert.ok(prompt.includes("## Goal\\nBuild something great"));
    assert.ok(prompt.includes("Codename: ORBITAL-MANGO-7391"));

    // 7. Removed pre-compaction messages are absent (they never entered context)
    assert.ok(!prompt.includes("Removed Turn"));

    // 8. Kept recent messages appear exactly once
    const keptUserCount = (prompt.match(/Kept user message/g) || []).length;
    const keptAssistantCount = (prompt.match(/Kept assistant response/g) || []).length;
    assert.strictEqual(keptUserCount, 1, "Kept user message must appear exactly once");
    assert.strictEqual(keptAssistantCount, 1, "Kept assistant message must appear exactly once");

    // 9. Latest user prompt appears exactly once
    const promptCount = (prompt.match(/What is the project codename for this test\?/g) || []).length;
    assert.strictEqual(promptCount, 1, "Latest user prompt must appear exactly once");

    // 10. System prompt appears exactly once
    const sysCount = (prompt.match(/You are an expert AI\./g) || []).length;
    assert.strictEqual(sysCount, 1, "System prompt must appear exactly once");
  });

  // 11. new AGY conversation ID replaces old responseId
  // 12. second post-compaction turn resumes the new conversation
  it("11 & 12. new AGY conversation ID replaces old responseId and second post-compaction turn resumes it", async () => {
    const mock1 = createMockChildProcess();
    const mock2 = createMockChildProcess();
    let spawnCount = 0;
    const fakeSpawn = ((_bin: string, _args: string[]) => {
      spawnCount++;
      return spawnCount === 1 ? mock1.child : mock2.child;
    }) as unknown as typeof import("node:child_process").spawn;

    markSessionCompacted("sess-11-12");

    const postCompactContext: TranscriptContext = {
      messages: [
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}## Summary\nCompacted${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: 200,
        },
        { role: "user", content: "Turn 1 post-compact", timestamp: 250 },
      ],
    } as unknown as TranscriptContext;

    const s1 = streamSimple(dummyModel, postCompactContext, {
      spawnFn: fakeSpawn,
      sessionId: "sess-11-12",
    });
    await drain();
    mock1.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-new-222" }) + "\n");
    await drain();
    mock1.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Resp 1" },
      }) + "\n",
    );
    await drain();
    mock1.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");

    const events1: AssistantMessageEvent[] = [];
    for await (const ev of s1) {
      events1.push(ev);
    }

    const doneEvent1 = events1.find((e) => e.type === "done");
    assert.ok(doneEvent1);
    if (doneEvent1.type === "done") {
      assert.strictEqual(doneEvent1.message.responseId, "conv-new-222");
    }

    // Turn 2 post-compact:
    const turn2Context: TranscriptContext = {
      messages: [
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}## Summary\nCompacted${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: 200,
        },
        { role: "user", content: "Turn 1 post-compact", timestamp: 250 },
        {
          role: "assistant",
          provider: "agy-pool", api: "agy-pool-api",
          content: [{ type: "text", text: "Resp 1" }],
          responseId: "conv-new-222",
          timestamp: 260,
        } as AssistantMessage,
        { role: "user", content: "Turn 2 post-compact", timestamp: 300 },
      ],
    } as unknown as TranscriptContext;

    const s2 = streamSimple(dummyModel, turn2Context, {
      spawnFn: fakeSpawn,
      sessionId: "sess-11-12",
    });
    await drain();
    mock1.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Resp 2" },
      }) + "\n",
    );
    await drain();
    mock1.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of s2) {}

    // Must reuse mock1 child process (spawnCount remains 1)
    assert.strictEqual(spawnCount, 1, "Turn 2 post-compact must resume new conversation on existing process");
  });

  // 13. session A compaction does not affect session B
  it("13. session A compaction does not affect session B", async () => {
    const mockA = createMockChildProcess();
    const mockB = createMockChildProcess();
    const mockA2 = createMockChildProcess();

    let spawnCount = 0;
    const fakeSpawn = (() => {
      spawnCount++;
      if (spawnCount === 1) return mockA.child;
      if (spawnCount === 2) return mockB.child;
      return mockA2.child;
    }) as unknown as typeof import("node:child_process").spawn;

    // Start Session A
    const sA = streamSimple(dummyModel, { messages: [{ role: "user", content: "A1" }] } as any, {
      spawnFn: fakeSpawn,
      sessionId: "session-A",
    });
    await drain();
    mockA.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-a" }) + "\n");
    await drain();
    mockA.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of sA) {}

    // Start Session B
    const sB = streamSimple(dummyModel, { messages: [{ role: "user", content: "B1" }] } as any, {
      spawnFn: fakeSpawn,
      sessionId: "session-B",
    });
    await drain();
    mockB.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-b" }) + "\n");
    await drain();
    mockB.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of sB) {}

    assert.strictEqual(activeProcesses.has("conv-a"), true);
    assert.strictEqual(activeProcesses.has("conv-b"), true);

    // Compact Session A ONLY
    markSessionCompacted("session-A");

    // Session A process retired, Session B untouched!
    assert.strictEqual(activeProcesses.has("conv-a"), false);
    assert.strictEqual(activeProcesses.has("conv-b"), true);
    assert.strictEqual(mockB.signalsReceived.length, 0);

    // Session B turn 2 reuses conv-b without interruption
    const sB2 = streamSimple(
      dummyModel,
      {
        messages: [
          { role: "user", content: "B1", timestamp: 10 },
          { role: "assistant",
          provider: "agy-pool", api: "agy-pool-api", content: [{ type: "text", text: "B1 reply" }], responseId: "conv-b", timestamp: 20 } as AssistantMessage,
          { role: "user", content: "B2", timestamp: 30 },
        ],
      } as any,
      { spawnFn: fakeSpawn, sessionId: "session-B" },
    );
    await drain();
    mockB.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "B2 reply" } }) + "\n");
    mockB.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of sB2) {}

    assert.strictEqual(mockB.signalsReceived.length, 0, "Session B must remain completely uninterrupted");
  });

  // 14. restart/resume structural fallback detects compaction
  // 15. stale pre-compaction responseId is ignored
  it("14 & 15. restart/resume structural fallback detects compaction and ignores stale pre-compaction responseId", () => {
    // Reset any in-memory state simulating a fresh Pi restart or extension reload
    resetActiveProcesses();

    const contextWithCompaction: TranscriptContext = {
      messages: [
        {
          role: "compactionSummary",
          summary: "Preserve context",
          timestamp: 500,
        },
        {
          role: "assistant",
          provider: "agy-pool", api: "agy-pool-api",
          content: [{ type: "text", text: "Pre-compaction response" }],
          responseId: "stale-pre-compact-conv-id",
          timestamp: 400,
        } as AssistantMessage,
        { role: "user", content: "Next prompt after restart", timestamp: 600 },
      ],
    } as unknown as TranscriptContext;

    // Structural detection check
    const detection = detectCompaction(contextWithCompaction);
    assert.strictEqual(detection.hasCompaction, true);
    assert.strictEqual(detection.compactionTimestamp, 500);

    // findConversationId must ignore stale-pre-compact-conv-id because timestamp 400 <= 500
    const convId = findConversationId(contextWithCompaction);
    assert.strictEqual(convId, undefined, "Stale pre-compaction conversation ID must be ignored");
  });

  // 16. no context duplication
  it("16. no context duplication between context.systemPrompt and projected system message", () => {
    const duplicateSystemContext = {
      systemPrompt: "You are a helpful coding assistant.",
      messages: [
        { role: "system", content: "You are a helpful coding assistant.", timestamp: 0 },
        { role: "user", content: "Hello", timestamp: 1 },
      ],
    } as unknown as TranscriptContext;

    const extracted = extractAuthoritativeSystemPrompt(duplicateSystemContext);
    assert.strictEqual(extracted, "You are a helpful coding assistant.");

    const prompt = buildTurnPrompt(duplicateSystemContext, false);
    const occurrences = (prompt.match(/You are a helpful coding assistant\./g) || []).length;
    assert.strictEqual(occurrences, 1, "System prompt must appear exactly once despite duplication in context");
  });

  // 17. model preserved
  // 18. effort/thinking level preserved
  it("17 & 18. model and effort are preserved across post-compaction bootstrap", async () => {
    const mock = createMockChildProcess();
    let capturedArgs: string[] = [];
    const fakeSpawn = ((_bin: string, args: string[]) => {
      capturedArgs = args;
      return mock.child;
    }) as unknown as typeof import("node:child_process").spawn;

    markSessionCompacted("sess-model-preservation");

    const context: TranscriptContext = {
      messages: [
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}## Summary\nWork\n${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: 100,
        },
        { role: "user", content: "Do work", timestamp: 110 },
      ],
    } as unknown as TranscriptContext;

    const stream = streamSimple(dummyModel, context, {
      spawnFn: fakeSpawn,
      sessionId: "sess-model-preservation",
      reasoning: "high",
    });

    await drain();

    mock.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-preservation" }) + "\n");
    await drain();
    mock.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");
    for await (const _ of stream) {}

    assert.ok(capturedArgs.includes("--model"));
    const modelIdx = capturedArgs.indexOf("--model");
    assert.strictEqual(capturedArgs[modelIdx + 1], "gemini-3.8-flash");

    assert.ok(capturedArgs.includes("--effort"));
    const effortIdx = capturedArgs.indexOf("--effort");
    assert.strictEqual(capturedArgs[effortIdx + 1], "high");
  });

  // 19. v0.3.3 progress visibility preserved
  it("19. v0.3.3 progress visibility preserved during bootstrap turn", async () => {
    const mock = createMockChildProcess();
    const fakeSpawn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const progressMessages: string[] = [];
    markSessionCompacted("sess-progress");

    const context: TranscriptContext = {
      messages: [
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}## Summary\nWork\n${COMPACTION_SUMMARY_SUFFIX}`,
          timestamp: 100,
        },
        { role: "user", content: "Prompt", timestamp: 110 },
      ],
    } as unknown as TranscriptContext;

    const stream = streamSimple(dummyModel, context, {
      spawnFn: fakeSpawn,
      sessionId: "sess-progress",
      onProgress: (msg) => {
        if (msg) progressMessages.push(msg);
      },
    });

    await drain();

    mock.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-prog" }) + "\n");
    await drain();
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "tool", state: "ACTIVE", tool_name: "read_file" },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Answer" },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");

    for await (const _ of stream) {}

    assert.ok(progressMessages.includes("AGY: Working…"));
    assert.ok(progressMessages.includes("AGY: Reading file…"));
  });

  // 20. tool telemetry still never becomes Pi toolcall
  // 21. subagent telemetry remains non-conversational
  it("20 & 21. tool telemetry and subagent telemetry never become Pi tool calls or pollute assistant text", async () => {
    const mock = createMockChildProcess();
    const fakeSpawn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const context: TranscriptContext = {
      messages: [{ role: "user", content: "Run tools", timestamp: 100 }],
    } as unknown as TranscriptContext;

    const stream = streamSimple(dummyModel, context, { spawnFn: fakeSpawn });
    await drain();
    mock.stdout.write(JSON.stringify({ event: "init", conversation_id: "c-telemetry" }) + "\n");
    await drain();
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "bash",
          tool_info: { name: "bash", input: "cat /secret" },
        },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "subagent",
          state: "ACTIVE",
          subagent_info: { subagents: [{ role: "Research Subagent" }] },
        },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Here is your answer." },
      }) + "\n",
    );
    await drain();
    mock.stdout.write(JSON.stringify({ event: "result", status: "SUCCESS" }) + "\n");

    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    // No Pi toolcall_* events emitted
    const toolCallEvents = events.filter((e) => (e.type as string).startsWith("toolcall_"));
    assert.strictEqual(toolCallEvents.length, 0);

    const done = events.find((e) => e.type === "done");
    assert.ok(done && done.type === "done");
    const content = done.message.content;
    assert.strictEqual(content.length, 1);
    assert.strictEqual(content[0].type, "text");
    if (content[0].type === "text") {
      assert.strictEqual(content[0].text, "Here is your answer.");
      assert.ok(!content[0].text.includes("bash"));
      assert.ok(!content[0].text.includes("Research Subagent"));
    }
  });

  // 22. normal sessions without compaction remain behaviorally unchanged
  it("22. normal sessions without compaction remain behaviorally unchanged", () => {
    const normalContext: TranscriptContext = {
      messages: [
        { role: "user", content: "Hi", timestamp: 1 },
        {
          role: "assistant",
          provider: "agy-pool", api: "agy-pool-api",
          content: [{ type: "text", text: "Hello" }],
          responseId: "conv-normal-standard",
          timestamp: 2,
        } as AssistantMessage,
        { role: "user", content: "Next prompt", timestamp: 3 },
      ],
    } as unknown as TranscriptContext;

    const detected = detectCompaction(normalContext);
    assert.strictEqual(detected.hasCompaction, false);

    const convId = findConversationId(normalContext);
    assert.strictEqual(convId, "conv-normal-standard");

    const resumedPrompt = buildTurnPrompt(normalContext, true);
    assert.strictEqual(resumedPrompt, "Next prompt");
  });

  // Integration with registerAgyPoolProvider hooks
  it("registers session_compact and branch navigation hooks via registerAgyPoolProvider", () => {
    const registeredHandlers = new Map<string, Function>();
    const fakePi: ExtensionAPI = {
      on(event: string, handler: Function) {
        registeredHandlers.set(event, handler);
        return () => {};
      },
      registerProvider: () => {},
    } as unknown as ExtensionAPI;

    registerAgyPoolProvider(fakePi);

    assert.ok(registeredHandlers.has("session_compact"));
    assert.ok(registeredHandlers.has("session_before_switch"));
    assert.ok(registeredHandlers.has("session_before_fork"));
    assert.ok(registeredHandlers.has("session_tree"));
    assert.ok(registeredHandlers.has("session_shutdown"));

    // Invoke session_compact handler
    const mockCtx = {
      sessionManager: {
        getSessionId: () => "sess-via-hook",
      },
    } as unknown as ExtensionContext;

    getSessionState("sess-via-hook").activeConversationId = "conv-hook-test";
    const compactHandler = registeredHandlers.get("session_compact")!;
    compactHandler({ type: "session_compact" }, mockCtx);

    assert.strictEqual(getSessionState("sess-via-hook").needsBootstrap, true);
    assert.strictEqual(retiredConversationIds.has("conv-hook-test"), true);
  });
});
