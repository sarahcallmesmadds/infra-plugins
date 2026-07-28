// Configuration loader.
//
// Defaults live here so the plugin runs the moment it is installed, but unlike
// the other plugins in this marketplace there is one setting with no sensible
// default: which database to read. Without `notion.dataSourceId` every command
// stops and says so, rather than auditing nothing and reporting no drift.
//
// The property map is the important part. Notion column names are display
// strings a person can rename in two clicks, so every column this plugin reads
// is looked up through `properties` instead of being hardcoded. Renaming a
// column then breaks one line of config rather than the audit.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_NAME = 'ip-inventory.config.json';

const DEFAULTS = {
  notion: {
    // No default. The database is the one thing this plugin cannot guess.
    dataSourceId: '',

    // API version and endpoint style move together and cannot be mixed. Version
    // 2022-06-28 serves POST /v1/databases/{id}/query; 2025-09-03 serves
    // POST /v1/data_sources/{id}/query and rejects the other. Both were probed
    // against the live API before these defaults were chosen. Pinning both here
    // means a future migration is a config edit, not a code change.
    apiVersion: '2025-09-03',
    endpointStyle: 'data_sources',

    // Where the integration token comes from. `tokenEnv` is read first.
    // `tokenFile` is the fallback and is what a scheduled runner needs, because
    // launchd and cron do not source a shell profile and so never see an
    // exported variable. Format is KEY=value lines, as in a .env file.
    tokenEnv: 'NOTION_PERSONAL_API_KEY',
    tokenFile: '',
  },

  github: {
    owner: '',
    // Read first, then `gh auth token`. A missing token is not fatal: the
    // filesystem checks still run and the repo checks report as unchecked.
    tokenEnv: 'GITHUB_TOKEN',
    tokenFile: '',
  },

  // Logical name -> Notion column name.
  properties: {
    name: 'Name',
    kind: 'Kind',
    status: 'Status',
    oneLiner: 'One-liner',
    repo: 'Repo',
    sourcePath: 'Source path',
    livePath: 'Live path',
    visibility: 'Visibility',
    version: 'Version',
    installed: 'Installed',
    enabled: 'Enabled',
    dateStarted: 'Date Started',
    verifiedRunning: 'Verified running',
    category: 'Category',
    healthNotes: 'Health Notes',
    ipDistinction: 'IP Distinction Notes',
    exhibitSummary: 'Exhibit-Ready Summary',
    repoLocation: 'Repo Location',
    parent: 'Parent',
  },

  // Rows of these kinds are third-party services this plugin's owner does not
  // own. They are excluded from the exhibit and never gap-reported.
  excludeKindsFromExhibit: ['MCP Server'],

  // Kinds whose Live path is expected to point at a real file on this machine.
  // An Agent that runs on someone else's server has no live path here, and
  // flagging one as missing would be noise.
  localKinds: ['Plugin', 'Skill', 'Hook', 'Script', 'Command', 'Config'],

  // Where the plugin manager keeps installed plugins, used to read the real
  // installed version and the enabled flag.
  pluginCacheDir: '~/.claude/plugins/cache',
  settingsPath: '~/.claude/settings.json',
};

// Expands a leading ~ to the home directory.
//
// Node's fs takes "~" literally, so an unexpanded path silently creates or
// reads a directory named "~" next to the current working directory, and every
// check after it looks in the wrong place.
function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readUserConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // Missing, unreadable, or invalid JSON. The caller decides what to do.
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Merges the user's config over the defaults, one level deep.
//
// A flat spread is wrong here and the difference is not cosmetic. `notion` and
// `properties` are objects, so `{...DEFAULTS, ...user}` replaces the whole
// object: setting only `notion.dataSourceId` would drop apiVersion,
// endpointStyle and both token settings, and the plugin would then fail with an
// error about the wrong thing entirely.
function mergeConfig(defaults, user) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    if (isPlainObject(defaults[key]) && isPlainObject(value)) {
      out[key] = { ...defaults[key], ...value };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function loadConfig(configPathOverride) {
  const configPath = configPathOverride
    ? expandHome(configPathOverride)
    : path.join(os.homedir(), '.claude', CONFIG_NAME);

  const user = readUserConfig(configPath);

  // JSON.parse succeeds on `[1,2]` and on `"text"`. Spreading either produces
  // an object with numeric keys rather than throwing, which would read as a
  // config with no recognised settings and be indistinguishable from an empty
  // one. A malformed file would then look like it had been applied.
  if (!isPlainObject(user)) {
    return { ...DEFAULTS, configPath, usedDefaults: true };
  }

  return { ...mergeConfig(DEFAULTS, user), configPath, usedDefaults: false };
}

// Returns the Notion token, or null. Env first, then the file.
function notionToken(config) {
  const fromEnv = process.env[config.notion.tokenEnv];
  if (fromEnv) return fromEnv.trim();
  return readTokenFile(config.notion.tokenFile, config.notion.tokenEnv);
}

function githubToken(config) {
  const fromEnv = process.env[config.github.tokenEnv];
  if (fromEnv) return fromEnv.trim();
  return readTokenFile(config.github.tokenFile, config.github.tokenEnv);
}

// Reads KEY=value out of a .env-style file.
//
// This exists for scheduled runs. An interactive shell has the variable
// exported by a profile; launchd and cron do not source one, so a runner that
// only reads the environment finds nothing, does no work, and exits 0 looking
// exactly like a run with nothing to do.
function readTokenFile(filePath, key) {
  if (!filePath) return null;
  let text;
  try {
    text = fs.readFileSync(expandHome(filePath), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

module.exports = { loadConfig, notionToken, githubToken, expandHome, DEFAULTS, CONFIG_NAME };
