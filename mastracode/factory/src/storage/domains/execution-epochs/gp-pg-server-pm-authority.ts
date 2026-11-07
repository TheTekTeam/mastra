import { randomUUID, verify, X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { FactoryStorageOps } from '@mastra/core/storage';
import type { GpHandoverScope } from './gp-pg-handover-crypto.js';
import { gpV9ScopeTupleDigest } from './gp-pg-handover-crypto.js';
import type { ReadAuthenticatedPmAuthority } from './gp-pg-lease-issuer.js';
import type { ReadPrivatePmV8Preflight } from './gp-pg-native-scope-attestor.js';

export const FACTORY_GP_PG_PM_AUTHORITY_CLIENT=Object.freeze({
  installed:false,enabledByDefault:false,productionReady:false,
  requiresLivePmSessionReadback:true,acceptsCallerGpClaims:false
});
const DOMAIN=Buffer.from('PM_TO_FACTORY_PRIVATE_GP_AUTHORITY_V1\0');
const PIN=/^[a-f0-9]{64}$/;
const KEY=/^[a-z0-9][a-z0-9._:-]{0,79}$/;
const FIELDS=['version','audience','keyId','phase','challengeId',
  'scopeTupleSha256','issuedAtMs','expiresAtMs','projectId','factoryOrgId',
  'consentRequestId','manifestId','nonceSha256','writerOwnerId',
  'writerEpoch','ownerEpoch','authorityRevision','policyDigest','mode',
  'writerHeartbeatAtMs','writerLeaseExpiresAtMs'];
const own=(x:unknown):x is Record<string,unknown>=>x!==null&&
  typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x:unknown,fields:string[]):x is Record<string,unknown>=>own(x)&&
  Object.keys(x).length===fields.length&&
  Object.keys(x).every(k=>fields.includes(k));
const positive=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
function canonical(x:unknown):string{
  if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
  if(typeof x==='number'&&Number.isSafeInteger(x))return String(x);
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(!own(x))throw new Error('FACTORY_PM_AUTHORITY_NONCANONICAL');
  const keys=Object.keys(x).sort();
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(x,key);
    if(!descriptor||!('value' in descriptor))throw new Error('FACTORY_PM_AUTHORITY_ACCESSOR');
  }
  return '{'+keys.map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
type Tls={
  origin:string;serverName:string;ca:string|Buffer;
  clientCert:string|Buffer;clientKey:string|Buffer;
  serverCertSha256:string;timeoutMs:number;
};
function post(tls:Tls,body:unknown):Promise<unknown>{
  const data=JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=httpsRequest(new URL('/private/pm-gp-pg/v1/authority',tls.origin),{
      method:'POST',servername:tls.serverName,rejectUnauthorized:true,
      ca:tls.ca,key:tls.clientKey,cert:tls.clientCert,timeout:tls.timeoutMs,
      headers:{'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(data)},
      checkServerIdentity(host,peer){
        const fingerprint=new X509Certificate(peer.raw).fingerprint256
          .replaceAll(':','').toLowerCase();
        return host===tls.serverName&&fingerprint===tls.serverCertSha256?
          undefined:new Error('FACTORY_PM_AUTHORITY_TLS_PIN_FAILED');
      }
    },res=>{
      let bytes=0,txt='';
      res.on('data',chunk=>{
        bytes+=chunk.length;
        if(bytes>8192)req.destroy(new Error('FACTORY_PM_AUTHORITY_OVERSIZE'));
        else txt+=String(chunk);
      });
      res.once('end',()=>{
        if(res.statusCode!==200)return reject(new Error('FACTORY_PM_AUTHORITY_DENIED'));
        try{resolve(JSON.parse(txt));}catch{reject(new Error('FACTORY_PM_AUTHORITY_INVALID_JSON'));}
      });
    });
    req.once('error',reject);
    req.once('timeout',()=>req.destroy(new Error('FACTORY_PM_AUTHORITY_TIMEOUT')));
    req.end(data);
  });
}

/**
 * Genuine private PM v8/v9 authority verification over mutually pinned mTLS
 * and a server-held PM Ed25519 key. PM's private endpoint reads actual
 * durable v8/v9 SQLite, current singleton writer, durable revocations and
 * the original live GP HTTPS operator session map; none are HTTP body claims.
 *
 * Must be called while Factory holds the B1 PG epoch lock. Unregistered by
 * default and not installed in the production service.
 */
