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
const { checkCode, checkData, checkSpec, checkTechnical, checkOverbuilt, checkOverplanned, markerDensity, codeShare } = require(path.join(base, 'technical.js'));
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
check('a plan that names no cut line is caught',
  checkOverplanned('We will build the thing. The plan is to implement it across the team. '.repeat(12))
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), true);
check('a plan that says what it is NOT doing is not',
  checkOverplanned('We will build the thing. The plan is to implement it. Out of scope: everything else. '.repeat(12))
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), false);
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
console.log('\ndocument checks stay off writing that is not a document');
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
check('a post is longer than the threshold',
  POST.length > 800, true);
check('a post is not reported as an unowned document',
  checkSpec(POST).some((f) => f.name === 'no-owner-and-no-date'), false);
check('a post is not reported as a proposal with no cut line',
  checkOverplanned(POST).some((f) => f.name === 'never-says-what-it-is-not-doing'), false);
// Parenthesised on purpose. Written without the brackets, `.repeat` binds to the
// second literal alone, and the result lands at 468 characters, under the 700 the
// check requires. The row then passed against the code it was written to catch,
// and passed for a reason that had nothing to do with the fix.
const ONE_MARKER = ('I want to build something better than the thing we have now, and I '
  + 'keep coming back to why that turns out to be harder than it sounds. ').repeat(6);
check('the one-marker fixture is past the length threshold',
  ONE_MARKER.length > 700, true);
check('one mention of building something is not a proposal',
  checkOverplanned(ONE_MARKER).some((f) => f.name === 'never-says-what-it-is-not-doing'), false);

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
check('a plan document is still asked who owns it',
  checkSpec(PLAN).some((f) => f.name === 'no-owner-and-no-date'), true);
check('a proposal written without planning vocabulary is still asked too',
  checkSpec('We will build the thing. The plan is to implement it across the team. '.repeat(12))
    .some((f) => f.name === 'no-owner-and-no-date'), true);
check('a document that names its owner is not asked twice',
  checkSpec(`Owner: the billing team\n\n${PLAN}`)
    .some((f) => f.name === 'no-owner-and-no-date'), false);

// Devin review round 1 on #137. Counting two distinct markers was wrong in both
// directions, and these rows pin both directions.
//
// Too quiet: a document that leans on one marker over and over is proposing work
// as plainly as one that uses two different words once each. Counting distinct
// words cannot see repetition at all.
//
// Too loud: "build" and "approach" are two distinct markers and both turn up in
// any ordinary essay about product work, so two was still enough to flag writing
// that proposes nothing. That one was not in the review. It was found by
// measuring marker density across the fixtures while choosing the threshold the
// review's first two findings needed.
console.log('\none marker leaned on is a plan; two ordinary words are not');
const REPEATED_PROPOSAL = 'We will fix the billing service. '.repeat(50);
check('the repeated-proposal fixture is long enough to reach both checks',
  REPEATED_PROPOSAL.length > 800, true);
check('a document that says "we will" fifty times is asked who owns it',
  checkSpec(REPEATED_PROPOSAL).some((f) => f.name === 'no-owner-and-no-date'), true);
check('...and is asked what it is not doing',
  checkOverplanned(REPEATED_PROPOSAL)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), true);

const REPEATED_SCOPE = 'Scope is limited. '.repeat(60);
check('the repeated-scope fixture is long enough',
  REPEATED_SCOPE.length > 800, true);
check('a scope statement repeated sixty times is asked who owns it',
  checkSpec(REPEATED_SCOPE).some((f) => f.name === 'no-owner-and-no-date'), true);

const PRODUCT_ESSAY = ('I spent four years building the wrong thing before I understood why. '
  + 'Every time we shipped, I would build the feature somebody asked for loudest, and '
  + 'the approach felt responsive at the time. What I could not see was that each build '
  + 'made the next one harder, because none of them shared a shape. The team that took '
  + 'over stopped building for two months and wrote down what the product refused to do. '
  + 'That list was shorter than any roadmap I had made and it decided more. If I were '
  + 'starting again I would build that list first and treat the approach as the thing to '
  + 'get right rather than the speed. ').repeat(2);
check('the essay fixture is long enough to reach both checks',
  PRODUCT_ESSAY.length > 800, true);
check('an essay using "build" and "approach" is not an unowned plan',
  checkSpec(PRODUCT_ESSAY).some((f) => f.name === 'no-owner-and-no-date'), false);
check('...and is not a proposal with no cut line',
  checkOverplanned(PRODUCT_ESSAY)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), false);

// Singular and plural of one word are one marker. Without normalising, "scope"
// and "scopes" counted as two and carried a document over the threshold on the
// strength of an inflection rather than on anything it said.
const SPARSE_INFLECTION = 'The scope of the change is small. '
  + ('Everything else here is ordinary narrative prose that runs on at some length '
    + 'without proposing anything, because the point of it is to be long rather than '
    + 'to be a plan. ').repeat(6)
  + 'Scopes of this kind are common. ';
check('the inflection fixture is long enough, and thin on markers',
  SPARSE_INFLECTION.length > 800, true);
