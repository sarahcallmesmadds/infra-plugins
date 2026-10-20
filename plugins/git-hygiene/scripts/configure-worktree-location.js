#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWithin, physicalPath } = require('./worktree-location');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return `${os.homedir()}${path.sep}${value.slice(2)}`;
  return value;
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the config must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${CONFIG_FILE}: ${error.message}`);
  }
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
    projectRoot: expandHome(values['--project-root']),
    worktreeRoot: expandHome(values['--worktree-root']),
    replace: Boolean(values.replace),
  };
}

function normalizeRoots(projectRootInput, worktreeRootInput) {
  if (!path.isAbsolute(projectRootInput) || !path.isAbsolute(worktreeRootInput)) {
    throw new Error('Both paths must be absolute paths (or begin with ~/).');
  }
  const projectRoot = physicalPath(projectRootInput);
  const worktreeRoot = physicalPath(worktreeRootInput);
  requireExistingDirectory(projectRoot, 'Project root');
  requireDirectoryOrMissing(worktreeRoot, 'Worktree root');
  if (projectRoot === worktreeRoot || !isWithin(worktreeRoot, projectRoot)) {
    throw new Error('Worktree root must be a different folder inside the project root.');
  }
  return { projectRoot, worktreeRoot };
}

function requireExistingDirectory(value, label) {
  try {
    if (!fs.statSync(value).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`${label} is not an existing directory: ${value} (${error.message})`);
  }
}

function requireDirectoryOrMissing(value, label) {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (!fs.statSync(current).isDirectory()) {
        throw new Error(`${label} has a non-directory path component: ${current}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function atomicWrite(config) {
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
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* No temporary file remains. */ }
    throw error;
  }
}

function configure(options) {
  const roots = normalizeRoots(options.projectRoot, options.worktreeRoot);
  const config = readConfig();
  if (Object.prototype.hasOwnProperty.call(config, 'worktreeLocation') && !options.replace) {
    throw new Error('A worktreeLocation setting already exists. Review it, then rerun with --replace-existing to change it.');
  }
  config.worktreeLocation = roots;
  atomicWrite(config);
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
