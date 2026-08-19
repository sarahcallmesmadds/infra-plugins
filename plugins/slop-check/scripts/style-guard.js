// What the two style hooks share: how to find the prose, how to judge it, and
// what to say about it.
//
// Split out when SubagentStop was registered. The alternative was one hook file
// wired to both events, and the captured shapes rule it out: Stop carries
// `transcript_path` and SubagentStop carries `agent_transcript_path` beside it,
// pointing at different files. A single file reading both would read a field
// that does not exist on one of its own events, which is the shape
// hook-event-shape.test.js exists to refuse, and the fallback would have walked
// the main session's transcript to lint a subagent's report.
//
// Fails open throughout, like everything else here. A guard that breaks a
// session is worse than a guard that misses something.

'use strict';

const fs = require('fs');
const path = require('path');

const { checkHard } = require(path.join(__dirname, 'tells.js'));

// What to tell the model, matched to what was actually found. An artefact left
// in the text needs deleting, not rephrasing, so the em dash advice would be
// nonsense for it.
function remedyFor(violations) {
  const names = new Set(violations.map((v) => v.name));
  const parts = [];

  if (names.has('em-dash')) {
    parts.push('Replace each em dash with a comma, a period, parentheses, or a restructured clause.');
  }
  if (names.has('choppy-run')) {
    parts.push('Break up the run of very short sentences by joining or expanding them, and vary the lengths.');
  }
  if (names.has('tool-artefact')) {
    parts.push('Delete the leftover generation artefacts. They are not prose and should never have been in the output.');
  }
  if (names.has('house-rule')) {
    // No parenthetical naming the phrase. The caller already opens with every
    // violation's `what`, and this one's `what` is itself the sentence "phrases
    // ruled out for this author (worth stealing)". Interpolating it again
    // nested that whole sentence inside these brackets, so the writer was
    // handed the same wording twice in one message, the second time inside its
    // own parentheses. The other three remedies say what to do and leave the
    // naming to the opening sentence, which is the shape that reads.
    parts.push(
      'Remove the phrase this author has ruled out, named above. '
      + 'Say the thing plainly instead. This is a standing instruction rather than a style preference, so rephrasing around it is the fix, not softening it.'
    );
  }
  return parts.join(' ');
}

// The fallback, and formerly the only path. Walk back to the most recent
// assistant message that actually said something. Tool calls and empty turns
// are not prose.
//
// The caller decides which transcript this is. That is not a detail: on
// SubagentStop the event carries two paths and only one of them is the
// subagent's own.
function fromTranscript(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return '';

  let lines;
  try {
    lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
  } catch {
    return '';
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    // Claude Code's own error text is not prose anyone wrote, and it contains
    // an em dash: "usually temporary - try again in a moment". Linting it
    // blocks a turn for the host's wording and tells the writer to fix a
    // sentence they cannot reach. Found while re-measuring the two coverage
    // gaps on 2026-08-18, where these were 7 of 12 apparent misses.
    if (entry.isApiErrorMessage) continue;
    // A delegated conversation can be appended here with this flag, and on this
    // path there is no turn to bound it, so the newest assistant row may belong
    // to a subagent. Blocking the main agent for it names the wrong writer.
    // The same guard exists in earlierParts; it was added there first and this
    // one was missed, which is why it was found twice.
    if (entry.isSidechain) continue;
    const content = entry.message && entry.message.content;
    if (!content) continue;
    const text = Array.isArray(content)
      ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : String(content);
    if (text.trim()) return text.trim();
  }
  return '';
}

// The prose to judge, preferring the value the event handed over directly.
//
// How much of the transcript tail to read looking for the start of this turn.
//
// Measured on 2026-08-18 over 3938 real turns in the saved sessions: half are
// under 32KB, 95 per cent under 287KB, and 99.09 per cent under this. The tail
// of that distribution is long, one turn reached 12.5MB, and whole transcripts
// run to 34MB, so reading the file is not an option in something that runs at
// the end of every turn.
//
// The 0.91 per cent this does not cover are not checked rather than partly
// checked. See earlierParts for why that is the only safe answer.
const TURN_WINDOW_BYTES = 1024 * 1024;

