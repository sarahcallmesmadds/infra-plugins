// Blank out the quoted text and the regular expressions in a source file, so
// what remains is the part of it that addresses a reader.
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
// The distinction drawn here is between text a program handles and text that
// addresses a person. A string literal and a regular expression are data: the
// program compares them, stores them, prints them. They are written in machine
// syntax, and `/\b(ignore|disregard)\b/i` is not a sentence anybody could act
// on. A comment is the opposite. It is prose, written to be read, and it is
// exactly where an instruction aimed at a model would be put, so comments stay
// scanned in full. That is the whole rule.
//
// The cost, stated plainly rather than buried: an injection hidden inside a
// string literal in a source file is no longer reported. That is a real gap
// and it is the price of the rule. It is accepted because the alternative,
// warning on every catalogue, trains the reader to skim the next warning, and
// a warning that gets skimmed protects nothing. Comments remain the more
// natural hiding place and remain covered.
//
// Only the JavaScript and TypeScript family is handled. Other languages quote
// and comment differently, and a lexer that half understands a language would
// blank the wrong spans, which fails silently in the direction of missing real
// injection. Anything else is scanned exactly as before. Every reproduction of
// this false positive so far has been a .js file.

'use strict';

const SOURCE_EXTENSION = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;

function isSourceFile(filePath) {
  return typeof filePath === 'string' && SOURCE_EXTENSION.test(filePath);
}

// Whether a `/` at this point opens a regular expression or divides. The
// question cannot be answered without knowing the previous token, and getting
// it wrong in the permissive direction would blank the rest of the file. So
// the list below is the set of characters after which a regular expression is
// genuinely possible, and everything else, notably an identifier, a closing
// bracket or a digit, means division.
const REGEX_MAY_FOLLOW = /[(,=:[!&|?{};+\-*%~^<>]/;

function regexCanStartAfter(previous) {
  return previous === '' || REGEX_MAY_FOLLOW.test(previous);
}

// Returns a copy of `source` the same length, with the inside of every string,
// template and regular expression replaced by `x`. Length is preserved so a
// match found in the copy can be reported from the original at the same
// offset, and newlines are kept so line numbers and excerpts still line up.
function maskCodeLiterals(source) {
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

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i + 1;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        // An unterminated quote on one line is a quote character in prose far
        // more often than it is a string running to the end of the file, and
        // running away with it would blank everything after an apostrophe.
        if (quote !== '`' && source[i] === '\n') break;
        i += 1;
      }
      blank(start, i);
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
