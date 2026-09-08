import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { install } from '../bin/jobhunt-kit.mjs';
import { installOptions } from '../bin/install-options.mjs';

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
  for (const name of ['.gitignore', 'package-lock.json', 'plugins/jobhunt-kit/package-lock.json',
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'plugins/jobhunt-kit/skills/job-profile/SKILL.md']) assert.ok(existsSync(join(path, name)), name);
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
    const result = spawnSync(process.execPath, [join(path, 'bin/jobhunt-kit.mjs'), 'doctor', '--workspace', join(path, '..', 'empty')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).initialized, false);
  } finally {
    unlinkSync(path);
  }
});
test('selected agent receives a complete portable skill; other agent is untouched', t => {
  const path = target(t);
  install(path, {installDependencies:false, agents:['claude']});
  assert.ok(existsSync(join(path,'.claude/skills/jobhunt-kit/SKILL.md')));
  assert.ok(existsSync(join(path,'.claude/skills/jobhunt-kit/bundle/references/workflow.md')));
  assert.ok(existsSync(join(path,'.claude/skills/jobhunt-kit/bundle/package-lock.json')));
  assert.equal(existsSync(join(path,'.agents/skills/jobhunt-kit')),false);
});
test('global installation targets only selected skill directories and is idempotent', t => {
  const home = target(t);
  const opts={home,scope:'global',agents:['codex','claude']};
  const first=install('unused',opts);
  assert.equal(first.agents.length,2);
  assert.equal(first.dependencies_installed,false);
  assert.equal(existsSync(join(home,'package.json')),false);
  assert.equal(existsSync(join(home,'local')),false);
  assert.equal(install('unused',opts).copied,0);
});
test('native skill conflict aborts the entire install before workspace files are copied', t => {
  const path=target(t);
  const folder=join(path,'.claude/skills/jobhunt-kit'); mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'SKILL.md'),'User instructions');
  assert.throws(()=>install(path,{installDependencies:false,agents:['codex','claude']}),/Existing file differs/);
  assert.equal(existsSync(join(path,'package.json')),false);
  assert.equal(existsSync(join(path,'.agents')),false);
  assert.equal(readFileSync(join(folder,'SKILL.md'),'utf8'),'User instructions');
});
test('native installation rejects redirected skill directories', t => {
  const path=target(t); mkdirSync(path,{recursive:true});
  const elsewhere=join(path,'elsewhere'); mkdirSync(elsewhere);
  const link=join(path,'.claude'); symlinkSync(elsewhere,link,process.platform==='win32'?'junction':'dir');
  try { assert.throws(()=>install(path,{installDependencies:false,agents:['claude']}),/symlink/); }
  finally { unlinkSync(link); }
  assert.equal(existsSync(join(elsewhere,'skills')),false);
});
test('interactive installer retries invalid choices and selects agents and scope', async t => {
  const answers=['invalid','claude,codex','global'];
  const options=await installOptions([],{home:target(t),cwd:target(t),output:{write(){}},ask:async()=>answers.shift()});
  assert.deepEqual(options.agents,['claude','codex']); assert.equal(options.scope,'global');
});
test('noninteractive installer requires explicit selection and validates before writing', async () => {
  const quiet={input:{isTTY:false},output:{isTTY:false}};
  await assert.rejects(installOptions([],quiet),/Non-interactive/);
  await assert.rejects(installOptions(['--agents','other'],quiet),/Choose agents/);
  await assert.rejects(installOptions(['some-folder','--agents','claude','--scope','global'],quiet),/does not take/);
  assert.deepEqual((await installOptions(['--agents','codex,claude'],quiet)).agents,['codex','claude']);
});
test('global skill can initialize separate data and generate a schedule with persistent paths', t => {
  const home=target(t);
  install('unused',{home,scope:'global',agents:['codex']});
  const workspace=join(home,'work'); mkdirSync(workspace);
  const cli=join(home,'.agents/skills/jobhunt-kit/bundle/scripts/cli.mjs');
  const run=args=>{
    const r=spawnSync(process.execPath,[cli,...args,'--workspace',workspace],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  run(['profile','init']);
  const input=join(workspace,'schedule.json');
  writeFileSync(input,JSON.stringify({frequency:'Weekly',timezone:'UTC',mode:'search'}));
  const result=run(['schedule','--input',input]);
  assert.equal(result.scheduled,false);
  assert.ok(readFileSync(result.path,'utf8').includes(join(home,'.agents/skills/jobhunt-kit/bundle')));
});
