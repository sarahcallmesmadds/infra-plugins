'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');
const OPTIONS_WITH_VALUES = new Set(['-b', '-B', '--reason']);

function expandConfiguredPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const expanded = value.trim().replace(/^~(?=\/|$)/, os.homedir());
  if (expanded.includes('$')) return null;
  return physicalPath(expanded);
}

function physicalPath(value) {
  const absolute = path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}`;
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep)) {
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    try { current = fs.realpathSync(next); }
    catch (_) { current = next; }
  }
  return current;
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
  let quoted = false;
  let singleQuoted = false;
  let tildeEligible = true;
  let tokenStarted = false;
  const flush = () => {
    if (tokenStarted) tokens.push({ value: token, quoted, singleQuoted, tildeEligible });
    token = '';
    quoted = false;
    singleQuoted = false;
    tildeEligible = true;
    tokenStarted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (escaped) {
      if (char === '\n') { escaped = false; continue; }
      token += char;
      escaped = false;
      continue;
    }
    if (!quote && char === '\n') {
      flush();
      tokens.push({ op: ';' });
      continue;
    }
    if (char === '\\' && quote !== "'") {
      if (!token) tildeEligible = false;
      tokenStarted = true;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else { token += char; quoted = true; if (quote === "'") singleQuoted = true; }
      continue;
    }
    if (char === "'" || char === '"') {
      if (!token) tildeEligible = false;
      tokenStarted = true;
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (';&|(){}'.includes(char)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') {
        tokens.push({ op: pair });
        i += 1;
      } else tokens.push({ op: char });
      continue;
    }
    token += char;
  }
  if (escaped) token += '\\';
  flush();
  return tokens;
}

function expandShellText(token, unresolvedVariables = new Set()) {
  const value = token.value;
  let expanded = token.tildeEligible === false ? value : value.replace(/^~(?=\/|$)/, os.homedir());
  if (!token.singleQuoted) {
    expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced, bare) => {
        const name = braced || bare;
        return unresolvedVariables.has(name) ? match : (process.env[name] || match);
      });
  }
  if (expanded.includes('$') || expanded.includes('$(') || expanded.includes('`')
      || /[*?\[]/.test(expanded)) return null;
  return expanded;
}

function expandShellPath(token, cwd, unresolvedVariables = new Set()) {
  const expanded = expandShellText(token, unresolvedVariables);
  if (expanded === null) return null;
  if (!cwd && !path.isAbsolute(expanded)) return null;
  const joined = path.isAbsolute(expanded) ? expanded : `${cwd}${path.sep}${expanded}`;
  return physicalPath(joined);
}

function expandCdPath(token, cwd, unresolvedVariables) {
  const expanded = expandShellText(token, unresolvedVariables);
  if (expanded === null || !cwd) return null;
  // The shell's default cd follows logical PWD semantics, resolving '..' before
  // following symlinks. The resulting process directory is then physical.
  return physicalPath(path.resolve(cwd, expanded));
}

function gitCommand(tokens, start, activeCwd, unresolvedVariables) {
  let index = start + 1;
  let repoCwd = activeCwd;
  while (index < tokens.length && !tokens[index].op) {
    const token = tokens[index].value;
    if (token === '-C' && tokens[index + 1] && !tokens[index + 1].op) {
      const next = expandShellPath(tokens[index + 1], repoCwd, unresolvedVariables);
      repoCwd = next || null;
      index += 2;
      continue;
    }
    if (token.startsWith('-C') && token.length > 2) {
      const next = expandShellPath({ value: token.slice(2), quoted: false }, repoCwd, unresolvedVariables);
      repoCwd = next || null;
      index += 1;
      continue;
    }
    if (token === '-c' || token === '--git-dir' || token === '--work-tree'
        || token === '--namespace') {
      index += 2;
      continue;
    }
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=')
        || token.startsWith('--namespace=') || token === '--no-pager'
        || token === '--no-optional-locks' || token === '--literal-pathspecs'
        || token === '--no-replace-objects' || token === '--no-lazy-fetch'
        || token.startsWith('-c')) {
      index += 1;
      continue;
    }
    break;
  }

  if (!tokens[index] || tokens[index].value !== 'worktree'
      || !tokens[index + 1] || tokens[index + 1].value !== 'add') {
    return { end: index, target: null, unknown: false };
  }
  index += 2;
  while (index < tokens.length && !tokens[index].op) {
    const token = tokens[index].value;
    if (token === '--') {
      index += 1;
      break;
    }
    if (token.startsWith('--reason=')) { index += 1; continue; }
    if (OPTIONS_WITH_VALUES.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    const target = repoCwd && expandShellPath(tokens[index], repoCwd, unresolvedVariables);
    return { end: index + 1, target, unknown: !target };
  }
  if (index < tokens.length && !tokens[index].op) {
    const target = repoCwd && expandShellPath(tokens[index], repoCwd, unresolvedVariables);
    return { end: index + 1, target, unknown: !target };
  }
  return { end: index, target: null, unknown: false };
}

