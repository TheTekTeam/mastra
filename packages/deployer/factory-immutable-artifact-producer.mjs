#!/usr/bin/env node
/**
 * Offline source-built first-party ARTIFACT producer, NEVER release authority.
 * Explicit opt-in; only isolated clean Git worktree roots and sibling candidate
 * directories. Does not produce output locks, install, deploy, touch services,
 * or approve a release. #51 verifies final dual-root closure separately.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename,
  rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceLocalClosure } from './factory-immutable-two-builds.mjs';

const RESERVE_BYTES = 10 * 1024 ** 3;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const die = msg => { throw new Error('IMMUTABLE_ARTIFACT_BLOCKED: ' + msg); };
const need = (condition, msg) => { if (!condition) die(msg); };
const fileName = (name, version) =>
  name.replace(/[^a-z0-9._-]/gi, '-') + '-' + version.replace(/[^a-z0-9._-]/gi, '-') + '.tgz';
const sections = ['dependencies', 'optionalDependencies'];
const packageDeps = pkg => Object.assign({}, ...sections.map(key => pkg[key] ?? {}));

function run(executable, args, cwd, { capture = true } = {}) {
  const result = spawnSync(executable, args, {
    cwd, encoding: 'utf8', timeout: 20 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024, stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
      COREPACK_ENABLE_NETWORK: '0', CI: 'true' },
  });
  need(!result.error && result.status === 0,
    executable + ' failed offline: ' + (result.stderr ?? result.error?.message ?? '').slice(-1200));
  return result.stdout ?? '';
}
async function reserve(dir) {
  const disk = await statfs(dir);
  const available = Number(disk.bavail) * Number(disk.bsize);
  need(available >= RESERVE_BYTES, 'disk reserve below 10GiB; abort staging');
  return available;
}
async function regularFile(file) {
  const real = await realpath(file);
  need(real === file, 'symlink/escaped source: ' + file);
  const fd = await import('node:fs/promises').then(fs => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW));
  try {
    const st = await fd.stat();
    need(st.isFile() && st.nlink === 1 && st.size <= 256 * 1024 ** 2,
      'linked/special/oversized source file: ' + file);
  } finally { await fd.close(); }
}
function safeRelative(relative) {
  need(relative && !path.isAbsolute(relative) && !relative.split('/').includes('..') &&
    !relative.split('/').includes('node_modules') && !relative.split('/').includes('.git'),
    'unsafe npm pack-list path: ' + relative);
}
async function inspectSource(sourceRoot, expectedHead) {
  need(/^[a-f0-9]{40}$/.test(expectedHead), 'expected source SHA must be full reviewed HEAD');
  need(path.isAbsolute(sourceRoot) && sourceRoot === path.resolve(sourceRoot) &&
    await realpath(sourceRoot) === sourceRoot && (await lstat(sourceRoot)).isDirectory(),
    'source root must be absolute, real isolated directory');
  // Protect operational hosts from accidental use: require an isolated worktree/clone.
  need(!sourceRoot.startsWith('/opt/') && !sourceRoot.startsWith('/etc/') &&
    !sourceRoot.startsWith('/var/'), 'source must not be live filesystem');
  const head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding:'utf8' }).trim();
  need(head === expectedHead, 'unapproved/stale source HEAD');
  const changed = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain=v1',
    '--untracked-files=all', '--', '.', ':(exclude)mastracode/web/.mastra/output'],
    { encoding:'utf8' }).trim();
  need(!changed, 'source clone has unreviewed mutations: ' + changed.slice(0, 300));
  const sourceLock = await readFile(path.join(sourceRoot, 'pnpm-lock.yaml'));
  const webManifest = JSON.parse(await readFile(path.join(sourceRoot, 'mastracode/web/package.json'),'utf8'));
  const graph = await sourceLocalClosure(sourceRoot, webManifest);
  return { graph, head, sourceLockSha256: digest(sourceLock) };
}
function buildOrder(graph) {
  const result = [], pending = new Set();
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    need(!pending.has(name), 'cyclic build dependency: ' + name);
    pending.add(name);
    const pkg = graph.packages.get(name);
    need(pkg, 'missing source package: ' + name);
    const imports = { ...packageDeps(pkg), ...pkg.peerDependencies };
    for (const dep of Object.keys(imports).filter(dep => graph.runtime.includes(dep)).sort()) {
      visit(dep); // peer ranges constrain build order, not tar resolution.
    }
    pending.delete(name); visited.add(name); result.push(name);
  }
  for(const name of graph.runtime) visit(name);
  return result;
}
export async function buildApprovedSource({ sourceRoot, expectedHead }) {
  need(process.env.MASTRA_FACTORY_IMMUTABLE_ARTIFACT_BUILD === '1',
    'explicit artifact build opt-in missing');
  const info = await inspectSource(sourceRoot, expectedHead);
  await reserve(sourceRoot);
  const order = buildOrder(info.graph);
  // User-visible failures are honest; no alternate live/registry build fallback.
  for (const name of order) {
    const pkg = info.graph.packages.get(name);
    const script = pkg.scripts?.['build:lib'] ? 'build:lib' : pkg.scripts?.build ? 'build' : '';
    need(script, 'no reviewed package build script: ' + name);
    const pkgDir = path.join(sourceRoot, path.dirname(info.graph.filesByName.get(name)));
    await reserve(sourceRoot);
    run('pnpm', ['run', script], pkgDir, { capture: false });
  }
  return { candidateOnly: true, builtPackages: order.length, sourceHead: expectedHead };
}

/** Build one stable local package tar from precompiled source, no lifecycle hooks. */
export async function packSource({ sourceRoot, sourceFile, manifest, graph, section, destination }) {
  need(['artifacts','workspace-module'].includes(section), 'bad immutable artifact section');
  const root = path.join(sourceRoot, path.dirname(sourceFile));
  const raw = run('npm', ['pack','--dry-run','--json','--offline','--ignore-scripts'], root);
  const listed = JSON.parse(raw);
  need(Array.isArray(listed) && listed.length === 1 && Array.isArray(listed[0].files),
    'npm returned no trustworthy pack list: ' + manifest.name);
  need(listed[0].files.some(entry => entry.path.startsWith('dist/')),
    'compiled dist missing from offline package: ' + manifest.name);
  const stage = await mkdtemp(path.join(os.tmpdir(), 'factory-immutable-pack-'));
  try {
    let total = 0;
    for (const item of listed[0].files) {
      const rel = item.path;
      safeRelative(rel);
      if (rel === 'package.json') continue;
      const src = path.join(root, rel);
      await regularFile(src);
      const size = (await stat(src)).size;
      need((total += size) <= 512 * 1024 ** 2,
        'package contents exceed 512MiB: ' + manifest.name);
      await mkdir(path.dirname(path.join(stage, rel)), {recursive:true});
      await copyFile(src, path.join(stage, rel));
    }
    const pinned = structuredClone(manifest);
    // A candidate may never invoke prepack/postinstall/build lifecycle scripts.
    delete pinned.scripts;
    for (const sectionName of sections) {
      for (const [dep, version] of Object.entries(pinned[sectionName] ?? {})) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          const dependency = graph.packages.get(dep);
          need(dependency, 'unmapped first-party tar dependency: ' + manifest.name + ' -> ' + dep);
          pinned[sectionName][dep] = 'file:./' + section + '/' +
            fileName(dep, dependency.version);
        } else if (graph.packages.has(dep)) {
          die('source registry substitution for local package: ' + manifest.name + ' -> ' + dep);
        }
      }
    }
    await writeFile(path.join(stage,'package.json'), JSON.stringify(pinned,null,2) + '\n');
    const packed = JSON.parse(run('npm', ['pack','--json','--offline',
      '--ignore-scripts','--pack-destination',stage], stage));
    need(packed.length === 1 && /^[a-z0-9._-]+\.tgz$/i.test(packed[0].filename),
      'invalid offline npm packed artifact: ' + manifest.name);
    const archive = path.join(stage,packed[0].filename);
    await regularFile(archive);
    const target = path.join(destination, fileName(manifest.name, manifest.version));
    await copyFile(archive, target, constants.COPYFILE_EXCL);
    const bytes = await readFile(target);
    return { name: manifest.name, version: manifest.version,
      fileName: path.basename(target), sha256: digest(bytes),
      sha512: createHash('sha512').update(bytes).digest('base64') };
  } finally {
    await rm(stage,{recursive:true,force:true}); // Exact private mkdtemp only.
  }
}

