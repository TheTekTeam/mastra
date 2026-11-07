import type { FactoryStorageOps } from '@mastra/core/storage';
import type { ReadLiveProjectAppGrant } from './gp-pg-lease-issuer.js';
import type { GpHandoverScope } from './gp-pg-handover-crypto.js';
import { installationGrantsRepository } from '../../../routes/source-control-app-evidence.js';
import type { Binding } from '../../../routes/source-control-app-evidence.js';

export const FACTORY_GP_PG_APP_GRANT_PROVIDER = Object.freeze({
  installed:false,enabledByDefault:false,productionReady:false,
  requiresInstalledFactoryGithubApp:true,acceptsBrowserGrant:false
});
const positive=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
type Link=Record<string,unknown>&{id:string;connection_id:string;repository_id:string};
type Connection=Record<string,unknown>&{id:string;factory_project_id:string;
  installation_id:string;integration_id:string};
type Repo=Record<string,unknown>&{id:string;installation_id:string;
  external_id:string;slug:string};
type Installation=Record<string,unknown>&{id:string;org_id:string;
  integration_id:string;external_id:string};
type ServerGithub={
  getAppOctokit:()=>{apps:{
    getAuthenticated:()=>Promise<{data:{slug?:unknown}}>;
  }};
  getInstallationOctokit:(installationId:number)=> {
    apps:{listReposAccessibleToInstallation:(params:{per_page:number})=>
      Promise<{data:{total_count?:unknown;repositories?:unknown}}>};
    repos:{get:(params:{owner:string;repo:string})=>
      Promise<{data:{id?:unknown;full_name?:unknown;owner?:{id?:unknown}}}>};
  };
};
type NativeIds={projectRepositoryLinkId:string;connectionId:string;
  repositoryRecordId:string;installationRecordId:string};

async function lockedBinding(ops:FactoryStorageOps,s:GpHandoverScope,b:NativeIds):
 Promise<Binding|null>{
  const link=await ops.findOne<Link>('factory_project_repositories',{
    id:b.projectRepositoryLinkId,connection_id:b.connectionId,
    repository_id:b.repositoryRecordId});
  const connection=await ops.findOne<Connection>(
    'factory_project_source_control_connections',{
      id:b.connectionId,factory_project_id:s.projectId,
      installation_id:b.installationRecordId,integration_id:'github'
    });
  const repo=await ops.findOne<Repo>('source_control_repositories',{
    id:b.repositoryRecordId,installation_id:b.installationRecordId});
  const install=await ops.findOne<Installation>('source_control_installations',{
    id:b.installationRecordId,org_id:s.factoryOrgId,integration_id:'github'});
  const slug=repo?.slug;
  if(!link||!connection||!repo||!install||
    !positive(s.repositoryId)||!positive(s.repositoryOwnerId)||
    !positive(s.appInstallationId)||
    repo.external_id!==String(s.repositoryId)||
    install.external_id!==String(s.appInstallationId)||
    typeof slug!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(slug))return null;
  return {
    factoryOrgId:s.factoryOrgId,projectId:s.projectId,
    projectRepositoryLinkId:link.id,connectionId:connection.id,
    repositoryRecordId:repo.id,repositoryFullName:slug,
    repositoryNumericId:s.repositoryId,installationRecordId:install.id,
    installationId:s.appInstallationId!,
    projectAutomationRevision:s.nativeAutomationRevision,
    bindingDigest:'not-a-grant'
  };
}

/**
 * Genuine installed Factory GitHub App proof, not a caller-supplied identity
 * claim. Must be constructed with Factory's EXISTING server-held GithubIntegration
 * credentials. Invoked within the Factory native B1 epoch-row PostgreSQL
 * transaction; it rechecks exact project/link/install before and after
 * independent installation-authenticated GitHub membership and repos.get.
 *
 * No Factory service imports or enables this factory by default.
 */
export function createFactoryGpPgInstalledAppGrantReader({
  enabled=false,github
}:{
  enabled?:boolean;github?:ServerGithub;
}={}):ReadLiveProjectAppGrant {
  if(!enabled)return async()=>null;
  if(!github||typeof github.getAppOctokit!=='function'||
    typeof github.getInstallationOctokit!=='function')
    throw new Error('GP_PG_INSTALLED_GITHUB_APP_REQUIRED');
  return async(ops,s,b)=>{
    if(!ops.databaseNow||!positive(s.appInstallationId))return null;
    try{
      const before=await lockedBinding(ops,s,b);
      if(!before)return null;
      const [owner,repo]=before.repositoryFullName.split('/');
      if(!owner||!repo)return null;
      // Calls are installation/App-authenticated via the *existing* Factory
      // integration. A public repos.get alone never proves installation grant.
      const installation=github.getInstallationOctokit(before.installationId);
      const app=github.getAppOctokit();
      const [grant,details,appIdentity]=await Promise.all([
        installation.apps.listReposAccessibleToInstallation({per_page:100}),
        installation.repos.get({owner,repo}),
        app.apps.getAuthenticated()
      ]);
      if(!installationGrantsRepository(grant,before)||
        details.data.id!==s.repositoryId||
        typeof details.data.full_name!=='string'||
        details.data.full_name.toLowerCase()!==before.repositoryFullName.toLowerCase()||
        details.data.owner?.id!==s.repositoryOwnerId||
        typeof appIdentity.data.slug!=='string'||!appIdentity.data.slug)return null;
      const after=await lockedBinding(ops,s,b);
      if(!after||JSON.stringify(after)!==JSON.stringify(before))return null;
      const t=(await ops.databaseNow()).getTime();
      return {
        source:'authenticated_github_app_grant_v1',grantActive:true,
        factoryOrgId:s.factoryOrgId,projectId:s.projectId,
        repositoryId:s.repositoryId,repositoryOwnerId:s.repositoryOwnerId,
        appInstallationId:s.appInstallationId!,
        projectRepositoryLinkId:b.projectRepositoryLinkId,
        connectionId:b.connectionId,repositoryRecordId:b.repositoryRecordId,
        installationRecordId:b.installationRecordId,
        verifiedAtMs:t
      };
    }catch{return null;}
  };
}
