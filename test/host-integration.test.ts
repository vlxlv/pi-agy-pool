import {test,afterEach} from "node:test";
import assert from "node:assert/strict";
import {setImmediate as tick} from "node:timers/promises";
import {readFileSync} from "node:fs";
import {streamSimple,resetActiveProcesses} from "../src/stream.ts";
import {registerAgyPoolProvider} from "../src/provider.ts";
import {MODELS,API_IDENTIFIER} from "../src/models.ts";
import {FakeAgy} from "./helpers/pi-progress.ts";
import {isRetryableAssistantError} from "@earendil-works/pi-ai";
import {AgyEventDecoder} from "../src/agy-events.ts";
async function collect(stream:any) {const events:any[]=[];for await(const event of stream)events.push(event);return events;}
const initialListeners=["SIGINT","SIGTERM","exit"].map(n=>process.listenerCount(n));
const model:any={...MODELS[0],api:API_IDENTIFIER,provider:"agy-pool"};
const context:any={messages:[{role:"user",content:"hello",timestamp:1}]};
afterEach(()=>resetActiveProcesses());
async function run(options:any={},events:any[]=[],terminal:any={event:"result",status:"SUCCESS"}){const child=new FakeAgy();const stream=streamSimple(model,context,{sessionId:"host-test",...options,spawnFn:()=>child});child.send({event:"init",conversation_id:"X"});await tick();for(const e of events)child.send(e);child.send(terminal);return {child,result:await stream.result(),events:await collect(stream)};}
test("CP4 cwd propagation and idle replacement",async()=>{
 const children:any[]=[],spawns:any[]=[];const spawnFn:any=(_:any,__:any,o:any)=>{spawns.push(o);const c=new FakeAgy();children.push(c);return c};
 for(const cwd of ["/workspace/a","/workspace/a","/workspace/b"]){const before=children.length;const stream=streamSimple(model,context,{sessionId:"cwd",cwd,spawnFn} as any);const c=children.at(-1);if(children.length>before)c.send({event:"init",conversation_id:"X"});await tick();c.result();await stream.result();}
 assert.deepEqual(spawns.map(o=>o.cwd),["/workspace/a","/workspace/b"]);
});
test("CP4 bound session cwd is authoritative",async()=>{
 const hooks:any={};let provider:any;registerAgyPoolProvider({on:(n:any,f:any)=>hooks[n]=f,registerProvider:(_:any,p:any)=>provider=p} as any);
 await hooks.session_start({}, {mode:"print",cwd:"/session/override",sessionManager:{getSessionId:()=>"cwd"}});
 const child=new FakeAgy();let cwd;const s=provider.streamSimple(model,context,{sessionId:"cwd",spawnFn:(_:any,__:any,o:any)=>{cwd=o.cwd;return child}});child.send({event:"init",conversation_id:"X"});await tick();child.result();await s.result();assert.equal(cwd,"/session/override");await hooks.session_shutdown();
});
test("CP4 provider environment overlays inherited environment",async()=>{let env:any;const child=new FakeAgy();const s=streamSimple(model,context,{env:{CP4_TEST:"value"},spawnFn:((_:any,__:any,o:any)=>{env=o.env;return child}) as any});child.send({event:"init",conversation_id:"E"});await tick();child.result();await s.result();assert.equal(env.CP4_TEST,"value");assert.equal(env.PATH,process.env.PATH);});
test("CP4 no host signal hooks",async()=>{const before=initialListeners;await run();assert.deepEqual(["SIGINT","SIGTERM","exit"].map(n=>process.listenerCount(n)),before);});
for(const message of ["service unavailable","rate limit 429","quota exceeded","context length exceeded"])test(`CP4 no automatic replay: ${message}`,async()=>{const {result}=await run({},[],{event:"result",status:"ERROR",error:message});assert.equal(isRetryableAssistantError(result),false);assert.equal(result.stopReason,"aborted");assert(result.errorMessage?.includes(message));});
test("CP4 terminal usage replaces all incremental counters including error",async()=>{for(const status of ["SUCCESS","ERROR"]){await resetActiveProcesses();const {result}=await run({},[{event:"step_update",step_update:{usage:{input_tokens:10,output_tokens:2,total_tokens:12,thinking_tokens:1,cache_read_tokens:3}}}],{event:"result",status,error:"failed",result:{usage:{input_tokens:20,output_tokens:4,thinking_tokens:2,cache_read_tokens:7}}});assert.deepEqual([result.usage.input,result.usage.output,result.usage.reasoning,result.usage.cacheRead,result.usage.totalTokens],[20,4,2,7,31]);}});
test("CP4 reused result-only turns always start; HTTP callback inapplicable",async()=>{let invoked=0;const child=new FakeAgy();for(let i=0;i<2;i++){const s=streamSimple(model,context,{sessionId:"reuse",spawnFn:(()=>child) as any,onResponse:async()=>{invoked++;throw Error("must not invoke")}});if(!i)child.send({event:"init",conversation_id:"X"});await tick();child.result();await s.result();const events=await collect(s);assert.equal(events[0].type,"start");assert.equal(events.filter(e=>e.type==="start").length,1);}assert.equal(invoked,0);});
test("CP4 rejected payload does not write and emits start/error",async()=>{const child=new FakeAgy();const s=streamSimple(model,context,{spawnFn:(()=>child) as any,onPayload:async()=>{throw Error("payload failed")}});child.send({event:"init",conversation_id:"X"});const result=await s.result();assert.equal(child.turns,0);assert.equal(result.stopReason,"aborted");assert.equal((await collect(s))[0].type,"start");});
test("CP4 diagnostics redact secrets and bound text",async()=>{const secret='Authorization: Bearer tokenSECRET\nCookie: session=cookieSECRET\nhttps://host/?api_key=keySECRET&access_token=accessSECRET\npassword=passSECRET';const {result}=await run({},[],{event:"result",status:"ERROR",error:secret+' z'.repeat(10000)});assert(!result.errorMessage?.includes('SECRET'));assert(result.errorMessage!.length<=4096);});
test("CP4 decoder states UTF-16 limit honestly",()=>{const d=new AgyEventDecoder(4);assert.throws(()=>d.feed(Buffer.from('雪'.repeat(5))),/UTF-16/);});
test("CP4 package metadata consistent",()=>{const p=JSON.parse(readFileSync('package.json','utf8')),l=JSON.parse(readFileSync('package-lock.json','utf8')).packages[''];assert.deepEqual(l.engines,p.engines);assert.deepEqual(l.peerDependencies,p.peerDependencies);assert.equal(p.engines.pi,">=0.87.1");});

