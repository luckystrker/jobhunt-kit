#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { installOptions } from './install-options.mjs';
import { AGENTS, skillDirectory } from './agents.mjs';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['bin', 'installer-assets', 'plugins/jobhunt-kit', 'scripts', 'tests',
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json',
  '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'];
function collect(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in template: ${path}`);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).filter(n => !['node_modules', '__pycache__', '.git'].includes(n))
    .flatMap(n => collect(join(path, n)));
}
function noSymlinks(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Destination contains a symlink: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function install(destination, { source = SOURCE, installDependencies = true, agents = [], scope = 'project', home = homedir(), env = process.env } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  if (!['project', 'global'].includes(scope) || agents.some(a => !AGENTS.some(p=>p.id===a))) throw new Error('Invalid installation scope or agents');
  if (scope === 'global' && !agents.length) throw new Error('Global installation requires at least one agent');
  const target = resolve(scope === 'global' ? home : destination);
  source = resolve(source);
  if (target === source || !relative(source, target).startsWith('..')) throw new Error('Choose a destination outside the installer package');
  const files = new Map();
  if (scope === 'project') {
    for (const root of roots) for (const path of collect(join(source, root))) files.set(relative(source, path), path);
  // npm omits package-lock.json and may omit .gitignore; ship them under explicit asset names.
  files.set('.gitignore', join(source, 'installer-assets/gitignore.txt'));
  files.set('package-lock.json', join(source, 'installer-assets/workspace-lock.json'));
  files.set('plugins/jobhunt-kit/package-lock.json', join(source, 'installer-assets/runtime-lock.json'));
  }
  const destinations = [];
  for (const agent of [...new Set(agents)]) {
    const native = relative(target,skillDirectory(agent,{scope,home:resolve(home),cwd:scope==='project'?target:process.cwd(),env}));
    destinations.push({agent, path: join(target, native)});
    files.set(join(native, 'SKILL.md'), join(source, 'installer-assets/native-SKILL.md'));
    const plugin = join(source, 'plugins/jobhunt-kit');
    for (const path of collect(plugin)) files.set(join(native, 'bundle', relative(plugin, path)), path);
    files.set(join(native, 'bundle/package-lock.json'), join(source, 'installer-assets/runtime-lock.json'));
  }
  const pending = [];
  for (const [name, input] of files) {
    const output = join(target, name);
    noSymlinks(output);
    let parent = dirname(output);
    while (parent !== dirname(parent)) {
      if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Destination directory is a file: ${parent}`);
      parent = dirname(parent);
    }
    if (existsSync(output)) {
      if (!lstatSync(output).isFile() || !readFileSync(output).equals(readFileSync(input))) {
        throw new Error(`Existing file differs; nothing copied: ${output}. Choose an empty folder or keep your existing installation.`);
      }
    } else pending.push([input, output]);
  }
  for (const [input, output] of pending) {
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(input, output);
  }
  if (scope === 'global') return {directory: target, copied: pending.length, dependencies_installed: false, scope, agents: destinations};
  if (installDependencies) {
    const options = { cwd: target, stdio: 'inherit', windowsHide: true };
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund'], options)
      : spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    if (result.error || result.status !== 0) throw new Error(`Template copied to ${target}, but dependencies were not installed. Retry the same init command. ${result.error?.message || ''}`);
  }
  const binDir = join(target, 'node_modules', '.bin');
  noSymlinks(binDir);
  noSymlinks(join(binDir, 'jobhunt-kit.cmd'));
  noSymlinks(join(binDir, 'jobhunt-kit'));
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'jobhunt-kit.cmd'), '@echo off\r\nnode "%~dp0..\\..\\bin\\jobhunt-kit.mjs" %*\r\n');
  writeFileSync(join(binDir, 'jobhunt-kit'), '#!/bin/sh\nexec node "$(dirname "$0")/../../bin/jobhunt-kit.mjs" "$@"\n', { mode: 0o755 });
  return { directory: target, copied: pending.length, dependencies_installed: installDependencies, scope, agents: destinations };
}
export async function main(args) {
  if (args[0] === 'agents') {
    if (args.length!==1) throw new Error('Usage: jobhunt-kit agents');
    console.log(AGENTS.map(a=>`${a.id.padEnd(14)} ${a.name}${a.globalOnly?' (global only)':''}`).join('\n'));
    return;
  }
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: jobhunt-kit <command> [arguments] [--workspace dir | --data dir]\n\ninstall [directory]              Choose agents and install (default: ./my-jobhunt)\n  --agents codex,cursor,...      Select agents (or all); --providers is an alias\n  agents                        List supported agents\n  --scope project|global        Workspace skills or user-wide skills\n  --yes, -y                     Use detected agents and project scope\ninit <directory>                 Alias with an explicit destination\nprofile init|show|check          Initialize/view/validate local profile\nprofile save --input file        Save profile and clear confirmation\nprofile confirm --note text      Record explicit candidate confirmation\nresume [file]                   Import file, fingerprint and mechanical checks\nresume check|reviewed            Inspect file / record agent review (--input file)\nsearch [plan]                   Prepare context for agent; no live search\nsearch start|event|record|finish  Persist search operations (--input file)\napply preview|export|begin slug  Review/export/reserve application\napply prepare|approve|send|finish|resolve --input file\ntrack list|show slug|status slug --input file\nhistory | runs | report          Inspect history or generate Markdown report\npolicy show|set --input file     Inspect/set application policy\nschedule --input file            Generate scheduler prompt; does not schedule\ndoctor                          Check local setup without network\n\nNode.js 24+ required. Default data: ./local/jobhunt-kit. Only apply send performs a live application call.');
    return;
  }
  if (!['init', 'install'].includes(args[0])) {
    const { runCommand } = await import('../plugins/jobhunt-kit/scripts/commands.mjs');
    const result = runCommand(args);
    console.log(JSON.stringify(result, null, 2));
    if (result && Object.hasOwn(result, 'valid') && result.valid === false) process.exitCode = 1;
    if (result?.attempt_id && Object.hasOwn(result, 'exit_code')) process.exitCode = result.exit_code ?? 1;
    return;
  }
  let options;
  if (args[0] === 'init') {
    if (args.length !== 2 || args[1].startsWith('-')) throw new Error('Usage: jobhunt-kit init <directory>');
    options = {destination: args[1]};
  } else options = await installOptions(args.slice(1));
  const result = install(options.destination, options);
  console.log(`\nJobhunt Kit ready: ${result.directory}\nCopied files: ${result.copied}`);
  for (const agent of result.agents) console.log(`${agent.agent}: ${agent.path}`);
  if (result.scope==='project' && result.agents.some(a=>a.agent==='hermes')) console.log('Hermes: run hermes skills trust from this workspace before using project skills.');
  console.log(result.scope === 'global' ? 'Open your working folder in a new agent session.' : 'Open this folder in a new agent session.');
  console.log('Ask: use jobhunt-kit to initialize my job search profile.\nNo profile, schedule, search or application was created.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (e) { console.error(`jobhunt-kit: ${e.message}`); process.exitCode = 1; }
}
