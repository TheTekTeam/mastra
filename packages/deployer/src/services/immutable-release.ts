/**
 * Verification for an explicitly approved, source-built Factory release.
 *
 * NOT a way for callers to approve themselves. The only production entrypoint
 * resolves an immutable reviewed approval from APPROVED_IMMUTABLE_RELEASES.
 * An empty registry is intentional until HP6 accepts a complete source,
 * output lock and tarball closure. Ordinary Mastra builds are unchanged.
 */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { parseDocument } from 'yaml';

export interface ImmutableTarPin {
  fileName: string;
  sha256: string;
  sha512: string;
}
export interface ApprovedImmutableRelease {
  sourceHead: string;
  sourceLockSha256: string;
  outputLockSha256: string;
  runtimeLockSha256: string;
  outputLockRelativePath: string;
  /** Reviewed absolute source and candidate roots. Never taken from the caller. */
  sourceRoot: string;
  projectRoot: string;
  runtimeRoot: string;
  outputRoot: string;
  pins: {
    '@mastra/factory': ImmutableTarPin;
    '@mastra/pg': ImmutableTarPin;
    mastra: ImmutableTarPin;
  };
}

/**
 * The operator must separately install the independently accepted approval here.
 * Build flags, environment JSON, candidate files and caller-provided hashes cannot
 * make a release trusted. The pinned location is not configurable through env/CLI.
 * This file is absent by default; ordinary Mastra builds are unchanged.
 */
const APPROVAL_PATH = '/etc/modelspend-cluster/factory-immutable-release-approval.json';

function assertTrustedApprovalShape(release: unknown): asserts release is ApprovedImmutableRelease {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('IMMUTABLE_APPROVAL_INVALID');
  }
  const r = release as Record<string, unknown>;
  for (const field of ['sourceRoot', 'projectRoot', 'runtimeRoot', 'outputRoot']) {
    if (typeof r[field] !== 'string' || !path.isAbsolute(r[field]) ||
        path.resolve(r[field] as string) !== r[field]) {
      throw new Error(`IMMUTABLE_APPROVAL_INVALID_PATH: ${field}`);
    }
  }
  for (const field of ['sourceHead', 'sourceLockSha256', 'runtimeLockSha256', 'outputLockSha256']) {
    const expected = field === 'sourceHead' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (typeof r[field] !== 'string' || !expected.test(r[field] as string)) {
      throw new Error(`IMMUTABLE_APPROVAL_INVALID_DIGEST: ${field}`);
    }
  }
  const outputRelative = r.outputLockRelativePath;
  if (typeof outputRelative !== 'string' ||
      outputRelative !== path.relative(r.sourceRoot as string, path.join(r.outputRoot as string, 'pnpm-lock.yaml')) ||
      !/(?:^|\/)\.mastra\/output\/pnpm-lock\.yaml$/.test(outputRelative)) {
    throw new Error('IMMUTABLE_APPROVAL_INVALID_OUTPUT_LOCK_PATH');
  }
  if (!r.pins || typeof r.pins !== 'object' || Array.isArray(r.pins)) {
    throw new Error('IMMUTABLE_APPROVAL_INVALID_PINS');
  }
  const pins = r.pins as Record<string, unknown>;
  if (Object.keys(pins).sort().join(',') !== '@mastra/factory,@mastra/pg,mastra') {
    throw new Error('IMMUTABLE_APPROVAL_INVALID_PACKAGE_SET');
  }
  for (const pin of Object.values(pins)) {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
      throw new Error('IMMUTABLE_APPROVAL_INVALID_PIN');
    }
    const p = pin as Record<string, unknown>;
    if (typeof p.fileName !== 'string' || !/^[a-zA-Z0-9._-]+\.tgz$/.test(p.fileName) ||
        typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) ||
        typeof p.sha512 !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(p.sha512)) {
      throw new Error('IMMUTABLE_APPROVAL_INVALID_PIN');
    }
  }
}

/**
 * Read only from the root-owned approval chain using no-follow open + inode
 * checks. A writable/symlink component cannot authorise a build.
 */
export async function getApprovedImmutableRelease(releaseId: string): Promise<ApprovedImmutableRelease> {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(releaseId)) {
    throw new Error('IMMUTABLE_RELEASE_ID_INVALID');
  }
  for (const segment of ['/', '/etc', '/etc/modelspend-cluster']) {
    const info = await lstat(segment);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error('IMMUTABLE_APPROVAL_UNTRUSTED_PARENT');
    }
  }
  const handle = await open(APPROVAL_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) !== 0) {
      throw new Error('IMMUTABLE_APPROVAL_UNTRUSTED_FILE');
    }
    const bytes = await handle.readFile();
    if (bytes.length > 64 * 1024) throw new Error('IMMUTABLE_APPROVAL_OVERSIZED');
    const decoded = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (decoded.candidateOnly !== undefined) throw new Error('IMMUTABLE_CANDIDATE_NOT_APPROVED');
    if (decoded.schemaVersion !== 1 || !decoded.releases ||
        typeof decoded.releases !== 'object' || Array.isArray(decoded.releases)) {
      throw new Error('IMMUTABLE_APPROVAL_INVALID');
    }
    const releases = decoded.releases as Record<string, unknown>;
    const release = Object.prototype.hasOwnProperty.call(releases, releaseId) ? releases[releaseId] : undefined;
    if (!release) throw new Error('IMMUTABLE_RELEASE_NOT_APPROVED');
    assertTrustedApprovalShape(release);
    return release;
  } finally {
    await handle.close();
  }
}