test("CP4 stderr oversized credential line cannot leak a truncated suffix",async()=>{const child=new FakeAgy();const s=streamSimple(model,context,{spawnFn:(()=>child) as any});child.stderr.write("Authorization: Bearer "+"SECRET".repeat(1500));child.emit("exit",1,null);const result=await s.result();assert(!result.errorMessage?.includes("SECRET"));assert(result.errorMessage?.includes("code 1"));});
test("CP4 usage snapshot matrix and abort",async()=>{
 const cases:any[]=[
  [{input_tokens:4,output_tokens:3,thinking_tokens:2,cache_read_tokens:1},undefined,[4,3,2,1,8]],
  [undefined,{input_tokens:6,output_tokens:2,total_tokens:99},[6,2,undefined,0,99]],
  [{input_tokens:4,output_tokens:3},{input_tokens:4,output_tokens:3},[4,3,undefined,0,7]],
  [{input_tokens:4,output_tokens:3,thinking_tokens:2,cache_read_tokens:1},{output_tokens:9},[0,9,undefined,0,9]],
  [undefined,{total_tokens:17},[0,0,undefined,0,17]],
 ];
 for(const [incremental,terminal,expected]of cases){await resetActiveProcesses();const {result}=await run({},incremental?[{event:"step_update",step_update:{usage:incremental}}]:[],{event:"result",status:"SUCCESS",result:{usage:terminal}});assert.deepEqual([result.usage.input,result.usage.output,result.usage.reasoning,result.usage.cacheRead,result.usage.totalTokens],expected);}
 await resetActiveProcesses();const controller=new AbortController(),child=new FakeAgy();const stream=streamSimple(model,context,{signal:controller.signal,spawnFn:(()=>child) as any});child.send({event:"init",conversation_id:"A"});await tick();child.step({usage:{input_tokens:4,output_tokens:1}});controller.abort();assert.equal((await stream.result()).usage.totalTokens,5);
});
test("CP4 cwd busy replacement starts fresh and env replacement is isolated",async()=>{const children:any[]=[],args:string[][]=[];const spawnFn:any=(_:any,a:any)=>{args.push(a);const c=new FakeAgy();children.push(c);return c};const a=streamSimple(model,context,{sessionId:"busy",cwd:"/a",spawnFn});children[0].send({event:"init",conversation_id:"A"});await tick();const b=streamSimple(model,context,{sessionId:"busy",cwd:"/b",spawnFn});children[1].send({event:"init",conversation_id:"B"});await tick();children[1].result();assert.equal((await a.result()).stopReason,"aborted");await b.result();assert(!args[1].includes("--conversation"));const c=streamSimple(model,context,{sessionId:"busy",cwd:"/b",env:{CP4_TEST:"changed"},spawnFn});assert.equal(children.length,3);children[2].send({event:"init",conversation_id:"B"});await tick();children[2].result();await c.result();assert(args[2].includes("--conversation"));});

test("CP4 repeated extension load/shutdown owns cleanup without signal listeners",async()=>{const before=["SIGINT","SIGTERM","exit"].map(n=>process.listenerCount(n));for(let i=0;i<100;i++){let p:any;const hooks:any={};registerAgyPoolProvider({on:(n:any,f:any)=>hooks[n]=f,registerProvider:(_:any,c:any)=>p=c} as any);await hooks.session_start({}, {mode:"print",cwd:"/tmp",sessionManager:{getSessionId:()=>"load"}});const child=new FakeAgy();const s=p.streamSimple(model,context,{sessionId:"load",spawnFn:()=>child});child.send({event:"init",conversation_id:`L${i}`});await tick();child.result();await s.result();await hooks.session_shutdown();assert(child.killed);assert.deepEqual(["SIGINT","SIGTERM","exit"].map(n=>process.listenerCount(n)),before);}});

test("CP4 payload replacement permits an intentional empty string",async()=>{const {child}=await run({onPayload:async()=>({event:"user",message:{content:""}})});assert.equal(child.inputs[0],"");});
