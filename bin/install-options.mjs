import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseAgents(value) {
  const agents = [...new Set(value.split(',').map(x => x.trim().toLowerCase()))];
  if (!agents.length || agents.some(x => !['codex', 'claude'].includes(x))) {
    throw new Error('Choose agents: codex, claude or codex,claude');
  }
  return agents;
}

export async function installOptions(args, { input = process.stdin, output = process.stdout, home = homedir(), cwd = process.cwd(), ask } = {}) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    agents: {type:'string'}, scope: {type:'string'}, yes: {type:'boolean', short:'y'}
  }});
  if (positionals.length > 1) throw new Error('Expected at most one destination folder');
  let agents = values.agents ? parseAgents(values.agents) : null;
  let scope = values.scope;
  if (scope && !['project','global'].includes(scope)) throw new Error('Scope must be project or global');
  const detected = ['codex','claude'].filter(a => existsSync(join(home, `.${a}`)) || existsSync(join(cwd, a === 'codex' ? '.agents' : '.claude')));
  const defaults = detected.length ? detected : ['codex','claude'];
  let terminal;
  try {
    if (!agents && !values.yes || !scope && !values.yes && !values.agents) {
      if (!ask && (!input.isTTY || !output.isTTY)) throw new Error('Non-interactive install: pass --agents codex,claude --scope project, or --yes');
      if (!ask) {
        terminal = createInterface({input, output});
        ask = question => terminal.question(question);
        terminal.on('SIGINT', () => terminal.close());
      }
      output.write(`\nJobhunt Kit\nDetected: ${detected.join(', ') || 'none'}\n`);
      while (!agents) {
        const answer = await ask(`Agents — codex, claude, or codex,claude [${defaults.join(',')}]: `);
        try { agents = parseAgents(answer.trim() || defaults.join(',')); }
        catch (e) { output.write(`${e.message}\n`); }
      }
      while (!scope) {
        const answer = (await ask('Scope — project or global [project]: ')).trim() || 'project';
        if (['project','global'].includes(answer)) scope = answer;
        else output.write('Choose project or global\n');
      }
    }
  } finally { terminal?.close(); }
  scope ||= 'project';
  agents ||= defaults;
  if (scope === 'global' && positionals.length) throw new Error('Global installation does not take a workspace folder');
  return {destination: positionals[0] || './my-jobhunt', agents, scope};
}
