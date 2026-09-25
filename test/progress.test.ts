import { setImmediate as drain } from "node:timers/promises";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Model, TextContent, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import {
  AgyProgressAdapter,
  formatSubagentProgress,
  formatToolProgress,
  resetActiveProcesses,
  streamSimple,
} from "../src/stream.ts";

function createMockChildProcess(): {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

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
  childEmitter.kill = ((sig?: NodeJS.Signals) => {
    isKilled = true;
    queueMicrotask(() => {
      childEmitter.emit("exit", null, sig || "SIGINT");
    });
    return true;
  }) as unknown as ChildProcess["kill"];

  return { child: childEmitter, stdin, stdout, stderr };
}

describe("progress.test.ts: AGY progress visibility & sanitization", () => {
  beforeEach(() => {
    resetActiveProcesses();
  });

  const dummyModel: Model<"agy-pool-api"> = {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    baseUrl: "",
    api: "agy-pool-api",
    provider: "agy-pool",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };

  const simpleContext = {
    messages: [
      {
        role: "user",
        content: "Inspect code",
        timestamp: Date.now(),
      } as UserMessage,
    ],
  } as unknown as TranscriptContext;

  // 1. tool ACTIVE produces status progress
  it("1. tool ACTIVE produces status progress", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p1"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Finished"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.strictEqual(progressList.includes("Running command…"), true);
  });

  // 2. known tool receives friendly label
  it("2. known tool receives friendly label", () => {
    assert.strictEqual(formatToolProgress("view_file"), "Reading file…");
    assert.strictEqual(formatToolProgress("read_file"), "Reading file…");
    assert.strictEqual(formatToolProgress("run_command"), "Running command…");
    assert.strictEqual(formatToolProgress("bash"), "Running command…");
    assert.strictEqual(formatToolProgress("search_web"), "Searching…");
    assert.strictEqual(formatToolProgress("search"), "Searching…");
    assert.strictEqual(formatToolProgress("code_search"), "Searching…");
    assert.strictEqual(formatToolProgress("edit_file"), "Editing file…");
    assert.strictEqual(formatToolProgress("replace_file_content"), "Editing file…");
    assert.strictEqual(formatToolProgress("write_to_file"), "Writing file…");
    assert.strictEqual(formatToolProgress("list_dir"), "Inspecting directory…");
  });

  // 3. unknown tool receives safe fallback
  it("3. unknown tool receives safe fallback", async () => {
    assert.strictEqual(formatToolProgress("custom_analyzer"), undefined);
    assert.strictEqual(formatToolProgress(undefined), undefined);

    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p3"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"custom_analyzer"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Done"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.deepStrictEqual(progressList, []);
  });

  // 4. tool output is never displayed
  it("4. tool output is never displayed", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    const secretOutput = "SECRET_TOKEN_XYZ_999";
    mock.stdout.write('{"event":"init","conversation_id":"c-p4"}\n');
    await drain();
    mock.stdout.write(`{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"name":"run_command","output":"${secretOutput}"}}}\n`);
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Safe output"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    for (const msg of progressList) {
      if (typeof msg === "string") {
        assert.strictEqual(msg.includes(secretOutput), false);
      }
    }
  });

  // 5. tool parameters are never displayed
  it("5. tool parameters are never displayed", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    const secretParam = "cat /etc/shadow && rm -rf /var";
    mock.stdout.write('{"event":"init","conversation_id":"c-p5"}\n');
    await drain();
    mock.stdout.write(`{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"${secretParam}"}}}}\n`);
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Safe output"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    for (const msg of progressList) {
      if (typeof msg === "string") {
        assert.strictEqual(msg.includes(secretParam), false);
        assert.strictEqual(msg.includes("CommandLine"), false);
      }
    }
  });

  // 6. subagent event produces progress
  it("6. subagent event produces progress", async () => {
    assert.strictEqual(formatSubagentProgress({ subagents: [{ role: "Code Reviewer" }] }), "Code Reviewer subagent…");
    assert.strictEqual(formatSubagentProgress({ subagents: [{ role: "Research subagent" }] }), "Research subagent…");
    assert.strictEqual(formatSubagentProgress(undefined), undefined);

    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p6"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"subagent","state":"ACTIVE","subagent_info":{"subagents":[{"role":"Architecture Auditor"}]}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Subagent finished"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.strictEqual(progressList.includes("Architecture Auditor subagent…"), true);
  });

  // 7. subagent prompt/log URI never displayed
  it("7. subagent prompt/log URI never displayed", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    const secretPrompt = "CLASSIFIED_PROMPT_DETAILS";
    const secretLogUri = "file:///var/log/private_agent.log";

    mock.stdout.write('{"event":"init","conversation_id":"c-p7"}\n');
    await drain();
    mock.stdout.write(`{"event":"step_update","step_update":{"step_index":1,"step_type":"subagent","state":"ACTIVE","subagent_info":{"subagents":[{"role":"Researcher","initial_prompt":"${secretPrompt}","log_uri":"${secretLogUri}"}]}}}\n`);
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Answer"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    for (const msg of progressList) {
      if (typeof msg === "string") {
        assert.strictEqual(msg.includes(secretPrompt), false);
        assert.strictEqual(msg.includes(secretLogUri), false);
      }
    }
  });

  // 8. system_message contents never displayed
  it("8. system_message contents never displayed", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    const secretSystem = "INTERNAL_DIAGNOSTIC_RETRY_ALERT";
    mock.stdout.write('{"event":"init","conversation_id":"c-p8"}\n');
    await drain();
    mock.stdout.write(`{"event":"step_update","step_update":{"step_index":1,"step_type":"system_message","state":"DONE","content":"${secretSystem}"}}\n`);
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Answer"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    for (const msg of progressList) {
      if (typeof msg === "string") {
        assert.strictEqual(msg.includes(secretSystem), false);
      }
    }
  });

  // 9. progress cleared on SUCCESS
  it("9. progress cleared on SUCCESS", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p9"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Success answer"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.strictEqual(progressList[progressList.length - 1], undefined);
  });

  // 10. progress cleared on ERROR
  it("10. progress cleared on ERROR", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p10"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"result","status":"ERROR","error":"fatal backend crash"}\n');

    const result = await stream.result();
    assert.strictEqual(result.stopReason, "aborted");
    assert.strictEqual(progressList[progressList.length - 1], undefined);
  });

  // 11. progress cleared on AbortSignal
  it("11. progress cleared on AbortSignal", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];
    const controller = new AbortController();

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      signal: controller.signal,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p11"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');

    controller.abort();

    const result = await stream.result();
    assert.strictEqual(result.stopReason, "aborted");
    assert.strictEqual(progressList[progressList.length - 1], undefined);
  });

  // 12. progress cleared on unexpected child exit
  it("12. progress cleared on unexpected child exit", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p12"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');

    // Child exits unexpectedly before result
    mock.child.emit("exit", 137, null);

    const result = await stream.result();
    assert.strictEqual(result.stopReason, "aborted");
    assert.strictEqual(progressList[progressList.length - 1], undefined);
  });

  // 13. no Pi "toolcall_*" emitted
  it("13. no Pi toolcall_* emitted", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const emittedTypes: string[] = [];

    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });
    const consume = (async () => {
      for await (const event of stream) {
        emittedTypes.push(event.type);
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-p13"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"name":"run_command"}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"output":"success"}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Answer"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await consume;
    await stream.result();
    assert.strictEqual(emittedTypes.some((t) => t.startsWith("toolcall_")), false);
  });

  // 14. no Pi "thinking_*" emitted
  it("14. no Pi thinking_* emitted", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const emittedTypes: string[] = [];

    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });
    const consume = (async () => {
      for await (const event of stream) {
        emittedTypes.push(event.type);
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-p14"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Answer","usage":{"thinking_tokens":500}}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await consume;
    const result = await stream.result();
    assert.strictEqual(emittedTypes.some((t) => t.startsWith("thinking_")), false);
    assert.strictEqual(result.usage.reasoning, 500);
  });

  // 15. no progress text enters assistant content
  it("15. no progress text enters assistant content", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-p15"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Pure assistant content"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    const text = (result.content[0] as TextContent).text;
    assert.strictEqual(text, "Pure assistant content");
    assert.strictEqual(text.includes("AGY:"), false);
  });

  // 16. non-interactive/no-UI mode remains functional
  it("16. non-interactive/no-UI mode remains functional", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    // No onProgress passed, no UI registered
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-p16"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Non-interactive ok"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Non-interactive ok");
    assert.strictEqual(result.stopReason, "stop");
  });

  // 18. full sequence test: init -> view_file -> done -> run_command -> done -> agent text -> search -> done -> agent text -> result
  it("18. full multi-step sequence updates and clears live status", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p18"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"DONE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":3,"step_type":"agent_response","state":"ACTIVE","text_delta":"First text"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":4,"step_type":"tool","state":"ACTIVE","tool_name":"search"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":4,"step_type":"tool","state":"DONE","tool_name":"search"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":5,"step_type":"agent_response","state":"DONE","text_delta":"Final text"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();

    assert.deepStrictEqual(progressList, [
      "Reading file…",
      "Reading file — done; continuing…",
      "Running command…",
      "Running command — done; continuing…",
      undefined,
      "Searching…",
      "Searching — done; continuing…",
      undefined,
    ]);
  });

  // 19. subagent ACTIVE and DONE transitions
  it("19. subagent ACTIVE and DONE transitions update status", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p19"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"subagent","state":"ACTIVE","subagent_info":{"subagents":[{"role":"Code Reviewer"}]}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"subagent","state":"DONE"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Review finished"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();

    assert.deepStrictEqual(progressList, [
      "Code Reviewer subagent…",
      "Code Reviewer subagent — done; continuing…",
      undefined,
    ]);
  });

  // 20. deduplication of repeated identical progress updates
  it("20. deduplicates repeated identical progress states", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p20"}\n');
    // Multiple identical tool ACTIVE updates
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    // Tool finishes
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"view_file"}}\n');
    // Multiple text deltas streaming
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"ACTIVE","text_delta":"chunk 1"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"ACTIVE","text_delta":"chunk 2"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"chunk 3"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();

    // Despite multiple ACTIVE events and multiple text deltas, each distinct state is emitted exactly once
    assert.deepStrictEqual(progressList, [
      "Reading file…",
      "Reading file — done; continuing…",
      undefined,
    ]);
  });

  // 21. progress resumes after intermediate assistant text
  it("21. progress row resumes after being cleared for assistant text", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p21"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"ACTIVE","text_delta":"First thought: "}}\n');
    assert.strictEqual(progressList[progressList.length - 1], undefined);

    // Later tool starts after text has streamed
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"search_web"}}\n');
    assert.strictEqual(progressList[progressList.length - 1], "Searching…");

    await drain();

    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"DONE","tool_name":"search_web"}}\n');
    assert.strictEqual(progressList[progressList.length - 1], "Searching — done; continuing…");

    await drain();

    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    await stream.result();
    assert.strictEqual(progressList[progressList.length - 1], undefined);
  });

});