/** Two sections are independently pinned; no output lock/production approval. */
export async function produceArtifacts({sourceRoot,expectedHead,runtimeRoot}) {
  need(process.env.MASTRA_FACTORY_IMMUTABLE_ARTIFACT_PRODUCE === '1',
    'explicit artifact production opt-in missing');
  const info = await inspectSource(sourceRoot, expectedHead);
  need(path.dirname(runtimeRoot) === path.dirname(sourceRoot) &&
    path.basename(runtimeRoot) === 'runtime', 'runtime must be sibling /runtime candidate');
  need(runtimeRoot === path.resolve(runtimeRoot), 'noncanonical runtime candidate');
  await reserve(path.dirname(sourceRoot));
  const outputRoot = path.join(sourceRoot,'mastracode/web/.mastra/output');
  need(await realpath(outputRoot) === outputRoot &&
    (await lstat(outputRoot)).isDirectory(), 'generated output must exist from explicit CLI build');
  const rtArtifacts = path.join(runtimeRoot,'artifacts');
  const outArtifacts = path.join(outputRoot,'workspace-module');
  for (const target of [runtimeRoot,rtArtifacts,outArtifacts]) {
    try { await access(target); die('would overwrite existing artifact target: ' + target); }
    catch (e) { if (!String(e.message).includes('ENOENT')) throw e; }
  }
  await mkdir(rtArtifacts,{recursive:true});
  await mkdir(outArtifacts,{recursive:true});
  const pins = { runtime: {}, output: {} };
  for (const [kind,names,section,dest] of [
    ['runtime', info.graph.runtime,'artifacts',rtArtifacts],
    ['output',info.graph.output,'workspace-module',outArtifacts],
  ]) {
    for (const name of names) {
      await reserve(path.dirname(sourceRoot));
      pins[kind][name] = await packSource({sourceRoot,
        sourceFile:info.graph.filesByName.get(name),
        manifest:info.graph.packages.get(name),
        graph:info.graph,section,destination:dest});
    }
  }
  const record = { candidateOnly:true, artifactOnly:true,
    sourceHead:expectedHead,sourceLockSha256:info.sourceLockSha256,pins };
  await writeFile(path.join(runtimeRoot,'artifact-producer-proof.json'),
    JSON.stringify(record,null,2)+'\n', {flag:'wx'});
  await reserve(path.dirname(sourceRoot));
  return record;
}
const cli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (cli) {
  const [operation,head,sourceRoot,runtimeRoot] = process.argv.slice(2);
  try {
    if (!head || !sourceRoot || (operation !== 'preflight' && operation !== 'produce' &&
      operation !== 'build') || (operation === 'produce' && !runtimeRoot)) {
      die('usage: node factory-immutable-artifact-producer.mjs preflight|build|produce ACCEPTED_HEAD SOURCE_ROOT [SIBLING_RUNTIME]');
    }
    if (operation === 'preflight') {
      const info = await inspectSource(sourceRoot,head);
      const bytes = await reserve(sourceRoot);
      process.stdout.write(JSON.stringify({ candidateOnly:true,artifactOnly:true,
        sourceHead:head,sourceLockSha256:info.sourceLockSha256,
        runtimeCount:info.graph.runtime.length,outputCount:info.graph.output.length,
        diskFreeBytes:bytes,buildOrder:buildOrder(info.graph) },null,2)+'\n');
    } else if (operation === 'build') {
      const result = await buildApprovedSource({sourceRoot,expectedHead:head});
      process.stdout.write(JSON.stringify(result,null,2)+'\n');
    } else {
      const result = await produceArtifacts({sourceRoot,expectedHead:head,runtimeRoot});
      process.stdout.write(JSON.stringify(result,null,2)+'\n');
    }
  } catch (error) { process.stderr.write(String(error)+'\n'); process.exitCode=1; }
}
