#!/usr/bin/env node
// Claude Code statusline
// Renders: model | folder/account | current task | session cost + rolling spend | context used | optional core-tool count
//
// Drop this file anywhere and point Claude Code at it in settings.json:
//   "statusLine": { "type": "command", "command": "node \"/absolute/path/to/statusline.js\"" }
//
// Every segment is optional and degrades gracefully. If Claude Code does not
// send cost/context, or if the core-tool cache is missing, that piece is omitted.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROLLING_SPEND_CACHE_PATH = process.env.STATUS_BAR_ROLLING_SPEND_CACHE_PATH
  || path.join(os.homedir(), '.cache', 'status-bar', 'claude-rolling-spend.json');
const ROLLING_SPEND_DAYS = 30;

// --- GitHub account reader --------------------------------------------------

/**
 * Walk up from `dir` looking for a .git/config, read the first remote URL, and
 * return the owner/org portion of it.
 *
 * Handles HTTPS and SSH remotes, including custom SSH host aliases:
 *   https://github.com/OWNER/repo.git
 *   git@github.com:OWNER/repo.git
 *   git@github-personal:OWNER/repo.git
 */
function readGitOwner(dir) {
  let current = dir;
  const root = path.parse(current).root;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(current, '.git', 'config');
    if (fs.existsSync(candidate)) {
      try {
        const cfg = fs.readFileSync(candidate, 'utf8');
        const m = cfg.match(/^\s*url\s*=\s*(.+)$/m);
        const url = m ? m[1].trim() : '';
        const parts = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
        return parts ? parts[1] : null;
      } catch (e) {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) break;
    current = parent;
  }
  return null;
}

// --- Core tool health -------------------------------------------------------

// Are the tools you depend on still signed in.
//
// This used to load a helper that read ~/.cache/ai-core-mcp-health.json and
// format whatever was in it. Nothing ever wrote that file, on any machine, so
// the segment returned '' every single render since the day it shipped. It
// looked like a feature that was simply switched off.
//
// It now reads a cache this plugin writes, from a list of tools the person
// installing it chose. Both of those were missing before: no writer, and a
// hardcoded list of five services that were only ever the right five for one
// person.
//
// Still deliberately cache-only. Probing here would put a multi-second network
// call on the render path of a status line.
function readCoreToolsStatuslineSegment() {
  try {
    const config = require(path.join(__dirname, '..', 'scripts', 'config.js')).load();
    if (!config.coreTools.length) return '';
    return require(path.join(__dirname, '..', 'scripts', 'mcp-health.js'))
      .statuslineSegment({ config });
  } catch (e) {
    // Keep prompt rendering reliable even if the health helper is absent or broken.
    return '';
  }
}

// --- Current task ----------------------------------------------------------

function readCurrentTaskStatuslineSegment({ sessionId, home = os.homedir(), config } = {}) {
  try {
    if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return '';
    const loaded = config || require(path.join(__dirname, '..', 'scripts', 'config.js')).load(home);
    if (loaded.currentTask?.enabled === false) return '';

    // Claude has used two names for the main session's todo file: the bare
    // session id, and an agent-qualified name whose agent id is the session id.
    // Other `-agent-<id>` files belong to sub-agents and are never candidates.
    const dir = path.join(home, '.claude', 'todos');
    const file = [
      { path: path.join(dir, `${sessionId}.json`), priority: 0 },
      { path: path.join(dir, `${sessionId}-agent-${sessionId}.json`), priority: 1 },
    ]
      .filter((candidate) => fs.existsSync(candidate.path))
      .map((candidate) => ({ ...candidate, mtimeMs: fs.statSync(candidate.path).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.priority - a.priority)[0]?.path;
    if (!file) return '';
    const parsed = readJsonFile(file);
    const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
    if (!Array.isArray(tasks)) return '';
    const current = tasks.find((task) => task?.status === 'in_progress'
      && typeof task.activeForm === 'string' && task.activeForm.trim());
    if (!current) return '';
    const label = current.activeForm
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return label ? ` │ \x1b[34m↳ ${label}\x1b[0m` : '';
  } catch (e) {
    // Todo state is optional and changes while the line renders. Stay quiet.
  }
  return '';
}

// --- Display helpers --------------------------------------------------------

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '0.00';
  if (amount >= 1000) return Math.round(amount).toLocaleString('en-US');
  if (amount >= 100) return amount.toFixed(0);
  return amount.toFixed(2);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // Spend tracking is best-effort; never break prompt rendering.
  }
}

