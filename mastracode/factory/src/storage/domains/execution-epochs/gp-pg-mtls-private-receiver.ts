import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import type { FactoryStorageOps } from '@mastra/core/storage';

import type {
  FactoryGpPgLeaseIssuerStorage,
  VerifiedPrivateGpIssuerRequest,
  VerifiedPrivateGpRevoke,
} from './gp-pg-lease-issuer.js';
import type { GpSignedHandoverPacket } from './gp-pg-handover-crypto.js';

// Intentionally NOT mounted by Factory's normal HTTP surface and NOT enabled
// without pinned, server-held TLS keys and real authenticated PM/GP providers.
export const FACTORY_GP_PG_PRIVATE_MTLS_RECEIVER_CAPABILITY = Object.freeze({
  installed: false, enabledByDefault: false, productionReady: false,
  loopbackOnly: true, bodySuppliedKeysTrusted: false, remoteExecution: false,
});

type PrivateBody = {
  version: 'factory_gp_pg_mtls_v1';
  kind: 'issue' | 'revoke';
  requestId: string;
  projectId: string;
  leaseIntentId: string;
  scopeTupleSha256: string;
  packet: GpSignedHandoverPacket;
};
const FINGERPRINT = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const fields = (x: unknown, keys: readonly string[]): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).length === keys.length &&
  Object.keys(x).every(key => keys.includes(key));
const isBody = (x: unknown): x is PrivateBody => {
  if (!fields(x, ['version', 'kind', 'requestId', 'projectId',
    'leaseIntentId', 'scopeTupleSha256', 'packet'])) return false;
  const packet = fields(x.packet, ['payload', 'signature', 'alg']) ?
    x.packet as unknown as GpSignedHandoverPacket : null;
  const payload = packet?.payload ?? null;
  return x.version === 'factory_gp_pg_mtls_v1' &&
    (x.kind === 'issue' || x.kind === 'revoke') &&
    UUID.test(String(x.requestId)) && UUID.test(String(x.projectId)) &&
    UUID.test(String(x.leaseIntentId)) && HEX.test(String(x.scopeTupleSha256)) &&
    !!payload && payload.scope?.projectId === x.projectId &&
    payload.scope?.leaseIntentId === x.leaseIntentId &&
    payload.scopeTupleSha256 === x.scopeTupleSha256 &&
    (x.kind !== 'issue' || x.requestId === payload.scope.bridgeChallengeId);
};
type ReadGpRevoke = (ops: FactoryStorageOps, body: Readonly<PrivateBody>) =>
  Promise<VerifiedPrivateGpRevoke | null>;

/**
 * The untrusted TLS request is converted to an object identity known only to
 * this server. The actual Factory issuer still verifies the PM Ed25519
 * signature, B1 epoch, native project/installation, live PM/GP grant and
 * PostgreSQL replay under its own transaction.
 */
