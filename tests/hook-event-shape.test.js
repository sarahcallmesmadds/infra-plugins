#!/usr/bin/env node
// Every field a hook reads off its event has to be a field the event carries.
//
// Run: node tests/hook-event-shape.test.js
//
// The bug this is named after: guardrails blocked nothing from its first
// release through 0.2.0, because its hooks emitted a top-level `decision` key
// and PreToolUse does not read that. Claude Code ignores an unrecognised shape
// with exit 0 and no message. Every guard reached the right verdict, printed
// it, and watched the command run anyway, and the whole suite stayed green,
// because nothing in the repository knew what a real event looks like.
//
// ---------------------------------------------------------------------------
// Why this is not a smoke harness.
//
// A harness that runs each hook as a child process and asserts the result was
// proposed and dropped, and the reason is worth keeping written down. Such a
// harness feeds each hook the payload its author believes Claude Code sends. If
// that belief is wrong, the hook and the harness are wrong in the same way, the
// harness passes, and the hook still does nothing. That is not a smaller
// version of the guardrails failure. It is the same failure with more code.
//
// So the reference here is not written by anyone. `capture-event.js` records
// the shape of an event that actually arrived, and every check below is made
// against that. A shape with no provenance stamp is refused rather than used,
// because a hand-typed fixture is indistinguishable from a captured one once it
// is on disk, and treating belief as evidence is the thing being guarded.
//
// ---------------------------------------------------------------------------
// What it does NOT check, deliberately.
//
// The output side, beyond the event name. Asserting that a PreToolUse denial
// must carry `hookSpecificOutput.permissionDecision` would mean writing down
// what this repository believes the response contract is, and belief is exactly
// what is not trusted here. Captures record what Claude Code sends, not what it
// accepts back. The one output check that survives that rule is the event name,
// because a hook naming an event it is not wired to is wrong whatever the rest
// of the contract turns out to be.
//
// Nothing here executes a hook, for the reason hook-executable.test.js gives:
// running session-start.js runs its whole main(), which reads ~/.claude and
// shells out to git across every configured root.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'hook-events');
const LIVE = path.join(os.homedir(), '.claude', 'build-loop', 'hook-events');

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${e.message}`);
  }
}

// ------------------------------------------------------------------ wiring --

// Discovered by walking hooks.json rather than from a list kept here, so a hook
// added tomorrow is covered without anyone remembering this file exists. A list
// would be the same problem one step along: something to forget to update.
function wiring() {
  const out = [];
  const pluginsDir = path.join(ROOT, 'plugins');
  for (const plugin of fs.readdirSync(pluginsDir).sort()) {
    const manifest = path.join(pluginsDir, plugin, 'hooks', 'hooks.json');
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    // The file nests everything under a "hooks" key, and the value of each
    // event is an array of matcher groups that each hold their own "hooks".
    const byEvent = parsed.hooks || parsed;
    for (const [event, groups] of Object.entries(byEvent)) {
      for (const group of groups) {
        for (const entry of group.hooks || []) {
          // "${CLAUDE_PLUGIN_ROOT}"/hooks/x.js, quotes and variable included.
          const m = String(entry.command || '').match(/hooks\/([\w.-]+\.js)/);
          if (!m) continue;
          const file = path.join(pluginsDir, plugin, 'hooks', m[1]);
          const found = out.find((h) => h.file === file);
          if (found) found.events.add(event);
          else out.push({ plugin, name: m[1], file, events: new Set([event]) });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ shapes --

// Live captures win over committed ones. A shape recorded on this machine
// describes the Claude Code running here, and the committed copy may be a
// release behind.
function loadShapes() {
  const shapes = {};
  for (const [dir, origin] of [[FIXTURES, 'fixture'], [LIVE, 'live capture']]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (_) {
        continue;
      }
      // The provenance stamp, and the reason any of this is worth more than a
      // fixture somebody typed. Refused rather than trusted.
      if (parsed.source !== 'capture-event.js' || !parsed.shape) continue;
      shapes[f.replace(/\.json$/, '')] = { shape: parsed.shape, origin, captured_at: parsed.captured_at };
    }
  }
  return shapes;
}

const SETTINGS_BLOCK = `
  Wire the capture hook, start one session, use it normally, then remove it:

    // ~/.claude/settings.json
    "hooks": {
      "<EventName>": [
        { "hooks": [ { "type": "command",
            "command": "\${CLAUDE_PLUGIN_ROOT}/hooks/capture-event.js" } ] }
      ]
    }

  Shapes land in ~/.claude/build-loop/hook-events/. Copy them into
  tests/fixtures/hook-events/ and commit, so this passes on a fresh clone too.`;

// ------------------------------------------------------------------ reading --

// Comments are stripped first. Several of these files discuss event fields in
// prose above the code, and counting a field because it was explained would
// have this suite verifying the documentation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// The name bound to the parsed event, taken from the file rather than assumed,
// because it is `event` in eight of these and `payload` in the ninth.
function eventIdent(src) {
  const handler = src.match(/readEvent\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/);
  if (handler) return handler[1];
  const named = src.match(/function\s+main\s*\(\s*([A-Za-z_$][\w$]*)/);
  if (named) return named[1];
  return null;
}

function fieldsRead(src, ident) {
  const paths = new Set();
  const dotted = new RegExp(`\\b${ident}\\s*\\.\\s*([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)`, 'g');
  let m;
  while ((m = dotted.exec(src)) !== null) {
    paths.add(m[1].replace(/\s+/g, ''));
  }
  // `const { tool_name, tool_input } = event`, which none of these use today
  // and all of them are free to start using tomorrow.
  const destructure = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${ident}\\b`, 'g');
  while ((m = destructure.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) paths.add(key);
    }
  }
  return [...paths];
}

