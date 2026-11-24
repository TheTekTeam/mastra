/**
 * Claimed Factory decisions only. This code never independently schedules work.
 * Subscription-only Codex process, zero paid API fallback.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const PROJECT = 'e184905a-bda5-4adb-8a4a-af64602dcda3';
const HTAI_REPO = '/home/gp/projects/htai';
const WORKTREES = '/home/gp/projects/.worktrees';
const WORKER = '/home/gp/.local/libexec/factory-htai-codex-cli-worker.py';
const ISSUER = '/home/gp/.config/factory-codex-htai/native-issuer.key';
const CLAIM_DIR = '/home/gp/.local/state/factory-codex-htai/claims';
const ISSUE_URL = /^https:\/\/github\.com\/TheTekTeam\/HTAI\/issues\/([1-9][0-9]{0,5})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;

interface NativeInput {
  record: { id: string; factoryProjectId: string; workItemId: string | null };
  decision: { role: string };
  item: { id: string; externalSource: { type: string; url?: string } | null };
}
function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
async function git(...args: string[]): Promise<string> {
  const result = await execFile('/usr/bin/git', ['-C', HTAI_REPO, ...args], {
    timeout: 90000, maxBuffer: 32768,
  });
  return result.stdout.trim();
}
export function createHtaiCodexNativeWorker() {
  let active = false;
  return async function execute(input: NativeInput): Promise<boolean> {
    if (input.record.factoryProjectId !== PROJECT) return false;
    // Do not hold a second Factory lease while another HTAI CLI task is active.
    // Factory's own retry/claim lifecycle decides what happens to busy claims.
    if (active) throw new Error('HTAI_CODEX_ONE_ACTIVE_TASK_LIMIT');
    active = true;
    // Every HTAI invokeSkill is intercepted. Unsupported roles fail closed.
    const run = async (): Promise<void> => {
      need(input.record.workItemId === input.item.id, 'HTAI_NATIVE_ITEM_DRIFT');
      need(UUID.test(input.record.id) && UUID.test(input.item.id), 'HTAI_NATIVE_ID_INVALID');
      need(input.decision.role === 'work', 'HTAI_CODEX_WORK_ROLE_ONLY');
      need(input.item.externalSource?.type === 'issue', 'HTAI_CODEX_NATIVE_ISSUE_REQUIRED');
      const issue = ISSUE_URL.exec(input.item.externalSource.url ?? '');
      need(issue, 'HTAI_CODEX_ISSUE_URL_REQUIRED');
      need(existsSync(WORKER), 'HTAI_CODEX_WORKER_UNAVAILABLE');
      need(existsSync(ISSUER), 'HTAI_CODEX_ISSUER_UNAVAILABLE');
      const secret = readFileSync(ISSUER);
      need(secret.length >= 32, 'HTAI_CODEX_ISSUER_INVALID');
      await git('fetch', 'origin', 'main');
      const head = await git('rev-parse', 'origin/main');
      need(SHA.test(head), 'HTAI_CODEX_BASE_INVALID');
      const suffix = issue[1] + '-' + input.record.id.slice(0, 8);
      const worktree = join(WORKTREES, 'htai-native-' + suffix);
      need(!existsSync(worktree), 'HTAI_NATIVE_RUN_ALREADY_ATTEMPTED');
      await git('worktree', 'add', '-b', 'factory/htai-native-' + suffix, worktree, head);
      mkdirSync(CLAIM_DIR, { recursive: true, mode: 0o700 });
      const now = Math.floor(Date.now() / 1000);
      const claim = {
        kind: 'FACTORY_NATIVE_HTAI_CODEX_V1',
        projectId: PROJECT,
        repository: 'TheTekTeam/HTAI',
        workItemId: input.item.id,
        nativeRunId: input.record.id,
        issueNumber: Number(issue[1]),
        role: input.decision.role,
        baseHead: head,
        worktree,
        createdAt: now,
        expiresAt: now + 300,
      };
      const canonical = JSON.stringify(
        Object.fromEntries(Object.entries(claim).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      );
      const signature = createHmac('sha256', secret).update(canonical).digest('hex');
      const claimFile = join(CLAIM_DIR, 'htai-' + input.record.id + '.json');
      writeFileSync(claimFile, JSON.stringify({ ...claim, hmacSha256: signature }), {
        mode: 0o600, flag: 'wx',
      });
      const result = await execFile('/usr/bin/python3', [
        WORKER, 'run', '--claim-file', claimFile, '--issuer-key', ISSUER,
      ], { timeout: 3700000, maxBuffer: 16384 });
      const outcome = JSON.parse(result.stdout) as { exitCode?: number; nativeRunId?: string };
      need(outcome.nativeRunId === input.record.id && outcome.exitCode === 0,
        'HTAI_CODEX_PROCESS_UNVERIFIED');
      console.info('htai.codex.native_worker_finished', {
        projectId: PROJECT, nativeRunId: input.record.id,
        issue: Number(issue[1]), lifecycleVerified: false,
      });
    };
    try {
      await run();
    } finally {
      active = false;
    }
    return true;
  };
}
