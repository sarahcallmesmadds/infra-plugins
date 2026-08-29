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

// Lowercase, and fold the typographic apostrophes and quote marks onto their
// straight equivalents, so "here’s" and "here's" compare equal.
function flattenQuotes(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"');
}

// A phrase inside quotation marks or inside code is being reported, not used.
// The house rules are a standing instruction about the author's own writing,
// and quoting the instruction back is not breaking it. `/pickup` prints those
// constraints verbatim at the start of every session and was blocked by its own
// rule for doing so, which is how this was found.
//
// Blanked to a space rather than deleted, so the text either side of a span is
// never joined into a match that was not in the original.
//
// Double quotes only. `flattenQuotes` has already folded the curly pair onto
// the straight one, so one pattern covers both. Single quotes are deliberately
// left alone: the apostrophe in "don't" would open a span that closes on the
// next contraction, and everything between two unrelated ordinary words would
// stop being checked.
//
// Bullets, headings and table rows stay checked, which is the difference
// between this and `proseOf`. A phrase in a list item is still the author using
// it, and a post written in bullets is the normal shape of the writing these
// rules exist for. Narrowing to `proseOf` here was the obvious repair and would
// have reintroduced what the list was added for on 2026-08-11: four drafts
// shipping with a ruled-out phrase and the tool reporting all four clean.
function withoutQuotedSpans(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ');
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
  // Both sides folded, so a list entry spelled with one apostrophe still finds
  // the other. Entries that carry both spellings, as FILLER does, collapse onto
  // each other here and are counted once rather than twice.
  const lower = flattenQuotes(haystack);
  const found = [];
  const seen = new Set();
  for (const needle of needles) {
    const flat = flattenQuotes(needle);
    if (seen.has(flat)) continue;
    seen.add(flat);
    const parts = lower.split(flat);
    if (parts.length > 1) found.push({ phrase: needle, count: parts.length - 1 });
  }
  return found;
}

