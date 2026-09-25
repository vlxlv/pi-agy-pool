import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FakeAgy } from "./helpers/pi-progress.ts";
import { streamSimple, sessionStates, releaseSessionProcesses, resetActiveProcesses } from "../src/stream.ts";
import { MODELS, API_IDENTIFIER } from "../src/models.ts";
const model: any={...MODELS[0],provider:"agy-pool",api:API_IDENTIFIER};
const user=(content:string):any=>({role:"user",content,timestamp:1});
const system:any={role:"system",content:"GUARDRAIL",timestamp:0};
afterEach(()=>resetActiveProcesses());
function harness(){
 const children:FakeAgy[]=[],args:string[][]=[];
 const spawnFn:any=(_:string,a:string[])=>{args.push(a);const c=new FakeAgy();children.push(c);return c;};
 async function turn(messages:any[],options:any={}){
  const before=children.length;
  const {model:requestModel=model,...streamOptions}=options;
  const s=streamSimple(requestModel,{messages} as any,{sessionId:"projection",spawnFn,...streamOptions});
  const c=children.at(-1)!;if(children.length>before)c.send({event:"init",conversation_id:`X${children.length}`});
  await tick();const input=c.inputs.at(-1);c.step({step_type:"agent_response",text_delta:"ANSWER"});c.result();
  return {input,answer:await s.result()};
 }
 return {children,args,turn};
}
test("B2 normal three-turn persistence excludes volatile metadata",async()=>{
 const h=harness();const messages=[system,user("ONE")];const a=await h.turn(messages);
 const history=[...messages,{...a.answer,timestamp:999,responseId:"metadata-only",usage:{input:999}},user("TWO")];
 const b=await h.turn(history);assert.equal(b.input,"TWO");
 const c=await h.turn([...history,b.answer,user("THREE")]);assert.equal(c.input,"THREE");assert.equal(h.children.length,1);
});
for(const mutation of ["replacement","deletion","user insertion","assistant insertion","toolResult","branchSummary","system"])test(`B2 ${mutation} requires fresh current projection`,async()=>{
 const h=harness();const messages:any[]=[system,user("OLD"),{role:"toolResult",toolCallId:"orphan",toolName:"read",isError:false,content:[{type:"text",text:"TOOL_OLD"}],timestamp:1}];
 const a=await h.turn(messages);const changed=structuredClone(messages);
 if(mutation==="replacement")changed[1]=user("NEW");
 if(mutation==="deletion")changed.splice(1,1);
 if(mutation==="toolResult")changed[2].content[0].text="TOOL_NEW";
 if(mutation==="system")changed[0].content="NEW_GUARDRAIL";
 const next=[...changed,a.answer];
 if(mutation==="user insertion")next.push(user("EXTRA_CONTEXT"));
 if(mutation==="assistant insertion")next.push({...a.answer,content:[{type:"text",text:"EXTRA_CONTEXT"}]});
 if(mutation==="branchSummary")next.push({role:"branchSummary",summary:"BRANCH_NEW",timestamp:3});
 const b=await h.turn([...next,user("LATEST")]);
 assert.equal(h.children.length,2);assert(!h.args[1].includes("--conversation"));assert(h.children[0].killed);
 assert(b.input?.startsWith("Pi projected context"));assert.equal(b.input!.split("LATEST").length-1,1);
 if(mutation==="replacement"||mutation==="deletion")assert(!b.input!.includes('"OLD"'));
});
for(const replacement of ["model","cwd","exit","combined"])test(`B2 mutation wins over ${replacement} replacement`,async()=>{
 const h=harness();const a=await h.turn([system,user("OLD")]);
 if(replacement==="exit"||replacement==="combined")h.children[0].emit("exit",0,null);
 const options:any={};if(replacement==="model"||replacement==="combined")options.model={...model,id:"gemini-3.1-pro"};
 if(replacement==="cwd"||replacement==="combined")options.cwd="/tmp/changed";
 const b=await h.turn([system,user("EDITED"),a.answer,user("LATEST")],options);
 assert.equal(h.children.length,2);assert(!h.args[1].includes("--conversation"));assert(b.input?.includes("EDITED"));
});
for(const replacement of ["effort","cwd","exit"])test(`B2 idle ${replacement} preserves native projection checkpoint`,async()=>{
 const h=harness(),messages=[system,user("ONE")];const a=await h.turn(messages);
 if(replacement==="exit")h.children[0].emit("exit",0,null);
 const options=replacement==="effort"?{reasoning:"high"}:replacement==="cwd"?{cwd:"/tmp/idle"}:{};
 const b=await h.turn([...messages,a.answer,user("TWO")],options);
 assert.equal(h.children.length,2);assert(h.args[1].includes("--conversation"));assert.equal(b.input,"TWO");
});

test("B2 checkpoint is a semantic SHA-256 and ownership release revokes it",async()=>{
 const h=harness();await h.turn([system,user("ONE")]);const state=sessionStates.get("projection")!;
 assert.match(state.projectionCheckpoint!,/^[0-9a-f]{64}$/);assert.equal(state.bootstrapEstablished,true);
 await releaseSessionProcesses("projection");assert.equal(state.projectionCheckpoint,undefined);assert.equal(state.bootstrapEstablished,false);
});
test("B2 changed payload cannot establish canonical projection continuity",async()=>{
 const h=harness();await h.turn([system,user("ONE")],{onPayload:()=>({message:{content:"REPLACEMENT"}})});
 assert.equal(sessionStates.get("projection")!.bootstrapEstablished,false);
 const next=await h.turn([system,user("TWO")]);assert.equal(h.children.length,2);assert(!h.args[1].includes("--conversation"));assert(next.input?.includes("GUARDRAIL"));
});

test("B2 fresh replacement cannot inherit a checkpoint after failed preparation",async()=>{
 const h=harness(),messages=[system,user("ONE")];const first=await h.turn(messages);
 const next=[...messages,first.answer,user("TWO")];
 const failed=await h.turn(next,{onPayload:()=>{throw Error("payload rejected");}});
 assert.equal(failed.answer.stopReason,"aborted");
 const replacement=await h.turn(next,{reasoning:"high"});
 assert.equal(h.children.length,2);assert(!h.args[1].includes("--conversation"));assert(replacement.input?.includes("GUARDRAIL"));
});

test("B2 edited projection and model/cwd replacement wait for late predecessor exit",async()=>{
 const h=harness(),messages=[system,user("OLD")];const first=await h.turn(messages);const old=h.children[0];
 old.kill=()=>true;
 const pending=streamSimple({...model,id:"gemini-3.1-pro"},{messages:[system,user("EDITED"),first.answer,user("LATEST")]} as any,{sessionId:"projection",cwd:"/tmp/new-cwd",spawnFn:((_:string,args:string[])=>{h.args.push(args);const c=new FakeAgy();h.children.push(c);return c;}) as any});
 assert.equal(h.children.length,2);const next=h.children[1];next.send({event:"init",conversation_id:"NEW"});await tick();
 assert.equal(next.turns,0);assert(!h.args[1].includes("--conversation"));
 old.emit("exit",0,null);await tick();
 assert.equal(next.turns,1);assert(next.inputs[0].includes("EDITED"));assert(!next.inputs[0].includes('"OLD"'));
 next.result();assert.equal((await pending.result()).stopReason,"stop");
});
