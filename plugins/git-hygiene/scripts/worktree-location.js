'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');
const SEPARATORS = new Set([';', '&&', '||', '|', '&']);
const OPTIONS_WITH_VALUES = new Set(['-b', '-B', '--reason', '--expire', '--orphan']);

function expandConfiguredPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const expanded = value.trim().replace(/^~(?=\/|$)/, os.homedir());
  if (expanded.includes('$')) return null;
  return path.resolve(expanded);
}

function loadPolicy() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const section = config && config.worktreeLocation;
    if (!section) return null;
    const projectRoot = expandConfiguredPath(section.projectRoot);
    const worktreeRoot = expandConfiguredPath(section.worktreeRoot);
    if (!projectRoot || !worktreeRoot || !isWithin(worktreeRoot, projectRoot)
        || worktreeRoot === projectRoot) return null;
    return { projectRoot, worktreeRoot };
  } catch (_) {
    return null;
  }
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function shellTokens(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  const flush = () => {
    if (token) tokens.push(token);
    token = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (';&|'.includes(char)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') {
        tokens.push(pair);
        i += 1;
      } else tokens.push(char);
      continue;
    }
    token += char;
  }
  if (escaped) token += '\\';
  flush();
  return tokens;
}

function expandShellPath(value, cwd) {
  let expanded = value.replace(/^~(?=\/|$)/, os.homedir());
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => process.env[braced || bare] || match);
  if (expanded.includes('$') || expanded.includes('$(') || expanded.includes('`')) return null;
  return path.resolve(cwd, expanded);
}

function gitCommand(tokens, start, activeCwd) {
  let index = start + 1;
  let repoCwd = activeCwd;
  while (index < tokens.length && !SEPARATORS.has(tokens[index])) {
    const token = tokens[index];
    if (token === '-C' && tokens[index + 1]) {
      const next = expandShellPath(tokens[index + 1], repoCwd);
      if (next) repoCwd = next;
      index += 2;
      continue;
    }
    if (token.startsWith('-C') && token.length > 2) {
      const next = expandShellPath(token.slice(2), repoCwd);
      if (next) repoCwd = next;
      index += 1;
      continue;
    }
    if (token === '-c' || token === '--git-dir' || token === '--work-tree'
        || token === '--namespace') {
      index += 2;
      continue;
    }
    if (token === '--no-pager' || token.startsWith('-c')) {
      index += 1;
      continue;
    }
    break;
  }

  if (tokens[index] !== 'worktree' || tokens[index + 1] !== 'add') {
    return { end: index, target: null, unknown: false };
  }
  index += 2;
  while (index < tokens.length && !SEPARATORS.has(tokens[index])) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (OPTIONS_WITH_VALUES.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    const target = expandShellPath(token, repoCwd);
    return { end: index + 1, target, unknown: !target };
  }
  if (index < tokens.length && !SEPARATORS.has(tokens[index])) {
    const target = expandShellPath(tokens[index], repoCwd);
    return { end: index + 1, target, unknown: !target };
  }
  return { end: index, target: null, unknown: false };
}

function misplacedTarget(command, cwd, policy) {
  const tokens = shellTokens(command);
  let activeCwd = path.resolve(cwd || process.cwd());
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === 'cd' && tokens[index + 1]
        && !SEPARATORS.has(tokens[index + 1])) {
      const changed = expandShellPath(tokens[index + 1], activeCwd);
      if (changed) activeCwd = changed;
      index += 1;
      continue;
    }
    if (tokens[index] !== 'git') continue;
    const result = gitCommand(tokens, index, activeCwd);
    if (result.target && isWithin(result.target, policy.projectRoot)
        && !isWithin(result.target, policy.worktreeRoot)) return result.target;
    if (result.unknown) return { unknown: true };
    index = Math.max(index, result.end - 1);
  }
  return null;
}

module.exports = { loadPolicy, misplacedTarget };
