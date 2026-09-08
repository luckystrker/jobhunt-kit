import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Directory conventions checked against Impeccable's providers.rs and README.
export const AGENTS = [
  {id:'codex', name:'Codex', dir:'.agents', detect:'.codex', aliases:['agents']},
  {id:'claude', name:'Claude Code', dir:'.claude', aliases:['claude-code']},
  {id:'cursor', name:'Cursor', dir:'.cursor'},
  {id:'gemini', name:'Gemini CLI', dir:'.gemini'},
  {id:'github', name:'GitHub Copilot', dir:'.github', global:'.copilot/skills', detect:'.copilot', aliases:['copilot']},
  {id:'opencode', name:'OpenCode', dir:'.opencode', global:'.config/opencode/skills'},
  {id:'antigravity', name:'Antigravity', dir:'.agent', global:'.gemini/config/skills', aliases:['agent']},
  {id:'pi', name:'Pi', dir:'.pi', global:'.pi/agent/skills'},
  {id:'grok', name:'Grok Build', dir:'.grok', aliases:['grok-build','xai']},
  {id:'hermes', name:'Hermes Agent', dir:'.hermes'},
  {id:'dsh', name:'DeepSeek Harness', dir:'.dsh', aliases:['deepseek','deepseek-harness']},
  {id:'kiro', name:'Kiro', dir:'.kiro'},
  {id:'qoder', name:'Qoder', dir:'.qoder'},
  {id:'trae', name:'Trae', dir:'.trae'},
  {id:'trae-cn', name:'Trae CN', dir:'.trae-cn'},
  {id:'rovo-dev', name:'Rovo Dev', dir:'.rovodev', aliases:['rovodev']},
  {id:'vibe', name:'Mistral Vibe', dir:'.vibe'},
  {id:'veto', name:'Veto', dir:'.veto', globalOnly:true}
];

export function parseAgents(value) {
  const selected = value.split(',').map(x => x.trim().toLowerCase().replace(/^\./,''));
  if (selected.length === 1 && selected[0] === 'all') return AGENTS.map(a=>a.id);
  return [...new Set(selected.map(id => {
    const found=AGENTS.find(a=>a.id===id || a.aliases?.includes(id));
    if (!found) throw new Error(`Choose agents: ${AGENTS.map(a=>a.id).join(', ')} (or all)`);
    return found.id;
  }))];
}

export function skillDirectory(id, {scope, home, cwd, env = process.env}) {
  const agent=AGENTS.find(a=>a.id===id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  if (scope==='project') {
    if (agent.globalOnly) throw new Error(`${agent.name} supports --scope global only`);
    return join(cwd,agent.dir,'skills','jobhunt-kit');
  }
  let folder=join(home, agent.global || join(agent.dir,'skills'));
  if (id==='opencode') {
    if (env.OPENCODE_CONFIG_DIR) folder=join(resolve(cwd,env.OPENCODE_CONFIG_DIR),'skills');
    else if (env.XDG_CONFIG_HOME) folder=join(resolve(cwd,env.XDG_CONFIG_HOME),'opencode','skills');
  }
  const override=id==='hermes' ? env.HERMES_HOME : id==='dsh' ? env.DSH_HOME : null;
  if (override) folder=join(resolve(cwd,override),'skills');
  const delta=relative(resolve(home),resolve(folder));
  if (isAbsolute(delta) || delta==='..' || delta.startsWith(`..${sep}`)) {
    throw new Error(`${agent.name}: global configuration path must be inside the home directory: ${folder}`);
  }
  return join(folder,'jobhunt-kit');
}

export function detectAgents({home,cwd,env=process.env}) {
  return AGENTS.filter(a=>{
    const project=a.id==='github' ? join(cwd,'.github/skills') : join(cwd,a.dir);
    let global;
    try { global=dirname(dirname(skillDirectory(a.id,{scope:'global',home,cwd,env}))); }
    catch { global=null; }
    return (!a.globalOnly && existsSync(project)) || global && existsSync(global)
      || a.detect && existsSync(join(home,a.detect));
  }).map(a=>a.id);
}
