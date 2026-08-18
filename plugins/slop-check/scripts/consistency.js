// Three ways a file contradicts itself, and nothing outside the file is needed
// to see any of them.
//
// The shared idea: these are not matters of taste. A count that disagrees with
// the list under it is wrong, and stays wrong however well the sentence reads.
// That is what makes them checkable, and it is also why they are worth checking
// mechanically rather than by reading carefully, which is what has been failing.
//
//   staleCounts       a number in prose disagreeing with the list beside it
//   survivingText     text replaced in one place and left standing in another
//   brokenOwnRule     a file that states a rule and then breaks it further down
//
// `staleCounts` moved here from tests/stated-counts.test.js, where it had been
// through seven rounds of fixes. Every comment in it describes a real false
// positive that reached the suite, so they are load-bearing and were carried
// across unchanged. The test still owns the corpus sweep; this file owns the
// logic, and both now run the same code. Two implementations of this check
// would drift, and the subtle one would be the one nobody was reading.

'use strict';

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// Nouns that name the list itself rather than something else in the sentence.
//
// An allowlist, arrived at by running the loose version over the repository and
// reading all eight things it caught. Every one was wrong: "three plugins here
// ship a cli" above an unrelated list, "up to 20 rows" above a six-row example,
// and "Exit 1 is a real error" read as a count of the word "is". A rule that
// fires eight times and is wrong eight times gets switched off by whoever sees
// it, so the loose version is worse than nothing.
//
// These are the words used when a sentence is announcing what the list under it
// contains. The original bug said "it checks four things" above a table of five.
// Nouns describing the width of a table rather than its length are not here.
// `columns` and `fields` were, and a table is only ever counted by its rows, so
// "The report has three columns:" above a three-column table of six rows was
// reported as a contradiction. The noun decided whether to compare and never
// what to compare against.
//
// Teaching the table branch to count columns for those two was the alternative.
// It was not taken. Seven rounds on this file have all been the same shape, a
// guess about which prose belongs to which list going wrong, and every one was
// fixed by checking less. Adding a second thing to measure adds a second thing
// to get wrong, against prose that is rare.
const LIST_NOUNS = new Set([
  'things', 'checks', 'steps', 'rules', 'cases', 'reasons', 'options',
  'states', 'statuses', 'modes', 'kinds', 'phases',
  'stages', 'conditions', 'requirements', 'outcomes', 'variants',
]);

// Whether each line sits inside a code example.
//
// The walk from a sentence to its list already stopped at a fence, which
// covered a fence opening between the two and nothing else. It did not know
// whether the sentence itself was inside one. So a document showing an example
// of a stale count was read as containing one, and the most likely author of
// such a document is whoever writes up this check.
//
// Two shapes. A fenced block, and an indented one: four or more spaces on a
// line that follows a blank. The indent rule wants the blank, because
// continuation prose inside a numbered step is indented too and is ordinary
// text.
function exampleLines(lines) {
  const inExample = new Array(lines.length).fill(false);
  let fenced = false;
  let indented = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inExample[i] = true;
      fenced = !fenced;
      continue;
    }
    if (fenced) { inExample[i] = true; continue; }

    if (line.trim() === '') { indented = false; inExample[i] = false; continue; }
    const lead = line.match(/^ */)[0].length;
    const afterBlank = i > 0 && lines[i - 1].trim() === '';
    if (lead >= 4 && (afterBlank || indented)) indented = true;
    else if (lead < 4) indented = false;
    inExample[i] = indented;
  }
  return inExample;
}