// Every event name the hook writes into its own output.
function eventNamesWritten(src) {
  const names = new Set();
  for (const re of [/advise\s*\(\s*['"]([A-Za-z]+)['"]/g, /hookEventName\s*:\s*['"]([A-Za-z]+)['"]/g]) {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return [...names];
}

// And the ones it writes without mentioning them, which is the case that
// matters. `block()` and `advise()` live in each plugin's scripts/hook-io.js,
// and the guardrails release that blocked nothing was wrong in that shared file
// rather than in any hook. A check that only reads hook files cannot see it.
//
// A helper's hardcoded name is credited only to a hook that actually calls it.
// One hook-io serves hooks wired to different events, so attributing every
// literal in it to all of them would fail hooks that are perfectly fine.
function helperEventNames(hookFile, src) {
  const names = new Set();
  const io = path.join(path.dirname(hookFile), '..', 'scripts', 'hook-io.js');
  if (!/hook-io/.test(src) || !fs.existsSync(io)) return names;
  const bodies = stripComments(fs.readFileSync(io, 'utf8')).split(/\nfunction\s+/).slice(1);
  for (const body of bodies) {
    const fn = (body.match(/^([A-Za-z_$][\w$]*)/) || [])[1];
    if (!fn || !new RegExp(`\\b${fn}\\s*\\(`).test(src)) continue;
    let m;
    const re = /hookEventName\s*:\s*['"]([A-Za-z]+)['"]/g;
    while ((m = re.exec(body)) !== null) names.add(m[1]);
  }
  return names;
}

function hasPath(shape, dotted) {
  let node = shape;
  for (const seg of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    if (!(seg in node)) return false;
    node = node[seg];
    // A branch recorded as the string "object" hit the capture depth limit, so
    // anything below it is unknown rather than absent. Unknown is not a
    // finding: reporting it would be this suite inventing a fault out of its
    // own truncation.
    if (node === 'object' || node === 'array') return true;
  }
  return true;
}

// -------------------------------------------------------------------- tests --

const hooks = wiring();
const shapes = loadShapes();
const wiredEvents = [...new Set(hooks.flatMap((h) => [...h.events]))].sort();

console.log(`hook-event-shape: ${hooks.length} hooks, ${wiredEvents.length} event types, `
  + `${Object.keys(shapes).length} captured shapes\n`);

check('every hook named in a hooks.json exists on disk', () => {
  const missing = hooks.filter((h) => !fs.existsSync(h.file));
  assert.strictEqual(missing.length, 0,
    `wired but absent: ${missing.map((h) => `${h.plugin}/${h.name}`).join(', ')}`);
});

check('at least one real event has been captured', () => {
  assert.ok(Object.keys(shapes).length > 0,
    'No captured event shapes, so nothing below can be verified and a pass here '
    + `would mean nothing.\n${SETTINGS_BLOCK}`);
});

check('every wired event type has a captured shape', () => {
  const gaps = wiredEvents.filter((e) => !shapes[e]);
  assert.strictEqual(gaps.length, 0,
    `no captured shape for: ${gaps.join(', ')}. Hooks on those events are `
    + `unverified, which is not the same as correct.\n${SETTINGS_BLOCK}`);
});

check('every captured shape carries the event name it is filed under', () => {
  for (const [name, s] of Object.entries(shapes)) {
    assert.ok(hasPath(s.shape, 'hook_event_name'),
      `${name} (${s.origin}) has no hook_event_name, so it may be filed under the wrong event`);
  }
});

// The check the whole file exists for.
for (const hook of hooks) {
  const src = stripComments(fs.readFileSync(hook.file, 'utf8'));
  const ident = eventIdent(src);

  check(`${hook.plugin}/${hook.name} says what it reads off the event`, () => {
    assert.ok(ident,
      'could not tell which identifier holds the parsed event. Silence here would '
      + 'mean every field check below is skipped and reported as a pass.');
  });
  if (!ident) continue;

  const fields = fieldsRead(src, ident);

  check(`${hook.plugin}/${hook.name} reads at least one field`, () => {
    assert.ok(fields.length > 0,
      `no ${ident}.<field> access found. Either the parse above is wrong or this `
      + 'hook ignores its event, and both are worth knowing.');
  });

  for (const event of [...hook.events].sort()) {
    const s = shapes[event];
    if (!s) continue;
    check(`${hook.plugin}/${hook.name} reads only fields ${event} carries`, () => {
      const absent = fields.filter((f) => !hasPath(s.shape, f));
      assert.strictEqual(absent.length, 0,
        `${absent.map((f) => `${ident}.${f}`).join(', ')} not present in a real `
        + `${event} event (${s.origin}${s.captured_at ? `, ${s.captured_at.slice(0, 10)}` : ''}). `
        + 'A field that is not there reads as undefined and the hook quietly does nothing.');
    });
  }

  const direct = eventNamesWritten(src);
  const viaHelper = [...helperEventNames(hook.file, src)];
  const written = [...new Set([...direct, ...viaHelper])];
  if (written.length) {
    check(`${hook.plugin}/${hook.name} names an event it is actually wired to`, () => {
      const wrong = written.filter((n) => !hook.events.has(n));
      assert.strictEqual(wrong.length, 0,
        `writes hookEventName ${wrong.join(', ')} but is wired to `
        + `${[...hook.events].join(', ')}. Claude Code drops output whose event name `
        + 'does not match the event it sent, without a word.'
        + (viaHelper.length ? ` (${viaHelper.join(', ')} comes from scripts/hook-io.js)` : ''));
    });
  }
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
