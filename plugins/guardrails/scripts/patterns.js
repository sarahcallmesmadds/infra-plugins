// Prompt-injection pattern catalogue.
//
// Each pattern belongs to a category. Severity is scored by how many DISTINCT
// categories a piece of text trips, not by raw match count, so a document that
// repeats one phrase twenty times still scores as one category. That keeps the
// noise down on legitimate writing that happens to use a loaded phrase.
//
// Every regex here is anchored on a literal phrase and bounded. None of them
// nest quantifiers, so none can backtrack catastrophically on hostile input.

'use strict';

const PATTERNS = [
  // 1. Instruction override, the classic. Text trying to cancel what came before.
  { id: 'override-ignore', category: 'instruction-override',
    re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction|context)/i,
    note: 'text attempting to cancel earlier instructions' },
  { id: 'override-instead', category: 'instruction-override',
    re: /\b(instead|rather)\b[^.\n]{0,20}\b(do|follow|obey|execute)\b[^.\n]{0,30}\b(the following|this|these)\b/i,
    note: 'redirection away from the original task' },
  { id: 'override-nolonger', category: 'instruction-override',
    re: /\byou are no longer\b|\byour (real|true|actual) (task|goal|instruction)\b/i,
    note: 'reassignment of the stated task' },

  // 2. Role reassignment, text trying to change who the model is.
  { id: 'role-younow', category: 'role-reassignment',
    re: /\byou are now\b[^.\n]{0,40}|\bfrom now on,? you\b/i,
    note: 'attempt to redefine the assistant role' },
  { id: 'role-actas', category: 'role-reassignment',
    re: /\b(act|behave|respond) as (if you (are|were)|an?)\b[^.\n]{0,40}\b(unrestricted|unfiltered|jailbroken|dan|developer mode)\b/i,
    note: 'persona swap toward an unrestricted mode' },
  { id: 'role-devmode', category: 'role-reassignment',
    re: /\b(developer|debug|god|admin|sudo) mode\b[^.\n]{0,20}\b(enabled?|activated?|on)\b/i,
    note: 'fictitious privileged mode' },

  // 3. Fake conversation boundaries, text impersonating the harness.
  { id: 'boundary-tag', category: 'fake-boundary',
    re: /<\/?(system|human|assistant|user)>|\[\/?(SYSTEM|INST|ASSISTANT)\]/,
    note: 'markup imitating a conversation-role boundary' },
  { id: 'boundary-rolelabel', category: 'fake-boundary',
    re: /^\s*(system|assistant)\s*:\s*\S/im,
    note: 'line beginning with a role label' },
  { id: 'boundary-endof', category: 'fake-boundary',
    re: /\bend of (document|context|file|input)\b[^.\n]{0,30}\b(new|now|begin)\b/i,
    note: 'false end-of-content marker followed by new directives' },

  // 4. Exfiltration, text asking for data to be sent somewhere.
  { id: 'exfil-send', category: 'exfiltration',
    re: /\b(send|post|upload|transmit|exfiltrate|forward)\b[^.\n]{0,30}\b(to|at)\b[^.\n]{0,20}(https?:\/\/|[\w.-]+@[\w.-]+\.\w+)/i,
    note: 'instruction to send content to an external destination' },
  { id: 'exfil-fetch', category: 'exfiltration',
    re: /\b(curl|wget|fetch|Invoke-WebRequest)\b[^\n]{0,60}https?:\/\//i,
    note: 'outbound network call embedded in content' },
  { id: 'exfil-encode', category: 'exfiltration',
    re: /\bbase64\b[^.\n]{0,30}\b(encode|encoded|then send|and send)\b/i,
    note: 'encoding step paired with transmission' },

  // 5. Secret solicitation, text fishing for the system prompt or credentials.
  { id: 'secret-prompt', category: 'secret-solicitation',
    re: /\b(reveal|print|show|output|repeat|dump)\b[^.\n]{0,30}\b(system prompt|your instructions|initial prompt|prompt above)\b/i,
    note: 'request to disclose the system prompt' },
  { id: 'secret-creds', category: 'secret-solicitation',
    re: /\b(list|print|show|read|cat)\b[^.\n]{0,30}\b(api[ _-]?key|secret|credential|token|password|\.env)\b/i,
    note: 'request to surface credentials' },

  // 6. Tool coercion, text pushing toward a specific action.
  { id: 'tool-runthis', category: 'tool-coercion',
    re: /\b(run|execute|invoke)\b[^.\n]{0,25}\b(the following|this) (command|script|code)\b/i,
    note: 'embedded instruction to run a command' },
  { id: 'tool-must', category: 'tool-coercion',
    re: /\byou (must|should|need to) (immediately |now )?(call|run|execute|use)\b[^.\n]{0,40}\b(tool|command|function|script)\b/i,
    note: 'imperative pressure toward a tool call' },

  // 7. Authority spoofing, text claiming to outrank the user.
  { id: 'authority-override', category: 'authority-spoofing',
    re: /\b(admin|administrator|system|security|owner) (override|directive|instruction|command)\b/i,
    note: 'claim of privileged authority' },
  { id: 'authority-urgent', category: 'authority-spoofing',
    re: /\b(urgent|critical|important)\b[^.\n]{0,20}\bdo not (tell|inform|mention|alert)\b[^.\n]{0,20}\b(the )?user\b/i,
    note: 'urgency paired with an instruction to conceal' },
  { id: 'authority-conceal', category: 'authority-spoofing',
    re: /\b(without|do not) (telling|informing|notifying|alerting)\b[^.\n]{0,20}\b(the user|anyone)\b/i,
    note: 'instruction to act without disclosure' },

  // 8. Obfuscation, characters that hide text from a human reader.
  { id: 'obfus-zerowidth', category: 'obfuscation',
    re: /[​-‍⁠﻿]/,
    note: 'zero-width characters, invisible to a reader' },
  { id: 'obfus-bidi', category: 'obfuscation',
    re: /[‪-‮⁦-⁩]/,
    note: 'bidirectional override characters, can reorder displayed text' },
];

// Files and directories where these phrases are expected rather than suspicious.
// Security notes, this plugin's own docs, and planning files all legitimately
// quote injection strings; firing on them trains the reader to ignore warnings.
const DEFAULT_EXCLUDE_PATHS = [
  /\/\.planning\//,
  /\/guardrails\//,
  /(^|\/)(SECURITY|THREAT[-_]MODEL|REVIEW|CHECKPOINT)[^/]*\.md$/i,
  /(^|\/)patterns\.js$/,
];

module.exports = { PATTERNS, DEFAULT_EXCLUDE_PATHS };
