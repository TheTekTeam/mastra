import { FactoryGpPgPrivatePmAuthorityReaderV1 } from './gp-pg-server-pm-authority.js';
import { createFactoryGpPgInstalledAppGrantReader, FACTORY_GP_PG_APP_GRANT_PROVIDER }
  from './gp-pg-server-app-grant.js';
import { FactoryGpPgNativeScopeAttestorV1, FACTORY_GP_PG_NATIVE_SCOPE_ATTESTOR_CAPABILITY }
  from './gp-pg-native-scope-attestor.js';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomInt, randomUUID, sign, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
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
import { FactoryGpPgLeaseIssuerStorage, FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA } from './gp-pg-lease-issuer.js';
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
function makeScope(projectId:string,factoryOrgId:string):GpHandoverScope {
  return {
    consentRequestId:randomUUID(),manifestId:sha('manifest'+randomUUID()),
    nonceSha256:sha('nonce'+randomUUID()),projectId,
    factoryOrgId,repositoryId:randomInt(1_000_000,1_000_000_000),
    repositoryOwnerId:278831585,appInstallationId:randomInt(1_000_000,1_000_000_000),
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
async function fixture({withNative=false,pmAuthorityPort=0}={}){
  if(!pgUrl)throw new Error('isolated PG18 URL required');
  const dir=mkdtempSync(join(tmpdir(),'factory-gp-mtls-'));
  const factoryCert=certificate(dir,'factory.local');
  const pmCert=certificate(dir,'pm.local');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const pmAuthority=pmAuthorityPort?new FactoryGpPgPrivatePmAuthorityReaderV1({
    enabled:true,origin:'https://127.0.0.1:'+pmAuthorityPort,
    serverName:'pm.local',ca:pmCert.cert,clientCert:factoryCert.cert,
    clientKey:factoryCert.key,
    serverCertSha256:new X509Certificate(pmCert.cert).fingerprint256
      .replaceAll(':','').toLowerCase(),
    pmPublicKey:publicKey,pmKeyId:'pm-authority-test-pin'
  }):null;
  // The cross-repository positive drives the REAL installed-App provider
  // with TEST-ONLY Octokit, not a self-asserted grant response.
  let currentAppScope:GpHandoverScope|undefined;
  let appMembershipReads=0;
  const installedAppReader=createFactoryGpPgInstalledAppGrantReader({
    enabled:pmAuthorityPort>0,
    github:{
      getAppOctokit:()=>({apps:{getAuthenticated:async()=>({
        data:{slug:'tek-test'}
      })}}),
      getInstallationOctokit:installationId=>{
        if(!currentAppScope||installationId!==currentAppScope.appInstallationId)
          throw new Error('Test installation pin mismatch');
        const s=currentAppScope;
        return {
          apps:{listReposAccessibleToInstallation:async()=>{
            appMembershipReads++;
            return {data:{total_count:1,repositories:[{
              id:s.repositoryId,full_name:'TheTekTeam/HTAI'
            }]}};
          }},
          repos:{get:async()=>({data:{
            id:s.repositoryId,full_name:'TheTekTeam/HTAI',
            owner:{id:s.repositoryOwnerId}
          }})}
        };
      }
    }
  });
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
    trustedKey:{keyId:withNative?'pm-test-pin':'gp-test-pinned-2026',publicKey},
    resolvePrivateRequest:ingress.resolvePrivateIssue,
    resolvePrivateReceipt:ingress.resolvePrivateReceipt,
    resolvePrivateRevokeIdentity:ingress.resolvePrivateRevokeIdentity,
    resolvePrivateRevoke:ingress.resolvePrivateRevoke,
    readAuthenticatedPm:pmAuthority?pmAuthority.readConsumed:
      async(ops:FactoryStorageOps,_ctx:object,s:GpHandoverScope)=>{
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
    readLiveAppGrant:pmAuthority?installedAppReader:async(ops,s,binding)=>({
      source:'authenticated_github_app_grant_v1' as const,
      grantActive:true as const,factoryOrgId:s.factoryOrgId,projectId:s.projectId,
      repositoryId:s.repositoryId,repositoryOwnerId:s.repositoryOwnerId,
      appInstallationId:s.appInstallationId!,...binding,
      verifiedAtMs:(await ops.databaseNow!()).getTime()
    })
  }));
  await storage.init();
  const orgId='native-opaque-org-'+randomUUID();
  const project=await projects.create({
    orgId,userId:'gp-native-test-owner',
    input:{name:'HTAI mTLS '+randomUUID()}
  });
  const s=makeScope(project.id,orgId),now=new Date();
  currentAppScope=s;
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
  const nativeKeys=withNative?generateKeyPairSync('ed25519'):null;
  const nativeAttestor=nativeKeys?new FactoryGpPgNativeScopeAttestorV1({
    enabled:true,storage,privateKey:nativeKeys.privateKey,
    keyId:'factory-test-pin',
    resolvePrivateScope:ingress.resolvePrivateNativeScope,
    readAuthenticatedPmV8:pmAuthority?pmAuthority.readPreconsent:
      async(ops:FactoryStorageOps,_ctx:object,s:GpHandoverScope)=>{
      const t=(await ops.databaseNow!()).getTime();
      return {source:'authenticated_current_pm_gp_v8_preconsent_v1' as const,
        actor:'gp' as const,sessionVerified:true as const,
        csrfVerified:true as const,consentUnrevoked:true as const,
        projectSelected:true as const,writerPaused:true as const,
        dispatchPending:0 as const,factoryOrgId:s.factoryOrgId,
        projectId:s.projectId,consentRequestId:s.consentRequestId,
        manifestId:s.manifestId,nonceSha256:s.nonceSha256,
        writerOwnerId:s.writerOwnerId,writerEpoch:s.writerEpoch,
        ownerEpoch:s.ownerEpoch,authorityRevision:s.authorityRevision,
        policyDigest:s.policyDigest,verifiedAtMs:t,
        writerLeaseExpiresAtMs:t+30000};
    },
    readNativeDrain:async(_ops,s)=>({
      source:'factory_pg_same_transaction_drain_v1' as const,
      projectId:s.projectId,factoryOrgId:s.factoryOrgId,
      coverageArmed:true as const,mappingDigest:s.mappingDigest,
      coverageVersion:1,runningCount:0 as const,parkedCount:0 as const,
      pendingCount:0 as const,unknownCount:0 as const,
      unsettledEffectCount:0 as const,remoteExecutionSupported:false as const
    }),
    readLiveAppGrant:pmAuthority?installedAppReader:async(ops,s,binding)=>({
      source:'authenticated_github_app_grant_v1' as const,
      grantActive:true as const,factoryOrgId:s.factoryOrgId,projectId:s.projectId,
      repositoryId:s.repositoryId,repositoryOwnerId:s.repositoryOwnerId,
      appInstallationId:s.appInstallationId!,...binding,
      verifiedAtMs:(await ops.databaseNow!()).getTime()
    })
  }):undefined;
  const {port}=await ingress.listen(issuer,nativeAttestor);
  const client={
    port,ca:factoryCert.cert.toString(),cert:pmCert.cert.toString(),
    key:pmCert.key.toString(),
    serverPin:new X509Certificate(factoryCert.cert).fingerprint256.replaceAll(':','').toLowerCase()
  };
  return {s,client,packet:signed(s,privateKey),storage,issuer,ingress,dir,privateKey,nativeKeys,pmAuthority,
    appMembershipReads:()=>appMembershipReads,
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
      const absent=await remoteWorker({...f.client,body,path:'receipt'});
      expect(absent.body.status).toBe('unknown');
      const first=await remoteWorker({...f.client,body});
      expect(first.http).toBe(200);
      expect(first.body.status).toBe('issued');
      const confirmed=await remoteWorker({...f.client,body,path:'receipt'});
      expect(confirmed.body.status).toBe('issued');
      const again=await remoteWorker({...f.client,body});
      expect(again.body.status).toBe('denied');
      const revoked=await remoteWorker({...f.client,body:{
        ...body,kind:'revoke',requestId:randomUUID()
      }});
      expect(revoked.body.status).toBe('revoked');
      const revokedReceipt=await remoteWorker({...f.client,body,path:'receipt'});
      expect(revokedReceipt.body.status).toBe('revoked');
      const after=await remoteWorker({...f.client,body});
      expect(after.body.status).toBe('denied');
    }finally{await f.dispose();}
  });
});
describe('Factory-native GP B1/B2/App scope attestor source',()=>{
  it('is unmounted and refuses missing private authority',()=>{
    expect(FACTORY_GP_PG_NATIVE_SCOPE_ATTESTOR_CAPABILITY).toMatchObject({
      installed:false,enabledByDefault:false,productionReady:false,
      trustedGpSessionProviderInstalled:false
    });
    expect(new FactoryGpPgNativeScopeAttestorV1()).toBeDefined();
    expect(()=>new FactoryGpPgNativeScopeAttestorV1({enabled:true}))
      .toThrow(/REAL_PG_SERVER_TRUST_REQUIRED/);
  });
  it.skipIf(!pgUrl)('signs actual isolated PG18 epoch/project/App binding only with server-held Ed25519 and fresh GP proof',async()=>{
    const f=await fixture();
    const keys=generateKeyPairSync('ed25519');
    const trusted=Object.freeze({privateTest:Symbol('Factory-native-PG')});
    const options={
      enabled:true,storage:f.storage,privateKey:keys.privateKey,
      keyId:'factory-native-test-pinned',
      resolvePrivateScope:async(ctx:object)=>ctx===trusted?f.s:null,
      readAuthenticatedPmV8:async(ops:FactoryStorageOps,_ctx:object,s:GpHandoverScope)=>{
        const now=(await ops.databaseNow!()).getTime();
        return {
          source:'authenticated_current_pm_gp_v8_preconsent_v1' as const,
          actor:'gp' as const,sessionVerified:true as const,
          csrfVerified:true as const,consentUnrevoked:true as const,
          projectSelected:true as const,writerPaused:true as const,
          dispatchPending:0 as const,factoryOrgId:s.factoryOrgId,projectId:s.projectId,
          consentRequestId:s.consentRequestId,manifestId:s.manifestId,
          nonceSha256:s.nonceSha256,writerOwnerId:s.writerOwnerId,
          writerEpoch:s.writerEpoch,ownerEpoch:s.ownerEpoch,
          authorityRevision:s.authorityRevision,policyDigest:s.policyDigest,
          verifiedAtMs:now,writerLeaseExpiresAtMs:now+30000
        };
      },
      readNativeDrain:async(_ops:unknown,s:GpHandoverScope)=>({
        source:'factory_pg_same_transaction_drain_v1' as const,
        projectId:s.projectId,factoryOrgId:s.factoryOrgId,
        coverageArmed:true as const,mappingDigest:s.mappingDigest,
        coverageVersion:s.coverageVersion,
        runningCount:0 as const,parkedCount:0 as const,pendingCount:0 as const,
        unknownCount:0 as const,unsettledEffectCount:0 as const,
        remoteExecutionSupported:false as const
      }),
      readLiveAppGrant:async(ops:FactoryStorageOps,s:GpHandoverScope,binding:{
        projectRepositoryLinkId:string;connectionId:string;
        repositoryRecordId:string;installationRecordId:string
      })=>({
        source:'authenticated_github_app_grant_v1' as const,
        grantActive:true as const,factoryOrgId:s.factoryOrgId,projectId:s.projectId,
        repositoryId:s.repositoryId,repositoryOwnerId:s.repositoryOwnerId,
        appInstallationId:s.appInstallationId!,...binding,
        verifiedAtMs:(await ops.databaseNow!()).getTime()
      })
    };
    try{
      const attestor=new FactoryGpPgNativeScopeAttestorV1(options);
      expect(await attestor.attest(Object.freeze({other:true}))).toBeNull();
      const signed=await attestor.attest(trusted);
      expect(signed?.alg).toBe('Ed25519');
      expect(signed?.payload?.scopeTupleSha256).toBe(gpV9ScopeTupleDigest(f.s));
      const {verify}=await import('node:crypto');
      const data=Buffer.concat([Buffer.from('FACTORY_PG_TO_PM_SCOPE_ATTESTATION_V1\0'),
        Buffer.from(canonical(signed!.payload))]);
      expect(verify(null,data,keys.publicKey,Buffer.from(signed!.signature,'base64url')))
        .toBe(true);
      // Independent OS-process mTLS request reaches signed native PostgreSQL
      // scope attestation. Positive trust callbacks exist only in this test.
      const serverKey=readFileSync(join(f.dir,'factory.local.key'));
      const serverCert=readFileSync(join(f.dir,'factory.local.pem'));
      const clientCert=readFileSync(join(f.dir,'pm.local.pem'));
      const tlsIngress=new FactoryGpPgPrivateMtlsIngress({
        enabled:true,serverKey,serverCert,clientCa:clientCert,
        pinnedClientCertSha256:new X509Certificate(clientCert).fingerprint256
          .replaceAll(':','').toLowerCase(),
        readAuthenticatedGpRevoke:async()=>null
      });
      const wireAttestor=new FactoryGpPgNativeScopeAttestorV1({
        ...options,resolvePrivateScope:tlsIngress.resolvePrivateNativeScope
      });
      try{
        const {port}=await tlsIngress.listen(f.issuer,wireAttestor);
        const wire=await remoteWorker({...f.client,port,path:'native-scope',body:{
          version:'factory_gp_pg_native_scope_request_v1',scope:f.s
        }});
        expect(wire.http).toBe(200);
        const packet=wire.body as unknown as NonNullable<typeof signed>;
        expect(packet.payload.scopeTupleSha256).toBe(gpV9ScopeTupleDigest(f.s));
        expect(verify(null,Buffer.concat([
          Buffer.from('FACTORY_PG_TO_PM_SCOPE_ATTESTATION_V1\0'),
          Buffer.from(canonical(packet.payload))
        ]),keys.publicKey,Buffer.from(packet.signature,'base64url'))).toBe(true);
      }finally{await tlsIngress.close();}
      const mismatched=new FactoryGpPgNativeScopeAttestorV1({
        ...options,resolvePrivateScope:async()=>({...f.s,
          appInstallationId:f.s.appInstallationId!+1})
      });
      expect(await mismatched.attest(trusted)).toBeNull();
    }finally{await f.dispose();}
  });
});

