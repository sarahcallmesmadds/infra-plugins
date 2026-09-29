'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');

function physicalPath(value, seenLinks = new Set()) {
  const absolute = path.isAbsolute(value) ? value : path.resolve(value);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    if (part === '..') { current = path.dirname(current); continue; }
    if (part === '.') continue;
    const next = path.join(current, part);
    try { current = fs.realpathSync.native(next); }
    catch (_) {
      try {
        if (!fs.lstatSync(next).isSymbolicLink() || seenLinks.has(next)) current = next;
        else {
          const target = fs.readlinkSync(next);
          const followed = new Set(seenLinks);
          followed.add(next);
          current = physicalPath(path.isAbsolute(target) ? target : path.resolve(current, target), followed);
        }
      } catch (_) { current = next; }
    }
  }
  return current;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function loadPolicy() {
  try {
    const section = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).worktreeLocation;
    const expand = (value) => typeof value === 'string'
      ? value.trim().replace(/^~(?=\/|$)/, os.homedir()) : value;
    const projectRoot = expand(section && section.projectRoot);
    const worktreeRoot = expand(section && section.worktreeRoot);
    if (typeof projectRoot !== 'string' || typeof worktreeRoot !== 'string'
        || !path.isAbsolute(projectRoot) || !path.isAbsolute(worktreeRoot)) return null;
    const project = physicalPath(projectRoot);
    const worktrees = physicalPath(worktreeRoot);
    if (!isWithin(worktrees, project) || worktrees === project) return null;
    return { projectRoot: project, worktreeRoot: worktrees };
  } catch (_) { return null; }
}

// Read only ordinary words and shell quotes. Any shell syntax makes the command
// outside this deliberately narrow grammar instead of trying to emulate Bash.
function simpleWords(source) {
  const words = [];
  let value = '';
  let quote = null;
  let started = false;
  let dynamic = false;
  let homeExpandable = false;
  let unsupported = false;
  const flush = () => {
    if (!started) return;
    words.push({ value, dynamic, homeExpandable });
    value = '';
    started = false;
    dynamic = false;
    homeExpandable = false;
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && ['"', '\\', '$', '`', '\n'].includes(source[i + 1])) {
        const next = source[++i];
        if (next === '\n') continue;
        value += next;
      } else {
        if (ch === '$' || ch === '`') dynamic = true;
        value += ch;
      }
      started = true;
      continue;
    }
    if (ch === '\\') {
      if (source[i + 1] === '\n') { i += 1; continue; }
      if (i + 1 < source.length) { value += source[++i]; started = true; }
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (!started) homeExpandable = false;
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '#' && !started) break;
    if (ch === '$' || ch === '`' || '*?[]{}<>|&;()'.includes(ch)) {
      unsupported = true;
      break;
    }
    if (ch === '\n') { unsupported = true; break; }
    if (ch === ' ' || ch === '\t') { flush(); continue; }
    if (!started && ch === '~') {
      let next = i + 1;
      while (source[next] === '\\' && source[next + 1] === '\n') next += 2;
      homeExpandable = source[next] !== '"' && source[next] !== "'" && source[next] !== '\\';
    }
    value += ch;
    started = true;
  }
  if (quote) unsupported = true;
  flush();
  return { words, unsupported };
}

function expandHome(word) {
  if (!word || word.dynamic) return { unknown: true };
  if (!word.homeExpandable) return { value: word.value };
  if (word.value === '~') return { value: os.homedir() };
  if (word.value.startsWith('~/')) return { value: `${os.homedir()}${path.sep}${word.value.slice(2)}` };
  if (word.value.startsWith('~')) return { unknown: true };
  return { value: word.value };
}

