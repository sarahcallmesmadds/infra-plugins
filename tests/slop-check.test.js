#!/usr/bin/env node
// Regression tests for the slop-check detectors.
//
// Run: node tests/slop-check.test.js
//
// The rows that matter most are the negative ones. A detector that flags
// everything is worse than no detector, because it trains you to ignore it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const base = path.join(__dirname, '..', 'plugins', 'slop-check', 'scripts');
const { checkHard, checkAll } = require(path.join(base, 'tells.js'));
const { checkCode, checkData, checkSpec, checkTechnical, checkOverbuilt, checkOverplanned } = require(path.join(base, 'technical.js'));
const simpleSkill = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'slop-check', 'skills', 'say-it-simply', 'SKILL.md'), 'utf8');

const EM = String.fromCharCode(0x2014);
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` (got ${actual}, wanted ${expected})`}`);
}

console.log('shipped writing guidance is installer-neutral');
check('say-it-simply does not encode a woman as the default user',
  /\b(?:she|her|hers)\b/i.test(simpleSkill), false);
check('say-it-simply does not ship dated transcript findings',
  /\b20\d{2}-\d{2}-\d{2}\b|\btranscripts? (?:were |was )?(?:read|measured)\b/i.test(simpleSkill), false);

console.log('\nhard rules');
check('em dash is caught', checkHard(`a sentence ${EM} with a dash`).ok, false);
check('hyphen is not an em dash', checkHard('a plain-English compound word').ok, true);
check('three short sentences run', checkHard('Yes. It works. All done.').ok, false);
check('one short sentence is fine', checkHard('Yes. That is a perfectly ordinary longer sentence here.').ok, true);
check('generation artefact is caught', checkHard('the result oaicite follows').ok, false);
check('bullets do not count as prose', checkHard('- one\n- two\n- three').ok, true);

console.log('\nsoft prose signals need to stack');
check('one buzzword is not a verdict', checkAll('We should leverage this.').reading, 'little');
check(
  'many categories together are',
  checkAll(
    "In today's world it's important to note that teams must leverage robust, holistic, seamless " +
    'processes. This is not just a challenge, but an opportunity. Experts argue that it serves as ' +
    'a testament to modern practice, underscoring the importance of change. It depends. ' +
    'Both approaches have merit. Ultimately the choice is yours.'
  ).reading,
  'strong'
);

console.log('\ncode');
check('shipped placeholder is a hard finding',
  checkCode('const KEY = "your-api-key";').some((f) => f.hard), true);
check('bare except that passes is caught',
  checkCode('try:\n    go()\nexcept:\n    pass\n').some((f) => f.name === 'errors-silently-swallowed'), true);
check('specific exception deliberately ignored is NOT caught',
  checkCode('try:\n    go()\nexcept ValueError:\n    pass\n').some((f) => f.name === 'errors-silently-swallowed'), false);
check('empty JS catch is caught',
  checkCode('try { go(); } catch (e) {}').some((f) => f.name === 'errors-silently-swallowed'), true);

console.log('\ndata and charts');
check('percentages that miss 100 are caught',
  checkData('30% of one, 30% of two, 25% of three').some((f) => f.name === 'percentages-do-not-total-100'), true);
check('percentages that total 100 are not',
  checkData('50% of one, 30% of two, 20% of three').some((f) => f.name === 'percentages-do-not-total-100'), false);
check('default chart labels are caught',
  checkData('Series 1 plotted against Category A').some((f) => f.name === 'default-chart-labels'), true);

console.log('\nspecs');
check('options with no recommendation are caught',
  checkSpec('Option 1 is this. Option 2 is that. Option 3 is the other.')
    .some((f) => f.name === 'options-with-no-recommendation'), true);
check('options WITH a recommendation are not',
  checkSpec('Option 1 is this. Option 2 is that. I recommend option 1 because it ships sooner.')
    .some((f) => f.name === 'options-with-no-recommendation'), false);
check('identical estimates are caught',
  checkSpec('Phase one 2 weeks. Phase two 2 weeks. Phase three 2 weeks.')
    .some((f) => f.name === 'every-estimate-identical'), true);
check('a normal doubling schedule is not "all round"',
  checkSpec('Phase one 2 weeks. Phase two 4 weeks. Phase three 8 weeks.')
    .some((f) => f.name === 'estimates-all-round-numbers'), false);
check('genuinely round estimates still are',
  checkSpec('Phase one 5 weeks. Phase two 10 weeks. Phase three 15 weeks.')
    .some((f) => f.name === 'estimates-all-round-numbers'), true);

console.log('\ntaking the long way round');
check('hand-rolled stdlib is caught',
  checkOverbuilt('function isEmpty(v) { return v === null; }')
    .some((f) => f.name === 'rebuilt-what-the-language-provides'), true);
check('async with nothing to await is caught',
  checkOverbuilt('async function a() { return 1; }\nasync function b() { return 2; }\n')
    .some((f) => f.name === 'async-with-nothing-to-await'), true);
check('async that actually awaits is not',
  checkOverbuilt('async function a() { await go(); }\nasync function b() { await go(); }\n')
    .some((f) => f.name === 'async-with-nothing-to-await'), false);
// Both rows pass the switch. The second one has to: without it the check never
// runs, so the row would pass whether or not "out of scope" still silences
// anything, and it exists to test that it does.
check('a plan that names no cut line is caught',
  checkOverplanned('We will build the thing. The plan is to implement it across the team. '.repeat(12),
    { documentChecks: true }).some((f) => f.name === 'never-says-what-it-is-not-doing'), true);
check('a plan that says what it is NOT doing is not',
  checkOverplanned('We will build the thing. The plan is to implement it. Out of scope: everything else. '.repeat(12),
    { documentChecks: true }).some((f) => f.name === 'never-says-what-it-is-not-doing'), false);
check('handing back the reader their own context is caught',
  checkOverplanned('As you mentioned, this is manual. To recap, it is slow.')
    .some((f) => f.name === 'restates-what-you-already-said'), true);

// The document checks used to fire on writing that was never a document.
//
// Both of these are absence checks, and an absence is only a finding where the
// thing was expected. One qualifying word was enough to make ordinary prose
// count as a proposal, and "build" is the commonest word in writing about making
// anything. A post ran through the skill came back reporting that it named no
// owner and declared no cut line, neither of which a post has.
//
// The positive rows below matter more than the negative ones here. A guard added
// to stop a false positive is one edit away from silencing the real finding, and
// the shape it protects, a plan written entirely in the language of doing the
// work rather than in planning vocabulary, is the one a vocabulary test misses.
console.log('\nthe two absence checks are off unless the caller asks');

// Deciding in code whether a text was a plan is gone; see the block above the
// checks in technical.js. What replaces it is the caller saying so, and that is
// what these rows pin.
//
// Every "does not fire" row is paired with the same input under
// { documentChecks: true }. Alone, an absence assertion cannot tell a check that
// is correctly quiet from a check that is no longer wired up, and this suite has
// shipped exactly that: eight rows in skill-md-check passed against a hook that
// had stopped running, because all eight asserted absence. The pair is the only
// thing that makes either row mean anything.

const ASKED = { documentChecks: true };
const unowned = (t, opts) => checkSpec(t, opts).some((f) => f.name === 'no-owner-and-no-date');
const noCut = (t, opts) => checkOverplanned(t, opts).some((f) => f.name === 'never-says-what-it-is-not-doing');

const POST = 'Six months ago I stopped writing my own status updates by hand. Not because '
  + 'I got lazy, but because every update I wrote was answering a question nobody had '
  + 'asked. I would spend forty minutes explaining what I had done, and the person '
  + 'reading it wanted one thing, which was to know whether they had to do anything. '
  + 'So I changed the shape of them. Each one now opens with the action, or with a '
  + 'plain sentence saying no action is needed, and the explanation goes underneath '
  + 'where the people who want it can find it. Replies went up rather than down, '
  + 'which surprised me. What I am going to build next is a small template for it, '
  + 'because I keep rewriting the same shape by hand every week. The part I did not '
  + 'expect was how much easier the writing got once the first line had to carry the '
  + 'whole point, since there is nowhere to hide a sentence you have not thought '
  + 'through. If you write these for a living, take the last one you sent and move '
  + 'the ask to the top, then read both versions out loud and listen to which one '
  + 'sounds like it was written by somebody who knew what they wanted.';

const PLAN = '# Migration to the new billing service\n\n'
  + 'Scope covers the subscription records, the invoice generator and the dunning '
  + 'emails. Requirements are that no customer sees a gap in service and that every '
  + 'historical invoice stays retrievable at the address it already has. The timeline '
  + 'runs across three regions, each getting a week of dual running before the old '
  + 'path is switched off. Stakeholders in support get a briefing the week before '
  + 'their own region moves. Success criteria are that the error rate stays where it '
  + 'is today and that support volume does not rise above its current weekly mean. '
  + 'The reconciliation report runs nightly against both systems and lists every '
  + 'account whose totals disagree, and that report is what tells us whether a region '
  + 'is safe to cut over, so it lands before the first region moves rather than after '
  + 'it. Anything touching tax calculation is held back until the three regions are '
  + 'through, because the rules differ per region and getting one wrong is a refund '
  + 'and an apology rather than a retry.';

// The opinion post from queue entry 2026-08-18T12-37-38. It commits to nothing
// and was flagged anyway, because "we should", "we could", "approach" and
// "build" are four ordinary words that reached the threshold between them.
const OPINION_POST = 'We should stop pretending that the office is what made those teams '
  + 'work. It was not the building. It was that the people in it had worked together long '
  + 'enough to know who to ask, and nobody has found a cheap way to manufacture that. The '
  + 'approach most companies took was to recreate the surface of the thing: standing '
  + 'meetings, a channel per team, a calendar invite called Coffee. All of it reproduces '
  + 'the schedule of an office and none of it reproduces what the schedule was for. We '
  + 'could argue about whether that is fixable. I think it partly is, but not by anyone '
  + 'whose plan starts with attendance. What seemed to work, in the two places I have '
  + 'watched it work, was giving people a reason to need each other answers. Not a ritual, '
  + 'a dependency. The rest of it, the badge counts and the mandates and the carefully '
  + 'worded memos about collaboration, is a way of not saying that we do not know how to '
  + 'build trust at a distance and would rather not find out.';

// The shell script from queue entry 2026-08-18T12-37-36, whose comments use
// ordinary proposal language. Parenthesised, because `.repeat` binds to the
// second literal alone without the brackets and the fixture lands under the
// threshold, which is how a row in this file once passed against the code it was
// written to catch.
const SHELL_PROPOSAL = '#!/bin/bash\n# The plan is to rebuild the index in one pass.\n'
  + ('# We will handle the records written before the reformat separately, because\n'
    + '# their shape differs and the approach that works for the rest does not.\n').repeat(12)
  + 'set -euo pipefail\necho "starting"\n';

// Queue entry 2026-08-18T12-46-29, and the row that matters most here. A real
// migration plan, no owner, no date, and it says outright that finance ops have
// not been consulted. The word-list version returned nothing at all on it,
// purely because it is written in plain English. Silence on a true finding is
// the failure that ended the guessing, so this fixture stays whatever else moves.
const PLAIN_PLAN = 'Moving the billing records off the old ledger happens in three '
  + 'stages, and the order matters because stage two cannot start until every historical '
  + 'entry has been given a stable identifier. Stage one takes a copy of everything as it '
  + 'stands today and parks it somewhere nobody writes to. It is cheap, and it is the only '
  + 'thing standing between us and a very bad afternoon, so it happens first even though it '
  + 'produces nothing anyone can see. Stage two walks every record and gives it an '
  + 'identifier that will survive the move, roughly four hundred thousand rows. The ones '
  + 'written before the 2023 reformat carry a different shape and have to be handled '
  + 'separately, which is most of the work and nearly all of the risk. Stage three points '
  + 'the reporting jobs at the new ledger and leaves the old one readable but frozen. '
  + 'Finance ops have not been consulted on the timing of stage three, and their close '
  + 'period would be a very poor week for it. Somebody needs to have that conversation '
  + 'before a date gets written down anywhere.';

for (const [name, text] of [['a LinkedIn post', POST], ['an opinion post', OPINION_POST],
  ['a shell script', SHELL_PROPOSAL], ['a real plan', PLAIN_PLAN], ['a spec document', PLAN]]) {
  check(`${name} is not asked who owns it unless the caller asks`,
    unowned(text), false);
  check(`...and ${name} is asked once the caller does`,
    unowned(text, ASKED), true);
}

// The cut-line check has its own floor and its own escape, so it gets its own
// pass rather than being assumed to follow the owner check.
for (const [name, text] of [['a LinkedIn post', POST], ['an opinion post', OPINION_POST],
  ['a shell script', SHELL_PROPOSAL], ['a real plan', PLAIN_PLAN]]) {
  check(`${name} is not asked for a cut line unless the caller asks`,
    noCut(text), false);
  check(`...and ${name} is asked once the caller does`,
    noCut(text, ASKED), true);
}

console.log('\nonly an explicit true turns them on');
check('no options at all leaves them off',
  unowned(PLAIN_PLAN), false);
check('an empty options object leaves them off',
  unowned(PLAIN_PLAN, {}), false);
check('documentChecks false leaves them off',
  unowned(PLAIN_PLAN, { documentChecks: false }), false);
check('no options at all leaves the cut line off',
  noCut(PLAIN_PLAN), false);
check('an empty options object leaves the cut line off',
  noCut(PLAIN_PLAN, {}), false);
check('documentChecks false leaves the cut line off',
  noCut(PLAIN_PLAN, { documentChecks: false }), false);
// The six rows above are absence assertions and would all hold against a check
// that had been deleted. This is the row that says there is still something
// there to be switched off.
check('...and all six of those are off rather than gone',
  unowned(PLAIN_PLAN, ASKED) && noCut(PLAIN_PLAN, ASKED), true);

console.log('\nwhat the checks look at, once they are asked');
check('a document naming its owner is not asked again',
  unowned(`Owner: the billing team\n\n${PLAIN_PLAN}`, ASKED), false);
check('a document carrying a date is not asked either',
  unowned(`Written 2026-08-18.\n\n${PLAIN_PLAN}`, ASKED), false);
check('a document naming what it leaves out is not asked for a cut line',
  noCut(`Tax calculation is explicitly excluded.\n\n${PLAIN_PLAN}`, ASKED), false);
check('a short note is under the floor even when asked',
  unowned('A short note with no owner on it at all.', ASKED), false);
check('the floor is a length, not a judgement about the text',
  unowned(('This sentence carries no owner and no date whatsoever. ').repeat(20), ASKED), true);

// The exclusion for source code went with the guess. Asking is now the whole
// answer, so a file reached only because somebody called it a spec is treated as
// what they called it.
check('source code is not excluded once the caller has called it a spec',
  unowned(SHELL_PROPOSAL, ASKED), true);

console.log('\nthe kind label never selects the checks, only the switch does');
// `kind` selecting which groups ran is the defect recorded above checkTechnical,
// and `kind === 'spec'` quietly standing in for the switch is the obvious way to
// rebuild it. So these go through checkTechnical rather than through the two
// checks directly, because that is the boundary where it would be reintroduced.
//
// Written as four explicit values rather than as two texts agreeing with each
// other. Equality between them holds just as well when both checks are gone,
// which is a row that passes while measuring nothing, and this suite has shipped
// that mistake before.
const viaTechnical = (t, kind, opts) => {
  const r = checkTechnical(t, kind, opts);
  return [...r.hard, ...r.soft, ...r.over].some((f) => f.name === 'no-owner-and-no-date');
};
check('kind spec on its own does not turn the check on',
  viaTechnical(PLAIN_PLAN, 'spec'), false);
check('...nor does kind spec with the switch explicitly false',
  viaTechnical(PLAIN_PLAN, 'spec', { documentChecks: false }), false);
check('the switch turns it on under kind spec',
  viaTechnical(PLAIN_PLAN, 'spec', ASKED), true);
check('...and under kind code too, because the label is not the gate',
  viaTechnical(PLAIN_PLAN, 'code', ASKED), true);


console.log('\nthe two readings are separate');
{
  // Two signals is "somewhat heavier", not a verdict. Three stacks into one.
  const light = checkTechnical(
    'function isEmpty(v) { return !v; }\nfunction unique(l) { return l; }\n' +
    'async function x() { return 1; }\nasync function y() { return 2; }\n', 'code');
  check('two signals is only somewhat heavy', light.weight, 'some');

  const heavy = checkTechnical(
    'const UserFactory = {};\nconst UserManager = {};\nconst UserProvider = {};\n' +
    'const UserRegistry = {};\nfunction isEmpty(v) { return !v; }\n' +
    'async function x() { return 1; }\nasync function y() { return 2; }\n', 'code');
  check('three or more reads heavy', heavy.weight, 'strong');
  check('...but none of it reads as unreviewed', heavy.reading, 'little');
}

console.log('\nverdicts do not overreact');
check('a single hard finding is not yet strong',
  checkTechnical('const KEY = "your-api-key";', 'code').reading, 'some');

// --- regressions, all found by review rather than by use --------------------

console.log('\nevery group runs regardless of the guessed kind');
{
  // A spec holding one percentage used to be classified as "data", and its
  // spec checks never ran, so the headline signal could not fire on exactly
  // the documents most likely to contain it.
  const spec = 'Option 1 is this. Option 2 is that. Option 3 is the other. Adoption is at 40%.';
  check('options with no recommendation still fire in a doc with a percentage',
    checkTechnical(spec, 'data').hard.concat(checkTechnical(spec, 'data').soft)
      .some((f) => f.name === 'options-with-no-recommendation'), true);
  check('and in one with a markdown table',
    checkTechnical('| a | b |\n| --- | --- |\nOption 1 here. Option 2 there.', 'data')
      .soft.some((f) => f.name === 'options-with-no-recommendation'), true);
}

console.log('\nprose is not mistaken for over-commented code');
{
  const doc = Array.from({ length: 30 }, (_, i) => `# Heading ${i}\n\nSome ordinary prose.`).join('\n');
  check('markdown headings do not count as comments',
    checkTechnical(doc, 'spec').soft.some((f) => f.name === 'over-commented'), false);
}

