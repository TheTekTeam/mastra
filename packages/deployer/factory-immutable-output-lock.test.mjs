import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseDocument } from 'yaml';
import { assertAcceptedExternalClosure, assertPinnedLocalTar, composeCandidateLocks, candidateManifest } from './factory-immutable-output-lock.mjs';

const roots=[];
after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
const integrity=bytes=>'sha512-'+createHash('sha512').update(bytes).digest('base64');
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'factory-lock-only-fixture-'));
  roots.push(root);
  await mkdir(path.join(root,'pkg'));
  await mkdir(path.join(root,'artifacts'));
  await writeFile(path.join(root,'pkg/package.json'),JSON.stringify({
    name:'@fixture/demo',version:'1.0.0',files:['index.js'],
    scripts:{prepack:'exit 73',postinstall:'exit 74'},
  }));
  await writeFile(path.join(root,'pkg/index.js'),'module.exports = {built:true};\n');
  const packed=spawnSync('npm',['pack','--offline','--ignore-scripts','--pack-destination',root],
    {cwd:path.join(root,'pkg'),encoding:'utf8',timeout:20000});
  assert.equal(packed.status,0,packed.stderr);
  const archive=packed.stdout.trim().split('\n').at(-1);
  await rename(path.join(root,archive),path.join(root,'artifacts/demo.tgz'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({
    name:'fixture-root',private:true,version:'0.0.0',packageManager:'pnpm@11.21.0',
    dependencies:{'@fixture/demo':'file:./artifacts/demo.tgz'},
  }));
  return root;
}
test('production lock compositor is default OFF and requires explicit opt-in',async()=>{
  const previous=process.env.MASTRA_FACTORY_IMMUTABLE_LOCK_COMPOSE;
  delete process.env.MASTRA_FACTORY_IMMUTABLE_LOCK_COMPOSE;
  try {
    await assert.rejects(composeCandidateLocks({sourceRoot:'/nonexistent',runtimeRoot:'/nonexistent',
      expectedHead:'a'.repeat(40),pnpmBin:'/nonexistent'}),/explicit lock-composer opt-in missing/);
  } finally {
    if(previous===undefined) delete process.env.MASTRA_FACTORY_IMMUTABLE_LOCK_COMPOSE;
    else process.env.MASTRA_FACTORY_IMMUTABLE_LOCK_COMPOSE=previous;
  }
});
test('generated ESM output bootstrap remains runnable while local deps are pinned',()=>{
  const graph={runtime:['@mastra/core'],output:['@mastra/core'],packages:new Map([
    ['@mastra/core',{version:'1.80.0'}]])};
  const original={name:'server',version:'1.0.0',private:true,type:'module',
    main:'index.mjs',scripts:{start:'node ./index.mjs'},
    dependencies:{'@mastra/core':'^1.80.0','posthog-node':'5.57.1'}};
  const result=candidateManifest('output',original,graph);
  assert.equal(result.type,'module');
  assert.equal(result.main,'index.mjs');
  assert.equal(result.scripts.start,'node ./index.mjs');
  assert.equal(result.name,'server');
  assert.equal(result.dependencies['posthog-node'],'5.57.1');
  assert.equal(result.dependencies['@mastra/core'],
    'file:./workspace-module/-mastra-core-1.80.0.tgz');
});
test('compositor rejects generated output lifecycle/deploy scripts',()=>{
  const graph={runtime:[],output:[],packages:new Map()};
  const original={name:'server',version:'1.0.0',type:'module',main:'index.mjs',
    scripts:{start:'node ./index.mjs',postinstall:'curl https://invalid'}};
  assert.throws(()=>candidateManifest('output',original,graph),
    /generated output bootstrap metadata changed/);
});

