// Gathers what is actually true, so the inventory can be compared against it.
//
// Three sources, deliberately separate:
//   - GitHub, for whether a repository exists, was renamed, and is public
//   - the filesystem, for whether a path still resolves
//   - the plugin cache and settings.json, for installed and enabled state
//
// Nothing here reads the inventory. Keeping the gatherer ignorant of what it is
// about to be compared against is what stops it quietly confirming whatever the
// record already claims.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandHome, githubToken } = require('./config');

const GITHUB_API = 'https://api.github.com';

// --- GitHub -----------------------------------------------------------------

function resolveGithubToken(config) {
  const configured = githubToken(config);
  if (configured) return configured;
  // Falls back to the CLI's stored credential. This is what makes an
  // interactive run work with no setup, and precisely what a launchd run will
  // not have, which is why config.github.tokenFile exists.
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Splits a GitHub URL into owner and repo. Returns null for anything else, so
// a row pointing at GitLab or a raw path is skipped rather than misread.
function parseRepoUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], name: match[2] };
}

async function githubGet(urlPath, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ip-inventory' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API}${urlPath}`, { headers });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
}

// Facts about one repository.
//
// A rename is detected by comparing the full_name GitHub answers with against
// the one that was asked for: GitHub serves renamed repositories from the old
// path and reports the new name in the payload, so a redirect is invisible
// unless the response is actually read.
async function repoFacts(owner, name, token) {
  const { status, body } = await githubGet(`/repos/${owner}/${name}`, token);

  if (status === 404) return { checked: true, exists: false };
  if (status === 401 || status === 403) {
    // Unauthenticated requests cannot see private repositories, and a private
    // repository is indistinguishable from a deleted one without a token. Say
    // so rather than reporting it as missing.
    return { checked: false, reason: `GitHub returned ${status}; a token is required to see private repositories` };
  }
  if (status !== 200 || !body) {
    return { checked: false, reason: `GitHub returned ${status}` };
  }

  const asked = `${owner}/${name}`.toLowerCase();
  const actual = String(body.full_name || '').toLowerCase();

  return {
    checked: true,
    exists: true,
    fullName: body.full_name,
    renamed: actual !== asked,
    visibility: body.private ? 'Private' : 'Public',
    defaultBranch: body.default_branch,
    pushedAt: body.pushed_at,
  };
}

// Every path in a repository, as a Set, so many rows can be checked with one
// request instead of one request each.
async function repoTree(owner, name, ref, token) {
  const { status, body } = await githubGet(
    `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token
  );
  if (status !== 200 || !body || !Array.isArray(body.tree)) {
    return { checked: false, reason: `tree request returned ${status}` };
  }
  // A truncated tree lists only part of the repository, so an absent path would
  // be indistinguishable from one that simply did not fit in the response.
  if (body.truncated) {
    return { checked: false, reason: 'tree was truncated by the API; too large to check exhaustively' };
  }
  return { checked: true, paths: new Set(body.tree.map((entry) => entry.path)) };
}

// --- Filesystem --------------------------------------------------------------

function pathExists(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return fs.existsSync(expandHome(value.trim()));
  } catch {
    return null;
  }
}

// --- Installed plugins -------------------------------------------------------

// Reads the plugin cache to find what is installed and at which version.
//
// The cache keeps one directory per installed version and neither uninstall nor
// update removes the old one, so several versions coexist. The highest is not
// necessarily the live one, but it is the best available signal from the
// filesystem alone.
function installedPlugins(config) {
  const cacheRoot = expandHome(config.pluginCacheDir);
  const found = new Map();
  let marketplaces;
  try {
    marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const marketplacePath = path.join(cacheRoot, marketplace.name);
    let plugins;
    try {
      plugins = fs.readdirSync(marketplacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginPath = path.join(marketplacePath, plugin.name);
      let versions;
      try {
        versions = fs.readdirSync(pluginPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(compareVersions);
      } catch {
        continue;
      }
      if (!versions.length) continue;
      const version = versions[versions.length - 1];
      found.set(plugin.name, {
        marketplace: marketplace.name,
        version,
        versionsOnDisk: versions,
        path: path.join(pluginPath, version),
      });
    }
  }
  return found;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Installed and enabled are two separate switches and only one is visible in
// the plugin list. A plugin can sit in the cache with its files intact while
// settings.json has it false, in which case none of its hooks or skills load
// and nothing anywhere says so.
function enabledPlugins(config) {
  const enabled = new Map();
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(expandHome(config.settingsPath), 'utf8'));
  } catch {
    return enabled;
  }
  for (const [key, value] of Object.entries(settings.enabledPlugins || {})) {
    enabled.set(key.split('@')[0], value === true);
  }
  return enabled;
}

// --- The gatherer ------------------------------------------------------------

// Collects everything the classifier needs, doing one GitHub request per unique
// repository rather than one per row.
async function gather(rows, config, options = {}) {
  const repos = new Map();
  const trees = new Map();

  // Offline runs skip GitHub entirely rather than failing on it. The tests use
  // this so they assert on the classifier rather than on the network, and it is
  // also the honest mode for a machine with no connection: the filesystem
  // checks still mean something, and the repository checks report as not run.
  if (options.skipGithub) {
    return {
      hasGithubToken: false,
      offline: true,
      repos,
      trees,
      installed: installedPlugins(config),
      enabled: enabledPlugins(config),
      pathExists,
    };
  }

  const token = options.githubToken || resolveGithubToken(config);

  const urls = [...new Set(rows.map((row) => row.repo).filter(Boolean))];
  for (const url of urls) {
    const parsed = parseRepoUrl(url);
    if (!parsed) {
      repos.set(url, { checked: false, reason: 'not a github.com repository URL' });
      continue;
    }
    const facts = await repoFacts(parsed.owner, parsed.name, token);
    repos.set(url, facts);

    if (facts.checked && facts.exists && facts.defaultBranch) {
      trees.set(url, await repoTree(parsed.owner, parsed.name, facts.defaultBranch, token));
    }
  }

  return {
    hasGithubToken: Boolean(token),
    repos,
    trees,
    installed: installedPlugins(config),
    enabled: enabledPlugins(config),
    pathExists,
  };
}

module.exports = {
  gather,
  repoFacts,
  repoTree,
  parseRepoUrl,
  pathExists,
  installedPlugins,
  enabledPlugins,
  compareVersions,
  resolveGithubToken,
};
