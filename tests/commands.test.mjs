import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runCommand } from '../plugins/job-search/scripts/commands.mjs';
import { validateProfile } from '../plugins/job-search/scripts/profile.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'job-search-command-'));
  t.after(() => {
    assert.ok(resolve(cwd).startsWith(resolve(tmpdir()) + sep) && cwd.includes('job-search-command-'));
    rmSync(cwd, { recursive: true, force: true });
  });
  const call = (...args) => runCommand(args, { cwd });
  const input = (data, name = 'input.json') => { writeFileSync(join(cwd, name), JSON.stringify(data)); return name; };
  return { cwd, call, input, dir: join(cwd, 'local/job-search') };
}
function ready(f) {
  f.call('profile', 'init');
  writeFileSync(join(f.cwd, 'fictional.txt'), 'Fictional Candidate\nfictional@example.invalid\nExperience\nLibrary work.');
  f.call('resume', 'fictional.txt');
  const profile = f.call('profile', 'show').profile;
  profile.search.roles = ['Fictional librarian']; profile.hirify_profile_id = 123;
  profile.evidence = [{ id: 'E1', text: 'Library work', source: 'fictional test', confirmed: true }];
  f.call('profile', 'save', '--input', f.input(profile));
  f.call('resume', 'reviewed', '--input', f.input({ sha256: profile.resume.sha256, status: 'ready', checks: { text: 'pass', visual: 'pass', facts: 'pass' }, evidence: 'Synthetic review only' }));
  f.call('profile', 'confirm', '--note', 'Synthetic candidate confirmation');
}
test('doctor does not create candidate data and profile init creates only empty templates', t => {
  const f = fixture(t);
  assert.equal(f.call('doctor').initialized, false);
  assert.equal(existsSync(f.dir), false);
  f.call('profile', 'init');
  assert.equal(f.call('profile', 'check').valid, false);
  assert.throws(() => f.call('profile', 'confirm', '--note', 'test'), /target role/);
});
test('profile save validates facts, clears confirmation and records explicit confirmation', t => {
  const f = fixture(t); ready(f);
  assert.equal(f.call('profile', 'check').confirmed, true);
  const p = f.call('profile', 'show').profile;
  p.search.roles = ['Fictional archivist'];
  f.call('profile', 'save', '--input', f.input(p));
  assert.equal(f.call('profile', 'check').confirmed, false);
  assert.ok(f.call('history').some(e => e.kind === 'profile_saved'));
  p.evidence.push(p.evidence[0]);
  assert.equal(validateProfile(p).valid, false);
});
test('resume imports immutable copy, performs text checks and preserves human review on rerun', t => {
  const f = fixture(t); f.call('profile', 'init');
  writeFileSync(join(f.cwd, 'fictional notes.txt'), 'Experience\nFictional text');
  const r = f.call('resume', 'fictional notes.txt');
  assert.equal(r.fingerprint_matches, true); assert.equal(r.text_extraction, 'utf8_text');
  assert.equal(r.ats_test, 'not_performed'); assert.ok(r.findings.some(x => x.includes('email')));
  writeFileSync(r.review_path, 'Human review must survive');
  f.call('resume', 'check');
  assert.equal(readFileSync(r.review_path, 'utf8'), 'Human review must survive');
  writeFileSync(join(f.cwd, 'fictional notes.txt'), 'Changed original');
  assert.match(readFileSync(r.file, 'utf8'), /Fictional text/);
});
test('binary resume is not falsely described as parsed or ready', t => {
  const f = fixture(t); f.call('profile', 'init');
  writeFileSync(join(f.cwd, 'fictional.pdf'), 'Not a real PDF; test only');
  const r = f.call('resume', 'fictional.pdf');
  assert.equal(r.text_extraction, 'not_performed');
  assert.equal(r.review_status, 'not_reviewed');
  assert.throws(() => f.call('resume', 'reviewed', '--input', f.input({sha256:r.sha256,status:'ready',evidence:'test'})), /recorded text/);
});
test('search creates an honest local context and prevents overlapping CLI runs', t => {
  const f = fixture(t); ready(f);
  const context = f.call('search');
  assert.equal(context.live_search_executed, false); assert.equal(context.budgets.target, 5);
  const run = f.call('search', 'start', '--input', f.input({ query: 'fictional' }));
  assert.throws(() => f.call('search', 'start', '--input', f.input({})), /previous running/);
  f.call('search', 'finish', '--input', f.input({run_id:run.run_id,status:'complete',reason:'Synthetic no results'}));
  assert.match(f.call('report').content, /Synthetic no results/);
});
test('application commands preserve approval, export and exactly-one dispatch guards', t => {
  const f = fixture(t); ready(f);
  const run = f.call('search', 'start', '--input', f.input({}));
  f.call('search', 'record', '--input', f.input({run_id:run.run_id,slug:'fictional',title:'Fictional role',url:'https://example.invalid/job',route:'hosted',description:'Test only',read_at:'2026-01-01T00:00:00Z',match:{verdict:'suitable',reasons:['test'],requirements:[]}}));
  f.call('apply', 'prepare', '--input', f.input({slug:'fictional',cover_letter:'Fictional cover\nLiteral $() and quotes "',claims:[{text:'Library work',evidence_id:'E1'}],answers:[],unresolved:[],hirify_profile_id:123}));
  const exported = f.call('apply', 'export', 'fictional');
  assert.equal(exported.sent, false);
  assert.match(readFileSync(join(exported.directory,'cover-letter.txt'),'utf8'), /Literal/);
  assert.throws(() => f.call('apply', 'begin', 'fictional'), /approval required/);
  f.call('apply', 'approve', '--input', f.input({slug:'fictional',user_authorization:'Synthetic individual approval'}));
  const packet = f.call('apply','begin','fictional');
  let calls=0;
  const send = () => runCommand(['apply','send','--input',packet.packet_path],{cwd:f.cwd,transport:()=>{calls++;return {status:0,stdout:'synthetic response',stderr:''};}});
  send(); assert.throws(send); assert.equal(calls,1);
  f.call('apply','finish','--input',f.input({attempt_id:packet.attempt_id,outcome:'submitted',application_id:'fictional-123',evidence:'Synthetic confirmed response'}));
  f.call('track','status','fictional','--input',f.input({slug:'different-untrusted-slug',status:'interview',note:'Synthetic user report'}));
  assert.equal(f.call('track','show','fictional').status,'interview');
});
test('schedule generates prompt with persistent workspace paths and never grants auto', t => {
  const f=fixture(t); f.call('profile','init');
  const plugin=join(f.cwd,'plugins/job-search/skills/job-search'); mkdirSync(plugin,{recursive:true}); writeFileSync(join(plugin,'SKILL.md'),'Fictional path fixture');
  const r=f.call('schedule','--input',f.input({frequency:'Every weekday at 9',timezone:'UTC',mode:'auto'}));
  assert.equal(r.scheduled,false); assert.equal(r.auto_permission_granted,false);
  assert.ok(readFileSync(r.path,'utf8').includes(join(f.cwd,'plugins/job-search')));
  assert.equal(f.call('policy').mode,'review_each');
  assert.throws(()=>f.call('schedule','--input',f.input({frequency:'daily',timezone:'invalid-zone',mode:'search'})));
});
test('CLI uses requested workspace independently of package working directory', t => {
  const f=fixture(t);
  const r=spawnSync(process.execPath,[resolve('bin/job-search.mjs'),'doctor','--workspace',f.cwd],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).workspace,f.cwd);
  assert.equal(existsSync(f.dir),false);
});
test('PDF text is extracted locally from a generated fictional one-page document', t => {
  const f=fixture(t);f.call('profile','init');
  const stream='BT /F1 12 Tf 30 100 Td (Fictional Resume Experience) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(f.cwd,'synthetic.pdf'),pdf);
  const result=f.call('resume','synthetic.pdf');
  assert.equal(result.text_extraction,'pdf-parse',JSON.stringify(result.findings));
  assert.match(readFileSync(join(dirname(result.checks_path),'text.txt'),'utf8'),/Fictional Resume Experience/);
  assert.equal(result.visual_review,'not_performed');
});
test('DOCX text is extracted locally from a generated fictional document', async t => {
  const f=fixture(t);f.call('profile','init');
  const require=createRequire(import.meta.url);
  const JSZip=createRequire(require.resolve('mammoth/package.json'))('jszip');
  const zip=new JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fictional DOCX Experience</w:t></w:r></w:p></w:body></w:document>');
  writeFileSync(join(f.cwd,'synthetic.docx'),await zip.generateAsync({type:'nodebuffer'}));
  const result=f.call('resume','synthetic.docx');
  assert.equal(result.text_extraction,'mammoth',JSON.stringify(result.findings));
  assert.match(readFileSync(join(dirname(result.checks_path),'text.txt'),'utf8'),/Fictional DOCX Experience/);
  assert.equal(result.factual_review,'not_performed');
});
