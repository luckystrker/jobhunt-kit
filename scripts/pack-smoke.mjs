import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'jobhunt-pack-smoke-'));
try {
  const env = { ...process.env, npm_config_cache: join(root, 'npm-cache') };
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this smoke check through npm run pack:smoke');
  const runNpm = (args, options = {}) => execFileSync(process.execPath, [npmCli, ...args], { env, ...options });
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', root], { cwd: resolve('.'), encoding: 'utf8' }));
  const archive = join(root, packed[0].filename);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  execFileSync('tar', ['-xzf', archive, '-C', consumer], { stdio: 'pipe' });
  const installed = join(consumer, 'package');
  const { install } = await import(pathToFileURL(join(installed, 'bin', 'jobhunt-kit.mjs')));
  const workspace = join(root, 'installed-workspace');
  const result = install(workspace, { source: installed, installDependencies: false, agents: ['codex'] });
  assert.equal(result.scope, 'project');
  for (const name of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) {
    cpSync(resolve('node_modules', name), join(workspace, 'node_modules', name), { recursive: true });
  }
  const { runCommand } = await import(pathToFileURL(join(workspace, 'plugins', 'jobhunt-kit', 'scripts', 'commands.mjs')));
  const initialized = runCommand(['profile', 'init', '--workspace', workspace], { cwd: workspace });
  assert.equal(initialized.initialized, true);
  const doctor = runCommand(['doctor', '--workspace', workspace], { cwd: workspace });
  assert.equal(doctor.integrity.database_ok, true);
  assert.equal(JSON.parse(readFileSync(join(workspace, 'plugins', 'jobhunt-kit', 'package.json'))).dependencies.ajv, '8.20.0');
  const globalHome = join(root, 'global-home');
  const global = install('.', { source: installed, installDependencies: false, agents: ['codex'], scope: 'global', home: globalHome });
  const bundle = join(global.agents[0].path, 'bundle');
  assert.equal(existsSync(join(bundle, 'node_modules')), false);
  const globalData = join(root, 'global-data');
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, 'fake-npm.mjs');
  writeFileSync(fakeNpm, `import { cpSync, mkdirSync, readdirSync } from 'node:fs';\nimport { join } from 'node:path';\nconst destination=join(process.cwd(),'node_modules');\nmkdirSync(destination,{recursive:true});\nfor(const name of readdirSync(process.env.JOBHUNT_SMOKE_MODULES)){if(name!=='.bin'&&name!=='jobhunt-kit')cpSync(join(process.env.JOBHUNT_SMOKE_MODULES,name),join(destination,name),{recursive:true});}\n`);
  writeFileSync(join(fakeBin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);
  writeFileSync(join(fakeBin, 'npm'), `#!${process.execPath}\nimport '${fakeNpm.replaceAll('\\', '/')}';\n`, { mode: 0o755 });
  const isolatedEnv = { ...env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, JOBHUNT_SMOKE_MODULES: resolve('node_modules') };
  execFileSync(process.execPath, [join(bundle, 'scripts', 'setup.mjs'), '--data', globalData, '--install-cli'], { env: isolatedEnv, stdio: 'pipe', timeout: 60000 });
  assert.equal(existsSync(join(bundle, 'node_modules', 'ajv')), true);
  assert.equal(JSON.parse(readFileSync(join(globalData, 'profile.json'))).schema_version, 1);
  console.log(`PACK_SMOKE_OK: ${packed[0].filename}, ${packed[0].entryCount} entries`);
} finally {
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir())) && absolute.includes('jobhunt-pack-smoke-'));
  rmSync(absolute, { recursive: true, force: true });
}
