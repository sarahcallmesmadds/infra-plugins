// Compares the inventory against reality and sorts every difference into one
// of two buckets.
//
//   auto   a fact with exactly one correct answer, which a machine can set
//   queue  a difference that needs a person, because the record is not wrong,
//          it is now unknown
//
// The line between them is the whole design. A repository that was renamed has
// one right answer and no judgement in it. A repository that has vanished does
// not: the code being gone does not tell you whether the thing it built is
// retired, moved, or still running somewhere and billing. Status is therefore
// never set by this file, and neither are Kind, Parent, or any relation.
//
// A third bucket, `skipped`, records checks that did not run. It exists because
// a check that silently does not happen is indistinguishable from a check that
// passed, and a report of "no drift" that quietly means "I could not look" is
// worse than no report at all.

'use strict';

// Every check this file can perform, with its bucket. Keeping them in one table
// means the report can say which checks ran even when they all pass.
const CHECKS = {
  'repo-missing': 'queue',
  'repo-renamed': 'auto',
  'visibility-changed': 'auto',
  'visibility-without-repo': 'queue',
  'live-path-missing': 'queue',
  'live-path-stale': 'auto',
  'source-path-missing': 'queue',
  'version-changed': 'auto',
  'installed-changed': 'auto',
  'enabled-changed': 'auto',
  'unrecorded-plugin': 'queue',
};

function finding(row, check, { field, was, now, detail, groupKey }) {
  return {
    rowId: row.id,
    rowUrl: row.url,
    name: row.name,
    kind: row.kind,
    check,
    verdict: CHECKS[check],
    field: field || null,
    was: was === undefined ? null : was,
    now: now === undefined ? null : now,
    detail,
    // Findings that share one cause but differ in their values, such as twelve
    // paths all pointing into the same superseded directory, carry a key so the
    // report can collapse them. Without it they group by value and never match.
    groupKey: groupKey || null,
  };
}

// Trailing slashes make "plugins/guardrails" and "plugins/guardrails/" two
// different strings and one of them is never in a git tree.
function normalisePath(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

// A path field holding a sentence rather than a path. These exist because a
// person wrote an explanation where a value belonged, and checking them as
// paths produces a confident and meaningless "missing".
function looksLikeProse(value) {
  const text = String(value || '');
  return text.includes(' ') && !text.startsWith('~') && !text.startsWith('/');
}

// Walks up Parent relations to the nearest row of Kind "Plugin".
//
// Children inherit their version and enabled state from the plugin that ships
// them, so the comparison has to be against that plugin rather than against the
// child's own name, which the plugin manager has never heard of.
function nearestPlugin(row, byId, seen = new Set()) {
  if (row.kind === 'Plugin') return row;
  const parents = Array.isArray(row.parent) ? row.parent : [];
  for (const parentId of parents) {
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) continue;
    const found = nearestPlugin(parent, byId, seen);
    if (found) return found;
  }
  return null;
}

// Finds a live path pointing into a superseded version directory.
//
// Neither uninstall nor update removes the previous version, so the old
// directory stays on disk and every path into it keeps resolving. A plain
// existence check therefore passes on a path that has been dead for weeks,
// which is the single most misleading state the filesystem can be in here.
function staleVersionInPath(livePath, pluginName, installed) {
  const marker = `/${pluginName}/`;
  const at = String(livePath).indexOf(marker);
  if (at === -1) return null;
  const version = String(livePath).slice(at + marker.length).split('/')[0];
  if (!installed.versionsOnDisk.includes(version)) return null;
  if (version === installed.version) return null;
  return version;
}

