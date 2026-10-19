// Structural tells: the shapes a document can carry while every sentence in it
// passes the lexical checks in tells.js.
//
// On 2026-10-19 a concept brief came back "Hard rules: clean... Softer tells:
// none worth reporting" and its author called it machine writing on sight. The
// habits she named were all above the sentence: a short sentence that announces
// a point the next sentence then makes, one idea restated section by section,
// the same list enumerated in prose and again in a table, and an opening
// paragraph about the event rather than the subject. None of those is visible
// to a phrase list or a sentence-length rule, which is why the lexical checks
// reported nothing.
//
// Two tiers, and the split matters more than any threshold. A detector with
// an anchor, a construction that ordinary prose rarely produces by accident,
// reports a SOFT category that counts toward the reading. A detector whose
// shape good writing also produces reports a QUESTION: printed with its
// evidence, never counted, so a reader with the document in front of them
// decides. Review of the plan for this file found that "report as a question"
// changes nothing while the finding still feeds the scorer, which is why the
// two come back in separate lists. Nothing here is enforced by the Stop hook.
//
// The thresholds were set by running the detectors over the four rejected
// drafts and the approved final of that brief, and over this repository's own
// documents, and are recorded beside each detector.

'use strict';

// --- block model -----------------------------------------------------------
//
// A paragraph-level reading of Markdown, kept deliberately simpler than the
// list parser in tells.js. These checks need to know where paragraphs,
// headings, tables and lists start and stop; they never need CommonMark's
// answer about nested continuation lines.

// The inner span may not hold the bold delimiter: "Choose **the fast path**
// over **the safe path**" starts and ends with emphasis and is a sentence,
// not a heading, and reading it as one both hid it from the prose checks and
// cut a section boundary nothing else could see. Single-asterisk emphasis
// inside is fine: "**Before *leaving* safely**" is a heading with a word in
// italics.
const BOLD_ONLY = /^(?:\*\*(?!\s)((?:(?!\*\*).)+)\*\*|__(?!\s)((?:(?!__).)+)__):?\s*$/;
const ITALIC_ONLY = /^(?:\*(?!\s)([^*]+)\*|_(?!\s)([^_]+)_)\s*$/;

// Fenced code, HTML blocks, comments and code spans are read by the same
// pass tells.js uses for the brochure check, which has been through its own
// review rounds for exactly these shapes. A scanner written here for the same
// job absorbed fourteen findings across five rounds (CRLF endings, markers
// inside comments, openers inside spans, indented openers, fences inside list
// items) before the lesson that it should not exist. The pass returns one
// entry per input line: visible lines as written, hidden lines as empty, a
// block boundary as a marker that reads as blank here, and a line whose
// inline comment closed before more text as that text with a continuation
// marker in front.
function visibleLines(text) {
  const tells = require('./tells.js');
  const raw = tells.withoutFencedBlocks(String(text || '').replace(/\r\n?/g, '\n'));
  const out = [];
  raw.forEach((line, i) => {
    if (line.startsWith(tells.MARKDOWN_BOUNDARY)) {
      // A hidden line with visible text directly above and below it, such as
      // a comment on its own line inside a paragraph, is dropped rather than
      // read as a blank: a blank would split the paragraph in two and hand
      // the paragraph checks a boundary the reader never sees.
      const above = i > 0 && raw[i - 1].trim() && !raw[i - 1].startsWith(tells.MARKDOWN_BOUNDARY);
      const below = i + 1 < raw.length && raw[i + 1].trim() && !raw[i + 1].startsWith(tells.MARKDOWN_BOUNDARY);
      if (!(above && below)) out.push('');
      return;
    }
    if (line.startsWith(tells.MARKDOWN_PARAGRAPH_CONTINUATION)) {
      out.push(line.slice(1));
      return;
    }
    out.push(line);
  });
  return out;
}


