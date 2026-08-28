#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const FORCE_KILL_GRACE_MS = 1000;

function main(argv) {
  const timeoutMs = Number(argv[0]);
  const command = argv[1];
  const args = argv.slice(2);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !command) {
    console.error('process-group-runner: usage: TIMEOUT_MS COMMAND [ARG...]');
    process.exitCode = 2;
    return;
  }

  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: grouped,
    env: process.env,
    stdio: 'inherit',
  });
  let finished = false;
  let timedOut = false;
  let forceTimer = null;

  const killTree = (signal) => {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (_) { /* The process tree already exited. */ }
  };
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    if (forceTimer) clearTimeout(forceTimer);
    process.exitCode = code;
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killTree('SIGTERM');
    forceTimer = setTimeout(() => killTree('SIGKILL'), FORCE_KILL_GRACE_MS);
  }, timeoutMs);

  const signalCodes = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  for (const [signal, code] of Object.entries(signalCodes)) {
    process.on(signal, () => {
      killTree('SIGKILL');
      finish(128 + code);
    });
  }

  child.once('error', (error) => {
    console.error(`process-group-runner: ${error.message}`);
    finish(127);
  });
  child.once('exit', (code, signal) => {
    if (timedOut) {
      // The direct child can exit on SIGTERM while a credential or SSH helper
      // keeps running. Kill the group again before the runner reports timeout.
      killTree('SIGKILL');
      finish(124);
      return;
    }
    if (signal) {
      console.error(`process-group-runner: command terminated by signal ${signal}`);
      finish(1);
      return;
    }
    finish(Number.isInteger(code) ? code : 1);
  });
}

main(process.argv.slice(2));