console.log('\nprecision is read from how numbers were written');
{
  const written = 'Values: 1.50, 2.00, 3.10, 4.20, 5.30, 6.40, 7.50, 8.60, 9.70, 10.80, 11.90, 12.30';
  check('trailing zeros are not lost before measuring',
    checkData(written).some((f) => f.name === 'uniform-decimal-precision'), true);
}

console.log('\narithmetic is a hard finding');
check('percentages that do not total 100 are hard',
  checkData('30% of one, 30% of two, 25% of three').some((f) => f.name === 'percentages-do-not-total-100' && f.hard), true);
// Percentages in source are widths and opacities, not shares of a whole. A
// false HARD finding costs more than a false soft one, so this must not fire.
check('percentages in CSS are not an arithmetic error',
  checkData('const s = { width: "20%", left: "30%", opacity: "40%" };\nfunction go() {}')
    .some((f) => f.name === 'percentages-do-not-total-100'), false);
check('matplotlib calls are not unlabelled charts',
  checkData('import matplotlib\ndef plot():\n    plt.xlabel("Revenue")\n    plt.ylabel("Month")')
    .some((f) => f.name === 'default-chart-labels'), false);
check('...but a real chart with default labels still flags',
  checkData('The chart plots Series 1 against Category A over the quarter.')
    .some((f) => f.name === 'default-chart-labels'), true);

