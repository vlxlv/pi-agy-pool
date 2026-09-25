import {test,afterEach} from "node:test";
import assert from "node:assert/strict";
import {setImmediate as tick} from "node:timers/promises";
import {ownershipHarness} from "./helpers/pi-ownership.ts";
import {resetActiveProcesses} from "../src/stream.ts";
async function until(f:()=>boolean){for(let i=0;i<30000;i++){if(f())return;await tick();}assert.fail("event barrier");}
async function turn(h:any,text:string){const old=h.children.at(-1),n=old?.turns??0,count=h.children.length;const pending=h.session.prompt(text);await until(()=>h.children.length>count||old?.turns>n);const c=h.children.at(-1);if(c!==old)c.send({event:"init",conversation_id:`X${h.children.length}`});await until(()=>c.turns>(c===old?n:0));await tick();const input=c.inputs.at(-1);c.step({step_type:"agent_response",text_delta:"ANSWER"});c.result();await pending;return input as string;}
function system(pi:any){pi.on("before_agent_start",(e:any)=>{e.systemPromptOptions.customPrompt="SYSTEM_GUARDRAIL";});}
afterEach(()=>resetActiveProcesses());
test("B1 real Pi rejected first payload still bootstraps SECOND_REQUEST",async t=>{
 const h=await ownershipHarness(false,system);t.after(()=>h.close());
 const original=h.session.agent.streamFunction;let calls=0;
 h.session.agent.streamFunction=(m:any,c:any,o:any)=>original(m,c,++calls===1?{...o,onPayload:async()=>{throw Error("reject");}}:o);
 await h.session.prompt("FIRST_REQUEST");assert.equal(h.children[0].turns,0);
 h.children[0].send({event:"init",conversation_id:"X"});
 const input=await turn(h,"SECOND_REQUEST");
 assert(input.includes("SYSTEM_GUARDRAIL"));assert(input.includes("FIRST_REQUEST"));assert.equal(input.split("SECOND_REQUEST").length-1,1);
});
for(const mutation of ["edit","delete","append user","append assistant"])test(`B2 real Pi boundary ${mutation} bootstraps changed projection`,async t=>{
 let changed=false;
 const h=await ownershipHarness(false,pi=>{system(pi);pi.on("turn_end",(_e:any,ctx:any)=>{
  if(changed)return;changed=true;
  if(mutation==="append user")return {entries:[{type:"custom_message",customType:"audit",content:"NEW_REQUIRED_CONTEXT",display:false}]};
  const target=ctx.sessionManager.getBranch().find((e:any)=>e.type==="message"&&e.message.role===(mutation==="append assistant"?"assistant":"user"));
  return {entries:[{type:"context_edit",targetId:target.id,replacement:mutation==="delete"?null:{content:mutation==="append assistant"?[{type:"text",text:"NEW_REQUIRED_CONTEXT"}]:"NEW_REQUIRED_CONTEXT"}}]};
 });});t.after(()=>h.close());
 await turn(h,"OLD_CONTEXT");const input=await turn(h,"LATEST_REQUEST");
 assert.equal(h.children.length,2);assert(!h.children[1].args.includes("--conversation"));assert(input.includes("SYSTEM_GUARDRAIL"));
 if(mutation!=="delete")assert(input.includes("NEW_REQUIRED_CONTEXT"));
 if(mutation==="edit"||mutation==="delete")assert(!input.includes("OLD_CONTEXT"));
 assert.equal(input.split("LATEST_REQUEST").length-1,1);
});
test("B2 real Pi ordinary three turns stay persistent",async t=>{
 const h=await ownershipHarness(false,system);t.after(()=>h.close());
 assert((await turn(h,"ONE")).includes("SYSTEM_GUARDRAIL"));assert.equal(await turn(h,"TWO"),"TWO");assert.equal(await turn(h,"THREE"),"THREE");assert.equal(h.children.length,1);
});
