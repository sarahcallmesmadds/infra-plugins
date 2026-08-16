'use strict';

// Two wordings of one constraint, and telling them apart from two real ones.
//
// The wrap step forbids a value that changes between sessions inside a
// constraint. That rule is prose, so nothing caught a counter going back in.
// One rule about where handoffs file reached five numbered wordings before
// anyone noticed, and the person who noticed was whoever read a pickup.
//
// The hard half is not detection, it is restraint. Constraints carry numbers
// for good reasons, so the checks below spend most of their weight on what must
// NOT warn. A warning that fires on a colour code is ignored inside a day, and
// then it is also ignoring the real case.

const assert = require('assert');
const path = require('path');

const h = require(path.join(__dirname, '..', 'plugins', 'session', 'scripts', 'handoffs.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

const c = (text, from = 'a-handoff') => ({ text, from });

const CENTRAL = 'Handoffs file centrally in `~/.planning/handoffs/`, never at a repo root, whatever `cli.js target` proposes.';

check('two wordings of one rule are reported as a pair', () => {
  const pairs = h.nearDuplicateConstraints([
    c(`${CENTRAL} Seventh session running.`, 'older'),
    c(`${CENTRAL} Tenth session running.`, 'newer'),
  ]);
  assert.strictEqual(pairs.length, 1, 'the counter pair that started all of this is not reported');
});

check('the report names only what differs', () => {
  // Both texts are nearly identical, so printing them in full is the least
  // readable way to show a one-word difference.
  const [pair] = h.nearDuplicateConstraints([
    c(`${CENTRAL} Seventh session running.`, 'older'),
    c(`${CENTRAL} Tenth session running.`, 'newer'),
  ]);
  assert.strictEqual(pair.a.differs, 'Seventh', `differing span was ${JSON.stringify(pair.a.differs)}`);
  assert.strictEqual(pair.b.differs, 'Tenth', `differing span was ${JSON.stringify(pair.b.differs)}`);
  assert.strictEqual(pair.a.from, 'older', 'the pair does not say which handoff each wording came from');
  assert.strictEqual(pair.b.from, 'newer', 'the pair does not say which handoff each wording came from');
});

check('a difference in the middle is caught, not just at the end', () => {
  const pairs = h.nearDuplicateConstraints([
    c('Never deploy to production without approval. Staging only, and never alias the domain.'),
    c('Never deploy to staging without approval. Staging only, and never alias the domain.'),
  ]);
  assert.strictEqual(pairs.length, 1, 'a differing span in the middle of the text is missed');
});

check('a date inside a constraint does not warn on its own', () => {
  // The single-constraint case. Nothing to compare against, so nothing to say,
  // however many digits it carries.
  const pairs = h.nearDuplicateConstraints([
    c('Never write "worth stealing". Ruled a violation rather than a preference on 2026-08-11.'),
  ]);
  assert.deepStrictEqual(pairs, [], 'a lone constraint warns about itself');
});

check('constraints that legitimately carry numbers do not warn', () => {
  // The reason a digit rule is the wrong implementation. Every one of these is
  // real and none of them is a duplicate of another.
  const pairs = h.nearDuplicateConstraints([
    c('Depth comes from layered shadows on one continuous `#F0ECE6` canvas.'),
    c('`docs/context/` in the always-allow repo holds 22 files of ground truth.'),
    c('Ruled a violation rather than a preference on 2026-08-11.'),
    c('One atomic commit per Devin review round, never a point fix per finding.'),
  ]);
  assert.deepStrictEqual(pairs, [], 'the check fires on numbers rather than on near-identical pairs');
});

check('two genuinely different constraints do not warn', () => {
  const pairs = h.nearDuplicateConstraints([
    c('Never deploy the real production site without explicit approval. Staging only.'),
    c('Business records live in the shared Google Drive, never in personal My Drive.'),
  ]);
  assert.deepStrictEqual(pairs, [], 'two unrelated constraints are called a duplicate pair');
});

check('two short constraints sharing a common opening do not warn', () => {
  // The failure mode of a ratio test with no floor: "Do not edit x." against
  // "Do not edit y." shares most of itself and is two real rules.
  const pairs = h.nearDuplicateConstraints([
    c('Do not edit `brand/motion/`.'),
    c('Do not edit `brand/logo/`.'),
  ]);
  assert.deepStrictEqual(pairs, [], 'two short rules that merely start alike are called duplicates');
});

check('an identical constraint recorded twice is not a near duplicate', () => {
  // Same text is the same constraint, which is the normal way one is carried
  // forward. Reporting it would fire on every healthy handoff chain.
  const pairs = h.nearDuplicateConstraints([c(CENTRAL, 'older'), c(CENTRAL, 'newer')]);
  assert.deepStrictEqual(pairs, [], 'carrying a constraint forward unchanged reads as a duplicate');
});

check('a retired wording is not reported, because it is not live', () => {
  // The list handed to this function is what survived retirement. Someone who
  // tidied up properly must not be warned about the wording they retired.
  const pairs = h.nearDuplicateConstraints([c(`${CENTRAL} Tenth session running.`)]);
  assert.deepStrictEqual(pairs, [], 'a single surviving wording is reported against nothing');
});

check('an empty or one-item list is handled', () => {
  assert.deepStrictEqual(h.nearDuplicateConstraints([]), [], 'an empty list throws or reports');
  assert.deepStrictEqual(h.nearDuplicateConstraints(), [], 'no argument throws');
  assert.deepStrictEqual(h.nearDuplicateConstraints([c(CENTRAL)]), [], 'one constraint reports against itself');
});

check('a constraint with no text is skipped rather than throwing', () => {
  assert.deepStrictEqual(
    h.nearDuplicateConstraints([{ from: 'x' }, c(CENTRAL)]),
    [],
    'a malformed entry throws instead of being skipped'
  );
});

check('three wordings of one rule report every pair', () => {
  // Five were live at once on 2026-08-15. Reporting one pair and stopping would
  // leave the person fixing them thinking they were done.
  const pairs = h.nearDuplicateConstraints([
    c(`${CENTRAL} Sixth session running.`, 'a'),
    c(`${CENTRAL} Seventh session running.`, 'b'),
    c(`${CENTRAL} Tenth session running.`, 'c'),
  ]);
  assert.strictEqual(pairs.length, 3, 'not every pair among three wordings is reported');
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