// "Not X, but Y" and "It's not about X. It's about Y." Very common in machine
// prose, and rare at this density in a human draft.
//
// Both patterns here lead with "not", so only the negation-first order is
// detected. The reversed order, "what they actually are, not what the campaign
// is called", is a known gap and is deliberately not covered.
//
// A reversed pattern was added on 2026-08-11 and withdrawn on 2026-08-14, after
// review measured what it did to ordinary prose. It carried the antithesis
// category onto 16 of this repository's 41 markdown documents, from none, and
// moved four of them from "little" to "some". Every hit was normal writing:
// ", not the airbag", ", not instruction", ", not a standard tax on every
// installation".
//
// The diagnosis worth keeping is why, because it rules out the obvious repairs.
// The forward pattern is anchored by its explicit ", but" foil, and that anchor
// is the whole reason it stays rare. A bare ", not X" has no anchor, so it
// matches any negated afterthought, and "a comma then a short not-clause" is
// everyday English rather than a tic. No threshold separates them, because a
// restrictive appositive and the rhetorical tell are the same shape. Density
// does not either: CONTRIBUTING.md carries two in 307 words, the same rate as
// the short draft that prompted the pattern.
//
// Covering the reversed order needs an anchor of its own, and finding one is
// its own change rather than a line in a pull request about house rules. Queue
// entry 2026-08-14T18-44-05-tells carries it.
function antithesis(prose) {
  const patterns = [
    /\bnot (just |merely |only )?[^.,;]{3,40}, but\b/gi,
    /\bless [^.,;]{3,30} and more\b/gi,
  ];
  // Distinct spans, not a sum of per-pattern counts. Corrected 2026-08-14.
  //
  // Two patterns can read the same construction, and summing their counts
  // scored it twice, which is the whole threshold, so one sentence raised the
  // reading on its own when the bar was written to require two separate ones.
  // "The result is not less noisy and more useful, but simply different" gives
  // the first pattern "not less noisy and more useful, but" and the second
  // "less noisy and more", and the second sits inside the first.
  //
  // Overlapping spans merge transitively, so a construction matched by every
  // pattern still counts once, and two genuinely separate contrasts in the same
  // paragraph still count twice.
  const spans = [];
  for (const re of patterns) {
    for (const m of prose.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let count = 0;
  let reach = -1;
  for (const [start, end] of spans) {
    if (start >= reach) count += 1;
    if (end > reach) reach = end;
  }
  return count;
}

// The copular form, "it isn't X, it's Y", kept apart from the counting
// detector above because it is unmistakable. Nobody writes this by accident
// the way they write an incidental ", not Y", so one is worth reporting where
// the graded version needs two.
//
// Which restatements count was narrowed 2026-08-14, after review found the
// detector reporting on ordinary sentences at its threshold of one. Two ways
// in, and both came from writing the pronoun and its verb as loosely as
// possible:
//
//   an optional apostrophe let the possessive through, so "wasn't obvious at
//   first, its cause turned up later" read as a restatement;
//
//   a bare "that is" or "this is" opens an independent clause far more often
//   than it restates the thing just denied, so "isn't empty, that is why the
//   run stalled" and "wasn't broken by the patch, this is a known flake" both
//   reported.
//
// So the apostrophe is now required where the contracted form is what makes it
// contrastive, and the spaced form is allowed only for "it" and "they", which
// is where it genuinely restates. "that's a feature" is kept, because the
// contraction carries the same force; "that is" and "this is" are not. The two
// real hits in this repository's own documents, both "is not X, it is Y", are
// unaffected.
function copularAntithesis(prose) {
  const patterns = [
    /\bit'?s not (about )?[^.]{3,50}\. it'?s\b/gi,
    /\b(is|are|was|were)n'?t (just |merely |only )?[^.,;]{3,50}, (?:it(?:'s| is)|they(?:'re| are)|that's)\b/gi,
    /\b(is|are) not (just |merely |only )?[^.,;]{3,50}, (?:it|they) (?:is|are)\b/gi,
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

// A repeated list of sentence-shaped bold labels followed by explanatory copy.
// One styled bullet is ordinary Markdown. Two in a row is the brochure shape
// this detects, and the run is what makes it evidence rather than one writer's
// formatting preference.
//
// This reads the list before `proseOf` removes it. Fenced examples come out
// first, or a style guide showing the pattern would be reported for teaching it.
// A colon label such as "**Owner:** Billing" is deliberately outside the
// sentence-ending punctuation below, and a headline with no copy after it is
// outside too. The "that" or "where" cue is load-bearing as well. Without it,
// three ordinary bold instructions in find-skill/SKILL.md matched this detector
// exactly. Imperative leads are excluded for the same reason: "Verify that..."
// is an instruction, not a marketing headline.
const MARKDOWN_BOUNDARY = '\0';

function boundaryLine(indent) {
  return `${MARKDOWN_BOUNDARY}${indent}`;
}

function boundaryIndent(line) {
  return line.startsWith(MARKDOWN_BOUNDARY) ? Number(line.slice(1)) : null;
}

function backtickRunsWithLaterClose(lines) {
  const seenLengths = new Set();
  const withLaterClose = new Set();
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    if (!lines[lineIndex].trim() || startsInlineBlock(lines[lineIndex])) {
      seenLengths.clear();
      continue;
    }
    const runs = [...lines[lineIndex].matchAll(/`+/g)];
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
      const run = runs[runIndex];
      if (seenLengths.has(run[0].length)) withLaterClose.add(`${lineIndex}:${run.index}`);
      seenLengths.add(run[0].length);
    }
  }
  return withLaterClose;
}

function htmlCommentStart(line, lineIndex, codeDelimiter, withLaterClose, startIndex = 0) {
  for (let index = startIndex; index < line.length; index += 1) {
    if (line[index] === '`') {
      let end = index + 1;
      while (line[end] === '`') end += 1;
      const length = end - index;
      if (codeDelimiter === length) {
        codeDelimiter = null;
      } else if (codeDelimiter === null) {
        let escapes = 0;
        for (let before = index - 1; before >= 0 && line[before] === '\\'; before -= 1) escapes += 1;
        if (escapes % 2 === 0 && withLaterClose.has(`${lineIndex}:${index}`)) {
          codeDelimiter = length;
        }
      }
      // Whether this run opened code, closed it, or is unmatched literal text,
      // inspect it once. Advancing one backtick at a time made a long unmatched
      // run quadratic even though it cannot contain a comment opener.
      index = end - 1;
      continue;
    }
    if (codeDelimiter === null && line.startsWith('<!--', index)) {
      let escapes = 0;
      for (let before = index - 1; before >= 0 && line[before] === '\\'; before -= 1) escapes += 1;
      if (escapes % 2 === 1) continue;
      const linkOpen = line.lastIndexOf('](', index);
      const linkClose = line.lastIndexOf(')', index);
      if (linkOpen > linkClose) continue;
      return { index, codeDelimiter };
    }
  }
  return { index: -1, codeDelimiter };
}

const HTML_BLOCK_UNTIL_CLOSE = /^(?:script|pre|style|textarea)$/i;
const HTML_BLOCK_UNTIL_BLANK = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)$/i;

function rawHtmlBlockStart(line) {
  if (/^[ \t]*<\?/.test(line)) return { end: '?>', interruptsParagraph: true };
  if (/^[ \t]*<!\[CDATA\[/.test(line)) return { end: ']]>', interruptsParagraph: true };
  if (/^[ \t]*<![A-Z]/.test(line)) return { end: '>', interruptsParagraph: true };

  const tag = line.match(/^[ \t]*<(\/)?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|>|\/?>|$)/);
  if (tag && !tag[1] && HTML_BLOCK_UNTIL_CLOSE.test(tag[2])) {
    return { tag: tag[2].toLowerCase(), interruptsParagraph: true };
  }
  if (tag && HTML_BLOCK_UNTIL_BLANK.test(tag[2])) {
    return { untilBlank: true, interruptsParagraph: true };
  }

  // A complete open or closing tag for a custom element is CommonMark's
  // seventh HTML-block form. Unlike the forms above it cannot interrupt a
  // paragraph, so callers use the flag when deciding inline-code boundaries.
  if (/^[ \t]*<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/.test(line)) {
    return { untilBlank: true, interruptsParagraph: false };
  }
  return null;
}

function startsInlineBlock(line) {
  if (/^[ \t]*(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^[ \t]*<!--/.test(line)) return true;
  const html = rawHtmlBlockStart(line);
  return Boolean(html && html.interruptsParagraph);
}

function withoutFencedBlocks(text) {
  let fence = null;
  let htmlComment = null;
  let rawHtml = null;
  let inlineCodeDelimiter = null;
  let afterBlank = false;
  let paragraphBase = null;
  const visible = [];
  const listContentIndents = [];
  const lines = String(text || '').split(/\r?\n/);
  const withLaterClose = backtickRunsWithLaterClose(lines);

  const listParentAt = (indent) => {
    let index = listContentIndents.length - 1;
    while (index >= 0 && indent < listContentIndents[index]) index -= 1;
    return { index, base: index >= 0 ? listContentIndents[index] : 0 };
  };
  const rememberVisibleLine = (line) => {
    if (!line.trim()) {
      afterBlank = true;
      paragraphBase = null;
      return;
    }

    const marker = parseListMarker(line);
    if (marker) {
      const parent = listParentAt(marker.indent);
      if (marker.indent - parent.base <= 3) {
        listContentIndents.length = parent.index + 1;
        listContentIndents.push(marker.contentIndent);
        afterBlank = false;
        paragraphBase = marker.body ? marker.contentIndent : null;
        return;
      }
    }

    const indent = leadingSpaces(line);
    const parent = listParentAt(indent);
    const markdownBlock = startsMarkdownBlock(line) && indent - parent.base <= 3;
    if (afterBlank || markdownBlock) {
      listContentIndents.length = parent.index + 1;
    }
    paragraphBase = markdownBlock ? null : listParentAt(indent).base;
    afterBlank = false;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let line = lines[lineIndex];
    if (fence) {
      const close = line.match(/^([ \t]*)(`+|~+)\s*$/);
      const closeIndent = close ? leadingSpaces(line) : 0;
      if (close && closeIndent >= fence.base && closeIndent <= fence.base + 3
        && close[2][0] === fence.char && close[2].length >= fence.length) {
        fence = null;
      }
      visible.push('');
      paragraphBase = null;
      continue;
    }

    if (rawHtml) {
      if (rawHtml.untilBlank && !line.trim()) {
        rawHtml = null;
        afterBlank = true;
      } else if (rawHtml.end && line.includes(rawHtml.end)) {
        rawHtml = null;
      } else if (rawHtml.tag
        && new RegExp(`</${rawHtml.tag}(?:[ \\t]|>)`, 'i').test(line)) {
        rawHtml = null;
      }
      visible.push('');
      paragraphBase = null;
      continue;
    }

    // Whole-line HTML comments are Markdown blocks. Scan them only after fenced
    // code has been handled so a literal `<!--` in an example cannot hide all
    // visible prose that follows an unclosed example marker.
    if (htmlComment) {
      const close = line.indexOf('-->');
      if (close === -1) {
        visible.push('');
        continue;
      }
      const commentKind = htmlComment;
      htmlComment = false;
      if (commentKind === 'block') {
        visible.push('');
        paragraphBase = null;
        continue;
      }
      // An inline comment may close before another comment begins. Feed the
      // remainder through the ordinary scanner so none of that hidden copy is
      // mistaken for an explanation attached to a list headline.
      line = ' '.repeat(close + 3) + line.slice(close + 3);
    }

    // A fenced, commented, or raw-HTML block may begin in the body of a list
    // marker (`- ````, `- <!--`, or `- <div>`). Parse that body at the item's
    // content column, while emitting a boundary at the marker's column so the
    // hidden list item still separates its visible siblings.
    const marker = parseListMarker(line);
    let blockLine = line;
    let blockBoundaryIndent = null;
    let blockMarkerRemembered = false;
    if (marker && marker.body) {
      const markerParent = listParentAt(marker.indent);
      if (marker.indent - markerParent.base <= 3) {
        const candidate = `${' '.repeat(marker.contentIndent)}${marker.body}`;
        if (startsInlineBlock(candidate) || rawHtmlBlockStart(candidate)) {
          rememberVisibleLine(line);
          blockLine = candidate;
          blockBoundaryIndent = marker.indent;
          blockMarkerRemembered = true;
        }
      }
    }

    if (!blockLine.trim() || startsInlineBlock(blockLine)) inlineCodeDelimiter = null;
    const lineIndent = leadingSpaces(blockLine);
    const open = blockLine.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    const openIndent = open ? leadingSpaces(blockLine) : 0;
    const fenceParent = listParentAt(openIndent);
    const validFenceInfo = open && (open[2][0] === '~' || !open[3].includes('`'));
    if (inlineCodeDelimiter === null && validFenceInfo
      && openIndent - fenceParent.base <= 3) {
      fence = { char: open[2][0], length: open[2].length, base: fenceParent.base };
      listContentIndents.length = fenceParent.index + 1;
      visible.push(boundaryLine(blockBoundaryIndent ?? openIndent));
      afterBlank = false;
      paragraphBase = null;
      continue;
    }

    const htmlOpen = inlineCodeDelimiter === null ? rawHtmlBlockStart(blockLine) : null;
    const htmlParent = listParentAt(lineIndent);
    const typeSevenCanStart = blockMarkerRemembered || paragraphBase === null
      || paragraphBase !== htmlParent.base;
    if (htmlOpen && (htmlOpen.interruptsParagraph || typeSevenCanStart)
      && lineIndent - htmlParent.base <= 3) {
      const closesHere = (htmlOpen.end && blockLine.includes(htmlOpen.end))
        || (htmlOpen.tag && new RegExp(`</${htmlOpen.tag}(?:[ \\t]|>)`, 'i').test(blockLine));
      rawHtml = closesHere ? null : htmlOpen;
      listContentIndents.length = htmlParent.index + 1;
      visible.push(boundaryLine(blockBoundaryIndent ?? lineIndent));
      afterBlank = false;
      paragraphBase = null;
      continue;
    }

    const commentParent = listParentAt(lineIndent);
    // Four columns beyond the containing list item make an indented code block.
    // Treat a comment-looking string there as code; a comment at the same raw
    // indentation can still be Markdown when it is nested inside a list.
    let remaining = blockLine;
    let scanStart = 0;
    let foundComment = false;
    let blockCommentLine = false;
    let commentScan = htmlCommentStart(
      remaining, lineIndex, inlineCodeDelimiter, withLaterClose, scanStart
    );
    inlineCodeDelimiter = commentScan.codeDelimiter;
    while (commentScan.index !== -1 && lineIndent - commentParent.base <= 3) {
      foundComment = true;
      const comment = commentScan.index;
      const close = remaining.indexOf('-->', comment + 4);
      const before = remaining.slice(0, comment);
      const blockComment = !before.trim();
      htmlComment = close === -1 ? (blockComment ? 'block' : 'inline') : null;
      if (blockComment) {
        listContentIndents.length = commentParent.index + 1;
        visible.push(boundaryLine(blockBoundaryIndent ?? lineIndent));
        afterBlank = false;
        paragraphBase = null;
        blockCommentLine = true;
        break;
      }
      if (close === -1) {
        remaining = before;
        break;
      }
      remaining = before + ' '.repeat(close + 3 - comment) + remaining.slice(close + 3);
      scanStart = close + 3;
      commentScan = htmlCommentStart(
        remaining, lineIndex, inlineCodeDelimiter, withLaterClose, scanStart
      );
      inlineCodeDelimiter = commentScan.codeDelimiter;
    }
    if (blockCommentLine) continue;
    if (foundComment) {
      if (remaining.trim()) rememberVisibleLine(remaining);
      else listContentIndents.length = commentParent.index + 1;
      visible.push(remaining.trim() ? remaining : boundaryLine(blockBoundaryIndent ?? lineIndent));
      afterBlank = false;
      continue;
    }

    visible.push(line);
    if (!blockMarkerRemembered) rememberVisibleLine(line);
  }

  return visible;
}

function startsMarkdownBlock(line) {
  return /^[ \t]*(?:#{1,6}(?:\s|$)|>|\d{1,9}[.)](?:\s|$)|\|)/.test(line)
    || /^[ \t]*(?:(?:\*\s*){3,}|(?:_\s*){3,}|(?:-\s*){3,}|=+)\s*$/.test(line)
    || /^[ \t]*<(?:!DOCTYPE\b|\?|\/?[A-Za-z][A-Za-z0-9-]*(?:\s|>|\/))/i.test(line);
}

function leadingSpaces(line) {
  return columnsAfter(0, (line.match(/^[ \t]*/) || [''])[0]);
}

function columnsAfter(start, whitespace) {
  let column = start;
  for (const character of whitespace) {
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1;
  }
  return column;
}

function parseListMarker(line) {
  const marker = line.match(/^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/);
  if (!marker) return null;

  const indent = columnsAfter(0, marker[1]);
  const afterMarker = indent + marker[2].length;
  const contentIndent = marker[3] ? columnsAfter(afterMarker, marker[3]) : afterMarker + 1;
  const padding = contentIndent - afterMarker;

  return {
    type: /^[-*+]$/.test(marker[2]) ? 'unordered' : 'ordered',
    bullet: marker[2],
    indent,
    contentIndent: padding <= 4 ? contentIndent : afterMarker + 1,
    body: padding <= 4 ? (marker[4] || '') : '',
  };
}

function brochureItem(body) {
  const labelled = body.trim().match(/^(\*\*|__)(.+?[.!?])\1\s+(.+)$/);
  if (!labelled) return false;

  const headlineWords = wordsIn(labelled[2]).length;
  const explanationWords = wordsIn(labelled[3]).length;
  return brochureHeadline(labelled[2]) && headlineWords >= 3 && headlineWords <= 12
    && explanationWords >= 4;
}

function brochureHeadline(headline) {
  // "Where the records live" names a place as a marketing headline. "Where
  // possible, reuse the client" is an instruction. Requiring a determiner is
  // narrow on purpose: a soft signal that stands alone should prefer silence
  // over guessing at the grammar.
  if (/^where\s+(?:the|this|these|those|your|our|their)\b/i.test(headline)
    && !/[,;:]/.test(headline)) return true;

  // In the reported pattern, `that` is the subject of a relative clause:
  // "Numbers that guide" and "Reporting that drives". In an instruction such
  // as "Remember that the cache is warm", a new subject follows `that`. Keeping
  // only the direct-relative form avoids an open-ended list of imperative verbs.
  const relational = headline.match(/^(.+?)\s+that\s+(\S+)/i);
  if (!relational || /^(?:a|an|each|every|he|it|no|our|she|that|the|their|these|they|this|those|we|you|your)\b/i
    .test(relational[2])) return false;

  const subject = relational[1].trim();
  const words = wordsIn(subject);
  if (words.length > 1) return /^(?:a|an|the|this|these|those|your|our|their)\b/i.test(subject);
  return /(?:[^s]s|ing|tion|ment|ness|ity|ance|ence)$/i.test(subject)
    || /^(?:content|copy|data|software)$/i.test(subject);
}

function brochureBulletHeadlines(text) {
  const visible = withoutFencedBlocks(text);
  let repeated = 0;
  let nextItemId = 1;
  const stack = [];
  const runs = new Map();

  const contextPrefix = (parent) => `${parent ? parent.id : 'root'}:unordered:`;
  const contextKey = (parent, bullet) => `${contextPrefix(parent)}${bullet}`;
  const finishContext = (key) => {
    const run = runs.get(key) || 0;
    if (run >= 2) repeated += run;
    runs.delete(key);
  };
  const finishContexts = (parent, except = null) => {
    for (const key of [...runs.keys()]) {
      if (key.startsWith(contextPrefix(parent)) && key !== except) finishContext(key);
    }
  };
  const finishItem = (item) => {
    const key = contextKey(item.parent, item.bullet);
    if (item.type === 'unordered' && brochureItem(item.body)) {
      runs.set(key, (runs.get(key) || 0) + 1);
    } else {
      finishContext(key);
    }
    // Every child list is complete when its parent item closes.
    finishContexts(item);
  };
  const popItem = () => finishItem(stack.pop());
  const popToIndent = (indent) => {
    let popped = 0;
    while (stack.length && indent < stack[stack.length - 1].contentIndent) {
      popItem();
      popped += 1;
    }
    return popped;
  };
  const interruptRoot = () => {
    while (stack.length) popItem();
    finishContexts(null);
  };

  for (const line of visible) {
    if (!line.trim()) {
      if (stack.length) {
        stack[stack.length - 1].paragraphOpen = false;
        stack[stack.length - 1].afterBlank = true;
      }
      continue;
    }

    let marker = parseListMarker(line);
    if (marker) {
      let parentIndex = stack.length - 1;
      while (parentIndex >= 0 && marker.indent < stack[parentIndex].contentIndent) parentIndex -= 1;
      // Four columns beyond the containing list item are an indented code
      // block. Apply that cutoff at every list depth, not just at the root.
      const parentBase = parentIndex >= 0 ? stack[parentIndex].contentIndent : 0;
      if (marker.indent - parentBase > 3) marker = null;
      else while (stack.length - 1 > parentIndex) popItem();
    }
    if (marker) {
      const parent = stack.length ? stack[stack.length - 1] : null;
      if (parent) parent.paragraphOpen = false;
      if (marker.type === 'ordered') finishContexts(parent);
      else finishContexts(parent, contextKey(parent, marker.bullet));
      stack.push({
        ...marker,
        id: nextItemId,
        parent,
        paragraphOpen: true,
        afterBlank: false,
      });
      nextItemId += 1;
      continue;
    }

    const boundary = boundaryIndent(line);
    const indent = boundary !== null ? boundary : leadingSpaces(line);
    let block = boundary !== null || startsMarkdownBlock(line);
    if (block && boundary === null) {
      let parentIndex = stack.length - 1;
      while (parentIndex >= 0 && indent < stack[parentIndex].contentIndent) parentIndex -= 1;
      const parentBase = parentIndex >= 0 ? stack[parentIndex].contentIndent : 0;
      if (indent - parentBase > 3) block = false;
    }
    if (block) {
      const popped = popToIndent(indent);
      if (popped && stack.length) finishContexts(stack[stack.length - 1]);
      if (stack.length) {
        stack[stack.length - 1].paragraphOpen = false;
        stack[stack.length - 1].afterBlank = false;
      } else {
        finishContexts(null);
      }
      continue;
    }

    if (stack.length) {
      let item = stack[stack.length - 1];
      if (item.paragraphOpen && !item.afterBlank) {
        item.body += ` ${line.trim()}`;
        continue;
      }

      const indent = leadingSpaces(line);
      if (item.afterBlank && indent - item.contentIndent >= 4) {
        item.paragraphOpen = false;
        continue;
      }
      const popped = popToIndent(indent);
      if (popped && stack.length) finishContexts(stack[stack.length - 1]);
      if (stack.length) {
        item = stack[stack.length - 1];
        item.body += ` ${line.trim()}`;
        item.paragraphOpen = true;
        item.afterBlank = false;
        continue;
      }
    }

    interruptRoot();
  }

  while (stack.length) popItem();
  for (const key of [...runs.keys()]) finishContext(key);
  return repeated >= 2 ? { count: repeated, standalone: true } : null;
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

  // Standing instructions about her own writing, not machine tells. One hit is
  // the whole threshold, because a phrase she has ruled out does not become a
  // violation on the second use. `bannedPhrases` in the config adds to the
  // built-in list rather than replacing it, so adding one later cannot silently
  // drop the others.
  if (config.houseRules !== false) {
    const extra = Array.isArray(config.bannedPhrases) ? config.bannedPhrases : [];
    // Both sides are flattened to a straight apostrophe before comparing, so a
    // phrase typed with a smart quote cannot walk past a list that spells it
    // straight, or the reverse. The soft lists solve this by carrying both
    // spellings of each entry, which works because nobody adds to them at
    // runtime. `bannedPhrases` is configured by hand, and asking somebody to
    // remember to write their phrase twice is a rule that fails quietly.
    const banned = [...P.HOUSE_RULES, ...extra].map((p) => flattenQuotes(String(p)));
    // Quoted spans and code come out before matching, so a mention of a rule is
    // not read as a use of it. See `withoutQuotedSpans` for why that is not
    // `proseOf`. Removing this narrowing puts the check back to blocking any
    // document that quotes the rules, this repository's own included.
    const lower = withoutQuotedSpans(flattenQuotes(String(text || '')));
    const hits = banned.filter((p) => p && lower.includes(p));
    if (hits.length) {
      violations.push({
        name: 'house-rule',
        count: hits.length,
        // The bare list as well as the sentence. `what` is prose written for
        // the hook, which says it once in a message it composes itself, and a
        // reader that wants only the phrases had to unpick them back out of
        // that sentence. The report needs them without the framing, because
        // the framing is the part that is wrong when the document under review
        // belongs to somebody else.
        phrases: hits,
        what: `phrases ruled out for this author (${hits.join(', ')})`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// Everything, hard and soft. This is what the skill reports.
function checkAll(text, config = {}) {
  const hard = checkHard(text, config);
  // Folded once, here, rather than inside each detector. Every soft check below
  // reads this string, and the regex ones spell the apostrophe as `'?`, which
  // matches a straight quote or nothing and never a curly one. Text pasted out
  // of a post or a word processor is the normal case for this tool, so a
  // detector that only sees straight quotes sees roughly nothing.
  //
  // The typographic-quotes signal further down deliberately reads the raw text
  // instead, since folding is exactly what would hide it from itself.
  const prose = flattenQuotes(proseOf(text));

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

  const copular = copularAntithesis(prose);
  if (copular >= 1) soft.push({ name: 'antithesis-copular', count: copular });

  const three = ruleOfThree(prose);
  if (three >= 3) soft.push({ name: 'rule-of-three', count: three });

  const brochureBullets = brochureBulletHeadlines(text);
  if (brochureBullets) {
    soft.push({ name: 'brochure-style-bullet-headlines', ...brochureBullets });
  }

  const rhythm = uniformRhythm(prose);
  if (rhythm) soft.push({ name: 'uniform-rhythm', ...rhythm });

  const smart = (String(text).match(/[‘’“”]/g) || []).length;
  if (smart >= 6) soft.push({ name: 'typographic-quotes-throughout', count: smart });

  // Distinct categories, not raw hits. One phrase repeated ten times is one
  // habit; six different categories at once is a pattern. A detector may mark
  // itself standalone only after it has already aggregated a repeated structure
  // with its own false-positive guard. That can support "some" on its own, but
  // never "strong".
  const categories = soft.length;
  const standalone = soft.some((finding) => finding.standalone === true);
  const reading =
    categories >= 4 ? 'strong' : categories >= 2 || standalone ? 'some' : 'little';

  return { hard: hard.violations, soft, categories, reading };
}

module.exports = { checkHard, checkAll, proseOf, sentencesOf, EM_DASH };