console.log('\nconfig escape hatches work');
check('choppyRunLimit 0 disables the rule rather than flagging everything',
  checkHard('Yes. It works. All done.', { choppyRunLimit: 0 }).ok, true);
check('choppyRunLimit 0 does not disable the em dash rule too',
  checkHard(`a sentence ${EM} here`, { choppyRunLimit: 0 }).ok, false);

console.log('\none word cannot trip a category on its own');
{
  const P = require(path.join(base, 'patterns.js'));
  const overlapping = P.VOCABULARY.filter((a) =>
    P.VOCABULARY.some((b) => b !== a && (a.includes(b) || b.includes(a))));
  check('no vocabulary entry contains another', overlapping.length, 0);
  check('one inflected buzzword is still only one hit',
    checkAll('This underscores the point and nothing else.').soft
      .some((f) => f.name === 'generic-vocabulary'), false);
}


console.log('\nevery finding renders a real detail');
{
  // percentages-do-not-total-100 carries only `total`, so a renderer that
  // assumed `hits` or `count` printed "undefined occurrences" on the check
  // the README tells you to trust most.
  const { execFileSync } = require('child_process');
  const os = require('os'), fsx = require('fs');
  const tmp = path.join(os.tmpdir(), 'wg-render-check.md');
  fsx.writeFileSync(tmp, 'Split: 30% one, 30% two, 25% three. Owner: nobody.\n');
  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'plugins', 'slop-check', 'scripts', 'cli.js'),
     'check', '--file', tmp, '--technical'], { encoding: 'utf8' });
  fsx.unlinkSync(tmp);
  check('no "undefined" in the rendered report', /undefined/.test(out), false);
  check('the actual total is shown', /total=85/.test(out), true);
}


