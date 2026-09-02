#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_PATH = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (typeof value === 'string' && value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function absolute(value) {
  const expanded = expandHome(value);
  if (typeof expanded !== 'string' || !expanded) return null;
  const resolved = path.resolve(expanded);
  const missing = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync.native(existing), ...missing); }
  catch (_) { return resolved; }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function configPath() {
  return process.env.GIT_HYGIENE_CONFIG || DEFAULT_PATH;
}

function defaults() {
  return {
    projectRoots: [],
    worktreeRoot: path.join(os.homedir(), '.worktrees'),
    enforceWorktreeRoot: false,
    sessionNotice: false,
  };
}

function validate(raw) {
  const errors = [];
  const normalized = defaults();

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['configuration must be a JSON object'], config: normalized };
  }

  if (!Array.isArray(raw.projectRoots) || raw.projectRoots.length === 0) {
    errors.push('projectRoots must contain at least one directory');
  } else {
    const roots = raw.projectRoots.map(absolute);
    if (roots.some((root) => !root)) errors.push('every project root must be a non-empty path');
    else normalized.projectRoots = [...new Set(roots)];
  }

  const worktreeRoot = absolute(raw.worktreeRoot);
  if (!worktreeRoot) errors.push('worktreeRoot must be a non-empty path');
  else normalized.worktreeRoot = worktreeRoot;

  if (typeof raw.enforceWorktreeRoot !== 'boolean') {
    errors.push('enforceWorktreeRoot must be true or false');
  } else {
    normalized.enforceWorktreeRoot = raw.enforceWorktreeRoot;
  }

  if (typeof raw.sessionNotice !== 'boolean') {
    errors.push('sessionNotice must be true or false');
  } else {
    normalized.sessionNotice = raw.sessionNotice;
  }

  if (worktreeRoot && normalized.projectRoots.some((root) => (
    contains(root, worktreeRoot) || contains(worktreeRoot, root)
  ))) {
    errors.push('worktreeRoot and visible project roots must not overlap');
  }

  return { valid: errors.length === 0, errors, config: normalized };
}

function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { ...defaults(), exists: false, valid: true, errors: [], file };
  }

  try {
    const checked = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { ...checked.config, exists: true, valid: checked.valid, errors: checked.errors, file };
  } catch (error) {
    return { ...defaults(), exists: true, valid: false, errors: [`configuration could not be read: ${error.message}`], file };
  }
}

function isGitRepository(candidate) {
  try {
    execFileSync('git', ['-C', candidate, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function rootHasRepository(root) {
  if (!fs.existsSync(root)) return false;
  if (isGitRepository(root)) return true;
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .some((entry) => isGitRepository(path.join(root, entry.name)));
  } catch (_) {
    return false;
  }
}

function propose(cwd = process.cwd(), home = os.homedir()) {
  const candidates = ['Projects', 'Developer', 'src', 'code', 'repos', 'work']
    .map((name) => path.join(home, name));
  const worktreeRoot = absolute(path.join(home, '.worktrees'));

  let currentRoot = null;
  try {
    // A linked checkout's top level lives under the hidden worktree root. Git
    // lists the primary checkout first, so use its parent as the visible root
    // instead of proposing a configuration that overlaps itself.
    const listed = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const primary = listed.split('\n').find((line) => line.startsWith('worktree '));
    if (primary) currentRoot = path.dirname(absolute(primary.slice('worktree '.length)));
  } catch (_) {
    // A setup run from outside a repository can still discover common roots.
  }

  const projectRoots = [...new Set([currentRoot, ...candidates].map(absolute).filter(Boolean))]
    .filter(rootHasRepository)
    .filter((root) => !contains(root, worktreeRoot) && !contains(worktreeRoot, root));

  return {
    projectRoots,
    worktreeRoot,
    enforceWorktreeRoot: true,
    sessionNotice: true,
  };
}

function writeConfig(raw) {
  const checked = validate(raw);
  if (!checked.valid) throw new Error(checked.errors.join('; '));

  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.git-hygiene.config.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(checked.config, null, 2) + '\n';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) { /* renamed or never created */ }
  }

  const readBack = loadConfig();
  if (!readBack.valid || !readBack.exists) throw new Error('configuration was written but did not read back as valid');
  return readBack;
}

function parseArgs(argv) {
  const out = { command: argv[0] || 'show', projectRoots: [] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--project-root') out.projectRoots.push(argv[++i]);
    else if (argv[i] === '--worktree-root') out.worktreeRoot = argv[++i];
    else if (argv[i] === '--enforce') out.enforceWorktreeRoot = true;
    else if (argv[i] === '--no-enforce') out.enforceWorktreeRoot = false;
    else if (argv[i] === '--session-notice') out.sessionNotice = true;
    else if (argv[i] === '--no-session-notice') out.sessionNotice = false;
    else if (argv[i] === '--approved') out.approved = true;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return out;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }

  try {
    if (args.command === 'show') {
      process.stdout.write(JSON.stringify(loadConfig(), null, 2) + '\n');
      return;
    }
    if (args.command === 'propose') {
      process.stdout.write(JSON.stringify(propose(), null, 2) + '\n');
      return;
    }
    if (args.command !== 'write') throw new Error(`unknown command: ${args.command}`);
    if (!args.approved) throw new Error('refusing to write configuration without --approved');
    const current = loadConfig();
    const next = {
      projectRoots: args.projectRoots.length ? args.projectRoots : current.projectRoots,
      worktreeRoot: args.worktreeRoot || current.worktreeRoot,
      enforceWorktreeRoot: args.enforceWorktreeRoot === undefined
        ? current.enforceWorktreeRoot
        : args.enforceWorktreeRoot,
      sessionNotice: args.sessionNotice === undefined ? current.sessionNotice : args.sessionNotice,
    };
    process.stdout.write(JSON.stringify(writeConfig(next), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  configPath,
  contains,
  defaults,
  expandHome,
  loadConfig,
  propose,
  validate,
  writeConfig,
};
