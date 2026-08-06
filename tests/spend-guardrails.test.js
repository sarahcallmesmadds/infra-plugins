#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins', 'spend-guardrails', 'skills', 'spend-guardrails', 'SKILL.md');
const README = path.join(ROOT, 'plugins', 'spend-guardrails', 'README.md');
const EVALS = path.join(ROOT, 'tests', 'fixtures', 'spend-guardrails-evals.json');
const text = fs.readFileSync(SKILL, 'utf8');
const readme = fs.readFileSync(README, 'utf8');
const evaluations = JSON.parse(fs.readFileSync(EVALS, 'utf8'));

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

check('the decision framework is provider-neutral', () => {
  for (const tier of ['Economy', 'Balanced', 'Premium', 'Maximum']) {
    assert.ok(text.includes(tier), `${tier} tier is missing`);
  }
  assert.match(text, /Anthropic/);
  assert.match(text, /OpenAI/);
});

check('the balanced tier is the default and escalation requires evidence', () => {
  assert.match(text, /Start with the verified balanced tier/);
  assert.match(text, /failed\s+evaluation/);
  assert.match(text, /Do not escalate because the work is visible, urgent, executive-facing/);
});

check('economical workers and expensive recurring agents are pinned deliberately', () => {
  assert.match(text, /Pin the verified balanced model on implementation agents/);
  assert.match(text, /Pin the verified economy model on mechanical fan-out/);
  assert.match(text, /Never leave recurring work on a\s+premium or maximum model without a written reason/);
});

check('the maximum tier requires explicit opt-in and an exit condition', () => {
  assert.match(text, /Use a verified maximum tier only with explicit opt-in/);
  assert.match(text, /what ends the expensive run/);
});

check('exact recommendations require current official sources', () => {
  assert.match(text, /platform\.claude\.com\/docs\/en\/about-claude\/models\/overview/);
  assert.match(text, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  assert.match(text, /developers\.openai\.com\/api\/docs\/models/);
  assert.match(text, /developers\.openai\.com\/api\/docs\/deprecations/);
  assert.match(text, /recommend a capability tier without an exact\s+ID or price/);
});

check('retired and deprecated models fail safe', () => {
  assert.match(text, /Never recommend a retired model/);
  assert.match(text, /Do not start new work on a deprecated model/);
  assert.match(text, /Treat a new model as a candidate, not an automatic upgrade/);
});

check('Fermat-specific policy did not survive the port', () => {
  assert.ok(!/Fermat|5,?800|premium share falling|RevOps-shaped/i.test(text));
});

check('the README states installation, runtime, configuration, and side effects', () => {
  assert.match(readme, /\/plugin install spend-guardrails@smadds/);
  assert.match(readme, /both Claude Code and Codex/);
  assert.match(readme, /No setup or configuration is required/);
  assert.match(readme, /advisory and read-only/);
});

check('forward evaluations cover both providers and every decision path', () => {
  assert.strictEqual(evaluations.version, 1);
  assert.ok(/^2026-08-\d{2}$/.test(evaluations.last_evaluated));
  assert.deepStrictEqual([...new Set(evaluations.cases.map((entry) => entry.provider))].sort(), ['anthropic', 'openai']);
  assert.strictEqual(evaluations.cases.length, 6);
  assert.ok(evaluations.cases.every((entry) =>
    entry.prompt
      && entry.expected_model
      && entry.expected_tier
      && entry.pass_condition
      && entry.status === 'pass'
      && entry.observed_tier === entry.expected_tier));
  assert.ok(evaluations.cases.filter((entry) => entry.provider === 'anthropic').every((entry) =>
    entry.observed_model === entry.expected_model));
  assert.ok(evaluations.cases.filter((entry) => entry.provider === 'openai').every((entry) =>
    entry.observed_model === '' && /withheld an exact ID/.test(entry.verification)));
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
