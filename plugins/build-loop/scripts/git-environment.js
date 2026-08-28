'use strict';

const os = require('os');

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

function isolatedGitEnvironment(source = process.env) {
  const env = sanitizedGitEnvironment(source);
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = os.devNull;
  return env;
}

module.exports = { isolatedGitEnvironment, sanitizedGitEnvironment };
