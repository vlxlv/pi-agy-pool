import { test } from "node:test";
import assert from "node:assert/strict";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import { buildTurnPrompt, extractAuthoritativeSystemPrompt } from "../src/stream.ts";
import { piModule } from "./helpers/pi-progress.ts";
const {SessionManager}=await piModule("core/session-manager");
const {convertToLlm}=await piModule("core/messages");
const parse=(c:any)=>JSON.parse(buildTurnPrompt(c,false).split("\n").slice(1).join("\n"));
function context(callRemovals:number[]=[],resultRemovals:number[]=[],duplicate=false) {
 const s=SessionManager.inMemory();let index=0;
 for(let batch=0;batch<3;batch++) {
  const calls=[0,1].map(j=>({type:"toolCall",id:duplicate?"q":j?"r":"q",name:"read",arguments:{path:`file-${batch}-${j}`}}));
  const a=s.appendMessage({role:"assistant",content:[{type:"text",text:"batch"},...calls],timestamp:1});
  s.appendContextEdit(a,{content:[{type:"text",text:"batch"},...calls.filter((_:any,j:number)=>!callRemovals.includes(index+j))]});
  s.appendMessage({role:"system",content:"",timestamp:2});
  for(let j=0;j<2;j++){const r=s.appendMessage({role:"toolResult",toolCallId:calls[j].id,toolName:"read",isError:false,content:[{type:"text",text:"VALUE"}],timestamp:3});if(resultRemovals.includes(index+j))s.appendContextEdit(r,null);}
  index+=2;
 }
 return normalizeContext({messages:convertToLlm(s.buildSessionProjection().messages)});
}
function graph(c:any) {
 const expected:any[]=[];let batch:any[]=[];
 for(const m of c.messages){if(m.role==="assistant")batch=m.content.filter((b:any)=>b.type==="toolCall");else if(m.role==="user")batch=[];else if(m.role==="toolResult"){const matches=batch.filter(b=>b.id===m.toolCallId);expected.push(matches.length===1?matches[0].arguments:null);}}
 const p=parse(c),calls=new Map<string,any>(),refs=new Set<string>();let result=0;
 for(const m of p){if(m.role==="assistant")for(const b of m.content)if(b.type==="toolCall"){assert(!refs.has(b.ref));refs.add(b.ref);calls.set(b.ref,b.arguments);}if(m.role==="toolResult"){const target=expected[result++];if(target){assert.equal(m.orphaned,undefined);assert.deepEqual(calls.get(m.ref),target);}else{assert.equal(m.orphaned,true);assert(!refs.has(m.ref));refs.add(m.ref);}assert.equal(m.content[0].text,"VALUE");}}
 assert.equal(result,expected.length);return p;
}
test("CP3.2 duplicate ID: three batches and exact earlier-call deletion",()=>{graph(context());graph(context([0],[]));graph(context([], [0]));});
test("CP3.2 orphan/future-call: duplicate within batch is ambiguous",()=>{graph(context([],[],true));graph(context([0,1,4],[3],true));});
test("CP3.2 orphan/future-call: user boundary prevents association",()=>{
 const c=context();const messages=c.messages.slice(0,2);messages.push({role:"user",content:"boundary",timestamp:2} as any,...c.messages.slice(2));graph(normalizeContext({messages}));
});
test("CP3.2 duplicate ID: seeded semantic graph 200 cases",()=>{
 let seed=54119;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 for(let n=0;n<200;n++){const calls=[],results=[];for(let i=0;i<6;i++){if(random()%3===0)calls.push(i);if(random()%3===0)results.push(i);}const c=context(calls,results,n%3===0);graph(c);assert.equal(buildTurnPrompt(c,false),buildTurnPrompt(structuredClone(c),false));}
});
test("CP3.2 duplicate ID: different result association differs",()=>{assert.notDeepEqual(graph(context([], [0])),graph(context([], [2])));});
const sys=(content:string,sections?:any,timestamp=0):any=>({role:"system",content,sections,timestamp});
test("CP3.2 system provenance: KEEP_BASE survives boundary and section replacement",()=>{
 const s=SessionManager.inMemory();s.appendMessage(sys("KEEP_BASE"));s.appendMessage({role:"user",content:"boundary",timestamp:1});s.appendMessage(sys("",{preamble:"KEEP_BASE"},2));s.appendMessage(sys("",{preamble:"NEW"},3));const c=normalizeContext({messages:convertToLlm(s.buildSessionProjection().messages)});
 assert.equal(getCurrentSystemPrompt(c.messages),"KEEP_BASE\n\nNEW");assert.equal(parse(c)[0].content,getCurrentSystemPrompt(c.messages));
});
test("CP3.2 system renderer equality: overlaps and independent duplicates",()=>{
 const cases:any[]=[{systemPrompt:"BASE",messages:[sys("BASE"),sys("EXTRA")]},{systemPrompt:"BASE",messages:[sys("",{preamble:"BASE",extra:"EXTRA"})]},{messages:[sys("SAME"),sys("SAME",undefined,3),sys("",{a:"SAME",b:"SAME"})]},{messages:[sys("BASE"),sys("",{preamble:"BASE",extra:"EXTRA"}),sys("",{preamble:"NEW",extra:null})]}];
 for(const c of cases){const expected=getCurrentSystemPrompt(normalizeContext(c).messages);assert.equal(extractAuthoritativeSystemPrompt(c),expected);assert.equal(parse(c)[0].content,expected);const changed=structuredClone(c);changed.messages.forEach((m:any)=>m.timestamp=999);assert.equal(extractAuthoritativeSystemPrompt(changed),expected);}
});

test("CP3.2 duplicate ID: exact two-batch audit and whole earlier assistant deletion",()=>{
 const s=SessionManager.inMemory();const entries:string[]=[];
 for(const file of ["file-a","file-b"]){entries.push(s.appendMessage({role:"assistant",content:[{type:"toolCall",id:"q",name:"read",arguments:{path:file}}],timestamp:1}));s.appendMessage({role:"toolResult",toolCallId:"q",toolName:"read",content:[{type:"text",text:`VALUE_${file}`}],isError:false,timestamp:2});}
 const render=()=>parse(normalizeContext({messages:convertToLlm(s.buildSessionProjection().messages)}));
 const before=render();assert.equal(before.length,4);assert.notEqual(before[0].content[0].ref,before[2].content[0].ref);assert.equal(before[1].ref,before[0].content[0].ref);assert.equal(before[3].ref,before[2].content[0].ref);
 s.appendContextEdit(entries[0],null);const after=render();assert.equal(after[0].orphaned,true);assert.notEqual(after[0].ref,after[1].content[0].ref);assert.equal(after[2].ref,after[1].content[0].ref);assert(!JSON.stringify(after).includes('"toolCallId"'));assert(!JSON.stringify(after).includes('"q"'));
});
test("CP3.2 duplicate ID: identical arguments and results still have occurrence identity",()=>{
 const c=context();for(const m of c.messages)if(m.role==="assistant")for(const b of m.content)if(b.type==="toolCall")b.arguments={path:"same"};graph(c);
});
