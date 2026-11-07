#!/usr/bin/env node
/**
 * Factory candidate lockfile compositor (default OFF).
 * Derives candidate roots from exact accepted Git source + generated Factory
 * output + source-built file: tarballs. Only pnpm 11.21 offline lock-only may
 * resolve dependency snapshots. EVERY external resolution must already exist
 * byte-for-byte in the accepted source lock. No registry/update/deploy/approval.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile,
  realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { sourceLocalClosure } from './factory-immutable-two-builds.mjs';

const RESERVE = 10 * 1024 ** 3;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');
const die = message => { throw new Error('IMMUTABLE_LOCK_BLOCKED: ' + message); };
const ensure = (condition,message) => { if(!condition) die(message); };
const sections = ['dependencies','devDependencies','optionalDependencies'];
const sectionDeps = manifest => Object.assign({},...sections.map(s=>manifest?.[s]??{}));
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value==='object' ? Object.fromEntries(
    Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const tarName = (name,version) => name.replace(/[^a-z0-9._-]/gi,'-') + '-' +
  version.replace(/[^a-z0-9._-]/gi,'-') + '.tgz';

async function safeFile(file) {
  const resolved = await realpath(file);
  ensure(resolved === file,'symlink/escaped file: '+file);
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const s=await fd.stat();ensure(s.isFile()&&s.nlink===1&&s.size<256*1024**2,
    'unsafe/special/oversized file: '+file); return await fd.readFile();}
  finally {await fd.close();}
}
async function safeDirectory(dir) {
  ensure(path.isAbsolute(dir) && dir===path.resolve(dir) && await realpath(dir)===dir &&
    (await lstat(dir)).isDirectory(),'noncanonical/symlink directory: '+dir);
}
async function budget(dir) {
  const fs=await statfs(dir);
  ensure(Number(fs.bavail)*Number(fs.bsize)>=RESERVE,'less than 10GiB free');
}
function parseLock(bytes,label) {
  const parsed=parseDocument(bytes.toString('utf8'),{uniqueKeys:true});
  ensure(parsed.errors.length===0,'invalid/duplicate source lock YAML: '+label);
  const lock=parsed.toJS({maxAliasCount:0});
  ensure(lock?.lockfileVersion==='9.0' && lock?.importers?.['.'] &&
    lock.packages && lock.snapshots,'incomplete pnpm v11 lock: '+label);
  return lock;
}
function gitRead(sourceRoot,args) {
  return execFileSync('git',['-C',sourceRoot,...args],{encoding:'utf8'}).trim();
}
async function sourceState(sourceRoot,expectedHead) {
  await safeDirectory(sourceRoot);
  ensure(/^[0-9a-f]{40}$/.test(expectedHead) &&
    gitRead(sourceRoot,['rev-parse','HEAD'])===expectedHead,
    'source HEAD is not the exact accepted commit');
  const dirty=gitRead(sourceRoot,['status','--porcelain=v1','--untracked-files=all',
    '--','.',' :(exclude)mastracode/web/.mastra/output'.trim()]);
  ensure(!dirty,'unreviewed tracked/untracked source outside output: '+dirty.slice(0,160));
  const bytes=await safeFile(path.join(sourceRoot,'pnpm-lock.yaml'));
  const source=parseLock(bytes,'accepted source');
  const web=JSON.parse((await safeFile(path.join(sourceRoot,'mastracode/web/package.json'))).toString());
  const graph=await sourceLocalClosure(sourceRoot,web);
  const workspaceDoc=parseDocument((await safeFile(path.join(sourceRoot,'pnpm-workspace.yaml'))).toString(),
    {uniqueKeys:true});
  ensure(workspaceDoc.errors.length===0,'source workspace config YAML invalid');
  const workspace=workspaceDoc.toJS({maxAliasCount:0});
  ensure(workspace?.packages&&workspace.overrides,'accepted source workspace settings missing');
  return {source,bytes,graph,web,workspace,sha:sha(bytes)};
}
function localDeps(graph,kind) {
  const names=kind==='runtime'?graph.runtime:graph.output;
  const section=kind==='runtime'?'artifacts':'workspace-module';
  return {names,section,dependencies:Object.fromEntries(names.map(name=>[
    name,'file:./'+section+'/'+tarName(name,graph.packages.get(name).version),
  ]))};
}
/** Registry authority: source exact package keys AND source peer snapshots. */
export function assertAcceptedExternalClosure({accepted,candidate,firstParty,section}) {
  for(const domain of ['packages','snapshots']){
    const expected=accepted[domain]??{};
    for(const [key,entry] of Object.entries(candidate[domain]??{})){
      const name=firstParty.find(name=>key.startsWith(name+'@'));
      if(name){
        ensure(key.startsWith(name+'@file:'+section+'/'),
          domain+' first-party registry/foreign path: '+key);
        continue;
      }
      ensure(Object.hasOwn(expected,key),domain+' not in source lock: '+key);
      ensure(JSON.stringify(canonical(expected[key]))===JSON.stringify(canonical(entry)),
        domain+' source identity/version/metadata drift: '+key);
    }
  }
}
export async function assertPinnedLocalTar({root,lock,graph,kind}) {
  const {names,section,dependencies}=localDeps(graph,kind);
  const importers=sectionDeps(lock.importers['.']);
  for(const name of names){
    const spec=dependencies[name];
    const filename=tarName(name,graph.packages.get(name).version);
    const src=path.join(root,section,filename);
    const bytes=await safeFile(src);
    const key=name+'@file:'+section+'/'+filename;
    ensure(lock.packages[key]?.resolution?.integrity==='sha512-'+sha512(bytes),
      'tar SHA512 lock mismatch: '+name);
    // All first-party modules must be direct importers. This avoids an
    // unpinned transitive path silently going out to the registry.
    ensure(importers[name]?.specifier===spec &&
      String(importers[name]?.version).startsWith('file:'+section+'/'+filename),
      'local tar importer is unpinned: '+name);
  }
}
export function candidateManifest(kind,original,graph){
  const {dependencies}=localDeps(graph,kind);
  const selected={};
  // Keep generated external declarations; replace all source first-party
  // dependencies with local immutable packages. Never trust arbitrary tar names.
  for(const name of sections){
    const deps={};
    for(const [key,spec] of Object.entries(original[name]??{})){
      if(graph.runtime.includes(key)) continue;
      ensure(!key.startsWith('@mastra/')&&key!=='mastra',
        'unexpected first-party outside accepted source closure: '+key);
      ensure(typeof spec==='string'&&!spec.startsWith('file:')&&!spec.startsWith('link:')&&
        !spec.startsWith('workspace:'),'unexpected generated external locator: '+key);
      deps[key]=spec;
    }
    if(Object.keys(deps).length) selected[name]=Object.fromEntries(
      Object.entries(deps).sort(([a],[b])=>a.localeCompare(b)));
  }
  selected.dependencies={...selected.dependencies,
    ...Object.fromEntries(Object.entries(dependencies).sort(([a],[b])=>a.localeCompare(b)))};
  let metadata={name:'factory-immutable-runtime-candidate',private:true,
    version:'0.0.0',packageManager:'pnpm@11.21.0'};
  if(kind==='output'){
    // Generated ESM output must remain runnable. Never drop type/main/start
    // when replacing its dependency graph, or introduce arbitrary lifecycle.
    ensure(typeof original.name==='string'&&typeof original.version==='string'&&
      original.type==='module'&&original.main==='index.mjs'&&
      original.scripts?.start==='node ./index.mjs'&&
      Object.keys(original.scripts??{}).length===1,
      'generated output bootstrap metadata changed; review required');
    metadata={name:original.name,version:original.version,private:true,
      type:'module',main:'index.mjs',scripts:{start:'node ./index.mjs'},
      packageManager:'pnpm@11.21.0'};
  }
  return {...metadata,...selected};
}
function runPnpmOffline(dir,pnpmBin){
  ensure(pnpmBin&&path.isAbsolute(pnpmBin)&&path.resolve(pnpmBin)===pnpmBin,
    'pinned pnpm binary required (absolute)');
  const base=['--offline','--ignore-scripts','--lockfile-only','--config.verify-store-integrity=true'];
  const args=pnpmBin.endsWith('.cjs')?[pnpmBin,'install',...base]:['install',...base];
  const executable=pnpmBin.endsWith('.cjs')?process.execPath:pnpmBin;
  const env={...process.env,npm_config_offline:'true',npm_config_ignore_scripts:'true',
    COREPACK_ENABLE_NETWORK:'0',CI:'true'};
  const version=spawnSync(executable,pnpmBin.endsWith('.cjs')?[pnpmBin,'--version']:['--version'],
    {cwd:dir,encoding:'utf8',env,timeout:20000});
  ensure(!version.error&&version.status===0&&version.stdout.trim()==='11.21.0',
    'offline pnpm 11.21.0 required; do not change global toolchain');
  const result=spawnSync(executable,args,{cwd:dir,encoding:'utf8',env,
    timeout:120000,maxBuffer:8*1024*1024});
  ensure(!result.error&&result.status===0,
    'pnpm offline lock-only failed: '+(result.stderr??result.error?.message??'').slice(-1000));
}
async function stageKind({tmp,kind,graph,original,sourceLock,sourceWorkspace,sourceRoot,pnpmBin,candidateRoot}){
  const {names,section}=localDeps(graph,kind);
  const dir=path.join(tmp,kind);await mkdir(dir);
  await mkdir(path.join(dir,section));
  for(const name of names){
    const filename=tarName(name,graph.packages.get(name).version);
    const archived=await safeFile(path.join(candidateRoot,section,filename));
    await writeFile(path.join(dir,section,filename),archived,{flag:'wx'});
  }
  const manifest=candidateManifest(kind,original,graph);
  await writeFile(path.join(dir,'package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  // pnpm-workspace is isolated and has exact local overrides. A source
  // third-party version never gains registry authority from the caller.
  const overrides={...sourceWorkspace.overrides};
  for(const name of names){
    ensure(!Object.hasOwn(overrides,name),'source already overrides first-party: '+name);
    overrides[name]='file:./'+section+'/'+tarName(name,graph.packages.get(name).version);
  }
  const workspace={...sourceWorkspace,packages:['.'],overrides,
    allowUnusedPatches:true};
  // Copy ONLY reviewed patches referenced by the accepted source workspace,
  // never infer patch content from untrusted/generated candidate output.
  for(const patch of Object.values(sourceWorkspace.patchedDependencies??{})){
    ensure(typeof patch==='string'&&/^patches\/[A-Za-z0-9@._+-]+\.patch$/.test(patch),
      'unsafe/unreviewed source patch path');
    const body=await safeFile(path.join(sourceRoot,patch));
    await mkdir(path.dirname(path.join(dir,patch)),{recursive:true});
    await writeFile(path.join(dir,patch),body,{flag:'wx'});
  }
  await writeFile(path.join(dir,'pnpm-workspace.yaml'),stringify(workspace),{flag:'wx'});
  runPnpmOffline(dir,pnpmBin);
  const bytes=await safeFile(path.join(dir,'pnpm-lock.yaml'));
  const lock=parseLock(bytes,kind);
  assertAcceptedExternalClosure({accepted:sourceLock,candidate:lock,firstParty:graph.runtime,
    section});
  await assertPinnedLocalTar({root:dir,lock,graph,kind});
  return {dir,manifest,bytes,lock,sha256:sha(bytes)};
}
/** Operator must invoke on isolated, exact-head, already built candidates. */
export async function composeCandidateLocks({sourceRoot,runtimeRoot,expectedHead,pnpmBin}){
  ensure(process.env.MASTRA_FACTORY_IMMUTABLE_LOCK_COMPOSE==='1',
    'explicit lock-composer opt-in missing');
  const info=await sourceState(sourceRoot,expectedHead);
  await safeDirectory(runtimeRoot);
  const outputRoot=path.join(sourceRoot,'mastracode/web/.mastra/output');
  await safeDirectory(outputRoot);
  ensure(path.dirname(runtimeRoot)===path.dirname(sourceRoot)&&
    path.basename(runtimeRoot)==='runtime','runtime must be isolated sibling /runtime');
  await budget(path.dirname(sourceRoot));
  const originalOutput=JSON.parse((await safeFile(path.join(outputRoot,'package.json'))).toString());
  // Source web manifest provides independent runtime external constraints.
  const tmp=await mkdtemp(path.join(path.dirname(sourceRoot),'.immutable-lock-'));
  try{
    const rt=await stageKind({tmp,kind:'runtime',graph:info.graph,original:info.web,
      sourceLock:info.source,sourceWorkspace:info.workspace,sourceRoot,pnpmBin,candidateRoot:runtimeRoot});
    await budget(path.dirname(sourceRoot));
    const out=await stageKind({tmp,kind:'output',graph:info.graph,original:originalOutput,
      sourceLock:info.source,sourceWorkspace:info.workspace,sourceRoot,pnpmBin,candidateRoot:outputRoot});
    ensure(rt.bytes.length>0&&out.bytes.length>0,'no candidate locks');
    // Fail before any final write if a candidate lock exists. Never replace it.
    for(const file of [path.join(runtimeRoot,'pnpm-lock.yaml'),
      path.join(outputRoot,'pnpm-lock.yaml'),path.join(runtimeRoot,'package.json')]){
      try{await lstat(file);die('candidate lock/manifest already exists: '+file);}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    await writeFile(path.join(runtimeRoot,'pnpm-lock.yaml'),rt.bytes,{flag:'wx'});
    await writeFile(path.join(runtimeRoot,'package.json'),
      JSON.stringify(rt.manifest,null,2)+'\n',{flag:'wx'});
    // Generated output is private and ignored by git; only exact opt-in may
    // replace its pre-existing manifest after both locks pass validation.
    const nextOutput=path.join(outputRoot,'.immutable-package-next.json');
    await writeFile(nextOutput,JSON.stringify(out.manifest,null,2)+'\n',{flag:'wx'});
    await rename(nextOutput,path.join(outputRoot,'package.json'));
    await writeFile(path.join(outputRoot,'pnpm-lock.yaml'),out.bytes,{flag:'wx'});
    return {candidateOnly:true,sourceHead:expectedHead,sourceLockSha256:info.sha,
      runtimeLockSha256:rt.sha256,outputLockSha256:out.sha256,local:{
        runtime:info.graph.runtime.length,output:info.graph.output.length},
      releaseApproved:false};
  } finally{
    await rm(tmp,{recursive:true,force:true}); // only exact mkdtemp-owned staging.
  }
}
const cli=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(cli){
  const [head,sourceRoot,runtimeRoot,pnpmBin]=process.argv.slice(2);
  try{
    ensure(head&&sourceRoot&&runtimeRoot&&pnpmBin,
      'usage: node factory-immutable-output-lock.mjs EXPECTED_SHA SOURCE_ROOT SIBLING_RUNTIME ABS_PNPM11_BIN');
    process.stdout.write(JSON.stringify(await composeCandidateLocks({
      expectedHead:head,sourceRoot,runtimeRoot,pnpmBin}),null,2)+'\n');
  }catch(error){process.stderr.write(String(error)+'\n');process.exitCode=1;}
}
