import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { FakeAgy } from "./helpers/pi-progress.ts";
import { streamSimple, sessionStates, resetActiveProcesses } from "../src/stream.ts";
import { MODELS, API_IDENTIFIER } from "../src/models.ts";
const model: any = { ...MODELS[0], provider: "agy-pool", api: API_IDENTIFIER };
const context = (text = "FIRST"): any => ({ messages: [{role:"system",content:"GUARDRAIL",timestamp:0},{role:"user",content:text,timestamp:1}] });
afterEach(() => resetActiveProcesses());
for (const failure of ["payload", "serialization", "cancel", "write", "EPIPE"]) test(`B1 ${failure} before bootstrap submission`, async () => {
  const children: FakeAgy[] = [];
  const spawnFn: any = () => { const c = new FakeAgy();
    if (!children.length && failure === "EPIPE")
      c.stdin = new Writable({write(_chunk,_encoding,cb){confirm=cb;}}) as any;
    if (!children.length && failure === "write") c.stdin.write = () => {throw Error("write failed");};
    children.push(c); return c; };
  const controller = new AbortController();
  let confirm: ((error?: Error | null) => void) | undefined;
  const ctx = context();
  if (failure === "serialization") ctx.messages[1].content = [{type:"text",text:1n}];
  const first = streamSimple(model, ctx, {sessionId:"B1", signal:controller.signal, spawnFn,
    onPayload: failure === "payload" ? async () => { throw Error("reject"); } : failure === "cancel" ? () => new Promise(() => {}) : undefined });
  const c = children[0];
  c.send({event:"init",conversation_id:"X"}); await tick();
  assert.equal((sessionStates.get("B1") as any).bootstrapEstablished, false);
  if (failure === "cancel") controller.abort();
  if (failure === "EPIPE") confirm!(Object.assign(Error(failure),{code:failure}));
  assert.equal((await first.result()).stopReason,"aborted"); await tick();
  assert.equal((sessionStates.get("B1") as any).bootstrapEstablished,false);
  const next = streamSimple(model,context("SECOND"),{sessionId:"B1",spawnFn});
  const last=children.at(-1)!;
  if(last!==c)last.send({event:"init",conversation_id:"Y"});
  await tick();
  const input=last.inputs.at(-1)!;
  assert(input.includes("GUARDRAIL"));assert.equal(input.split("SECOND").length-1,1);
  assert.equal((sessionStates.get("B1") as any).bootstrapEstablished,true);
  last.result();assert.equal((await next.result()).stopReason,"stop");
});
test("B1 init and outstanding write do not establish bootstrap",async()=>{
 const c=new FakeAgy();let confirm!:()=>void;
 c.stdin=new Writable({write(_chunk,_encoding,cb){confirm=()=>cb();}}) as any;
 const s=streamSimple(model,context(),{sessionId:"boundary",spawnFn:(()=>c) as any});
 c.send({event:"init",conversation_id:"X"});await tick();
 assert.equal((sessionStates.get("boundary") as any).bootstrapEstablished,false);
 confirm();assert.equal((sessionStates.get("boundary") as any).bootstrapEstablished,true);
 c.result();await s.result();
});

test("B1 queued request prepares full bootstrap after first preparation fails",async()=>{
 const c=new FakeAgy();let reject!:(error:Error)=>void;
 const first=streamSimple(model,context(),{sessionId:"queued-bootstrap",spawnFn:(()=>c) as any,onPayload:()=>new Promise((_,no)=>{reject=no;})});
 const next=streamSimple(model,context("SECOND"),{sessionId:"queued-bootstrap",spawnFn:(()=>c) as any});
 c.send({event:"init",conversation_id:"X"});await tick();reject(Error("payload rejected"));
 assert.equal((await first.result()).stopReason,"aborted");await tick();
 assert.equal(c.turns,1);assert(c.inputs[0].includes("GUARDRAIL"));assert.equal(c.inputs[0].split("SECOND").length-1,1);
 c.result();assert.equal((await next.result()).stopReason,"stop");
});
