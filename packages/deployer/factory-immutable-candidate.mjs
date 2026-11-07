#!/usr/bin/env node
// READ ONLY. Print untrusted candidate evidence; never install, build, deploy or approve.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
const digest = (bytes, alg) => createHash(alg).update(bytes).digest(alg === 'sha512' ? 'base64' : 'hex');
function assert(ok, reason) { if (!ok) throw new Error('IMMUTABLE_CANDIDATE_INVALID: ' + reason); }
async function outputTreeDigest(root) {
  assert(await realpath(root) === root && (await lstat(root)).isDirectory(), 'output root symlink');
  const state = createHash('sha256');
  let count = 0, total = 0;
  async function walk(dir) {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = dir ? dir + '/' + entry.name : entry.name;
      if (relative === 'node_modules') continue;
      if (entry.isDirectory()) {
        await walk(relative);
      } else if (entry.isFile()) {
        const handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          assert(info.isFile() && info.nlink === 1, 'output hardlink/special file');
          const bytes = await handle.readFile();
          assert(++count <= 20000 && (total += bytes.length) <= 512 * 1024 * 1024, 'output too large');
          state.update(JSON.stringify([relative, digest(bytes, 'sha256')]) + '\n');
        } finally { await handle.close(); }
      } else {
        assert(false, 'output symlink/special file');
      }
    }
  }
  await walk('');
  assert(count > 0, 'empty output');
  return state.digest('hex');
}
async function main(releaseId, sourceRoot, projectRoot, runtimeRoot, outputRoot) {
  assert(/^[a-zA-Z0-9._-]{1,100}$/.test(releaseId), 'release ID');
  for (const p of [sourceRoot, projectRoot, runtimeRoot, outputRoot]) {
    assert(path.isAbsolute(p) && path.resolve(p) === p, 'non-canonical path');
  }
  assert(projectRoot.startsWith(sourceRoot + path.sep), 'project outside source');
  for (const p of [sourceRoot, projectRoot, runtimeRoot, outputRoot]) {
    assert(await realpath(p) === p && (await lstat(p)).isDirectory(), 'symlinked root');
  }
  const outputRelativeRoot = path.relative(sourceRoot, outputRoot);
  assert(outputRelativeRoot && !outputRelativeRoot.startsWith('..'), 'output root outside source');
  const sourceHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
  const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude)' + outputRelativeRoot], {encoding:'utf8'}).trim();
  assert(/^[0-9a-f]{40}$/.test(sourceHead) && !dirty, 'uncommitted source');
  const runtime = JSON.parse(await readFile(path.join(runtimeRoot, 'package.json'), 'utf8'));
  const output = JSON.parse(await readFile(path.join(outputRoot, 'package.json'), 'utf8'));
  const pins = {};
  for (const name of ['@mastra/factory', '@mastra/pg', 'mastra']) {
    const spec = runtime.dependencies?.[name] ?? '';
    const match = /^file:\.\/artifacts\/([a-zA-Z0-9._-]+\.tgz)$/.exec(spec);
    assert(match, name + ' lacks local source tar pin');
    const fileName = match[1];
    const bytes = await readFile(path.join(runtimeRoot, 'artifacts', fileName));
    pins[name] = {fileName, sha256:digest(bytes,'sha256'), sha512:digest(bytes,'sha512')};
    if (name !== 'mastra') {
      assert(output.dependencies?.[name] === 'file:./workspace-module/' + fileName, name + ' output spec drift');
      const outputBytes = await readFile(path.join(outputRoot, 'workspace-module', fileName));
      assert(digest(outputBytes, 'sha256') === pins[name].sha256, name + ' output tar drift');
    }
  }
  assert(!output.dependencies?.mastra, 'unapproved CLI output dependency');
  const relative = path.relative(sourceRoot, path.join(outputRoot, 'pnpm-lock.yaml'));
  assert(!relative.startsWith('..') && /(?:^|\/)\.mastra\/output\/pnpm-lock\.yaml$/.test(relative), 'output outside source');
  const sourceLock = await readFile(path.join(sourceRoot,'pnpm-lock.yaml'));
  const runtimeLock = await readFile(path.join(runtimeRoot,'pnpm-lock.yaml'));
  const outputLock = await readFile(path.join(outputRoot,'pnpm-lock.yaml'));
  return {
    candidateOnly: true, // Poison pill: trusted reader rejects unreviewed generator output.
    schemaVersion: 1,
    releases: {[releaseId]: {
      sourceHead, sourceRoot, projectRoot, runtimeRoot, outputRoot, outputLockRelativePath:relative,
      sourceLockSha256:digest(sourceLock,'sha256'),
      runtimeLockSha256:digest(runtimeLock,'sha256'),
      outputLockSha256:digest(outputLock,'sha256'),
      runtimeManifestSha256:digest(await readFile(path.join(runtimeRoot,'package.json')),'sha256'),
      outputManifestSha256:digest(await readFile(path.join(outputRoot,'package.json')),'sha256'),
      outputTreeSha256:await outputTreeDigest(outputRoot),
      pins,
    }},
  };
}
const args = process.argv.slice(2);
if (args.length !== 5) {
  process.stderr.write('usage: node factory-immutable-candidate.mjs RELEASE_ID SOURCE_ROOT PROJECT_ROOT RUNTIME_ROOT OUTPUT_ROOT\n');
  process.exitCode = 2;
} else {
  try { process.stdout.write(JSON.stringify(await main(...args),null,2)+'\n'); }
  catch(e){ process.stderr.write(String(e)+'\n'); process.exitCode = 1; }
}
