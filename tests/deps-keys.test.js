#!/usr/bin/env node
// Regression tests for DEPS.json keys and the plugin-repo file search.
//
// Run: node tests/deps-keys.test.js
//
// Two faults, found by running /audit-deps against this repository for the
// first time. Both are prose rather than code, so what is testable is the
// instruction each skill gives and the shape of the repository it is given.
//
// 1. Keys collided. The rule was {repo}:{name on disk}, which assumes the root
//    name disambiguates. Under a plugin-repo root it does not: one root named
//    `plugins` holding four plugins produces `plugins:cli` for three separate
//    files. Later entries overwrite earlier ones, so the map describes the
//    wrong file and a fix to one plugin flags another plugin's dependents.
//
// 2. scripts/ was invisible. The plugin-repo search covered skills/, hooks/ and
//    commands/, and scripts/ is where the logic actually lives, since hooks and
//    skills in a well-built plugin are thin wrappers. Two of the four guardrails
//    bugs fixed on 2026-07-27 were in scripts/, so /flag-issue could not resolve
//    the file for the common case.
//
// The behavioural half at the bottom derives keys from this repository both
// ways and asserts the collision is real. If the plugin layout ever changes so
// that bare names no longer collide, that test fails and the rule can be
// revisited on evidence rather than on memory.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PLUGINS = path.join(__dirname, '..', 'plugins');
const BUILD_LOOP = path.join(PLUGINS, 'build-loop');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const SCHEMA = read(BUILD_LOOP, 'reference', 'SCHEMA-DEPS.md');
const SKILLS = {
  'flag-issue': read(BUILD_LOOP, 'skills', 'flag-issue', 'SKILL.md'),
  'audit-deps': read(BUILD_LOOP, 'skills', 'audit-deps', 'SKILL.md'),
  'apply-fix': read(BUILD_LOOP, 'skills', 'apply-fix', 'SKILL.md'),
  'built-check': read(BUILD_LOOP, 'skills', 'built-check', 'SKILL.md'),
};

// The number of checks this file is expected to run. It is asserted at the
// bottom rather than printed from a literal, because on 2026-07-28 three checks
// were added here and the hardcoded tally was left at 17, so the suite ran 20
// and said 17. That is the failure this repository keeps finding: the value was
// right, the sentence printed beside it was not.
//
// Counting as they run fixes the wrong number. It does not fix the other half,
// which is why the literal was here at all: a check that quietly disappears
// should be noticed. So the count is derived AND compared, and this constant
// has to move when a check is added or removed. Forgetting now fails the suite
// instead of printing a smaller number nobody reads.
const EXPECTED_CHECKS = 33;

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- where the plugin-repo search looks -------------------------------------

// These three rules have not changed. Their evidence has. The skills used to
// carry a glob block each, three copies in prose, and the rules below read
// those copies. `bin/` was added to the repository on 2026-08-14 and to none of
// the three, which is exactly the drift these were written to catch and exactly
// what they could not catch, because a rule that names one directory only ever
// finds that directory missing.
//
// The list now lives once in roots.js and the skills call it, so these ask what
// it generates. roots-check.test.js holds the complementary half: that the list
// covers every directory a plugin actually has, and that no skill has gone back
// to writing its own.
const { execFileSync: exec } = require('child_process');
const ROOTS = path.join(BUILD_LOOP, 'scripts', 'roots.js');
const LAYOUT = exec(process.execPath, [ROOTS, 'layout', '--root', '<root.path>'], { encoding: 'utf8' });
const LAYOUT_FIND = exec(process.execPath, [ROOTS, 'layout', '--root', '<root.path>', '--slug', '{target}'], { encoding: 'utf8' });

