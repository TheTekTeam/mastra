#!/usr/bin/env node
// Trusted CI disposable PG18 HTTP acceptance. No production credentials,
// external network listener, project mutation, or persistent Docker volume.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '../..');
const releaseRoot = path.resolve(process.env.FACTORY_QA_RELEASE || webRoot);
const pgImage = 'postgres@sha256:300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736';
const hostname = '127.0.0.1';
const appPort = numericPort('FACTORY_QA_APP_PORT', 15503);
const pgPort = numericPort('FACTORY_QA_PG_PORT', 55439);
const base = 'http://' + hostname + ':' + appPort;
const random = crypto.randomBytes(12).toString('hex');
const containerName = 'factory-auth-ci-' + process.pid + '-' + random.slice(0, 6);
const dbUser = 'factory_qa';
const dbName = 'factory_auth_qa';
const dbPassword = crypto.randomBytes(24).toString('base64url');
const authSecret = crypto.randomBytes(32).toString('hex');
const encryptionKey = crypto.randomBytes(32).toString('base64');
const email = 'factory-qa-' + random + '@example.invalid';
const password = crypto.randomBytes(18).toString('base64url') + 'A!';
const statuses = {};
let child;
let containerStarted = false;
let childOutput = '';
let childOutputBytes = 0;

