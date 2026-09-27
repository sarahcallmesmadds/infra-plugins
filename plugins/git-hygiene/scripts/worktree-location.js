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
  let escapedExpansion = false;
  let substitutions = [];
  const flush = () => {
    if (tokenStarted) tokens.push({ value: token, quoted, singleQuoted, tildeEligible,
      escapedExpansion, substitutions });
    token = '';
    quoted = false;
    singleQuoted = false;
    tildeEligible = true;
    tokenStarted = false;
    escapedExpansion = false;
    substitutions = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (escaped) {
      if (char === '\n') { escaped = false; continue; }
      if (char === '$' || char === '`') escapedExpansion = true;
      token += char;
      escaped = false;
      continue;
    }
    if (!quote && char === '\n') {
      flush();
      tokens.push({ op: ';' });
      continue;
    }
    if (!quote && char === '#' && !tokenStarted) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      if (!token) tildeEligible = false;
      tokenStarted = true;
      escaped = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && char === '$' && command[i + 1] === '(') {
        const end = substitutionEnd(command, i + 1);
        if (end > i) { substitutions.push(command.slice(i + 2, end)); token += command.slice(i, end + 1); i = end; continue; }
      }
      if (quote === '"' && char === '`') {
        const end = command.indexOf('`', i + 1);
        if (end >= 0) { substitutions.push(command.slice(i + 1, end)); token += command.slice(i, end + 1); i = end; continue; }
      }
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
    if (char === '$' && command[i + 1] === '(') {
      const end = substitutionEnd(command, i + 1);
      if (end > i) { substitutions.push(command.slice(i + 2, end)); token += command.slice(i, end + 1); tokenStarted = true; i = end; continue; }
    }
    if (char === '`') {
      const end = command.indexOf('`', i + 1);
      if (end >= 0) { substitutions.push(command.slice(i + 1, end)); token += command.slice(i, end + 1); tokenStarted = true; i = end; continue; }
    }
    if (char === '<' || char === '>') {
      flush();
      if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1].value)) tokens.pop();
      let redirection = char;
      if (command[i + 1] === char) { redirection += char; i += 1; }
      if (command[i + 1] === '&') { redirection += '&'; i += 1; }
      tokens.push({ op: `redirect:${redirection}` });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (';&|()'.includes(char)
        || (char === '{' && !tokenStarted && /\s/.test(command[i + 1] || ''))
        || (char === '}' && !tokenStarted)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') {
        tokens.push({ op: pair });
        i += 1;
      } else tokens.push({ op: char });
      continue;
    }
    tokenStarted = true;
    token += char;
  }
  if (escaped) token += '\\';
  flush();
  return tokens;
}

function expandShellText(token, unresolvedVariables = new Set()) {
  const value = token.value;
  if (token.escapedExpansion && value.includes('$')) return null;
  let expanded = token.tildeEligible === false ? value : value.replace(/^~(?=\/|$)/, os.homedir());
  if (!token.singleQuoted) {
    expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced, bare) => {
        const name = braced || bare;
        return unresolvedVariables.has(name) ? match : (process.env[name] || match);
      });
  }
  if (expanded.includes('$') || expanded.includes('$(') || expanded.includes('`')
      || /[*?\[{}]/.test(expanded)) return null;
  return expanded;
}

function expandShellPath(token, cwd, unresolvedVariables = new Set()) {
  const expanded = expandShellText(token, unresolvedVariables);
  if (expanded === null) return null;
  if (!cwd && !path.isAbsolute(expanded)) return null;
  const joined = path.isAbsolute(expanded) ? expanded : `${cwd}${path.sep}${expanded}`;
  return physicalPath(joined);
}