// Some rows arrive as ordinary user messages without being the user saying
// anything, and stopping the walk at one puts the turn boundary in the wrong
// place.
//
// The direction of that fault is worth being exact about, because it is not the
// one it looks like. The walk runs backwards and takes the newest qualifying
// row, so a machinery row accepted as the boundary moves the start of the turn
// FORWARD. Nothing from a previous turn is dragged in. What happens is that this
// turn's own earlier prose falls outside the boundary and is never read, so the
// coverage this file exists to add quietly does not apply to any turn that ran a
// shell command or picked up a system note along the way.
//
// Counted across the 298 main session logs on the machine this was written on:
// 155 interrupt notices, 55 echoed stdout rows, 40 each of bash input, stdout
// and stderr. The interrupt notices are the reason the array form matters more
// than the string form: every one of them arrives as text blocks rather than as
// a plain string, so a check that only looked at strings, as this one first did,
// saw none of them and reported the shape as absent.
//
// The list is build-loop's, in pushback.js, minus two entries. `<command-message>`
// and `<command-name>` stay off it deliberately: those are the user typing
// `/something`, which is the user speaking and a real turn boundary, and there
// are 439 of them here. pushback.js drops them because it is asking whether the
// user was complaining, and a slash command is not a complaint. Different
// question, and copying the list wholesale would make every slash command
// invisible.
const MACHINERY = [
  '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>',
  '<bash-input>', '<bash-stdout>', '<bash-stderr>',
  '<system-reminder>', '[Request interrupted', 'Caveat:',
  'Stop hook feedback:', 'Base directory for this skill:',
];

function spokenByUser(row) {
  const text = textOfRow(row);
  if (!text) return true;            // nothing to judge on, so do not exclude it
  return !MACHINERY.some((marker) => text.startsWith(marker));
}

// Every wording this file can produce starts with these words. `style-lint`
// uses it to tell a message it already blocked from one it has not seen, so it
// has to stay true of all of them.
const BLOCK_MARKER = 'Style violation in';

