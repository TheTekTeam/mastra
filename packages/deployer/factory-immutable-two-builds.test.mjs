import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { inspectCandidate, verifyTwoBuilds } from './factory-immutable-two-builds.mjs';

const names = [
  '@mastra/auth-better-auth', '@mastra/auth-workos', '@mastra/client-js',
  '@mastra/code-sdk', '@mastra/core', '@mastra/e2b', '@mastra/factory',
  '@mastra/hono', '@mastra/libsql', '@mastra/pg', '@mastra/platform-workspace',
  '@mastra/redis-streams', 'mastra',
];
const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');
const extras = [
  '@mastra/auth', '@mastra/agent-browser', '@mastra/schema-compat',
  '@mastra/duckdb', '@mastra/fastembed', '@mastra/github-signals',
  '@mastra/mcp', '@mastra/memory', '@mastra/observability',
  '@mastra/parallel', '@mastra/stagehand', '@mastra/tavily',
  '@mastra/auth-studio', '@mastra/slack', '@mastra/server',
  '@mastra/deployer', '@mastra/loggers',
];
const all = [...names, ...extras];
const fileName = name => name.replace(/[^a-z0-9]+/gi, '-') + '.tgz';
const sourceDeps = name => name === '@mastra/code-sdk'
  ? Object.fromEntries(extras.slice(0, -2).map(dep => [dep, 'workspace:*']))
  : name === 'mastra' ? {
    '@mastra/deployer': 'workspace:^', '@mastra/loggers': 'workspace:^',
  } : {};
function packedTar(name, section, overrides = {}) {
  const dependencies = {
    ...Object.fromEntries(Object.keys(sourceDeps(name)).map(dep =>
      [dep, 'file:./' + section + '/' + fileName(dep)])),
    ...overrides,
  };
  const contents = Buffer.from(JSON.stringify({ name, version: '1.0.0', dependencies }));
  const header = Buffer.alloc(512, 0);
  const write = (s, at, len) => header.write(s, at, Math.min(s.length, len), 'utf8');
  const oct = (v, width) => v.toString(8).padStart(width - 1, '0') + '\0';
  write('package/package.json', 0, 100);
  write(oct(420, 8), 100, 8); write(oct(0, 8), 108, 8); write(oct(0, 8), 116, 8);
  write(oct(contents.length, 12), 124, 12); write(oct(0, 12), 136, 12);
  header.fill(32, 148, 156); write('0', 156, 1); write('ustar\0', 257, 6);
  const sum = header.reduce((a, b) => a + b, 0);
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - contents.length % 512) % 512, 0);
  return gzipSync(Buffer.concat([header, contents, pad, Buffer.alloc(1024)]), { level: 9 });
}

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
  for (const name of all) {
    const dir = path.join(sourceRoot, 'fake', name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name, version: '1.0.0', dependencies: sourceDeps(name),
    }));
  }
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
      const bytes = packedTar(name, section);
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
  await writeCandidate(runtimeRoot, 'artifacts', all);
  await writeCandidate(outputRoot, 'workspace-module', all.filter(n =>
    !['mastra', '@mastra/deployer', '@mastra/loggers'].includes(n)));
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
  assert.equal(Object.keys(result.proof.tarPins.runtime).length, 30);
  assert.equal(Object.keys(result.proof.tarPins.output).length, 27);
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

test('reject source-package tar that replaces a transitive first-party file pin with registry semver', async () => {
  const value = await two();
  const changed = packedTar('@mastra/code-sdk', 'artifacts', {
    '@mastra/agent-browser': '^1.0.0',
  });
  const archivePath = path.join(value.first.runtimeRoot, 'artifacts', fileName('@mastra/code-sdk'));
  await writeFile(archivePath, changed);
  const lockPath = path.join(value.first.runtimeRoot, 'pnpm-lock.yaml');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const key = '@mastra/code-sdk@file:artifacts/' + fileName('@mastra/code-sdk');
  lock.packages[key].resolution.integrity = 'sha512-' + sha512(changed);
  await writeFile(lockPath, JSON.stringify(lock));
  await assert.rejects(verifyTwoBuilds(value),
    /transitive first-party registry substitution: @mastra\/code-sdk -> @mastra\/agent-browser/);
});

test('reject missing transitive archive even when all 13 direct tar pins remain', async () => {
  const value = await two();
  await rm(path.join(value.first.outputRoot, 'workspace-module', fileName('@mastra/agent-browser')));
  await assert.rejects(verifyTwoBuilds(value), /ENOENT/);
});

test('reject first-party registry lock entry even when matching legitimate source package elsewhere', async () => {
  const value = await two();
  const lockPath = path.join(value.second.runtimeRoot, 'pnpm-lock.yaml');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages['@mastra/core@1.80.0'] = {
    resolution: { integrity: 'sha512-' + sha512('registry') },
  };
  await writeFile(lockPath, JSON.stringify(lock));
  await assert.rejects(verifyTwoBuilds(value), /first-party registry\/foreign tar fallback/);
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