function expandCdPath(token, cwd, unresolvedVariables, physical = false) {
  const expanded = expandShellText(token, unresolvedVariables);
  if (expanded === null || !cwd) return null;
  if (expanded === '-') return null;
  const logical = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
  const resolved = physical ? physicalPath(path.isAbsolute(expanded)
    ? expanded : `${cwd}${path.sep}${expanded}`) : physicalPath(logical);
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch (_) { return null; }
  return physical ? resolved : logical;
}

function gitCommand(tokens, start, activeCwd, unresolvedVariables) {
  let index = start + 1;
  let repoCwd = activeCwd;
  while (index < tokens.length && (!tokens[index].op || tokens[index].op.startsWith('redirect:'))) {
    if (tokens[index].op && tokens[index].op.startsWith('redirect:')) {
      index += 2;
      continue;
    }
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
        || token === '--paginate' || token === '-P'
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
  while (index < tokens.length && (!tokens[index].op || tokens[index].op.startsWith('redirect:'))) {
    if (tokens[index].op && tokens[index].op.startsWith('redirect:')) {
      index += 2;
      continue;
    }
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
    const target = expandShellPath(tokens[index], repoCwd, unresolvedVariables);
    return { end: index + 1, target, unknown: !target };
  }
  if (index < tokens.length && !tokens[index].op) {
    const target = expandShellPath(tokens[index], repoCwd, unresolvedVariables);
    return { end: index + 1, target, unknown: !target };
  }
  return { end: index, target: null, unknown: false };
}

function misplacedTarget(command, cwd, policy) {
  const source = stripHereDocuments(command);
  const tokens = shellTokens(source);
  const suppliedCwd = path.resolve(cwd || process.cwd());
  const logicalPwd = process.env.PWD && path.resolve(process.env.PWD);
  let activeCwd = logicalPwd && physicalPath(logicalPwd) === physicalPath(suppliedCwd)
    ? logicalPwd : suppliedCwd;
  const cwdStack = [];
  const directoryStack = [];
  const unresolvedVariables = new Set();
  let conditionalDirectory = false;
  let commandStart = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (item.op) {
      if (item.op.startsWith('redirect:')) {
        for (const nested of (tokens[index + 1] && tokens[index + 1].substitutions) || []) {
          const nestedTarget = misplacedTarget(nested, activeCwd, policy);
          if (nestedTarget) return nestedTarget;
        }
        index += 1;
        continue;
      }
      if (item.op === ';' && conditionalDirectory) {
        activeCwd = null;
        unresolvedVariables.add('PWD');
        conditionalDirectory = false;
      }
      if (item.op === '(') cwdStack.push(activeCwd);
      if (item.op === ')') activeCwd = cwdStack.length ? cwdStack.pop() : null;
      commandStart = true;
      continue;
    }
    for (const nested of item.substitutions || []) {
      const nestedTarget = misplacedTarget(nested, activeCwd, policy);
      if (nestedTarget) return nestedTarget;
    }
    if (!commandStart) continue;
    if (['if', 'then', 'do', 'else', 'elif', '!', 'time'].includes(item.value)) {
      if (item.value === 'then') { activeCwd = null; unresolvedVariables.add('PWD'); }
      continue;
    }
    commandStart = false;
    const executable = item.value.split('/').pop();
    if (executable === 'export') {
      for (let next = index + 1; tokens[next] && !tokens[next].op; next += 1) {
        const assignment = tokens[next].value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (assignment) unresolvedVariables.add(assignment[1]);
      }
      continue;
    }
    if (executable === 'pushd') {
      if (!tokens[index + 1] || tokens[index + 1].op) { activeCwd = null; continue; }
      directoryStack.push(activeCwd);
      activeCwd = expandCdPath(tokens[index + 1], activeCwd, unresolvedVariables);
      index += 1;
      continue;
    }
    if (executable === 'popd') {
      activeCwd = directoryStack.length ? directoryStack.pop() : null;
      continue;
    }
    if (['env', 'command', 'builtin'].includes(executable)) {
      let candidate = index + 1;
      while (tokens[candidate] && !tokens[candidate].op) {
        const assignment = tokens[candidate].value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (assignment) unresolvedVariables.add(assignment[1]);
        if (assignment) candidate += 1;
        else if (executable === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(tokens[candidate].value)) candidate += 2;
        else if (tokens[candidate].value.startsWith('-')) candidate += 1;
        else break;
      }
      if (tokens[candidate] && !tokens[candidate].op
          && ['git', 'cd', 'bash', 'sh', 'zsh', 'dash'].includes(tokens[candidate].value.split('/').pop())) index = candidate;
      else continue;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(item.value)) {
      let candidate = index;
      while (tokens[candidate] && !tokens[candidate].op
          && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[candidate].value)) candidate += 1;
      for (let assigned = index; assigned < candidate; assigned += 1) {
        unresolvedVariables.add(tokens[assigned].value.split('=')[0]);
      }
      if (tokens[candidate] && !tokens[candidate].op
          && ['git', 'bash', 'sh', 'zsh', 'dash'].includes(tokens[candidate].value.split('/').pop())) index = candidate;
      else continue;
    }
    const commandItem = tokens[index];
    const commandExecutable = commandItem.value.split('/').pop();
    if (['bash', 'sh', 'zsh', 'dash'].includes(commandExecutable)) {
      let scriptIndex = index + 1;
      let hasCommandFlag = false;
      while (tokens[scriptIndex] && !tokens[scriptIndex].op
          && tokens[scriptIndex].value.startsWith('-')) {
        if (/^-[^-]*c/.test(tokens[scriptIndex].value)) hasCommandFlag = true;
        scriptIndex += 1;
      }
      if (hasCommandFlag && tokens[scriptIndex] && !tokens[scriptIndex].op) {
        const nested = misplacedTarget(tokens[scriptIndex].value, activeCwd, policy);
        if (nested) return nested;
      }
      continue;
    }
    let cdOperand = index + 1;
    let physicalCd = false;
    if (commandExecutable === 'cd') {
      while (tokens[cdOperand] && !tokens[cdOperand].op
          && ['--', '-P', '-L'].includes(tokens[cdOperand].value)) {
        if (tokens[cdOperand].value === '-P') physicalCd = true;
        cdOperand += 1;
      }
    }
    if (commandExecutable === 'cd' && tokens[cdOperand] && !tokens[cdOperand].op) {
      const prior = tokens[index - 1] && tokens[index - 1].op;
      if (prior === '&&' || prior === '||') conditionalDirectory = true;
      let inPipelineOrBackground = false;
      for (let look = cdOperand + 1; look < tokens.length && !tokens[look].op
          || (tokens[look] && ['|', '&'].includes(tokens[look].op)); look += 1) {
        if (tokens[look].op === '|' || tokens[look].op === '&') inPipelineOrBackground = true;
      }
      const changed = expandCdPath(tokens[cdOperand], activeCwd, unresolvedVariables, physicalCd);
      if (!inPipelineOrBackground) {
        activeCwd = changed;
        unresolvedVariables.add('PWD');
      }
      index = cdOperand;
      continue;
    }
    if (commandExecutable === 'cd') {
      activeCwd = null;
      unresolvedVariables.add('PWD');
      unresolvedVariables.add('OLDPWD');
      continue;
    }
    if (commandExecutable !== 'git') continue;
    const result = gitCommand(tokens, index, activeCwd, unresolvedVariables);
    for (let argument = index + 1; argument < result.end; argument += 1) {
      for (const nested of tokens[argument].substitutions || []) {
        const nestedTarget = misplacedTarget(nested, activeCwd, policy);
        if (nestedTarget) return nestedTarget;
      }
    }
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
  let delimiter = null;
  let stripTabs = false;
  let expandBody = false;
  let shellBody = false;
  let body = [];
  for (const line of lines) {
    if (delimiter) {
      const closing = (stripTabs ? line.replace(/^\t+/, '') : line) === delimiter;
      if (!closing) body.push(line);
      if (closing) delimiter = null;
      output.push(shellBody ? line : '');
      if (closing) {
        if (expandBody) output.push(...extractCommandSubstitutions(body.join('\n'), true));
        if (shellBody) output.push(')');
        shellBody = false;
        expandBody = false;
        body = [];
      }
      continue;
    }
    output.push(line);
    const heredoc = findHereDocument(line);
    if (heredoc) {
      stripTabs = heredoc.stripTabs;
      delimiter = heredoc.delimiter;
      expandBody = !heredoc.quoted;
      shellBody = heredoc.shellScript;
      body = [];
      if (shellBody) output.push('(');
    }
  }
  return output.join('\n');
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
    if (char === '<' && line[i + 1] === '<' && line[i + 2] === '<') { i += 2; continue; }
    if (char !== '<' || line[i + 1] !== '<') continue;
    let cursor = i + 2;
    let stripTabs = false;
    if (line[cursor] === '-') { stripTabs = true; cursor += 1; }
    while (/\s/.test(line[cursor] || '') && cursor < line.length) cursor += 1;
    let delimiter = '';
    let wordQuote = null;
    let quoted = false;
    while (cursor < line.length) {
      const part = line[cursor];
      if (!wordQuote && (/\s/.test(part) || ';&|(){}'.includes(part))) break;
      if (!wordQuote && (part === "'" || part === '"')) { wordQuote = part; quoted = true; cursor += 1; continue; }
      if (wordQuote && part === wordQuote) { wordQuote = null; cursor += 1; continue; }
      if (part === '\\' && wordQuote !== "'") {
        quoted = true;
        cursor += 1;
        if (cursor < line.length) delimiter += line[cursor++];
        continue;
      }
      delimiter += part;
      cursor += 1;
    }
    if (delimiter) {
      const shellScript = /^\s*(?:(?:command|env)\s+)*(?:\/[^\s]+\/)?(?:bash|sh|zsh|dash)(?:\s|$)/.test(line);
      return { delimiter, stripTabs, quoted, shellScript };
    }
  }
  return null;
}