console.log('\ncode checks stay off ordinary prose');
{
  const doc = '# Set up the project\n\nProse here.\n\n## Create the config\n\nMore prose.\n\n' +
              '## Get started\n\nVisit example.com for docs.\n\n## Check if it worked\n\nA final paragraph.\n';
  check('markdown headings are not comments restating code',
    checkCode(doc).some((f) => f.name === 'comments-restate-the-code'), false);
  check('"visit example.com" in prose is not a shipped placeholder',
    checkCode(doc).some((f) => f.name === 'placeholders-left-in'), false);
  check('...and the document reads clean overall', checkTechnical(doc).reading, 'little');
}
check('a real shipped placeholder in real code still flags',
  checkCode('const KEY = "your-api-key";\nfunction go() {}')
    .some((f) => f.name === 'placeholders-left-in' && f.hard), true);
check('a document full of its own leftovers still flags',
  checkSpec('Owner: TBD. Timeline: TBD. Body is lorem ipsum for now.')
    .some((f) => f.name === 'open-placeholders-in-a-finished-doc'), true);

// ---------------------------------------------------------------------------
// Config loading.
//
// The failure these guard against is silent: a config that fails to load falls
// back to defaults, and defaults returning is indistinguishable from a config
// that happens to match them. So a broken or unreadable file must never take
// the checks offline without saying so.

