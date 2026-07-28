// Today's date, stated to the model at the start of every session.
//
// ---------------------------------------------------------------------------
// Why this is worth a hook.
//
// A model has a training cutoff and no clock. Left alone it will answer "what
// is today" with a date somewhere near the end of its training data, and it
// will do it confidently, because from the inside there is nothing to
// distinguish a remembered date from a known one. Everything downstream
// inherits the error: a file named with today's date, a "last 30 days" window,
// a deadline described as three weeks away when it is three days away.
//
// The failure is quiet, which is the reason to fix it at the hook layer rather
// than by asking. Nothing looks wrong. The date is simply the wrong one.
//
// ---------------------------------------------------------------------------
// Why the timezone offset is in the line.
//
// It is not decoration. A date with no zone gets read as UTC by anything that
// parses it, and on a machine west of Greenwich that is yesterday for part of
// every day. That exact bug reached shipped code twice in this repository:
// `git log --since=` was handed a bare date and filled in the current clock
// time, then the replacement was computed with `date -u` and read back as
// local. Both silently dropped real commits.
//
// Stating the offset does not prevent the mistake by itself. It does mean the
// information needed to catch it is present rather than assumed.

'use strict';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// `+01:00`, `-04:00`, `+00:00`.
//
// getTimezoneOffset returns minutes to ADD to local time to reach UTC, so it is
// positive west of Greenwich. That is the opposite sign from how offsets are
// written, and getting it backwards produces a plausible-looking string that is
// wrong by twice the offset. Hence the negation, and hence the test.
function formatOffset(date) {
  const total = -date.getTimezoneOffset();
  const sign = total < 0 ? '-' : '+';
  const abs = Math.abs(total);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

// Local calendar date as YYYY-MM-DD.
//
// Deliberately not toISOString().slice(0, 10), which converts to UTC first and
// therefore reports tomorrow's date all evening east of Greenwich and
// yesterday's all morning west of it. This is the same bug the comment above
// describes, and it is one keystroke away at all times.
function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The line the hook injects. One sentence, phrased so it is usable as a fact
// rather than as a reminder to go and look something up.
function todayLine(now = new Date()) {
  const weekday = DAYS[now.getDay()];
  const month = MONTHS[now.getMonth()];
  return `Today is ${weekday} ${now.getDate()} ${month} ${now.getFullYear()} `
    + `(${isoDate(now)}), local time ${formatOffset(now)}. `
    + 'Use this date for anything dated, and for any window like "the last 30 days". '
    + 'Do not infer the date from training data, and do not hand a bare date to a tool '
    + 'that will read it as UTC.';
}

module.exports = { todayLine, isoDate, formatOffset };
