/**
 * BDD coverage for the web-auth query hook and its runtime-config short-circuit.
 *
 * Drives the real `fetchAuthState` service + React Query cache; only the
 * network is mocked (MSW, `onUnhandledRequest: 'error'`). The injected
 * `window.__MASTRACODE_CONFIG__` flag comes from the server (prod) or Vite
 * (dev); tests set it directly on `window` the same way the injected script
 * would.
 */
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { useFactoryAuth } from '../useFactoryAuth';

const AUTH_ME_URL = `${TEST_BASE_URL}/auth/me`;
const AUTH_CAPABILITIES_URL = `${TEST_BASE_URL}/api/auth/capabilities`;

afterEach(() => {
  delete window.__MASTRACODE_CONFIG__;
});

describe('useFactoryAuth', () => {
  describe('given the server injected authEnabled: false', () => {
    it('resolves the disabled state without touching the network', async () => {
      window.__MASTRACODE_CONFIG__ = { authEnabled: false };
      // No `/auth/me` handler registered: any fetch would trip MSW's
      // onUnhandledRequest: 'error' and fail this test.

      const { result, client } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data).toEqual({ authEnabled: false, authenticated: false });
      await waitFor(() => expect(client.isFetching()).toBe(0));
    });
  });

  describe('given the server injected authEnabled: true', () => {
    it('fetches /auth/me and exposes the signed-in identity', async () => {
      window.__MASTRACODE_CONFIG__ = { authEnabled: true };
      server.use(
        http.get(AUTH_ME_URL, () =>
          HttpResponse.json({ authenticated: true, user: { email: 'dev@mastra.ai', name: 'Dev' } }),
        ),
      );

      const { result } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data).toEqual({
        authEnabled: true,
        authenticated: true,
        user: { email: 'dev@mastra.ai', name: 'Dev' },
      });
    });

    it('reports unauthenticated when /auth/me returns 401', async () => {
      window.__MASTRACODE_CONFIG__ = { authEnabled: true };
      server.use(http.get(AUTH_ME_URL, () => HttpResponse.json({ error: 'unauthenticated' }, { status: 401 })));

      const { result } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data).toEqual({ authEnabled: true, authenticated: false });
    });

    it('surfaces a server outage instead of reporting the session as unauthenticated', async () => {
      window.__MASTRACODE_CONFIG__ = { authEnabled: true };
      server.use(http.get(AUTH_ME_URL, () => new Response(null, { status: 500 })));

      const { result } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toEqual(new Error('Auth check failed (500)'));
    });
  });

  describe('given no injected runtime config (stale HTML, tests)', () => {
    it('falls back to probing /auth/me and degrades to auth disabled on 404', async () => {
      const hit = vi.fn();
      server.use(
        http.get(AUTH_ME_URL, () => {
          hit();
          return HttpResponse.json({ error: 'not_found' }, { status: 404 });
        }),
      );

      const { result } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data).toEqual({ authEnabled: false, authenticated: false });
      expect(hit).toHaveBeenCalledTimes(1);
    });

    it('accepts an SPA fallback only when capabilities explicitly reports auth disabled', async () => {
      const authHit = vi.fn();
      const capabilitiesHit = vi.fn();
      server.use(
        http.get(AUTH_ME_URL, () => {
          authHit();
          return new HttpResponse('<!doctype html><html><body>Factory</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(AUTH_CAPABILITIES_URL, () => {
          capabilitiesHit();
          return HttpResponse.json({ enabled: false, login: null });
        }),
      );

      const { result } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data).toEqual({ authEnabled: false, authenticated: false });
      expect(authHit).toHaveBeenCalledTimes(1);
      expect(capabilitiesHit).toHaveBeenCalledTimes(1);
    });

    it('fails closed when an SPA fallback is returned while capabilities reports auth enabled', async () => {
      server.use(
        http.get(
          AUTH_ME_URL,
          () =>
            new HttpResponse('<!doctype html><html><body>Unexpected fallback</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
        http.get(AUTH_CAPABILITIES_URL, () => HttpResponse.json({ enabled: true, login: '/auth/login' })),
      );

      const { result } = renderHookWithProviders(() => useFactoryAuth());

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toEqual(
        new Error('Auth check returned a non-JSON response while authentication is enabled'),
      );
    });
  });
});