// The list that begins at `from`, or null if there is not one. A table counts
// its body rows; a bullet or numbered list counts its top-level items, so a
// nested bullet does not inflate the total.
function listAt(lines, from, inExample = null) {
  let i = from;
  // At most one blank line. This used to skip an unbounded run, which meant
  // "directly above" was not enforced at all: a sentence and a list five blank
  // lines apart were compared to each other.
  if (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() === '') return null;
  // A list inside an example belongs to the example. This was the stated
  // intent from the start and only ever held for fenced blocks, because the
  // walk stopped at a fence and nothing looked at an indented one. The map was
  // being built for every line and consulted for exactly one of them, the
  // announcing sentence.
  if (inExample && inExample[i]) return null;

  if (/^\s*\|/.test(lines[i])) {
    const rows = [];
    for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);

    // The header rule is found by position, not by shape. The first attempt
    // matched any row built only from pipes, spaces, dashes and colons, and
    // then reset the running total when it saw one. A body row of `| - | - |`
    // meaning "none", or a blank spacer row, matched that and silently
    // discarded every row above it, so a correct sentence above a four-row
    // table was reported as wrong and failed the suite.
    //
    // A real header rule is the second line of the table and holds at least one
    // dash. Position is the load-bearing half: a body row of `| - | - |` cannot
    // be mistaken for a rule anywhere else in the table.
    //
    // It asked for three dashes at first, as belt and braces on top of the
    // position. That was not free. GitHub-flavoured markdown accepts one dash
    // per column, so `|-|-|` was not recognised, the two heading lines were
    // counted as content, and a correct four-row table read as six. The
    // position check was already doing the work the dash count was added for,
    // and the extra condition only ruled out valid tables.
    // The trailing pipe is optional, because markdown makes it optional:
    // `|---|---` is a divider and `| a | b` is a row. Requiring it meant such a
    // table had its heading lines counted as content and read two rows too
    // long, so correct documentation failed the suite.
    const HEADER_RULE = /^\s*\|[\s|:-]*-[\s|:-]*\|?\s*$/;
    const hasHeader = rows.length > 1 && HEADER_RULE.test(rows[1]);
    const count = hasHeader ? rows.length - 2 : rows.length;
    return count > 0 ? { kind: 'table', count, to: i - 1 } : null;
  }

  if (/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
    const indent = lines[i].match(/^\s*/)[0].length;
    let items = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      // A blank line inside a list ends the check rather than the list.
      //
      // Blanks used to be transparent, which merged two consecutive lists into
      // one total. The obvious repair, breaking at the blank, is wrong the
      // other way: in CommonMark `- a`, `- b`, blank, `- c`, `- d` is a single
      // loose list of four, and that is what a reader sees rendered. So one
      // shape wants them joined and the other wants them split, and the text
      // does not say which.
      //
      // Neither is guessed at. An ambiguous grouping means no comparison, the
      // same answer as a sentence carrying two counts.
      if (line.trim() === '') {
        // A blank ends a list. It is also what sits between two lists, and
        // between the items of a loose one, and those two are the same
        // characters. So: if bullets resume at this indent after the blank,
        // the grouping is ambiguous and nothing is compared. If they do not,
        // this is simply where the list stopped.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const resumes = j < lines.length
          && lines[j].match(/^\s*/)[0].length === indent
          && /^\s*([-*]|\d+\.)\s/.test(lines[j]);
        if (resumes) return null;
        break;
      }
      const here = line.match(/^\s*/)[0].length;
      if (here < indent) break;
      if (here === indent && /^\s*([-*]|\d+\.)\s/.test(line)) items++;
      else if (here === indent) break;
    }
    return items > 1 ? { kind: 'list', count: items, to: i - 1 } : null;
  }

  return null;
}

// Every count on a line, with the noun each one counts. The caller picks which
// matters, because only the caller knows the allowlist.
//
// This used to return the last match on the line and nothing else, which was
// wrong in both directions once the allowlist existed. "The four checks below
// apply to 3 fields:" ended on `3 fields`, and `fields` is allowlisted, so 3
// was compared against a four-row list and correct text was reported as wrong.
// "It checks four things across 12 files:" ended on `12 files`, which is not
// allowlisted, so the genuinely stale `four things` was never looked at.
// A number that is not counting anything, judged by what sits in front of it.
//
// All three of these were found by sweeping 593 markdown files rather than by
// any test, and two of them were reported as contradictions in correct prose:
//
//   a range      "Build a comparison table with 3-5 options:" took `5 options`
//                and compared it against a two-row template. The sentence is
//                not claiming the list has five of anything.
//   a fraction   "7/7 success criteria, 49/49 requirements" took
//                `49 requirements` and compared it against the bullets below.
//   an estimate  "up to 20 rows", "about 8 steps". An approximation that comes
//                out lower or higher than the list is not a contradiction, it
//                is the word "about" doing its job.
//
// Checked against the raw text before the match rather than by widening the
// pattern, because every previous attempt to make this regex cleverer has
// produced another false positive.
const NOT_A_COUNT = /(?:[\d)](?:\s*[-–—/]\s*)|\b(?:up to|at most|at least|about|around|roughly|nearly|some|between|or)\s+|[~≈<>]\s*)$/i;