export class FactoryGpPgPrivateMtlsIngress {
  #enabled: boolean;
  #tls?: { serverKey: string | Buffer; serverCert: string | Buffer;
    clientCa: string | Buffer; pinnedClientCertSha256: string };
  #issuer?: FactoryGpPgLeaseIssuerStorage;
  #readGpRevoke?: ReadGpRevoke;
  #contexts = new WeakMap<object, PrivateBody>();
  #server?: ReturnType<typeof createServer>;

  constructor(options: {
    enabled?: boolean;
    serverKey?: string | Buffer;
    serverCert?: string | Buffer;
    clientCa?: string | Buffer;
    pinnedClientCertSha256?: string;
    readAuthenticatedGpRevoke?: ReadGpRevoke;
  } = {}) {
    this.#enabled = options.enabled === true;
    if (!this.#enabled) return;
    if (!options.serverKey || !options.serverCert || !options.clientCa ||
      !FINGERPRINT.test(options.pinnedClientCertSha256 ?? '') ||
      !options.readAuthenticatedGpRevoke) {
      throw new Error('GP PG receiver requires private TLS and GP revocation verifier');
    }
    this.#tls = {
      serverKey: options.serverKey, serverCert: options.serverCert,
      clientCa: options.clientCa, pinnedClientCertSha256: options.pinnedClientCertSha256!,
    };
    this.#readGpRevoke = options.readAuthenticatedGpRevoke;
  }

  resolvePrivateIssue = async (context: object): Promise<VerifiedPrivateGpIssuerRequest | null> => {
    const body = this.#contexts.get(context);
    if (!this.#enabled || !body || body.kind !== 'issue') return null;
    return { packet: body.packet, scope: body.packet.payload.scope, ttlSeconds: 60 };
  };

  resolvePrivateReceipt = (context: object) => {
    const body = this.#contexts.get(context);
    if (!this.#enabled || !body) return null;
    return { scope: body.packet.payload.scope, leaseIntentId: body.leaseIntentId,
      scopeTupleSha256: body.scopeTupleSha256 };
  };

  resolvePrivateRevokeIdentity = (context: object): {
    factoryOrgId: string; projectId: string;
  } | null => {
    const body = this.#contexts.get(context);
    if (!this.#enabled || !body || body.kind !== 'revoke') return null;
    const scope = body.packet.payload.scope;
    return scope?.factoryOrgId && scope.projectId === body.projectId ?
      { factoryOrgId: scope.factoryOrgId, projectId: scope.projectId } : null;
  };

  resolvePrivateRevoke = async (ops: FactoryStorageOps, context: object):
    Promise<VerifiedPrivateGpRevoke | null> => {
    const body = this.#contexts.get(context);
    if (!this.#enabled || !body || body.kind !== 'revoke') return null;
    // MUST perform fresh independent PM live GP session/origin/CSRF and
    // revocation readback inside the Factory epoch-row lock. Never lift booleans
    // or key material from the HTTP JSON as authority.
    return this.#readGpRevoke!(ops, body);
  };

  async listen(issuer: FactoryGpPgLeaseIssuerStorage): Promise<{ port: number }> {
    if (!this.#enabled || !this.#tls || this.#server) {
      throw new Error('GP PG mTLS receiver not enabled or already listening');
    }
    this.#issuer = issuer;
    const { serverKey, serverCert, clientCa, pinnedClientCertSha256 } = this.#tls;
    const server = createServer({
      key: serverKey, cert: serverCert, ca: clientCa,
      requestCert: true, rejectUnauthorized: true,
    }, (request, response) => {
      const socket = request.socket as TLSSocket;
      const peer = socket.getPeerCertificate(true);
      const fingerprint = peer?.raw ?
        new X509Certificate(peer.raw).fingerprint256.replaceAll(':', '').toLowerCase() : null;
      if (!socket.authorized || fingerprint !== pinnedClientCertSha256) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== 'POST' ||
        (request.url !== '/private/gp-pg/v1/issue' &&
          request.url !== '/private/gp-pg/v1/revoke' &&
          request.url !== '/private/gp-pg/v1/receipt') ||
        !String(request.headers['content-type']).startsWith('application/json')) {
        response.writeHead(404).end();
        return;
      }
      let bytes = 0, raw = '', over = false;
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16384) { over = true; request.destroy(); }
        else raw += String(chunk);
      });
      request.once('end', () => {
        if (over) return;
        void (async () => {
          try {
            const body: unknown = JSON.parse(raw);
            if (!isBody(body) ||
              (request.url !== '/private/gp-pg/v1/receipt' &&
                request.url !== '/private/gp-pg/v1/' + body.kind)) {
              response.writeHead(400).end();
              return;
            }
            const context = Object.freeze({ nonce: Symbol('factory-gp-pg-private-request') });
            this.#contexts.set(context, body);
            try {
              const status = request.url === '/private/gp-pg/v1/receipt' ?
                await this.#issuer!.receipt(context) : body.kind === 'issue' ?
                  await this.#issuer!.issue(context) : await this.#issuer!.revoke(context);
              const ack = { requestId: body.requestId, kind: body.kind,
                projectId: body.projectId, leaseIntentId: body.leaseIntentId,
                scopeTupleSha256: body.scopeTupleSha256, status };
              response.writeHead(200, { 'Content-Type': 'application/json',
                'Cache-Control': 'no-store' }).end(JSON.stringify(ack));
            } finally { this.#contexts.delete(context); }
          } catch {
            // No stack, project existence or mutable-effect status leaked.
            response.writeHead(503, { 'Cache-Control': 'no-store' }).end();
          }
        })();
      });
    });
    this.#server = server;
    try {
      await new Promise<void>((yes, no) => {
        server.once('error', no);
        server.listen(0, '127.0.0.1', () => yes());
      });
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('mTLS loopback bind failed');
      return { port: addr.port };
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>(yes => server.close(() => yes()));
  }
}