console.log('\nconfig loading');
{
  const os = require('os');
  const fs = require('fs');
  const cfgPath = path.join(base, 'config.js');

  // loadConfig reads from the real home directory, so the only honest way to
  // test it is to give it a different one. HOME is re-read per require because
  // the module resolves the path inside the function, not at load time.
  const realHome = os.homedir;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-cfg-'));
  fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true });

  const loadWith = (files) => {
    for (const f of fs.readdirSync(path.join(sandbox, '.claude'))) {
      fs.unlinkSync(path.join(sandbox, '.claude', f));
    }
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(sandbox, '.claude', name), body);
    }
    os.homedir = () => sandbox;
    delete require.cache[require.resolve(cfgPath)];
    const { loadConfig } = require(cfgPath);
    const out = loadConfig();
    os.homedir = realHome;
    return out;
  };

  check('no config file at all gives the working defaults',
    loadWith({}).enforce, true);

  check('a config file is honoured',
    loadWith({ 'slop-check.config.json': '{"enforce":false}' }).enforce, false);

  check('one key set does not reset the others',
    loadWith({ 'slop-check.config.json': '{"choppyRunLimit":5}' }).enforce, true);

  check('a JSON array is rejected rather than spread into settings',
    loadWith({ 'slop-check.config.json': '[1,2,3]' }).enforce, true);

  check('unparseable JSON falls back to defaults rather than disabling checks',
    loadWith({ 'slop-check.config.json': '{not json' }).enforce, true);

  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('\nhouse rules are hard, one hit is enough');
check('a banned steal phrase blocks',
  checkHard('This one is worth stealing.').ok, false);
check('go steal it blocks',
  checkHard('go steal it!!').ok, false);
check('the finding names the phrase it caught',
  checkHard('This one is worth stealing.').violations.some((v) => v.what.includes('worth stealing')), true);
check('an ordinary sentence about theft is not caught',
  checkHard('The report covers retail theft in the northeast.').ok, true);
check('discussing theft rather than inviting it is not caught',
  checkHard('Somebody could steal it from the shared folder.').ok, true);
check('being told what you already know is not a hard rule',
  checkHard('This assumes you already know the failure modes.').ok, true);

// Found by review rather than by use: the first version of this list matched
// two of the repository's own shipped documents. A hard rule blocks a whole
// reply on one hit, so anything that fires on ordinary writing is a bug, and
// the repository is the nearest supply of ordinary writing.
{
  const docs = [
    path.join(__dirname, '..', 'README.md'),
    path.join(__dirname, '..', 'plugins', 'slop-check', 'README.md'),
    path.join(__dirname, '..', 'plugins', 'guardrails', 'skills', 'undo-possible', 'SKILL.md'),
  ];
  const fsMod = require('fs');
  const offenders = docs
    .filter((f) => fsMod.existsSync(f))
    .filter((f) => checkHard(fsMod.readFileSync(f, 'utf8')).violations
      .some((v) => v.name === 'house-rule'))
    .map((f) => path.basename(path.dirname(f)) + '/' + path.basename(f));
  check(`no shipped document trips a house rule${offenders.length ? ` (${offenders.join(', ')})` : ''}`,
    offenders.length, 0);
}

console.log('\na banned phrase cannot hide behind a smart quote');
check('the straight apostrophe form is caught',
  checkHard("here's the thing, it works", { bannedPhrases: ["here's the thing"] }).ok, false);
check('the curly apostrophe form is caught by a straight-quoted rule',
  checkHard('here’s the thing, it works', { bannedPhrases: ["here's the thing"] }).ok, false);
check('and a curly-quoted rule catches the straight form',
  checkHard("here's the thing, it works", { bannedPhrases: ['here’s the thing'] }).ok, false);
check('houseRules false turns the check off',
  checkHard('This one is worth stealing.', { houseRules: false }).ok, true);
check('a configured phrase is added to the built-in list',
  checkHard('we should circle back on this', { bannedPhrases: ['circle back'] }).ok, false);
check('configuring one phrase does not drop the built-in ones',
  checkHard('This one is worth stealing.', { bannedPhrases: ['circle back'] }).ok, false);
check('a non-array bannedPhrases is ignored rather than crashing',
  checkHard('a clean sentence with nothing wrong in it', { bannedPhrases: 'circle back' }).ok, true);

console.log('\nquoting a house rule is not the same as breaking it');
// The Stop hook blocked a /pickup that printed, verbatim and in a bullet, the
// constraint forbidding the phrase. A rule quoted is a rule mentioned, not one
// used. Queue entry 2026-08-15T22-18-30-tells.
//
// Asserted on the house-rule violation by name rather than on `ok`, so a row
// cannot pass because some unrelated tell fired on the same line.
const houseRuleHit = (t, c) => checkHard(t, c).violations.some((v) => v.name === 'house-rule');
check('a quoted mention in a bullet is not a hit',
  houseRuleHit('- Never write "worth stealing" or any steal framing, in chat or as her.'), false);
check('a quoted mention in running prose is not a hit',
  houseRuleHit('The rule is that "worth stealing" is never written.'), false);
check('a phrase in a code span is not a hit',
  houseRuleHit('The list starts with `worth stealing` and three others.'), false);
check('a phrase in a fenced block is not a hit',
  houseRuleHit('```\nworth stealing\n```'), false);
check('a configured phrase is narrowed the same way',
  houseRuleHit('The rule is that "circle back" is never written.', { bannedPhrases: ['circle back'] }), false);
// The negative controls, and they are the point. Narrowing on Markdown
// structure instead of on quotation, which is the obvious repair and what the
// bug report first proposed, passes the first of these. That is the shape the
// house rules were added for on 2026-08-11: four drafts, all reported clean.
check('a plain use in a bullet is still a hit',
  houseRuleHit('- worth stealing: the three-column layout.'), true);
