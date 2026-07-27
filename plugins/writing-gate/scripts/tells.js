// Detect the patterns that make writing read as unedited machine output.
//
// Two tiers, deliberately kept apart.
//
// HARD tells are unambiguous and mechanical. An em dash is either present or
// it is not. These can be enforced, and the hook blocks on them.
//
// SOFT tells are aggregate signals. Any one of them appears in perfectly good
// human writing, and treating a single hit as evidence produces nonsense. They
// are counted and reported, never enforced, and they only mean anything
// together.

'use strict';

const EM_DASH = String.fromCharCode(0x2014);

// Strip anything that is not prose: code, quotes, headings, lists, tables.
// A style rule about sentence rhythm has no business judging a bullet list.
function proseOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^[-*>#|]/.test(t)) return false;
      if (/^\d+\.\s/.test(t)) return false;
      return true;
    })
    .join(' ');
}

function sentencesOf(prose) {
  return prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordsIn(sentence) {
  return sentence.split(/\s+/).filter((w) => /\w/.test(w));
}

// --- hard tells ------------------------------------------------------------

function emDashes(text) {
  const count = String(text || '').split(EM_DASH).length - 1;
  return count > 0 ? { name: 'em-dash', count, what: `${count} em dash${count === 1 ? '' : 'es'}` } : null;
}

function choppyRun(text, limit) {
  // Zero or below turns the rule off. Without this, `worst >= 0` is always
  // true and setting the limit to zero would flag every piece of text, which
  // is the exact opposite of what someone setting it to zero wants.
  if (!(limit > 0)) return null;
  const sentences = sentencesOf(proseOf(text));
  let run = 0;
  let worst = 0;
  for (const s of sentences) {
    const n = wordsIn(s).length;
    if (n > 0 && n < 4) {
      run += 1;
      if (run > worst) worst = run;
    } else {
      run = 0;
    }
  }
  return worst >= limit
    ? { name: 'choppy-run', count: worst, what: `a run of ${worst} sentences under four words` }
    : null;
}

// --- soft tells ------------------------------------------------------------

const P = require('./patterns.js');

function countPhrases(haystack, needles) {
  const lower = haystack.toLowerCase();
  const found = [];
  for (const needle of needles) {
    const parts = lower.split(needle);
    if (parts.length > 1) found.push({ phrase: needle, count: parts.length - 1 });
  }
  return found;
}

// "Not X, but Y" and "It's not about X. It's about Y." Very common in machine
// prose, and rare at this density in a human draft.
function antithesis(prose) {
  const patterns = [
    /\bnot (just |merely |only )?[^.,;]{3,40}, but\b/gi,
    /\bit'?s not (about )?[^.]{3,50}\. it'?s\b/gi,
    /\bless [^.,;]{3,30} and more\b/gi,
  ];
  let count = 0;
  for (const re of patterns) count += (prose.match(re) || []).length;
  return count;
}

// Three items in a row, repeatedly. One list of three is fine. Five are a tic.
function ruleOfThree(prose) {
  const re = /\b[\w'-]+, [\w'-]+,? and [\w'-]+\b/gi;
  return (prose.match(re) || []).length;
}

// Human paragraphs breathe unevenly. Near-identical sentence lengths across a
// whole document is the least visible tell and one of the most reliable.
function uniformRhythm(prose) {
  const lengths = sentencesOf(prose).map((s) => wordsIn(s).length).filter((n) => n > 2);
  if (lengths.length < 8) return null;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const spread = Math.sqrt(variance) / mean;
  return spread < 0.35
    ? { spread: Number(spread.toFixed(2)), sentences: lengths.length, mean: Math.round(mean) }
    : null;
}

// --- the two entry points --------------------------------------------------

// Hard tells only. This is what the hook enforces.
function checkHard(text, config = {}) {
  // `??` rather than `||`, so a configured 0 means "turn this rule off"
  // instead of silently falling back to the default.
  const limit = config.choppyRunLimit ?? 3;
  const violations = [];

  if (config.allowEmDash !== true) {
    const em = emDashes(text);
    if (em) violations.push(em);
  }
  const choppy = choppyRun(text, limit);
  if (choppy) violations.push(choppy);

  // Leftovers from the tool that produced the text: citation stubs, refusal
  // boilerplate, model self-references. Unlike everything else here these are
  // not a matter of taste. Nobody types "oaicite" by hand, so one is enough.
  const artefacts = P.TOOL_ARTEFACTS.filter((a) => text.includes(a));
  if (artefacts.length) {
    violations.push({
      name: 'tool-artefact',
      count: artefacts.length,
      what: `left-in generation artefacts (${artefacts.join(', ')})`,
    });
  }

  return { ok: violations.length === 0, violations };
}

// Everything, hard and soft. This is what the skill reports.
function checkAll(text, config = {}) {
  const hard = checkHard(text, config);
  const prose = proseOf(text);

  const soft = [];
  const band = (name, list, threshold) => {
    const hits = countPhrases(prose, list);
    if (hits.length >= threshold) soft.push({ name, hits });
  };

  band('filler', P.FILLER, 1);
  band('generic-vocabulary', P.VOCABULARY, 2);
  band('hedging', P.HEDGES, 2);
  band('avoiding-plain-is-and-has', P.COPULA_AVOIDANCE, 2);
  band('inflated-significance', P.SIGNIFICANCE, 1);
  band('participle-tacked-on-the-end', P.PARTICIPLE_TACK, 2);
  band('sourced-to-nobody', P.WEASEL_ATTRIBUTION, 1);
  band('forced-enthusiasm', P.FAKE_ENTHUSIASM, 1);
  band('melodramatic-pivot', P.MELODRAMA, 1);

  const anti = antithesis(prose);
  if (anti >= 2) soft.push({ name: 'antithesis', count: anti });

  const three = ruleOfThree(prose);
  if (three >= 3) soft.push({ name: 'rule-of-three', count: three });

  const rhythm = uniformRhythm(prose);
  if (rhythm) soft.push({ name: 'uniform-rhythm', ...rhythm });

  const smart = (String(text).match(/[‘’“”]/g) || []).length;
  if (smart >= 6) soft.push({ name: 'typographic-quotes-throughout', count: smart });

  // Distinct categories, not raw hits. One phrase repeated ten times is one
  // habit; six different categories at once is a pattern.
  const categories = soft.length;
  const reading =
    categories >= 4 ? 'strong' : categories >= 2 ? 'some' : 'little';

  return { hard: hard.violations, soft, categories, reading };
}

module.exports = { checkHard, checkAll, proseOf, sentencesOf, EM_DASH };
