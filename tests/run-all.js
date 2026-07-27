#!/usr/bin/env node
// Run every test suite in this directory and report what passed.
//
//   node tests/run-all.js          every suite
//   node tests/run-all.js deps     only suites whose name contains "deps"
//
// There are eight suites and they were run one at a time, which means a full
// check depended on remembering all eight. A suite added and not mentioned
// anywhere would simply never run, and nothing would say so.
//
// Discovery is by directory listing rather than a list kept here on purpose. A
// list would be the same problem one level along: something to forget to
// update.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const filter = process.argv[2];

const suites = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (suites.length === 0) {
  console.log(filter ? `No suite matches "${filter}".` : 'No test suites found.');
  process.exit(1);
}

const results = [];
for (const suite of suites) {
  const run = spawnSync(process.execPath, [path.join(HERE, suite)], { encoding: 'utf8' });
  const output = (run.stdout || '') + (run.stderr || '');
  // Every suite ends with its own summary line. Take the last non-empty line
  // rather than parsing counts, so a suite that reports differently still gets
  // its own words shown instead of being flattened into a number.
  const summary = output.trim().split('\n').filter(Boolean).pop() || '(no output)';
  results.push({ suite, ok: run.status === 0, summary, output });
}

const width = Math.max(...results.map((r) => r.suite.length));
console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.suite.padEnd(width)}  ${r.summary}`);
}

const failures = results.filter((r) => !r.ok);

// A failing suite is the reason anybody runs this, so print it in full rather
// than making them go and run that one again to find out what happened.
for (const r of failures) {
  console.log(`\n${'-'.repeat(60)}\n${r.suite}\n${'-'.repeat(60)}`);
  console.log(r.output.trim());
}

console.log(`\n${results.length} suites, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
