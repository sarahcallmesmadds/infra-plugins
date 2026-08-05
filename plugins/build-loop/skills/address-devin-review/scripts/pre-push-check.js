#!/usr/bin/env node
'use strict';

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: pre-push-check.js <round.json>');
  process.exit(2);
}

let round;
try {
  round = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`invalid round record: ${error.message}`);
  process.exit(2);
}

const errors = [];
const dispositions = new Set([
  'fixed', 'design-intentional', 'deferred', 'positive-flag', 'out-of-scope'
]);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const list = (value) => Array.isArray(value) && value.length > 0;

for (const key of ['repository', 'branch', 'head_sha']) {
  if (!text(round[key])) errors.push(`${key} is required`);
}
if (!Number.isInteger(round.pr) || round.pr < 1) errors.push('pr must be a positive integer');
if (!Number.isInteger(round.round) || round.round < 1) errors.push('round must be a positive integer');
if (round.finding_set_complete !== true) errors.push('finding_set_complete must be true');
if (!Array.isArray(round.findings)) errors.push('findings must be an array');

const ids = new Set();
for (const [index, finding] of (round.findings || []).entries()) {
  const label = text(finding.id) ? finding.id : `findings[${index}]`;
  if (!text(finding.id)) errors.push(`${label}: id is required`);
  else if (ids.has(finding.id)) errors.push(`${label}: duplicate id`);
  else ids.add(finding.id);
  if (!text(finding.location)) errors.push(`${label}: location is required`);
  if (!text(finding.summary)) errors.push(`${label}: summary is required`);
  if (!dispositions.has(finding.disposition)) errors.push(`${label}: invalid disposition`);
  if (!text(finding.evidence)) errors.push(`${label}: evidence is required`);

  if (finding.disposition === 'fixed') {
    if (!list(finding.dependency_audit)) errors.push(`${label}: fixed finding needs dependency_audit`);
    if (!list(finding.paired_file_audit)) errors.push(`${label}: fixed finding needs paired_file_audit`);
    if (!list(finding.changed_files)) errors.push(`${label}: fixed finding needs changed_files`);
  }
  if (finding.disposition === 'deferred' && !text(finding.tracking_id)) {
    errors.push(`${label}: deferred finding needs tracking_id`);
  }
  if (finding.disposition === 'out-of-scope' && !text(finding.base_evidence)) {
    errors.push(`${label}: out-of-scope finding needs base_evidence`);
  }
}

if (!list(round.verification)) {
  errors.push('verification needs at least one command result');
} else {
  for (const [index, check] of round.verification.entries()) {
    if (!text(check.command)) errors.push(`verification[${index}]: command is required`);
    if (check.outcome !== 'passed') errors.push(`verification[${index}]: outcome must be passed`);
  }
}

if (errors.length) {
  console.error(`round is not push-ready (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`round is push-ready: ${round.findings.length} finding${round.findings.length === 1 ? '' : 's'}, all classified`);
