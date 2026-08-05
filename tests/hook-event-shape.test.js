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
// The first real capture earned its keep immediately: events carry `prompt_id`,
// `tool_use_id`, `effort.level` and `duration_ms`, none of which anyone here
// would have put in a hand-written fixture.
//
// ---------------------------------------------------------------------------
// Envelope and payload are checked differently, and that distinction is the
// whole reason this file is not a hundred lines shorter.
//
// The envelope is what every event of a type carries whatever tool triggered
// it: session_id, cwd, tool_name, transcript_path. One capture proves it.
//
// `tool_input` and `tool_response` are not that. They hold whatever the tool in
// question carries: `command` for Bash, `file_path` for Write, `page_id` for a
// Notion call. Checked against a single capture, `tool_input.command` passes or
// fails on which tool happened to fire first while capturing, which is a coin
// toss reported as a defect. So payload shapes are captured per tool and
// matched against the matcher each hook is wired to.
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
// added tomorrow is covered without anyone remembering this file exists.
//
// The matcher is kept, not discarded. It names the tools a hook actually sees,
// and without it there is no way to tell which captured payload a hook should
// be checked against.
function wiring() {
  const out = [];
  const pluginsDir = path.join(ROOT, 'plugins');
  for (const plugin of fs.readdirSync(pluginsDir).sort()) {
    const manifest = path.join(pluginsDir, plugin, 'hooks', 'hooks.json');
    if (!fs.existsSync(manifest)) continue;
    const byEvent = (JSON.parse(fs.readFileSync(manifest, 'utf8')).hooks) || {};
    for (const [event, groups] of Object.entries(byEvent)) {
      for (const group of groups) {
        // No matcher means every tool, which is recorded as an empty set and
        // read as "cannot narrow" rather than as "matches nothing".
        //
        // Split on comma as well as bar. hook-executable.test.js sanctions
        // `Write, Edit` as a legal matcher, and splitting on the bar alone
        // turns that into one tool called "Write, Edit", which matches no
        // capture and quietly drops the hook's payload reads into the unproven
        // list instead of checking them.
        const tools = group.matcher
          ? group.matcher.split(/[|,]/).map((t) => t.trim()).filter(Boolean)
          : [];
        for (const entry of group.hooks || []) {
          const m = String(entry.command || '').match(/hooks\/([\w.-]+\.js)/);
          if (!m) continue;
          const file = path.join(pluginsDir, plugin, 'hooks', m[1]);
          let hook = out.find((h) => h.file === file);
          if (!hook) {
            hook = { plugin, name: m[1], file, events: new Map() };
            out.push(hook);
          }
          if (!hook.events.has(event)) hook.events.set(event, new Set());
          for (const t of tools) hook.events.get(event).add(t);
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
  const envelopes = {};
  const payloads = {};
  const misfiled = [];
  for (const [dir, origin] of [[FIXTURES, 'fixture'], [LIVE, 'live capture']]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (_) {
        misfiled.push(`${f} (${origin}) is not readable JSON`);
        continue;
      }
      if (parsed.source !== 'capture-event.js' || !parsed.shape) continue;

      // The name INSIDE the file decides what it is, and the filename has to
      // agree. A shape copied or renamed to the wrong name would otherwise
      // become the reference for a different event, and every hook checked
      // against it would report a clean pass that proves nothing. capture-event
      // calls that worse than not filing it at all.
      const key = parsed.tool_name
        ? `${parsed.hook_event_name}.${parsed.tool_name}`
        : String(parsed.hook_event_name);
      if (`${key}.json` !== f) {
        misfiled.push(`${f} (${origin}) records ${key}, so it is filed under the wrong name`);
        continue;
      }
      const target = parsed.tool_name ? payloads : envelopes;
      target[key] = { shape: parsed.shape, origin, captured_at: parsed.captured_at };
    }
  }
  return { envelopes, payloads, misfiled };
}

// Both halves are load-bearing and the copy is not optional. The installed
// plugin lives under a version number, so wiring that path breaks at the next
// release, and \${CLAUDE_PLUGIN_ROOT} expands to nothing outside a plugin
// manifest, which is a hook that silently runs \`node /hooks/capture-event.js\`.
// Verified: the $HOME form below runs, the other two do not.
const SETTINGS_BLOCK = `
  1. Put the hook somewhere stable:

       cp plugins/build-loop/hooks/capture-event.js ~/.claude/hooks/
       chmod +x ~/.claude/hooks/capture-event.js

  2. Wire it in ~/.claude/settings.json, one entry per event you need:

       "hooks": {
         "<EventName>": [
           { "hooks": [ { "type": "command", "command":
               "node \\"$HOME/.claude/hooks/capture-event.js\\"" } ] }
         ]
       }

  3. Start one session, use it normally, then take the entries back out.

  Shapes land in ~/.claude/build-loop/hook-events/. Copy them into
  tests/fixtures/hook-events/ and commit, so this passes on a fresh clone too.`;

// ------------------------------------------------------------------ reading --

// Comments are stripped first. Several of these files discuss event fields in
// prose above the code, and counting a field because it was explained would
// have this suite verifying the documentation. The `[^:]` guard is there so a
// `http://` inside a string is not mistaken for a comment.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// `event?.tool_input` and `event['tool_input']` are the same read as
// `event.tool_input` and have to be seen as one. Normalising here rather than
// widening every regex below means one place to get it right, and a hook that
// adopts optional chaining tomorrow does not silently become a hook that reads
// nothing.
function normalizeAccess(src) {
  return src
    .replace(/\?\./g, '.')
    .replace(/\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g, '.$1');
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

// Reads rooted at one name, whether that name is the event or a local standing
// in for part of it.
//
// The alias half is not a refinement, it is most of the value. write-scan does
// `const input = event.tool_input || {}` and then reads `input.content`,
// `input.new_string` and `input.file_path`. Rooted at `event` alone, this saw
// the single path `tool_input` and checked nothing under it, so a live hook got
// a clean pass on three unverified payload reads and did not even appear in the
// unproven list. A checker that reports nothing wrong because it looked in the
// wrong place is the exact failure this suite exists to catch, happening inside
// the suite.
//
// One level deep on purpose. `const a = event.x; const b = a.y; b.z` is not
// followed, and chasing it properly wants a parser rather than a regex. The
// depth that exists covers every hook here and the shape the aliasing takes.
function readsRootedAt(src, root, prefix, paths) {
  const dotted = new RegExp(`\\b${root}\\s*\\.\\s*([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)`, 'g');
  let m;
  while ((m = dotted.exec(src)) !== null) {
    paths.add((prefix ? `${prefix}.` : '') + m[1].replace(/\s+/g, ''));
  }
  const destructure = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${root}\\b`, 'g');
  while ((m = destructure.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) paths.add((prefix ? `${prefix}.` : '') + key);
    }
  }
}

function fieldsRead(src, ident) {
  const paths = new Set();
  readsRootedAt(src, ident, '', paths);

  // `const input = event.tool_input || {}` and `const { tool_input: input } =
  // event`. Both put part of the event behind a new name, and everything read
  // through that name is a read of the event.
  const aliases = new Map();
  let m;
  const assigned = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${ident}\\s*\\.\\s*([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)`, 'g');
  while ((m = assigned.exec(src)) !== null) aliases.set(m[1], m[2].replace(/\s+/g, ''));

  const renamed = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${ident}\\b`, 'g');
  while ((m = renamed.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const [key, local] = part.split(':').map((s) => (s || '').trim());
      if (local && /^[A-Za-z_$][\w$]*$/.test(local) && /^[A-Za-z_$][\w$]*$/.test(key)) {
        aliases.set(local, key);
      }
    }
  }

  for (const [local, prefix] of aliases) readsRootedAt(src, local, prefix, paths);
  return [...paths];
}

function eventNamesWritten(src) {
  const names = new Set();
  for (const re of [/advise\s*\(\s*['"]([A-Za-z]+)['"]/g, /hookEventName\s*:\s*['"]([A-Za-z]+)['"]/g]) {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

// Whatever the hook writes without mentioning it, which is the case that
// matters. `block()` and `advise()` live in each plugin's scripts/hook-io.js,
// and the guardrails release that blocked nothing was wrong in that shared file
// rather than in any hook. A check that only reads hook files cannot see it.
//
// A helper's behaviour is credited only to a hook that actually calls it. One
// hook-io serves hooks wired to different events, so attributing everything in
// it to all of them would fail hooks that are perfectly fine.
function viaHelper(hookFile, src) {
  const names = new Set();
  let topLevelDecision = false;
  const io = path.join(path.dirname(hookFile), '..', 'scripts', 'hook-io.js');
  if (!/hook-io/.test(src) || !fs.existsSync(io)) return { names, topLevelDecision };
  const bodies = stripComments(fs.readFileSync(io, 'utf8')).split(/\nfunction\s+/).slice(1);
  for (const body of bodies) {
    const fn = (body.match(/^([A-Za-z_$][\w$]*)/) || [])[1];
    if (!fn || !new RegExp(`\\b${fn}\\s*\\(`).test(src)) continue;
    let m;
    const re = /hookEventName\s*:\s*['"]([A-Za-z]+)['"]/g;
    while ((m = re.exec(body)) !== null) names.add(m[1]);
    if (/JSON\.stringify\s*\(\s*\{\s*decision\s*:/.test(body)) topLevelDecision = true;
  }
  return { names, topLevelDecision };
}

// A recorded leaf is a type name, not a container. Anything below one is a
// member of that value rather than a field of the event: `command.match`,
// `session_id.slice`, `transcript_path.trim`, `content.length`. Walking into it
// and reporting "not present in a real event" would call ordinary JavaScript a
// defect, and the message would look exactly like a real finding.
//
// So a descent past any leaf stops and answers unknown. The check that matters
// is untouched, because a name the event does not carry at all, `event.toolName`
// for `event.tool_name`, fails on its first segment and never reaches a leaf.
// `undefined` is deliberately not in here, and its absence is load-bearing.
// A capture that recorded a missing key as the leaf "undefined" would otherwise
// make an absent field look present-but-unknown, and every read beneath it
// would pass. capture-event.js now omits those keys, and treating any that
// survive in an older fixture as absent rather than unknown closes the same
// hole from the other end.
const UNKNOWN_BELOW = new Set(['object', 'array', 'null', 'string', 'number', 'boolean', 'function']);

function hasPath(shape, dotted) {
  let node = shape;
  for (const seg of dotted.split('.')) {
    // A recorded array is `[shapeOf(firstElement)]`, so a read below it is
    // either an index or an Array member. Neither is a field of the event.
    if (Array.isArray(node)) return true;
    if (node === null || typeof node !== 'object') return false;
    if (!(seg in node)) return false;
    node = node[seg];
    // "object" and "array" mean the capture hit its depth limit; "null" means
    // the field was null on the one call recorded, which says nothing about the
    // field in general; a scalar type name means we have left the event. Every
    // one of them is unknown rather than absent, and reporting unknown as a
    // fault would be this suite inventing one out of its own sampling.
    if (typeof node === 'string' && UNKNOWN_BELOW.has(node)) return true;
  }
  return true;
}

const PAYLOAD_ROOT = /^(tool_input|tool_response)\./;

// -------------------------------------------------------------------- tests --

const hooks = wiring();
const { envelopes, payloads, misfiled } = loadShapes();
const wiredEvents = [...new Set(hooks.flatMap((h) => [...h.events.keys()]))].sort();

console.log(`hook-event-shape: ${hooks.length} hooks, ${wiredEvents.length} event types, `
  + `${Object.keys(envelopes).length} envelopes, ${Object.keys(payloads).length} tool payloads\n`);

check('every hook named in a hooks.json exists on disk', () => {
  const missing = hooks.filter((h) => !fs.existsSync(h.file));
  assert.strictEqual(missing.length, 0,
    `wired but absent: ${missing.map((h) => `${h.plugin}/${h.name}`).join(', ')}`);
});

check('every captured shape is filed under the name it records', () => {
  assert.strictEqual(misfiled.length, 0, misfiled.join('; '));
});

check('at least one real event has been captured', () => {
  assert.ok(Object.keys(envelopes).length > 0,
    'No captured event shapes, so nothing below can be verified and a pass here '
    + `would mean nothing.\n${SETTINGS_BLOCK}`);
});

check('every wired event type has a captured envelope', () => {
  const gaps = wiredEvents.filter((e) => !envelopes[e]);
  assert.strictEqual(gaps.length, 0,
    `no captured shape for: ${gaps.join(', ')}. Hooks on those events are `
    + `unverified, which is not the same as correct.\n${SETTINGS_BLOCK}`);
});

const unproven = [];

for (const hook of hooks) {
  const label = `${hook.plugin}/${hook.name}`;

  // Read inside its own guarded check. An earlier version read every hook at
  // the top of this loop, so a manifest naming a deleted file threw ENOENT and
  // killed the run: no remaining results, no summary, and a stack trace in
  // place of the readable "wired but absent" the check above had prepared.
  let src = null;
  check(`${label} can be read`, () => {
    src = normalizeAccess(stripComments(fs.readFileSync(hook.file, 'utf8')));
  });
  if (src === null) continue;

  const ident = eventIdent(src);
  check(`${label} says what it reads off the event`, () => {
    assert.ok(ident,
      'could not tell which identifier holds the parsed event. Silence here would '
      + 'mean every field check below is skipped and reported as a pass.');
  });
  if (!ident) continue;

  const fields = fieldsRead(src, ident);
  check(`${label} reads at least one field`, () => {
    assert.ok(fields.length > 0,
      `no ${ident}.<field> access found. Either the parse above is wrong or this `
      + 'hook ignores its event, and both are worth knowing.');
  });

  const envelopeFields = fields.filter((f) => !PAYLOAD_ROOT.test(f));
  const payloadFields = fields.filter((f) => PAYLOAD_ROOT.test(f));

  for (const [event, tools] of [...hook.events].sort()) {
    const env = envelopes[event];
    if (env) {
      check(`${label} reads only envelope fields ${event} carries`, () => {
        const absent = envelopeFields.filter((f) => !hasPath(env.shape, f));
        assert.strictEqual(absent.length, 0,
          `${absent.map((f) => `${ident}.${f}`).join(', ')} not present in a real `
          + `${event} event (${env.origin}${env.captured_at ? `, ${env.captured_at.slice(0, 10)}` : ''}). `
          + 'A field that is not there reads as undefined and the hook quietly does nothing.');
      });
    }

    if (!payloadFields.length) continue;

    // Only the tools this hook is actually wired to. A hook on `Write|Edit` is
    // not wrong for failing to read a field only Bash carries.
    const candidates = [...tools].filter((t) => payloads[`${event}.${t}`]);

    // Every tool in the matcher with no capture is named, including when a
    // sibling does have one. A hook on `Write|Edit` checked against Edit alone
    // is half checked, and reporting that as a clean pass is the same silence
    // this file exists to break. A matcher-less hook cannot be narrowed at all,
    // so it is named once rather than per tool.
    const gaps = tools.size
      ? [...tools].filter((t) => !payloads[`${event}.${t}`])
      : (payloadFields.length ? ['(no matcher, so no tool to check against)'] : []);
    if (!candidates.length) {
      unproven.push(`${label}: ${payloadFields.map((f) => `${ident}.${f}`).join(', ')} `
        + `on ${event}, no capture for ${gaps.join('/')}`);
      continue;
    }

    // Present in at least one of the tools the hook handles, not in all of
    // them. A hook wired to `Write|Edit` reads the union and guards with `||`:
    // write-scan takes `input.content || input.new_string` precisely because
    // `content` is a Write field and `new_string` is an Edit field. Demanding
    // every field from every tool marks that correct code as broken, which is
    // the same class of error as checking payloads against one capture.
    //
    // A field carried by none of them is still a real finding, and that is the
    // case that matters: a Bash-only hook reaching for `tool_input.file_path`
    // reads undefined on every call it will ever see.
    const absent = payloadFields.filter(
      (f) => !candidates.some((t) => hasPath(payloads[`${event}.${t}`].shape, f)));

    // A verdict is only available when every tool the hook handles has been
    // captured. With one of `Write|Edit` missing, a field absent from the
    // captured half may be carried by the other half, and calling that a defect
    // would be the suite reporting its own missing evidence as the hook's fault.
    if (gaps.length) {
      if (absent.length) {
        unproven.push(`${label}: ${absent.map((f) => `${ident}.${f}`).join(', ')} `
          + `on ${event}, not carried by ${candidates.join('/')} and no capture for ${gaps.join('/')}`);
      }
      continue;
    }

    check(`${label} reads only ${event} payload fields ${candidates.join('/')} provide`, () => {
      assert.strictEqual(absent.length, 0,
        `${absent.map((f) => `${ident}.${f}`).join(', ')} not present in a real `
        + `${event} event on any of ${candidates.join(', ')}, which is every tool this `
        + 'hook is wired to. A field that is not there reads as undefined and the hook '
        + 'quietly does nothing.');
    });
  }

  // What the hook writes back.
  const helper = viaHelper(hook.file, src);
  const written = new Set([...eventNamesWritten(src), ...helper.names]);
  const eventNames = new Set(hook.events.keys());

  if (written.size) {
    check(`${label} names an event it is actually wired to`, () => {
      const wrong = [...written].filter((n) => !eventNames.has(n));
      assert.strictEqual(wrong.length, 0,
        `writes hookEventName ${wrong.join(', ')} but is wired to `
        + `${[...eventNames].join(', ')}. Claude Code drops output whose event name `
        + 'does not match the event it sent, without a word.'
        + (helper.names.size ? ` (${[...helper.names].join(', ')} comes from scripts/hook-io.js)` : ''));
    });
  }

  // The guardrails bug stated directly, and the one output rule worth encoding.
  // Every other response field would be this repository writing down what it
  // believes the contract is, which is the thing not trusted here. This one is
  // different: it is recorded in guardrails' own hook-io.js, it cost a release,
  // and a hook emitting it on PreToolUse is silently ignored.
  //
  // Registered whether or not a decision is found, so the hook whose output
  // most resembles the historical bug is not the one hook with no check at all.
  // style-lint emits exactly that shape and is correct to, because it is wired
  // to Stop, where a top-level decision is what gets read.
  check(`${label} does not answer PreToolUse with a top-level decision`, () => {
    const emitsDecision = helper.topLevelDecision
      || /JSON\.stringify\s*\(\s*\{\s*decision\s*:/.test(src);
    assert.ok(!(emitsDecision && eventNames.has('PreToolUse')),
      'emits a top-level `decision`, which PreToolUse does not read. It reads '
      + 'hookSpecificOutput.permissionDecision, and an unrecognised shape is ignored '
      + 'without a word. This is the bug that made guardrails block nothing through 0.2.0.');
  });
}

if (unproven.length) {
  console.log(`\n  ${unproven.length} payload read(s) not proven, no capture for that tool yet:`);
  for (const u of unproven) console.log(`    ${u}`);
  console.log('  Not a failure. Trigger those tools once while capturing to cover them.');
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
