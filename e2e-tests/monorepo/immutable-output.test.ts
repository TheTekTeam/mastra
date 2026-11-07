import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getApprovedImmutableRelease,
  hashImmutableOutputTree,
  verifyImmutableBuildInputs,
  type ApprovedImmutableRelease,
  type ImmutableTarPin,
} from '../../packages/deployer/src/services/immutable-release.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(dir => rm(dir, { force: true, recursive: true })));
});

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64');

function tarball(member = 'package/package.json'): Buffer {
  const content = Buffer.from('{"name":"fixture","version":"1.0.0"}\n');
  const header = Buffer.alloc(512);
  header.write(member, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-immutable-monorepo-'));
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const projectRoot = join(sourceRoot, 'mastracode', 'web');
  const runtimeRoot = join(root, 'runtime');
  const outputRoot = join(projectRoot, '.mastra', 'output');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(join(runtimeRoot, 'artifacts'), { recursive: true }),
    mkdir(join(outputRoot, 'workspace-module'), { recursive: true }),
  ]);
  const sourceLock = Buffer.from('lockfileVersion: 9.0\n');
  await writeFile(join(sourceRoot, 'pnpm-lock.yaml'), sourceLock);
  execFileSync('git', ['init', '-q', sourceRoot]);
  execFileSync('git', ['-C', sourceRoot, 'add', 'pnpm-lock.yaml']);
  execFileSync('git', ['-C', sourceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '-m', 'immutable test fixture']);
  const sourceHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const pins = {
    '@mastra/factory': { fileName: 'factory.tgz', sha256: '', sha512: '' },
    '@mastra/pg': { fileName: 'pg.tgz', sha256: '', sha512: '' },
    mastra: { fileName: 'cli.tgz', sha256: '', sha512: '' },
  } satisfies Record<string, ImmutableTarPin>;

  for (const pin of Object.values(pins)) {
    const bytes = tarball();
    pin.sha256 = sha256(bytes);
    pin.sha512 = sha512(bytes);
    await writeFile(join(runtimeRoot, 'artifacts', pin.fileName), bytes);
    if (pin !== pins.mastra) await writeFile(join(outputRoot, 'workspace-module', pin.fileName), bytes);
  }

  async function writeRoot(target: string, section: 'artifacts' | 'workspace-module') {
    const names = section === 'artifacts'
      ? ['@mastra/factory', '@mastra/pg', 'mastra'] as const
      : ['@mastra/factory', '@mastra/pg'] as const;
    const dependencies: Record<string, string> = {};
    const importer: Record<string, { specifier: string; version: string }> = {};
    const packages: Record<string, { resolution: { integrity: string } }> = {};
    for (const name of names) {
      const pin = pins[name];
      const specifier = `file:./${section}/${pin.fileName}`;
      dependencies[name] = specifier;
      importer[name] = { specifier, version: `file:${section}/${pin.fileName}` };
      packages[`${name}@file:${section}/${pin.fileName}`] = {
        resolution: { integrity: `sha512-${pin.sha512}` },
      };
    }
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'test-root', dependencies }));
    await writeFile(join(target, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: importer } },
      packages,
    }));
  }

  await writeRoot(runtimeRoot, 'artifacts');
  await writeRoot(outputRoot, 'workspace-module');
  const approved: ApprovedImmutableRelease = {
    sourceHead,
    sourceRoot,
    projectRoot,
    runtimeRoot,
    outputRoot,
    outputLockRelativePath: 'mastracode/web/.mastra/output/pnpm-lock.yaml',
    sourceLockSha256: sha256(sourceLock),
    runtimeLockSha256: sha256(await readFile(join(runtimeRoot, 'pnpm-lock.yaml'))),
    outputLockSha256: sha256(await readFile(join(outputRoot, 'pnpm-lock.yaml'))),
    runtimeManifestSha256: sha256(await readFile(join(runtimeRoot, 'package.json'))),
    outputManifestSha256: sha256(await readFile(join(outputRoot, 'package.json'))),
    outputTreeSha256: await hashImmutableOutputTree(outputRoot),
    pins,
  };
  const verify = () => verifyImmutableBuildInputs({ approved, sourceRoot, runtimeRoot, outputRoot });
  return { approved, verify, sourceRoot, projectRoot, runtimeRoot, outputRoot };
}