function worktreeArgs(words, start, cwd, policy, unsupported) {
  let index = start;
  let gitCwd = cwd;
  let cwdUnknown = false;
  while (index < words.length) {
    const item = words[index];
    if (['--help', '-h', '--version', '-v'].includes(item.value)) return null;
    if (item.value === '-C') {
      const dir = expandHome(words[index + 1]);
      if (!words[index + 1] || dir.unknown || !gitCwd) cwdUnknown = true;
      else {
        gitCwd = physicalPath(path.isAbsolute(dir.value) ? dir.value : `${gitCwd}${path.sep}${dir.value}`);
        if (path.isAbsolute(dir.value)) cwdUnknown = false;
      }
      index += 2;
    } else if (item.value.startsWith('-C') && item.value.length > 2) {
      const dir = expandHome({ value: item.value.slice(2), dynamic: item.dynamic, homeExpandable: false });
      if (dir.unknown || !gitCwd) cwdUnknown = true;
      else {
        gitCwd = physicalPath(path.isAbsolute(dir.value) ? dir.value : `${gitCwd}${path.sep}${dir.value}`);
        if (path.isAbsolute(dir.value)) cwdUnknown = false;
      }
      index += 1;
    } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(item.value)) {
      if (!words[index + 1]) return { unknown: true };
      index += 2;
    } else if (item.value.startsWith('-c') && item.value.length > 2) index += 1;
    else if (/^--(?:git-dir|work-tree|namespace|config-env|super-prefix)=/.test(item.value)) index += 1;
    else if (['--exec-path', '--html-path', '--man-path', '--info-path'].includes(item.value)) return null;
    else if (/^--exec-path=/.test(item.value)) index += 1;
    else if (['--no-pager', '--paginate', '-p', '-P', '--no-replace-objects', '--bare', '--literal-pathspecs',
      '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
      '--no-optional-locks', '--no-advice', '--no-lazy-fetch'].includes(item.value)) index += 1;
    else if (item.value.startsWith('-')) { return { unknown: true }; }
    else break;
  }
  if (!words[index] || words[index].dynamic) return null;
  if (words[index].value !== 'worktree') return null;
  const actionIndex = words[index + 1] && words[index + 1].value === '--' ? index + 2 : index + 1;
  const action = words[actionIndex];
  if (!action) return unsupported ? { unknown: true } : null;
  if (action.dynamic) return { unknown: true };
  if (['list', '--help', '-h'].includes(action.value)) return null;
  if (!['add', 'move', 'repair'].includes(action.value)) return null;
  if (unsupported) return { unknown: true };
  if (action.value === 'repair') {
    let optionsEnded = false;
    for (const word of words.slice(actionIndex + 1)) {
      if (word.value === '--') optionsEnded = true;
      else if (!optionsEnded && !word.dynamic && ['--help', '-h'].includes(word.value)) return null;
    }
    return { unknown: true };
  }

  const args = [];
  let optionEnd = false;
  for (let cursor = actionIndex + 1; cursor < words.length; cursor += 1) {
    const arg = words[cursor];
    if (arg.dynamic) return { unknown: true };
    if (!optionEnd && ['--help', '-h'].includes(arg.value)) return null;
    if (!optionEnd && arg.value === '--') { optionEnd = true; continue; }
    if (!optionEnd && arg.value.startsWith('-')) {
      if (action.value === 'move' && ['-f', '--force', '--no-force', '--relative-paths', '--no-relative-paths'].includes(arg.value)) continue;
      if (action.value === 'add' && ['-f', '--force', '--detach', '-d', '--checkout', '--no-checkout', '--lock', '--no-lock', '--no-track', '--guess-remote', '--no-guess-remote', '--quiet', '-q', '--orphan', '--relative-paths', '--no-relative-paths'].includes(arg.value)) continue;
      if (action.value === 'add' && ['-b', '-B', '--reason'].includes(arg.value)) {
        if (!words[cursor + 1] || words[cursor + 1].dynamic) return { unknown: true };
        cursor += 1;
        continue;
      }
      if (action.value === 'add' && /^-[bB].+/.test(arg.value)) continue;
      if (action.value === 'add' && arg.value === '--track') {
        continue;
      }
      if (action.value === 'add' && /^--(?:track|reason)=/.test(arg.value)) continue;
      return { unknown: true };
    }
    args.push(arg);
  }
  const destToken = action.value === 'move' ? args[1] : args[0];
  if (!destToken) return { unknown: true };
  const expanded = expandHome(destToken);
  if (expanded.unknown || (!path.isAbsolute(expanded.value) && (cwdUnknown || !gitCwd))) return { unknown: true };
  let destination = physicalPath(path.isAbsolute(expanded.value) ? expanded.value : `${gitCwd}${path.sep}${expanded.value}`);
  if (action.value === 'move' && args[0]) {
    try {
      if (fs.statSync(destination).isDirectory()) {
        const source = physicalPath(path.isAbsolute(args[0].value)
          ? args[0].value : `${gitCwd}${path.sep}${args[0].value}`);
        destination = physicalPath(`${destination}${path.sep}${path.basename(source)}`);
      }
    }
    catch (_) { /* Git creates a destination that does not exist. */ }
  }
  const parts = path.relative(policy.worktreeRoot, destination).split(path.sep).filter(Boolean);
  if (!isWithin(destination, policy.worktreeRoot) || parts.length !== 2) return { target: destination };
  return null;
}

function misplacedTarget(command, cwd, policy) {
  if (typeof command !== 'string' || !policy
      || !path.isAbsolute(policy.projectRoot) || !path.isAbsolute(policy.worktreeRoot)) return { unknown: true };
  const parsed = simpleWords(command.trim());
  const { words } = parsed;
  let index = 0;
  while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index += 1;
  if (!words[index]) return null;
  if (path.basename(words[index].value).toLowerCase() !== 'git') return null;
  const gitIndex = index;
  index += 1;
  while (index < words.length) {
    const item = words[index];
    if (['--help', '-h', '--version', '-v'].includes(item.value)) return null;
    if (item.value === '-C') index += 2;
    else if (item.value.startsWith('-C') && item.value.length > 2) index += 1;
    else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(item.value)) index += 2;
    else if (item.value.startsWith('-c') && item.value.length > 2) index += 1;
    else if (/^--(?:git-dir|work-tree|namespace|config-env|super-prefix|exec-path)=/.test(item.value)) index += 1;
    else if (['--exec-path', '--html-path', '--man-path', '--info-path'].includes(item.value)) return null;
    else if (['--no-pager', '--paginate', '-p', '-P', '--no-replace-objects', '--bare', '--literal-pathspecs',
      '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
      '--no-optional-locks', '--no-advice', '--no-lazy-fetch'].includes(item.value)) index += 1;
    else if (item.dynamic) return { unknown: true };
    else if (item.value.startsWith('-')) {
      // Unknown global options do not make unrelated Git commands a worktree risk.
      // If a worktree subcommand follows, fail closed because option arity is unknown.
      return words.slice(index + 1).some((word) => !word.dynamic && word.value === 'worktree')
        ? { unknown: true } : null;
    }
    else break;
  }
  if (!words[index]) return null;
  if (words[index].dynamic) return { unknown: true };
  if (words[index].value !== 'worktree') return null;
  return worktreeArgs(words, gitIndex + 1, cwd ? physicalPath(cwd) : null, policy, parsed.unsupported);
}

module.exports = { loadPolicy, misplacedTarget };
