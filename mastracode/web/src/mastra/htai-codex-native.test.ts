import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHtaiCodexNativeWorker } from './htai-codex-native.js';

const validId = 'e184905a-bda5-4adb-8a4a-af64602dcda3';
const otherId = 'b30cdfd3-daf3-4484-9314-28a23b115d1a';
function fixture(projectId: string, role = 'work') {
  return {
    record: { id: validId, factoryProjectId: projectId, workItemId: validId },
    decision: { role },
    item: { id: validId, externalSource: {
      type: 'issue', url: 'https://github.com/TheTekTeam/HTAI/issues/17',
    } },
  };
}

test('non-HTAI project is never intercepted', async () => {
  assert.equal(await createHtaiCodexNativeWorker()(fixture(otherId)), false);
});

test('HTAI unsupported role cannot fall through to paid model', async () => {
  await assert.rejects(() => createHtaiCodexNativeWorker()(fixture(validId, 'triage')),
    /HTAI_CODEX_WORK_ROLE_ONLY/);
});

test('HTAI requires unambiguous genuine GitHub issue', async () => {
  const input = fixture(validId);
  input.item.externalSource.type = 'pull-request';
  await assert.rejects(() => createHtaiCodexNativeWorker()(input),
    /HTAI_CODEX_NATIVE_ISSUE_REQUIRED/);
});

test('HTAI refuses native work-item mismatch', async () => {
  const input = fixture(validId);
  input.item.id = otherId;
  await assert.rejects(() => createHtaiCodexNativeWorker()(input),
    /HTAI_NATIVE_ITEM_DRIFT/);
});
