'use strict';

const os = require('os');
const path = require('path');

const REPOSITORY_ENVIRONMENT_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
];

function sanitizedGitEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of REPOSITORY_ENVIRONMENT_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_GRAFT_FILE = os.devNull;
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

function commandName(command) {
  const match = String(command || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match ? path.basename(match[1] || match[2] || match[3]).toLowerCase() : '';
}

function addTransportFlag(command, flag) {
  const value = String(command || '').trim();
  const match = value.match(/^(?:"[^"]*"|'[^']*'|\S+)/);
  if (!match) return flag;
  return `${match[0]} ${flag}${value.slice(match[0].length)}`;
}

function sshTransport(source) {
  const command = source.GIT_SSH_COMMAND || source.GIT_SSH || 'ssh';
  const requested = String(source.GIT_SSH_VARIANT || '').trim().toLowerCase();
  const name = commandName(command);
  let variant = requested === 'auto' ? '' : requested;
  if (!variant) {
    if (name.includes('tortoiseplink')) variant = 'tortoiseplink';
    else if (name.includes('plink')) variant = 'plink';
    else if (name.includes('putty')) variant = 'putty';
    else if (name === 'ssh') variant = 'ssh';
  }
  if (!variant) {
    throw new Error('custom SSH transport requires GIT_SSH_VARIANT=ssh, plink, putty, or tortoiseplink');
  }
  if (!['ssh', 'plink', 'putty', 'tortoiseplink'].includes(variant)) {
    throw new Error(`SSH variant ${variant} cannot be made non-interactive`);
  }
  return {
    command: addTransportFlag(command, variant === 'ssh' ? '-o BatchMode=yes' : '-batch'),
    variant,
  };
}

function isolatedGitEnvironment(source = process.env, options = {}) {
  const env = sanitizedGitEnvironment(source);
  delete env.GIT_ASKPASS;
  delete env.GIT_SSH;
  delete env.GIT_SSH_VARIANT;
  delete env.SSH_ASKPASS;
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_TERMINAL_PROMPT = '0';
  if (options.ssh === true) {
    const transport = sshTransport(source);
    env.GIT_SSH_COMMAND = transport.command;
    env.GIT_SSH_VARIANT = transport.variant;
  } else {
    delete env.GIT_SSH_COMMAND;
  }
  return env;
}

module.exports = { isolatedGitEnvironment, sanitizedGitEnvironment, sshTransport };
