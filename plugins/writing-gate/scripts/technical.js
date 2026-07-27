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

function commentRatio(code) {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 20) return null;
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
  const proposes = /\b(we (?:will|should|could)|the plan|approach|proposal|implement|build|deliverable)\b/i.test(text);
  const namesACut = /\b(out of scope|not (?:doing|building|in scope)|v2|version 2|later|deferred|explicitly excluded|won'?t (?:do|build|include)|minimum|smallest|first (?:cut|version|pass)|mvp)\b/i.test(text);
  if (proposes && !namesACut && text.length > 700) {
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

  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n));
  if (numbers.length >= 12) {
    const round = numbers.filter((n) => Number.isInteger(n) && (n % 10 === 0 || n % 5 === 0));
    const share = round.length / numbers.length;
    if (share > 0.6) {
      found.push({ name: 'numbers-suspiciously-round', share: Number(share.toFixed(2)), of: numbers.length });
    }

    // Every decimal carried to exactly the same place. Real data collected by
    // different instruments or people does not do this.
    const decimals = numbers
      .map((n) => (String(n).split('.')[1] || '').length)
      .filter((d) => d > 0);
    if (decimals.length >= 8) {
      const uniform = decimals.every((d) => d === decimals[0]);
      if (uniform) found.push({ name: 'uniform-decimal-precision', places: decimals[0], of: decimals.length });
    }
  }

  // Percentages that do not add up. Cheap to check, and damning when it fails.
  const percents = (text.match(/(\d+(?:\.\d+)?)\s*%/g) || []).map((p) => parseFloat(p));
  if (percents.length >= 3 && percents.length <= 12) {
    const total = percents.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.5 && Math.abs(total - 100) < 25) {
      found.push({ name: 'percentages-do-not-total-100', total: Number(total.toFixed(1)) });
    }
  }

  // Chart scaffolding nobody relabelled.
  const defaults = ['Series 1', 'Series1', 'series_1', 'Column1', 'Untitled', 'Sheet1',
    'xlabel', 'ylabel', 'Category A', 'Category B', 'Label 1', 'Value 1'];
  const hits = defaults.filter((d) => text.includes(d));
  if (hits.length) found.push({ name: 'default-chart-labels', hits });

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
    } else if (weeks.every((w) => w % 2 === 0 || w % 5 === 0)) {
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
  const hasOwner = /\b(owner|dri|accountable|assigned to|author|lead)\b\s*[:\-]/i.test(text);
  const hasDate = /\b(20\d\d-\d\d-\d\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})/i.test(text);
  if (text.length > 800 && !hasOwner && !hasDate) {
    found.push({ name: 'no-owner-and-no-date' });
  }

  // TBDs sitting in a document that presents itself as finished.
  const tbd = (text.match(/\b(TBD|TBC|to be determined|to be confirmed|\[placeholder\]|\[insert)/gi) || []).length;
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
  const groups = {
    code: (s) => [...checkCode(s), ...checkOverbuilt(s)],
    data: checkData,
    spec: (s) => [...checkSpec(s), ...checkOverplanned(s)],
  };
  // A scope document can carry a table, and a README carries code. Run
  // everything and let the categories speak, rather than guessing once.
  const all = kind && groups[kind]
    ? groups[kind](text)
    : [...checkCode(text), ...checkOverbuilt(text), ...checkData(text), ...checkSpec(text), ...checkOverplanned(text)];

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

module.exports = { checkTechnical, checkCode, checkData, checkSpec, checkOverbuilt, checkOverplanned, guessKind };
