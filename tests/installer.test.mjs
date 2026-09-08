import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { install } from '../bin/job-search.mjs';

function target(t) {
  const path = mkdtempSync(join(tmpdir(), 'job-search-install-'));
  t.after(() => {
    assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep) && path.includes('job-search-install-'));
    rmSync(path, { recursive: true, force: true });
  });
  return join(path, 'new workspace');
}
test('installs a complete template, including npm-omitted files, without personal state', t => {
  const path = target(t);
  const result = install(path, { installDependencies: false });
  assert.ok(result.copied > 30);
  for (const name of ['.gitignore', 'package-lock.json', 'plugins/job-search/package-lock.json',
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'plugins/job-search/skills/job-profile/SKILL.md']) assert.ok(existsSync(join(path, name)), name);
  assert.equal(existsSync(join(path, 'local')), false);
  assert.equal(existsSync(join(path, '.git')), false);
});
test('repeat installation preserves candidate files and copies nothing', t => {
  const path = target(t);
  install(path, { installDependencies: false });
  mkdirSync(join(path, 'local'));
  writeFileSync(join(path, 'local', 'fictional.md'), 'Fictional private test data');
  const result = install(path, { installDependencies: false });
  assert.equal(result.copied, 0);
  assert.equal(readFileSync(join(path, 'local', 'fictional.md'), 'utf8'), 'Fictional private test data');
});
test('conflicting file stops before copying any files', t => {
  const path = target(t);
  mkdirSync(path); writeFileSync(join(path, 'README.md'), 'Existing user document');
  assert.throws(() => install(path, { installDependencies: false }), /Existing file differs/);
  assert.equal(existsSync(join(path, 'plugins')), false);
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'Existing user document');
});
test('CLI executes through the package link used by npm exec', t => {
  const path = target(t);
  symlinkSync(resolve('.'), path, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = spawnSync(process.execPath, [join(path, 'bin/job-search.mjs'), 'doctor', '--workspace', join(path, '..', 'empty')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).initialized, false);
  } finally {
    unlinkSync(path);
  }
});