function classify(rows, reality, config) {
  const findings = [];
  const skipped = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const localKinds = new Set(config.localKinds);

  if (!reality.hasGithubToken) {
    skipped.push({
      check: 'repo-missing / repo-renamed / visibility-changed',
      reason: 'no GitHub token, so private repositories are indistinguishable from deleted ones',
    });
  }

  for (const row of rows) {
    // --- repository ---------------------------------------------------------
    if (row.repo) {
      const facts = reality.repos.get(row.repo);

      if (!facts || !facts.checked) {
        skipped.push({
          name: row.name,
          check: 'repo',
          reason: (facts && facts.reason) || 'repository was not checked',
        });
      } else if (!facts.exists) {
        findings.push(finding(row, 'repo-missing', {
          field: config.properties.repo,
          was: row.repo,
          detail: `${row.repo} returns 404. Whether this is retired, moved, or deleted by mistake is not something the API can say.`,
        }));
      } else {
        if (facts.renamed) {
          const url = `https://github.com/${facts.fullName}`;
          findings.push(finding(row, 'repo-renamed', {
            field: config.properties.repo,
            was: row.repo,
            now: url,
            detail: `Renamed to ${facts.fullName}. GitHub still serves the old path, so the link works and the name is wrong.`,
          }));
        }
        if (facts.visibility && facts.visibility !== row.visibility) {
          findings.push(finding(row, 'visibility-changed', {
            field: config.properties.visibility,
            was: row.visibility,
            now: facts.visibility,
            detail: `GitHub reports ${facts.visibility}.`,
          }));
        }
      }
    } else if (row.visibility === 'Public' || row.visibility === 'Private') {
      findings.push(finding(row, 'visibility-without-repo', {
        field: config.properties.visibility,
        was: row.visibility,
        detail: `Visibility says ${row.visibility} but no repository is recorded, so nothing supports the claim.`,
      }));
    }

    // --- source path in the repository --------------------------------------
    if (row.repo && row.sourcePath && !looksLikeProse(row.sourcePath)) {
      const tree = reality.trees.get(row.repo);
      if (!tree || !tree.checked) {
        if (tree) skipped.push({ name: row.name, check: 'source-path', reason: tree.reason });
      } else if (!tree.paths.has(normalisePath(row.sourcePath))) {
        findings.push(finding(row, 'source-path-missing', {
          field: config.properties.sourcePath,
          was: row.sourcePath,
          detail: `Not present in the repository's default branch. It may have been renamed, moved, or deleted.`,
        }));
      }
    } else if (row.sourcePath && looksLikeProse(row.sourcePath)) {
      skipped.push({
        name: row.name,
        check: 'source-path',
        reason: `the field holds a sentence rather than a path: "${row.sourcePath}"`,
      });
    }

    // --- live path on this machine ------------------------------------------
    if (row.livePath && localKinds.has(row.kind)) {
      if (looksLikeProse(row.livePath)) {
        skipped.push({
          name: row.name,
          check: 'live-path',
          reason: `the field holds a sentence rather than a path: "${row.livePath}"`,
        });
      } else if (reality.pathExists(row.livePath) === false) {
        findings.push(finding(row, 'live-path-missing', {
          field: config.properties.livePath,
          was: row.livePath,
          detail: 'Nothing at this path on this machine.',
        }));
      }
    }

    // --- installed plugin state ---------------------------------------------
    const plugin = nearestPlugin(row, byId);
    if (plugin) {
      const installed = reality.installed.get(plugin.name);
      const newest = installed
        ? `the newest copy of "${plugin.name}" on disk is ${installed.version}`
        : '';

      // Checked on every row, components included, because each one names its
      // own file and any of them can be left pointing at an old version.
      if (installed && row.livePath && !looksLikeProse(row.livePath)) {
        const stale = staleVersionInPath(row.livePath, plugin.name, installed);
        if (stale) {
          findings.push(finding(row, 'live-path-stale', {
            field: config.properties.livePath,
            was: row.livePath,
            // Replaces the version segment whether the path ends there or
            // continues. Requiring a trailing slash silently no-ops on the
            // plugin's own row, which is the one path that stops at the version.
            now: String(row.livePath).replace(
              `/${plugin.name}/${stale}`,
              `/${plugin.name}/${installed.version}`
            ),
            groupKey: `live-path-stale:${plugin.name}:${stale}->${installed.version}`,
            detail: `Points into ${stale}, which is superseded. The path still resolves, because `
              + 'updating a plugin leaves the old directory behind, so an existence check alone '
              + `would call this fine. The newest copy of "${plugin.name}" on disk is ${installed.version}.`,
          }));
        }
      }

      // Installed and enabled are read from the plugin row only.
      //
      // Notion returns false both for a box someone unticked and for one that
      // was never set, and the API cannot tell the two apart. Reading false as
      // a deliberate "no" on the component rows manufactures drift that is not
      // there: one enabled plugin produced eleven findings saying its scripts
      // were disabled, which nobody had ever claimed.
      if (row.kind === 'Plugin') {
        if (!installed && row.installed === true) {
          findings.push(finding(row, 'installed-changed', {
            field: config.properties.installed,
            was: true,
            now: false,
            detail: `"${plugin.name}" is not in the plugin cache.`,
          }));
        }
        if (installed && row.installed !== true) {
          findings.push(finding(row, 'installed-changed', {
            field: config.properties.installed,
            was: row.installed,
            now: true,
            detail: `"${plugin.name}" ${installed.version} is in the plugin cache.`,
          }));
        }
        const isEnabled = reality.enabled.get(plugin.name);
        if (installed && isEnabled !== undefined && row.enabled !== isEnabled) {
          findings.push(finding(row, 'enabled-changed', {
            field: config.properties.enabled,
            was: row.enabled,
            now: isEnabled,
            detail: isEnabled
              ? `"${plugin.name}" is enabled in settings.json.`
              : `"${plugin.name}" is installed but DISABLED in settings.json, so none of its `
                + 'skills or hooks load and nothing anywhere says so.',
          }));
        }
      }

      // Version is checked on components too. A component row records the
      // version of the plugin that ships it, and that is a real value which
      // really changes, unlike the checkboxes above.
      if (installed && row.version && row.version !== installed.version) {
        findings.push(finding(row, 'version-changed', {
          field: config.properties.version,
          was: row.version,
          now: installed.version,
          detail: `${newest[0].toUpperCase()}${newest.slice(1)}.`
            + (installed.versionsOnDisk.length > 1
              ? ` All versions present: ${installed.versionsOnDisk.join(', ')}. Which one is`
                + ' actually running is whatever loaded at session start, which disk cannot show.'
              : ''),
        }));
      }
    }
  }

  // --- plugins on disk with no row ------------------------------------------
  const recorded = new Set(
    rows.filter((row) => row.kind === 'Plugin').map((row) => String(row.name).toLowerCase())
  );
  for (const [name, installed] of reality.installed) {
    if (recorded.has(name.toLowerCase())) continue;
    findings.push({
      rowId: null,
      rowUrl: null,
      name,
      kind: 'Plugin',
      check: 'unrecorded-plugin',
      verdict: CHECKS['unrecorded-plugin'],
      field: null,
      was: null,
      now: installed.version,
      detail: `Installed at ${installed.path} but absent from the inventory.`,
    });
  }

  return {
    findings,
    skipped,
    checksRun: Object.keys(CHECKS),
    counts: {
      rows: rows.length,
      findings: findings.length,
      auto: findings.filter((f) => f.verdict === 'auto').length,
      queue: findings.filter((f) => f.verdict === 'queue').length,
      skipped: skipped.length,
    },
  };
}

module.exports = { classify, CHECKS, nearestPlugin, normalisePath, looksLikeProse };