check('a plain use after a quoted mention is still a hit',
  houseRuleHit('She said "never say it". This one is worth stealing.'), true);
check('an unbalanced quote does not swallow the rest of the line',
  houseRuleHit('He said "hello and then worth stealing happened'), true);

console.log('\nantithesis is caught in both word orders');
const softNames = (t) => checkAll(t).soft.map((s) => s.name);
check('negation-first order still counts',
  checkAll('It is not merely a report, but a plan. This is not just talk, but action.').soft
    .some((s) => s.name === 'antithesis'), true);
// The reversed order is a known gap, withdrawn 2026-08-14 after review measured
// it carrying the category onto 16 of this repository's 41 documents. Asserted
// rather than left unsaid, so that reinstating it without an anchor fails here
// first. See queue entry 2026-08-14T18-44-05-tells.
check('the reversed order is not covered, on purpose',
  checkAll('It groups them by what they are, not what the campaign is called. It ranks by spend, not by recency.').soft
    .some((s) => s.name === 'antithesis'), false);
check('and an ordinary clarifying clause is not a tell',
  softNames('The check reads the branch tip, not the directory holding it.')
    .includes('antithesis'), false);
check('the copular form reports on a single hit',
  softNames("The output isn't a report, it's a build list.").includes('antithesis-copular'), true);
check('a plain contrast with a comma is not antithesis',
  softNames('She reviewed the draft on Tuesday, then sent it on Wednesday.').includes('antithesis'), false);

// Found by review. Every soft detector spells the apostrophe as `'?`, which
// matches a straight quote or nothing and never a curly one, so the same
// sentence pasted out of a post scored clean. Text arriving with smart quotes
// is the normal case for this tool, not the edge.
check('the copular form is caught with curly apostrophes too',
  softNames('The output isn’t a report, it’s a build list.').includes('antithesis-copular'), true);
check('and reads identically to the straight-quoted sentence',
  JSON.stringify(softNames("The output isn't a report, it's a build list.")),
  JSON.stringify(softNames('The output isn’t a report, it’s a build list.')));
check('a curly-quoted filler phrase is caught by the straight-quoted entry',
  softNames("It’s important to note that this is in today’s world of work.").includes('filler'), true);
check('folding the prose does not blind the smart-quote signal',
  softNames('One ‘a’ two ‘b’ three “c” four “d” five ‘e’ six ‘f’ in a sentence of prose.')
    .includes('typographic-quotes-throughout'), true);
check('a bare negative clause is not antithesis',
  softNames('The skill does not touch the warehouse.').includes('antithesis'), false);

// Found by review. Two patterns can read the same construction, and summing
// their counts scored one sentence as two, reaching a threshold written to
// require two separate ones. "not less noisy and more useful, but" contains
// "less noisy and more", so the second match sits inside the first.
console.log('\none construction counts once, however many patterns match it');
const antiCount = (t) =>
  (checkAll(t).soft.find((s) => s.name === 'antithesis') || {}).count || 0;
check('a nested pair of patterns does not reach the two-hit bar on one sentence',
  softNames('The result is not less noisy and more useful, but simply different.')
    .includes('antithesis'), false);
// The count is only reported once the category fires, so the merge is asserted
// through the threshold: the overlapping sentence plus one separate contrast
// reads as 2, where summing the patterns read it as 3.
check('an overlapping construction adds one, not two, to the count',
  antiCount('The result is not less noisy and more useful, but simply different. It is not a report, but a plan.'), 2);
check('two separate constructions still count twice',
  antiCount('It is not merely a report, but a plan. This is not just talk, but action.'), 2);

// Found by review. At a threshold of one there is no aggregation to absorb a
// false positive, so every shape this matches has to be the restatement and
// not merely a clause that follows a negation.
console.log('\nthe copular form is the restatement, not anything after a negation');
check('a possessive is not a restatement',
  softNames("The failure wasn't obvious at first, its cause turned up later.")
    .includes('antithesis-copular'), false);
check('"that is" opening a clause is not a restatement',
  softNames("The queue isn't empty, that is why the run stalled.")
    .includes('antithesis-copular'), false);
check('"this is" opening a clause is not a restatement',
  softNames("The build wasn't broken by the patch, this is a known flake.")
    .includes('antithesis-copular'), false);
check('nor is "that is" on the uncontracted pattern',
  softNames('The answer is not simple, that is clear enough.')
    .includes('antithesis-copular'), false);
check('nor is "this is" on the uncontracted pattern',
  softNames('The runs are not identical, this is expected.')
    .includes('antithesis-copular'), false);
check('but the contracted "that\'s" is kept',
  softNames("It isn't a bug, that's a feature.").includes('antithesis-copular'), true);
check('and "is not X, it is Y" still reports, which this repository writes',
  softNames('It is not context that might be useful, it is the thing the work has to comply with.')
    .includes('antithesis-copular'), true);

// --- the message the Stop hook actually sends back ---------------------------
//
// Found by review. remedyFor interpolated the house-rule violation's `what`
// into its own parenthetical, and `what` is already a whole sentence that the
// opening line prints. The writer was handed "phrases ruled out for this
// author (worth stealing)" twice in one message, the second time nested inside
// brackets. Asserted against the bytes the hook writes rather than against
// remedyFor, because the doubling was only visible once both halves were
// joined, which is the same reason bash-guard.test.js spawns its hook.

console.log('\nthe rewrite instruction the Stop hook sends back');

const STYLE_HOOK = path.join(__dirname, '..', 'plugins', 'slop-check', 'hooks', 'style-lint.js');