function extractCommandSubstitutions(command, heredocExpansion = false) {
  const found = [];
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && (heredocExpansion || quote !== "'")) { escaped = true; continue; }
    if (quote) {
      if (heredocExpansion) {
        if (char === '$' && command[i + 1] === '(') {
          const end = substitutionEnd(command, i + 1);
          if (end > i) { found.push(command.slice(i + 2, end)); i = end; }
        } else if (char === '`') {
          const end = command.indexOf('`', i + 1);
          if (end >= 0) { found.push(command.slice(i + 1, end)); i = end; }
        }
        continue;
      }
      if (char === quote) quote = null;
      else if (quote === '"' && char === '$' && command[i + 1] === '(') {
        const end = substitutionEnd(command, i + 1);
        if (end > i) { found.push(command.slice(i + 2, end)); i = end; }
      } else if (quote === '"' && char === '`') {
        const end = command.indexOf('`', i + 1);
        if (end >= 0) { found.push(command.slice(i + 1, end)); i = end; }
      }
      continue;
    }
    if (!heredocExpansion && char === "'") { quote = char; continue; }
    if (!heredocExpansion && char === '"') { quote = char; continue; }
    if (char === '$' && command[i + 1] === '(') {
      const end = substitutionEnd(command, i + 1);
      if (end > i) { found.push(command.slice(i + 2, end)); i = end; }
    } else if (char === '`') {
      const end = command.indexOf('`', i + 1);
      if (end >= 0) { found.push(command.slice(i + 1, end)); i = end; }
    }
  }
  return found;
}

function substitutionEnd(command, openingParen) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openingParen; i < command.length; i += 1) {
    const char = command[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return i;
  }
  return -1;
}

module.exports = { loadPolicy, misplacedTarget };
