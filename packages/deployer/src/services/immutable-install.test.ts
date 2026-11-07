import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runChildProcess, getApprovedImmutableRelease, verifyImmutableBuildInputs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  getApprovedImmutableRelease: vi.fn(),
  verifyImmutableBuildInputs: vi.fn(),
}));

vi.mock('../deploy/log.js', () => ({
  createChildProcessLogger: () => runChildProcess,
}));
vi.mock('./immutable-release.js', () => ({
  getApprovedImmutableRelease,
  verifyImmutableBuildInputs,
}));

import { DepsService } from './deps.js';

const roots: string[] = [];

beforeEach(() => {
  runChildProcess.mockReset().mockResolvedValue({ success: true, stdout: '', stderr: '' });
  getApprovedImmutableRelease.mockReset();
  verifyImmutableBuildInputs.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-immutable-install-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const runtimeRoot = join(root, 'runtime');
  const outputRoot = join(root, 'output');
  await Promise.all([mkdir(projectRoot), mkdir(runtimeRoot), mkdir(outputRoot)]);
  await writeFile(join(projectRoot, 'pnpm-lock.yaml'), 'legacy-source-lock\n');
  await writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(outputRoot, 'package.json'), '{"name":"fixture-output"}');
  await writeFile(join(outputRoot, 'pnpm-lock.yaml'), 'independently-reviewed-pinned-lock\n');
  const approved = { sourceRoot: root, projectRoot, runtimeRoot, outputRoot };
  getApprovedImmutableRelease.mockResolvedValue(approved);
  return { approved, projectRoot, outputRoot, runtimeRoot };
}

describe('deployer immutable Factory install control', () => {
  it('leaves the legacy nonfrozen source-lock install untouched when disabled', async () => {
    const f = await fixture();
    await new DepsService(f.projectRoot).install({ dir: f.outputRoot });
    expect(await readFile(join(f.outputRoot, 'pnpm-lock.yaml'), 'utf8')).toBe('legacy-source-lock\n');
    expect(runChildProcess).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'pnpm install --no-frozen-lockfile --loglevel=error',
    }));
    expect(getApprovedImmutableRelease).not.toHaveBeenCalled();
  });

  it('requires approval before filesystem mutation or a child process', async () => {
    const f = await fixture();
    getApprovedImmutableRelease.mockRejectedValueOnce(new Error('IMMUTABLE_RELEASE_NOT_APPROVED'));
    await expect(new DepsService(f.projectRoot).install({
      dir: f.outputRoot, immutableReleaseId: 'release-unapproved',
    })).rejects.toThrow('IMMUTABLE_RELEASE_NOT_APPROVED');
    expect(await readFile(join(f.outputRoot, 'pnpm-lock.yaml'), 'utf8')).toBe('independently-reviewed-pinned-lock\n');
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it('only invokes offline, frozen, scripts-disabled pnpm after approved dual-root provenance passes', async () => {
    const f = await fixture();
    await new DepsService(f.projectRoot).install({
      dir: f.outputRoot, immutableReleaseId: 'release-reviewed',
    });
    expect(getApprovedImmutableRelease).toHaveBeenCalledWith('release-reviewed');
    expect(verifyImmutableBuildInputs).toHaveBeenCalledWith({
      approved: f.approved,
      sourceRoot: f.approved.sourceRoot,
      runtimeRoot: f.runtimeRoot,
      outputRoot: f.outputRoot,
    });
    expect(await readFile(join(f.outputRoot, 'pnpm-lock.yaml'), 'utf8')).toBe('independently-reviewed-pinned-lock\n');
    expect(runChildProcess).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'pnpm install --frozen-lockfile --offline --ignore-scripts --loglevel=error',
    }));
  });

  it('rejects a wrong root or integrity failure without any package-manager execution', async () => {
    const f = await fixture();
    const outside = join(f.projectRoot, 'not-approved');
    await mkdir(outside);
    await expect(new DepsService(f.projectRoot).install({
      dir: outside, immutableReleaseId: 'release-reviewed',
    })).rejects.toThrow('IMMUTABLE_INSTALL_ROOT_NOT_APPROVED');
    expect(verifyImmutableBuildInputs).not.toHaveBeenCalled();

    verifyImmutableBuildInputs.mockRejectedValueOnce(new Error('IMMUTABLE_DIGEST_MISMATCH'));
    await expect(new DepsService(f.projectRoot).install({
      dir: f.outputRoot, immutableReleaseId: 'release-reviewed',
    })).rejects.toThrow('IMMUTABLE_DIGEST_MISMATCH');
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(await readFile(join(f.outputRoot, 'pnpm-lock.yaml'), 'utf8')).toBe('independently-reviewed-pinned-lock\n');
  });
});