// The prose written earlier in this same turn, oldest first, which is the half
// the event does not carry.
//
// The Stop event holds the closing message and nothing else, so a turn that
// paused to run a tool and wrote a paragraph first had that paragraph read by
// nobody. Measured on 2026-08-18: of 651 main-agent turns, 414 wrote something
// before a tool call, and 18 carried a hard rule break that nothing caught.
//
// Returns null, meaning "do not know", separately from [] meaning "nothing
// there". The caller must not treat them alike. Null happens when the start of
// the turn is not inside the window, and the honest answer then is to check
// nothing here: the alternative is taking whatever the window begins with,
// which is the previous turn's prose, and blocking someone for writing that.
// Reporting the wrong text is the fault this whole hook was rewritten to stop
// committing, and it would be worse here than a miss, because a miss is silent
// and a wrong report is confidently wrong.
function earlierParts(transcriptPath, closing) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    let start;
    try {
      // fstat rather than stat, so the size and the bytes come from the same
      // open file rather than from two lookups of a name.
      const size = fs.fstatSync(fd).size;
      start = Math.max(0, size - TURN_WINDOW_BYTES);
      // One byte earlier than the window, when there is one, so the drop below
      // can tell a cut that landed mid-line from one that landed exactly on a
      // line start. Without it a boundary row sitting exactly on the window edge
      // was thrown away with the partial line that usually sits there, and the
      // turn then had no start at all.
      if (start > 0) start -= 1;
      const buf = Buffer.alloc(size - start);
      // The count matters. A short read leaves the rest of the buffer as zero
      // bytes, and those rows parse as nothing while the rows before them parse
      // fine, so the damage is invisible.
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      // Grown or shrunk while being read. The turn boundary is appended before
      // the turn it opens, so in practice it is long written by the time this
      // runs, but "in practice" is how the fault this hook exists to avoid got
      // in. If the file moved at all, the window may end before the current
      // boundary, the walk then finds the previous one, and the previous turn's
      // prose is reported as though it were just written. Give up instead.
      if (fs.fstatSync(fd).size !== size) return null;
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A window that did not start at the beginning almost certainly begins
    // mid-line, and half a JSON object parses as nothing rather than as
    // something wrong, but dropping it is cheaper than reasoning about it.
    if (start > 0) {
      text = text[0] === '\n'
        ? text.slice(1)                              // the window began on a line start
        : text.slice(text.indexOf('\n') + 1);       // mid-line, so drop the remnant
    }
  } catch {
    return null;
  }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }   // a torn line is not evidence
    // A delegated conversation can be appended into the main session log with
    // this flag, and its prompt arrives as a plain-string user row: exactly what
    // the boundary walk below is looking for. Stopping there puts the boundary
    // inside somebody else's conversation, so the subagent's writing is reported
    // against the main agent while the main agent's own opening paragraph, the
    // thing this function was added to read, sits before the boundary and is
    // skipped. That is the wrong-text failure this whole change exists to
    // remove, arriving by a route nobody was watching.
    //
    // It does not reproduce on this build, and that is worth writing down so
    // this guard is not later read as evidence it happened: across all 298 main
    // session logs on the machine this was written on, zero user rows carry the
    // flag, because subagent conversations go to their own files under
    // subagents/. build-loop's pushback.js drops these rows explicitly, so the
    // shape has been seen somewhere, and one condition is a cheap way to not
    // depend on which build you are running.
    //
    // pushback.js also drops rows whose userType is not "external", and that is
    // deliberately not copied. It is answering whether the user was complaining,
    // where a slash command is not pushback. Here the question is whether the
    // user spoke, and a slash command is the user speaking.
    if (row.isSidechain) continue;
    rows.push(row);
  }

  // Walk back to the message that opened this turn. `isMeta` is what excludes
  // the hook's own feedback, which arrives as a user message and would
  // otherwise read as the user speaking and cut the turn in half.
  let from = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i];
    if (e.type !== 'user' || e.isMeta) continue;
    const c = e.message && e.message.content;
    if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) continue;
    if (!spokenByUser(e)) continue;
    from = i;
    break;
  }
  if (from === -1) return null;                 // boundary outside the window

  // Which row is the last thing the assistant said, and whether it can be the
  // closing message at all.
  //
  // Position alone is not enough either. The log runs a beat behind, so the
  // closing message is usually not on disk yet and the last row here is an
  // earlier part of the same turn. What separates the two is what follows it:
  // if the assistant called a tool afterwards, then whatever it said before
  // that was not the last thing it said, whether or not the words match.
  let lastSaid = -1;
  for (let i = rows.length - 1; i > from; i--) {
    const e = rows[i];
    if (e.type !== 'assistant' || e.isApiErrorMessage) continue;
    const c = e.message && e.message.content;
    if (!c) continue;
    const t = (Array.isArray(c)
      ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
      : String(c)).trim();
    if (t) { lastSaid = i; break; }
  }
  // A row can carry text and a tool call together, and then the text is not the
  // last thing said either, without anything following the row at all.
  if (lastSaid !== -1) {
    const c = rows[lastSaid].message && rows[lastSaid].message.content;
    if (Array.isArray(c) && c.some((x) => x.type === 'tool_use')) lastSaid = -1;
  }

  // Anything tool-shaped after it settles the question.
  for (let i = lastSaid + 1; lastSaid !== -1 && i < rows.length; i++) {
    const e = rows[i];
    const c = e.message && e.message.content;
    const tooled = Array.isArray(c)
      && c.some((x) => x.type === 'tool_use' || x.type === 'tool_result');
    if (tooled) { lastSaid = -1; break; }
  }

  const said = objections(rows, from);

  const parts = [];
  for (let i = from + 1; i < rows.length; i++) {
    const e = rows[i];
    if (e.type !== 'assistant' || e.isApiErrorMessage) continue;
    const c = e.message && e.message.content;
    if (!c) continue;
    const t = (Array.isArray(c)
      ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
      : String(c)).trim();
    if (!t) continue;
    // The closing message, if the log has caught up with it. It is checked from
    // the event, and checking it twice would report one em dash as two.
    //
    // Only the last one can be it. Matching on the text alone meant a turn that
    // opened and closed with the same sentence lost the opening copy, and the
    // block then named one place while two needed rewriting. Text is not
    // identity: the position is.
    if (closing && i === lastSaid && t === closing) continue;
    // Already blocked once and already rewritten. The rewrite is a later
    // message in this same turn, because the hook's feedback is isMeta and does
    // not start a new one, so without this the original is found again and
    // reported as though nothing had been done about it.
    if (said.some((o) => o.includes(excerpt(t)))) continue;
    parts.push(t);
  }
  return parts;
}