describe('opt-in immutable Factory output provenance (no registry/network)', () => {
  it('verifies exact accepted source HEAD, both locks, local source-built tar pins and member paths', async () => {
    const f = await fixture();
    await expect(f.verify()).resolves.toBeUndefined();
  });

  it('fails closed when an output lock is changed without independent approval', async () => {
    const f = await fixture();
    await writeFile(join(f.outputRoot, 'pnpm-lock.yaml'), '{}');
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_DIGEST_MISMATCH');
  });

  it('fails closed on tampered local Factory tar even if local npm cache would resolve another copy', async () => {
    const f = await fixture();
    await writeFile(join(f.runtimeRoot, 'artifacts', 'factory.tgz'), tarball('package/another.json'));
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_DIGEST_MISMATCH');
  });

  it('fails closed on registry fallback even when a caller recomputes its own lock checksum', async () => {
    const f = await fixture();
    const manifest = JSON.parse(await readFile(join(f.runtimeRoot, 'package.json'), 'utf8'));
    manifest.dependencies['@mastra/pg'] = '^1.33.0';
    await writeFile(join(f.runtimeRoot, 'package.json'), JSON.stringify(manifest));
    // Even self-updating the claimed manifest digest cannot bypass the importer shape check.
    f.approved.runtimeManifestSha256 = sha256(await readFile(join(f.runtimeRoot, 'package.json')));
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_LOCK_IMPORTER_DRIFT');
  });

  it('emits a digest-only, explicitly non-authoritative candidate for independent review', async () => {
    const f = await fixture();
    const generator = fileURLToPath(new URL('../../packages/deployer/factory-immutable-candidate.mjs', import.meta.url));
    const text = execFileSync(process.execPath, [
      generator, 'review-me', f.approved.sourceRoot, f.approved.projectRoot,
      f.runtimeRoot, f.outputRoot,
    ], { encoding: 'utf8' });
    const result = JSON.parse(text);
    expect(result.candidateOnly).toBe(true);
    expect(result.releases['review-me'].sourceHead).toBe(f.approved.sourceHead);
    expect(result.releases['review-me'].pins).toEqual(f.approved.pins);
    expect(result.releases['review-me'].outputLockSha256).toBe(f.approved.outputLockSha256);
    expect(result.releases['review-me'].runtimeManifestSha256).toBe(f.approved.runtimeManifestSha256);
    expect(result.releases['review-me'].outputManifestSha256).toBe(f.approved.outputManifestSha256);
    expect(result.releases['review-me'].outputTreeSha256).toBe(f.approved.outputTreeSha256);
  });

  it('rejects untracked source injection even with an accepted Git HEAD', async () => {
    const f = await fixture();
    await mkdir(join(f.projectRoot, 'src', 'mastra'), { recursive: true });
    await writeFile(join(f.projectRoot, 'src', 'mastra', 'untracked.ts'), 'export const injected = true;');
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_SOURCE_NOT_ACCEPTED');
  });

  it('rejects ignored executable source outside the attested output tree', async () => {
    const f = await fixture();
    await mkdir(join(f.projectRoot, 'src', 'mastra'), { recursive: true });
    await writeFile(join(f.sourceRoot, '.gitignore'), 'mastracode/web/src/mastra/hidden.ts\n');
    execFileSync('git', ['-C', f.sourceRoot, 'add', '.gitignore']);
    execFileSync('git', ['-C', f.sourceRoot, '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'ignore fixture']);
    f.approved.sourceHead = execFileSync('git', ['-C', f.sourceRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }).trim();
    await writeFile(join(f.projectRoot, 'src', 'mastra', 'hidden.ts'), 'export const hidden = true;');
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_IGNORED_SOURCE_NOT_APPROVED');
  });

  it('rejects generated output symlinks even when the approved lock and tar digests match', async () => {
    const f = await fixture();
    await symlink(join(f.outputRoot, 'pnpm-lock.yaml'), join(f.outputRoot, 'injected.js'));
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_OUTPUT_SYMLINK_OR_SPECIAL');
  });

  it('rejects symlinked runtime roots despite lexically matching a caller-approved string', async () => {
    const f = await fixture();
    const alias = join(f.sourceRoot, 'runtime-alias');
    await symlink(f.runtimeRoot, alias);
    f.approved.runtimeRoot = alias;
    await expect(verifyImmutableBuildInputs({
      approved: f.approved, sourceRoot: f.sourceRoot,
      runtimeRoot: alias, outputRoot: f.outputRoot,
    })).rejects.toThrow('IMMUTABLE_ROOT_SYMLINK');
  });

  it('rejects a tampered runtime manifest even if its importer still looks plausible', async () => {
    const f = await fixture();
    const file = join(f.runtimeRoot, 'package.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.name = 'tampered';
    await writeFile(file, JSON.stringify(manifest));
    await expect(f.verify()).rejects.toThrow('IMMUTABLE_DIGEST_MISMATCH');
  });

  it('does not accept caller-supplied relative approval IDs, even without network', async () => {
    await expect(getApprovedImmutableRelease('../../self-approved')).rejects.toThrow('IMMUTABLE_RELEASE_ID_INVALID');
  });
});