function hash(bytes: Buffer | string, algorithm: 'sha256' | 'sha512'): string {
  return createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

async function loadApprovedYaml(filePath: string): Promise<Record<string, any>> {
  const raw = await readFile(filePath);
  const doc = parseDocument(raw.toString('utf8'), { uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error('IMMUTABLE_LOCK_INVALID_YAML: duplicate or invalid lock content');
  const data = doc.toJS({ maxAliasCount: 0 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('IMMUTABLE_LOCK_INVALID: not a pnpm lockfile');
  }
  return data as Record<string, any>;
}

function assertDigest(actual: string, approved: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(approved) || actual !== approved) {
    throw new Error(`IMMUTABLE_DIGEST_MISMATCH: ${label}`);
  }
}

function normalizeDepMap(record: unknown): Record<string, { specifier?: unknown; version?: unknown }> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  return record as Record<string, { specifier?: unknown; version?: unknown }>;
}

function assertPinnedImporter(
  manifest: Record<string, any>,
  lock: Record<string, any>,
  packagePins: Record<string, ImmutableTarPin>,
  root: 'output' | 'runtime',
) {
  const importer = lock.importers?.['.'];
  if (!importer || typeof importer !== 'object') throw new Error('IMMUTABLE_LOCK_IMPORTER_MISSING');
  const selected: Record<string, string> = {};
  const locked: Record<string, { specifier?: unknown; version?: unknown }> = {};
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = manifest[section];
    if (declared && (typeof declared !== 'object' || Array.isArray(declared))) {
      throw new Error('IMMUTABLE_MANIFEST_INVALID_DEPENDENCIES');
    }
    for (const [name, spec] of Object.entries(declared ?? {})) {
      if (typeof spec !== 'string' || !spec || /^(?:workspace:|link:)/.test(spec) ||
          spec === 'latest' || spec === '*' || spec.includes('://')) {
        throw new Error(`IMMUTABLE_UNPINNED_DEPENDENCY: ${name}`);
      }
      if (selected[name] && selected[name] !== spec) throw new Error('IMMUTABLE_DUPLICATE_DEPENDENCY');
      selected[name] = spec;
    }
    for (const [name, entry] of Object.entries(normalizeDepMap(importer[section]))) {
      if (locked[name] && locked[name]?.specifier !== entry.specifier) {
        throw new Error('IMMUTABLE_LOCK_DUPLICATE_IMPORTER');
      }
      locked[name] = entry;
    }
  }

  if (Object.keys(selected).length !== Object.keys(locked).length) {
    throw new Error('IMMUTABLE_LOCK_IMPORTER_DRIFT');
  }
  for (const [name, spec] of Object.entries(selected)) {
    const row = locked[name];
    if (!row || row.specifier !== spec || typeof row.version !== 'string') {
      throw new Error(`IMMUTABLE_LOCK_IMPORTER_DRIFT: ${name}`);
    }
    if (/^(?:workspace:|link:)/.test(row.version)) {
      throw new Error(`IMMUTABLE_LOCK_UNPINNED_VERSION: ${name}`);
    }
  }

  if (root === 'output' && selected.mastra !== undefined) {
    throw new Error('IMMUTABLE_UNAPPROVED_OUTPUT_CLI');
  }
  for (const [name, pin] of Object.entries(packagePins)) {
    if (root === 'output' && name === 'mastra') continue;
    const subdir = root === 'output' ? 'workspace-module' : 'artifacts';
    const spec = `file:./${subdir}/${pin.fileName}`;
    const entry = locked[name];
    if (selected[name] !== spec || entry?.specifier !== spec ||
        entry?.version !== `file:${subdir}/${pin.fileName}`) {
      throw new Error(`IMMUTABLE_LOCAL_TAR_NOT_PINNED: ${name}`);
    }
  }

  for (const [key, record] of Object.entries(lock.packages ?? {})) {
    const resolution = (record as Record<string, any>)?.resolution;
    if (!resolution || typeof resolution.integrity !== 'string' ||
        !/^sha512-[A-Za-z0-9+/]+=*$/.test(resolution.integrity)) {
      throw new Error(`IMMUTABLE_LOCK_MISSING_INTEGRITY: ${key}`);
    }
  }
  return lock.packages as Record<string, any>;
}

/**
 * Independently inspect the archive member list, not just its filename/digest.
 * Ignore unsupported PAX/longlink formats rather than accidentally treating
 * them as ordinary files. A later reviewed build can intentionally broaden it.
 */
function assertSafeTarArchive(compressed: Buffer): void {
  const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  const seen = new Set<string>();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      terminated = true;
      if (!tar.subarray(offset).every(byte => byte === 0)) {
        throw new Error('IMMUTABLE_TAR_TRAILING_DATA');
      }
      break;
    }
    const part = header.subarray(0, 100).toString('utf8').split('\0', 1)[0] ?? '';
    const prefix = header.subarray(345, 500).toString('utf8').split('\0', 1)[0] ?? '';
    const member = prefix ? `${prefix}/${part}` : part;
    const normalized = path.posix.normalize(member);
    if (!member || member.includes('\\') || member.startsWith('/') || member.includes('\0') ||
        normalized === '.' || normalized === '..' || normalized.startsWith('../') ||
        normalized !== member.replace(/\/$/, '') ||
        !normalized.startsWith('package/')) {
      throw new Error('IMMUTABLE_TAR_PATH_UNSAFE');
    }
    if (seen.has(normalized)) throw new Error('IMMUTABLE_TAR_DUPLICATE_MEMBER');
    seen.add(normalized);
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) {
      throw new Error('IMMUTABLE_TAR_UNSUPPORTED_MEMBER_TYPE');
    }
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]*$/.test(sizeText)) throw new Error('IMMUTABLE_TAR_INVALID_SIZE');
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0 || (type === 53 && size !== 0)) {
      throw new Error('IMMUTABLE_TAR_INVALID_SIZE');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > tar.length) throw new Error('IMMUTABLE_TAR_TRUNCATED');
  }
  if (!terminated || seen.size === 0) throw new Error('IMMUTABLE_TAR_TRUNCATED');
}

