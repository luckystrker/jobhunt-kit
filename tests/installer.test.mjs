import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { install } from '../bin/jobhunt-kit.mjs';
import { installOptions } from '../bin/install-options.mjs';
import { AGENTS, parseAgents, skillDirectory, detectAgents } from '../bin/agents.mjs';

const VALIDATION_MODULES = ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string'];
function installValidationFixture(bundle) {
  for (const name of VALIDATION_MODULES) cpSync(resolve('node_modules', name), join(bundle, 'node_modules', name), { recursive: true });
}

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
  const bundle=join(home,'.agents/skills/jobhunt-kit/bundle');
  installValidationFixture(bundle);
  const cli=join(bundle,'scripts/cli.mjs');
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
test('all supported harnesses receive complete bundles at their project and global paths', t => {
  const project=target(t), home=target(t);
  const projectAgents=AGENTS.filter(a=>!a.globalOnly).map(a=>a.id);
  install(project,{agents:projectAgents,installDependencies:false,env:{}});
  install('unused',{agents:AGENTS.map(a=>a.id),scope:'global',home,env:{}});
  const expected={github:'.copilot/skills',opencode:'.config/opencode/skills',antigravity:'.gemini/config/skills',pi:'.pi/agent/skills'};
  for(const a of AGENTS){
    const global=join(home,expected[a.id] || `${a.dir}/skills`,'jobhunt-kit');
    assert.ok(existsSync(join(global,'SKILL.md')),a.id);
    assert.ok(existsSync(join(global,'bundle/scripts/setup.mjs')),a.id);
    if(!a.globalOnly) assert.ok(existsSync(join(project,a.dir,'skills/jobhunt-kit/SKILL.md')),a.id);
  }
  assert.equal(existsSync(join(project,'.veto')),false);
});
test('provider aliases and all work in flags and interactive selection', async () => {
  assert.deepEqual(parseAgents('copilot,github,.claude,claude-code,deepseek'),['github','claude','dsh']);
  const quiet={input:{isTTY:false},output:{isTTY:false}};
  const project=await installOptions(['--providers','all'],quiet);
  assert.equal(project.agents.length,17); assert.equal(project.agents.includes('veto'),false);
  const global=await installOptions(['--agents','all','--scope','global'],quiet);
  assert.equal(global.agents.length,18);
  await assert.rejects(installOptions(['--agents','veto'],quiet),/global/);
  await assert.rejects(installOptions(['--agents','codex','--providers','cursor'],quiet),/either/);
  const answers=['all','project'];
  assert.equal((await installOptions([],{output:{write(){}},ask:async()=>answers.shift()})).agents.length,17);
});
test('custom global configuration directories are detected and cannot escape home', t => {
  const home=target(t),cwd=target(t);
  const env={OPENCODE_CONFIG_DIR:join(home,'custom/open'),HERMES_HOME:join(home,'custom/hermes'),DSH_HOME:join(home,'custom/dsh')};
  for(const p of Object.values(env)) mkdirSync(p,{recursive:true});
  for(const id of ['opencode','hermes','dsh']) assert.ok(detectAgents({home,cwd,env}).includes(id));
  assert.equal(skillDirectory('opencode',{home,cwd,env,scope:'global'}),join(env.OPENCODE_CONFIG_DIR,'skills/jobhunt-kit'));
  assert.equal(skillDirectory('opencode',{home,cwd,env:{XDG_CONFIG_HOME:join(home,'xdg')},scope:'global'}),join(home,'xdg/opencode/skills/jobhunt-kit'));
  assert.throws(()=>skillDirectory('hermes',{home,cwd,env:{HERMES_HOME:home+'-sibling'},scope:'global'}),/inside the home/);
  assert.throws(()=>install('unused',{home,scope:'global',agents:['codex','opencode'],env:{OPENCODE_CONFIG_DIR:cwd}}),/inside the home/);
  assert.equal(existsSync(join(home,'.agents')),false);
});
