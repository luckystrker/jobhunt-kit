import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { AGENTS, detectAgents, parseAgents } from './agents.mjs';
export { parseAgents } from './agents.mjs';

export async function installOptions(args, { input = process.stdin, output = process.stdout, home = homedir(), cwd = process.cwd(), env = process.env, ask } = {}) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    agents: {type:'string'}, providers: {type:'string'}, scope: {type:'string'}, yes: {type:'boolean', short:'y'}
  }});
  if (positionals.length > 1) throw new Error('Expected at most one destination folder');
  if (values.agents && values.providers) throw new Error('Use either --agents or --providers');
  const selection = values.agents ?? values.providers;
  let agents = selection !== undefined ? parseAgents(selection) : null;
  let allSelected = selection?.trim().toLowerCase()==='all';
  let scope = values.scope;
  if (scope && !['project','global'].includes(scope)) throw new Error('Scope must be project or global');
  const detected = detectAgents({home,cwd,env});
  const defaults = detected.length ? detected : ['codex','claude'];
  let terminal;
  try {
    if (!agents && !values.yes || !scope && !values.yes && selection === undefined) {
      if (!ask && (!input.isTTY || !output.isTTY)) throw new Error('Non-interactive install: pass --agents codex,claude --scope project, or --yes');
      if (!ask) {
        terminal = createInterface({input, output});
        ask = question => terminal.question(question);
        terminal.on('SIGINT', () => terminal.close());
      }
      output.write(`\nJobhunt Kit\n${AGENTS.map(a=>`${a.id}: ${a.name}${a.globalOnly?' (global only)':''}`).join('\n')}\nDetected: ${detected.join(', ') || 'none'}\n`);
      while (!agents) {
        const answer = await ask(`Agents — comma-separated names or all [${defaults.join(',')}]: `);
        try {
          const chosen = answer.trim() || defaults.join(',');
          agents = parseAgents(chosen); allSelected=chosen.toLowerCase()==='all';
        }
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
  if (scope==='project') {
    const globalOnly = agents.filter(id=>AGENTS.find(a=>a.id===id).globalOnly);
    if (allSelected) agents=agents.filter(id=>!globalOnly.includes(id));
    else if (globalOnly.length) throw new Error(`${globalOnly.join(', ')} requires --scope global`);
  }
  if (scope === 'global' && positionals.length) throw new Error('Global installation does not take a workspace folder');
  return {destination: positionals[0] || './my-jobhunt', agents, scope};
}
