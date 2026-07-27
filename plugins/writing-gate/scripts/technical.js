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
  const groups = { code: checkCode, data: checkData, spec: checkSpec };
  // A scope document can carry a table, and a README carries code. Run
  // everything and let the categories speak, rather than guessing once.
  const all = kind && groups[kind]
    ? groups[kind](text)
    : [...checkCode(text), ...checkData(text), ...checkSpec(text)];

  const hard = all.filter((f) => f.hard);
  const soft = all.filter((f) => !f.hard);

  // One checkable problem is worth reporting but is not a verdict: a single
  // placeholder can be a genuine template, and one broad catch can be a
  // considered decision. The reading only goes strong when the signals stack.
  const reading =
    hard.length >= 2 || (hard.length >= 1 && soft.length >= 2) || soft.length >= 4
      ? 'strong'
      : hard.length >= 1 || soft.length >= 2
        ? 'some'
        : 'little';

  return { hard, soft, categories: all.length, reading };
}

module.exports = { checkTechnical, checkCode, checkData, checkSpec, guessKind };