function countIn(line) {
  const re = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+([a-z][a-z-]*s)\b/gi;
  const found = [];
  let hit;
  while ((hit = re.exec(line)) !== null) {
    const raw = hit[1].toLowerCase();
    const value = WORDS[raw] !== undefined ? WORDS[raw] : Number(raw);
    // A year or a version is not a count of anything.
    if (value > 100) continue;
    if (NOT_A_COUNT.test(line.slice(0, hit.index))) continue;
    found.push({ value, noun: hit[2].toLowerCase(), text: hit[0] });
  }
  return found;
}

// The count that is announcing the list, or nothing when that cannot be told.
//
// One allowlisted count on the line is the announcer. Two or more and the line
// is ambiguous, so it is skipped rather than guessed at.
//
// Taking the last one was tried and does not survive "The four checks below
// apply to 3 fields:", where both nouns are allowlisted and the announcer is
// the first. Taking the first does not survive "There are 2 modes and 5
// options:" above a list of options. Nothing short of reading the sentence
// distinguishes them, so neither is chosen.
//
// The cost is a stale count in a two-count sentence going unnoticed. That is
// the right way round: this fails a build, and a guard that fails on correct
// prose gets switched off, after which it catches nothing at all.
// A count that points backwards is not announcing what comes next.
//
// "that build path and those five steps, which is what the handout describes"
// sits above a four-row table of files and was reported as claiming five of
// them. "those" refers to something already named; a sentence introducing the
// list below it does not use it. Found by sweeping her markdown, not by a test.
//
// Narrow on purpose. "these five steps:" genuinely can introduce a list, so it
// is not here, and the general problem of deciding which list a sentence means
// is the one every previous round of this file lost.
const REFERS_BACK = /\b(those|the same)\s+$/i;

function announcedCount(line) {
  const candidates = countIn(line)
    .filter((c) => LIST_NOUNS.has(c.noun))
    .filter((c) => !REFERS_BACK.test(line.slice(0, line.indexOf(c.text))));
  return candidates.length === 1 ? candidates[0] : null;
}