describe('Factory native PG App authority through installed GithubIntegration',()=>{
  it.skipIf(!pgUrl)('reads actual PG link while holding B1 lock; proves live installation grant twice with server-held client',async()=>{
    const f=await fixture();
    try{
      const connection=await f.storage.ops.findOne<{id:string}&Record<string,unknown>>(
        'factory_project_source_control_connections',{factory_project_id:f.s.projectId});
      expect(connection?.id).toBeTruthy();
      const link=await f.storage.ops.findOne<{id:string;repository_id:string}&Record<string,unknown>>(
        'factory_project_repositories',{connection_id:connection!.id});
      const repo=await f.storage.ops.findOne<{id:string;installation_id:string}&Record<string,unknown>>(
        'source_control_repositories',{id:link!.repository_id});
      const ids={projectRepositoryLinkId:link!.id,connectionId:connection!.id,
        repositoryRecordId:repo!.id,installationRecordId:repo!.installation_id};
      let membershipReads=0;
      const installed={
        getAppOctokit:()=>({apps:{getAuthenticated:async()=>({data:{slug:'tek-test'}})}}),
        getInstallationOctokit:(installationId:number)=>{
          expect(installationId).toBe(f.s.appInstallationId);
          return {
            apps:{listReposAccessibleToInstallation:async()=>{
              membershipReads++;
              return {data:{total_count:1,repositories:[{
                id:f.s.repositoryId,full_name:'TheTekTeam/HTAI'
              }]}};
            }},
            repos:{get:async()=>({data:{
              id:f.s.repositoryId,full_name:'TheTekTeam/HTAI',
              owner:{id:f.s.repositoryOwnerId}
            }})}
          };
        }
      };
      const provider=createFactoryGpPgInstalledAppGrantReader({enabled:true,github:installed});
      let result:Awaited<ReturnType<typeof provider>>=null;
      await f.storage.withTransaction(async ops=>{
        await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name,{
          org_id:f.s.factoryOrgId,factory_project_id:f.s.projectId
        },async row=>{
          expect(row.state).toBe('quiescing');
          result=await provider(ops,f.s,ids);
          return null;
        });
      });
      expect(result?.grantActive).toBe(true);
      expect(membershipReads).toBe(1);
      expect(FACTORY_GP_PG_APP_GRANT_PROVIDER).toMatchObject({
        installed:false,enabledByDefault:false,productionReady:false
      });
      const unavailable=createFactoryGpPgInstalledAppGrantReader();
      expect(await unavailable(f.storage.ops,f.s,ids)).toBeNull();
      const revoked=createFactoryGpPgInstalledAppGrantReader({enabled:true,
        github:{...installed,getInstallationOctokit:()=>({
          apps:{listReposAccessibleToInstallation:async()=>({
            data:{total_count:0,repositories:[]}
          })},
          repos:{get:async()=>({data:{
            id:f.s.repositoryId,full_name:'TheTekTeam/HTAI',
            owner:{id:f.s.repositoryOwnerId}
          }})}
        })}
      });
      expect(await revoked(f.storage.ops,f.s,ids)).toBeNull();
    }finally{await f.dispose();}
  });
});

