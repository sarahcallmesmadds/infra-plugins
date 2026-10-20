#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRoots } = require('./worktree-location');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');

function readRaw() {
  try { return fs.readFileSync(CONFIG_FILE, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${CONFIG_FILE}: ${error.message}`);
  }
}

function parseConfig(raw) {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the config must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cannot read ${CONFIG_FILE}: ${error.message}`);
  }
}

function readConfig() {
  return parseConfig(readRaw());
}

function show() {
  const config = readConfig();
  process.stdout.write(`${JSON.stringify({
    configPath: CONFIG_FILE,
    configured: Object.prototype.hasOwnProperty.call(config, 'worktreeLocation'),
    worktreeLocation: config.worktreeLocation === undefined ? null : config.worktreeLocation,
  }, null, 2)}\n`);
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--show') return { show: true };
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--project-root', '--worktree-root', '--replace-existing'].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Duplicate option: ${key}`);
    if (key === '--replace-existing') {
      if (argv[i + 1] !== undefined) throw new Error('--replace-existing takes no value');
      values.replace = true;
      continue;
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} needs a path`);
    values[key] = argv[i + 1];
  }
  if (!values['--project-root'] || !values['--worktree-root']) {
    throw new Error('Provide --project-root and --worktree-root, or use --show');
  }
  return {
    projectRoot: values['--project-root'],
    worktreeRoot: values['--worktree-root'],
    replace: Boolean(values.replace),
  };
}

// `expected` is the file text this run read. Another session can rewrite the
// file between that read and the rename; without this re-read, its keys vanish.
function atomicWrite(config, expected) {
  let destination = CONFIG_FILE;
  try {
    destination = fs.realpathSync.native(CONFIG_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      if (fs.lstatSync(CONFIG_FILE).isSymbolicLink()) {
        throw new Error(`Cannot update dangling configuration symlink: ${CONFIG_FILE}`);
      }
    } catch (lstatError) {
      if (lstatError.code !== 'ENOENT') throw lstatError;
    }
  }
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (readRaw() !== expected) {
      throw new Error(`${CONFIG_FILE} changed while setup was running. Nothing was written; run setup again.`);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* No temporary file remains. */ }
    throw error;
  }
}

function configure(options) {
  const roots = resolveRoots(options.projectRoot, options.worktreeRoot);
  const raw = readRaw();
  const config = parseConfig(raw);
  if (Object.prototype.hasOwnProperty.call(config, 'worktreeLocation') && !options.replace) {
    throw new Error('A worktreeLocation setting already exists. Review it, then rerun with --replace-existing to change it.');
  }
  config.worktreeLocation = roots;
  atomicWrite(config, raw);
  process.stdout.write(`Configured worktreeLocation in ${CONFIG_FILE}.\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.show) show();
  else configure(options);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
