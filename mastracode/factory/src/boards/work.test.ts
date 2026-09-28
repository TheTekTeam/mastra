import { describe, expect, it } from 'vitest';

import type { FactoryRuleItemContext, FactoryStageRuleContext } from '../rules/types.js';
import { workBoard } from './work.js';

function executeContext(source: FactoryRuleItemContext['source']): FactoryStageRuleContext {
  return {
    tenant: { orgId: 'org-1', projectId: 'project-1' },
    actor: { type: 'system', id: 'test' },
    ingress: { type: 'rule', id: 'ingress-1' },
    cause: 'test',
    causalChain: [],
    configVersion: 'test',
    item: {
      id: 'item-1',
      source,
      sourceKey: 'source-1',
      parentWorkItemId: null,
      title: 'Fix the issue',
      url: 'https://gitlab.com/acme/app/-/issues/3',
      stages: ['execute'],
      acceptedAt: null,
      metadata: { identifier: 'acme/app#3' },
    },
    board: 'work',
    itemRevision: 1,
    source: source === 'gitlab-issue' ? 'gitlabIssue' : 'issue',
    stage: 'execute',
    fromStage: 'triage',
    toStage: 'execute',
  };
}

describe('Dell trusted Intake arrival policy', () => {
  it.each([true, false])('only allows eligible newly materialized issues: %s', async eligible => {
    const base = executeContext('github-issue');
    const context = {
      ...base,
      cause: 'linked_item_materialized',
      stage: 'intake',
      toStage: 'intake',
      item: { ...base.item, stages: ['intake'], metadata: { autoStartCandidate: eligible } },
    };
    const result = await workBoard.rules.intake?.issue?.onEnter?.(context);
    if (eligible) expect(result).toMatchObject({ type: 'invokeSkill', skillName: 'factory-triage' });
    else expect(result).toBeUndefined();
    expect(await workBoard.rules.intake?.issue?.onEnter?.({ ...context, cause: 'test' })).toBeUndefined();
  });
});

describe('work board build prompt', () => {
  it('asks for a merge request for a GitLab issue', async () => {
    const decision = await workBoard.rules.execute?.gitlabIssue?.onEnter?.(executeContext('gitlab-issue'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'work' });
    if (!decision || decision.type !== 'invokeSkill') throw new Error('Expected build invocation.');
    expect(decision.prompt).toContain('Open a merge request when the work is ready for review.');
    expect(decision.prompt).toContain('GitLab issue acme/app#3');
    expect(decision.prompt).not.toContain('pull request');
  });

  it('retains the pull-request instruction for a GitHub issue', async () => {
    const decision = await workBoard.rules.execute?.issue?.onEnter?.(executeContext('github-issue'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'work' });
    if (!decision || decision.type !== 'invokeSkill') throw new Error('Expected build invocation.');
    expect(decision.prompt).toContain('Open a pull request when the work is ready for review.');
  });
});