function gate(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { qaCode: reason });
}
function numericPort(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  gate(/^[0-9]{4,5}$/.test(raw), 'invalid_qa_port');
  const number = Number(raw);
  gate(number > 1024 && number <= 65535, 'invalid_qa_port');
  return number;
}
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  gate(!result.error && result.status === 0, 'qa_docker_operation_failed');
  return (result.stdout || '').trim();
}
function sourcePin() {
  gate(releaseRoot === webRoot ||
    (releaseRoot.startsWith('/home/gp/projects/.worktrees/') &&
      fs.existsSync(path.join(releaseRoot, '.factory-receipt-candidate'))),
  'qa_target_must_be_disposable_source_or_marked_worktree');
  const expectedHead = process.env.FACTORY_QA_EXPECTED_HEAD;
  if (expectedHead) {
    gate(/^[a-f0-9]{40}$/.test(expectedHead), 'qa_expected_head_invalid');
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    gate(actual === expectedHead, 'qa_source_head_changed');
  }
  const webEntry = path.join(releaseRoot, 'src/mastra/index.ts');
  const cli = path.join(releaseRoot, 'node_modules/mastra/dist/index.js');
  const output = path.join(releaseRoot, '.mastra/output');
  const sourceFactory = path.join(repoRoot, 'mastracode/factory/dist');
  gate(fs.statSync(webEntry).isFile() && fs.statSync(cli).isFile() &&
    fs.statSync(output).isDirectory(), 'qa_source_build_missing');
  const entry = fs.readFileSync(webEntry, 'utf8');
  gate(entry.includes("MASTRACODE_BETTER_AUTH_SIGNUP_ENABLED === 'true'") &&
    entry.includes('new MastraAuthBetterAuth') &&
    entry.indexOf('new MastraAuthWorkos') < entry.indexOf('new MastraAuthBetterAuth'),
  'qa_secure_signup_source_contract_missing');
  const generated = fs.readFileSync(path.join(output, 'mastra.mjs'), 'utf8');
  gate(generated.includes('MASTRACODE_BETTER_AUTH_SIGNUP_ENABLED') &&
    generated.includes('MastraAuthBetterAuth'), 'qa_secure_signup_generated_missing');
  // Generator must not silently replace a source-built Factory0.25 package
  // with a same-semver public registry package. Compare both installed roots
  // against compiled source bytes for native receipt and automation CAS.
  const files = ['routes/automation-runs.js', 'storage/domains/projects/base.js'];
  for (const subpath of files) {
    const source = path.join(sourceFactory, subpath);
    const sourceHash = hash(source);
    for (const root of [releaseRoot, output]) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const spec = manifest.dependencies?.['@mastra/factory'];
      gate(typeof spec === 'string' && spec.startsWith('file:'),
        'qa_factory_not_source_tar_pinned');
      const lock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
      gate(lock.includes('specifier: ' + spec) &&
        lock.includes("'@mastra/factory@file:"), 'qa_factory_lock_pin_missing');
      const installed = path.join(root, 'node_modules/@mastra/factory/dist', subpath);
      gate(hash(installed) === sourceHash, 'qa_factory_native_source_mismatch');
    }
  }
  return { cli, output, sourceHash: hash(webEntry), generatedHash: hash(path.join(output, 'mastra.mjs')) };
}
async function portOccupied(port) {
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: hostname, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}
async function http(method, route, payload, cookie) {
  const response = await fetch(base + route, {
    method, headers: {
      'Content-Type': 'application/json', Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(7000), redirect: 'manual',
  });
  const raw = await response.text();
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  const cookies = response.headers.getSetCookie?.() ?? [];
  return {
    status: response.status, json,
    cookie: cookies.map(value => value.split(';')[0]).filter(Boolean).join('; '),
    mime: response.headers.get('content-type') ?? '',
  };
}
async function waitDatabase() {
  for (let attempt = 0; attempt < 90; attempt++) {
    const ready = spawnSync('docker', [
      'exec', containerName, 'pg_isready', '-U', dbUser, '-d', dbName,
    ], { encoding: 'utf8', stdio: 'ignore', timeout: 3000 });
    if (ready.status === 0) return;
    await delay(500);
  }
  throw Object.assign(new Error('qa_pg18_not_ready'), { qaCode: 'qa_pg18_not_ready' });
}
async function waitApp() {
  for (let attempt = 0; attempt < 360; attempt++) {
    gate(child && child.exitCode === null && !child.killed, 'qa_app_exited_before_ready');
    try {
      const result = await http('GET', '/auth/me');
      if (![502, 503].includes(result.status)) return;
    } catch {}
    await delay(250);
  }
  throw Object.assign(new Error('qa_app_timeout'), { qaCode: 'qa_app_timeout' });
}
async function stopApp() {
  if (!child || child.exitCode !== null) { child = null; return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await delay(200);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await delay(300);
  }
  child = null;
}
async function startApp(cli, environment, enableSignUp) {
  const env = { ...environment };
  if (enableSignUp) env.MASTRACODE_BETTER_AUTH_SIGNUP_ENABLED = 'true';
  else delete env.MASTRACODE_BETTER_AUTH_SIGNUP_ENABLED;
  child = spawn(process.execPath, [cli, 'start', '--dir', '.mastra/output'], {
    cwd: releaseRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      childOutputBytes += chunk.length;
      if (childOutput.length < 65536) {
        childOutput += chunk.toString('utf8').slice(0, 65536 - childOutput.length);
      }
    });
  }
  await waitApp();
}
async function main() {
  gate(appPort !== pgPort, 'qa_ports_identical');
  gate(!(await portOccupied(appPort)) && !(await portOccupied(pgPort)),
    'qa_port_already_in_use');
  const { cli, sourceHash, generatedHash } = sourcePin();
  const databaseUrl = new URL('postgresql://' + hostname + ':' + pgPort + '/' + dbName);
  databaseUrl.username = dbUser;
  databaseUrl.password = dbPassword;
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    USER: process.env.USER || 'runner',
    LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1',
    MASTRA_HOST: hostname, HOST: hostname, PORT: String(appPort),
    MASTRACODE_PUBLIC_URL: base, BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: authSecret, FACTORY_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    DATABASE_URL: databaseUrl.toString(), FACTORY_SANDBOX_PROVIDER: 'local',
    MASTRACODE_AUTH_DISABLED: '0', MASTRA_SHARED_API_URL: '',
    WORKOS_API_KEY: '', WORKOS_CLIENT_ID: '', WORKOS_CLIENT_SECRET: '',
  };

  docker(['pull', '--platform', 'linux/amd64', pgImage]);
  docker(['run', '--detach', '--rm', '--name', containerName, '--platform', 'linux/amd64',
    '--publish', hostname + ':' + pgPort + ':5432',
    '-e', 'POSTGRES_USER', '-e', 'POSTGRES_DB', '-e', 'POSTGRES_PASSWORD',
    pgImage], { env: {
      ...process.env, POSTGRES_USER: dbUser, POSTGRES_DB: dbName,
      POSTGRES_PASSWORD: dbPassword,
    } });
  containerStarted = true;
  await waitDatabase();

  await startApp(cli, env, true);
  const unauth = await http('GET', '/web/factory/projects');
  statuses.unauth = unauth.status;
  gate(unauth.status === 401, 'qa_phase1_anonymous_not_denied');
  const invalid = await http('POST', '/auth/api/sign-in/email',
    { email: 'missing-' + random + '@example.invalid', password: 'invalid-password' });
  statuses.invalidSignIn = invalid.status;
  gate(invalid.status >= 400 && invalid.status < 500, 'qa_invalid_signin_not_denied');
  const signedUp = await http('POST', '/auth/api/sign-up/email',
    { name: 'Disposable CI operator', email, password });
  statuses.signupOptIn = signedUp.status;
  gate([200, 201].includes(signedUp.status), 'qa_opt_in_signup_failed');
  const signedIn = await http('POST', '/auth/api/sign-in/email', { email, password });
  statuses.signIn = signedIn.status;
  gate(signedIn.status === 200 && signedIn.cookie.length > 5, 'qa_operator_signin_failed');
  const organization = await http('POST', '/auth/api/organization/create',
    { name: 'Disposable Factory CI ' + random.slice(0, 6),
      slug: 'factory-ci-' + random.slice(0, 10) }, signedIn.cookie);
  statuses.createOrg = organization.status;
  gate([200, 201].includes(organization.status) &&
    typeof organization.json?.id === 'string', 'qa_org_create_failed');
  const active = await http('POST', '/auth/api/organization/set-active',
    { organizationId: organization.json.id }, signedIn.cookie);
  statuses.activeOrg = active.status;
  gate(active.status === 200, 'qa_org_activation_failed');
  const created = await http('POST', '/web/factory/projects',
    { name: 'Disposable Factory CI ' + random.slice(0, 8), description: 'CI only' },
    signedIn.cookie);
  statuses.createProject = created.status;
  const projectId = created.json?.project?.id;
  gate(created.status === 201 && /^[0-9a-f-]{36}$/i.test(projectId || ''),
    'qa_project_create_failed');
  const project = await http('GET', '/web/factory/projects/' + projectId,
    undefined, signedIn.cookie);
  statuses.projectGet = project.status;
  const typed = project.json?.project;
  gate(project.status === 200 && typed?.id === projectId &&
    Number.isSafeInteger(typed?.automationRevision) &&
    typeof typed?.autoRunEnabled === 'boolean' &&
    typeof typed?.autoApprovePlans === 'boolean', 'qa_project_not_typed');
  const receipt = await http('GET', '/web/factory/projects/' + projectId +
    '/automation-runs/' + crypto.randomUUID(), undefined, signedIn.cookie);
  statuses.receipt = receipt.status;
  gate(receipt.status === 404 && receipt.json?.error === 'Enqueue receipt not found',
    'qa_native_receipt_not_json404');
  const anonAgain = await http('GET', '/web/factory/projects/' + projectId);
  gate(anonAgain.status === 401, 'qa_project_anon_not_denied');

  await stopApp();
  gate(!(await portOccupied(appPort)), 'qa_phase2_port_not_released');
  await startApp(cli, env, false);
  const denied = await http('POST', '/auth/api/sign-up/email', {
    name: 'Must be denied', email: 'denied-' + random + '@example.invalid',
    password: crypto.randomBytes(18).toString('base64url') + 'A!',
  });
  statuses.defaultSignupDenied = denied.status;
  gate(denied.status >= 400 && denied.status < 500, 'qa_default_signup_not_denied');
  const existing = await http('POST', '/auth/api/sign-in/email', { email, password });
  statuses.existingSignIn = existing.status;
  gate(existing.status === 200 && existing.cookie.length > 5, 'qa_existing_signin_broken');
  const activeAgain = await http('POST', '/auth/api/organization/set-active',
    { organizationId: organization.json.id }, existing.cookie);
  gate(activeAgain.status === 200, 'qa_existing_org_activation_broken');
  const projectAgain = await http('GET', '/web/factory/projects/' + projectId,
    undefined, existing.cookie);
  statuses.existingProject = projectAgain.status;
  const typedAgain = projectAgain.json?.project;
  gate(projectAgain.status === 200 && typedAgain?.id === projectId &&
    typedAgain.automationRevision === typed.automationRevision &&
    typeof typedAgain.autoRunEnabled === 'boolean' &&
    typeof typedAgain.autoApprovePlans === 'boolean', 'qa_existing_project_broken');
  const receiptAgain = await http('GET', '/web/factory/projects/' + projectId +
    '/automation-runs/' + crypto.randomUUID(), undefined, existing.cookie);
  statuses.existingReceipt = receiptAgain.status;
  gate(receiptAgain.status === 404 &&
    receiptAgain.json?.error === 'Enqueue receipt not found',
    'qa_existing_receipt_broken');
  const anonymousAgain = await http('GET', '/web/factory/projects/' + projectId);
  gate(anonymousAgain.status === 401, 'qa_phase2_anonymous_not_denied');
  console.log(JSON.stringify({
    result: 'PASS', qa: 'factory-better-auth-pg18-two-phase',
    sourceHead: process.env.FACTORY_QA_EXPECTED_HEAD || 'isolated-qa',
    sourceSha256: sourceHash, generatedSha256: generatedHash,
    postgres: '18-alpine-immutable', loopback: true,
    twoPhase: true, optInSignup: true, defaultSignupDenied: true,
    existingSignIn: true, typedNativeProject: true, nativeReceipt404Json: true,
    anonymous401: true, statuses,
  }));
}
function classify(error) {
  if (typeof error?.qaCode === 'string') return error.qaCode;
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(childOutput)) return 'qa_dependency_missing';
  if (/database|password authentication failed|relation .* does not exist/i.test(childOutput)) return 'qa_database_or_schema';
  if (/EADDRINUSE|listen EACCES|ECONNREFUSED/i.test(childOutput)) return 'qa_transport';
  return 'qa_unclassified';
}
try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ result: 'FAILED_CLOSED', reason: classify(error),
    statuses, childExitCode: child?.exitCode ?? null, suppressedChildLogBytes: childOutputBytes }));
  process.exitCode = 1;
} finally {
  await stopApp();
  if (containerStarted) {
    const stop = spawnSync('docker', ['stop', '--time', '5', containerName],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    if (stop.status !== 0) {
      console.error(JSON.stringify({ result: 'FAILED_CLOSED', reason: 'qa_container_cleanup_failed' }));
      process.exitCode = 1;
    }
  }
}