// A transcript holding one assistant turn, which is what the hook walks back to.
function runStyleHook(assistantText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-style-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: assistantText }] },
  }) + '\n');
  const stdout = execFileSync(process.execPath, [STYLE_HOOK], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false }),
    encoding: 'utf8',
    env: { ...process.env, HOME: dir },
  });
  return stdout.trim() ? JSON.parse(stdout).reason : '';
}

const houseRuleMessage = runStyleHook('This one is worth stealing.');

check('a banned phrase is blocked at all',
  houseRuleMessage.includes('phrases ruled out for this author'), true);
check('and the phrase itself is named once, not twice',
  houseRuleMessage.split('worth stealing').length - 1, 1);
check('the remedy carries no nested parenthetical',
  /ruled out \(phrases ruled out/.test(houseRuleMessage), false);
check('and still says what to do about it',
  houseRuleMessage.includes('Say the thing plainly instead'), true);

// The other remedies never restated `what`, which is the shape this now matches.
const emDashMessage = runStyleHook(`a sentence ${EM} with a dash in it`);
check('the em dash remedy names the fault once',
  emDashMessage.split('em dash').length - 1 <= 2, true);

// --- the hook lints the turn that just ended ---------------------------------
//
// The hook used to walk the transcript for the finished turn. The transcript is
// written a beat behind the conversation, so at Stop time the finished turn is
// usually not in the file and the walk landed on the message before it. Across
// 116 real blocks in the saved sessions, 70 named the wrong text: a clean turn
// was stopped and told to fix the previous turn's em dashes, while the turn
// that actually broke the rule was never checked.
//
// The event carries the finished turn as `last_assistant_message`, so that is
// what gets linted now. The rows below are written so that the second one fails
// against the old walk, which was confirmed by running them against it before
// the fix went in.

console.log('\nthe Stop hook lints the turn that just ended');

// Payload fields and transcript contents are set independently on purpose. The
// bug only shows when the two disagree, which is every real firing.
function runStyleHookOn({ ended, transcriptTurns = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-ended-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, transcriptTurns.map((text) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })).join('\n') + (transcriptTurns.length ? '\n' : ''));

  const payload = { transcript_path: transcript, stop_hook_active: false };
  if (ended !== undefined) payload.last_assistant_message = ended;

  const stdout = execFileSync(process.execPath, [STYLE_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: dir },
  });
  return stdout.trim() ? JSON.parse(stdout).reason : '';
}

const clean = 'This sentence is written plainly and holds nothing to complain about.';

check('the finished turn is what gets linted, not the transcript',
  runStyleHookOn({ ended: `one ${EM} dash`, transcriptTurns: [clean] })
    .includes('1 em dash'), true);

// The bug itself, and the fixture has to be the real situation to catch it.
// The finished turn is absent from the transcript, because that is the whole
// point: at Stop time it has not been written yet. Writing it into the file as
// the last entry makes the old walk find it and the row passes against the very
// code it is meant to fail against.
check('a clean turn is not blocked for an earlier turn\'s em dashes',
  runStyleHookOn({
    ended: clean,
    transcriptTurns: [`a ${EM} b ${EM} c ${EM} d`],
  }), '');

check('the count named is the count in the turn that ended',
  runStyleHookOn({
    ended: `two ${EM} dashes ${EM} here`,
    transcriptTurns: [`a ${EM} b ${EM} c ${EM} d ${EM} e ${EM} f`],
  }).includes('2 em dashes'), true);

// The fallback. `last_assistant_message` is captured in the Stop fixture and
// checked by hook-event-shape.test.js, but nobody published it as a contract,
// so its absence has to degrade to the old behaviour rather than to silence.
check('with the field absent the transcript is still read',
  runStyleHookOn({ transcriptTurns: [clean, `a ${EM} dash`] })
    .includes('1 em dash'), true);

// Absent and empty are different answers to different questions, and the first
// version of this file got it wrong in a way that reopened the bug. An empty
// field is a turn that ended without prose, a turn whose last act was a tool
// call being the ordinary case. Falling back there lints an older message and
// calls it the response just written, which is the whole fault.
check('a turn that ended without prose is not linted against an older one',
  runStyleHookOn({ ended: '', transcriptTurns: [`a ${EM} b ${EM} c ${EM} d`] }), '');

check('whitespace alone counts as ended without prose, not as absent',
  runStyleHookOn({ ended: '   ', transcriptTurns: [`a ${EM} b ${EM} c ${EM} d`] }), '');

check('nothing readable anywhere stays silent rather than throwing',
  runStyleHookOn({ transcriptTurns: [] }), '');

// --- whose document is this ---------------------------------------------------
//
// Found by review. checkAll delegates to checkHard, so the house-rule check
// runs over whatever the skill was pointed at, and the skill is pointed at
// other people's documents as often as at your own. A document somebody else
// wrote came back reading "Hard rules: BROKEN. phrases ruled out for this
// author", which is the tier with no defence, about an author who never agreed
// to the rule. The detection is kept and the framing is fixed, so these check
// the report's wording and the enforcement paths separately.

console.log('\nhouse rules are reported as yours, not as the document being broken');

const CLI = path.join(__dirname, '..', 'plugins', 'slop-check', 'scripts', 'cli.js');

function runCli(args, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-cli-'));
  return execFileSync(process.execPath, [CLI, 'check', ...args], {
    input: text,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir },
  });
}

