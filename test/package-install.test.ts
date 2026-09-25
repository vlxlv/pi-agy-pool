import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, appendFileSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { piModule } from "./helpers/pi-progress.ts";
const root=resolve(import.meta.dirname,"..");
function workflowStep(file:string,name:string):string {
 const yaml=readFileSync(join(root,file),"utf8");
 const part=yaml.split(`- name: ${name}\n`)[1]?.split("\n      - name:")[0];
 assert(part,`missing workflow step ${name}`);
 return part.slice(part.indexOf("run: |\n")+7).split("\n").map(line=>line.replace(/^          /,"")).join("\n");
}
test("B3 exact CI/release validators accept current pack and reject an unexpected file",()=>{
 const dir=mkdtempSync(join(tmpdir(),"pi-package-"));
 try {
  const pack=JSON.parse(execFileSync("npm",["pack","--json","--pack-destination",dir],{cwd:root,encoding:"utf8"}))[0];
  assert.equal(pack.entryCount,10);
  for(const [file,name] of [[".github/workflows/ci.yml","Inspect and verify package contents"],[".github/workflows/release.yml","Verify tarball contents"]]){
   const run=spawnSync("bash",["-e","-o","pipefail","-c",workflowStep(file,name)],{cwd:root,encoding:"utf8",env:{...process.env,TARBALL_FILE:join(dir,pack.filename)}});
   assert.equal(run.status,0,run.stdout+run.stderr);
  }
  // Feed the same validator an eleventh file, including an otherwise plausible source file.
  const unexpected={...pack,files:[...pack.files,{path:"src/unexpected.ts",size:0,mode:420}]};
  const bad=spawnSync(process.execPath,["scripts/verify-package.mjs","--json"],{cwd:root,input:JSON.stringify([unexpected]),encoding:"utf8"});
  assert.equal(bad.status,1);assert.match(bad.stderr,/Unexpected package inventory/);
  execFileSync("tar",["-xzf",join(dir,pack.filename),"-C",dir]);
  writeFileSync(join(dir,"package/src/unexpected.ts"),"// not a release file\n");
  const badTar=join(dir,"unexpected.tgz");execFileSync("tar",["-czf",badTar,"-C",dir,...pack.files.map((file:any)=>`package/${file.path}`),"package/src/unexpected.ts"]);
  const badRelease=spawnSync("bash",["-e","-c",workflowStep(".github/workflows/release.yml","Verify tarball contents")],{cwd:root,encoding:"utf8",env:{...process.env,TARBALL_FILE:badTar}});
  assert.equal(badRelease.status,1);assert.match(badRelease.stderr,/Unexpected package inventory/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("B4 actual Pi Git install/update/remove and extracted archive installation",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"pi-install-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const pack=JSON.parse(execFileSync("npm",["pack","--json","--pack-destination",dir],{cwd:root,encoding:"utf8"}))[0];
 execFileSync("tar",["-xzf",join(dir,pack.filename),"-C",dir]);
 const fixture=join(dir,"package");
 const {DefaultPackageManager}=await piModule("core/package-manager");
 const {SettingsManager}=await piModule("core/settings-manager");
 const {DefaultResourceLoader}=await piModule("core/resource-loader");
 const settingsManager=SettingsManager.inMemory({packages:[]});
 const manager=new DefaultPackageManager({cwd:dir,agentDir:dir,settingsManager});
 const load=async()=>{
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
 };
 await manager.installAndPersist(fixture);await load();assert.equal(await manager.removeAndPersist(fixture),true);
 assert.equal(settingsManager.getGlobalSettings().packages.length,0);
 // Real Git/npm/package-manager/loader operations, with only the remote redirected
 // to the packed fixture. No network, user config, or production checkout mutation.
 copyFileSync(join(root,"package-lock.json"),join(fixture,"package-lock.json"));
 const git=(...args:string[])=>execFileSync("git",args,{cwd:fixture,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
 git("init","-b","main");git("add",".");
 const commit=()=>git("-c","user.name=Offline Fixture","-c","user.email=fixture@example.invalid","commit","--no-gpg-sign","-qm","fixture");commit();
 const source="git:github.com/vlxlv/pi-agy-pool";
 const count=Number(process.env.GIT_CONFIG_COUNT??0);
 const overlay:Record<string,string>={GIT_CONFIG_COUNT:String(count+1),[`GIT_CONFIG_KEY_${count}`]:`url.file://${fixture}.insteadOf`,[`GIT_CONFIG_VALUE_${count}`]:manager.parseSource(source).repo,npm_config_offline:"true",npm_config_audit:"false",npm_config_fund:"false"};
 const old=new Map(Object.keys(overlay).map(key=>[key,process.env[key]]));Object.assign(process.env,overlay);
 t.after(()=>{for(const [key,value] of old)if(value===undefined)delete process.env[key];else process.env[key]=value;});
 await manager.installAndPersist(source);await load();
 appendFileSync(join(fixture,"README.md"),"\nINSTALL_UPDATE_MARK\n");git("add","README.md");commit();
 await manager.update(source);await load();assert(readFileSync(join(manager.getInstalledPath(source,"user"),"README.md"),"utf8").includes("INSTALL_UPDATE_MARK"));
 assert.equal(await manager.removeAndPersist(source),true);assert.equal(settingsManager.getGlobalSettings().packages.length,0);
});
