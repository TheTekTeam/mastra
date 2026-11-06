import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgFactoryStorage } from '@mastra/pg';
import type { FactoryStorageOps } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';
import { FactoryProjectsStorage } from '../projects/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import { FactoryExecutionOriginStorage } from '../execution-origin/base.js';
import { FactoryExecutionEpochStorage, FACTORY_EXECUTION_EPOCHS_SCHEMA } from './base.js';
import { FactoryManagedCoreEffectStorage } from './managed-effect.js';
import { FactoryGpPgLeaseIssuerStorage } from './gp-pg-lease-issuer.js';
import { FactoryGpPgPrivateMtlsIngress, FACTORY_GP_PG_PRIVATE_MTLS_RECEIVER_CAPABILITY }
  from './gp-pg-mtls-private-receiver.js';
import { gpV9ScopeTupleDigest } from './gp-pg-handover-crypto.js';
import type { GpHandoverScope, GpSignedHandoverPacket } from './gp-pg-handover-crypto.js';

const pgUrl=process.env.FACTORY_A2D_PG_TEST_URL;
const sha=(value: unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: unknown): string {
  if(value===null||['string','number','boolean'].includes(typeof value))
    return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  const x=value as Record<string,unknown>;
  return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
function certificate(dir:string,name:string){
  const prefix=join(dir,name),key=prefix+'.key',cert=prefix+'.pem';
  execFileSync('openssl',['req','-x509','-nodes','-newkey','rsa:2048',
    '-keyout',key,'-out',cert,'-days','1','-subj','/CN='+name,
    '-addext','subjectAltName=DNS:'+name],{stdio:'ignore'});
  return {key:readFileSync(key),cert:readFileSync(cert)};
}
function makeScope(projectId:string):GpHandoverScope {
  return {
    consentRequestId:randomUUID(),manifestId:sha('manifest'+randomUUID()),
    nonceSha256:sha('nonce'+randomUUID()),projectId,
    factoryOrgId:'native-opaque-org-gp',repositoryId:1208128934,
    repositoryOwnerId:278831585,appInstallationId:827331,
    writerOwnerId:'pm-gp-private-writer',writerEpoch:7,
    ownerEpoch:'B1-native-opaque-owner',authorityRevision:4,
    policyDigest:sha('policy'),scopeDigest:sha('scope'),
    sourceProofDigest:sha('source'),mode:'supervised',
    nativeAutomationRevision:0,mappingDigest:sha('mapping'),
    coverageVersion:1,bridgeChallengeId:randomUUID(),leaseIntentId:randomUUID()
  };
}
function signed(s:GpHandoverScope,privateKey:ReturnType<typeof generateKeyPairSync>['privateKey']):
 GpSignedHandoverPacket {
  const now=Date.now();
  const payload={
    version:'pm_factory_pg_handover_v1' as const,
    audience:'factory_pg_handover_issuer' as const,
    issuer:'factory-project-manager',keyId:'gp-test-pinned-2026',
    issuedAtMs:now,expiresAtMs:now+10000,
    scopeTupleSha256:gpV9ScopeTupleDigest(s),scope:s
  };
  const data=Buffer.concat([Buffer.from('PM_TO_FACTORY_GP_PG_HANDOVER_V1\0'),
    Buffer.from(canonical(payload))]);
  return {alg:'Ed25519',payload,signature:sign(null,data,privateKey).toString('base64url')};
}
function remoteWorker(input:Record<string,unknown>):Promise<{http:number;body:Record<string,unknown>}> {
  const path=fileURLToPath(new URL('./gp-pg-mtls-client.worker.mjs',import.meta.url));
  const child=spawn(process.execPath,[path],{
    env:{...process.env,FACTORY_GP_PG_TLS_TEST_INPUT:JSON.stringify(input)},
    stdio:['ignore','pipe','pipe']
  });
  return new Promise((resolve,reject)=>{
    let out='',err='';
    child.stdout.on('data',x=>out+=String(x));
    child.stderr.on('data',x=>err+=String(x));
    child.once('error',reject);
    child.once('exit',code=>{
      const line=out.split('\n').find(x=>x.startsWith('ACK:'));
      if(code!==0||!line)reject(new Error('TLS worker '+code+': '+out.slice(-300)+' '+err.slice(-300)));
      else resolve(JSON.parse(line.slice(4)) as {http:number;body:Record<string,unknown>});
    });
  });
}
async function fixture(){
  if(!pgUrl)throw new Error('isolated PG18 URL required');
  const dir=mkdtempSync(join(tmpdir(),'factory-gp-mtls-'));
  const factoryCert=certificate(dir,'factory.local');
  const pmCert=certificate(dir,'pm.local');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const ingress=new FactoryGpPgPrivateMtlsIngress({
    enabled:true,serverKey:factoryCert.key,serverCert:factoryCert.cert,
    clientCa:pmCert.cert,
    pinnedClientCertSha256:new X509Certificate(pmCert.cert).fingerprint256.replaceAll(':','').toLowerCase(),
    readAuthenticatedGpRevoke:async(ops,body)=>{
      const scope=body.packet.payload.scope;
      return {source:'authenticated_live_gp_revocation_v1',actor:'gp',
        gpSessionVerified:true,originVerified:true,csrfVerified:true,
        factoryOrgId:scope.factoryOrgId,projectId:scope.projectId,
        leaseId:scope.leaseIntentId,writerOwnerId:scope.writerOwnerId,
        ownerEpoch:scope.ownerEpoch,verifiedAtMs:(await ops.databaseNow!()).getTime()};
    }
  });
  const storage=new PgFactoryStorage({connectionString:pgUrl});
  const projects=storage.registerDomain(new FactoryProjectsStorage());
  const epochs=storage.registerDomain(new FactoryExecutionEpochStorage());
  storage.registerDomain(new SourceControlStorage());
  storage.registerDomain(new FactoryExecutionOriginStorage(async()=>null));
  storage.registerDomain(new FactoryManagedCoreEffectStorage());
  const issuer=storage.registerDomain(new FactoryGpPgLeaseIssuerStorage({
    enabled:true,
    trustedKey:{keyId:'gp-test-pinned-2026',publicKey},
    resolvePrivateRequest:ingress.resolvePrivateIssue,
    resolvePrivateRevokeIdentity:ingress.resolvePrivateRevokeIdentity,
    resolvePrivateRevoke:ingress.resolvePrivateRevoke,
    readAuthenticatedPm:async(ops:FactoryStorageOps,_ctx:object,s:GpHandoverScope)=>{
      const now=(await ops.databaseNow!()).getTime();
      return {source:'authenticated_live_pm_v9_authority_v1' as const,actor:'gp' as const,
        current:true as const,gpSessionVerified:true as const,
        consentUnrevoked:true as const,consentConsumedOnce:true as const,
        projectSelected:true as const,projectMembershipVerified:true as const,
        writerPaused:true as const,dispatchPending:0 as const,
        projectId:s.projectId,factoryOrgId:s.factoryOrgId,
        consentRequestId:s.consentRequestId,manifestId:s.manifestId,
        nonceSha256:s.nonceSha256,writerOwnerId:s.writerOwnerId,
        writerEpoch:s.writerEpoch,ownerEpoch:s.ownerEpoch,
        authorityRevision:s.authorityRevision,policyDigest:s.policyDigest,
        mode:s.mode,verifiedAtMs:now,heartbeatAtMs:now,
        writerLeaseExpiresAtMs:now+30000
      };
    },
    readNativeDrain:async(_ops,s)=>({
      source:'factory_pg_same_transaction_drain_v1' as const,
      projectId:s.projectId,factoryOrgId:s.factoryOrgId,coverageArmed:true as const,
      mappingDigest:s.mappingDigest,coverageVersion:s.coverageVersion,
      runningCount:0 as const,parkedCount:0 as const,pendingCount:0 as const,
      unknownCount:0 as const,unsettledEffectCount:0 as const,
      remoteExecutionSupported:false as const
    }),
    readLiveAppGrant:async(ops,s,binding)=>({
      source:'authenticated_github_app_grant_v1' as const,
      grantActive:true as const,factoryOrgId:s.factoryOrgId,projectId:s.projectId,
      repositoryId:s.repositoryId,repositoryOwnerId:s.repositoryOwnerId,
      appInstallationId:s.appInstallationId!,...binding,
      verifiedAtMs:(await ops.databaseNow!()).getTime()
    })
  }));
  await storage.init();
  const project=await projects.create({
    orgId:'native-opaque-org-gp',userId:'gp-native-test-owner',
    input:{name:'HTAI mTLS '+randomUUID()}
  });
  const s=makeScope(project.id),now=new Date();
  const install=await storage.ops.insertOne('source_control_installations',{
    org_id:s.factoryOrgId,integration_id:'github',connected_by_user_id:'gp-native-test-owner',
    external_id:String(s.appInstallationId),provider_metadata:{},created_at:now
  }) as {id:string};
  const repo=await storage.ops.insertOne('source_control_repositories',{
    installation_id:install.id,external_id:String(s.repositoryId),
    slug:'TheTekTeam/HTAI',default_branch:'main',provider_metadata:{},
    created_at:now,updated_at:now
  }) as {id:string};
  const connection=await storage.ops.insertOne('factory_project_source_control_connections',{
    factory_project_id:s.projectId,integration_id:'github',installation_id:install.id,
    created_by_user_id:'gp-native-test-owner',created_at:now
  }) as {id:string};
  await storage.ops.insertOne('factory_project_repositories',{
    connection_id:connection.id,repository_id:repo.id,
    created_by_user_id:'gp-native-test-owner',
    sandbox_provider:'local',sandbox_workdir:'/tmp',
    created_at:now,updated_at:now
  });
  await epochs.provisionUnarmed({orgId:s.factoryOrgId,projectId:s.projectId});
  await storage.withTransaction(async ops=>{
    await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name,
      {org_id:s.factoryOrgId,factory_project_id:s.projectId},
      ()=>({fence_armed:true,coverage_version:1,mapping_digest:s.mappingDigest}));
  });
  expect(await epochs.tryQuiesce({orgId:s.factoryOrgId,projectId:s.projectId,
    expectedRevision:0,ownerEpoch:s.ownerEpoch})).toBe('quiescing');
  const {port}=await ingress.listen(issuer);
  const client={
    port,ca:factoryCert.cert.toString(),cert:pmCert.cert.toString(),
    key:pmCert.key.toString(),
    serverPin:new X509Certificate(factoryCert.cert).fingerprint256.replaceAll(':','').toLowerCase()
  };
  return {s,client,packet:signed(s,privateKey),storage,ingress,dir,
    dispose:async()=>{await ingress.close();await storage.close();
      rmSync(dir,{recursive:true,force:true});}};
}
describe('Factory default-off GP PG mutual TLS ingress',()=>{
  it('has no production mount, requires pin and GP authority',()=>{
    expect(FACTORY_GP_PG_PRIVATE_MTLS_RECEIVER_CAPABILITY).toMatchObject({
      installed:false,enabledByDefault:false,productionReady:false,
      bodySuppliedKeysTrusted:false
    });
    expect(()=>new FactoryGpPgPrivateMtlsIngress({enabled:true}))
      .toThrow(/private TLS and GP revocation verifier/);
  });
  it.skipIf(!pgUrl)('separate Node client reaches real PostgreSQL issuer once, replay denied; revocation tombstones',async()=>{
    const f=await fixture();
    try{
      const body={version:'factory_gp_pg_mtls_v1',kind:'issue',
        requestId:f.s.bridgeChallengeId,projectId:f.s.projectId,
        leaseIntentId:f.s.leaseIntentId,scopeTupleSha256:gpV9ScopeTupleDigest(f.s),
        packet:f.packet};
      const first=await remoteWorker({...f.client,body});
      expect(first.http).toBe(200);
      expect(first.body.status).toBe('issued');
      const again=await remoteWorker({...f.client,body});
      expect(again.body.status).toBe('denied');
      const revoked=await remoteWorker({...f.client,body:{
        ...body,kind:'revoke',requestId:randomUUID()
      }});
      expect(revoked.body.status).toBe('revoked');
      const after=await remoteWorker({...f.client,body});
      expect(after.body.status).toBe('denied');
    }finally{await f.dispose();}
  });
});