it("tracks overlapping step identities and ignores events after terminal cleanup", () => {
  const seen: Array<string | undefined> = [];
  const state = new AgyProgressAdapter((text) => seen.push(text));
  state.update(undefined);
  state.step({ step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "read_file" });
  state.step({ step_type: "subagent", step_index: 1, state: "ACTIVE", subagent_info: { subagents: [{ role: "Research" }] } });
  state.step({ step_type: "tool", step_index: 1, state: "DONE" });
  assert.equal(seen.at(-1), "Research subagent…");
  state.step({ step_type: "subagent", step_index: 1, state: "DONE" });
  assert.equal(seen.at(-1), "Research subagent — done; continuing…");
  state.step({ step_type: "agent_response", state: "ACTIVE" });
  assert.equal(seen.at(-1), "Research subagent — done; continuing…");
  state.step({ step_type: "agent_response", text_delta: "answer" });
  assert.equal(seen.at(-1), undefined);
  state.step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "code_search" });
  assert.equal(seen.at(-1), "Searching…");
  state.finish();
  state.step({ step_type: "tool", step_index: 3, state: "ACTIVE" });
  assert.equal(seen.at(-1), undefined);
});

it("does not echo unknown names, paths, terminal escapes, or free-form roles", () => {
  for (const value of ["/private/credentials", "TOKEN_12345", "\x1b[31msecret", "x".repeat(500), "prompt\ncontents", "constructor", "__proto__"]) {
    assert.equal(formatToolProgress(value), undefined);
    assert.equal(formatSubagentProgress({ subagents: [{ role: value }] }), undefined);
  }
});

it("uses names when indices are absent and ambiguous DONE does not erase peers", () => {
  const seen: Array<string | undefined> = [];
  const state = new AgyProgressAdapter((text) => seen.push(text));
  state.step({ step_type: "tool", state: "ACTIVE", tool_name: "read_file" });
  state.step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command" });
  state.step({ step_type: "tool", state: "DONE" });
  assert.equal(seen.at(-1), "Running command…");
  state.step({ step_type: "tool", state: "DONE", tool_name: "read_file" });
  assert.equal(seen.at(-1), "Running command…");
  state.step({ step_type: "tool", state: "DONE" });
  assert.equal(seen.at(-1), "Running command — done; continuing…");
  state.finish();
});