// execFileSync throws on a non-zero exit, so a row expecting a failing run has to
// catch it or the whole suite dies with a stack trace instead of naming the row.
function runCliAllowingFailure(args, text) {
  try {
    return runCli(args, text);
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

const BANNED = 'This approach is worth stealing. The team shipped it last week and it held up well.';
const report = runCli(['--prose'], BANNED);

check('a banned phrase does not make the hard tier read BROKEN',
  report.includes('Hard rules: BROKEN'), false);
check('it is reported under a heading that says whose rule it is',
  report.includes('Your own standing phrase rules'), true);
check('and names the phrase without the sentence about "this author"',
  report.includes('\n  worth stealing'), true);
check('the report no longer calls the writer "this author"',
  report.includes('phrases ruled out for this author'), false);

// A genuine hard rule is still a hard rule, so the tier did not lose its teeth.
const withEmDash = runCli(['--prose'], `a sentence ${EM} with a dash in it, written out at length`);
check('a real hard rule still reads BROKEN',
  withEmDash.includes('Hard rules: BROKEN'), true);

// The two enforcement paths are unchanged, and they are the ones where the
// author genuinely is the person whose rules these are.
check('--hard-only still reports the house rule',
  runCli(['--hard-only'], BANNED).includes('phrases ruled out for this author'), true);

// SKILL.md: "By default it runs both halves. Whichever half does not apply
// reports nothing, which is why one command handles a LinkedIn draft and a pull
// request equally." That was a promise the code did not keep. The technical half
// printed unconditionally, so a post came back with a heading calling it a spec,
// a verdict on whether it had been reviewed and a closing explanation of what
// the check does not claim.
//
// Silence here is conditional on there being no findings, never on the guessed
// kind. `checkTechnical` runs every group over every input on purpose, and the
// comment in it records what happened the last time a kind decided what ran.
console.log('\nthe half that does not apply prints nothing');
{
  const postReport = runCli([], POST);
  check('a post gets no technical block',
    postReport.includes('Technical check'), false);
  check('and no separator rule above the one it would have had',
    postReport.includes('-'.repeat(60)), false);
  check('the prose half is still reported in full',
    postReport.includes('Little sign of machine-writing habits'), true);

  // A spec on the default path no longer gets asked who owns it, and that is the
  // change rather than a regression: the two absence checks are the caller's to
  // request. The rows below pin the default silence and the asked-for finding
  // together, so neither can quietly become the other.
  const planReport = runCli([], PLAN);
  check('a spec is not asked who owns it on the default path',
    planReport.includes('no-owner-and-no-date'), false);
  check('the default run says the absence checks did not run',
    planReport.includes('Two checks did not run'), true);
  check('and says which two, so it cannot read as disclaiming the whole block',
    planReport.includes('names an owner and a date') && planReport.includes('what it is not doing'), true);
  check('and names the flag that runs them',
    planReport.includes('--technical spec'), true);
  check('the reminder is printed for a post as well, not just for a document',
    postReport.includes('--technical spec'), true);

  const askedReport = runCli(['--technical', 'spec'], PLAN);
  check('asking for the spec check gets the finding',
    askedReport.includes('no-owner-and-no-date'), true);
  check('a bare --technical does not turn them on',
    runCli(['--technical'], PLAN).includes('no-owner-and-no-date'), false);
  check('--technical code does not either',
    runCli(['--technical', 'code'], PLAN).includes('no-owner-and-no-date'), false);
  check('--technical data does not either',
    runCli(['--technical', 'data'], PLAN).includes('no-owner-and-no-date'), false);

  // `--technical=spec` matched nothing and fell through to the default path,
  // which then printed the line telling the reader to run --technical spec. The
  // rows below pin both spellings of every form, because the failure was silent:
  // the report looked like an answer to a question that had never been asked.
  check('--technical=spec turns them on like the spaced form',
    runCli(['--technical=spec'], PLAN).includes('no-owner-and-no-date'), true);
  check('--technical=code does not',
    runCli(['--technical=code'], PLAN).includes('no-owner-and-no-date'), false);
  check('--technical=spec does not fall through to the default path',
    runCli(['--technical=spec'], PLAN).includes('Two checks did not run'), false);
  // A flag is not its own value. Written first as `--technical --prose` asserting
  // no finding, which measured nothing: the swallowed value fails the `spec`
  // comparison either way, so the row passed against the unguarded code too.
  // `--file` is where the swallow is observable, because the value is opened.
  check('a following flag is not swallowed as a value',
    runCliAllowingFailure(['--file', '--prose'], PLAN).includes('cannot read --prose'), false);
  // "Hard rules" appears on a default run too, so asserting it proved nothing
  // about the file being rejected. The prose branch exits before the reminder,
  // and the reminder is on every default run, so its absence is what separates
  // them.
  check('...and it is not the default path, which would have printed the reminder',
    runCliAllowingFailure(['--file', '--prose'], PLAN).includes('Two checks did not run'), false);
  check('...having actually checked the text it was given',
    runCliAllowingFailure(['--file', '--prose'], PLAN).includes('Hard rules'), true);

  // An unrecognised kind is refused, not guessed. Every one of these matched the
  // flag and then failed the kind comparison in silence before this.
  for (const bad of ['--technical=', '--technical==spec', '--technical=bogus']) {
    check(`${bad} is refused rather than silently ignored`,
      runCliAllowingFailure([bad], PLAN).includes('unrecognised kind for --technical'), true);
    check(`...and ${bad} prints neither half of the report`,
      runCliAllowingFailure([bad], PLAN).includes('Hard rules')
        || runCliAllowingFailure([bad], PLAN).includes('Softer tells')
        || runCliAllowingFailure([bad], PLAN).includes('Technical check'), false);
  }
  check('a bare --technical is still valid, not a typo',
    runCli(['--technical'], PLAN).includes('Technical check'), true);

  // Asking for a half and getting silence is its own failure. The caller asked.
  check('an explicit --technical prints even with nothing to say',
    runCli(['--technical'], POST).includes('Technical check'), true);
  check('...and says so rather than printing an empty heading',
    runCli(['--technical'], POST).includes('Nothing else worth flagging'), true);
}

console.log(`\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