function lineKind(raw) {
  const line = raw.trim();
  if (!line) return 'blank';
  if (/^#{1,6}\s/.test(line)) return 'heading';
  if (/^(?:[-*+]|\d{1,3}[.)])\s/.test(line)) return 'list';
  // An indented line without a marker continues whatever block is open; the
  // block loop folds it into the list item above, keeps it in an open
  // paragraph, and otherwise reads four columns of it as code.
  if (/^\s/.test(raw)) return 'continuation';
  if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line)) return 'rule';
  if (/^\[\^[^\]]+\]:/.test(line)) return 'note';
  if (/^>/.test(line)) return 'quote';
  if (BOLD_ONLY.test(line)) return 'heading';
  // A short italic line under a title is a subtitle. An italic sentence is a
  // paragraph: draft 1 of the brief that prompted this file set its event
  // logistics in italics, and reading that as a subtitle would have hidden the
  // very paragraph check F exists for. Any sentence punctuation disqualifies,
  // because a one-sentence italic line ends in a period followed by the
  // closing asterisk and not by a space.
  if (ITALIC_ONLY.test(line) && wordsOf(line).length <= 8 && !/[.!?]/.test(line)) return 'subtitle';
  return 'text';
}

function wordsOf(s) {
  return String(s).split(/\s+/).filter((w) => /\w/.test(w));
}

// Inline markup out, words kept: **x** and *x* and [x](y) become x. A code
// span becomes a space, the way proseOf in tells.js drops it: the words inside
// backticks are an example being shown, and an announcing sentence quoted as
// code must not raise the reading of the prose around it.
function plain(s) {
  return String(s)
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/`[^`]*`/g, ' ')
    // The destination is bounded so a document that is nothing but unclosed
    // "[a](" fragments is read in linear time rather than rescanned to its
    // end from every bracket. 2,000 characters is far past any real URL.
    .replace(/!\[([^\]\n]*)\]\([^)\n]{0,2000}\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]{0,2000}\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<![\w])_(.+?)_(?![\w])/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingText(line) {
  const t = line.trim();
  const hash = t.match(/^#{1,6}\s+(.*)$/);
  if (hash) return plain(hash[1]).replace(/\s*:$/, '');
  const bold = t.match(BOLD_ONLY);
  if (bold) return plain(bold[1] || bold[2]).replace(/\s*:$/, '');
  return plain(t);
}

const SEPARATOR_ROW = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// A table is a run of lines carrying a pipe with a separator row among them,
// whether or not the outer pipes are written. A lone line starting with a
// pipe is prose, as CommonMark reads it; treating it as a table split the
// paragraph it wrapped in.
function unpipedTableLines(lines) {
  const table = new Set();
  let run = [];
  const flush = () => {
    if (run.some((i) => SEPARATOR_ROW.test(lines[i].trim()) && lines[i].includes('|'))) {
      for (const i of run) table.add(i);
    }
    run = [];
  };
  // A run stops at any line that is already another kind of block: a heading
  // that happens to hold a pipe is not the table's header row, and reading it
  // as one swallowed the heading and with it the section boundary.
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const kind = lineKind(raw);
    if (t && t.includes('|') && kind === 'text') run.push(i);
    else flush();
  });
  flush();
  return table;
}

function blocksOf(text) {
  const lines = visibleLines(text);
  const blocks = [];
  const unpiped = unpipedTableLines(lines);
  let current = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  // A setext heading is a text line with a line of = or - under it. The
  // underline alone reads as a rule and the title as prose, which left a
  // document organised that way with no sections at all: the list check could
  // never fire and the logistics check read the whole document as its opening.
  const setext = new Set();
  const underline = new Set();
  lines.forEach((raw, i) => {
    if (i === 0) return;
    // The title line has to open its paragraph: the line before it is blank,
    // a heading, or an underline of a previous setext heading. An underline
    // after the second line of a paragraph is a rule, as lineKind reads it.
    const before = i >= 2 ? lines[i - 2] : '';
    const opensParagraph = !before.trim() || lineKind(before) === 'heading' || underline.has(i - 2);
    if (/^\s*(?:=+|-+)\s*$/.test(raw) && lineKind(lines[i - 1]) === 'text' && !unpiped.has(i - 1)
      && opensParagraph) {
      setext.add(i - 1);
      underline.add(i);
    }
  });
  lines.forEach((raw, index) => {
    if (underline.has(index)) return;
    let kind = setext.has(index) ? 'heading' : unpiped.has(index) ? 'table' : lineKind(raw);
    // Four columns of indent at the start of a block is indented code, and
    // code is not prose, a heading or a list however it is shaped. Inside an
    // open block it is a wrapped line, a nested item or a continuation, and
    // stays with the block it continues.
    if (!current && kind !== 'blank' && /^(?: {4}|\t)/.test(raw)) kind = 'blank';
    if (kind === 'continuation') {
      if (current && current.kind === 'list') {
        // The wrapped line is kept apart from the item's first line with a
        // marker, so the item's words for matching come from the line the
        // author wrote as the item and a long continuation cannot lift the
        // match bar out of reach.
        current.lines[current.lines.length - 1] += ` \u0002${raw.trim()}`;
        return;
      }
      kind = current && current.kind === 'text' ? 'text'
        : /^(?: {4}|\t)/.test(raw) ? 'blank' : 'text';
    }
    // A bold-only line ending in sentence punctuation with prose directly
    // under it, no blank line between, is a run-in label and its paragraph:
    // "**Setup.**" over "Inspect the surface." is the shape the label checks
    // exist for, and reading it as a heading hid it from them and cut a
    // section. A bare "**Second**" over prose keeps its heading: the period
    // is the marker that separates the two, because a heading does not end
    // in one and a label does.
    // A bold-only line with prose directly above it, no blank between, is
    // the paragraph continuing, as CommonMark reads it; it opens nothing.
    if (kind === 'heading' && !/^\s*#/.test(raw) && !setext.has(index) && current && current.kind === 'text') {
      kind = 'text';
    }
    if (kind === 'heading' && /^\s*(?:\*\*|__).*[.:!?](?:\*\*|__)\s*$/.test(raw) && !setext.has(index)
      && index + 1 < lines.length && !underline.has(index + 1) && lineKind(lines[index + 1]) === 'text') {
      kind = 'text';
    }
    if (kind === 'blank' || kind === 'rule') {
      close();
      return;
    }
    // Headings and subtitles are one line each. Everything else runs until
    // the kind changes or a blank line closes it.
    if (kind === 'heading' || kind === 'subtitle') {
      close();
      blocks.push({ kind, lines: [raw.trim()], text: headingText(raw) });
      return;
    }
    if (current && current.kind === kind) {
      current.lines.push(raw.trim());
      return;
    }
    close();
    current = { kind, lines: [raw.trim()], text: '' };
  });
  close();
  for (const b of blocks) {
    if (b.kind === 'text' || b.kind === 'quote' || b.kind === 'note') {
      b.text = plain(b.lines.map((l) => l.replace(/^>\s?/, '')).join(' '));
    }
  }
  return blocks;
}

function sentencesIn(paragraphText) {
  return String(paragraphText)
    // Split after sentence punctuation before a capital, digit, quote,
    // bracket or emphasis marker, but not after an initial or a common
    // abbreviation: "vs. They lost" and "Mr. Smith" are one sentence.
    .split(/(?<=(?<!\b[A-Z])(?<!\b(?:vs|Mr|Mrs|Ms|Dr|No|Jr|Sr|St|etc|e\.g|i\.e|a\.m|p\.m|U\.S|D\.C))[.!?])\s+(?=[A-Z0-9"'(\u201c\u2018*_\[`])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- words -----------------------------------------------------------------

