// The list of declared threads, at ~/.planning/handoffs/threads.json.
//
// A thread is a central handoff that is rewritten in place at every wrap and
// is the only authority for its own rules. Which documents are threads is
// declared here rather than inferred, because inference was tried on paper and
// failed both ways: a filename suffix promotes nothing a person did not name
// that way, and "every central handoff is a thread" promotes years of session
// logs, one of them carrying 505 rules, into binding documents.
//
// No file means the plugin has not been migrated and behaves as it always did.
// A file that exists and cannot be trusted is `invalid`, and every command that
// writes refuses on it: guessing which documents are threads is exactly the
// decision this file exists to take away from the code.
//
// Shape:
//   { "version": 1, "generation": 3, "migratedAt": "...",
//     "threads": [ { "slug": "site-thread", "path": "/abs/HANDOFF-site-thread.md" } ],
//     "pending": [ { "kind": "add" | "drop", "slug": "site-thread", "text": "..." } ] }
//
// `generation` changes on every migration, never on an ordinary save, and is
// never reused. A draft carries the generation it was prepared under, so one
// written before a migration cannot be saved after it.
//
// `pending` is what a migration still has to write into thread files. While it
// is not empty nothing reads a home thread's rules as binding, because a list
// that is half written is neither the old answer nor the new one.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function registryPath(home = os.homedir()) {
  return path.join(home, '.planning', 'handoffs', 'threads.json');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['not a JSON object'];
  if (raw.version !== 1) errors.push(`version is ${JSON.stringify(raw.version)}, expected 1`);
  if (!Number.isInteger(raw.generation) || raw.generation < 1) errors.push('generation must be a whole number of at least 1');
  if (!Array.isArray(raw.threads)) errors.push('threads must be a list');
  if (raw.pending !== undefined && !Array.isArray(raw.pending)) errors.push('pending must be a list');
  if (errors.length) return errors;

  const slugs = new Set();
  const paths = new Set();
  raw.threads.forEach((t, i) => {
    if (!t || typeof t !== 'object') { errors.push(`thread ${i + 1} is not an object`); return; }
    if (typeof t.slug !== 'string' || !t.slug || slugify(t.slug) !== t.slug) errors.push(`thread ${i + 1} has an unusable slug`);
    if (typeof t.path !== 'string' || !path.isAbsolute(t.path)) errors.push(`thread ${i + 1} path must be absolute`);
    if (slugs.has(t.slug)) errors.push(`slug ${t.slug} is declared twice`);
    if (paths.has(t.path)) errors.push(`path ${t.path} is declared twice`);
    slugs.add(t.slug);
    paths.add(t.path);
  });
  (raw.pending || []).forEach((p, i) => {
    if (!p || (p.kind !== 'add' && p.kind !== 'drop') || typeof p.text !== 'string' || !p.text.trim()) {
      errors.push(`pending item ${i + 1} is malformed`);
    } else if (!slugs.has(p.slug)) {
      errors.push(`pending item ${i + 1} names ${p.slug}, which is not declared`);
    }
  });
  return errors;
}

// { state: 'absent' | 'invalid' | 'ok', registry, errors }
function readRegistry(home = os.homedir()) {
  let text;
  try {
    text = fs.readFileSync(registryPath(home), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent', registry: null, errors: [] };
    return { state: 'invalid', registry: null, errors: [`could not be read: ${e.message}`] };
  }
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    return { state: 'invalid', registry: null, errors: [`is not valid JSON: ${e.message}`] };
  }
  const errors = validate(raw);
  if (errors.length) return { state: 'invalid', registry: null, errors };
  return { state: 'ok', registry: { ...raw, pending: raw.pending || [] }, errors: [] };
}

// Temp file and rename, so a reader sees the old list or the new one and never
// half of one. Only ever called from inside a locked region.
function writeRegistryUnlocked(registry, home = os.homedir()) {
  const errors = validate(registry);
  if (errors.length) throw new Error(`refusing to write an invalid thread list: ${errors.join('; ')}`);
  const file = registryPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function declaredBySlug(registry, slug) {
  if (!registry) return null;
  const key = slugify(slug);
  return registry.threads.find((t) => t.slug === key) || null;
}

function declaredPaths(registry) {
  if (!registry) return new Set();
  const out = new Set();
  for (const t of registry.threads) {
    out.add(t.path);
    try { out.add(fs.realpathSync(t.path)); } catch (_) { /* not there; the plain path is enough */ }
  }
  return out;
}

module.exports = {
  registryPath,
  readRegistry,
  writeRegistryUnlocked,
  declaredBySlug,
  declaredPaths,
  validate,
};