check('"scope" and "scopes" are one marker, not two',
  checkSpec(SPARSE_INFLECTION).some((f) => f.name === 'no-owner-and-no-date'), false);

// Devin review round 2 on #137. Three of these are what the round found, and each
// one is a case no count of distinct words could have got right.
//
// The proposal below is the one that broke counting for good. It uses two markers,
// "we will" and "build", at a low density, which is exactly the shape of the essay
// fixture above that must stay quiet. Two inputs, same marker count, opposite
// answers, so the count is not the thing that separates them. What separates them
// is that "we will" commits somebody and "build" only describes work.
console.log('\ncommitment language separates a proposal from a retrospective');
const SHORT_PLAN = 'We will build the billing service. '
  + 'The first phase is to build the data model and the second is to build the API. '
  + 'We will write tests as we build. We will also build a small admin panel. '
  + 'The work will take several weeks and we will review it daily. '
  + ('This paragraph carries ordinary context that is not planning language itself, '
    + 'so the marker count stays low while the document passes the length gate. ').repeat(8);
check('the short-plan fixture is long enough to reach both checks',
  SHORT_PLAN.length > 800, true);
check('a plain proposal using only "we will" and "build" is asked who owns it',
  checkSpec(SHORT_PLAN).some((f) => f.name === 'no-owner-and-no-date'), true);
check('...and is asked what it is not doing',
  checkOverplanned(SHORT_PLAN)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), true);
check('the essay it shares a marker count with still stays quiet',
  checkSpec(PRODUCT_ESSAY).some((f) => f.name === 'no-owner-and-no-date'), false);

// A list is not a document. Density alone said this was the densest plan it had
// ever seen, which is what a ceiling with no floor does: 150 headings reading
// "Scope" run one marker per 6 characters, and prose cannot do that.
const SCOPE_LIST = Array.from({ length: 150 }, () => 'Scope').join('\n');
check('the heading-list fixture is long enough to reach the check',
  SCOPE_LIST.length > 800, true);
check('a list of 150 headings is not an unowned document',
  checkSpec(SCOPE_LIST).some((f) => f.name === 'no-owner-and-no-date'), false);

// Source code, which checkSpec has always excluded and checkOverplanned did not.
// The same question about the same kind of document, answered about documents by
// only one of the two.
const CODE_WITH_COMMENTS = 'function go() {\n'
  + Array.from({ length: 60 }, (_, i) => `  // we will handle step ${i}`).join('\n')
  + '\n}';
check('the commented-code fixture is long enough to reach the check',
  CODE_WITH_COMMENTS.length > 700, true);
check('code carrying sixty "we will" comments is not a proposal',
  checkOverplanned(CODE_WITH_COMMENTS)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), false);
check('...and the same text is not reported as an unowned document either',
  checkSpec(CODE_WITH_COMMENTS).some((f) => f.name === 'no-owner-and-no-date'), false);

// Devin review round 3 on #137.
//
// "We should" is not a commitment, and putting it with "we will" brought the
// original bug back for a fourth time: an opinion post opening "We should stop
// pretending" and saying "build" once further down scored three and was reported
// as an unowned plan. The first row is the reviewer's own input and the second is
// a realistic post, kept separate because one is the reported case and the other
// is the shape it would actually arrive in.
console.log('\n"we should" is an opinion, not a commitment');
const SHOULD_POST = ('We should not overstate how much a small feature can matter. '
  + 'People often say they want to build something, but the work is always harder. ').repeat(12);
check('the reviewer fixture clears both gates',
  SHOULD_POST.length > 800, true);
check('"we should" plus "build" is not an unowned plan',
  checkSpec(SHOULD_POST).some((f) => f.name === 'no-owner-and-no-date'), false);
check('...and is not a proposal with no cut line',
  checkOverplanned(SHOULD_POST)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), false);

const OPINION_POST = 'We should stop pretending that the office is what made those teams work. '
  + ('I have watched the same argument play out in four companies now, and the part nobody '
    + 'wants to say out loud is that the good years had nothing to do with the building. They '
    + 'had to do with who was in the room and whether anybody felt able to disagree with them. '
    + 'You cannot build that back by insisting on attendance, and the attempt tends to drive '
    + 'out exactly the people who made it work in the first place. ').repeat(2);
check('the opinion-post fixture clears both gates',
  OPINION_POST.length > 800, true);
check('an opinion post is not an unowned plan',
  checkSpec(OPINION_POST).some((f) => f.name === 'no-owner-and-no-date'), false);
check('...and "we will" is still a commitment where it appears',
  checkSpec(`We will ${OPINION_POST.slice(3)}`)
    .some((f) => f.name === 'no-owner-and-no-date'), true);

// A document that shows a code sample is still a document. One pasted line used to
// make the whole thing source and silence both checks, while a real source file
// must keep being skipped. Only a proportion separates those two.
console.log('\na document showing code is still a document');
const PROPOSAL = 'We will build the thing. The plan is to implement it across the team. '.repeat(12);
check('the proposal fires before any code is added to it',
  checkSpec(PROPOSAL).some((f) => f.name === 'no-owner-and-no-date'), true);
