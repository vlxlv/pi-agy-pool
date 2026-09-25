import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { ownershipHarness } from "./helpers/pi-ownership.ts";
import { resetActiveProcesses } from "../src/stream.ts";

async function until(f:()=>boolean) { for(let i=0;i<30000;i++){if(f())return;await tick();}assert.fail("event-loop barrier"); }
function once(p:string,m:string) {assert.equal(p.split(m).length-1,1,m);}
function system(pi:any) {pi.on("before_agent_start",(e:any)=>{e.systemPromptOptions.customPrompt="SYS_MARK";e.systemPromptOptions.sections={...e.systemPromptOptions.sections,project:"PROJECT_MARK"};});}
async function turn(h:any,id:string,request:string,answer:string) {
 const before=h.children.length, c0=h.children.at(-1), n=c0?.turns??0;
 const pending=h.session.prompt(request);await until(()=>h.children.length>before||c0?.turns>n);
 const c=h.children.at(-1);if(c!==c0)c.send({event:"init",conversation_id:id});await until(()=>c.turns>(c===c0?n:0));await tick();
 c.step({step_type:"agent_response",text_delta:answer});c.result();await pending;
 return {input:c.inputs.at(-1) as string,leaf:h.session.sessionManager.getLeafId()};
}
afterEach(()=>resetActiveProcesses());
test("CP3 real initial and persisted restart bootstrap",async t=>{
 const h=await ownershipHarness(true,system);t.after(()=>h.close());
 const first=await turn(h,"X","FIRST_FACT","FIRST_ANSWER");for(const m of ["SYS_MARK","PROJECT_MARK","FIRST_FACT"])once(first.input,m);
 const file=h.session.sessionFile;await h.host.dispose();await resetActiveProcesses();await h.reopen(file);
 const next=await turn(h,"Y","LATEST_REQUEST","LATEST_ANSWER");for(const m of ["SYS_MARK","PROJECT_MARK","FIRST_FACT","FIRST_ANSWER","LATEST_REQUEST"])once(next.input,m);
 assert(!next.input.includes("responseId"));assert(!h.children.at(-1)!.args.includes("--conversation"));
});
for(const point of ["tip","older"])test(`CP3 real fork ${point} projection fidelity`,async t=>{
 const h=await ownershipHarness(false,system);t.after(()=>h.close());
 const first=await turn(h,"X","TARGET_USER","TARGET_ANSWER");const tip=await turn(h,"X","FUTURE_USER","FUTURE_ANSWER");
 await h.host.fork(point==="tip"?tip.leaf:first.leaf,{position:"at"});
 const next=await turn(h,"Y","LATEST_REQUEST","CHILD_ANSWER");for(const m of ["SYS_MARK","PROJECT_MARK","TARGET_USER","TARGET_ANSWER","LATEST_REQUEST"])once(next.input,m);
 for(const m of ["FUTURE_USER","FUTURE_ANSWER"])assert.equal(next.input.split(m).length-1,point==="tip"?1:0);
});
test("CP3 real tree backward sibling return projection fidelity",async t=>{
 const h=await ownershipHarness(false,system);t.after(()=>h.close());
 const first=await turn(h,"X","TARGET_USER","TARGET_ANSWER"),old=await turn(h,"X","OLD_BRANCH_USER","OLD_BRANCH_ANSWER");
 await h.session.navigateTree(first.leaf);const sibling=await turn(h,"Y","SIBLING_USER","SIBLING_ANSWER");once(sibling.input,"TARGET_USER");assert(!sibling.input.includes("OLD_BRANCH_USER"));
 await h.session.navigateTree(old.leaf);const back=await turn(h,"Z","RETURN_REQUEST","RETURN_ANSWER");for(const m of ["SYS_MARK","TARGET_USER","TARGET_ANSWER","OLD_BRANCH_USER","OLD_BRANCH_ANSWER","RETURN_REQUEST"])once(back.input,m);assert(!back.input.includes("SIBLING_USER"));
});
test("CP3 real compaction lifecycle keeps projected content exactly once",async t=>{
 let keep:string;
 const h=await ownershipHarness(false,pi=>{system(pi);pi.on("session_before_compact",()=>({compaction:{summary:"SUMMARY_MARK",firstKeptEntryId:keep,tokensBefore:30000}}));});t.after(()=>h.close());
 await turn(h,"X","REMOVED_USER","REMOVED_ANSWER " + "padding ".repeat(24000));
 const s=h.session.sessionManager;keep=s.appendMessage({role:"user",content:"RETAINED_USER",timestamp:3});
 s.appendMessage({role:"toolResult",toolName:"read",toolCallId:"PRIVATE_TOOL_ID",content:[{type:"text",text:"TOOL_FACT"}],isError:false,timestamp:4});
 await h.session.compact();const next=await turn(h,"Y","LATEST_REQUEST","ANSWER");
 for(const m of ["SYS_MARK","PROJECT_MARK","SUMMARY_MARK","RETAINED_USER","TOOL_FACT","LATEST_REQUEST"])once(next.input,m);
 for(const m of ["REMOVED_USER","REMOVED_ANSWER","PRIVATE_TOOL_ID"])assert(!next.input.includes(m));
});
test("CP3 ambiguous native state bootstraps current Pi projection",async t=>{
 const h=await ownershipHarness(false,system);t.after(()=>h.close());
 await turn(h,"X","FIRST_FACT","FIRST_ANSWER");const c=h.children[0];const pending=h.session.prompt("INTERRUPTED_REQUEST");await until(()=>c.turns===2);c.emit("exit",1,null);await pending;
 const next=await turn(h,"Y","LATEST_REQUEST","ANSWER");for(const m of ["SYS_MARK","FIRST_FACT","FIRST_ANSWER","INTERRUPTED_REQUEST","LATEST_REQUEST"])once(next.input,m);assert(!h.children.at(-1)!.args.includes("--conversation"));
});