const STOP = new Set(('a an the and or but nor of to in on at for with from by as is are was were be been being '
  + 'it its this that these those we our ours you your yours they their theirs he she his her him them us me my i '
  + 'who whom whose which what where when how why will would can could should shall may might must do does did '
  + 'done not no nor so if then than there here has have had having into onto over under up out about more most '
  + 'much many some any all each every both either neither one also just only very too such same own other another '
  + 'because while before after since until though although whether per via get gets got let lets like via '
  + 'way something anything nothing everything someone anyone nobody everyone').split(' '));

// A crude stem is enough for "measure" and "measuring" to agree, and wrong in
// the harmless direction: it joins words that are not the same more often
// than it splits words that are, which errs toward reporting a restatement
// rather than missing one, and every report here quotes its evidence.
function stem(w) {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

function contentWords(s) {
  // Contractions lose their clitic before the stop list sees them, or "don't"
  // and "it's" count as content and "Don't skip" reappears wherever "skip"
  // does.
  return wordsOf(plain(s).toLowerCase().replace(/[^a-z0-9'\s-]/g, ' '))
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/n't$|'(?:s|re|ve|ll|d|m)$/, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);
}

// --- A. announce, then explain --------------------------------------------
//
// "It matters now because of what AI removes." and then the sentence that says
// what is removed. The author's instruction was to say the thing in the
// sentence, so the tell is a short sentence whose content is a placeholder,
// followed by the longer sentence that fills it.
//
// Two anchors, because a short sentence followed by a long one is most prose.
// Either the subject is a bare pronoun and the sentence ends on a tail that
// points forward ("is simple", "because of what X does", "makes it concrete",
// "already there"), or the grammatical subject is an abstract head noun
// (reason, point, example, thinking) that names the content without carrying
// it. "The queue is empty." has a pronoun-free subject and no forward tail, so
// it is not a candidate however long the next sentence is.

// Every alternative runs to the end of the sentence. The adjective tails end
// it themselves ("is simple."), and the clause tails swallow the clause they
// open ("because of what AI removes.", "changes who builds."), which is the
// placeholder the next sentence fills. A tail with its own content after it
// ("is simple because seals shrink.") matches nothing here. "Comes down to"
// was on the list and is not: its object is the answer ("It comes down to
// trust."), so it names the content rather than deferring it.
const FORWARD_TAIL = new RegExp([
  "\\b(?:is|was|are|were|'s|seems?|sounds?)\\s+(?:also\\s+|very\\s+|quite\\s+)?(?:(?:a|an|the|some)\\s+)?(?:(?:simple|clear|obvious|straightforward|easy|plain|subtle|telling)(?:\\s+(?:fix|one|problem|point|reason|case|thing|part))?|point|reason|key|hard part|catch|problem|difference|thing|answer|question|deal|already there|worth \\w+ing(?: here| now| briefly)?|where (?:\\w+ ){1,3}(?:starts?|begins?|comes? in))[.!?]*$",
  "\\bbecause of (?:what|how|who|where|when)\\b[^.!?]*[.!?]*$",
  "\\bmakes? (?:it|this|that|them|the \\w+(?: \\w+)?) (?:concrete|clear|simple|obvious|real|plain|visible)[.!?]*$",
  "\\b(?:changes?|decides?|explains?|shows?|answers?|tells? (?:you|us)) (?:who|what|how|why|where|when)\\b[^.!?]*[.!?]*$",
].join('|'), 'i');

const ABSTRACT_HEAD = /^(?:the|a|an|one|two|three|four|its|this|that|these|those|our|their|his|her|my|your|several|a few|both)\s+(?:\w+\s+)?(?:reasons?|points?|thinking|idea|ideas|answers?|questions?|examples?|things?|parts?|lessons?|takeaways?|catch|trick|key|difference|problem|result|upshot|argument|case|story|explanation)\b/i;

// `paragraphs` carries each paragraph's text and its position among the
// document's blocks, so that "the next paragraph" means the block directly
// after this one and not the first prose under the next heading.
function announceThenExplain(paragraphs) {
  const hits = [];
  let opening = 0;
  for (let pi = 0; pi < paragraphs.length; pi += 1) {
    const sentences = sentencesIn(paragraphs[pi].text);
    // The last sentence of a paragraph is compared with the first of the
    // next one: an announcement set as its own one-line paragraph, with the
    // explanation under it, is the most natural typography of the fault.
    // Only when the two are adjacent blocks: a heading, list or table between
    // them means the second paragraph is not the explanation of the first.
    const adjacent = pi + 1 < paragraphs.length && paragraphs[pi + 1].at === paragraphs[pi].at + 1;
    const following = adjacent ? sentencesIn(paragraphs[pi + 1].text)[0] : null;
    for (let i = 0; i < sentences.length; i += 1) {
      const s = sentences[i];
      const next = i + 1 < sentences.length ? sentences[i + 1] : following;
      if (!next) continue;
      const n = wordsOf(s).length;
      if (n < 3 || n > 12) continue;
      if (/[:;]/.test(s)) continue;
      if (/\?$/.test(s)) continue;
      if (wordsOf(next).length < Math.ceil(n * 1.5)) continue;
      // "So it matters now..." is the same sentence as "It matters now...",
      // and the short-opener check already allows the same openers.
      const bare = s.replace(/^(?:so|and|but|then|now),?\s+/i, '');
      const pronounSubject = /^(?:it|that|this|there|here)\b/i.test(bare);
      const abstractSubject = ABSTRACT_HEAD.test(bare);
      if (!pronounSubject && !abstractSubject) continue;
      if (!FORWARD_TAIL.test(s)) continue;
      hits.push(s);
      if (i === 0) opening += 1;
    }
  }
  // One is enough when it opens a paragraph, because that is the position
  // the author stopped reading at. Mid-paragraph, two are needed.
  if (hits.length === 0) return null;
  if (opening === 0 && hits.length < 2) return null;
  return { name: 'announce-then-explain', count: hits.length, hits: hits.map((h) => `"${h}"`) };
}

// --- B. a very short claim opening a paragraph -----------------------------
//
// The hard choppy-run rule needs three short sentences in a row. "So we talk."
// standing alone at the top of a paragraph, with the real sentence after it,
// was named as the same habit and the run rule cannot see it. Fragments
// without a verb ("Three steps.") are labels rather than claims and stay out.
//
// A question, not a category, and anchored on a pronoun subject. Measured
// over 210 documents from four of the author's repositories (213 by the time
// the branch shipped, with the same result), the unanchored
// version reported 49 of them, almost all instruction prose where "Do not ask
// here." and "Nothing to do on upgrade." are the right length. "So we talk."
// and "That changes who builds." open on a pronoun pointing back at the
// paragraph before, which is the shape the author named, and with that anchor
// and two hits required the same corpus reports 7.

const AUX = /\b(?:am|is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|should|shall|may|might|must|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't)\b/i;

function hasVerb(s) {
  const flat = s.replace(/[‘’]/g, "'");
  if (AUX.test(flat)) return true;
  if (/\w(?:'s|'re|'ve|'ll|'d|'m|n't)\b/i.test(flat)) return true;
  // A pronoun followed by a word is a clause ("So we talk."), unless the word
  // is an adverb that leaves a fragment ("This too.", "That often.").
  if (/^(?:so |and |but |then |now )?(?:i|we|you|they|he|she|it|that|this|who)\s+\w{2,}/i.test(flat)
    && !/^(?:so |and |but |then |now )?(?:i|we|you|they|he|she|it|that|this|who)\s+(?:too|often|also|again|here|there|now|then|still|always|never|only|indeed|though)[.!?]?$/i.test(flat)) return true;
  // "Here we go." and "There it goes." are clauses; "Here tomorrow." is not.
  // A locative opener needs a pronoun or a verb right after it.
  if (/^(?:so |and |but |then |now )?(?:here|there)\s+(?:i|we|you|they|he|she|it|goes|comes|lies|sits|stands|begins|ends)\b/i.test(flat)) return true;
  if (/\b\w{3,}ed\b/i.test(flat)) return true;
  return false;
}

// `taken` holds the sentences the announce check already reported. One
// sentence is one piece of evidence; letting it open two categories would
// turn a single opener into a "some" reading on its own.
function shortClaimOpener(paragraphs, taken) {
  const hits = [];
  for (const p of paragraphs) {
    const sentences = sentencesIn(p);
    if (sentences.length < 2) continue;
    const first = sentences[0];
    const n = wordsOf(first).length;
    if (n < 2 || n > 5) continue;
    if (/[?:]$/.test(first)) continue;
    if (!hasVerb(first)) continue;
    if (!/^(?:so |and |but |then |now )?(?:i|it|that|this|we|you|they|here|there)\b/i.test(first)) continue;
    if (taken.has(first)) continue;
    hits.push(first);
  }
  return hits.length >= 2 ? { name: 'short-claim-opener', question: true, count: hits.length, hits: hits.map((h) => `"${h}"`) } : null;
}

// --- C. the same list enumerated twice -------------------------------------
//
// The four parts of a framework appeared as a prose list, then as a table
// column, then as four bold paragraph labels. Any one of those is how a list
// is written down. The same items in two of them is the document saying the
// list again.
//
// The anchor is one paragraph. The list has been said again when three or
// more of its items turn up inside a single paragraph of another section,
// each as a sentence sharing most of the item's content words, or inside one
// other list or table column there. A schema whose table of fields is
// followed by one paragraph per field is the list being used rather than
// repeated, and that was 25 of the same 210 documents when the check
// accepted items found anywhere in another section.
//
// The hit quotes both sides: the items that reappear and the start of the
// paragraph they reappear in. A count and a header alone sent the reader
// hunting for the repetition the report claimed.

function tableColumns(block) {
  const rows = block.lines
    .filter((l) => !SEPARATOR_ROW.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => plain(c)));
  if (rows.length < 4) return [];
  const header = rows[0];
  const body = rows.slice(1);
  const columns = [];
  for (let c = 0; c < header.length; c += 1) {
    const cells = body.map((r) => r[c] || '').filter((cell) => contentWords(cell).length >= 2);
    if (cells.length >= 3) columns.push({ label: `the table column "${header[c] || c + 1}"`, items: cells });
  }
  return columns;
}

function listItems(block) {
  const items = block.lines
    .map((l) => plain(l.replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '').split('\u0002')[0]))
    .map((l) => l.split(/(?<=[.!?])\s/)[0])
    .filter((l) => contentWords(l).length >= 2);
  return items.length >= 3 ? [{ label: `the list beginning "${items[0]}"`, items }] : [];
}

function runInLabel(block) {
  if (block.kind !== 'text') return null;
  // The label and its copy may sit on one line or on two, so the block's
  // lines are joined before the label is read.
  const m = block.lines.join(' ').match(/^(?:\*\*|__)(?!\s)(.+?)(?:\*\*|__)[.:!?]?\s+\S/);
  return m ? plain(m[1]).replace(/[.:!?]$/, '') : null;
}

function labelRuns(blocks) {
  const runs = [];
  let run = [];
  for (const b of blocks) {
    const label = runInLabel(b);
    if (label) {
      run.push({ label, block: b });
    } else {
      if (run.length >= 3) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 3) runs.push(run);
  return runs;
}

// Returns the index of the first sentence that says the item again, or -1.
// `used` holds indices already claimed: when the candidate is another list,
// each of its items may stand for one source item only, or three items that
// share three words would all be found again in one unrelated entry.
// `common` holds the words every item of the sequence shares: a match has to
// reach at least one word outside that set, or "Review system audit logs",
// "Archive system audit logs" and "Scan system audit logs" are all found
// again in one sentence about system audit logs that reviews, archives and
// scans nothing.
function reappearsAt(item, sentences, used, common) {
  const words = [...new Set(contentWords(item))];
  if (words.length < 2) return -1;
  const need = Math.ceil(words.length * 0.7);
  const distinct = words.filter((w) => !common.has(w));
  for (let i = 0; i < sentences.length; i += 1) {
    if (used && used.has(i)) continue;
    const have = new Set(sentences[i].words);
    let shared = 0;
    for (const w of words) if (have.has(w)) shared += 1;
    if (shared < need) continue;
    if (distinct.length && !distinct.some((w) => have.has(w))) continue;
    return i;
  }
  return -1;
}

function commonWords(items) {
  const sets = items.map((i) => new Set(contentWords(i)));
  if (!sets.length) return new Set();
  return new Set([...sets[0]].filter((w) => sets.every((set) => set.has(w))));
}

function excerpt(text, words = 8) {
  const all = wordsOf(text);
  return all.length > words ? `${all.slice(0, words).join(' ')}...` : all.join(' ');
}

// A document with no headings is one section, and a list said again inside
// it is not reported: the check is for a list enumerated in another section,
// which is what the author named, and the same list twice in one unbroken
// run of prose is a different and rarer fault.
function sectionIndexOf(blocks) {
  const index = new Map();
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'heading') n += 1;
    index.set(b, n);
  }
  return index;
}

function listEnumeratedTwice(blocks) {
  const section = sectionIndexOf(blocks);
  const sequences = [];
  for (const b of blocks) {
    if (b.kind === 'table') for (const col of tableColumns(b)) sequences.push({ ...col, kind: 'column', section: section.get(b) });
    if (b.kind === 'list') for (const l of listItems(b)) sequences.push({ ...l, kind: 'list', section: section.get(b) });
  }
  for (const run of labelRuns(blocks)) {
    sequences.push({
      label: `the bold labels beginning "${run[0].label}"`,
      kind: 'run of labels',
      items: run.map((r) => r.label),
      section: section.get(run[0].block),
    });
  }
  if (!sequences.length) return null;

  // Every paragraph in the document as its sentences, tagged with its
  // section, so a list is never found to reappear in itself or beside itself.
  // Every other sequence is a candidate too, as a list of its items, which is
  // how a bullet list repeated under a later heading is found.
  const candidates = blocks
    .filter((b) => b.kind === 'text' || b.kind === 'quote')
    .map((b) => ({
      section: section.get(b),
      what: 'paragraph',
      text: b.text,
      sentences: sentencesIn(b.text).map((t) => ({ words: contentWords(t) })),
    }));
  for (const other of sequences) {
    candidates.push({
      section: other.section,
      what: other.kind,
      list: true,
      text: other.items.join('; '),
      sentences: other.items.map((t) => ({ words: contentWords(t) })),
      sequence: other,
    });
  }

  const hits = [];
  // Two sequences that repeat each other are one repetition: the pair is
  // reported once, from whichever sequence comes first.
  const reported = new Set();
  for (const seq of sequences) {
    let best = null;
    const common = commonWords(seq.items);
    for (const c of candidates) {
      if (c.section === seq.section || c.sequence === seq) continue;
      // A pair already reported from the other side is skipped as a
      // candidate, not the whole sequence: its items may also be restated
      // in a paragraph of a third section, and that evidence still prints.
      if (c.sequence) {
        const a = sequences.indexOf(seq);
        const b = sequences.indexOf(c.sequence);
        if (reported.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) continue;
      }
      const used = c.list ? new Set() : null;
      const again = seq.items.filter((item) => {
        const at = reappearsAt(item, c.sentences, used, common);
        if (at === -1) return false;
        if (used) used.add(at);
        return true;
      });
      if (!best || again.length > best.again.length) best = { again, candidate: c };
    }
    if (best && best.again.length >= 3 && best.candidate.sequence) {
      const a = sequences.indexOf(seq);
      const b = sequences.indexOf(best.candidate.sequence);
      reported.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }
    if (best && best.again.length >= 3) {
      const quoted = best.again.map((i) => `"${excerpt(i, 6)}"`).join(', ');
      hits.push(`${best.again.length} of ${seq.items.length} items in ${seq.label} (${quoted}) are said again in one ${best.candidate.what} of another section, the one beginning "${excerpt(best.candidate.text)}"`);
    }
  }
  return hits.length ? { name: 'list-enumerated-twice', count: hits.length, hits } : null;
}

// Not here: sections that restate one idea. Three sections of the brief
// that prompted this file were organised around the same four parts, and the
// obvious detector, content-word overlap between sections, was built and
// measured. At the threshold that caught the proving pair (an overlap
// coefficient of 0.60), 30 of the same 210 documents from four repositories
// reported too, because a schema's "Purpose" and "Field reference" sections
// share their nouns while saying different things, and so do a manual's
// install and remove steps. Vocabulary cannot tell restatement from shared
// subject matter, so the rule lives in the concept-brief skill's reading list
// rather than here.

// --- E. run-in bold labels sharing a stem (D, section overlap, is the note above) ----------------------------------
//
// "**How things connect.** ..." "**How things behave over time.** ..." opening
// paragraph after paragraph. The brochure check in tells.js wants a bullet;
// this is the same shape written as paragraphs, and the repeated first word is
// what the author heard. A question rather than a category: "Before
// installation", "Before removal", "After repair" is a procedure organised
// the same way on purpose. The shared stem is the first two words, because
// "the", "it" and "what" open half the labels in any manual.

function runInLabelsSharingStem(blocks) {
  const hits = [];
  for (const run of labelRuns(blocks)) {
    // Two words, or the whole label when it is one word: three paragraphs
    // opening "**Setup.**" share a stem as surely as three opening "How things".
    // The most repeated stem is reported, not the first one found.
    const stems = run.map((r) => wordsOf(r.label).slice(0, 2).join(' ').toLowerCase());
    const counts = new Map();
    for (const f of stems) counts.set(f, (counts.get(f) || 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
    if (repeated) {
      hits.push(`${run.length} consecutive paragraphs open with a bold label, ${repeated[1]} of them starting "${repeated[0]}"`);
    }
  }
  return hits.length ? { name: 'run-in-labels-sharing-a-stem', question: true, count: hits.length, hits } : null;
}

// --- F. logistics before the subject ---------------------------------------
//
// A document titled with a concept whose first paragraphs are about the event:
// the date, the room, the minutes, who co-teaches. Reported as a question,
// because a document can be about an event, and the only way to know is to
// ask. Three distinct tokens before the second heading after the title keeps a
// passing "online" or "session" quiet. The second heading rather than the
// first, because a brief with a metadata line under its title and the
// logistics under its first header is exactly the document this was written
// for, and stopping at the first header would have passed it.

// Month names in full or the usual abbreviations, nothing looser: "10
// marvelous guests" matched a stem-plus-anything spelling. A slash date needs
// its year, or "1/2 of capacity" is a date.
const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

const EVENT_TOKENS = [
  ['a date', new RegExp([
    `\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTHS}\\b`,
    `\\b${MONTHS} \\d{1,2}(?:st|nd|rd|th)?\\b`,
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    '\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b',
  ].join('|'), 'i')],
  ['minutes', /\b\d+[- ]?minutes?\b/i],
  ['the session', /\bsessions?\b/i],
  // "Room 4" and "Room B" are places; "room for growth" is not.
  ['the room', /\b(?:[Tt]he|[Aa]|[Oo]ur) (?:\w+ )?[Rr]ooms?\b|\b[Rr]ooms? [A-Z0-9][\w-]*\b/],
  ['the venue', /\bvenues?\b/i],
  ['co-teaching', /\bco-?teach(?:es|ing)?\b/i],
  ['attendees', /\battendees?\b/i],
  ['guests', /\bguests?\b/i],
  ['the dinner', /\bdinner\b/i],
  ['running it twice', /\brun(?:s|ning)?(?: it)? twice\b/i],
  ['in person', /\bin[- ]person\b/i],
  ['online', /\bonline\b/i],
  ['the webinar', /\bwebinar\b/i],
  ['Zoom', /\bzoom\b/i],
];

function logisticsBeforeSubject(blocks) {
  // The title is the first heading among the first three blocks, so YAML
  // frontmatter or an epigraph above it does not switch the check off.
  const titleAt = blocks.slice(0, 3).findIndex((b) => b.kind === 'heading');
  if (titleAt === -1) return null;
  // The window is the opening, not the document: it closes at the second
  // heading or after six blocks, whichever comes first, so a long title-plus-
  // prose piece that mentions guests on page three is not asked. Lists,
  // quotes and subtitle lines in the window count, because "90 minutes, Room
  // 4, Oct 28" set as an italic line or a bulleted list is exactly the shape.
  const opening = [];
  let headings = 0;
  let seen = 0;
  for (const b of blocks.slice(titleAt + 1)) {
    if (b.kind === 'heading') {
      headings += 1;
      if (headings >= 2) break;
      continue;
    }
    if (seen >= 6) break;
    seen += 1;
    if (b.kind === 'text' || b.kind === 'quote' || b.kind === 'subtitle' || b.kind === 'note') opening.push(b.text);
    else if (b.kind === 'list' || b.kind === 'table') opening.push(plain(b.lines.join(' ').replace(/[|\u0002]/g, ' ')));
  }
  if (!opening.length) return null;
  const text = opening.join(' ');
  const found = EVENT_TOKENS.filter(([, re]) => re.test(text)).map(([label]) => label);
  if (found.length < 3) return null;
  return {
    name: 'logistics-before-the-subject',
    question: true,
    count: found.length,
    hits: [`is the opening about the event rather than the subject? it names ${found.join(', ')}`],
  };
}

// Not here: "the two" with no noun it stands for ("where the two first
// diverge"). It was on the list, and a pronoun with nothing to point at is a
// real fault, but spelling cannot stand in for reference resolution: "Maya met
// Leo at the gate. The two walked home together." is fine and would report,
// and "the two children" would report because children has no final s. A
// detector that fires on good prose and misses the fault it was built for is
// worse than none, so the sentence rule lives in the concept-brief skill's
// reading list instead.

// --- entry point -----------------------------------------------------------

// Two lists. `soft` goes into the reading beside the lexical categories in
// tells.js; `questions` is printed beside it and counted against nothing.
// These run on whatever checkAll is given, source files included, as the
// lexical checks do; a code file whose comments carry headings and bullets is
// unmeasured here, and the cheaper direction on it is a miss.
function structuralTells(text) {
  const blocks = blocksOf(text);
  const paragraphs = blocks.filter((b) => b.kind === 'text').map((b) => b.text);
  const placed = blocks.map((b, at) => ({ ...b, at })).filter((b) => b.kind === 'text');
  const announce = announceThenExplain(placed);
  const taken = new Set(announce ? announce.hits.map((h) => h.slice(1, -1)) : []);
  const findings = [
    announce,
    shortClaimOpener(paragraphs, taken),
    listEnumeratedTwice(blocks),
    runInLabelsSharingStem(blocks),
    logisticsBeforeSubject(blocks),
  ].filter(Boolean);
  return {
    soft: findings.filter((f) => !f.question),
    questions: findings.filter((f) => f.question),
  };
}

module.exports = { structuralTells, blocksOf, contentWords };
