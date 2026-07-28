// Tell the model how full its own context is.
//
// ---------------------------------------------------------------------------
// The gap this closes.
//
// Claude Code sends the status line a `context_window` object on every render.
// It does not tell the model anything. So the person watching the terminal can
// see the bar turn orange while the assistant, which is the thing deciding
// whether to open six more files, has no idea and keeps exploring. `/context`
// is the only way to read it and only a person can run that.
//
// The fix is a bridge, and it is the whole trick: the status line already has
// the number, so it writes it to a file, and a PostToolUse hook reads the file
// back and says it out loud. Two components that cannot talk to each other,
// joined by the filesystem.
//
// Ported from `gsd-context-monitor.js`, which solved this first.
//
// ---------------------------------------------------------------------------
// Two details that came from that implementation and are easy to get wrong.
//
// The percentage written to the bridge is the RAW one, `100 - remaining`, not
// the normalized figure the meter draws with. The meter subtracts the
// autocompact buffer and rescales, which is right for a progress bar and wrong
// for a warning: it reads about thirteen points higher, so the model gets told
// it is at 78% when the number a person sees in `/context` says 65%. Two
// components disagreeing about the same quantity, in front of the user.
//
// The session id is checked before it is used in a path. It arrives from
// outside and lands in a filename, so a value containing a separator or `..`
// would write outside the temp directory. Rejected rather than sanitised,
// because a session id that looks like a path is not a session id.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  // Remaining percentage at which the model is told to stop starting things.
  warningRemaining: 35,

  // Remaining percentage at which it is told to stop and ask.
  criticalRemaining: 25,

  // Tool calls between repeated warnings. Without this, every single tool call
  // for the rest of a long session carries the same paragraph, which costs
  // context in order to complain about context.
  debounceCalls: 5,

  // A reading older than this is not used. The status line renders constantly,
  // so a stale bridge file means it stopped rendering, and a number from a
  // minute ago is not a fact about now.
  staleSeconds: 60,
};

// A session id that is safe to put in a filename.
//
// Not sanitised, checked. Rewriting a bad value would invent an id and quietly
// share one file between two sessions; refusing it just means no warnings,
// which is the safe direction.
function safeSessionId(id) {
  const s = String(id || '');
  if (!s) return null;
  if (/[/\\]|\.\./.test(s)) return null;
  return s;
}

function bridgePath(sessionId, tmp = os.tmpdir()) {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(tmp, `claude-ctx-${safe}.json`) : null;
}

function warnPath(sessionId, tmp = os.tmpdir()) {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(tmp, `claude-ctx-${safe}-warned.json`) : null;
}

// Called from the status line, on every render. Must never throw and must
// never be slow.
function writeBridge({ sessionId, contextWindow, tmp = os.tmpdir(), now = Date.now() }) {
  const target = bridgePath(sessionId, tmp);
  if (!target) return null;

  const remaining = contextWindow && contextWindow.remaining_percentage;
  if (remaining == null || !Number.isFinite(Number(remaining))) return null;

  // Raw, deliberately. See the note at the top of this file.
  const payload = {
    session_id: sessionId,
    remaining_percentage: Number(remaining),
    used_pct: Math.round(100 - Number(remaining)),
    total_tokens: (contextWindow && contextWindow.total_tokens) || null,
    timestamp: Math.floor(now / 1000),
  };

  try {
    fs.writeFileSync(target, JSON.stringify(payload));
    return payload;
  } catch (_) {
    // Best effort. A status line that fails to write a cache is still a status
    // line, and breaking the prompt over it would be a poor trade.
    return null;
  }
}

function readBridge(sessionId, { tmp = os.tmpdir(), now = Date.now(), staleSeconds } = {}) {
  const target = bridgePath(sessionId, tmp);
  if (!target) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    return null;
  }
  // Same guard as `decide`, for the same reason: a bridge file whose
  // remaining_percentage is null would otherwise be read as zero remaining.
  if (!data || data.remaining_percentage == null) return null;
  if (!Number.isFinite(Number(data.remaining_percentage))) return null;

  const limit = staleSeconds == null ? DEFAULTS.staleSeconds : staleSeconds;
  const age = Math.floor(now / 1000) - (Number(data.timestamp) || 0);
  if (age > limit) return null;

  return data;
}

// Should anything be said, and has it been said too recently.
//
// Split from the message so the debounce can be tested without matching on
// prose. The escalation rule is the part worth pinning: crossing from warning
// into critical must not be swallowed by a debounce counter, because that is
// precisely the transition somebody needs to hear about.
function decide({ remaining, state = {}, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };

  // `remaining == null` is checked before the coercion, and that ordering is
  // the whole guard. `Number(null)` is 0, and 0 is a perfectly finite number
  // that sails through every validity check and lands below the critical
  // threshold. A missing reading would have produced CONTEXT CRITICAL, stated
  // as fact, from no data at all.
  //
  // Which is the failure this plugin keeps finding: not a wrong calculation,
  // but an absent value silently becoming a confident answer.
  const value = remaining == null ? NaN : Number(remaining);

  if (!Number.isFinite(value) || value > cfg.warningRemaining) {
    return { speak: false, level: null, state: { callsSinceWarn: 0, lastLevel: null } };
  }

  const level = value <= cfg.criticalRemaining ? 'critical' : 'warning';
  const seen = Number(state.callsSinceWarn) || 0;
  const first = state.lastLevel == null;
  const escalated = level === 'critical' && state.lastLevel === 'warning';

  if (!first && !escalated && seen + 1 < cfg.debounceCalls) {
    return {
      speak: false,
      level,
      state: { ...state, callsSinceWarn: seen + 1 },
    };
  }

  return {
    speak: true,
    level,
    escalated,
    state: { ...state, callsSinceWarn: 0, lastLevel: level },
  };
}

// Advisory, never imperative.
//
// The model is told what is true and what is unwise, and the decision about
// what to do next is left with the person. An earlier generation of this
// message told the model to save state and write handoff files, which meant a
// long session would spontaneously start writing files nobody asked for at the
// exact moment the user was busy. Reporting a fact is useful. Acting on it
// unasked is not.
function message({ level, usedPct, remaining }) {
  const numbers = `Context is at ${usedPct}% used, ${remaining}% remaining.`;

  if (level === 'critical') {
    return `CONTEXT CRITICAL. ${numbers} `
      + 'There is not much room left. Tell the user plainly and ask how they want to proceed. '
      + 'Do not start new exploration, do not read more files than the current step needs, and '
      + 'do not save state or write handoff files on your own initiative. If they want a handoff, '
      + 'they will say so, and /wrap is what does it.';
  }

  return `CONTEXT WARNING. ${numbers} `
    + 'Finish what is underway rather than starting something new, and prefer targeted reads '
    + 'over broad exploration. No need to mention this unless it affects what you were about to do.';
}

function readState(sessionId, tmp = os.tmpdir()) {
  const target = warnPath(sessionId, tmp);
  if (!target) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeState(sessionId, state, tmp = os.tmpdir()) {
  const target = warnPath(sessionId, tmp);
  if (!target) return;
  try {
    fs.writeFileSync(target, JSON.stringify(state));
  } catch (_) {
    // A lost counter means one extra warning, which is survivable. A thrown
    // error in a PostToolUse hook is not.
  }
}

module.exports = {
  DEFAULTS,
  safeSessionId,
  bridgePath,
  warnPath,
  writeBridge,
  readBridge,
  decide,
  message,
  readState,
  writeState,
};
