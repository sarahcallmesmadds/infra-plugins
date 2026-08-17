// Signals in technical output: code, data and charts, and scope documents.
//
// The prose tells do not transfer. Nobody writes "delve" in a function name.
// What shows up instead is work that LOOKS finished and has not been checked
// by anyone who would know it is wrong.
//
// Same discipline as the prose side: these are aggregate signals, they appear
// in human work too, and the scorer counts distinct categories. The difference
// is that several of these are checkable facts rather than matters of taste,
// and those are worth much more than the stylistic ones.

'use strict';

// --- code ------------------------------------------------------------------

// Placeholders that a person would have replaced before shipping. Strong,
// because they are unambiguous and nobody defends them.
const CODE_PLACEHOLDERS = [
  'your-api-key', 'YOUR_API_KEY', 'your_api_key', 'sk-xxx', 'xxxxxxxx',
  'example.com', 'foo@bar.com', 'user@example', 'localhost:3000/api/v1/example',
  'TODO: implement', 'TODO: handle', 'FIXME', 'implement me', 'not implemented',
  'replace this', 'your-project-id', 'INSERT_', 'CHANGE_ME', 'lorem ipsum',
];

// Names that carry no meaning. A few are normal; a file built from them means
// nobody named anything after knowing what it held.
const GENERIC_IDENTIFIERS = [
  'data', 'result', 'results', 'temp', 'tmp', 'item', 'items', 'obj',
  'value', 'val', 'handler', 'process', 'helper', 'util', 'utils',
  'thing', 'stuff', 'output', 'input', 'response', 'res', 'req',
];

