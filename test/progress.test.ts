import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Model, TextContent, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyAgyProgress,
  formatSubagentProgress,
  formatToolProgress,
  resetActiveProcesses,
  setActiveProgressCallback,
  streamSimple,
} from "../src/stream.ts";
import { registerAgyPoolProvider } from "../src/provider.ts";

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
    setActiveProgressCallback(undefined);
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

  // 1. tool ACTIVE produces working-message progress
  it("1. tool ACTIVE produces working-message progress", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p1"}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Finished"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.strictEqual(progressList.includes("AGY: Running command…"), true);
  });

  // 2. known tool receives friendly label
  it("2. known tool receives friendly label", () => {
    assert.strictEqual(formatToolProgress("view_file"), "AGY: Reading file…");
    assert.strictEqual(formatToolProgress("read_file"), "AGY: Reading file…");
    assert.strictEqual(formatToolProgress("run_command"), "AGY: Running command…");
    assert.strictEqual(formatToolProgress("bash"), "AGY: Running command…");
    assert.strictEqual(formatToolProgress("search_web"), "AGY: Searching…");
    assert.strictEqual(formatToolProgress("code_search"), "AGY: Searching code…");
    assert.strictEqual(formatToolProgress("edit_file"), "AGY: Editing file…");
    assert.strictEqual(formatToolProgress("replace_file_content"), "AGY: Editing file…");
    assert.strictEqual(formatToolProgress("write_to_file"), "AGY: Writing file…");
    assert.strictEqual(formatToolProgress("list_dir"), "AGY: Inspecting directory…");
  });

  // 3. unknown tool receives safe fallback
  it("3. unknown tool receives safe fallback", async () => {
    assert.strictEqual(formatToolProgress("custom_analyzer"), "AGY: Running custom_analyzer…");
    assert.strictEqual(formatToolProgress(undefined), "AGY: Running tool…");

    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p3"}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"custom_analyzer"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Done"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.strictEqual(progressList.includes("AGY: Running custom_analyzer…"), true);
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
    assert.strictEqual(formatSubagentProgress({ subagents: [{ role: "Code Reviewer" }] }), "AGY: Code Reviewer subagent…");
    assert.strictEqual(formatSubagentProgress({ subagents: [{ role: "Research subagent" }] }), "AGY: Research subagent…");
    assert.strictEqual(formatSubagentProgress(undefined), "AGY: Running subagent…");

    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const progressList: Array<string | undefined> = [];

    const stream = streamSimple(dummyModel, simpleContext, {
      spawnFn,
      onProgress: (msg) => progressList.push(msg),
    });

    mock.stdout.write('{"event":"init","conversation_id":"c-p6"}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"subagent","state":"ACTIVE","subagent_info":{"subagents":[{"role":"Architecture Auditor"}]}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Subagent finished"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await stream.result();
    assert.strictEqual(progressList.includes("AGY: Architecture Auditor subagent…"), true);
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
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    mock.stdout.write('{"event":"result","status":"ERROR","error":"fatal backend crash"}\n');

    const result = await stream.result();
    assert.strictEqual(result.stopReason, "error");
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
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');

    // Child exits unexpectedly before result
    mock.child.emit("exit", 137, null);

    const result = await stream.result();
    assert.strictEqual(result.stopReason, "error");
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
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Non-interactive ok"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Non-interactive ok");
    assert.strictEqual(result.stopReason, "stop");
  });

  // 17. real ExtensionContext lifecycle bridge integration
  it("17. integrates with real ExtensionContext UI lifecycle hooks", async () => {
    const listeners: Record<string, Function> = {};
    const mockPi = {
      on: (event: string, handler: Function) => {
        listeners[event] = handler;
        return () => {};
      },
      registerProvider: () => {},
    } as unknown as ExtensionAPI;

    registerAgyPoolProvider(mockPi);

    let activeWorkingMessage: string | undefined = "default";
    const mockCtx = {
      ui: {
        setWorkingMessage: (msg?: string) => {
          activeWorkingMessage = msg;
        },
      },
    } as unknown as ExtensionContext;

    // Simulate Pi turn lifecycle
    listeners["turn_start"]({}, mockCtx);

    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;

    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-p17"}\n');
    assert.strictEqual(activeWorkingMessage, "AGY: Working…");

    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}\n');
    assert.strictEqual(activeWorkingMessage, "AGY: Reading file…");

    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Done"}}\n');
    assert.strictEqual(activeWorkingMessage, undefined);

    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');
    await stream.result();

    listeners["turn_end"]({}, mockCtx);
    assert.strictEqual(activeWorkingMessage, undefined);
  });
});
