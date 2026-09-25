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
  TextContent,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import { resetActiveProcesses, streamSimple } from "../src/stream.ts";

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
  childEmitter.kill = (() => {
    isKilled = true;
    queueMicrotask(() => childEmitter.emit("exit", 0, "SIGTERM"));
    return true;
  }) as unknown as ChildProcess["kill"];

  return { child: childEmitter, stdin, stdout, stderr };
}

describe("telemetry.test.ts: AGY structured agent telemetry", () => {
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
        content: "Test prompt",
        timestamp: Date.now(),
      } as UserMessage,
    ],
  } as unknown as TranscriptContext;

  // 1. answer → tool → answer
  it("1. stitches text correctly across answer -> tool -> answer", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t1"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"ACTIVE","text_delta":"Part 1. "}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"cmd":"ls"}}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"output":"file1.txt\\nfile2.txt"}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":3,"step_type":"agent_response","state":"DONE","text_delta":"Part 2."}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS","result":{"response":"Part 1. Part 2."}}\n');

    const result = await stream.result();
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0].type, "text");
    assert.strictEqual((result.content[0] as TextContent).text, "Part 1. Part 2.");
  });

  // 2. answer → subagent → answer
  it("2. stitches text correctly across answer -> subagent -> answer", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t2"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"ACTIVE","text_delta":"Delegating task. "}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"subagent","state":"DONE","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"conversation_id":"sub-1"}]}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":3,"step_type":"system_message","state":"DONE","duration_seconds":0.01}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":4,"step_type":"agent_response","state":"DONE","text_delta":"Subagent completed."}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS","result":{"response":"Delegating task. Subagent completed."}}\n');

    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Delegating task. Subagent completed.");
  });

  // 3. multiple agent_response steps
  it("3. stitches multiple agent_response steps seamlessly", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t3"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"ACTIVE","text_delta":"Alpha "}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"ACTIVE","text_delta":"Beta "}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":3,"step_type":"agent_response","state":"DONE","text_delta":"Gamma"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS","result":{"response":"Alpha Beta Gamma"}}\n');

    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Alpha Beta Gamma");
  });

  // 4. tool ACTIVE/DONE ignored for answer text
  it("4. ignores tool ACTIVE and DONE for answer text", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t4"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"read_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"read_file"}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Only answer text"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Only answer text");
  });

  // 5. tool output never appears in Pi answer
  it("5. tool output never appears in Pi answer", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t5"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"name":"run_command","output":"TOP_SECRET_CREDENTIAL_DATA"}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Clean summary without secrets"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    const fullText = (result.content[0] as TextContent).text;
    assert.strictEqual(fullText.includes("TOP_SECRET_CREDENTIAL_DATA"), false);
    assert.strictEqual(fullText, "Clean summary without secrets");
  });

  // 6. subagent metadata never appears in Pi answer
  it("6. subagent metadata never appears in Pi answer", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t6"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"subagent","state":"DONE","subagent_info":{"subagents":[{"initial_prompt":"SUBAGENT_INTERNAL_PROMPT","log_uri":"file:///logs/sub.log"}]}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Final synthesized answer"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    const fullText = (result.content[0] as TextContent).text;
    assert.strictEqual(fullText.includes("SUBAGENT_INTERNAL_PROMPT"), false);
    assert.strictEqual(fullText.includes("file:///logs/sub.log"), false);
    assert.strictEqual(fullText, "Final synthesized answer");
  });

  // 7. result.response does not duplicate streamed text
  it("7. result.response does not duplicate streamed text", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    const receivedDeltas: string[] = [];
    const consume = (async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          receivedDeltas.push(event.delta);
        }
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-t7"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"ACTIVE","text_delta":"Streamed "}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"DONE","text_delta":"answer"}}\n');
    // result.response carries identical cumulative text
    await drain();
    mock.stdout.write('{"event":"result","status":"SUCCESS","result":{"response":"Streamed answer"}}\n');

    await consume;
    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Streamed answer");
    assert.deepStrictEqual(receivedDeltas, ["Streamed ", "answer"]);
  });

  // 8. thinking_tokens usage mapping
  it("8. maps thinking_tokens to Pi usage.reasoning metric", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t8"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"DONE","text_delta":"Hi","usage":{"input_tokens":100,"output_tokens":50,"thinking_tokens":35,"total_tokens":150}}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS","result":{"usage":{"input_tokens":100,"output_tokens":50,"thinking_tokens":35,"total_tokens":150}}}\n');

    const result = await stream.result();
    assert.strictEqual(result.usage.reasoning, 35);
    assert.strictEqual(result.usage.input, 100);
    assert.strictEqual(result.usage.output, 50);
    assert.strictEqual(result.usage.totalTokens, 150);
  });

  // 9. no Pi "toolcall_*" events emitted
  it("9. never emits Pi toolcall_* events for AGY tools", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    const emittedTypes: string[] = [];
    const consume = (async () => {
      for await (const event of stream) {
        emittedTypes.push(event.type);
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-t9"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"whoami"}}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"output":"codex"}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"User is codex"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await consume;
    const result = await stream.result();
    // Zero toolcall events
    assert.strictEqual(emittedTypes.some((t) => t.startsWith("toolcall_")), false);
    assert.strictEqual(result.stopReason, "stop");
  });

  // 10. no Pi "thinking_*" events emitted
  it("10. never emits Pi thinking_* events even when thinking_tokens > 0", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    const emittedTypes: string[] = [];
    const consume = (async () => {
      for await (const event of stream) {
        emittedTypes.push(event.type);
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-t10"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"DONE","text_delta":"42","usage":{"thinking_tokens":400}}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await consume;
    const result = await stream.result();
    assert.strictEqual(emittedTypes.some((t) => t.startsWith("thinking_")), false);
    // Content contains no ThinkingContent
    assert.strictEqual(result.content.some((c) => c.type === "thinking"), false);
  });

  // 11. unknown step type safely ignored
  it("11. safely ignores unknown AGY step types without crashing", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    mock.stdout.write('{"event":"init","conversation_id":"c-t11"}\n');
    // Unknown future step type
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"telemetry_heartbeat","state":"DONE","custom_payload":{"foo":"bar"}}}\n');
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","state":"DONE","text_delta":"Still working"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    const result = await stream.result();
    assert.strictEqual((result.content[0] as TextContent).text, "Still working");
  });

  // 12. terminal SUCCESS exactly once
  it("12. emits terminal done event with reason 'stop' exactly once", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    let doneCount = 0;
    const consume = (async () => {
      for await (const event of stream) {
        if (event.type === "done") {
          doneCount++;
          assert.strictEqual(event.reason, "stop");
        }
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-t12"}\n');
    await drain();
    mock.stdout.write('{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"DONE","text_delta":"Done test"}}\n');
    mock.stdout.write('{"event":"result","status":"SUCCESS"}\n');

    await consume;
    await stream.result();
    assert.strictEqual(doneCount, 1);
  });

  // 13. terminal ERROR exactly once
  it("13. emits terminal error event exactly once on result ERROR", async () => {
    const mock = createMockChildProcess();
    const spawnFn = (() => mock.child) as unknown as typeof import("node:child_process").spawn;
    const stream = streamSimple(dummyModel, simpleContext, { spawnFn });

    let errorCount = 0;
    const consume = (async () => {
      for await (const event of stream) {
        if (event.type === "error") {
          errorCount++;
          assert.strictEqual(event.reason, "error");
        }
      }
    })();

    mock.stdout.write('{"event":"init","conversation_id":"c-t13"}\n');
    await drain();
    mock.stdout.write('{"event":"result","status":"ERROR","error":"upstream service unavailable"}\n');

    await consume;
    const result = await stream.result();
    assert.strictEqual(errorCount, 1);
    assert.strictEqual(result.stopReason, "error");
    assert.strictEqual(result.errorMessage, "upstream service unavailable");
  });
});
