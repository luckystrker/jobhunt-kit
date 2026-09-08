import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Tracker } from './tracker.mjs';
import { atomicWriteJSON, readBytes, readJSON as safeReadJSON, sha256 } from './files.mjs';
import { schemaErrors } from './validation.mjs';

export const readJSON = path => safeReadJSON(path);
export function writeJSON(path, value, base = dirname(path)) { atomicWriteJSON(path, value, { base }); }
const filled = value => typeof value === 'string' && value.trim().length > 0;
export function validateProfile(p) {
  const errors = schemaErrors('profile', p);
  const warnings = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { valid: false, errors, warnings };
  if (p.schema_version !== 1) errors.push('schema_version must be 1');
  for (const field of ['identity', 'search', 'resume', 'availability', 'writing']) {
    if (!p[field] || typeof p[field] !== 'object' || Array.isArray(p[field])) errors.push(`${field} must be an object`);
  }
  for (const field of ['experience', 'education', 'skills', 'achievements', 'evidence', 'answers', 'languages']) {
    if (!Array.isArray(p[field])) errors.push(`${field} must be an array`);
  }
  if (!Array.isArray(p.search?.roles) || !p.search.roles.length || !p.search.roles.every(filled)) errors.push('Specify at least one target role');
  const ids = new Set();
  for (const e of Array.isArray(p.evidence) ? p.evidence : []) {
    if (!e || !filled(e.id) || !filled(e.text) || !filled(e.source) || typeof e.confirmed !== 'boolean') errors.push('Evidence needs id, text, source and boolean confirmed');
    else if (ids.has(e.id)) errors.push(`Duplicate evidence ID: ${e.id}`);
    else ids.add(e.id);
  }
  for (const field of ['experience', 'education', 'skills', 'achievements', 'answers']) {
    for (const entry of Array.isArray(p[field]) ? p[field] : []) {
      if (!entry || typeof entry !== 'object') { errors.push(`${field} entries must be objects`); continue; }
      if (entry.evidence_ids !== undefined && !Array.isArray(entry.evidence_ids)) errors.push(`${field}.evidence_ids must be an array`);
      else for (const id of entry.evidence_ids || []) if (!ids.has(id)) errors.push(`${field}: unknown evidence ${id}`);
    }
  }
  const salary = p.search?.salary;
  if (salary?.min !== null && salary?.min !== undefined || salary?.target !== null && salary?.target !== undefined) {
    for (const k of ['currency', 'period', 'tax_basis']) if (!filled(salary[k])) errors.push(`Salary needs ${k}`);
    for (const k of ['min', 'target']) if (salary[k] !== null && salary[k] !== undefined && (!Number.isFinite(salary[k]) || salary[k] < 0)) errors.push(`Invalid salary ${k}`);
    if (typeof salary.min === 'number' && typeof salary.target === 'number' && salary.target < salary.min) errors.push('Salary target is below minimum');
  }
  if (p.confirmed_at !== null && (!filled(p.confirmed_at) || !Number.isFinite(Date.parse(p.confirmed_at)))) errors.push('confirmed_at must be null or an ISO timestamp');
  for (const k of ['name', 'email']) if (!filled(p.identity?.[k])) warnings.push(`Missing ${k}; needed before applying`);
  if (!p.search?.countries?.length) warnings.push('Clarify geographical restrictions or explicitly allow any country');
  if (!p.search?.work_modes?.length) warnings.push('Clarify work modes or explicitly allow any');
  if (!(p.evidence || []).some?.(e => e?.confirmed)) warnings.push('No confirmed evidence for application claims');
  return { valid: errors.length === 0, confirmed: Boolean(p.confirmed_at), errors, warnings };
}
export function saveProfile(dir, input) {
  const check = validateProfile({ ...input, confirmed_at: null });
  if (!check.valid) throw new Error(check.errors.join('; '));
  const file = join(dir, 'profile.json');
  if (!existsSync(file)) throw new Error('Run profile init first');
  const next = { ...input, confirmed_at: null };
  const store = new Tracker(dir);
  try {
    const previousBytes = readBytes(file, { base: dir });
    const previous = JSON.parse(previousBytes.toString('utf8').replace(/^\uFEFF/, ''));
    const changed_fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
      .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
    store.writeManagedJSON('profile.json', next, { expectedSha256: sha256(previousBytes), eventKind: 'profile_saved', eventPayload: { changed_fields } });
    return { saved: true, confirmation_required: true, check };
  } finally { store.close(); }
}
export function confirmProfile(dir, note) {
  if (!filled(note)) throw new Error('Explicit user confirmation note required');
  const file = join(dir, 'profile.json');
  const store = new Tracker(dir);
  try {
    const profileBytes = readBytes(file, { base: dir });
    const profile = JSON.parse(profileBytes.toString('utf8').replace(/^\uFEFF/, ''));
    const check = validateProfile(profile);
    if (!check.valid) throw new Error(check.errors.join('; '));
    profile.confirmed_at = new Date().toISOString();
    const profileHash = serializedHash(profile);
    store.writeManagedJSON('profile.json', profile, { expectedSha256: sha256(profileBytes), eventKind: 'profile_confirmed',
      eventPayload: { user_confirmation: note, profile_hash: profileHash } });
    const result = store.profile();
    return { confirmed_at: profile.confirmed_at, hash: result.hash, warnings: check.warnings };
  } finally { store.close(); }
}

function serializedHash(value) { return sha256(JSON.stringify(value)); }