async function localTarBytes(root: string, section: 'artifacts' | 'workspace-module', pin: ImmutableTarPin) {
  if (!/^[A-Za-z0-9._-]+\.tgz$/.test(pin.fileName)) throw new Error('IMMUTABLE_TAR_NAME_INVALID');
  const rootReal = await realpath(root);
  const tarPath = path.join(rootReal, section, pin.fileName);
  const fileReal = await realpath(tarPath);
  if (!fileReal.startsWith(rootReal + path.sep) ||
      fileReal !== tarPath || !(await lstat(tarPath)).isFile()) {
    throw new Error('IMMUTABLE_TAR_PATH_ESCAPE');
  }
  const bytes = await readFile(fileReal);
  assertDigest(hash(bytes, 'sha256'), pin.sha256, pin.fileName);
  if (hash(bytes, 'sha512') !== pin.sha512) {
    throw new Error(`IMMUTABLE_TAR_INTEGRITY_MISMATCH: ${pin.fileName}`);
  }
  assertSafeTarArchive(bytes);
  return bytes;
}

/** Read-only; never installs, rewrites manifests, or hydrates the registry. */
export async function verifyImmutableBuildInputs(input: {
  approved: ApprovedImmutableRelease;
  sourceRoot: string;
  runtimeRoot: string;
  outputRoot: string;
}): Promise<void> {
  const { approved, sourceRoot, runtimeRoot, outputRoot } = input;
  const sourceHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(approved.sourceHead) || sourceHead !== approved.sourceHead || dirty) {
    throw new Error('IMMUTABLE_SOURCE_NOT_ACCEPTED');
  }
  assertDigest(hash(await readFile(path.join(sourceRoot, 'pnpm-lock.yaml')), 'sha256'),
    approved.sourceLockSha256, 'approved source lock');

  for (const [root, expectedLockSha, section] of [
    [runtimeRoot, approved.runtimeLockSha256, 'artifacts'],
    [outputRoot, approved.outputLockSha256, 'workspace-module'],
  ] as const) {
    const lockPath = path.join(root, 'pnpm-lock.yaml');
    const lockBytes = await readFile(lockPath);
    assertDigest(hash(lockBytes, 'sha256'), expectedLockSha, `${section} lock`);
    const lock = await loadApprovedYaml(lockPath);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, any>;
    const packages = assertPinnedImporter(manifest, lock, approved.pins, section === 'artifacts' ? 'runtime' : 'output');
    for (const [name, pin] of Object.entries(approved.pins)) {
      if (section === 'workspace-module' && name === 'mastra') continue;
      const bytes = await localTarBytes(root, section, pin);
      const key = `${name}@file:${section}/${pin.fileName}`;
      if (packages?.[key]?.resolution?.integrity !== `sha512-${hash(bytes, 'sha512')}`) {
        throw new Error(`IMMUTABLE_TAR_LOCK_INTEGRITY_MISMATCH: ${name}`);
      }
    }
  }
}