check('one pasted code line does not turn a proposal into source',
  checkSpec(`${PROPOSAL}\nfunction go() { return 1; }\n`)
    .some((f) => f.name === 'no-owner-and-no-date'), true);
check('...nor does a fenced block',
  checkSpec(`${PROPOSAL}\n\`\`\`\nfunction go() { return 1; }\nconst x = 2;\n\`\`\`\n`)
    .some((f) => f.name === 'no-owner-and-no-date'), true);
check('...and the cut-line check agrees with the owner check',
  checkOverplanned(`${PROPOSAL}\nfunction go() { return 1; }\n`)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), true);

// Both bounds of that proportion, pinned against real files in this repository
// rather than against invented ones. The tighter side is source, so a suite that
// grows enough prose to drop under the threshold fails here rather than quietly
// becoming a document that gets asked who owns it.
const THIS_SUITE = fs.readFileSync(__filename, 'utf8');
const TECHNICAL_JS = fs.readFileSync(path.join(base, 'technical.js'), 'utf8');
check('this suite is still read as source, not as a document',
  codeShare(THIS_SUITE) > 0.30, true);
check('so is the file it tests',
  codeShare(TECHNICAL_JS) > 0.30, true);
check('and neither is reported as an unowned document',
  checkSpec(THIS_SUITE).concat(checkSpec(TECHNICAL_JS))
    .some((f) => f.name === 'no-owner-and-no-date'), false);
check('a proposal carrying one code line is under the source threshold',
  codeShare(`${PROPOSAL}\nfunction go() { return 1; }\n`) < 0.30, true);

// Codex review on #137, run as a second opinion before a fourth Devin round.
// It found the one thing three Devin rounds had not: counting a line as code only
// when it declares, comments or braces misses a source file built from a string
// table, and the same input on main produced one finding where this produced two.
console.log('\nsource is recognised by how its lines end, not by what they hold');
const STRING_TABLE = 'const STEPS = [\n'
  + Array.from({ length: 40 },
    (_, i) => `  "We will build step ${i} and the plan is to implement it across the team",`).join('\n')
  + '\n];\n\nmodule.exports = { STEPS };\n';
check('a source file built from a string table is read as source',
  codeShare(STRING_TABLE) > 0.30, true);
check('...so its planning language is not an unowned document',
  checkSpec(STRING_TABLE).some((f) => f.name === 'no-owner-and-no-date'), false);
check('...and not a proposal with no cut line either',
  checkOverplanned(STRING_TABLE)
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), false);

// The other direction, which the first fix for the above would have broken.
// Hard-wrapped prose ends line after line with a comma, so counting a bare comma
// as code turned a wrapped plan carrying a code sample into source.
const WRAPPED_PLAN = ('We will build the migration in three passes, one region at a time,\n'
  + 'so that any problem is cheap to unwind. The plan is to run the smallest\n'
  + 'region first, and to keep both systems live for a week either side of it,\n'
  + 'because a reconciliation report is the only thing that tells us whether a\n'
  + 'region is safe to cut over at all.\n').repeat(4);
const WRAPPED_WITH_CODE = `${WRAPPED_PLAN}\n\`\`\`\nfunction go() { return 1; }\n\`\`\`\n`;
check('the wrapped-plan fixture clears the length gate',
  WRAPPED_WITH_CODE.length > 800, true);
check('a hard-wrapped plan showing a code sample is still a document',
  codeShare(WRAPPED_WITH_CODE) < 0.30, true);
check('...and is still asked who owns it',
  checkSpec(WRAPPED_WITH_CODE).some((f) => f.name === 'no-owner-and-no-date'), true);

// The numbers written into the threshold comments, recomputed here. Two review
// rounds each caught a figure in a comment that no longer matched the fixture it
// came from, so the figures are asserted rather than noted.
console.log('\nthe documented thresholds match the fixtures they came from');
check('the densest fixture that must stay quiet is above the density ceiling',
  markerDensity(PRODUCT_ESSAY).proposal > 60, true);
check('...and it is the essay, at one marker per 119 characters',
  Math.round(markerDensity(PRODUCT_ESSAY).proposal), 119);
check('the repeated proposal is inside the band, at one per 33',
  Math.round(markerDensity(REPEATED_PROPOSAL).proposal), 33);
check('the repeated scope statement is inside the band, at one per 18',
  Math.round(markerDensity(REPEATED_SCOPE).planning), 18);
check('the heading list is below the floor, at one per 6',
  Math.round(markerDensity(SCOPE_LIST).planning), 6);

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

  const planReport = runCli([], PLAN);
  check('a document with real findings still gets its technical block',
    planReport.includes('Technical check'), true);
  check('and the finding itself is still named',
    planReport.includes('no-owner-and-no-date'), true);

  // Asking for a half and getting silence is its own failure. The caller asked.
  check('an explicit --technical prints even with nothing to say',
    runCli(['--technical'], POST).includes('Technical check'), true);
  check('...and says so rather than printing an empty heading',
    runCli(['--technical'], POST).includes('Nothing else worth flagging'), true);
}

console.log(`\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