// Swallowing an error is how generated code makes a failing path look handled.
//
// Only BROAD catches count. `except ValueError: pass` is a deliberate decision
// by someone who knew which failure they were ignoring and why. A bare
// `except:` or an empty `catch {}` is the opposite: every failure, including
// the ones nobody thought about, silently discarded.
const SWALLOWED_ERRORS = [
  /catch\s*\([^)]*\)\s*\{\s*\}/g,
  /catch\s*\{\s*\}/g,
  /except\s*:\s*\n\s*(#[^\n]*\n\s*)?pass\b/g,
  /except\s+(?:Base)?Exception[^\n:]*:\s*\n\s*(#[^\n]*\n\s*)?pass\b/g,
  /rescue\s*(?:=>\s*\w+)?\s*\n\s*end\b/g,
];

// A comment that restates the line under it. "// increment the counter".
const RESTATING_COMMENT = /(?:\/\/|#)\s*(increment|decrement|initiali[sz]e|declare|define|create|set|get|return|loop (?:over|through)|iterate (?:over|through)|check if|assign)\b/gi;

function countMatches(text, regexes) {
  let n = 0;
  for (const re of regexes) {
    const found = text.match(re);
    if (found) n += found.length;
  }
  return n;
}

// Looks like source rather than prose. Needed because every group now runs on
// every input: a markdown heading starts with "#", which would otherwise be
// counted as a comment and make any well-structured document look
// over-commented.
function looksLikeCode(text) {
  // Declarations catch whole files. The second group catches fragments: a
  // pasted try/catch is unmistakably code but declares nothing, and requiring
  // a declaration would wave it through as prose.
  const declares = /(^|\n)\s*(function\s+\w+|def\s+\w+|class\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|import\s+|from\s+\w+\s+import|#include|package\s+\w+)/;
  const constructs = /(^#!)|(\btry\s*[:{])|(\}\s*catch\b)|(\bcatch\s*[({])|(\bexcept\b[^\n]*:)|(\bfinally\s*[:{])|(=>\s*[{(])|(\breturn\b[^\n]*;)/;
  return declares.test(text) || constructs.test(text);
}

function commentRatio(code) {
  if (!looksLikeCode(code)) return null;
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 20) return null;
  // Markdown headings are "# " with a space; a shell or Python comment is too,
  // so this only runs on text already established as source.
  const comments = lines.filter((l) => /^(\/\/|#|\*|\/\*)/.test(l)).length;
  return { ratio: Number((comments / lines.length).toFixed(2)), lines: lines.length };
}

// camelCase and snake_case fighting inside one file. A person picks one.
function mixedNaming(code) {
  const camel = (code.match(/\b[a-z]+[A-Z][a-zA-Z]*\b/g) || []).length;
  const snake = (code.match(/\b[a-z]+_[a-z_]+\b/g) || []).length;
  if (camel < 5 || snake < 5) return null;
  const minor = Math.min(camel, snake);
  const share = minor / (camel + snake);
  return share > 0.25 ? { camel, snake, share: Number(share.toFixed(2)) } : null;
}

function checkCode(text) {
  const found = [];

  // Everything below is about source, and every group now runs on every input,
  // so this has to establish it is looking at source before saying anything.
  // Two of these read as ordinary prose otherwise:
  //
  //   `# Set up the project` is a markdown heading, and also matches the
  //   comment-restating-the-code pattern, because a comment marker in most
  //   languages is the same character.
  //
  //   "visit example.com" is a normal sentence, and also a placeholder string.
  //   That one was reported HARD, which is the tier the README tells the
  //   reader to treat as fact.
  const isCode = looksLikeCode(text);
  if (!isCode) return found;

  const placeholders = CODE_PLACEHOLDERS.filter((p) => text.includes(p));
  if (placeholders.length) {
    found.push({ name: 'placeholders-left-in', hard: true, hits: placeholders });
  }

  const swallowed = countMatches(text, SWALLOWED_ERRORS);
  if (swallowed > 0) found.push({ name: 'errors-silently-swallowed', hard: true, count: swallowed });

  const restating = (text.match(RESTATING_COMMENT) || []).length;
  if (restating >= 3) found.push({ name: 'comments-restate-the-code', count: restating });

  const ratio = commentRatio(text);
  if (ratio && ratio.ratio > 0.35) {
    found.push({ name: 'over-commented', ...ratio });
  }

  const naming = mixedNaming(text);
  if (naming) found.push({ name: 'naming-style-mixed', ...naming });

  const generic = GENERIC_IDENTIFIERS.filter((g) =>
    new RegExp(`\\b(?:const|let|var|def|function)\\s+${g}\\b`).test(text));
  if (generic.length >= 3) found.push({ name: 'generic-identifiers', hits: generic });

  return found;
}

// --- taking the long way round ---------------------------------------------
//
// A separate failure from the ones above, and a more expensive one. The work
// is reviewable, runs, and does the job, but by a far longer path than the
// problem needed. It shows up as structure with nothing behind it: layers that
// only forward calls, an abstraction with exactly one thing under it, a helper
// that reimplements something the language already has.
//
// The honest framing is "this looks heavier than the problem". Some of these
// are correct decisions in a codebase heading somewhere, which is exactly why
// they are soft signals and why the counts matter more than any single hit.

// Names that promise a layer. Two or three in a large codebase is ordinary.
// Six in a two hundred line script is architecture nobody needed.
const LAYER_WORDS = /\b\w*(Factory|Manager|Provider|Strategy|Adapter|Wrapper|Orchestrator|Coordinator|Dispatcher|Registry|Container|Builder|Facade|Delegate|Mediator)\b/g;

// Utilities the standard library already provides. Hand-rolling one is the
// clearest form of the long way round, because the short path is one call.
const REINVENTED = [
  { name: 'deep clone', re: /function\s+deepClone|const\s+deepClone\s*=|def\s+deep_clone/ },
  { name: 'debounce', re: /function\s+debounce|const\s+debounce\s*=|def\s+debounce/ },
  { name: 'group by', re: /function\s+groupBy|const\s+groupBy\s*=|def\s+group_by/ },
  { name: 'chunk', re: /function\s+chunk|const\s+chunk\s*=|def\s+chunk\b/ },
  { name: 'capitalise', re: /function\s+capitali[sz]e|const\s+capitali[sz]e\s*=|def\s+capitali[sz]e/ },
  { name: 'is empty', re: /function\s+isEmpty|const\s+isEmpty\s*=|def\s+is_empty/ },
  { name: 'unique', re: /function\s+unique|const\s+unique\s*=|def\s+unique\b/ },
  { name: 'range', re: /function\s+range\b|def\s+my_range/ },
];

// A function whose whole body forwards to another call. One is a rename. Four
// is a layer that exists to be a layer.
function passThroughWrappers(code) {
  const patterns = [
    /function\s+\w+\s*\([^)]*\)\s*\{\s*return\s+\w+(?:\.\w+)*\([^)]*\);?\s*\}/g,
    /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\w+(?:\.\w+)*\([^)]*\);?/g,
    /def\s+\w+\s*\([^)]*\):\s*\n\s*return\s+\w+(?:\.\w+)*\([^)]*\)\s*\n/g,
  ];
  return countMatches(code, patterns);
}

