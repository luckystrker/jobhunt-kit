import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat('date-time', value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
ajv.addFormat('uri', value => {
  try { const url = new URL(value); return Boolean(url.protocol); } catch { return false; }
});

const validators = new Map();
for (const name of ['profile', 'policy', 'vacancy', 'draft', 'finish', 'status']) {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', `${name}.schema.json`), 'utf8'));
  validators.set(name, ajv.compile(schema));
}

export function validateSchema(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new Error(`Unknown schema: ${name}`);
  if (validate(value)) return value;
  const detail = validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
  throw new Error(`${name} schema: ${detail}`);
}

export function schemaErrors(name, value) {
  try { validateSchema(name, value); return []; }
  catch (error) { return [error.message]; }
}
