import { sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { PgFactoryStorage } from '@mastra/pg';
import type { FactoryStorageOps } from '@mastra/core/storage';

import { gpV9ScopeTupleDigest } from './gp-pg-handover-crypto.js';
import type { GpHandoverScope } from './gp-pg-handover-crypto.js';
import type { ReadLiveProjectAppGrant, ReadNativeDrainInPgTransaction }
  from './gp-pg-lease-issuer.js';
import { FACTORY_EXECUTION_EPOCHS_SCHEMA, FACTORY_EXECUTION_RESERVATIONS_SCHEMA }
  from './base.js';

export const FACTORY_GP_PG_NATIVE_SCOPE_ATTESTOR_CAPABILITY = Object.freeze({
  installed: false, enabledByDefault: false, productionReady: false,
  nativePg: true, trustedGpSessionProviderInstalled: false,
  githubAppGrantProviderInstalled: false, autonomousWritesEnabled: false,
});
const DOMAIN = Buffer.from('FACTORY_PG_TO_PM_SCOPE_ATTESTATION_V1\0');
const KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const HEX = /^[a-f0-9]{64}$/;
const positive = (x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
type Epoch = Record<string,unknown> & {
  owner_epoch:string|null;state:string;fence_armed:boolean;
  coverage_version:number;mapping_digest:string|null;revision:number;
};
type Project = Record<string,unknown> & {
  automation_revision:number;auto_run_enabled:boolean;auto_approve_plans:boolean;
};
type Connection = Record<string,unknown> & {
  id:string;integration_id:string;installation_id:string;
};
type Link = Record<string,unknown> & {id:string;connection_id:string;repository_id:string};
type Repo = Record<string,unknown> & {id:string;installation_id:string;external_id:string};
type Installation = Record<string,unknown> & {
  id:string;org_id:string;integration_id:string;external_id:string;
};
export type PrivateNativeScopeResolver=(invocation:object)=>
 Promise<GpHandoverScope|null>;
export type ReadPrivatePmV8Preflight=(ops:FactoryStorageOps,invocation:object,scope:GpHandoverScope)=>
 Promise<{
   source:'authenticated_current_pm_gp_v8_preconsent_v1';
   actor:'gp';sessionVerified:true;csrfVerified:true;consentUnrevoked:true;
   projectSelected:true;writerPaused:true;dispatchPending:0;
   factoryOrgId:string;projectId:string;consentRequestId:string;
   manifestId:string;nonceSha256:string;writerOwnerId:string;
   writerEpoch:number;ownerEpoch:string;authorityRevision:number;
   policyDigest:string;verifiedAtMs:number;writerLeaseExpiresAtMs:number;
 }|null>;
const own=(x:unknown):x is Record<string,unknown>=>
 !!x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
function canonical(x:unknown):string{
  if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
  if(typeof x==='number'&&Number.isSafeInteger(x))return String(x);
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(!own(x))throw new Error('NATIVE_SCOPE_NONCANONICAL');
  const keys=Object.keys(x).sort();
  for(const key of keys){
    const p=Object.getOwnPropertyDescriptor(x,key);
    if(!p||!('value' in p))throw new Error('NATIVE_SCOPE_ACCESSOR');
  }
  return '{'+keys.map(key=>JSON.stringify(key)+':'+canonical(x[key])).join(',')+'}';
}

/**
 * Server-private Factory Ed25519 signer for an ACTUAL PostgreSQL-locked B1/B2
 * project scope, never a HTTP body-supplied claim. This class is not mounted
 * in Factory; no live private key or PM/GP provider is configured.
 */
export class FactoryGpPgNativeScopeAttestorV1 {
  #enabled:boolean;#storage?:PgFactoryStorage;#key?:KeyObject;#keyId?:string;
  #resolve?:PrivateNativeScopeResolver;#pm?:ReadPrivatePmV8Preflight;
  #grant?:ReadLiveProjectAppGrant;#drain?:ReadNativeDrainInPgTransaction;
  constructor({enabled=false,storage,privateKey,keyId,resolvePrivateScope,
    readAuthenticatedPmV8,readLiveAppGrant,readNativeDrain}:{
      enabled?:boolean;storage?:PgFactoryStorage;privateKey?:KeyObject;
      keyId?:string;resolvePrivateScope?:PrivateNativeScopeResolver;
      readAuthenticatedPmV8?:ReadPrivatePmV8Preflight;
      readLiveAppGrant?:ReadLiveProjectAppGrant;
      readNativeDrain?:ReadNativeDrainInPgTransaction;
    }={}){
    this.#enabled=enabled===true;
    if(!this.#enabled)return;
    if(!(storage instanceof PgFactoryStorage)||privateKey?.type!=='private'||
      privateKey.asymmetricKeyType!=='ed25519'||!KEY.test(keyId??'')||
      !resolvePrivateScope||!readAuthenticatedPmV8||
      !readLiveAppGrant||!readNativeDrain)
      throw new Error('NATIVE_SCOPE_REAL_PG_SERVER_TRUST_REQUIRED');
    this.#storage=storage;this.#key=privateKey;this.#keyId=keyId;
    this.#resolve=resolvePrivateScope;this.#pm=readAuthenticatedPmV8;
    this.#grant=readLiveAppGrant;this.#drain=readNativeDrain;
  }

  async attest(privateInvocation:object):Promise<{
    payload:Record<string,unknown>;signature:string;alg:'Ed25519';
  }|null>{
    if(!this.#enabled||!this.#storage||!privateInvocation||
      typeof privateInvocation!=='object')return null;
    const scope=await this.#resolve!(privateInvocation);
    if(!scope?.projectId||!scope.factoryOrgId||!positive(scope.repositoryId)||
      !positive(scope.repositoryOwnerId)||!positive(scope.appInstallationId)||
      scope.coverageVersion!==1||!HEX.test(scope.mappingDigest??''))
      return null;
    try{
      return await this.#storage.withTransaction(async ops=>{
        if(!ops.databaseNow)return null;
        let attestation:null|{
          payload:Record<string,unknown>;signature:string;alg:'Ed25519';
        }=null;
        const where={org_id:scope.factoryOrgId,factory_project_id:scope.projectId};
        await ops.updateAtomic<Epoch>(FACTORY_EXECUTION_EPOCHS_SCHEMA.name,where,async epoch=>{
          if(epoch.state!=='quiescing'||epoch.fence_armed!==true||
            epoch.owner_epoch!==scope.ownerEpoch||
            epoch.coverage_version!==scope.coverageVersion||
            epoch.mapping_digest!==scope.mappingDigest)return null;
          const pm=await this.#pm!(ops,privateInvocation,scope);
          // Evidence may be generated during callback; compare with fresh DB
          // time after it returns, never a stale timestamp from beforehand.
          const t=(await ops.databaseNow!()).getTime();
          if(!pm||pm.source!=='authenticated_current_pm_gp_v8_preconsent_v1'||
            pm.actor!=='gp'||pm.sessionVerified!==true||pm.csrfVerified!==true||
            pm.consentUnrevoked!==true||pm.projectSelected!==true||
            pm.writerPaused!==true||pm.dispatchPending!==0||
            pm.factoryOrgId!==scope.factoryOrgId||pm.projectId!==scope.projectId||
            pm.consentRequestId!==scope.consentRequestId||
            pm.manifestId!==scope.manifestId||pm.nonceSha256!==scope.nonceSha256||
            pm.writerOwnerId!==scope.writerOwnerId||
            pm.writerEpoch!==scope.writerEpoch||pm.ownerEpoch!==scope.ownerEpoch||
            pm.authorityRevision!==scope.authorityRevision||
            pm.policyDigest!==scope.policyDigest||
            !positive(pm.verifiedAtMs)||pm.verifiedAtMs>t||t-pm.verifiedAtMs>30000||
            !positive(pm.writerLeaseExpiresAtMs)||pm.writerLeaseExpiresAtMs<=t)
            return null;
          let projectLocked=false;
          await ops.updateAtomic<Project>('factory_projects',{
            id:scope.projectId,org_id:scope.factoryOrgId
          },p=>{
            if(p.auto_run_enabled||p.auto_approve_plans||
              p.automation_revision!==scope.nativeAutomationRevision)return null;
            projectLocked=true;
            return {automation_revision:p.automation_revision};
          });
          if(!projectLocked)return null;
          const connections=(await ops.findMany<Connection>(
            'factory_project_source_control_connections',
            {factory_project_id:scope.projectId}
          )).filter(c=>c.integration_id==='github');
          if(connections.length!==1)return null;
          const connection=connections[0]!;
          const links=await ops.findMany<Link>('factory_project_repositories',
            {connection_id:connection.id});
          if(links.length!==1)return null;
          const link=links[0]!;
          const repo=await ops.findOne<Repo>('source_control_repositories',
            {id:link.repository_id,installation_id:connection.installation_id});
          const installation=await ops.findOne<Installation>('source_control_installations',
            {id:connection.installation_id,org_id:scope.factoryOrgId,integration_id:'github'});
          if(!repo||!installation||repo.external_id!==String(scope.repositoryId)||
            installation.external_id!==String(scope.appInstallationId))return null;
          const binding={projectRepositoryLinkId:link.id,connectionId:connection.id,
            repositoryRecordId:repo.id,installationRecordId:installation.id};
          const app=await this.#grant!(ops,scope,binding);
          const now=(await ops.databaseNow!()).getTime();
          if(!app||app.source!=='authenticated_github_app_grant_v1'||
            app.grantActive!==true||app.factoryOrgId!==scope.factoryOrgId||
            app.projectId!==scope.projectId||app.repositoryId!==scope.repositoryId||
            app.repositoryOwnerId!==scope.repositoryOwnerId||
            app.appInstallationId!==scope.appInstallationId||
            app.projectRepositoryLinkId!==link.id||app.connectionId!==connection.id||
            app.repositoryRecordId!==repo.id||app.installationRecordId!==installation.id||
            !positive(app.verifiedAtMs)||app.verifiedAtMs>now||
            now-app.verifiedAtMs>30000)return null;
          const drain=await this.#drain!(ops,scope);
          if(!drain||drain.source!=='factory_pg_same_transaction_drain_v1'||
            drain.projectId!==scope.projectId||drain.factoryOrgId!==scope.factoryOrgId||
            drain.coverageArmed!==true||
            drain.mappingDigest!==scope.mappingDigest||
            drain.coverageVersion!==1||drain.runningCount!==0||
            drain.parkedCount!==0||drain.pendingCount!==0||
            drain.unknownCount!==0||drain.unsettledEffectCount!==0||
            drain.remoteExecutionSupported!==false)return null;
          const reservations=await ops.findMany<{state:string}&Record<string,unknown>>(
            FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name,where);
          if(reservations.some(r=>r.state!=='settled'))return null;
          if(await ops.findOne('factory_execution_unknown_origins',
            {org_id:scope.factoryOrgId}))return null;
          // Recheck live GitHub App installation evidence AND the current PM
          // writer after external calls, immediately before private signing.
          const finalApp=await this.#grant!(ops,scope,binding);
          const finalPm=await this.#pm!(ops,privateInvocation,scope);
          const finalAt=(await ops.databaseNow!()).getTime();
          if(!finalApp||finalApp.grantActive!==true||
            finalApp.repositoryId!==app.repositoryId||
            finalApp.repositoryOwnerId!==app.repositoryOwnerId||
            finalApp.appInstallationId!==app.appInstallationId||
            finalApp.projectRepositoryLinkId!==app.projectRepositoryLinkId||
            !positive(finalApp.verifiedAtMs)||finalApp.verifiedAtMs>finalAt||
            finalAt-finalApp.verifiedAtMs>30000||
            !finalPm||finalPm.consentUnrevoked!==true||
            finalPm.writerEpoch!==pm.writerEpoch||
            finalPm.ownerEpoch!==pm.ownerEpoch||
            finalPm.authorityRevision!==pm.authorityRevision||
            !positive(finalPm.verifiedAtMs)||finalPm.verifiedAtMs>finalAt||
            finalAt-finalPm.verifiedAtMs>30000||
            finalPm.writerLeaseExpiresAtMs<=finalAt)return null;
          const native={
            projectId:scope.projectId,factoryOrgId:scope.factoryOrgId,
            ownerEpoch:scope.ownerEpoch,mappingDigest:scope.mappingDigest,
            coverageVersion:1,fenceArmed:true,
            nativeAutomationRevision:scope.nativeAutomationRevision,
            nativeAutoRunEnabled:false,nativeAutoApprovePlansEnabled:false,
            runningCount:0,parkedCount:0,pendingCount:0,unknownCount:0,
            unsettledEffectCount:0,remoteExecutionSupported:false,
            providerEagerSupported:false,appGrantActive:true,
            repositoryId:scope.repositoryId,
            repositoryOwnerId:scope.repositoryOwnerId,
            appInstallationId:scope.appInstallationId
          };
          const payload={
            version:'factory_pg_scope_attestation_v1',
            audience:'gp_pg_handover_controller',keyId:this.#keyId!,
            issuedAtMs:finalAt,expiresAtMs:finalAt+30000,
            scopeTupleSha256:gpV9ScopeTupleDigest(scope),
            scope,native
          };
          const bytes=Buffer.concat([DOMAIN,Buffer.from(canonical(payload))]);
          attestation={alg:'Ed25519',payload,
            signature:sign(null,bytes,this.#key!).toString('base64url')};
          // A read-only attestation is not an issued manager lease.
          return null;
        });
        return attestation;
      });
    }catch{return null;}
  }
}
