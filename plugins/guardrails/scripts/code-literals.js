// Blank out the regular expressions in a source file, and nothing else.
//
// The problem this solves is the scanner firing on security tooling, including
// its own source. A pattern catalogue is a list of the phrases an attacker
// uses, so a detector that reads it finds every one of them and reports a file
// whose entire purpose is defence. It happened twice in one triage session and
// again while this was being written, on this repository.
//
// Excluding by directory does not work and was tried. The property that trips
// the scanner is the file's content, not its location, so an exclusion has to
// be extended for every new place a catalogue turns up and is wrong the moment
// somebody else's scanner is reviewed.
//
// Only regular expressions are blanked, and the reason is that a regular
// expression cannot be an instruction. `/\b(ignore|disregard)\b/i` is machine
// syntax for matching text. There is no reading of it under which somebody
// does what it says, so treating a match inside one as a declaration is not a
// judgement call about intent.
//
// A string literal is not like that, and an earlier version of this file
// blanked those too. It was wrong. A string can hold a sentence, a prompt
// constant, or an entire instruction written to be read later, and blanking
// them meant an injection sitting in a quoted string in any .js file passed
// the scan in silence, on Write and Edit as well as on Read. In a codebase
// full of prompts held in source that is not an acceptable trade, and the
// version that made it never said so out loud in the place it mattered. So
// strings are scanned, comments are scanned, and everything outside a regular
// expression is scanned exactly as it was before.
//
// What that costs is honest noise rather than a silent gap. A file holding
// injection strings as test fixtures still reports, because from the outside
// it is indistinguishable from a file holding injection strings for real.
// injectionExcludePaths in ~/.claude/guardrails.config.json is the release
// valve for a specific file, and it stays a decision somebody makes on
// purpose rather than a rule that quietly stops looking.
//
// Only the JavaScript and TypeScript family is handled. Other languages quote
// and comment differently, and a lexer that half understands a language would
// blank the wrong spans, which fails silently in the direction of missing real
// injection. Anything else is scanned exactly as before. Every reproduction of
// this false positive so far has been a .js file.

'use strict';

// No .jsx and no .tsx. Markup breaks the one heuristic this file depends on:
// every closing tag is written `</`, so the slash reads as opening a regular
// expression and the mask runs to the next slash on the line, which is the
// next closing tag. Text between two tags, the words actually on the screen,
// got blanked and stopped being scanned. That is the failure this file's
// header warns about, arriving through the door it was watching.
const SOURCE_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts)$/i;

// Markup living in a plain .js or .ts file, which older React code does all
// the time. The extension cannot rule it out, so the content is checked, and
// a file that looks like markup is not masked at all. Scanning too much is a
// false positive somebody can see and argue with. Scanning too little is
// silent, and between the two there is no contest.
const LOOKS_LIKE_MARKUP = /<\/[A-Za-z]|\/>/;

function isSourceFile(filePath) {
  return typeof filePath === 'string' && SOURCE_EXTENSION.test(filePath);
}

// Whether a `/` at this point opens a regular expression or divides. The
// question cannot be answered without knowing the previous token, and getting
// it wrong in the permissive direction would blank the rest of the file. So
// the list below is the set of characters after which a regular expression is
// genuinely possible, and everything else, notably an identifier, a closing
// bracket or a digit, means division.
//
// `<` is deliberately absent, and `>` deliberately present. `>` is there for
// the arrow in `x => /abc/.test(x)`, which is everywhere. `<` would only be
// there for `a < /re/.source.length`, which is nothing anybody writes, and
// leaving it in made every `</` in a piece of markup open an expression.
// Dropping it costs at worst a real regular expression going unmasked, which
// shows up as a warning somebody reads. Keeping it cost text going unscanned,
// which shows up as nothing at all.
const REGEX_MAY_FOLLOW = /[(,=:[!&|?{};+\-*%~^>]/;

// A regular expression longer than this is treated as a division sign after
// all. Nothing here is a judgement about style: it is a blast radius. Every
// expression in this plugin's own catalogue fits inside a fraction of it, and
// the point of the cap is that a misread slash can now blank at most a few
// lines rather than the remainder of a file.
const LONGEST_PLAUSIBLE_REGEX = 400;

function regexCanStartAfter(previous) {
  return previous === '' || REGEX_MAY_FOLLOW.test(previous);
}

// Returns a copy of `source` the same length, with the inside of every regular
// expression replaced by `x`. Length is preserved so a match found in the copy
// can be reported from the original at the same offset, and newlines are kept
// so line numbers and excerpts still line up.
//
// Strings and comments are walked but left intact. Walking them is not
// optional even though nothing is blanked: a `/` inside a string or a comment
// would otherwise be read as opening a regular expression, and the mask would
// run from there to the next `/` anywhere in the file, blanking real prose on
// the way. Skipping them is what keeps the blanking confined.
function maskCodeLiterals(source) {
  if (LOOKS_LIKE_MARKUP.test(source)) return source;

  const out = source.split('');
  const n = source.length;
  let i = 0;
  let previous = '';

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = 'x';
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Comments are left exactly as they are. They are prose.
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // Walked, not blanked. The contents stay scannable; stepping over them is
    // only so a `/` inside a string cannot be mistaken for a regular
    // expression opening.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        // An unterminated quote on one line is a quote character in prose far
        // more often than it is a string running to the end of the file, and
        // running away with it would step over everything after an apostrophe.
        if (quote !== '`' && source[i] === '\n') break;
        i += 1;
      }
      i += 1;
      previous = quote;
      continue;
    }

    if (ch === '/' && regexCanStartAfter(previous)) {
      const start = i + 1;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; break; }
        if (j - start > LONGEST_PLAUSIBLE_REGEX) break;
        j += 1;
      }
      // An unclosed `/` is division after all, whatever came before it.
      if (closed) {
        blank(start, j);
        i = j + 1;
        previous = '/';
        continue;
      }
    }

    if (!/\s/.test(ch)) previous = ch;
    i += 1;
  }

  return out.join('');
}

module.exports = { maskCodeLiterals, isSourceFile };