// The text of a row, however the host chose to carry it. wasBlocked used to do
// this itself and only handled the array form, so a plain-string assistant row
// read as empty and the scan walked straight past the message it was supposed
// to stop at.
function textOfRow(e) {
  const c = e && e.message && e.message.content;
  if (!c) return '';
  return (Array.isArray(c)
    ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
    : String(c)).trim();
}

// Everything the hook said about this turn, so a paragraph can be matched to
// the objection that named it.
//
// The first version of this walked forward from the paragraph and gave up at
// the next thing the assistant said. For an earlier part of a turn that is
// exactly the wrong shape: the block fires at Stop, so the turn's closing
// message sits between the paragraph and the feedback, the scan stopped there,
// and a paragraph the writer had already corrected was demanded again. The
// fixture that was supposed to cover this put the feedback immediately after
// the paragraph, which is not a shape that occurs, so it passed.
//
// Proximity was the wrong question. What ties an objection to a paragraph is
// that the objection quoted it, so that is what gets asked.
function objections(rows, from) {
  const out = [];
  for (let i = from + 1; i < rows.length; i++) {
    const e = rows[i];
    if (e.type !== 'user' || !e.isMeta) continue;
    const t = textOfRow(e);
    if (t.includes(BLOCK_MARKER)) out.push(t);
  }
  return out;
}

// Enough of a piece of writing to find it again, and no more.
function excerpt(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? flat.slice(0, 70) + '...' : flat;
}

// Asking the transcript first was the bug, and the ordering here is the fix, so
// the evidence travels with it. The file is written a beat behind the
// conversation, so at Stop time the finished turn is usually not in it yet and
// the walk lands on the message before. The guard then blocked a clean turn for
// the previous one's count, while the turn that really broke the rule went out
// unchecked.
//
// Measured on 2026-08-15 over 116 real blocks in the saved sessions: 70 linted
// the wrong text. A live probe over five firings found the event correct every
// time and the transcript short every time. On one firing the hook saw 11 lines
// and 66794 bytes of a file that ends at 14 lines and 68998 bytes, with the
// reply stamped 60ms before the read and still not written.
//
// That is why the direct field wins and the walk is a last resort, rather than
// the two being interchangeable sources. Reordering them reintroduces a guard
// that complains about the wrong piece of writing.
//
// `last_assistant_message` is documented on both Stop and SubagentStop and is
// present in the captured shape of each. The walk stays as a fallback so the
// guard degrades to its old behaviour rather than to nothing if that changes.
//
// Present and empty is not the same as absent, and the difference decides
// whether the fallback runs. An empty field is a turn that ended without prose,
// a turn whose last act was a tool call being the ordinary case, and there is
// simply nothing to lint. Falling back there walks the transcript and blocks an
// older message under a sentence reading "just written", which is the exact
// fault this hook was changed to stop committing. Absent is different: it means
// this build does not send the field, and the walk is the best answer available.
function proseOf(direct, transcriptPath) {
  if (typeof direct === 'string') return direct.trim();
  return fromTranscript(transcriptPath);
}