// async with nothing to wait for. The keyword was added because it looked
// like the shape of the thing, not because anything is asynchronous.
function asyncWithoutAwait(code) {
  const fns = code.match(/async\s+(?:function\s+\w+|\w+\s*=>|def\s+\w+)[\s\S]{0,600}?(?=\n(?:async|function|def|const|class|\}|$))/g) || [];
  return fns.filter((f) => !/\bawait\b/.test(f)).length;
}

// A class used only as a namespace. In most languages these are functions.
function staticOnlyClass(code) {
  const classes = code.match(/class\s+\w+[\s\S]{0,1200}?\n\}/g) || [];
  return classes.filter((c) => {
    const methods = c.match(/^\s{2,}(?:static\s+)?\w+\s*\(/gm) || [];
    if (methods.length < 2) return false;
    const statics = c.match(/^\s{2,}static\s+\w+\s*\(/gm) || [];
    return statics.length === methods.length;
  }).length;
}

// How deep the code goes before doing anything. Measured by indentation, which
// is crude but survives every language here.
function nestingDepth(code) {
  const depths = code.split('\n')
    .filter((l) => l.trim())
    .map((l) => (l.match(/^[\t ]*/)[0].replace(/\t/g, '    ').length / 2) | 0);
  if (depths.length < 30) return null;
  const deep = depths.filter((d) => d >= 5).length;
  const share = deep / depths.length;
  return share > 0.15 ? { share: Number(share.toFixed(2)), lines: depths.length } : null;
}

function checkOverbuilt(text) {
  const found = [];
  const tag = (f) => ({ ...f, over: true });

  const layers = [...new Set(text.match(LAYER_WORDS) || [])];
  const lines = text.split('\n').filter((l) => l.trim()).length;
  if (layers.length >= 3 && lines > 0 && layers.length / (lines / 100) >= 1.5) {
    found.push(tag({ name: 'layers-for-their-own-sake', hits: layers, per100Lines: Number((layers.length / (lines / 100)).toFixed(1)) }));
  }

  const wrappers = passThroughWrappers(text);
  if (wrappers >= 3) found.push(tag({ name: 'functions-that-only-forward', count: wrappers }));

  const reinvented = REINVENTED.filter((r) => r.re.test(text)).map((r) => r.name);
  if (reinvented.length) found.push(tag({ name: 'rebuilt-what-the-language-provides', hits: reinvented }));

  const idleAsync = asyncWithoutAwait(text);
  if (idleAsync >= 2) found.push(tag({ name: 'async-with-nothing-to-await', count: idleAsync }));

  const statics = staticOnlyClass(text);
  if (statics >= 1) found.push(tag({ name: 'class-used-only-as-a-namespace', count: statics }));

  const nesting = nestingDepth(text);
  if (nesting) found.push(tag({ name: 'deeply-nested-throughout', ...nesting }));

  return found;
}

// --- is this text a plan at all -------------------------------------------
//
// Two checks below are absence checks: nothing says who owns this, and nothing
// says what is being left out. An absence only means something where the thing
// was expected, and neither is expected in ordinary writing. A blog post, a
// newsletter and a LinkedIn draft are all long, all unowned and all proposing
// nothing, and both checks fired on all of them.
//
// Counting words was the wrong instrument, and two rounds of tuning the count
// only moved which writing it was wrong about.
//
// One word was too few: any post mentioning building something matched. Two was
// too few in one direction and too many in the other, because "build" and
// "approach" are two different words that both belong in an ordinary essay about
// product work, while a real proposal can lean on "we will" alone. Three was
// still wrong: a plain proposal saying "we will build" and little else reaches
// only two.
//
// The distinction the count kept missing is not how many words appear but what
// kind. "We will", "the plan", "a proposal" and "the deliverable" commit somebody
// to something. "Build", "implement" and "approach" describe work and appear just
// as readily in a retrospective. So the commitment words count double, and the
// work words count single, against a threshold of three. One commitment word plus
// one work word is a proposal. Two work words on their own are a Tuesday.
//
// What the numbers below are and are not. They come from the seven fixtures in
// tests/slop-check.test.js, which are hand-written, few, and chosen by the person
// who wrote this. They show that these thresholds separate the cases that exist
// there. They do not establish that the thresholds are right in general, and an
// earlier version of this comment claimed they did. Round 2 of the review made
// that concrete by producing a two-marker proposal from outside the sample that
// the threshold missed, which is why the rule now turns on the kind of word
// rather than on a count that happened to fit seven examples.
//
// Density is the second route, and it catches what any count of distinct words
// cannot: one word leaned on so hard that it is the subject of the document. A
// band rather than a ceiling, and both ends are measured from those same
// fixtures by scratchpad/measure-fixtures.js, which reads them out of the test
// file rather than from a copy, so editing a fixture moves the numbers.
//
// The ceiling of 60 sits between the sparsest case that must fire on density
// alone, at one marker per 33 characters, and the densest case that must stay
// quiet, at one per 119. The floor of 12 sits between that same 33 and a list of
// 150 headings reading "Scope", which runs one per 6 and is not prose at all.
// Telling a list it names no owner is the same category of wrong as telling a
// post.
//
// Two earlier versions of this comment carried the densest quiet figure as 137
// and then as 135. Both were measured from a draft of the essay fixture and never
// re-measured after it was lengthened for the suite. The number is 119.4, and
// that is the reason the script above exists rather than a note of the figure.
//
// Multi-word alternatives come before their own substrings. `out of scope` is
// still reachable after `scopes?` today, because a search starting at the word
// boundary before "out" cannot match `scopes?` there, but that is a property of
// where the engine happens to start rather than anything this file states. Order
// them and it stops depending on that.

// The word lists, and the patterns built from them. Written once each: the
// combined proposal pattern is the two halves joined rather than a third copy of
// the same words, because three lists that must agree is three chances to edit
// one and not the others, and nothing here would report the disagreement.
// `we will` only. Leaving `we (?:will|should|could)` here while adding "we should"
// below would have matched it in both lists and scored it three on its own, which
// is worse than the defect being fixed.
const COMMITMENT_WORDS = ['we will', 'the plan', 'proposal', 'deliverable'];
// "We should" and "we could" are not commitments. Putting them here was the
// round-2 answer and round 3 broke it in one line: "We should stop pretending that
// the office is what made those teams work", plus one "build" further down, scored
// three and got an opinion post reported as an unowned plan with no cut line. That
// is the original bug of this pull request, arriving for the fourth time through
// its own fix. "We will" commits somebody to doing something. "We should" is how
// commentary opens.
const WORK_WORDS = ['we should', 'we could', 'approach', 'implement', 'build'];

function anyOf(words) {
  return new RegExp(`\\b(${words.join('|')})\\b`, 'gi');
}

const COMMITMENT_MARKERS = anyOf(COMMITMENT_WORDS);
const WORK_MARKERS = anyOf(WORK_WORDS);
const PROPOSAL_MARKERS = anyOf([...COMMITMENT_WORDS, ...WORK_WORDS]);

const PLANNING_TERMS = /\b(out of scope|acceptance criteria|success criteria|rollout plan|migration plan|project plan|key results?|scopes?|requirements?|deliverables?|milestones?|timelines?|stakeholders?|sign-?off|roadmaps?|sprints?|backlog|objectives?)\b/gi;

// Singular and plural of one term are one term. Without this, "scope" and
// "scopes" counted as two markers, so a document leaning on a single concept in
// both forms reached the threshold on the strength of an inflection.
function markers(text, pattern) {
  const all = (text.match(pattern) || [])
    .map((m) => m.toLowerCase().replace(/s$/, ''));
  return { distinct: new Set(all).size, total: all.length };
}

// One word used often enough to be the subject, and often enough to still be
// prose. Both bounds are load-bearing and they fail in opposite directions: with
// no ceiling this never fires, and with no floor it fires on any list.
function leanedOn(text, pattern) {
  const { total } = markers(text, pattern);
  if (total === 0) return false;
  const perMarker = text.length / total;
  return perMarker <= 60 && perMarker >= 12;
}

// Source, as opposed to a document that shows some code.
//
// `looksLikeCode` answers "is there code in here". That is the right question for
// the code checks and the wrong one for the two document checks, because one
// `function go() { return 1; }` line pasted onto a twelve-paragraph proposal made
// the whole thing source and silenced both. It is also the question that has to
// stay answered for source itself: a function carrying sixty "we will" comments
// must not be told it declared no cut line, which is why the guard was added.
//
// Those two pull in opposite directions and only a proportion separates them, so
// the existing test stays as a necessary condition and a share is added on top.
// Characters, not lines: a proposal built by repeating one sentence is a single
// 840-character line, so a code line appended to it is half the lines and three
// per cent of the text.
//
// Measured over this repository's own files by scratchpad/measure-codeshare.js.
// The margin is not wide and the tighter side is source: documents reach 22 per
// cent at most, which is this repository's CLAUDE.md and its code fences, while
// the lowest source file is the slop-check suite at 35 per cent, low because it is
// mostly prose fixtures. Thirty sits between them. Both bounds are pinned by tests
// against real files in this repository, so a suite that grows more prose trips a
// row here rather than quietly becoming a document.
const CODE_LINE = /^\s*(\/\/|\*|\/\*)/;
const BRACE_LINE = /^\s*[{}()[\];]+\s*$/;

function codeShare(text) {
  const lines = text.split('\n').filter((line) => line.trim());
  let code = 0;
  let all = 0;
  for (const line of lines) {
    all += line.length;
    // No `#`. It is a comment in shell and Python and a heading in markdown, and
    // counting it made every structured document look like source.
    if (looksLikeCode(line) || CODE_LINE.test(line) || BRACE_LINE.test(line)) {
      code += line.length;
    }
  }
  return all ? code / all : 0;
}

function isSourceRatherThanDocument(text) {
  return looksLikeCode(text) && codeShare(text) > 0.30;
}

// Characters per marker, for each of the two vocabularies. Infinity when the text
// holds none, which is the honest answer and keeps a caller from dividing by zero.
// Exported so the numbers written into the comments above can be asserted.
function markerDensity(text) {
  const per = (pattern) => {
    const { total } = markers(text, pattern);
    return total ? text.length / total : Infinity;
  };
  return { proposal: per(PROPOSAL_MARKERS), planning: per(PLANNING_TERMS) };
}

// Commitment words count double, work words single, three to qualify.
function proposesWork(text) {
  const weight = 2 * markers(text, COMMITMENT_MARKERS).distinct
    + markers(text, WORK_MARKERS).distinct;
  return weight >= 3 || leanedOn(text, PROPOSAL_MARKERS);
}

// A document proposing work is the same question as whether it is a plan, for the
// purpose of asking who owns it. Both routes are needed: a proposal can be
// written entirely in the language of doing the work and never say "scope", and a
// plan can be laid out in planning vocabulary and never say "we will".
function readsAsAPlan(text) {
  return proposesWork(text)
    || markers(text, PLANNING_TERMS).distinct >= 3
    || leanedOn(text, PLANNING_TERMS);
}

// The same failure in a plan rather than in code: a build heavier than the
// thing being built.
function checkOverplanned(text) {
  const found = [];
  const tag = (f) => ({ ...f, over: true });
  const lower = text.toLowerCase();

  const grandiose = ['framework', 'platform', 'engine', 'abstraction layer',
    'pipeline architecture', 'plugin system', 'extensible system',
    'future-proof', 'scalable foundation', 'generic solution'];
  const hits = grandiose.filter((g) => lower.includes(g));
  const phases = (text.match(/\bphase\s*\d/gi) || []).length;

  if (hits.length >= 2 && text.length < 6000) {
    found.push(tag({ name: 'building-a-framework-for-a-one-off', hits }));
  }
  if (phases >= 4 && text.length < 4000) {
    found.push(tag({ name: 'more-phases-than-the-work-needs', phases }));
  }

  // Governance outweighing the work: lots of process nouns, little verb.
  const process = (lower.match(/\b(governance|stakeholder|alignment|cadence|working group|steering|review board|sign-?off)\b/g) || []).length;
  if (process >= 5) found.push(tag({ name: 'more-process-than-work', count: process }));

  // Reaching for the finished version when the smallest one was wanted. The
  // adjectives are the tell: nobody asking for a first cut describes it as
  // enterprise-grade.
  const goldPlating = ['production-ready', 'enterprise-grade', 'fully scalable',
    'battle-tested', 'comprehensive solution', 'robust architecture',
    'best practices', 'industry standard', 'fault-tolerant', 'highly available'];
  const plated = goldPlating.filter((g) => lower.includes(g));
  if (plated.length >= 2) found.push(tag({ name: 'built-for-a-scale-nobody-asked-for', hits: plated }));

  // The single most useful question of a proposal: what is it NOT doing.
  // Work that names no cut line has not been thought about, it has been
  // enumerated. A first version is defined by what it leaves out.
  //
  // A single one of these words is not a proposal, and the commonest of them is
  // "build". Any writing longer than 700 characters that mentioned building
  // something once matched, so this fired on a LinkedIn draft whose only
  // qualifying word was "build", in the phrase "what I am going to build next",
  // and told its writer their post had never declared a cut line.
  //
  // `proposesWork` rather than a count, for the reasons given where it is defined.
  // Every count tried here was wrong about something: one word flagged any post
  // mentioning building, two flagged an essay about product work, and three
  // stayed silent on a plain proposal that said "we will build" and little else.
  //
  // Not source code. `checkSpec` has always excluded it and this did not, so a
  // function carrying sixty "we will" comments was told it had declared no cut
  // line. The two checks ask the same question about the same kind of document,
  // and only one of them was answering it about documents.
  const namesACut = /\b(out of scope|not (?:doing|building|in scope)|v2|version 2|later|deferred|explicitly excluded|won'?t (?:do|build|include)|minimum|smallest|first (?:cut|version|pass)|mvp)\b/i.test(text);
  if (proposesWork(text) && !namesACut && text.length > 700 && !isSourceRatherThanDocument(text)) {
    found.push(tag({ name: 'never-says-what-it-is-not-doing' }));
  }

  // Handing back the reader's own context before getting to the work.
  const echoes = ['as you mentioned', 'as you noted', 'based on your request',
    'as requested', 'you asked me to', 'to summarise your', 'to summarize your',
    'to recap', 'in other words', 'as we discussed', 'per your request',
    'it is worth restating', 'as previously stated'];
  const echoed = echoes.filter((e) => lower.includes(e));
  if (echoed.length >= 2) found.push(tag({ name: 'restates-what-you-already-said', hits: echoed }));

  return found;
}

// --- data and charts -------------------------------------------------------

// Real measurements are untidy. Fabricated ones are suspiciously regular:
// round numbers, uniform precision, monotone columns, smooth series.
function checkData(text) {
  const found = [];

  // Keep the source strings. Precision is a property of how a number was
  // WRITTEN, not of its value, and parsing destroys exactly that: Number("2.00")
  // is 2, and Number("1.50") is 1.5. Measuring after conversion made the check
  // blind to the tidy trailing-zero formatting it exists to catch.
  const written = text.match(/-?\d+(?:\.\d+)?/g) || [];
  const numbers = written.map(Number).filter((n) => Number.isFinite(n));

  // Regularity analysis is meaningless over source. Array indices, thresholds,
  // status codes and buffer sizes are round because programmers choose round
  // numbers, not because anyone fabricated a measurement.
  if (numbers.length >= 12 && !looksLikeCode(text)) {
    const round = numbers.filter((n) => Number.isInteger(n) && (n % 10 === 0 || n % 5 === 0));
    const share = round.length / numbers.length;
    if (share > 0.6) {
      found.push({ name: 'numbers-suspiciously-round', share: Number(share.toFixed(2)), of: numbers.length });
    }

    // Every decimal carried to exactly the same place. Real data collected by
    // different instruments or people does not do this.
    const decimals = written
      .map((s) => (s.split('.')[1] || '').length)
      .filter((d) => d > 0);
    if (decimals.length >= 8) {
      const uniform = decimals.every((d) => d === decimals[0]);
      if (uniform) found.push({ name: 'uniform-decimal-precision', places: decimals[0], of: decimals.length });
    }
  }

  // Percentages that do not add up. This is arithmetic rather than taste, so
  // it is a hard finding: a set of shares that does not total 100 is wrong,
  // and no amount of context makes it right.
  //
  // Documents only. Percentages in source are widths, opacities, offsets and
  // easing values. They are not shares of a whole and were never meant to sum
  // to anything, so adding them up and calling the result an error is exactly
  // the kind of confident wrong answer that makes a tool worth ignoring. This
  // finding is marked hard, so a false one costs more than most.
  const percents = (text.match(/(\d+(?:\.\d+)?)\s*%/g) || []).map((p) => parseFloat(p));
  if (percents.length >= 3 && percents.length <= 12 && !looksLikeCode(text)) {
    const total = percents.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.5 && Math.abs(total - 100) < 25) {
      found.push({ name: 'percentages-do-not-total-100', hard: true, total: Number(total.toFixed(1)) });
    }
  }

  // Chart scaffolding nobody relabelled. Also documents only: `xlabel` and
  // `ylabel` are the matplotlib API, so every plotting script in existence
  // would otherwise be reported for using the library correctly.
  const defaults = ['Series 1', 'Series1', 'series_1', 'Column1', 'Untitled', 'Sheet1',
    'xlabel', 'ylabel', 'Category A', 'Category B', 'Label 1', 'Value 1'];
  const hits = defaults.filter((d) => text.includes(d));
  if (hits.length && !looksLikeCode(text)) found.push({ name: 'default-chart-labels', hits });

  return found;
}

// --- scope and spec documents ---------------------------------------------

// The failure is not bad prose, it is a document that decides nothing.
function checkSpec(text) {
  const found = [];
  const lower = text.toLowerCase();

  // Risk sections that list the risks any project has.
  const genericRisks = ['scope creep', 'resource constraints', 'timeline slippage',
    'stakeholder alignment', 'technical debt', 'changing requirements',
    'lack of resources', 'communication gaps'];
  const risks = genericRisks.filter((r) => lower.includes(r));
  if (risks.length >= 3) found.push({ name: 'generic-risk-list', hits: risks });

  // Success criteria that cannot be measured, so nobody can fail them.
  const vagueMetrics = ['improved efficiency', 'better alignment', 'increased visibility',
    'enhanced collaboration', 'greater clarity', 'improved experience',
    'streamlined process', 'higher quality'];
  const metrics = vagueMetrics.filter((m) => lower.includes(m));
  if (metrics.length >= 2) found.push({ name: 'unmeasurable-success-criteria', hits: metrics });

  // Estimates that are all the same, or all round. Nobody estimated anything.
  const weeks = (text.match(/\b(\d+)\s*(?:weeks?|days?|sprints?)\b/gi) || [])
    .map((m) => parseInt(m, 10)).filter(Number.isFinite);
  if (weeks.length >= 3) {
    const unique = new Set(weeks);
    if (unique.size === 1) {
      found.push({ name: 'every-estimate-identical', value: weeks[0], of: weeks.length });
    // Multiples of five only. An earlier version also counted every even
    // number as round, which flagged 2, 4, 8 weeks: a perfectly ordinary
    // doubling schedule, and arguably the most considered estimate in the
    // list. Half of all integers are even, so that term was close to saying
    // "some numbers appeared".
    } else if (weeks.every((w) => w % 5 === 0)) {
      found.push({ name: 'estimates-all-round-numbers', of: weeks.length });
    }
  }

  // Options laid out with equal weight and no recommendation. The single most
  // common shape of a document written by something with no stake in it.
  const optionCount = (text.match(/\b(?:option|approach|alternative)\s*(?:\d|[a-c]\b|one|two|three)/gi) || []).length;
  const recommends = /\b(i recommend|we recommend|recommendation:|my recommendation|we should|the right call|i'd go with|go with)\b/i.test(text);
  if (optionCount >= 2 && !recommends) {
    found.push({ name: 'options-with-no-recommendation', options: optionCount });
  }

  // Nobody's name on it, and no date. Unowned work is unreviewed work.
  //
  // Documents only, and plans among those. Every group runs on every input now,
  // so without the code guard this fired on every source file, and without the
  // plan guard it fired on every piece of long prose that was never a document
  // in the first place. Both exclusions are for the same reason: the field it
  // reports missing was never going to be present.
  const hasOwner = /\b(owner|dri|accountable|assigned to|author|lead)\b\s*[:\-]/i.test(text);
  const hasDate = /\b(20\d\d-\d\d-\d\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})/i.test(text);
  if (text.length > 800 && !hasOwner && !hasDate && !isSourceRatherThanDocument(text) && readsAsAPlan(text)) {
    found.push({ name: 'no-owner-and-no-date' });
  }

  // Placeholders sitting in a document that presents itself as finished.
  //
  // The code-side placeholder check only runs on source now, so this is where
  // a document's own leftovers get caught. `lorem ipsum` and `FIXME` moved here
  // rather than being dropped: in prose they are unambiguous, where
  // "visit example.com" is just a sentence.
  const tbd = (text.match(/\b(TBD|TBC|to be determined|to be confirmed|\[placeholder\]|\[insert|lorem ipsum|FIXME|XXX)/gi) || []).length;
  if (tbd >= 2) found.push({ name: 'open-placeholders-in-a-finished-doc', count: tbd });

  return found;
}

// --- entry point -----------------------------------------------------------

function guessKind(filename, text) {
  const name = String(filename || '').toLowerCase();
  if (/\.(js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|sh|sql)$/.test(name)) return 'code';
  if (/\.(csv|tsv|json)$/.test(name)) return 'data';
  if (/```|function |def |const |import /.test(text)) return 'code';
  if (/\|\s*-{2,}\s*\|/.test(text) || /\d+\s*%/.test(text)) return 'data';
  return 'spec';
}

function checkTechnical(text, kind) {
  // Every group, every time. An earlier version picked one group from a
  // guessed kind, which quietly defeated the whole design: guessKind returns
  // "data" for anything holding a table or a percentage, so a spec with one
  // percent figure never reached checkSpec, and the headline signal, options
  // laid out with no recommendation, could not fire on exactly the documents
  // most likely to contain it.
  //
  // `kind` is now only a label for the report. Real documents are mixtures: a
  // spec carries a table, a README carries code, a plan carries both.
  const all = [
    ...checkCode(text),
    ...checkOverbuilt(text),
    ...checkData(text),
    ...checkSpec(text),
    ...checkOverplanned(text),
  ];

  const hard = all.filter((f) => f.hard);
  const over = all.filter((f) => f.over);
  const soft = all.filter((f) => !f.hard && !f.over);

  // One checkable problem is worth reporting but is not a verdict: a single
  // placeholder can be a genuine template, and one broad catch can be a
  // considered decision. The reading only goes strong when the signals stack.
  const reading =
    hard.length >= 2 || (hard.length >= 1 && soft.length >= 2) || soft.length >= 4
      ? 'strong'
      : hard.length >= 1 || soft.length >= 2
        ? 'some'
        : 'little';

  // Two separate questions, so two separate readings. Work can be carefully
  // reviewed and still take the long way round, and the reverse.
  const weight =
    over.length >= 3 ? 'strong' : over.length >= 2 ? 'some' : 'little';

  return { hard, soft, over, categories: all.length, reading, weight };
}

// `markerDensity` and `codeShare` are exported for the tests and for nothing else.
// The thresholds above are documented with numbers, and the last two review rounds
// both caught a number in a comment that no longer matched the fixture it came
// from. A figure nothing can check is a figure that drifts, so the rows in
// tests/slop-check.test.js recompute these and assert the bounds, which means
// editing a fixture past a threshold fails the suite rather than quietly making a
// comment false.
module.exports = {
  checkTechnical, checkCode, checkData, checkSpec, checkOverbuilt, checkOverplanned, guessKind,
  markerDensity, codeShare,
};
