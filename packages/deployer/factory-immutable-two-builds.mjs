#!/usr/bin/env node
/**
 * Source-only immutable Factory candidate reproducibility preflight.
 * Compares TWO independently staged candidates. Never builds, installs,
 * rewrites locks, calls 'deploy', modifies services or approves a release.
 *
 * A successful preflight emits candidateOnly evidence for HP6; the immutable
 * release reader rejects that output until independent root-owned approval.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const EXPECTED_LOCAL = Object.freeze([
  '@mastra/auth-better-auth', '@mastra/auth-workos', '@mastra/client-js',
  '@mastra/code-sdk', '@mastra/core', '@mastra/e2b', '@mastra/factory',
  '@mastra/hono', '@mastra/libsql', '@mastra/pg',
  '@mastra/platform-workspace', '@mastra/redis-streams', 'mastra',
].sort());
const digest = (bytes, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const reject = message => { throw new Error('IMMUTABLE_TWO_BUILD_BLOCKED: ' + message); };
const ensure = (test, message) => { if (!test) reject(message); };
const depMap = obj => ({ ...obj.dependencies, ...obj.devDependencies, ...obj.optionalDependencies });
const safeName = name => /^[A-Za-z0-9._-]+\.tgz$/.test(name);

async function readSafe(root, relative) {
  ensure(relative && !path.isAbsolute(relative) && !relative.split('/').includes('..'), 'unsafe relative path');
  const target = path.join(root, relative);
  const actual = await realpath(target);
  ensure(actual === target && actual.startsWith(root + path.sep), 'symlink or escaped file: ' + relative);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    ensure(stat.isFile() && stat.nlink === 1, 'special or linked file: ' + relative);
    return handle.readFile();
  } finally { await handle.close(); }
}

async function parseLock(root, relative) {
  const bytes = await readSafe(root, relative);
  const doc = parseDocument(bytes.toString('utf8'), { uniqueKeys: true });
  ensure(doc.errors.length === 0, 'invalid or duplicate lock YAML: ' + relative);
  const lock = doc.toJS({ maxAliasCount: 0 });
  ensure(lock && typeof lock === 'object' && !Array.isArray(lock) &&
    lock.importers?.['.'] && lock.packages && typeof lock.packages === 'object',
    'incomplete lock: ' + relative);
  return { bytes, lock };
}

async function canonicalDir(directory) {
  ensure(path.isAbsolute(directory) && path.resolve(directory) === directory, 'noncanonical path: ' + directory);
  ensure((await realpath(directory)) === directory && (await lstat(directory)).isDirectory(),
    'symlink or non-directory: ' + directory);
  return directory;
}

function sourceLinkNames(manifest) {
  const linked = Object.entries(depMap(manifest))
    .filter(([, version]) => typeof version === 'string' && version.startsWith('link:'))
    .map(([name]) => name).sort();
  ensure(JSON.stringify(linked) === JSON.stringify(EXPECTED_LOCAL),
    'accepted web first-party set changed (must pin exactly 13 links)');
  return linked;
}

function assertLockIntegrity(sourceLock, candidateLock, localNames, rootKind, name) {
  const original = sourceLock.packages;
  const firstparty = new Set(localNames);
  for (const [key, pkg] of Object.entries(candidateLock.packages)) {
    const resolution = pkg?.resolution;
    ensure(typeof resolution?.integrity === 'string' &&
      /^sha512-[A-Za-z0-9+/]+=*$/.test(resolution.integrity),
      name + ' package resolution integrity missing: ' + key);
    // Local first-party file tar entries are checked separately below.
    const locallyPinned = [...firstparty].some(n => key.startsWith(n + '@file:'));
    if (locallyPinned) continue;
    ensure(Object.hasOwn(original, key), name + ' external package not in accepted source: ' + key);
    ensure(JSON.stringify(original[key]) === JSON.stringify(pkg),
      name + ' third-party source integrity/metadata drift: ' + key);
  }
  ensure(rootKind === 'runtime' || rootKind === 'output', 'bad root kind');
  for (const [key, snapshot] of Object.entries(candidateLock.snapshots ?? {})) {
    const locallyPinned = [...firstparty].some(n => key.startsWith(n + '@file:'));
    if (locallyPinned) continue;
    ensure(Object.hasOwn(sourceLock.snapshots ?? {}, key),
      name + ' external snapshot not in accepted source: ' + key);
    ensure(JSON.stringify(sourceLock.snapshots[key]) === JSON.stringify(snapshot),
      name + ' third-party source snapshot drift: ' + key);
  }
}

function checkLocalImporter({ manifest, lock, name, section, required }) {
  const declared = depMap(manifest);
  const importer = lock.importers['.'];
  const imports = depMap(importer);
  for (const local of required) {
    const spec = declared[local];
    const match = typeof spec === 'string'
      ? /^file:\.\/(?:artifacts|workspace-module)\/([A-Za-z0-9._-]+\.tgz)$/.exec(spec)
      : null;
    ensure(match && spec.startsWith('file:./' + section + '/'),
      name + ' registry/workspace fallback: ' + local);
    ensure(imports[local]?.specifier === spec &&
      imports[local]?.version === 'file:' + section + '/' + match[1],
      name + ' wrong lock importer: ' + local);
  }
  if (section === 'workspace-module') ensure(!Object.hasOwn(declared, 'mastra'), name + ' CLI in output');
}

async function treeHash(root) {
  const state = createHash('sha256');
  let count = 0;
  async function visit(rel) {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (child === 'node_modules') continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const bytes = await readSafe(root, child);
        ensure(++count <= 20000, 'too many output files');
        state.update(JSON.stringify([child, digest(bytes)]) + '\n');
      } else reject('output contains symlink/special: ' + child);
    }
  }
  await visit('');
  ensure(count > 0, 'empty output');
  return state.digest('hex');
}

/** Read-only proof for one candidate; does not manufacture missing locks/tars. */
export async function inspectCandidate({ sourceRoot, runtimeRoot, expectedHead, label }) {
  await canonicalDir(sourceRoot);
  await canonicalDir(runtimeRoot);
  const outputRoot = path.join(sourceRoot, 'mastracode/web/.mastra/output');
  await canonicalDir(outputRoot);
  ensure((await readSafe(sourceRoot, 'pnpm-lock.yaml')).length > 0, label + ' source lock missing');
  const head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  ensure(head === expectedHead && /^[a-f0-9]{40}$/.test(head), label + ' unapproved source HEAD');
  const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all',
    '--', '.', ':(exclude)mastracode/web/.mastra/output'], { encoding: 'utf8' }).trim();
  ensure(!dirty, label + ' dirty accepted source');
  const sourceLock = await parseLock(sourceRoot, 'pnpm-lock.yaml');
  const sourceWebManifest = JSON.parse((await readSafe(sourceRoot, 'mastracode/web/package.json')).toString());
  const localNames = sourceLinkNames(sourceWebManifest);
  const rtManifestBytes = await readSafe(runtimeRoot, 'package.json');
  const outManifestBytes = await readSafe(outputRoot, 'package.json');
  const rtManifest = JSON.parse(rtManifestBytes.toString());
  const outManifest = JSON.parse(outManifestBytes.toString());
  const rtLock = await parseLock(runtimeRoot, 'pnpm-lock.yaml');
  const outLock = await parseLock(outputRoot, 'pnpm-lock.yaml');
  const roots = [
    { root: runtimeRoot, manifest: rtManifest, lock: rtLock.lock, section: 'artifacts', required: localNames, label: 'runtime' },
    { root: outputRoot, manifest: outManifest, lock: outLock.lock, section: 'workspace-module',
      required: localNames.filter(n => n !== 'mastra'), label: 'output' },
  ];
  const tarPins = {};
  for (const item of roots) {
    checkLocalImporter({ ...item, name: label + '/' + item.label });
    assertLockIntegrity(sourceLock.lock, item.lock, localNames, item.label, label + '/' + item.label);
    for (const dep of item.required) {
      const spec = depMap(item.manifest)[dep];
      const fileName = spec.slice(('file:./' + item.section + '/').length);
      ensure(safeName(fileName), label + ' bad tar name: ' + dep);
      const bytes = await readSafe(item.root, item.section + '/' + fileName);
      const sha = digest(bytes);
      const sha512 = digest(bytes, 'sha512');
      const key = dep + '@file:' + item.section + '/' + fileName;
      ensure(item.lock.packages[key]?.resolution?.integrity === 'sha512-' + sha512,
        label + ' tar lock integrity mismatch: ' + dep);
      if (tarPins[dep]) ensure(tarPins[dep].sha256 === sha, label + ' dual-root tar mismatch: ' + dep);
      else tarPins[dep] = { fileName, sha256: sha, sha512 };
    }
  }
  return {
    sourceHead: head, sourceLockSha256: digest(sourceLock.bytes),
    runtimeLockSha256: digest(rtLock.bytes), outputLockSha256: digest(outLock.bytes),
    runtimeManifestSha256: digest(rtManifestBytes), outputManifestSha256: digest(outManifestBytes),
    outputTreeSha256: await treeHash(outputRoot), tarPins,
  };
}