test('immutable third-party source closure admits exact metadata, independent of key order',()=>{
  const accepted={
    packages:{'zod@4.6.7':{resolution:{integrity:'sha512-signed',tarball:'registry'}}},
    snapshots:{'zod@4.6.7':{dependencies:{other:'1.0.0',peer:'2.0.0'}}},
  };
  const candidate={
    packages:{'zod@4.6.7':{resolution:{tarball:'registry',integrity:'sha512-signed'}},
      '@mastra/pg@file:workspace-module/pg.tgz':{resolution:{integrity:'sha512-local'}}},
    snapshots:{'zod@4.6.7':{dependencies:{peer:'2.0.0',other:'1.0.0'}}},
  };
  assert.doesNotThrow(()=>assertAcceptedExternalClosure({accepted,candidate,
    firstParty:['@mastra/pg'],section:'workspace-module'}));
});
test('reject unsupported source versions, changed metadata and forged matching caller digest',()=>{
  const accepted={
    packages:{'posthog-node@5.57.1':{resolution:{integrity:'sha512-source'}}},
    snapshots:{'posthog-node@5.57.1':{dependencies:{}}},
  };
  const check=candidate=>assertAcceptedExternalClosure({accepted,candidate,
    firstParty:['@mastra/pg'],section:'artifacts'});
  assert.throws(()=>check({packages:{
    'posthog-node@5.61.3':{resolution:{integrity:'sha512-new'}}},
    snapshots:{}}),/not in source lock/);
  assert.throws(()=>check({packages:{
    'posthog-node@5.57.1':{resolution:{integrity:'sha512-forged'}}},
    snapshots:{}}),/source identity\/version\/metadata drift/);
  assert.throws(()=>check({packages:{
    '@mastra/pg@1.33.0':{resolution:{integrity:'sha512-source'}}},
    snapshots:{}}),/first-party registry\/foreign path/);
  assert.throws(()=>check({packages:{},snapshots:{
    'posthog-node@5.60.0':{dependencies:{}}}}),/not in source lock/);
});
test('local source-built archives require genuine importer and exact SHA512',async()=>{
  const root=await fixture();
  const bytes=await readFile(path.join(root,'artifacts/demo.tgz'));
  const graph={runtime:['@fixture/demo'],output:[],packages:new Map([
    ['@fixture/demo',{version:'1.0.0'}]])};
  const good={importers:{'.':{dependencies:{'@fixture/demo':{
    specifier:'file:./artifacts/-fixture-demo-1.0.0.tgz',
    version:'file:artifacts/-fixture-demo-1.0.0.tgz'}}}},
    packages:{'@fixture/demo@file:artifacts/-fixture-demo-1.0.0.tgz':{
      resolution:{integrity:integrity(bytes)}}}};
  await rename(path.join(root,'artifacts/demo.tgz'),
    path.join(root,'artifacts/-fixture-demo-1.0.0.tgz'));
  await assertPinnedLocalTar({root,lock:good,graph,kind:'runtime'});
  good.packages['@fixture/demo@file:artifacts/-fixture-demo-1.0.0.tgz'].resolution.integrity='sha512-forged';
  await assert.rejects(assertPinnedLocalTar({root,lock:good,graph,kind:'runtime'}),
    /SHA512 lock mismatch/);
});
test('pnpm11 offline frozen install resolves a nested local tar dependency without registry fallback',async()=>{
  const root=await fixture();
  const src=path.join(root,'nested');
  await mkdir(src);
  await writeFile(path.join(src,'package.json'),JSON.stringify({
    name:'@fixture/outer',version:'1.0.0',
    dependencies:{'@fixture/demo':'file:./artifacts/demo.tgz'},
  }));
  await writeFile(path.join(src,'index.js'),'module.exports = true;\n');
  const p=spawnSync('npm',['pack','--offline','--ignore-scripts','--pack-destination',root],
    {cwd:src,encoding:'utf8',timeout:20000});
  assert.equal(p.status,0,p.stderr);
  await rename(path.join(root,p.stdout.trim().split('\n').at(-1)),
    path.join(root,'artifacts/outer.tgz'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({
    name:'fixture-root',private:true,version:'0.0.0',packageManager:'pnpm@11.21.0',
    dependencies:{'@fixture/demo':'file:./artifacts/demo.tgz',
      '@fixture/outer':'file:./artifacts/outer.tgz'},
  }));
  const env={...process.env,npm_config_offline:'true',npm_config_ignore_scripts:'true',
    COREPACK_ENABLE_NETWORK:'0',CI:'true'};
  const run=args=>spawnSync('pnpm',args,{cwd:root,encoding:'utf8',env,timeout:45000});
  const lock=run(['install','--lockfile-only','--offline','--ignore-scripts']);
  assert.equal(lock.status,0,lock.stderr);
  const installed=run(['install','--offline','--frozen-lockfile','--ignore-scripts']);
  assert.equal(installed.status,0,installed.stderr);
});
test('pnpm11 offline lock-only produces a lock accepted by subsequent frozen install',async()=>{
  const root=await fixture();
  const environment={...process.env,npm_config_offline:'true',
    npm_config_ignore_scripts:'true',COREPACK_ENABLE_NETWORK:'0',CI:'true'};
  const run=args=>spawnSync('pnpm',args,{cwd:root,encoding:'utf8',
    env:environment,timeout:45000,maxBuffer:2*1024*1024});
  const version=run(['--version']);
  assert.equal(version.status,0,version.stderr);
  assert.equal(version.stdout.trim(),'11.21.0');
  const lock=run(['install','--offline','--ignore-scripts','--lockfile-only']);
  assert.equal(lock.status,0,lock.stderr);
  const raw=await readFile(path.join(root,'pnpm-lock.yaml'),'utf8');
  const parsed=parseDocument(raw).toJS({maxAliasCount:0});
  assert.equal(parsed.lockfileVersion,'9.0');
  assert.ok(Object.keys(parsed.packages).some(key=>key.startsWith('@fixture/demo@file:')));
  const frozen=run(['install','--offline','--frozen-lockfile','--ignore-scripts']);
  assert.equal(frozen.status,0,frozen.stderr);
});