function misplacedTarget(command, cwd, policy) {
  const tokens = shellTokens(stripHereDocuments(command));
  let activeCwd = path.resolve(cwd || process.cwd());
  const cwdStack = [];
  const unresolvedVariables = new Set();
  let commandStart = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (item.op) {
      if (item.op === '(') cwdStack.push(activeCwd);
      if (item.op === ')') activeCwd = cwdStack.length ? cwdStack.pop() : null;
      commandStart = true;
      continue;
    }
    if (!commandStart) continue;
    if (['if', 'then', 'do', 'else', 'elif', '!', 'time'].includes(item.value)) continue;
    commandStart = false;
    const executable = item.value.split('/').pop();
    if (['env', 'command', 'builtin'].includes(executable)) {
      let candidate = index + 1;
      while (tokens[candidate] && !tokens[candidate].op) {
        const assignment = tokens[candidate].value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (assignment) unresolvedVariables.add(assignment[1]);
        if (assignment || tokens[candidate].value.startsWith('-')) candidate += 1;
        else break;
      }
      if (tokens[candidate] && !tokens[candidate].op
          && tokens[candidate].value.split('/').pop() === 'git') index = candidate;
      else continue;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(item.value)) {
      let candidate = index;
      while (tokens[candidate] && !tokens[candidate].op
          && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[candidate].value)) candidate += 1;
      for (let assigned = index; assigned < candidate; assigned += 1) {
        unresolvedVariables.add(tokens[assigned].value.split('=')[0]);
      }
      if (tokens[candidate] && !tokens[candidate].op
          && tokens[candidate].value.split('/').pop() === 'git') index = candidate;
      else continue;
    }
    const commandItem = tokens[index];
    const commandExecutable = commandItem.value.split('/').pop();
    if (['bash', 'sh', 'zsh', 'dash'].includes(commandExecutable)) {
      let scriptIndex = index + 1;
      while (tokens[scriptIndex] && !tokens[scriptIndex].op
          && tokens[scriptIndex].value !== '-c') scriptIndex += 1;
      if (tokens[scriptIndex] && tokens[scriptIndex].value === '-c'
          && tokens[scriptIndex + 1] && !tokens[scriptIndex + 1].op) {
        const nested = misplacedTarget(tokens[scriptIndex + 1].value, activeCwd, policy);
        if (nested) return nested;
      }
      continue;
    }
    let cdOperand = index + 1;
    if (commandExecutable === 'cd' && tokens[cdOperand]
        && tokens[cdOperand].value === '--') cdOperand += 1;
    if (commandExecutable === 'cd' && tokens[cdOperand] && !tokens[cdOperand].op) {
      let inPipelineOrBackground = false;
      for (let look = cdOperand + 1; look < tokens.length && !tokens[look].op
          || (tokens[look] && ['|', '&'].includes(tokens[look].op)); look += 1) {
        if (tokens[look].op === '|' || tokens[look].op === '&') inPipelineOrBackground = true;
      }
      const changed = expandCdPath(tokens[cdOperand], activeCwd, unresolvedVariables);
      if (!inPipelineOrBackground) {
        activeCwd = changed;
        unresolvedVariables.add('PWD');
      }
      index = cdOperand;
      continue;
    }
    if (commandExecutable !== 'git') continue;
    const result = gitCommand(tokens, index, activeCwd, unresolvedVariables);
    if (result.target && isWithin(result.target, policy.projectRoot)
        && !isWithin(result.target, policy.worktreeRoot)) return result.target;
    if (result.unknown) return { unknown: true };
    index = Math.max(index, result.end - 1);
  }
  return null;
}

function stripHereDocuments(command) {
  const lines = command.split('\n');
  const output = [];
  const substitutions = [];
  let delimiter = null;
  let stripTabs = false;
  let expandBody = false;
  for (const line of lines) {
    if (delimiter) {
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) delimiter = null;
      if (expandBody) {
        const pattern = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g;
        let match;
        while ((match = pattern.exec(line))) substitutions.push(match[1] || match[2]);
      }
      output.push('');
      continue;
    }
    output.push(line);
    const heredoc = findHereDocument(line);
    if (heredoc) {
      stripTabs = heredoc.stripTabs;
      delimiter = heredoc.delimiter;
      expandBody = !heredoc.quoted;
    }
  }
  return output.concat(substitutions).join('\n');
}

function findHereDocument(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length - 1; i += 1) {
    const char = line[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (char !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') continue;
    let cursor = i + 2;
    let stripTabs = false;
    if (line[cursor] === '-') { stripTabs = true; cursor += 1; }
    while (/\s/.test(line[cursor] || '') && cursor < line.length) cursor += 1;
    let delimiter = '';
    let wordQuote = null;
    let quoted = false;
    while (cursor < line.length) {
      const part = line[cursor];
      if (!wordQuote && /\s/.test(part)) break;
      if (!wordQuote && (part === "'" || part === '"')) { wordQuote = part; quoted = true; cursor += 1; continue; }
      if (wordQuote && part === wordQuote) { wordQuote = null; cursor += 1; continue; }
      if (part === '\\' && wordQuote !== "'") { quoted = true; cursor += 1; }
      else delimiter += part;
      cursor += 1;
    }
    if (delimiter) return { delimiter, stripTabs, quoted };
  }
  return null;
}

module.exports = { loadPolicy, misplacedTarget };
