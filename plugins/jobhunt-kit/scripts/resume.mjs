import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJSON, writeJSON } from './profile.mjs';
import { Tracker } from './tracker.mjs';
import { atomicWrite, localPath, MAX_RESUME_BYTES, readBytes, sha256 as fingerprint } from './files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function importResume(dir, file) {
  const pfile = join(dir, 'profile.json');
  const store = new Tracker(dir);
  try {
    const profileBytes = readBytes(pfile, { base: dir });
    const profile = JSON.parse(profileBytes.toString('utf8').replace(/^\uFEFF/, ''));
    const bytes = readBytes(resolve(file), { maxBytes: MAX_RESUME_BYTES });
    if (!bytes.length) throw new Error('Resume file is empty');
    const extension = extname(file).toLowerCase();
    if (!['.txt', '.md', '.pdf', '.docx', '.doc', '.rtf'].includes(extension)) throw new Error('Supported resume files: txt, md, pdf, docx, doc, rtf');
    const sha256 = fingerprint(bytes);
    const filename = `${sha256}${extension}`;
    const path = localPath(dir, `resumes/${filename}`);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) atomicWrite(path, bytes, { base: dir });
    else if (fingerprint(readBytes(path, { maxBytes: MAX_RESUME_BYTES, base: dir })) !== sha256) throw new Error('Stored resume fingerprint mismatch');
    if (profile.resume?.sha256 !== sha256 || profile.resume?.path !== `resumes/${filename}`) {
      profile.resume = { path: `resumes/${filename}`, sha256, review_status: 'not_reviewed' };
      profile.confirmed_at = null;
      store.writeManagedJSON('profile.json', profile, { expectedSha256: fingerprint(profileBytes), eventKind: 'resume_imported',
        eventPayload: { source_name: basename(file), sha256, bytes: bytes.length } });
    }
    return { path, sha256, bytes: bytes.length, review_status: profile.resume.review_status, next: 'resume check' };
  } finally { store.close(); }
}
export function checkResume(dir) {
  const profile = readJSON(join(dir, 'profile.json'));
  if (!profile.resume?.path) throw new Error('Import a resume first: resume <file>');
  const path = localPath(dir, profile.resume.path);
  const bytes = readBytes(path, { maxBytes: MAX_RESUME_BYTES, base: dir });
  const sha256 = fingerprint(bytes);
  const extension = extname(path).toLowerCase();
  const findings = [];
  let text = null;
  let extraction = 'not_performed';
  let pages = null;
  if (['.txt', '.md'].includes(extension)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); extraction = 'utf8_text'; }
    catch { findings.push('File is not valid UTF-8 text; export it as UTF-8'); }
  } else if (['.pdf', '.docx'].includes(extension)) {
    const child = spawnSync(process.execPath, ['--max-old-space-size=512', join(ROOT, 'scripts', 'extract-resume.mjs'), resolve(dir), path],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (child.error || child.status !== 0) findings.push(`Text extraction failed: ${child.error?.message || child.stderr?.trim() || 'unknown parser error'}`);
    else {
      try { const parsed = JSON.parse(child.stdout); text = parsed.text; extraction = parsed.method; pages = parsed.pages; findings.push(...parsed.warnings); }
      catch { findings.push('Parser output could not be read; inspect the original file'); }
    }
  } else findings.push('Legacy DOC/RTF: export to PDF, DOCX or UTF-8 text for extraction');
  if (text !== null) {
    if (!text.trim()) findings.push('No readable text; an image-only scan may require OCR');
    if (text.includes('\0')) findings.push('NUL bytes found; check text encoding');
    if (!/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) findings.push('No email detected by a simple pattern; verify contacts');
    if (!/(experience|опыт|employment|work history|профессиональн)/iu.test(text)) findings.push('No common experience heading detected; inspect structure');
  }
  const result = { file: path, sha256, registered_sha256: profile.resume.sha256,
    fingerprint_matches: sha256 === profile.resume.sha256, bytes: bytes.length,
    text_extraction: extraction, characters: text?.length ?? null, pages,
    visual_review: 'not_performed', factual_review: 'not_performed', ats_test: 'not_performed', findings,
    review_status: profile.resume.review_status, next_skill: 'job-resume' };
  if (!result.fingerprint_matches) findings.unshift('File changed after registration; import the current version again');
  const output = join(dir, 'materials', `resume-${sha256}`);
  mkdirSync(output, { recursive: true });
  writeJSON(join(output, 'checks.json'), result);
  if (text !== null) atomicWrite(join(output, 'text.txt'), text, { base: dir });
  const review = join(output, 'review.md');
  if (!existsSync(review)) atomicWrite(review, readFileSync(join(ROOT, 'templates', 'resume-review.md')), { base: dir });
  return { ...result, checks_path: join(output, 'checks.json'), review_path: review,
    agent_instruction: `Use job-resume. Review ${path}; mechanical checks: ${join(output, 'checks.json')}. Complete ${review}. Do not infer an ATS score from these checks.` };
}
export function recordResumeReview(dir, review) {
  const file = join(dir, 'profile.json');
  const store = new Tracker(dir);
  try {
    const profileBytes = readBytes(file, { base: dir });
    const profile = JSON.parse(profileBytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!profile.resume?.path) throw new Error('Import a resume first');
    const resumePath = localPath(dir, profile.resume.path);
    const actual = fingerprint(readBytes(resumePath, { maxBytes: MAX_RESUME_BYTES, base: dir }));
    if (review.sha256 !== actual || profile.resume.sha256 !== actual) throw new Error('Review must refer to the current registered file');
    if (!['ready', 'needs_changes'].includes(review.status) || typeof review.evidence !== 'string' || !review.evidence.trim()) throw new Error('Review needs status and evidence');
    if (review.status === 'ready' && !['text', 'visual', 'facts'].every(k => review.checks?.[k] === 'pass')) throw new Error('Ready requires recorded text, visual and factual checks');
    profile.resume.review_status = review.status;
    profile.confirmed_at = null;
    store.writeManagedJSON('profile.json', profile, { expectedSha256: fingerprint(profileBytes), eventKind: 'resume_reviewed', eventPayload: review });
    return { recorded: true, confirmation_required: true, status: review.status };
  } finally { store.close(); }
}