async function availableLocalPort(){
  const server=createNetServer();
  await new Promise<void>((ok,no)=>{server.once('error',no);
    server.listen(0,'127.0.0.1',ok);});
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('No test port');
  const port=address.port;
  await new Promise<void>(ok=>server.close(()=>ok()));
  return port;
}
const pmCrossRoot=process.env.GP_PG_PM_TEST_WORKTREE;
describe('cross-repository GP HTTPS to real Factory PG18 handover',()=>{
  it.skipIf(!pgUrl||!pmCrossRoot)('uses actual PM v9 and Factory locked PG18 lease through pinned mTLS',async()=>{
    const pmAuthorityPort=await availableLocalPort();
    const f=await fixture({withNative:true,pmAuthorityPort});
    try{
      expect(f.nativeKeys).not.toBeNull();
      const pmSigningKeyPath=join(f.dir,'pm-test-signing.key');
      const factorySignerPublicKeyPath=join(f.dir,'factory-test-signing.pub');
      writeFileSync(pmSigningKeyPath,
        f.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
      writeFileSync(factorySignerPublicKeyPath,
        f.nativeKeys!.publicKey.export({format:'pem',type:'spki'}),{mode:0o600});
      const config={
        projectId:f.s.projectId,factoryOrgId:f.s.factoryOrgId,
        repositoryId:f.s.repositoryId,repositoryOwnerId:f.s.repositoryOwnerId,
        appInstallationId:f.s.appInstallationId,
        ownerEpoch:f.s.ownerEpoch,mappingDigest:f.s.mappingDigest,
        port:f.client.port,pmAuthorityPort,pmSigningKeyPath,factorySignerPublicKeyPath,
        factoryCertPath:join(f.dir,'factory.local.pem'),
        pmCertPath:join(f.dir,'pm.local.pem'),
        pmTlsKeyPath:join(f.dir,'pm.local.key')
      };
      const pmTest=join(pmCrossRoot!,'test/goal-pg-native-mtls-scope-reader.test.mjs');
      const child=spawn(process.execPath,['--test',
        '--test-name-pattern=CROSS-REPO actual Factory PG18',pmTest],{
        env:{...process.env,GP_PG_FACTORY_NATIVE_WIRE_TEST_CONFIG:JSON.stringify(config)},
        stdio:['ignore','pipe','pipe']
      });
      const result=await new Promise<{code:number|null;output:string}>((yes,no)=>{
        let output='';
        child.stdout.on('data',x=>output+=String(x).slice(0,8000));
        child.stderr.on('data',x=>output+=String(x).slice(0,8000));
        child.once('error',no);
        child.once('close',code=>yes({code,output:output.slice(-7000)}));
      });
      expect(result.code,result.output).toBe(0);
      const rows=await f.storage.ops.findMany<{id:string}&Record<string,unknown>>(
        FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA.name,
        {org_id:f.s.factoryOrgId,factory_project_id:f.s.projectId});
      expect(rows.length).toBe(1);
      expect(f.appMembershipReads()).toBeGreaterThanOrEqual(2);
    }finally{await f.dispose();}
  });
});
