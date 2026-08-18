#!/usr/bin/env node
// A private directory for a skill's working files, made fresh on each run.
//
// Run: node scripts/scratch.js
//
// It prints one line, the absolute path of a directory that did not exist a
// moment ago. Nothing else is printed, so a caller can use the output directly.
//
// Why this exists. Seven skills each made a private directory and explained how
// in their own prose, and the explanations had already diverged: 22 lines and
// byte-identical in four of them, 30 in flag-issue, 12 in revert-fix, and
// devin-review-response with its own wording and its own directory prefix. Every
// version was trying to say the same two things, and a reader comparing two of
// them could not tell whether the difference was deliberate. This is the third
// time the same move has been made here, after roots.js for the config check and
// queue.js for writes, and the reason is the one roots.js gives: a rule that has
// to hold everywhere cannot be seven paragraphs that each drift on their own,
// because prose has no compiler.
//
// The two things those paragraphs were protecting, now enforced rather than
// described:
//
// Never `mktemp -d -t build-loop`. That short form is BSD only. GNU coreutils
// wants at least six `X` characters in a template and exits 1 on the short form,
// so on Linux the directory is never created, and every later step that reads
// from it fails somewhere else with a message about the wrong thing. Calling
// fs.mkdtempSync instead removes the split entirely: there is one implementation
// and it behaves the same on both, which is why this is a script and not a
// corrected shell one-liner repeated seven times.
//
// Never a fixed name under /tmp. Two reasons and the second is the one that has
// bitten this machine. A fixed name is world-readable and another local user can
// replace the directory between a Write and the call that reads it, so what
// lands in the queue is not what was composed. And a fixed name is shared
// between sessions: three other Claude Code sessions were live in the home
// directory while build-loop's own queue-locking bug was being written up, and
// with two in flight one session's Write lands between the other's Write and its
// call, recording the wrong text against the wrong item.
//
// mkdtempSync also creates the directory 0700, so the first reason is closed by
// the permissions rather than only by the unguessable name.
//
// Nothing here removes the directory. A skill's run ends when the session moves
// on rather than at a point this script can observe, and deleting a directory
// another step is still reading from is worse than leaving it for the operating
// system to clear.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// os.tmpdir() reads TMPDIR where the platform sets one, which on macOS is a
// per-user directory rather than /tmp. Hard-coding /tmp would put the directory
// somewhere every local account can reach, which is half of what this exists to
// prevent.
const PREFIX = path.join(os.tmpdir(), 'build-loop-');

const USAGE = `scratch.js - print a fresh private directory for a skill's working files.

  node scripts/scratch.js

Prints one line, the absolute path. The directory is created 0700 and is not
removed by this script.`;

function main(argv) {
  // Length first, then the value. Testing for --help anywhere in argv meant
  // `scratch.js --help --list` printed help and exited 0, which is this script
  // answering a command it does not have while claiming it takes no arguments.
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (argv.length > 0) {
    // A caller passing an argument has a different command in mind, and
    // printing a path anyway would send its files somewhere it is not looking.
    process.stdout.write(`scratch.js takes no arguments, got: ${argv.join(' ')}\n`);
    return 1;
  }
  process.stdout.write(fs.mkdtempSync(PREFIX) + '\n');
  return 0;
}

if (require.main === module) {
  let code = 0;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    // The skills are told to relay what this printed, and a skill reads stdout.
    // On stderr the one case that matters, a temp directory that cannot be
    // created, produced an empty relay and the skill carried on as though it
    // had a path. Same reasoning as roots.js.
    process.stdout.write(`scratch.js could not make a directory under ${os.tmpdir()}: ${error.message}\n`);
    code = 1;
  }
  // process.exitCode, never process.exit: a write to a pipe on macOS is
  // asynchronous, and every caller here is a skill reading what was printed.
  process.exitCode = code;
}

module.exports = { main, PREFIX };
