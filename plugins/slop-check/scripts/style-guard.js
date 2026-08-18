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

  const text = proseOf(direct, transcriptPath);
  if (!text) return null;

  let result;
  try {
    result = checkHard(text, config);
  } catch {
    return null;
  }
  if (result.ok) return null;

  const found = result.violations.map((v) => v.what).join(', and ');
  return `Style violation in ${subject}: ${found}. `
    + `Rewrite it now. ${remedyFor(result.violations)} `
    + `Acknowledge it in at most one short line, then give the corrected version. `
    + `Do not apologise at length or explain the rule.`;
}

module.exports = { remedyFor, fromTranscript, proseOf, blockMessage };
