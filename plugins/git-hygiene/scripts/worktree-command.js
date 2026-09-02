'use strict';

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const MUTATING = new Set(['add', 'move', 'remove', 'lock', 'unlock']);
const READ_ONLY = new Set(['list', 'help', '--help', '-h']);
const PASSTHROUGH = new Set(['repair']);
const CONTROL_PREFIXES = new Set(['!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const ALIAS_TIMEOUT_MS = 500;
const MAX_ALIAS_DEPTH = 6;
const MAX_VARIABLE_DEPTH = 6;
let builtinCommands = null;

function splitSegments(command) {
  const out = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let substitutionDepth = 0;
  const source = String(command || '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '$' && next === '(') { substitutionDepth += 1; current += '$('; i += 1; continue; }
    if (char === ')' && substitutionDepth > 0) { substitutionDepth -= 1; current += char; continue; }
    if (substitutionDepth === 0 && (
      char === ';' || char === '\n' || char === '|' || char === '&'
      || char === '(' || char === ')' || char === '{' || char === '}'
    )) {
      if (current.trim()) out.push(current.trim());
      current = '';
      if ((char === '|' || char === '&') && next === char) i += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function heredocDeclarations(header) {
  const out = [];
  let quote = null;
  let escaped = false;
  for (let i = 0; i < header.length - 1; i += 1) {
    const char = header[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== '<' || header[i + 1] !== '<' || header[i + 2] === '<') continue;

    const start = i;
    let cursor = i + 2;
    let stripTabs = false;
    if (header[cursor] === '-') { stripTabs = true; cursor += 1; }
    while (/[ \t]/.test(header[cursor] || '')) cursor += 1;
    const wordStart = cursor;
    let wordQuote = null;
    let wordEscaped = false;
    for (; cursor < header.length; cursor += 1) {
      const wordChar = header[cursor];
      if (wordEscaped) { wordEscaped = false; continue; }
      if (wordChar === '\\' && wordQuote !== "'") { wordEscaped = true; continue; }
      if (wordQuote) {
        if (wordChar === wordQuote) wordQuote = null;
        continue;
      }
      if (wordChar === "'" || wordChar === '"') { wordQuote = wordChar; continue; }
      if (/\s/.test(wordChar) || /[;&|<>]/.test(wordChar)) break;
    }
    const raw = header.slice(wordStart, cursor);
    if (raw) {
      out.push({
        start,
        end: cursor,
        marker: raw.replace(/['"\\]/g, ''),
        quoted: /['"\\]/.test(raw),
        stripTabs,
      });
    }
    i = Math.max(i, cursor - 1);
  }
  return out;
}

function headerRunsShell(header, declarations) {
  let withoutDeclarations = header;
  for (const item of [...declarations].reverse()) {
    withoutDeclarations = withoutDeclarations.slice(0, item.start) + withoutDeclarations.slice(item.end);
  }
  return splitSegments(withoutDeclarations).some((segment) => {
    const words = tokens(segment);
    const executable = words[executableIndex(words)];
    return executable && SHELLS.has(path.basename(executable));
  });
}

function heredocAnalysis(command) {
  const lines = String(command || '').split('\n');
  const kept = [];
  const scripts = [];
  const expansions = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    kept.push(header);
    const declarations = heredocDeclarations(header);
    if (!declarations.length) continue;

    const executes = headerRunsShell(header, declarations);
    for (const item of declarations) {
      const body = [];
      i += 1;
      while (i < lines.length) {
        const candidate = item.stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
        if (candidate === item.marker) break;
        body.push(lines[i]);
        i += 1;
      }
      const text = body.join('\n');
      if (executes) scripts.push(text);
      else if (!item.quoted) expansions.push(text);
    }
  }
  return { source: kept.join('\n'), scripts, expansions };
}

function stripHeredocs(command) {
  return heredocAnalysis(command).source;
}

function segments(command) {
  return splitSegments(stripHeredocs(command));
}

function tokens(segment) {
  const out = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { out.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function nestedCommands(command) {
  const found = [];
  const source = stripHeredocs(command);
  let outerQuote = null;
  let outerEscaped = false;
  for (let i = 0; i < source.length - 1; i += 1) {
    const outer = source[i];
    if (outerEscaped) { outerEscaped = false; continue; }
    if (outer === '\\' && outerQuote !== "'") { outerEscaped = true; continue; }
    if (outerQuote === "'") {
      if (outer === "'") outerQuote = null;
      continue;
    }
    if (outer === "'") { outerQuote = "'"; continue; }
    if (outer === '"') { outerQuote = outerQuote === '"' ? null : '"'; continue; }

    // Legacy backtick substitutions still execute inside double quotes. Keep
    // them out of single-quoted prose, and honor an escaped closing backtick.
    if (outer === '`') {
      let escaped = false;
      let j = i + 1;
      for (; j < source.length; j += 1) {
        const char = source[j];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '`') break;
      }
      if (j < source.length) { found.push(source.slice(i + 1, j)); i = j; }
      continue;
    }

    if (outer !== '$' || source[i + 1] !== '(') continue;
    let depth = 1;
    let quote = null;
    let escaped = false;
    const start = i + 2;
    let j = start;
    for (; j < source.length; j += 1) {
      const char = source[j];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) break;
    }
    if (depth === 0) { found.push(source.slice(start, j)); i = j; }
  }
  return found;
}

function executableIndex(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  while (i < words.length) {
    const executable = path.basename(words[i]);
    if (CONTROL_PREFIXES.has(words[i]) || executable === 'exec' || executable === 'nohup') { i += 1; continue; }
    if (executable === 'command' || executable === 'builtin') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += 1;
      continue;
    }
    if (executable === 'sudo') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) {
        if (['-u', '-g', '-h', '-p', '-C', '-T', '-D', '--chdir'].includes(words[i])) i += 2;
        else i += 1;
      }
      continue;
    }
    if (executable === 'env') {
      i += 1;
      while (i < words.length) {
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(words[i])) { i += 2; continue; }
        if (words[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i += 1; continue; }
        break;
      }
      continue;
    }
    if (executable === 'nice' || executable === 'time') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-n' || words[i] === '--adjustment') i += 2;
        else i += 1;
      }
      continue;
    }
    break;
  }
  return i;
}

function expandedVariable(word, variables) {
  const found = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(word || '');
  if (!found) return word;
  const value = variables.get(found[1] || found[2]);
  return value === undefined ? word : value;
}

function expandKnownWords(words, variables) {
  return words.flatMap((word) => {
    const expanded = expandedVariable(word, variables);
    if (expanded === word) return [word];
    return tokens(expanded);
  });
}

function expandedDirectory(candidate, cwd) {
  const value = candidate === '~' || candidate.startsWith('~/')
    ? path.join(os.homedir(), candidate.slice(2))
    : candidate;
  return path.resolve(cwd, value);
}

function rememberInlineAlias(aliases, assignment) {
  const found = /^alias\.([^=]+)=(.*)$/s.exec(assignment || '');
  if (found) aliases.set(found[1], found[2]);
}

function rememberEnvironmentAlias(aliases, specification, variables) {
  const found = /^alias\.([^=]+)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(specification || '');
  if (!found) return;
  const value = variables.has(found[2]) ? variables.get(found[2]) : process.env[found[2]];
  if (value !== undefined) aliases.set(found[1], value);
}

function wrapperDirectory(words, fallback) {
  let cwd = path.resolve(fallback || process.cwd());
  const end = executableIndex(words);
  for (let i = 0; i < end; i += 1) {
    if ((words[i] === '-C' || words[i] === '--chdir' || words[i] === '-D') && words[i + 1]) {
      cwd = expandedDirectory(words[i + 1], cwd);
      i += 1;
    } else if (words[i].startsWith('--chdir=')) {
      cwd = expandedDirectory(words[i].slice('--chdir='.length), cwd);
    }
  }
  return cwd;
}

function gitInvocation(words, options = {}) {
  let i = executableIndex(words);
  if (!words[i] || path.basename(words[i]) !== 'git') return null;
  const variables = new Map();
  for (const word of words.slice(0, i)) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
    if (assignment) variables.set(assignment[1], assignment[2]);
  }
  i += 1;
  let cwd = wrapperDirectory(words, options.cwd);
  const aliases = new Map();
  while (i < words.length && words[i].startsWith('-')) {
    const option = words[i];
    if (option === '-C' && words[i + 1]) {
      cwd = expandedDirectory(words[i + 1], cwd);
      i += 2;
    } else if (option.startsWith('-C') && option.length > 2) {
      cwd = expandedDirectory(option.slice(2), cwd);
      i += 1;
    } else if (option === '-c' && words[i + 1]) {
      rememberInlineAlias(aliases, words[i + 1]);
      i += 2;
    } else if (option.startsWith('-c') && option.length > 2) {
      rememberInlineAlias(aliases, option.slice(2));
      i += 1;
    } else if (option === '--config-env' && words[i + 1]) {
      rememberEnvironmentAlias(aliases, words[i + 1], variables);
      i += 2;
    } else if (option.startsWith('--config-env=')) {
      rememberEnvironmentAlias(aliases, option.slice('--config-env='.length), variables);
      i += 1;
    } else if (['--git-dir', '--work-tree', '--namespace'].includes(option)) i += 2;
    else i += 1;
  }
  return { subcommand: words[i] || null, args: words.slice(i + 1), cwd, aliases };
}

function gitWorktreeAction(words) {
  const invocation = gitInvocation(words);
  if (!invocation || invocation.subcommand !== 'worktree') return null;
  let i = 0;
  const worktreeArgs = invocation.args;
  while (i < worktreeArgs.length && worktreeArgs[i].startsWith('-') && !READ_ONLY.has(worktreeArgs[i])) i += 1;
  return { action: worktreeArgs[i] || null, args: worktreeArgs.slice(i + 1) };
}

function configuredAlias(invocation) {
  if (!invocation || !invocation.subcommand) return null;
  let alias = invocation.aliases.get(invocation.subcommand) || null;
  try {
    if (!alias) {
      alias = execFileSync('git', ['-C', invocation.cwd, 'config', '--get', `alias.${invocation.subcommand}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: ALIAS_TIMEOUT_MS,
      }).trim() || null;
    }
    if (!alias) return null;
    if (builtinCommands === null) {
      builtinCommands = new Set(execFileSync('git', ['--list-cmds=builtins'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: ALIAS_TIMEOUT_MS,
      }).split(/\s+/).filter(Boolean));
    }
    // Git aliases cannot override built-ins. Treating a colliding alias as
    // executable would block an ordinary command that Git itself ignores.
    return builtinCommands.has(invocation.subcommand) ? null : alias;
  } catch (_) {
    // Older Git versions may not support --list-cmds=builtins. If the alias
    // itself was resolved, fail closed rather than letting it hide a mutation.
    return alias;
  }
}

function shellWord(word) {
  return `'${String(word).replace(/'/g, `'"'"'`)}'`;
}

function xargsCommand(words, index) {
  const takesValue = new Set([
    '-a', '--arg-file', '-E', '--eof', '-I', '--replace', '-L', '--max-lines',
    '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '-d', '--delimiter',
  ]);
  let i = index + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (takesValue.has(words[i])) i += 2;
    else i += 1;
  }
  return words.slice(i);
}

function aliasDecision(invocation, options) {
  if (!invocation || invocation.subcommand === 'worktree') return null;
  const alias = configuredAlias(invocation);
  if (!alias) return null;
  const suffix = invocation.args.map(shellWord).join(' ');
  const expanded = alias.startsWith('!')
    ? `${alias.slice(1)} ${suffix}`
    : `git ${alias} ${suffix}`;
  return decisionFor(expanded, {
    ...options,
    cwd: invocation.cwd,
    aliasDepth: (options.aliasDepth || 0) + 1,
  });
}

function decisionFor(command, options = {}) {
  const analysis = heredocAnalysis(command);
  for (const script of analysis.scripts) {
    const scriptDecision = decisionFor(script, options);
    if (scriptDecision) return scriptDecision;
  }
  for (const body of analysis.expansions) {
    for (const nested of nestedCommands(body)) {
      const expansionDecision = decisionFor(nested, options);
      if (expansionDecision) return expansionDecision;
    }
  }
  for (const nested of nestedCommands(analysis.source)) {
    const nestedDecision = decisionFor(nested, options);
    if (nestedDecision) return nestedDecision;
  }
  let segmentOptions = { ...options };
  const variables = new Map(options.variables || []);
  for (const segment of splitSegments(analysis.source)) {
    const rawWords = tokens(segment);
    let index = executableIndex(rawWords);
    if (index >= rawWords.length) {
      for (const word of rawWords) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
        if (assignment) variables.set(assignment[1], assignment[2]);
      }
      continue;
    }
    const words = rawWords;
    const variableExecutable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(words[index]);
    if (variableExecutable) {
      const value = variables.get(variableExecutable[1] || variableExecutable[2]);
      if (value) {
        // Shell expansion can turn one token into an executable plus several
        // arguments. Re-parse the expanded command rather than treating the
        // entire value as an executable filename and letting it pass unseen.
        const variableDepth = segmentOptions.variableDepth || 0;
        if (variableDepth < MAX_VARIABLE_DEPTH) {
          const expanded = [value, ...words.slice(index + 1).map(shellWord)].join(' ');
          const expandedDecision = decisionFor(expanded, {
            ...segmentOptions,
            variables,
            variableDepth: variableDepth + 1,
          });
          if (expandedDecision) return expandedDecision;
        }
        continue;
      }
    }
    const executable = words[index];
    if (executable && ['cd', 'pushd'].includes(path.basename(executable))) {
      const destination = words.slice(index + 1).find((word) => !word.startsWith('-'));
      if (destination && destination !== '-') {
        segmentOptions.cwd = expandedDirectory(destination, segmentOptions.cwd || process.cwd());
      }
      continue;
    }
    if (executable && SHELLS.has(path.basename(executable))) {
      const commandAt = words.findIndex((word, i) => i > index && (word === '-c' || word === '-lc'));
      if (commandAt !== -1 && words[commandAt + 1]) {
        const nestedDecision = decisionFor(expandedVariable(words[commandAt + 1], variables), {
          ...segmentOptions,
          variables,
        });
        if (nestedDecision) return nestedDecision;
      }
      const hereString = words.indexOf('<<<', index + 1);
      if (hereString !== -1 && words[hereString + 1]) {
        const nestedDecision = decisionFor(expandedVariable(words[hereString + 1], variables), {
          ...segmentOptions,
          variables,
        });
        if (nestedDecision) return nestedDecision;
      }
      continue;
    }
    if (executable === 'eval' && words[index + 1]) {
      const expanded = words.slice(index + 1).map((word) => expandedVariable(word, variables)).join(' ');
      const nestedDecision = decisionFor(expanded, { ...segmentOptions, variables });
      if (nestedDecision) return nestedDecision;
      continue;
    }
    if (executable && path.basename(executable) === 'xargs') {
      const dispatched = xargsCommand(words, index);
      if (dispatched.length) {
        const nestedDecision = decisionFor(dispatched.map(shellWord).join(' '), segmentOptions);
        if (nestedDecision) return nestedDecision;
      }
      continue;
    }
    const gitWords = expandKnownWords(words, variables);
    const invocation = gitInvocation(gitWords, segmentOptions);
    if ((segmentOptions.aliasDepth || 0) < MAX_ALIAS_DEPTH) {
      const expandedDecision = aliasDecision(invocation, segmentOptions);
      if (expandedDecision) return expandedDecision;
    }
    const parsed = gitWorktreeAction(gitWords);
    if (!parsed) continue;
    if (parsed.action === 'prune') {
      if (parsed.args.includes('--dry-run') || parsed.args.includes('-n')) continue;
      return { action: 'prune', reason: 'direct non-dry-run worktree pruning bypasses the configured audit' };
    }
    if (READ_ONLY.has(parsed.action) || PASSTHROUGH.has(parsed.action) || parsed.action === null) continue;
    if (MUTATING.has(parsed.action)) {
      return { action: parsed.action, reason: `direct git worktree ${parsed.action} bypasses deterministic placement and verification` };
    }
    return { action: parsed.action, reason: 'the requested git worktree operation could not be classified as read-only' };
  }
  return null;
}

module.exports = {
  decisionFor,
  gitInvocation,
  gitWorktreeAction,
  heredocAnalysis,
  nestedCommands,
  segments,
  stripHeredocs,
  tokens,
};
