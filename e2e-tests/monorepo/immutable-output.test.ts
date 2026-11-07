import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getApprovedImmutableRelease,
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
    pins,
  };
  const verify = () => verifyImmutableBuildInputs({ approved, sourceRoot, runtimeRoot, outputRoot });
  return { approved, verify, runtimeRoot, outputRoot };
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
  });

  it('does not accept caller-supplied relative approval IDs, even without network', async () => {
    await expect(getApprovedImmutableRelease('../../self-approved')).rejects.toThrow('IMMUTABLE_RELEASE_ID_INVALID');
  });
});
