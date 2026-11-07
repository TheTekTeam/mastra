import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { inspectCandidate, verifyTwoBuilds } from './factory-immutable-two-builds.mjs';

const names = [
  '@mastra/auth-better-auth', '@mastra/auth-workos', '@mastra/client-js',
  '@mastra/code-sdk', '@mastra/core', '@mastra/e2b', '@mastra/factory',
  '@mastra/hono', '@mastra/libsql', '@mastra/pg', '@mastra/platform-workspace',
  '@mastra/redis-streams', 'mastra',
];
const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');
const roots = [];
after(async () => { await Promise.all(roots.map(r => rm(r, { recursive: true, force: true }))); });

async function source() {
  const parent = await mkdtemp(path.join(tmpdir(), 'immutable-2-source-'));
  roots.push(parent);
  const sourceRoot = path.join(parent, 'source');
  await mkdir(path.join(sourceRoot, 'mastracode/web'), { recursive: true });
  const sourceLock = {
    lockfileVersion: '9.0',
    importers: { '.': { dependencies: {} } },
    packages: { 'posthog-node@5.57.1': { resolution: { integrity: 'sha512-' + sha512('posthog') } } },
    snapshots: { 'posthog-node@5.57.1': { dependencies: {} } },
  };
  await writeFile(path.join(sourceRoot, 'pnpm-lock.yaml'), JSON.stringify(sourceLock));
  await writeFile(path.join(sourceRoot, 'mastracode/web/package.json'),
    JSON.stringify({ dependencies: Object.fromEntries(names.map(n => [n, 'link:../../fake/' + n])) }));
  await writeFile(path.join(sourceRoot, '.gitignore'), 'mastracode/web/.mastra/\n');
  execFileSync('git', ['init', '-q', sourceRoot]);
  execFileSync('git', ['-C', sourceRoot, 'add', '.']);
  execFileSync('git', ['-C', sourceRoot, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'accepted fixture']);
  const head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { sourceRoot, parent, head, sourceLock };
}

async function candidate({ original, clone = false }) {
  let sourceRoot;
  let parent;
  if (!clone) {
    ({ sourceRoot, parent } = original);
  } else {
    parent = await mkdtemp(path.join(tmpdir(), 'immutable-2-clone-'));
    roots.push(parent);
    sourceRoot = path.join(parent, 'source');
    execFileSync('git', ['clone', '--quiet', '--no-local', original.sourceRoot, sourceRoot]);
  }
  const runtimeRoot = path.join(parent, 'runtime');
  const outputRoot = path.join(sourceRoot, 'mastracode/web/.mastra/output');
  await Promise.all([
    mkdir(path.join(runtimeRoot, 'artifacts'), { recursive: true }),
    mkdir(path.join(outputRoot, 'workspace-module'), { recursive: true }),
  ]);
  const external = original.sourceLock.packages['posthog-node@5.57.1'];
  const snapshot = original.sourceLock.snapshots['posthog-node@5.57.1'];
  async function writeCandidate(target, section, locals) {
    const dependencies = Object.fromEntries(locals.map(name => [
      name, 'file:./' + section + '/' + name.replace(/[^a-z0-9]+/gi, '-') + '.tgz',
    ]));
    const importer = {};
    const packages = { 'posthog-node@5.57.1': external };
    for (const name of locals) {
      const spec = dependencies[name];
      const fileName = spec.split('/').at(-1);
      const bytes = Buffer.from('same-source-tar-' + name);
      await writeFile(path.join(target, section, fileName), bytes);
      importer[name] = { specifier: spec, version: 'file:' + section + '/' + fileName };
      packages[name + '@file:' + section + '/' + fileName] =
        { resolution: { integrity: 'sha512-' + sha512(bytes) } };
    }
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ dependencies }));
    await writeFile(path.join(target, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: importer } },
      packages, snapshots: { 'posthog-node@5.57.1': snapshot },
    }));
  }
  await writeCandidate(runtimeRoot, 'artifacts', names);
  await writeCandidate(outputRoot, 'workspace-module', names.filter(n => n !== 'mastra'));
  return { sourceRoot, runtimeRoot, outputRoot };
}

async function two() {
  const initial = await source();
  const first = await candidate({ original: initial });
  const second = await candidate({ original: initial, clone: true });
  return { expectedHead: initial.head, first, second };
}

test('positive: two independently cloned exact-head local tar/output/lock closures match', async () => {
  const value = await two();
  const result = await verifyTwoBuilds(value);
  assert.equal(result.candidateOnly, true);
  assert.equal(result.reproducible, true);
  assert.equal(result.proof.sourceHead, value.expectedHead);
  assert.equal(Object.keys(result.proof.tarPins).length, 13);
});

test('reject registry substitution of even one non-Factory first-party package', async () => {
  const value = await two();
  const manifestPath = path.join(value.second.runtimeRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['@mastra/core'] = '^1.0.0';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyTwoBuilds(value), /registry\/workspace fallback: @mastra\/core/);
});

test('reject output first-party omissions and external source lock drift', async () => {
  const value = await two();
  const manifestPath = path.join(value.first.outputRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.dependencies['@mastra/client-js'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyTwoBuilds(value), /registry\/workspace fallback: @mastra\/client-js/);
  const fresh = await two();
  const lockPath = path.join(fresh.second.runtimeRoot, 'pnpm-lock.yaml');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.snapshots['posthog-node@5.57.1'].dependencies.untrusted = '1.2.3';
  await writeFile(lockPath, JSON.stringify(lock));
  await assert.rejects(verifyTwoBuilds(fresh), /third-party source snapshot drift/);
});

test('reject missing exact output lock, source mismatch and reused candidate', async () => {
  const value = await two();
  await assert.rejects(verifyTwoBuilds({ ...value, second: value.first }),
    /candidate roots must be distinct/);
  await assert.rejects(verifyTwoBuilds({ ...value, expectedHead: 'a'.repeat(40) }),
    /unapproved source HEAD/);
  const lockPath = path.join(value.second.outputRoot, 'pnpm-lock.yaml');
  await rm(lockPath);
  await assert.rejects(verifyTwoBuilds(value), /ENOENT/);
});

test('reject symlinked output tar even when bytes equal', async () => {
  const value = await two();
  const file = path.join(value.first.outputRoot, 'workspace-module', '-mastra-core.tgz');
  const bytes = await readFile(file);
  await rm(file);
  await writeFile(file + '.copy', bytes);
  await symlink(file + '.copy', file);
  await assert.rejects(inspectCandidate({
    ...value.first, expectedHead: value.expectedHead, label: 'symlink',
  }), /symlink or escaped file/);
});