// The whole verdict in one call. Returns null when there is nothing to say, so
// a caller never has to decide what "clean" looks like.
//
// Values, not the event. The hooks pull `last_assistant_message` and the right
// transcript path out themselves and pass them in, which keeps every read of
// the event inside the hook file. hook-event-shape.test.js checks the fields a
// hook reads against the captured shape of each event it is wired to, and it
// reads hook files. Reading the payload in here instead would move those reads
// somewhere the check cannot see and buy a green result by hiding from it.
//
// `subject` names the text being judged, and it is a parameter because the two
// events address different readers. Blocking Stop sends the main agent back to
// its own reply. Blocking SubagentStop prevents the subagent from stopping, so
// the subagent is the one told to rewrite, and calling its report "the response
// just written" describes something it did not write.
function blockMessage(direct, transcriptPath, config, subject) {
  if (config.enforce === false) return null;

  const closing = proseOf(direct, transcriptPath);

  // Earlier parts only on the normal path, where the event handed over the
  // closing message. When it did not, `closing` is itself the last thing in the
  // transcript, and the two readers would be picking over the same messages
  // with no reliable way to say which one is the closing one. The degraded path
  // keeps exactly its old behaviour rather than gaining a half-working version
  // of this one.
  const earlier = (typeof direct === 'string')
    ? (earlierParts(transcriptPath, closing) || [])
    : [];

  const judge = (text) => {
    if (!text) return null;
    try {
      const r = checkHard(text, config);
      return r.ok ? null : r;
    } catch {
      return null;
    }
  };

  const found = [];
  for (const t of earlier) {
    const r = judge(t);
    if (r) found.push({ where: 'earlier in this turn', result: r, text: t });
  }
  const closingResult = judge(closing);
  if (closingResult) found.push({ where: subject, result: closingResult, text: closing });

  if (!found.length) return null;

  const remedy = remedyFor(found.flatMap((f) => f.result.violations));
  const tail = `${remedy} Acknowledge it in at most one short line, `
    + `then give the corrected version. Do not apologise at length or explain the rule.`;

  // One place reads as a sentence, which is what it has always done, and the
  // closing-only wording is unchanged on purpose: it is the common case and it
  // is the sentence the pushback measurements have been counting since 0.4.2.
  if (found.length === 1) {
    const only = found[0];
    const what = only.result.violations.map((v) => v.what).join(', and ');
    if (only.where === subject) {
      return `${BLOCK_MARKER} ${subject}: ${what}. Rewrite it now. ${tail}`;
    }
    // Naming the place is the whole point. "The response just written" sent the
    // writer to text that was fine, three tool calls after the text that was
    // not, and a rewrite instruction pointed at the wrong paragraph is worse
    // than none: it reads as a false positive and teaches the guard is wrong.
    return `${BLOCK_MARKER} this turn, in text written ${only.where}: ${what}. `
      + `It is not in your closing message, so re-reading that will not find it. `
      + `The text begins: "${excerpt(only.text)}". Rewrite that part. ${tail}`;
  }

  // More than one place. Counts are kept apart rather than added up, because
  // the reader has to go to each one, and "3 em dashes" with no location is the
  // same failure as naming the wrong location.
  const lines = found.map((f) => {
    const what = f.result.violations.map((v) => v.what).join(', and ');
    return f.where === subject
      ? `  - ${subject}: ${what}`
      : `  - ${f.where}, beginning "${excerpt(f.text)}": ${what}`;
  }).join('\n');

  return `${BLOCK_MARKER} this turn, in ${found.length} places:\n${lines}\n`
    + `Rewrite each of them. ${tail}`;
}

module.exports = { remedyFor, fromTranscript, proseOf, blockMessage };