function updateRollingSpend(data, now = new Date()) {
  const costUsd = Number(data.cost?.total_cost_usd);
  const sessionId = data.session_id || data.transcript_path;
  if (!sessionId || !Number.isFinite(costUsd) || costUsd < 0) return null;

  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const cutoffMs = nowMs - (ROLLING_SPEND_DAYS * 24 * 60 * 60 * 1000);
  const cache = readJsonFile(ROLLING_SPEND_CACHE_PATH) || {};
  const sessions = cache.sessions && typeof cache.sessions === 'object' ? cache.sessions : {};
  const previous = sessions[sessionId] || {};

  sessions[sessionId] = {
    cost_usd: costUsd,
    first_seen_at: previous.first_seen_at || nowIso,
    last_seen_at: nowIso,
  };

  for (const [key, value] of Object.entries(sessions)) {
    const seenAt = new Date(value.last_seen_at || value.first_seen_at || 0).getTime();
    if (!Number.isFinite(seenAt) || seenAt < cutoffMs) delete sessions[key];
  }

  const total = Object.values(sessions).reduce((sum, value) => {
    const sessionCost = Number(value.cost_usd);
    return Number.isFinite(sessionCost) ? sum + sessionCost : sum;
  }, 0);

  writeJsonFile(ROLLING_SPEND_CACHE_PATH, {
    version: 1,
    window_days: ROLLING_SPEND_DAYS,
    updated_at: nowIso,
    sessions,
  });

  return { total, sessionCount: Object.keys(sessions).length };
}

function renderRollingSpend(data) {
  const spend = updateRollingSpend(data);
  if (!spend) return '';

  const limitRaw = process.env.CLAUDE_30D_SPEND_LIMIT_USD || process.env.CLAUDE_MONTHLY_SPEND_LIMIT_USD;
  const limit = Number(limitRaw);
  let text = `30d $${formatUsd(spend.total)} est`;
  let colorCode = '35';

  if (Number.isFinite(limit) && limit > 0) {
    const pct = Math.round((spend.total / limit) * 100);
    text = `30d $${formatUsd(spend.total)}/$${formatUsd(limit)} ${pct}% est`;
    if (pct >= 90) colorCode = '31';
    else if (pct >= 75) colorCode = '38;5;208';
    else if (pct >= 50) colorCode = '33';
    else colorCode = '35';
  }

  return ` · \x1b[${colorCode}m${text}\x1b[0m`;
}

// Hand the number to the model as well as to the person.
//
// Claude Code sends the context window here and tells the model nothing, so the
// assistant deciding whether to open six more files cannot see the bar the user
// is watching fill up. This writes it where a PostToolUse hook can read it.
//
// Best effort and silent on failure: a status line that could not write a cache
// is still a status line.
function writeContextBridge(data) {
  try {
    require(path.join(__dirname, '..', 'scripts', 'context.js')).writeBridge({
      sessionId: data.session_id,
      contextWindow: data.context_window,
    });
  } catch (e) {
    // Never break the prompt over the bridge.
  }
}

function renderContextMeter(contextWindow) {
  const remaining = contextWindow?.remaining_percentage;
  if (remaining == null) return '';

  const totalCtx = contextWindow?.total_tokens || 1_000_000;
  const autoCompactWindow = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
  const bufferPct = autoCompactWindow > 0
    ? Math.min(100, (autoCompactWindow / totalCtx) * 100)
    : 16.5;

  const usableRemaining = Math.max(0, ((remaining - bufferPct) / (100 - bufferPct)) * 100);
  const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));
  const filled = Math.floor(used / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  if (used >= 80) return ` \x1b[5;31m💀 ${bar} ${used}%\x1b[0m`;
  if (used >= 65) return ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
  if (used >= 50) return ` \x1b[33m${bar} ${used}%\x1b[0m`;
  return ` \x1b[32m${bar} ${used}%\x1b[0m`;
}

function renderCost(data) {
  const costUsd = data.cost?.total_cost_usd;
  if (costUsd == null || isNaN(costUsd)) return '';
  return ` │ \x1b[36m$${Number(costUsd).toFixed(2)}\x1b[0m${renderRollingSpend(data)}`;
}

function composeStatusline({
  model,
  dirname,
  owner = '',
  currentTask = '',
  cost = '',
  context = '',
  coreTools = '',
} = {}) {
  const modelSeg = `\x1b[2m${model || 'Claude'}\x1b[0m`;
  const ownerSeg = owner ? ` \x1b[2m⎇ ${owner}\x1b[0m` : '';
  const dirSeg = `\x1b[2m${dirname || ''}\x1b[0m${ownerSeg}`;
  return `${modelSeg} │ ${dirSeg}${currentTask}${cost}${context}${coreTools}`;
}

// --- main ------------------------------------------------------------------

function renderStatusline(data) {
  const dir = data.workspace?.current_dir || process.cwd();
  writeContextBridge(data);
  return composeStatusline({
    model: data.model?.display_name || 'Claude',
    dirname: path.basename(dir),
    owner: readGitOwner(dir),
    currentTask: readCurrentTaskStatuslineSegment({ sessionId: data.session_id }),
    cost: renderCost(data),
    context: renderContextMeter(data.context_window),
    coreTools: readCoreToolsStatuslineSegment(),
  });
}

function run() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      process.stdout.write(renderStatusline(JSON.parse(input)));
    } catch (e) {
      // Never break the shell prompt on a bad/empty payload.
    }
  });
}

if (require.main === module) run();

module.exports = {
  writeContextBridge,
  readGitOwner,
  readCoreToolsStatuslineSegment,
  readCurrentTaskStatuslineSegment,
  formatUsd,
  updateRollingSpend,
  renderRollingSpend,
  renderContextMeter,
  renderCost,
  composeStatusline,
  renderStatusline,
};
