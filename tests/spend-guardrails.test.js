#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins', 'spend-guardrails', 'skills', 'spend-guardrails', 'SKILL.md');
const text = fs.readFileSync(SKILL, 'utf8');

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

check('the ladder contains all four current Claude rungs', () => {
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5']) {
    assert.ok(text.includes(id), `${id} is missing from the ladder`);
  }
});

check('Sonnet is the default and escalation requires evidence', () => {
  assert.match(text, /Default to Sonnet/);
  assert.match(text, /failed evaluation/);
  assert.match(text, /Do not escalate because the work is visible, urgent, executive-facing/);
});

check('cheap workers and expensive recurring agents are both pinned deliberately', () => {
  assert.match(text, /Pin Sonnet on implementation agents/);
  assert.match(text, /Pin Haiku on mechanical fan-out/);
  assert.match(text, /Never leave recurring work on\s+Opus or Fable without a written reason/);
});

check('Fable requires explicit opt-in and an exit condition', () => {
  assert.match(text, /Use Fable only with explicit opt-in/);
  assert.match(text, /what ends the expensive run/);
});

check('dated prices point back to current official sources', () => {
  assert.match(text, /verified 2026-08-05/);
  assert.match(text, /platform\.claude\.com\/docs\/en\/about-claude\/models\/overview/);
  assert.match(text, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  assert.match(text, /Recheck them before producing a budget or cost forecast/);
});

check('Fermat-specific policy did not survive the port', () => {
  assert.ok(!/Fermat|5,?800|premium share falling|RevOps-shaped/i.test(text));
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