// Every skill that searches a plugin-repo root has to reach the generated list
// rather than spell one out, which is what makes the three rules below hold for
// all of them at once instead of one copy at a time.
check('every skill that searches a plugin-repo root calls the shared listing', () => {
  for (const [name, text] of Object.entries(SKILLS)) {
    if (!/plugins\/\*\//.test(text)) continue;
    assert.ok(
      /roots\.js" layout/.test(text),
      `${name} searches a plugin-repo root without calling roots.js layout, so it `
      + 'has a copy of the list that can drift'
    );
  }
});

check('the shared listing reaches scripts/, where the logic lives', () => {
  assert.match(LAYOUT, /plugins\/\*\/scripts\//);
  assert.match(LAYOUT_FIND, /plugins\/\*\/scripts\//);
});

// --- the statusline/ and tests/ gaps ---------------------------------------

// Found by diffing the repository against DEPS.json on 2026-07-28: 19 test
// files and 2 statusline files, none of them reachable by any search. The
// statusline pair was in the map only because someone added it by hand, which
// is the state that looks fixed and is not.
check('the shared listing reaches statusline/', () => {
  assert.match(LAYOUT, /plugins\/\*\/statusline\//);
  assert.match(LAYOUT_FIND, /plugins\/\*\/statusline\//);
});

check('the shared listing reaches tests/, which is a sibling of plugins/', () => {
  // This one was never fixable by adding a subdirectory to the plugins/*/ glob.
  // tests/ is a sibling of plugins/, not a child, so the search has to reach
  // outside the pattern that finds everything else.
  assert.match(LAYOUT, /<root\.path>\/tests\//);
  assert.match(LAYOUT_FIND, /<root\.path>\/tests\//);
});

check('a test target keeps a key that cannot collide with a plugin target', () => {
  assert.ok(
    /built-check\.test/.test(SKILLS['audit-deps']),
    'audit-deps does not say what key a test file gets, so built-check.test.js '
    + "and the build-loop skill called built-check can land on the same key"
  );
});

check('a script target is no longer sent straight to a manual ask', () => {
  assert.ok(
    !/If `target_kind` is `script` or `other` and nothing above matched/.test(SKILLS['flag-issue']),
    'flag-issue still gives up on script targets before searching scripts/'
  );
});

// --- the key collision -----------------------------------------------------

check('the schema defines the key under a plugin-repo root', () => {
  assert.ok(
    /\{plugin\}\/\{name\}/.test(SCHEMA),
    'SCHEMA-DEPS.md does not say what the key is when one root holds many plugins'
  );
  // The key rule arrived in v3, so anything from 3 up carries it. Pinning the
  // exact number made this fail on the next unrelated bump, which says nothing
  // about whether the rule is still documented.
  const declared = SCHEMA.match(/\$schema_version` \| int \| Currently (\d+)/);
  assert.ok(declared, 'the schema does not declare a version at all');
  assert.ok(Number(declared[1]) >= 3, `schema version is ${declared[1]}, so the plugin-qualified key predates it`);
});

check('both key readers know about the plugin-qualified form', () => {
  // A writer and a reader that disagree about the key produce a lookup that
  // finds nothing, which is indistinguishable from having no dependents.
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /plugin-repo`, it is `\{repo\}:\{plugin\}\/\{target\}/.test(SKILLS[name]),
      `${name} still builds a bare {repo}:{target} key, which will miss every `
      + 'entry written under a plugin-repo root'
    );
  }
});

check('both readers fall back to a suffix match rather than giving up quietly', () => {
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /ending `\/\{target\}`|ends with `\/\{target\}`|suffix match on `\/\{target\}`/.test(SKILLS[name]),
      `${name} has no suffix fallback, so a bare lookup against a v3 map finds nothing`
    );
  }
});

check('both readers retry the bare key, which is what a pre-v3 map stored', () => {
  // The suffix match only works in one direction. A qualified lookup against a
  // map written before v3 finds nothing through it, because the stored name is
  // `hook-io` and that does not end with `/hook-io`. Without a bare-key retry,
  // installing this version makes every existing map go quiet, which is the
  // failure the whole change set out to remove.
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /bare key, `\{repo\}:\{target\}`/.test(SKILLS[name]),
      `${name} never retries the bare key, so a pre-v3 map silently stops reporting dependents`
    );
    assert.ok(
      /predates v3/.test(SKILLS[name]),
      `${name} matches a pre-v3 key without saying the entry may describe a different plugin`
    );
  }
});

check('the schema spells out the lookup order rather than one fallback', () => {
  assert.ok(
    /in order/.test(SCHEMA) && /bare key, `\{repo\}:\{target\}`/.test(SCHEMA),
    'SCHEMA-DEPS.md does not define the full lookup order, so the two readers '
    + 'have nothing to agree against'
  );
});

check('the README does not claim an old map keeps working unqualified', () => {
  // It said "keeps working through the fallback", which was not true for the
  // migration direction that actually occurs.
  const readme = read(BUILD_LOOP, 'README.md');
  assert.ok(
    !/keeps working through the fallback/.test(readme),
    'README still claims a pre-v3 map resolves through the suffix fallback, which it does not'
  );
});

check('an ambiguous match is reported rather than guessed at', () => {
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /More than one[\s\S]{0,200}(do not choose|do not pick)/i.test(SKILLS[name]),
      `${name} does not say what to do when two keys match, and guessing sends a `
      + 'fix to the wrong plugin'
    );
  }
});

// --- edges point at a key without becoming one -----------------------------
//
// The key carries the plugin. An edge has to reach the same key, and it also
// feeds /flag-issue, which copies an edge's `target` verbatim into a queue
// entry. A queue entry's target is a name on disk. So the plugin has to travel
// beside `target`, not inside it: fold it in and every dep-review entry names
// something like `guardrails/hook-io`, which no search will ever resolve.

check('the edge format carries plugin as its own field', () => {
  assert.ok(
    /\| `plugin` \| string \| no \|/.test(SCHEMA),
    'the edge field table has no `plugin`, so an edge inside a plugin-repo root '
    + 'cannot say which plugin it means'
  );
  assert.ok(
    /\*\*Bare, never `plugin\/name`\.\*\*/.test(SCHEMA),
    'nothing says the edge target stays bare, which is the half that breaks quietly'
  );
});

check('flag-issue keeps the edge target bare in the entry it writes', () => {
  const t = SKILLS['flag-issue'];
  assert.ok(
    /plugin: P/.test(t),
    'flag-issue does not read the edge plugin field'
  );
  assert.ok(
    /Never write `\{P\}\/\{X\}` into the entry's `target`/.test(t),
    'flag-issue does not forbid writing a slashed name into a queue entry, '
    + 'which produces an entry that cannot resolve to a file'
  );
});

check('audit-deps writes plugin beside target, and carries it to back-edges', () => {
  const t = SKILLS['audit-deps'];
  assert.ok(
    /never `\{"target": "guardrails\/hook-io"\}`/.test(t),
    'audit-deps does not say to keep the edge target bare'
  );
  assert.ok(
    /plugin: A\.plugin/.test(t),
    'the back-edge step drops plugin, so dependents lose it while depends_on keeps it'
  );
});

check('audit-deps Step 4 names every required edge field, with no ellipsis', () => {
  // The ellipsis is the whole defect. Step 4's edge example used to read
  // `{"target": "hook-io", "plugin": "guardrails", ...}`, and everything behind
  // the `...` went unwritten: 118 edges across 41 entries carried no `repo`,
  // measured on 2026-08-17 and repaired the same day. `plugin` was named and so
  // it was always present; `repo` was not named and so it was always absent.
  // That is the correlation this check exists to keep.
  const t = SKILLS['audit-deps'];

  // Anchored to the example block itself, not to the whole file. Checking that
  // the field names appear "somewhere in the skill" passes while the example
  // omits them, because the words occur in prose all over this file. Devin
  // review round 1 on PR #136 caught that: the check was named for what it
  // should prove and asserted something weaker.
  const start = t.indexOf('"target": "hook-io"');
  assert.ok(start !== -1, 'the Step 4 worked edge example is gone or renamed');
  const open = t.lastIndexOf('{', start);
  const close = t.indexOf('}', start);
  assert.ok(open !== -1 && close !== -1 && close > open, 'the worked example is not a JSON object');
  const example = t.slice(open, close + 1);

  for (const field of ['target', 'kind', 'repo', 'reason']) {
    assert.ok(
      new RegExp('"' + field + '"\\s*:').test(example),
      `the Step 4 worked edge example omits "${field}", which SCHEMA-DEPS.md marks `
      + 'required, so copying the example produces an invalid edge'
    );
  }

  // No ellipsis anywhere in the example, however it is worded. The original
  // defect was `{"target": "hook-io", "plugin": "guardrails", ...}`, and banning
  // only that exact string lets a differently worded one back in.
  assert.ok(
    !/\.\.\./.test(example),
    'the worked edge example hides fields behind an ellipsis again, which is '
    + 'exactly what left 118 edges without a repo'
  );

  // The prose has to name the set too, so a reader who skims the example still
  // learns which fields are required rather than inferring it from one sample.
  assert.ok(
    /`target`, `kind`, `repo` and `reason`/.test(t),
    'Step 4 no longer names the four required edge fields in prose'
  );
});

check('an entry stores plugin as a field, so back-edges have it to read', () => {
  // The back-edge step reads A.plugin off an entry. If the plugin only lives
  // inside the composite key, that read returns nothing and every dependent is
  // written without one, which is the ambiguity this change removed from edges
  // reappearing on the reverse direction.
  assert.ok(
    /\| `plugin` \| string \| no \| Which plugin inside a `plugin-repo` root holds this/.test(SCHEMA),
    'the entry field table has no `plugin`, so A.plugin in the back-edge step '
    + 'reads a field that does not exist'
  );
  assert.ok(
    /`plugin` when the root is a\n  `plugin-repo`/.test(SKILLS['audit-deps'])
      || /plus \*\*`plugin` when the root is a/.test(SKILLS['audit-deps']),
    'audit-deps never writes plugin onto the entry it builds'
  );
});

check('a dep-review id and dedup key carry the plugin, so two cli entries survive', () => {
  // target and id want opposite things. target is a name that has to resolve to
  // a file, so it stays bare. id, filename and dedup_key exist to be unique,
  // and a bare name is not: one fix touching something both guardrails/cli and
  // slop-check/cli depend on produced the same filename twice and the same
  // dedup key twice, so one review overwrote the other or was skipped as a
  // duplicate. The dependent in the other plugin then vanished with no message,
  // inside the machinery built to stop exactly that.
  const t = SKILLS['flag-issue'];
  assert.ok(
    /dep-review-\{slug\(P\)\}-\{slug\(X\)\}/.test(t),
    'the dep-review id is built from the bare name, so two dependents sharing a '
    + 'name across plugins collide on one filename'
  );
  assert.ok(
    /dep-review::\{P\}\/\{X\}::/.test(t),
    'the dedup key is built from the bare name, so the second dependent is '
    + 'skipped as a duplicate of the first'
  );
});

check('the dependents warning names the plugin, not just the bare name', () => {
  // Guidance said to show {plugin}/{target}; the template below it still said
  // {dep.target}. The template is the part that reaches the user.
  const t = SKILLS['apply-fix'];
  assert.ok(
    /\{dep\.plugin\}\/\{dep\.target\}/.test(t),
    'the warning template still shows a bare dependent name, so a fix can warn '
    + 'about "cli" without saying which of the three it means'
  );
});

// --- and the repository this rule exists for -------------------------------

function targetsInRepo() {
  const found = [];
  for (const plugin of fs.readdirSync(PLUGINS)) {
    for (const dir of ['scripts', 'hooks', 'commands']) {
      const full = path.join(PLUGINS, plugin, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full)) {
        if (file.startsWith('.') || file.endsWith('.json')) continue;
        found.push({ plugin, name: file.replace(/\.[^.]+$/, '') });
      }
    }
    const skills = path.join(PLUGINS, plugin, 'skills');
    if (fs.existsSync(skills)) {
      for (const s of fs.readdirSync(skills)) found.push({ plugin, name: s });
    }
  }
  return found;
}

check('bare names really do collide in this repository', () => {
  // The evidence the rule rests on. If this stops being true the collision is
  // gone and the key format is worth revisiting, so a failure here is a prompt
  // rather than a defect.
  const counts = {};
  for (const t of targetsInRepo()) counts[t.name] = (counts[t.name] || 0) + 1;
  const collisions = Object.entries(counts).filter(([, n]) => n > 1);
  assert.ok(
    collisions.length > 0,
    'no bare-name collisions found, so the plugin-qualified key may no longer '
    + 'be needed. Check before removing it.'
  );
  assert.ok(
    collisions.some(([name]) => name === 'cli'),
    `expected cli to collide, got: ${collisions.map(([n, c]) => n + '×' + c).join(', ')}`
  );
});

check('plugin-qualified keys are unique across the whole repository', () => {
  const seen = new Set();
  for (const t of targetsInRepo()) {
    const key = `plugins:${t.plugin}/${t.name}`;
    assert.ok(!seen.has(key), `plugin-qualified key still collides: ${key}`);
    seen.add(key);
  }
});

// --- what a plugin row's path points at -------------------------------------

// Found by running the audit by hand on 2026-07-28. The map stores a plugin as
// its manifest; the glob that finds plugins returns a directory. Nothing says
// which to store, so a run reports all five plugins MISSING and the same five
// ORPHANED in a single pass, and approving that draft doubles every plugin row.
check('audit-deps says a plugin row stores the manifest, not the directory', () => {
  assert.ok(
    /`path` for a `kind: plugin` entry is the plugin's\n\s*`\.claude-plugin\/plugin\.json`/.test(SKILLS['audit-deps']),
    'audit-deps never says what path a plugin entry stores, so the directory '
    + 'the glob returns and the manifest already in the map both look correct'
  );
});

// --- the two ways this skill used to lose information silently --------------

// Step 6 said "prune dependents with no matching depends_on" and nothing else.
// Run against the live map on 2026-08-11 that deleted 101 of 242 back-edges,
// 42 percent, almost all of them test coverage links. No error, no count, the
// file just came back smaller and every reader kept working.
check('audit-deps does not prune back-edges without being told to', () => {
  const step6 = SKILLS['audit-deps'];
  assert.ok(
    /Collect, do not delete/.test(step6),
    'audit-deps still prunes one-sided dependents as a silent step'
  );
  assert.ok(
    /Never prune without an explicit `remove`/.test(step6),
    'audit-deps never says pruning needs permission, so it reads as automatic'
  );
  assert.ok(
    /keep \/ add-missing \/ remove/.test(step6),
    'audit-deps offers no way to repair a one-sided edge, so the only options '
    + 'are keep it broken or delete the evidence'
  );
});

// The bucket is found in Step 3 and put to the user in Step 5, with everything
// else. Asking in Step 6 would be a second approval for a write they already
// approved, which is the shape Step 5 exists to prevent.
// Schema v5 made `dependents` generated from direct edges only, and the obvious
// next simplification is to make the one-sided test direct-only to match. It is
// wrong. Generation and acceptance are separate: a person can hand-write a row
// that a chain explains, A's depends_on naming B and not C while A sits in C's
// dependents. A direct-edge test flags that healthy row, and `add-missing` then
// invents a direct A -> C edge the schema does not intend. The last assertion
// pins the sentence that says the two rules are separate, because without it
// the walk reads as leftovers from the transitive era and gets deleted.
check('one-sided means no path at all, not no direct edge', () => {
  const skill = SKILLS['audit-deps'];
  assert.ok(
    /no `depends_on` path to T at all/.test(skill),
    'audit-deps defines one-sided by a missing direct edge, which flags every '
    + 'legitimate chain-explained back-edge as broken'
  );
  assert.ok(
    /walk its `depends_on` transitively/.test(skill),
    'audit-deps never says to follow the chain, so an implementation compares '
    + 'direct edges and inflates the bucket'
  );
  assert.ok(
    /Generation is direct-only\. Acceptance is not\./.test(skill),
    'the reason the direct-edge test is still wrong after v5 is not written '
    + 'down, so the walk reads as dead weight and gets simplified back'
  );
});

// v5 settled that dependents are generated direct-only. The schema said the
// opposite from v1 and nothing ever implemented it, so the risk being pinned
// here is the rule drifting back into the schema and quietly re-authorising a
// closure that would fan one dep-review per reachable dependent.
check('the schema says dependents are generated from direct edges only', () => {
  assert.ok(
    /`dependents` is generated from direct edges only/.test(SCHEMA),
    'SCHEMA-DEPS.md no longer states the direct-only generation rule'
  );
  assert.ok(
    !/Transitive dependencies ARE tracked/.test(SCHEMA),
    'the retracted transitive-generation rule is back in SCHEMA-DEPS.md'
  );
  assert.ok(
    /explained only by a chain is still valid, and is never one-sided/.test(SCHEMA),
    'the schema drops the direct-only rule without saying a chain-explained row '
    + 'is still valid, which is what stops /audit-deps fabricating an edge'
  );
});

check('a scoped audit filters the one-sided bucket too', () => {
  const skill = SKILLS['audit-deps'];
  assert.ok(
    !/filter all three buckets/.test(skill),
    'the $ARGUMENTS filter still names three buckets, so ONE-SIDED escapes it'
  );
  assert.ok(
    /a row is in scope if either end matches/.test(skill),
    'audit-deps never says how to scope a one-sided row, which sits between two '
    + 'entries rather than on one'
  );
});

check('audit-deps asks about one-sided edges in the one approval gate', () => {
  const skill = SKILLS['audit-deps'];
  assert.ok(
    /four buckets/.test(skill),
    'ONE-SIDED is not one of the buckets Step 3 produces, so it cannot reach '
    + "Step 5's draft"
  );
  assert.ok(
    /One-sided \(J of \{total\} dependents rows/.test(skill),
    "Step 5's draft has no One-sided section, so the user approves a write "
    + 'without seeing what it removes'
  );
  assert.ok(
    /\*\*Do not ask here\.\*\*/.test(skill),
    'Step 6 still opens a second approval conversation'
  );
});

// Every clause in the closing summary is a claim somebody acts on. It said
// "reviewed {K} stale entries" while Step 5 was leaving declined ones alone.
check('the summary does not report work that did not happen', () => {
  const skill = SKILLS['audit-deps'];
  // The template line itself, not the prose around it. The paragraph below it
  // quotes the retired wording on purpose, to say what it used to claim and
  // why that was wrong, and a test that cannot tell a template from a
  // description of one forces the history to be deleted to go green.
  const template = skill.match(/^> "DEPS\.json updated\..*$/m);
  assert.ok(template, 'the summary template is gone entirely');
  assert.ok(
    !/reviewed/.test(template[0]),
    `the summary template still claims a review: ${template[0]}`
  );
  assert.ok(
    /Nothing was stamped as reviewed/.test(skill),
    'the summary never says what was left alone, so a declined run reads as a '
    + 'completed one'
  );
  assert.ok(
    /One-sided dependents: \{J\}/.test(skill),
    'the summary never reports the one-sided bucket, and silence there reads '
    + 'as there having been none'
  );
});

// The missing bucket is the only one whose approval creates entries, and it was
// written with a default of ALL first. On 2026-08-16 a first scan of a newly
// registered root returned 16 things, ten of them retired skills already
// replaced by plugins, and one agreement put all ten into the map as ordinary
// entries. Nothing in this skill can tell a live target from a retired one, so
// the default has to be the answer that writes nothing.
//
// Two places instruct, and both are pinned, because either one alone leaves the
// skill telling the reader and the implementation different things. The prompt
// line in the Step 5 draft is what the user reads at the moment they answer. The
// paragraph beginning "For missing entries" is what an implementation consults
// when the answer comes back bare.
//
// Nothing here reads the paragraph after it, which records that ALL was tried
// first and what it cost. That is deliberate. A check anchored in a history
// paragraph makes the history load-bearing, so rewording it fails a suite while
// the behaviour is perfectly correct, and the cheapest way back to green is
// deleting the record of why the rule exists. The summary-template check above
// documents the same trap from the other direction.
//
// Both are compared whole rather than searched for the phrases that matter, and
// that is the part worth explaining, because a presence test is the obvious
// simplification and it does not work here. Asking whether `Default: none.` is
// present says nothing about what sits beside it, and the edit to expect is not
// none being changed to all, it is a sentence added that reads as a
// clarification: "If the user gives a bare response, add all missing entries."
// That defeats a presence test appended after the default, inserted before it,
// or added to the end of the instruction paragraph, leaving the pinned phrase
// intact and the meaning reversed every time. Anchoring the phrase more tightly
// moves which of those three works. Only comparing the whole text refuses all of
// them.
//
// Whitespace is flattened before comparing, so part of the cost of that
// strictness is refunded. A change to the three spaces before Default, and a
// rewrap of the instruction paragraph, are not the default changing and do not
// fail this.
//
// The prompt line is the exception and it is not an oversight. It is matched as a
// single line, so wrapping it across two fails even with the wording intact. That
// line sits inside a fenced draft, where the break is not layout: it is what the
// user is shown at the moment they answer. The message says so rather than
// claiming reflow is free, which is a worse failure than the strictness, because
// it tells the reader to go looking for a wording change that is not there.
//
// A blank line inserted inside the instruction paragraph fails too, for the same
// reason rather than by accident. A blank line in markdown does not wrap a
// paragraph, it ends one and starts another, so the second half stops being part
// of the instruction that governs and becomes a separate paragraph that happens
// to sit underneath it. The message reports where the missing phrase went instead
// of calling it deleted.
//
// The rest of the cost is real and is accepted rather than solved. Flattening
// leaves case, emphasis and punctuation load-bearing, so writing `**Default is
// none.**` in place of NONE fails a check whose subject has not changed. Making
// those tolerant too would mean deciding which characters carry meaning in a
// sentence whose entire job is to carry one, and the failure message is the
// cheaper answer: it says reflow is already ignored, which leaves rewording, and
// it says to update the expected text when that was deliberate. A check that
// fails without saying what to do about it gets deleted rather than answered.
//
// What this does not do, written down because it looks like a gap worth closing
// and closing it is a trap. It pins what these two passages say. It cannot show
// that nothing else in the file contradicts them: a paragraph inserted anywhere
// outside both spans, saying that a bare answer adds everything, passes this
// untouched. Widening the spans moves that boundary rather than removing it,
// because the file is prose and the property wanted is semantic, and every
// widening costs tolerance somewhere a reflow will find.
//
// So the boundary is where it is on purpose. This catches the edit that actually
// happens, someone changing the default where the default is written. Two
// instructions in one file disagreeing is a different fault, it is not
// detectable by pinning text, and it wants its own check rather than a wider
// version of this one.
check('the new-items bucket defaults to adding nothing', () => {
  // Normalised first. The paragraph match below ends on a blank line, which is
  // two newlines and is three characters under CRLF, so a file saved with
  // Windows endings would find no paragraph at all and report it as missing.
  const skill = SKILLS['audit-deps'].replace(/\r\n?/g, '\n');
  // Spacing is not meaning. Everything below compares flattened text.
  const flat = (s) => s.replace(/\s+/g, ' ').trim();

  // Every passage is counted, not just found. A first match is not necessarily
  // the passage that governs: a correct copy sitting anywhere above the real one
  // satisfies a comparison against match()[0] while the real one below it says
  // the opposite. Nothing plants a decoy by accident, but an unrelated section
  // quoting the draft would do it without meaning to, and either way the check
  // would be reading a passage nobody runs on.
  const PROMPT_LINE = 'so say which ones you want. all / none / name them. Default: none.';
  const prompts = skill.match(/^\s*so say which ones you want\..*$/gm) || [];
  // Zero matches has two causes and a line matcher cannot tell them apart. A wrap
  // that splits the opening phrase itself leaves nothing to find, and calling
  // that gone sends the reader looking for a deleted line that is on screen in
  // front of them. Flattening the whole file settles the one case worth naming:
  // the exact sentence surviving there means the line is present and broken
  // across lines, wherever the break falls.
  //
  // Only the whole sentence is used for that, never a shorter opening. Flattening
  // joins every line to the one after it, so it invents adjacencies that exist
  // nowhere in the file: a different passage in this same skill wraps as "so say"
  // then "which ones you want. Nothing was stamped as reviewed", which flattens
  // into the exact opening phrase of the line being looked for. A short anchor
  // reports a deleted line as merely wrapped, using evidence assembled out of two
  // unrelated sentences.
  //
  // So when the full sentence is absent, both causes stay on the table and the
  // message says so rather than choosing.
  const flatSkill = flat(skill);
  assert.strictEqual(
    prompts.length, 1,
    prompts.length === 0
      ? flatSkill.includes(PROMPT_LINE)
        ? 'no single line in the Step 5 draft matches, and the whole sentence does '
          + 'appear once the file is flattened. Most likely the line is wrapped '
          + 'across two, which is worth fixing because it sits in a fenced draft '
          + 'where the break is what the user is shown. Worth ruling out first: '
          + 'flattening joins every line to the next, so two neighbouring lines '
          + 'can read that way without either being the draft line'
        : 'no single line in the Step 5 draft starts "so say which ones you want.". '
          + 'Either the line is gone, or it has been wrapped across lines and '
          + 'reworded as well, and this cannot tell which from here'
      : `${prompts.length} lines in audit-deps start "so say which ones you want.". `
        + 'This check cannot tell which one Step 5 shows the user, so it is not '
        + 'checking anything until there is one'
  );
  assert.strictEqual(
    flat(prompts[0]),
    PROMPT_LINE,
    'the line the user answers no longer says what it said. Spacing within the '
    + 'line is already ignored, but this line is matched as one line and lives '
    + 'inside a fenced draft, so wrapping it across two is a change to what the '
    + 'user is shown and fails here too. Update the expected text if the rewording '
    + 'or the wrap was deliberate. If it is an added clause, it changes what the '
    + 'draft tells the user a bare answer does'
  );

  // To the next blank line. A blank line inserted inside the paragraph truncates
  // what is read without changing how many paragraphs match, so the count cannot
  // report it and does not try to. The comparison below tells that case apart
  // instead, by asking whether a phrase missing from what was read is still
  // somewhere in the file.
  // Ends at a blank line or at the end of the file. Requiring the blank line
  // alone means the paragraph is unfindable if it is ever the last thing in the
  // file, which reports as the paragraph being missing rather than as the end of
  // the file arriving early.
  // `\s*` for the same reason the prompt matcher has it. Without it an indented
  // copy of the correct paragraph, under a numbered step or inside a block quote,
  // is not found at all and reports as missing.
  const paragraphs = skill.match(/^\s*For missing entries,[\s\S]*?(?=\n\n|(?![\s\S]))/gm) || [];
  assert.strictEqual(
    paragraphs.length, 1,
    paragraphs.length === 0
      ? 'no paragraph starting "For missing entries," was found. Either it is '
        + 'gone, or a reflow moved that opening phrase off the start of a line'
      : `${paragraphs.length} paragraphs start "For missing entries,", so this `
        + 'check cannot tell which one an implementation reads'
  );
  const instruction = flat(paragraphs[0]);
  const claims = [
    ['the default', /\*\*Default is NONE\.\*\*/],
    ['the reason it differs from the other three', /the one bucket whose approval creates entries/],
  ];
  // Said before the whole-paragraph comparison speaks, because "this long string
  // differs from that long string" sends the reader to a character diff to answer
  // a question the check already knows the answer to.
  //
  // Each is a phrase rather than an idea, so what it can honestly report is that
  // the phrase is not there in that form, not that the thought is gone. The two
  // read alike in a failure message and are not the same thing: an emphasis
  // change loses the phrase and keeps the meaning.
  //
  // Absent from the file is worth telling apart from absent from the paragraph,
  // which the count above cannot do: blaming the second on the wording sends the
  // reader looking for a deletion that never happened.
  const missing = claims.filter(([, re]) => !re.test(instruction));
  // Against the flattened file, not the raw one. A claim reflowed across two
  // physical lines is still in the file, and testing the raw text calls it gone,
  // which is the more alarming of the two messages and the wrong one.
  const elsewhere = missing.filter(([, re]) => re.test(flatSkill)).map(([name]) => name);
  const gone = missing.filter(([, re]) => !re.test(flatSkill)).map(([name]) => name);
  const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const diagnosis = [
    gone.length
      ? `${gone.join(' and ')} ${gone.length > 1 ? 'no longer appear' : 'no longer appears'} `
        + 'in this form anywhere in audit-deps'
      : '',
    // This knows exactly two things: the phrase is not in the text that was
    // extracted, and it is somewhere in the file. It does not know why, so it
    // reports the two and lists what would explain them without picking one.
    //
    // Naming a single cause here is the tempting version and it is wrong twice
    // over. "A blank line has split the paragraph" is false when the phrase was
    // moved. Offering a split or a move is still a closed set, and it is false
    // when the phrase was deleted from the paragraph while an unrelated copy sits
    // elsewhere, which satisfies neither. Both read as more helpful than the two
    // bare facts and send the reader looking for something that did not happen.
    elsewhere.length
      ? `${elsewhere.join(' and ')} ${elsewhere.length > 1 ? 'are' : 'is'} not in the paragraph `
        + `that was read, but ${elsewhere.length > 1 ? 'are' : 'is'} present somewhere else in `
        + 'audit-deps. Those two facts have several explanations: a blank line splitting the '
        + 'paragraph so only the part above it was checked, the phrase having moved, or a second '
        + 'copy sitting somewhere unrelated'
      : '',
  ].filter(Boolean).map(sentence).join('. ');
  assert.strictEqual(
    instruction,
    'For missing entries, take the list whole or in part. `all` adds every one, '
    + '`none` adds nothing, and naming them adds only those. **Default is NONE.** '
    + 'This is the one bucket whose approval creates entries, and the other three '
    + 'all default to changing nothing, so this one does too.',
    diagnosis
      || 'the paragraph an implementation reads for the default still contains both '
        + 'phrases but no longer says what it said. Reflow is already ignored, so '
        + 'this is a wording or formatting change. A sentence added to the end of '
        + 'it is the specific edit this is here to catch, because it leaves every '
        + 'phrase worth grepping for in place'
  );
});

// `last_updated` means a person or this skill judged the edges correct. v4 added
// `last_auto_checked` so an unattended check would stop writing into it. Step 5
// then told this skill to stamp it on entries nobody looked at, which is the
// same fault in the place the fix did not reach.
check('audit-deps does not stamp a review that did not happen', () => {
  const skill = SKILLS['audit-deps'];
  assert.ok(
    /If they decline, leave `last_updated` alone/.test(skill),
    'audit-deps still bumps last_updated on entries it did not re-infer'
  );
  assert.ok(
    !/this acknowledges the file was inspected/.test(skill),
    'the old instruction to stamp an uninspected entry is still present'
  );
});

check('finding a plugin resolves to a file rather than a directory', () => {
  // /apply-fix opens the path a queue entry records, and a directory cannot be
  // opened. The rule used to be checked in flag-issue's own prose; the lookup is
  // generated now, so it is checked where it is produced and holds for every
  // caller rather than for the one that was audited.
  assert.match(
    LAYOUT_FIND, /plugins\/\{target\}\/\.claude-plugin\/plugin\.json/,
    'finding a plugin resolves to its directory, and /apply-fix cannot open one'
  );
  assert.ok(
    !/ls -1d <root\.path>\/plugins\/\{target\} 2/.test(LAYOUT_FIND),
    'the directory-only lookup is still there beside the manifest'
  );
});

check('the two path conventions really are distinguishable', () => {
  // The evidence the rule rests on, in the shape of the collision test above.
  // If a manifest path ever equalled its directory path the double-add could
  // not happen and this rule would be unnecessary.
  const dirs = fs.readdirSync(PLUGINS).filter((d) =>
    fs.existsSync(path.join(PLUGINS, d, '.claude-plugin', 'plugin.json')));
  assert.ok(dirs.length > 1, `expected several plugins on disk, found ${dirs.length}`);
  for (const d of dirs) {
    const asDir = path.join(PLUGINS, d);
    const asManifest = path.join(PLUGINS, d, '.claude-plugin', 'plugin.json');
    assert.notStrictEqual(
      asDir, asManifest,
      `${d} resolves the same both ways, so storing the wrong one would be harmless`
    );
    assert.ok(fs.statSync(asDir).isDirectory(), `${d} is not a directory`);
    assert.ok(fs.statSync(asManifest).isFile(), `${d} has no manifest file to store`);
  }
});

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        ran ${ran}, expected ${EXPECTED_CHECKS}. If you added or removed a `
    + `check, move EXPECTED_CHECKS. If you did not, one has gone missing.`
  );
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
