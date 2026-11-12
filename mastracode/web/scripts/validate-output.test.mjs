import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceValidator = fileURLToPath(new URL('./validate-output.mjs', import.meta.url));
const required = ['configure-factory-rules', 'factory-plan', 'factory-review', 'factory-triage'];

function fixture(callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'mastra-output-check-'));
  const output = path.join(root, '.mastra', 'output');
  try {
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    copyFileSync(sourceValidator, path.join(root, 'scripts', 'validate-output.mjs'));
    mkdirSync(path.join(output, 'factory'), { recursive: true });
    writeFileSync(path.join(output, 'index.mjs'), 'export {};\n');
    writeFileSync(path.join(output, 'package.json'), JSON.stringify({ dependencies: { '@mastra/factory': '0.25.0' } }));
    writeFileSync(path.join(output, 'factory', 'index.html'), '<!doctype html>');
    const addSkill = (layout, name, content = '# Factory Skill\n') => {
      const folder = layout === 'package' ? path.join(output, 'node_modules', '@mastra', 'factory') : output;
      const skillFile = path.join(folder, 'factory-skills', name, 'SKILL.md');
      mkdirSync(path.dirname(skillFile), { recursive: true });
      writeFileSync(skillFile, content);
      return skillFile;
    };
    const validate = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-output.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    });
    callback({ root, output, addSkill, validate });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts all stock Factory skills installed inside the packaged dependency', () => fixture(({ addSkill, validate }) => {
  for (const name of required) addSkill('package', name);
  const result = validate();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /node_modules.*factory-skills/);
}));

test('accepts bundled skills copied at the deploy output root', () => fixture(({ addSkill, validate }) => {
  for (const name of required) addSkill('root', name);
  assert.equal(validate().status, 0);
}));

test('rejects a package missing one required skill', () => fixture(({ addSkill, validate }) => {
  for (const name of required.slice(0, -1)) addSkill('package', name);
  const result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /factory-triage/);
}));

test('rejects an empty required skill document', () => fixture(({ addSkill, validate }) => {
  for (const name of required) addSkill('package', name, name === 'factory-review' ? '' : '# Factory Skill\n');
  const result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /factory-review/);
}));

test('rejects a symlinked skill document escaping the deployable output', () => fixture(({ root, output, addSkill, validate }) => {
  for (const name of required.slice(0, -1)) addSkill('package', name);
  const outside = path.join(root, 'outside.md');
  writeFileSync(outside, '# External skill\n');
  const link = path.join(output, 'node_modules', '@mastra', 'factory', 'factory-skills', 'factory-triage', 'SKILL.md');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(outside, link);
  const result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /factory-triage/);
}));

test('preserves rejection of non-installable dependency specs', () => fixture(({ output, addSkill, validate }) => {
  for (const name of required) addSkill('package', name);
  writeFileSync(path.join(output, 'package.json'), JSON.stringify({ dependencies: { '@mastra/factory': 'link:../factory' } }));
  const result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-installable spec/);
}));
