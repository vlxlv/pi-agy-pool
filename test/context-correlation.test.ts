import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { setImmediate as tick } from "node:timers/promises";
import { MODELS, API_IDENTIFIER } from "../src/models.ts";
import { streamSimple, resetActiveProcesses } from "../src/stream.ts";
import { piModule, FakeAgy } from "./helpers/pi-progress.ts";
import { buildTurnPrompt, extractAuthoritativeSystemPrompt } from "../src/stream.ts";
const {SessionManager}=await piModule("core/session-manager");
const {convertToLlm}=await piModule("core/messages");
const parse=(c:any)=>JSON.parse(buildTurnPrompt(c,false).split("\n").slice(1).join("\n"));
function projection(removeCalls:number[],removeResults:number[]) {
 const s=SessionManager.inMemory();const ids:string[]=[];
 for(let batch=0;batch<2;batch++) {
  const calls=Array.from({length:3},(_,j)=>{const i=batch*3+j;return {type:"toolCall",id:`PRIVATE_${i}`,name:"read",arguments:{path:`file-${i}`}};});
  const a=s.appendMessage({role:"assistant",content:calls,timestamp:1});
  s.appendContextEdit(a,{content:calls.filter((_:any,j:number)=>!removeCalls.includes(batch*3+j))});
  for(let j=0;j<3;j++){const i=batch*3+j;const r=s.appendMessage({role:"toolResult",toolCallId:`PRIVATE_${i}`,toolName:"read",isError:false,content:[{type:"text",text:"VALUE"}],timestamp:2});ids.push(r);}
 }
 for(const i of removeResults)s.appendContextEdit(ids[i],null);
 s.appendMessage({role:"user",content:"LATEST",timestamp:3});
 return normalizeContext({messages:convertToLlm(s.buildSessionProjection().messages)});
}
function verify(c:any) {
 const records=parse(c),calls=new Map<string,any>();
 for(const m of records)if(m.role==="assistant")for(const b of m.content){assert.equal(typeof b.ref,"string");assert(!calls.has(b.ref));calls.set(b.ref,b);}
 const originalCalls=new Map<string,any>();for(const m of c.messages)if(m.role==="assistant")for(const b of m.content)originalCalls.set(b.id,b);
 const originals=c.messages.filter((m:any)=>m.role==="toolResult");let n=0;
 for(const m of records)if(m.role==="toolResult") {const original=originals[n++],call=originalCalls.get(original.toolCallId);assert.equal(typeof m.ref,"string");if(call){assert.equal(m.orphaned,undefined);assert.deepEqual(calls.get(m.ref)?.arguments,call.arguments);}else{assert.equal(m.orphaned,true);assert(!calls.has(m.ref));}}
 assert(!JSON.stringify(records).includes("PRIVATE_"));return records;
}
test("CP3.1 correlation: identical results keep distinct call associations after real edits",()=>{
 const a=projection([], [1,2,3,4,5]),b=projection([], [0,2,3,4,5]);verify(a);verify(b);assert.notDeepEqual(parse(a),parse(b));
});
test("CP3.1 correlation: orphan calls/results and multiple batches",()=>{verify(projection([0,4],[1,3]));verify(projection([], [0,1,2,3,4,5]));});
test("CP3.1 correlation: seeded subset edits 100 cases",()=>{
 let seed=7731;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
 for(let n=0;n<100;n++){const calls=[],results=[];for(let i=0;i<6;i++){if(rand()%3===0)calls.push(i);if(rand()%3===0)results.push(i);}verify(projection(calls,results));}
});
test("CP3.1 correlation: identical projection serializes identically 100 times",()=>{const c=projection([2],[1,4]);verify(c);const expected=buildTurnPrompt(c,false);for(let i=0;i<100;i++)assert.equal(buildTurnPrompt(structuredClone(c),false),expected);});
const sys=(content:string,sections?:any):any=>({role:"system",content,sections,timestamp:0});
for(const normalized of [false,true])test(`CP3.1 system: legacy/opaque overlap normalized=${normalized}`,()=>{
 const c={systemPrompt:"BASE",messages:[sys("BASE"),sys("EXTRA")]};assert.equal(extractAuthoritativeSystemPrompt(normalized?normalizeContext(c):c),"BASE\n\nEXTRA");
});
test("CP3.1 system: legacy/sections overlap and full equivalent rendering",()=>{
 const s=sys("",{preamble:"BASE",extra:"EXTRA"});for(const legacy of ["BASE","BASE\n\nEXTRA"])for(const normalize of [false,true]){const c={systemPrompt:legacy,messages:[s]};assert.equal(extractAuthoritativeSystemPrompt(normalize?normalizeContext(c):c),"BASE\n\nEXTRA");}
});
test("CP3.1 system: normalized legacy plus opaque plus sections is one representation",()=>{
 const context=normalizeContext({systemPrompt:"BASE\n\nEXTRA",messages:[sys("BASE\n\nEXTRA"),sys("",{preamble:"BASE",extra:"EXTRA"})]});
 assert.equal(extractAuthoritativeSystemPrompt(context),"BASE\n\nEXTRA");
});
test("CP3.1 system: independent repeated sections and opaque updates are retained",()=>{
 assert.equal(extractAuthoritativeSystemPrompt({messages:[sys("",{a:"Always test.",b:"Always test."})]}),"Always test.\n\nAlways test.");
 assert.equal(extractAuthoritativeSystemPrompt({messages:[sys("FIRST"),{...sys("FIRST"),timestamp:2}]}),"FIRST\n\nFIRST");
});
test("CP3.1 system: section update/delete with a legacy alias",()=>{
 const c=normalizeContext({systemPrompt:"BASE",messages:[sys("",{preamble:"BASE",extra:"EXTRA"}),sys("",{preamble:"NEW",extra:null})]});assert.equal(extractAuthoritativeSystemPrompt(c),"NEW");
});

test("CP3.1 system: canonical equivalence reuses; patch/delete retires; stable state reuses",async()=>{
 const children:FakeAgy[]=[],args:string[][]=[];
 const spawnFn:any=(_:string,a:string[])=>{args.push(a);const c=new FakeAgy();children.push(c);return c};
 const model:any={...MODELS[0],api:API_IDENTIFIER,provider:"agy-pool"};
 const initial=sys("",{preamble:"BASE",extra:"EXTRA"});let history:any[]=[];
 async function turn(systems:any[]){const before=children.length;const context=normalizeContext({messages:[...systems,...history,{role:"user",content:"LATEST",timestamp:5}]});const r=streamSimple(model,context,{sessionId:"canon",spawnFn});const c=children.at(-1)!;if(children.length>before)c.send({event:"init",conversation_id:`N${children.length}`});await tick();c.result();history.push(await r.result());}
 try {
  await turn([sys("BASE"),initial]);assert.equal(children.length,1);
  await turn([initial]);assert.equal(children.length,1);
  const updated=[initial,sys("",{extra:"NEW"})];await turn(updated);assert.equal(children.length,2);assert(!args[1].includes("--conversation"));assert.equal(JSON.parse(children[1].inputs[0].split("\n").slice(1).join("\n"))[0].content,"BASE\n\nNEW");
  await turn(updated);assert.equal(children.length,2);
  await turn([...updated,sys("",{extra:null})]);assert.equal(children.length,3);assert(!args[2].includes("--conversation"));
 }finally{await resetActiveProcesses();}
});