export class FactoryGpPgPrivatePmAuthorityReaderV1 {
  #enabled:boolean;#tls?:Tls;#key?:KeyObject;#keyId?:string;
  constructor({enabled=false,origin,serverName,ca,clientCert,clientKey,
    serverCertSha256,pmPublicKey,pmKeyId,timeoutMs=3000}:{
      enabled?:boolean;origin?:string;serverName?:string;
      ca?:string|Buffer;clientCert?:string|Buffer;clientKey?:string|Buffer;
      serverCertSha256?:string;pmPublicKey?:KeyObject;pmKeyId?:string;
      timeoutMs?:number;
    }={}){
    this.#enabled=enabled===true;
    if(!this.#enabled)return;
    const url=new URL(origin??'about:blank');
    if(url.protocol!=='https:'||url.hostname!=='127.0.0.1'||
      url.username||url.password||url.search||url.hash||
      (url.pathname&&url.pathname!=='/')||
      !serverName||serverName.length<3||!ca||!clientCert||!clientKey||
      !PIN.test(serverCertSha256??'')||!KEY.test(pmKeyId??'')||
      pmPublicKey?.type!=='public'||pmPublicKey.asymmetricKeyType!=='ed25519'||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)
      throw new Error('FACTORY_PM_AUTHORITY_REAL_PINNED_PM_REQUIRED');
    this.#tls={origin:origin!,serverName,ca,clientCert,clientKey,
      serverCertSha256:serverCertSha256!,timeoutMs};
    this.#key=pmPublicKey;this.#keyId=pmKeyId;
  }
  async #read(ops:FactoryStorageOps,phase:'preconsent'|'consumed',
    scope:GpHandoverScope){
    if(!this.#enabled||!this.#tls||!ops.databaseNow)return null;
    const challengeId=randomUUID();
    try{
      const raw=await post(this.#tls,{
        version:'factory_pm_gp_authority_readback_v1',phase,challengeId,scope
      });
      if(!exact(raw,['alg','payload','signature'])||raw.alg!=='Ed25519'||
        !exact(raw.payload,FIELDS)||typeof raw.signature!=='string'||
        !/^[A-Za-z0-9_-]{86}$/.test(raw.signature))return null;
      const p=raw.payload!;
      const now=(await ops.databaseNow()).getTime();
      // v2 semantic contract is a same-DB durable native-intent pause plus
      // zero unsettled dispatch under PM BEGIN IMMEDIATE. Never accept v1,
      // whose signature did not establish these facts.
      if(p.version!=='pm_gp_pg_private_authority_v2'||
        p.audience!=='factory_pg_epoch_locked_handover'||
        p.keyId!==this.#keyId||p.phase!==phase||p.challengeId!==challengeId||
        p.scopeTupleSha256!==gpV9ScopeTupleDigest(scope)||
        p.projectId!==scope.projectId||p.factoryOrgId!==scope.factoryOrgId||
        p.consentRequestId!==scope.consentRequestId||
        p.manifestId!==scope.manifestId||p.nonceSha256!==scope.nonceSha256||
        p.writerOwnerId!==scope.writerOwnerId||
        p.writerEpoch!==scope.writerEpoch||p.ownerEpoch!==scope.ownerEpoch||
        p.authorityRevision!==scope.authorityRevision||
        p.policyDigest!==scope.policyDigest||p.mode!==scope.mode||
        !positive(p.issuedAtMs)||p.issuedAtMs>now||
        !positive(p.expiresAtMs)||p.expiresAtMs<=now||
        p.expiresAtMs-p.issuedAtMs>5000||
        !positive(p.writerHeartbeatAtMs)||p.writerHeartbeatAtMs>now||
        now-p.writerHeartbeatAtMs>120000||
        !positive(p.writerLeaseExpiresAtMs)||p.writerLeaseExpiresAtMs<=now)return null;
      if(!verify(null,Buffer.concat([DOMAIN,Buffer.from(canonical(p))]),
        this.#key!,Buffer.from(raw.signature,'base64url')))return null;
      return p;
    }catch{return null;}
  }
  readPreconsent:ReadPrivatePmV8Preflight=async(ops,_invocation,scope)=>{
    const p=await this.#read(ops,'preconsent',scope);
    if(!p)return null;
    return {
      source:'authenticated_current_pm_gp_v8_preconsent_v1',
      // Derived from authenticated v2 PM proof, not a body assertion.
      actor:'gp',sessionVerified:true,csrfVerified:true,
      consentUnrevoked:true,projectSelected:true,writerPaused:true,
      dispatchPending:0,factoryOrgId:scope.factoryOrgId,projectId:scope.projectId,
      consentRequestId:scope.consentRequestId,manifestId:scope.manifestId,
      nonceSha256:scope.nonceSha256,writerOwnerId:scope.writerOwnerId,
      writerEpoch:scope.writerEpoch,ownerEpoch:scope.ownerEpoch,
      authorityRevision:scope.authorityRevision,policyDigest:scope.policyDigest,
      verifiedAtMs:p.issuedAtMs as number,
      writerLeaseExpiresAtMs:p.writerLeaseExpiresAtMs as number
    };
  };
  readConsumed:ReadAuthenticatedPmAuthority=async(ops,_invocation,scope)=>{
    const p=await this.#read(ops,'consumed',scope);
    if(!p)return null;
    return {
      source:'authenticated_live_pm_v9_authority_v1',
      actor:'gp',current:true,gpSessionVerified:true,
      consentUnrevoked:true,consentConsumedOnce:true,
      projectSelected:true,projectMembershipVerified:true,writerPaused:true,
      dispatchPending:0,projectId:scope.projectId,factoryOrgId:scope.factoryOrgId,
      consentRequestId:scope.consentRequestId,manifestId:scope.manifestId,
      nonceSha256:scope.nonceSha256,writerOwnerId:scope.writerOwnerId,
      writerEpoch:scope.writerEpoch,ownerEpoch:scope.ownerEpoch,
      authorityRevision:scope.authorityRevision,policyDigest:scope.policyDigest,
      mode:scope.mode,verifiedAtMs:p.issuedAtMs as number,
      heartbeatAtMs:p.writerHeartbeatAtMs as number,
      writerLeaseExpiresAtMs:p.writerLeaseExpiresAtMs as number
    };
  };
}