/** Prove BOTH independent candidate builds reproduce exactly; otherwise deny. */
export async function verifyTwoBuilds({ expectedHead, first, second }) {
  ensure(/^[a-f0-9]{40}$/.test(expectedHead), 'expected HEAD must be a reviewed full SHA');
  ensure(first.sourceRoot !== second.sourceRoot && first.runtimeRoot !== second.runtimeRoot,
    'candidate roots must be distinct');
  const a = await inspectCandidate({ ...first, expectedHead, label: 'first' });
  const b = await inspectCandidate({ ...second, expectedHead, label: 'second' });
  ensure(JSON.stringify(a) === JSON.stringify(b), 'independent candidate lock/tar/output mismatch');
  return { candidateOnly: true, sourceHead: expectedHead, reproducible: true,
    independent: [first.sourceRoot, second.sourceRoot], proof: a };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== 'verify-two') {
    process.stderr.write('usage: node factory-immutable-two-builds.mjs verify-two EXPECTED_HEAD SOURCE_A RUNTIME_A SOURCE_B RUNTIME_B\n');
    process.exitCode = 2;
  } else {
    try {
      const [, expectedHead, sourceA, runtimeA, sourceB, runtimeB] = args;
      const proof = await verifyTwoBuilds({
        expectedHead,
        first: { sourceRoot: sourceA, runtimeRoot: runtimeA },
        second: { sourceRoot: sourceB, runtimeRoot: runtimeB },
      });
      process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
    } catch (error) {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    }
  }
}