// A number stated in prose must match the list standing next to it.
//
// Returns `{line, stated, kind, count}` per problem, with `line` 1-indexed.
// The caller formats. This used to build the message itself, which meant the
// test and the hook could not word it differently for their two audiences.
function staleCounts(text) {
  const lines = text.split('\n');
  const inExample = exampleLines(lines);
  const problems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inExample[i]) continue;
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*([-*]|\d+\.)\s/.test(line)) continue;

    const stated = announcedCount(line);
    if (!stated) continue;

    // Directly above means the next line, or the one after it when the line
    // between is blank or a lone colon. It used to try `i + 2` unconditionally,
    // which stepped over whatever was there: an unrelated paragraph, or the
    // opening fence of a code block, so a list inside an example was compared
    // against a sentence that had nothing to do with it.
    // Walk to the end of this paragraph, then look for the list.
    //
    // The announcing sentence is not always the last line of its paragraph.
    // The instance this whole file exists for reads "it checks five things and
    // reports back into / the conversation. It never blocks and it never
    // writes." and the table is four lines below. A window of one or two lines
    // was measured against the repository and found nothing at all: it missed
    // that, and every other real case, while the fixtures kept passing because
    // they were built to end at the last bullet.
    //
    // A code fence stops the walk. A list inside an example belongs to the
    // example, not to the sentence above it.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '' && !/^\s*(\||[-*]\s|\d+\.\s)/.test(lines[j])) {
      if (/^\s*(```|~~~)/.test(lines[j])) { j = -1; break; }
      j++;
    }
    if (j < 0) continue;
    const list = listAt(lines, j, inExample);
    if (!list) continue;

    problems.push({
      line: i + 1,
      stated: stated.text,
      kind: list.kind,
      count: list.count,
      ok: list.count === stated.value,
      // The whole span this finding is about, sentence through last row, so a
      // caller can ask whether an edit touched any of it. 1-indexed, matching
      // `line`.
      from: i + 1,
      to: list.to + 1,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------

// Words too common to identify anything. A replacement made up only of these
// tells you nothing about where else the same edit belongs.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'for', 'from', 'with', 'as', 'by', 'not', 'no', 'so', 'then', 'than',
]);

// Is this fragment specific enough that finding it again means something?
//
// The whole check rests on this. Replacing "the" somewhere and reporting the
// other four hundred "the"s is not a finding, it is the check making itself
// useless in one run. So a fragment has to carry something distinguishing:
// a digit, a backticked token, an identifier with internal punctuation or
// capitals, or failing all of those, real length and a word that is not filler.
function isDistinctive(fragment) {
  const text = fragment.trim();
  if (text.length < 6) return false;

  if (/\d/.test(text)) return true;                    // counts, versions, ids
  if (/`[^`]+`/.test(text)) return true;               // a quoted token
  if (/[a-z][A-Z]/.test(text)) return true;            // camelCase
  if (/[a-zA-Z][._/-][a-zA-Z]/.test(text)) return true; // a path or dotted name

  const words = text.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  const solid = words.filter((w) => !STOPWORDS.has(w));
  return text.length >= 12 && solid.length >= 2;
}

// The runs of text that `before` had and `after` does not.
//
// Deliberately not a real diff. It trims the common prefix and suffix and
// returns what is left in the middle, which for the edits this check cares
// about, one value swapped for another, is exactly the changed part. A
// structural rewrite produces one large fragment that `isDistinctive` will
// pass and the file search will then not find, so the cost of the crude
// version is a search that comes back empty rather than a wrong answer.
function replacedFragments(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return [];
  if (!before || before === after) return [];

  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;

  let end = 0;
  while (
    end < max - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;

  const removed = before.slice(start, before.length - end);
  if (!removed.trim()) return [];

  // Grow the fragment out to whole words. A cut through the middle of one
  // produces "ight rounds" from "eight rounds", which is distinctive, matches
  // nothing, and would quietly make the check useless on exactly the edits it
  // is for.
  let from = start;
  while (from > 0 && /[\w`.'-]/.test(before[from - 1])) from--;
  let to = before.length - end;
  while (to < before.length && /[\w`.'-]/.test(before[to])) to++;

  // Then take a word of context from the part that did not change.
  //
  // The minimal difference between "eight rounds" and "nine rounds" is the
  // single word "eight", and that is too little to go looking for. It is under
  // any sensible length floor, and searching for it as a substring finds
  // "weight" and "eighteen". The word beside it did not change, which is
  // exactly what makes it useful: "eight rounds" is the claim that was
  // corrected, and the other copies of that claim are what this check is for.
  //
  // Only enough to reach two real words, and never across a line, so a
  // structural edit does not drag in a paragraph.
  const solidWords = (text) => (text.toLowerCase().match(/[a-z][a-z'-]*/g) || [])
    .filter((w) => !STOPWORDS.has(w)).length;

  while (solidWords(before.slice(from, to)) < 2 && to - from < 40) {
    const next = before.slice(to);
    const grown = next.match(/^[^\S\n]+[\w`.'-]+/);
    if (!grown) break;
    to += grown[0].length;
  }
  while (solidWords(before.slice(from, to)) < 2 && to - from < 40) {
    const prev = before.slice(0, from);
    const grown = prev.match(/[\w`.'-]+[^\S\n]+$/);
    if (!grown) break;
    from -= grown[0].length;
  }

  // Drop punctuation that only ends the sentence.
  //
  // The word-growing class has to hold a dot, or "queue.js" is cut at the dot
  // and searched for as "queue". The cost is that a name at the end of a
  // sentence takes the full stop with it, so renaming "queue.js" in
  // "Renamed to queue.js." goes looking for "queue.js." and misses every
  // other mention, which have no full stop after them. That is the most
  // ordinary shape there is and it made the check silent on it.
  //
  // Only trailing, and never all of it: a fragment that is nothing but
  // punctuation is left as it was rather than emptied.
  const fragment = before.slice(from, to);
  const trimmed = fragment.replace(/[.,;:!?]+$/, '');
  return [trimmed.trim() ? trimmed : fragment];
}

// The fragment as a whole token, rather than as any run of characters.
//
// A bare substring search reports "Step 4" as surviving on a line that says
// "Step 41". Renaming "Step 4" to "Step 5" then sends the writer to correct
// text that was already right, and a renumbering is the shape this check fires
// on most, which is exactly where 4 and 41 sit in the same file.
//
// The length floor in isDistinctive was written for this hazard and does not
// reach it. "Step 4" is six characters, clears the floor, and is still a
// prefix of "Step 41".
//
// A boundary is only added on an end that is a word character, because a
// fragment ending in punctuation has one already. Backticks count as part of
// the token: `queue.js` and queue.js inside a longer name are different
// things.
//
// Deliberately not treating a dot as a boundary. "Step 4.2" does contain
// "Step 4", and when step 4 becomes step 5 its substeps have to move too, so
// reporting it is right. Adding a dot to the boundary would also stop
// "Step 4." at the end of a sentence from matching, and that is a real
// leftover.
function wholeToken(needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^[\w`]/.test(needle) ? '(?<![\\w`])' : '';
  const after = /[\w`]$/.test(needle) ? '(?![\\w`])' : '';
  return new RegExp(before + escaped + after);
}

// Text replaced here and left standing there.
//
// Only ever called for an Edit, because only an Edit says what the old text
// was. A Write replaces the whole file and has no "before" to compare against,
// so this check simply does not apply to one, and saying so is better than
// inventing a weaker version that does.
//
// Measured against 790 real markdown Edit calls taken from session
// transcripts. 548 produced a fragment specific enough to go looking for and
// 11 of those would have fired, which is a fire rate of about 2%.
//
// One shape accounts for most of the 11 and it is worth knowing about: a
// renumbering, part-way through. Renaming "Step L5" to "Step L6" leaves the
// old label further down the file until the rest of the pass lands, and this
// reports it. That reads as a false positive from the outside and it is not
// one. Mid-rename is exactly the moment the fault this check exists for is
// indistinguishable from an unfinished job, and the answer is the same either
// way: the other copies still say the old thing. It warns and never blocks,
// which is what makes being early harmless.
//
// Returns `{fragment, lines}` for each replaced fragment still present.
function survivingText(content, oldString, newString) {
  const found = [];
  for (const fragment of replacedFragments(oldString, newString)) {
    if (!isDistinctive(fragment)) continue;

    const needle = fragment.trim();

    // The replacement can still hold the fragment, and then the line just
    // written matches and is reported as a leftover of itself.
    //
    // Trimming trailing punctuation is what did it. An edit whose only change
    // was the punctuation after a word, a full stop to a comma, leaves the
    // word standing, the trim removes the one character that differed, and
    // the fragment is now exactly the text at the edit site. Every ordinary
    // punctuation fix produced a note pointing at correct text.
    //
    // A fragment the replacement still contains cannot be evidence that
    // something was left behind. The cost is a deliberate partial rename
    // inside one edit, "use queue.js and queue.js" with only the first
    // changed, going unreported. That is a thing somebody did on purpose,
    // where this fires on a thing nobody did at all.
    if (typeof newString === 'string' && wholeToken(needle).test(newString)) continue;
    const lines = [];
    const re = wholeToken(needle);
    content.split('\n').forEach((line, i) => {
      if (re.test(line)) lines.push(i + 1);
    });
    if (lines.length) found.push({ fragment: needle, lines });
  }
  return found;
}

// ---------------------------------------------------------------------------

// A rule the file states about its own text, and how to find a breach of it.
//
// Only rules about a literal, checkable string are here. "Be concise" is a
// rule and is not one of these, because nothing can decide whether a file
// breaks it. The em dash rule is the one that has actually been broken in this
// repository, repeatedly, including by documents whose subject is the rule.
const SELF_RULES = [
  {
    name: 'em-dash',
    // "no em dashes", "never use em dashes", "avoid em dashes", "em dashes are banned"
    states: /\b(no|never use|never|avoid|don't use|do not use|without)\s+em[\s-]?dash(es)?\b|\bem[\s-]?dash(es)?\s+(are|is)\s+(banned|forbidden|not allowed|out)\b/i,
    breaks: /—/,
    what: 'an em dash',
  },
];

// A file that states a rule about its own text and then breaks it.
//
// Two exclusions, and both are the difference between a check that survives
// and one that gets switched off in a week:
//
//   The stating line itself. "Never use an em dash, like this one: —" is the
//   rule and its illustration, on one line, and reporting it is reporting the
//   documentation of the rule as a violation of it.
//
//   Code examples. A fenced block showing what the forbidden thing looks like
//   is the normal way to document a rule about characters. slop-check's own
//   README does this and would otherwise be the first thing flagged.
// A line with its inline code spans taken out.
//
// The breach scan already skipped fenced and indented blocks, because showing
// the character is how you document a rule about characters. An inline span is
// the other way of doing that and was not covered, so a file explaining its own
// rule was warned by it: "The `-` character is banned in prose" read as a use
// of the thing rather than a mention of it.
//
// The file most likely to quote an em dash while banning em dashes is the one
// explaining the rule, which makes this plugin's own documentation and her
// memory files the first things it would have fired on.
//
// Longer runs first, so ``a ` b`` is removed whole rather than leaving a
// stranded backtick behind.
function withoutCodeSpans(line) {
  return line.replace(/``[^`]*``/g, '').replace(/`[^`]*`/g, '');
}

// The same line with the backtick characters gone and the words kept.
//
// The two tests want opposite things from a code span and neither wants what
// the other does. Removing the span suits the breach test, where the point is
// that a shown character is not a used one. It ruins the rule test: "Never use
// `em dashes`" becomes "Never use ." and the file stops being held to a rule
// it plainly states.
//
// Removing only the backticks is what the rule test wants. Marking up part of
// a sentence does not stop it being the sentence. This also fixes a case that
// was broken before any of it: the raw line does not match either, because the
// pattern wants whitespace between "use" and "em" and finds a backtick, so a
// rule written that way was never detected at all.
function withoutBackticks(line) {
  return line.replace(/`/g, '');
}

// An index entry describes the document it links to, so a rule named in one is
// that document's rule and the punctuation in one is that format's punctuation.
//
// An index is a list of `- [Title](file.md) - one line about it`, and the
// separator in that format is often the very character a style rule bans. One
// entry naming the rule turned every other entry into a breach of it: a real
// index reported a rule stated once and broken on 45 of its 66 lines, on every
// edit, and no edit could ever clear it. A warning nobody can clear is one that
// teaches the reader to stop looking, which costs more than the check earns.
//
// Neither question is asked of such a line, and both halves matter. Skipping
// only the rule test leaves the separators reported as breaches whenever some
// other line does state the rule, which is the same false report with a
// different sentence on it.
//
// The link is what carries this, not the bullet. A plain list item saying "No
// em dashes" is the file's own rule and still counts. So does a link into this
// same document, because an anchor is not somewhere else, which is why the
// target must not start with `#`.
//
// Read past code spans, like every other predicate here. `- Write links as
// `[Title](file.md)`` shows the syntax rather than linking anywhere, and
// matching it swallowed a rule stated on the same line.
//
// An image is not a link to a document. `- ![alt](shot.png) - the caption` was
// matched because the `.*` before the bracket happily swallowed the `!`, which
// silenced captions rather than index entries, so the bracket may not be an
// image's.
//
// What this costs, stated plainly because it is broader than the case it was
// written for: any bulleted line carrying a non-anchor link is skipped whole,
// so an em dash used in earnest on such a line goes unreported. That is the
// price of the pair being answered together, and it is the right way round. A
// missed breach on one bullet is quiet. The report it replaced named 45 lines
// that no edit could ever clear, and that is what gets a hook switched off.
//
// Not handled, deliberately: a bullet that links elsewhere and also states a
// rule for this file. Telling those apart means reading the sentence to decide
// whose rule it is, and every attempt in this file to decide a document's
// nature from its wording has been reverted.
// The lookahead covers the whole leading run, not one position inside it.
// Written as `\(\s*(?!#)` the `\s*` backtracks until the lookahead is happy, so
// `](  #style)` matched: the engine gave back a space, found another space
// rather than a `#`, and declared the target was not an anchor. That drops the
// file's own rule on such a line without saying anything was skipped.
//
// An angle bracket only makes a target an anchor when a `#` follows it. The
// first attempt at the line above read every `<` as one, and markdown uses that
// wrapper for ordinary filenames too, `](<my file.md>)` being the reason it
// exists. So every index written that way went straight back to the unclearable
// warning this whole change removes. What decides is the `#`, in either
// position; the bracket decides nothing on its own.
const LINKS_ELSEWHERE = /^\s*(?:[-*+]|\d+[.)])\s+.*(?<!!)\[[^\]]*\]\((?!\s*(?:#|<\s*#))\s*[^)]+\)/;

function describesAnotherDocument(line) {
  return LINKS_ELSEWHERE.test(withoutCodeSpans(line));
}

// The only two places that decide what a line does about a rule.
//
// There used to be a second pair inside ruleChange, matching the raw line.
// The moment brokenOwnRule learned to normalise for code spans the two drifted
// apart, and drifted in both directions at once: a rule added with backticks
// read as "no rule added", and an em dash added inside a code span read as "a
// breach added". Four of six review findings on this feature landed in this
// check, and this split is what most of them were.
//
// So there is one definition of each question now, and both callers ask it
// here. Normalising one can no longer disagree with the other, because there
// is no other.
//
// Unifying the predicates was not enough on its own, and the seventh finding
// was the proof: *which* lines get asked was still duplicated. That lives in
// `ruleLines` now, for the same reason and in the same way.
//
// Why the two normalise differently is the whole point and is not an
// oversight. See withoutCodeSpans and withoutBackticks.
function statesRule(rule, line) {
  return rule.states.test(withoutBackticks(line));
}

function breaksRule(rule, line) {
  return rule.breaks.test(withoutCodeSpans(line));
}

// What one text does about one rule: the lines stating it, the lines breaking
// it. Line numbers, 1-based.
//
// This is the third thing the two callers had their own copy of, and the last.
// `statesRule` and `breaksRule` were unified a round ago, but *which lines they
// were asked about* was not, and that is where the seventh finding landed: the
// file scan skipped examples and skipped the rule sentence itself, while the
// edit test asked every line of the fragment. So an em dash added inside a
// fenced example read as a new breach to one and as no breach at all to the
// other, and the disagreement blamed an untouched line for it.
//
// Both exclusions are decisions with reasons, and both belong to the question
// rather than to either caller:
//
//   examples        a fence is where you demonstrate the fault. The file that
//                   quotes an em dash while banning them is the one explaining
//                   the rule, and it is not breaking it.
//   the rule itself a sentence stating the rule and using the character in the
//                   same breath states it on the line it breaks. Reporting that
//                   means the plugin's own docs and her memory files fire first
//                   and forever.
//
// Asked in one place now, so neither can drift from the other again.
function ruleLines(rule, text) {
  const lines = text.split('\n');
  const inExample = exampleLines(lines);
  const statedAt = [];
  const breaches = [];

  lines.forEach((line, i) => {
    if (inExample[i]) return;
    // Whose document the line is about is asked before what it does about the
    // rule, and answering it once here is what keeps the two halves from
    // disagreeing. See describesAnotherDocument.
    if (describesAnotherDocument(line)) return;
    if (statesRule(rule, line)) { statedAt.push(i + 1); return; }
    if (breaksRule(rule, line)) breaches.push(i + 1);
  });

  return { statedAt, breaches };
}

function brokenOwnRule(text) {
  const found = [];

  for (const rule of SELF_RULES) {
    const { statedAt, breaches } = ruleLines(rule, text);
    if (!statedAt.length || !breaches.length) continue;

    found.push({
      name: rule.name,
      what: rule.what,
      statedAt: statedAt[0],
      // Every line stating it, not only the first. A file can say the same
      // thing in a frontmatter description and again in the body, and a
      // caller asking "did this edit add the rule" needs all of them.
      statedLines: statedAt,
      lines: breaches,
    });
  }
  return found;
}

// What an edit did to a rule, as opposed to what it sat near.
//
// The hook used to ask whether the line stating the rule fell inside the
// edited span, and called that "the edit introduced the rule". Those are not
// the same thing. An Edit routinely carries surrounding lines in old_string
// and new_string so the match is unique, so an unchanged rule sentence lands
// inside the span constantly, and every pre-existing breach in the file was
// then reported as though this edit had caused it.
//
// Introduced means absent before and present after. Nothing else does.
//
// `addedBreach` counts rather than tests, because an edit can leave a breach
// standing while changing the line around it, and a test would call that new.
//
// **Whole files, not the edit's fragments.** This used to be handed
// `old_string` and `new_string` directly, and that is unfixable rather than
// merely wrong: whether a line sits inside a fenced example is a fact about the
// document, and a fragment can begin in the middle of a fence. No amount of
// example detection inside a fragment can recover what a fragment does not
// contain. Passing the file as it was and the file as it is asks the identical
// question of two complete documents, and the disagreement has nowhere left to
// live. The caller reconstructs the before; see `previousContent` in the hook.
// Where an edit stands against the file on disk: did it land, and can the
// document it replaced be rebuilt.
//
// Two questions and not one, because they have different consequences and
// answering them in two places is how the seventh finding got in. "Did not
// land" means nothing in the file is that event's doing and no check should
// speak. "Landed but cannot be rebuilt" means the other checks still run on
// their own terms, and only the rule check, which needs a before to compare
// against, sits out.
//
//   landed  the new text is on disk as written. A deletion has no new text to
//           look for and is taken at its word; the caller's deletion path
//           handles it.
//   text    the whole prior document, rebuilt by putting `old_string` back
//           where `new_string` now sits, ready for `ruleChange`.
//
// Here rather than in the hook so both answers can be asserted directly. Every
// guard below is one an end-to-end test agrees with for its own reasons, which
// means a suite driving only the hook stays green with any of them deleted.
//
// No rebuild on `replace_all`. Every occurrence of `new_string` would have to
// be one this edit created, and a document that already held the text would
// rebuild into a before that never existed: the copies that were always there
// get turned into `old_string` too, so a rule those copies state reads as one
// this edit introduced, and every breach in the file is then reported as its
// doing. Measured before deciding: **0 of 833 markdown Edit calls in her
// history set `replace_all`**, so the case being declined has not once
// occurred.
//
// No rebuild on an ambiguous match either. Which occurrence the edit made is
// unknowable, and while putting the text back at the wrong one leaves the same
// set of lines in almost every case, "almost" is doing real work there: either
// string may carry a fence marker, and moving one of those changes which lines
// count as an example for the whole rest of the document.
function editStanding(content, input) {
  const needle = input.new_string;
  const replacement = input.old_string;
  const noRebuild = { landed: true, text: null };
  if (typeof needle !== 'string' || typeof replacement !== 'string') return noRebuild;
  if (needle === '') return noRebuild;

  const first = content.indexOf(needle);
  if (first === -1) return { landed: false, text: null };
  if (input.replace_all) return noRebuild;
  if (content.indexOf(needle, first + 1) !== -1) return noRebuild;

  return {
    landed: true,
    text: content.slice(0, first) + replacement + content.slice(first + needle.length),
  };
}

function ruleChange(name, beforeText, afterText) {
  const rule = SELF_RULES.find((r) => r.name === name);
  if (!rule) return { addedRule: false, addedBreach: false };

  const before = ruleLines(rule, typeof beforeText === 'string' ? beforeText : '');
  const after = ruleLines(rule, typeof afterText === 'string' ? afterText : '');

  return {
    addedRule: after.statedAt.length > 0 && before.statedAt.length === 0,
    addedBreach: after.breaches.length > before.breaches.length,
  };
}

module.exports = {
  staleCounts,
  ruleChange,
  editStanding,
  survivingText,
  brokenOwnRule,
  // Exported for the tests, which pin the pieces that produced false positives.
  ruleLines,
  listAt,
  countIn,
  announcedCount,
  exampleLines,
  replacedFragments,
  isDistinctive,
  LIST_NOUNS,
};
