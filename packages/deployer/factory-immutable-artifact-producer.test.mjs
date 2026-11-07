import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { packSource } from './factory-immutable-artifact-producer.mjs';

const allocated = [];
after(async () => { for (const dir of allocated) await rm(dir, { recursive: true, force: true }); });
async function setup(dependency = 'workspace:*') {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-producer-fixture-'));
  allocated.push(root);
  const dep = '@mastra/fixture-dep', main = '@mastra/fixture-root';
  const paths = new Map([[dep,'pkgs/dep/package.json'],[main,'pkgs/main/package.json']]);
  const manifests = new Map([
    [dep,{ name:dep, version:'0.2.0',files:['dist'],scripts:{prepack:'exit 91'} }],
    [main,{ name:main, version:'1.0.0',files:['dist'],
      dependencies:{[dep]:dependency, 'safe-ext':'1.4.2'},
      scripts:{prepack:'exit 91',postinstall:'exit 92'} }],
  ]);
  for (const name of [main,dep]) {
    const file = paths.get(name);
    await mkdir(path.join(root,path.dirname(file),'dist'),{recursive:true});
    await writeFile(path.join(root,file), JSON.stringify(manifests.get(name),null,2));
    await writeFile(path.join(root,path.dirname(file),'dist/index.js'), 'export default 41;\n');
  }
  const first = path.join(root,'first');
  const second = path.join(root,'second');
  await mkdir(first); await mkdir(second);
  return {root,first,second,main,dep,graph:{packages:manifests,filesByName:paths}};
}
function tarPackageJson(tarball) {
  const bytes = gunzipSync(tarball);
  for(let off=0;off+512<=bytes.length;) {
    const head=bytes.subarray(off,off+512);
    if(head.every(byte=>byte===0))break;
    const name=head.subarray(0,100).toString('utf8').split('\0')[0];
    const size=parseInt(head.subarray(124,136).toString('ascii').split('\0')[0].trim(),8);
    if(name==='package/package.json')return JSON.parse(bytes.subarray(off+512,off+512+size).toString());
    off+=512+Math.ceil(size/512)*512;
  }
  throw new Error('no manifest in fake tar');
}
test('source-built offline tar contains only local first-party file pins, no lifecycle scripts, and retains external spec',async()=>{
  const env=await setup();
  const args={sourceRoot:env.root,sourceFile:env.graph.filesByName.get(env.main),
    manifest:env.graph.packages.get(env.main),graph:env.graph,section:'artifacts'};
  const first=await packSource({...args,destination:env.first});
  const second=await packSource({...args,destination:env.second});
  assert.equal(first.sha256,second.sha256);
  const content=tarPackageJson(await readFile(path.join(env.first,first.fileName)));
  assert.equal(content.dependencies[env.dep],'file:./artifacts/-mastra-fixture-dep-0.2.0.tgz');
  assert.equal(content.dependencies['safe-ext'],'1.4.2');
  assert.equal(content.scripts,undefined);
  const variant=await packSource({...args,section:'workspace-module',destination:await (async()=>{
    const third=path.join(env.root,'third');await mkdir(third);return third;})()});
  assert.notEqual(first.sha256,variant.sha256);
});
test('reject semver registry fallback for source-tracked local dependency',async()=>{
  const env=await setup('^0.2.0');
  await assert.rejects(packSource({sourceRoot:env.root,
    sourceFile:env.graph.filesByName.get(env.main),
    manifest:env.graph.packages.get(env.main),graph:env.graph,
    section:'artifacts',destination:env.first}),
  /source registry substitution/);
});
test('reject missing compiled artifact before immutable npm pack',async()=>{
  const env=await setup();
  const file=env.graph.filesByName.get(env.main);
  const {rm:remove}=await import('node:fs/promises');
  await remove(path.join(env.root,path.dirname(file),'dist/index.js'));
  await assert.rejects(packSource({sourceRoot:env.root,sourceFile:file,
    manifest:env.graph.packages.get(env.main),graph:env.graph,
    section:'artifacts',destination:env.first}),/compiled dist missing/);
});
