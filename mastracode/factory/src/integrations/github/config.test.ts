import { describe, expect, it } from 'vitest';

import { fakeRouteAuth } from '../../routes/test-utils.js';
import { getGithubFeatureDiagnostics, isGithubFeatureEnabled } from './config.js';
import { GithubIntegration } from './integration.js';

describe('isGithubFeatureEnabled', () => {
  it('keeps a configured GitHub integration enabled in explicit no-auth local mode', () => {
    const github = new GithubIntegration({
      appId: '123',
      privateKey: 'test-key',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      slug: 'test-app',
    });

    expect(isGithubFeatureEnabled({ github, auth: fakeRouteAuth({ enabled: false }) })).toBe(true);
  });
});

describe('getGithubFeatureDiagnostics', () => {
  it('does not require integration route storage to be initialized', () => {
    const github = new GithubIntegration({
      appId: '123',
      privateKey: 'test-key',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      slug: 'test-app',
    });

    expect(
      getGithubFeatureDiagnostics({
        github,
        auth: fakeRouteAuth(),
        appDbConfigured: false,
      }),
    ).toMatchObject({
      githubAppConfigured: true,
      appDbConfigured: false,
    });
  });
});
