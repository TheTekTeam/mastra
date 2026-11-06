#!/usr/bin/env node
// Trusted CI *disposable generated-output* staging of an exact source-built
// Factory tar. Never touch a live release or a shared store; no pnpm re-resolution.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(web, '../..');
const output = path.join(web, '.mastra/output');
const [tarballArg, expectedHead] = process.argv.slice(2);
assert(tarballArg && /^[0-9a-f]{40}$/.test(expectedHead || ''),
  'usage: stage-source-factory-for-ci TARBALL EXACT_HEAD');
const tarball = fs.realpathSync(tarballArg);
const expectedRepo = process.env.GITHUB_WORKSPACE;
if (process.env.GITHUB_ACTIONS === 'true') {
  assert(expectedRepo && fs.realpathSync(expectedRepo) === fs.realpathSync(repo),
    'CI repository root identity mismatch');
} else {
  assert(process.env.FACTORY_QA_LOCAL === '1' &&
    repo.includes('/.worktrees/') &&
    !repo.includes('/opt/modelspend-cluster/mastra-factory/releases/'),
  'source package staging allowed only in disposable CI or explicit isolated QA');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
assert.equal(head, expectedHead, 'source head drifted');
assert(fs.realpathSync(output).startsWith(fs.realpathSync(web) + path.sep),
  'output escapes source workspace');
const marker = path.join(output, '.factory-ci-source-pin.json');
assert(!fs.existsSync(marker), 'prior CI pin proof exists; refusing replay');
const rootPackage = fs.realpathSync(path.join(web, 'node_modules/@mastra/factory'));
assert.equal(rootPackage, fs.realpathSync(path.join(repo, 'mastracode/factory')),
  'runtime source Factory link is not exact local checkout');
const outputLink = path.join(output, 'node_modules/@mastra/factory');
const installed = fs.realpathSync(outputLink);
assert(installed.startsWith(fs.realpathSync(path.join(output, 'node_modules/.pnpm')) + path.sep),
  'generated package destination is not disposable output virtual store');
assert(fs.lstatSync(outputLink).isSymbolicLink() &&
  fs.statSync(installed).isDirectory(), 'generated package link/dir unexpected');
assert.equal(fs.statSync(installed).uid, process.getuid(),
  'generated package is not owned by QA runner');

const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const hash = file => sha(fs.readFileSync(file));
const tarSha256 = hash(tarball);
const extractJson = entry => JSON.parse(execFileSync('tar', ['-xOf', tarball, entry], {
  encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
}));
const packed = extractJson('package/package.json');
const original = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(repo, 'mastracode/factory/package.json'), 'utf8'));
assert.equal(source.name, '@mastra/factory');
assert.equal(source.version, '0.25.0');
assert.equal(packed.name, source.name);
assert.equal(packed.version, source.version);
assert.equal(original.name, packed.name);
assert.equal(original.version, packed.version);
for (const kind of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  assert.deepEqual(packed[kind] ?? {}, original[kind] ?? {},
    'packed Factory changes generated dependency graph: ' + kind);
}
assert(!Object.values(packed.dependencies ?? {}).some(
  value => typeof value === 'string' && value.startsWith('workspace:')),
'packed Factory unresolved workspace spec');

const outputManifestSha = hash(path.join(output, 'package.json'));
const outputLockSha = hash(path.join(output, 'pnpm-lock.yaml'));
const rootManifestSha = hash(path.join(web, 'package.json'));
const rootLockSha = hash(path.join(web, 'pnpm-lock.yaml'));
const nonce = crypto.randomBytes(6).toString('hex');
const stage = path.join(path.dirname(installed), '.factory-ci-stage-' + nonce);
const backup = path.join(path.dirname(installed), '.factory-ci-original-' + nonce);
assert(!fs.existsSync(stage) && !fs.existsSync(backup), 'CI stage path collision');
fs.mkdirSync(stage, { mode: 0o700 });
let movedOriginal = false;
let movedNew = false;
try {
  const listing = execFileSync('tar', ['-tzf', tarball], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n').filter(Boolean);
  assert(listing.length > 0 &&
    listing.every(entry => entry === 'package/' ||
      (entry.startsWith('package/') && !entry.includes('..') && !entry.startsWith('/'))),
  'source tar contains unsafe paths');
  execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', stage], {
    timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const staged = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  assert.equal(staged.name, packed.name);
  assert.equal(staged.version, packed.version);
  for (const kind of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.deepEqual(staged[kind] ?? {}, packed[kind] ?? {});
  }

  let compared = 0;
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const part = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), part);
      else {
        assert(entry.isFile(), 'source tar contains unsupported dist entry');
        const compiled = path.join(repo, 'mastracode/factory/dist', part);
        assert.equal(hash(path.join(directory, entry.name)), hash(compiled),
          'packed native file differs from compiled exact source: ' + part);
        compared++;
      }
    }
  };
  walk(path.join(stage, 'dist'));
  assert(compared > 100, 'source tar compiled file coverage too small');
  for (const rel of ['routes/automation-runs.js', 'storage/domains/projects/base.js']) {
    const buffer = fs.readFileSync(path.join(stage, 'dist', rel), 'utf8');
    assert(buffer.includes(rel.startsWith('routes/') ? 'getEnqueueReceipt' : 'automationRevision'),
      'required native receipt/CAS source symbol absent: ' + rel);
  }

  fs.renameSync(installed, backup);
  movedOriginal = true;
  fs.renameSync(stage, installed);
  movedNew = true;
  assert.equal(fs.realpathSync(outputLink), installed);
  for (const rel of ['routes/automation-runs.js', 'storage/domains/projects/base.js']) {
    const compiled = path.join(repo, 'mastracode/factory/dist', rel);
    assert.equal(hash(path.join(installed, 'dist', rel)), hash(compiled));
    assert.equal(hash(path.join(rootPackage, 'dist', rel)), hash(compiled));
  }
  assert.equal(hash(path.join(output, 'package.json')), outputManifestSha);
  assert.equal(hash(path.join(output, 'pnpm-lock.yaml')), outputLockSha);
  assert.equal(hash(path.join(web, 'package.json')), rootManifestSha);
  assert.equal(hash(path.join(web, 'pnpm-lock.yaml')), rootLockSha);
  const evidence = {
    schema: 1, purpose: 'disposable-ci-source-factory-pin-only',
    head, tarball, tarSha256, outputLockSha256: outputLockSha,
    rootLockSha256: rootLockSha, rootPackage, generatedPackage: installed,
    compiledFileCount: compared, dependencyMapsEqual: true,
  };
  fs.writeFileSync(marker, JSON.stringify(evidence) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({
    result: 'CI_SOURCE_FACTORY_PIN_PASS', head, tarSha256,
    compiledFilesByteEqual: compared, bothNativeRootsByteEqual: true,
    dependencyMapsEqual: true, existingLockfilesUnchanged: true,
  }));
} catch (error) {
  // Transactional recovery within the disposable generated output only.
  if (movedOriginal) {
    if (movedNew) fs.renameSync(installed, path.join(path.dirname(installed), '.factory-ci-failed-' + nonce));
    fs.renameSync(backup, installed);
  }
  if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: false });
  throw error;
}
