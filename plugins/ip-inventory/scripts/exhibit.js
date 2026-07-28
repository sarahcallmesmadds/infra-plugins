// Renders the exhibit, and the gap report that has to come before it.
//
// An exhibit is the schedule of prior intellectual property attached to an
// employment agreement, listing what you already owned when you signed so the
// invention-assignment clause cannot reach it. That is what the inventory is
// for, and it is why a blank field here matters more than an untidy one: an
// entry with no date and no statement of how it came to be yours is not
// evidence of anything, and putting it on the list anyway weakens the entries
// that are sound.
//
// So the gap report is printed first and is the more useful half. It is a
// worklist, not a warning.

'use strict';

// Implementation detail, not a work. A script inside a plugin is covered by the
// plugin being listed; naming it separately pads the schedule without adding a
// single claim to it.
const COMPONENT_KINDS = new Set(['Script', 'Hook', 'Config']);

// Fields an entry needs before it can carry weight.
const REQUIRED = [
  { key: 'dateStarted', label: 'no date started', why: 'nothing establishes when it came into existence' },
  { key: 'ipDistinction', label: 'no authorship basis', why: 'nothing states why it is yours rather than an employer\'s' },
];

function isThirdParty(row, config) {
  return config.excludeKindsFromExhibit.includes(row.kind);
}

// The rows that stand as discrete works.
//
// Top-level entries, plus anything whose parent is a repository, since a
// repository is a container rather than a work in its own right. Components
// are excluded, and so is anything third-party.
//
// A repository is a container only where it actually contains something.
//
// The rule above was written and then not applied to repositories themselves.
// A top-level repository has no parent, so the empty-parent branch returned it
// as a work, and it appeared in the exhibit beside the plugins inside it. The
// same authorship was then claimed twice, once as the repository and once for
// each thing it holds, which is the padding this tool warns about elsewhere
// and which weakens the entries that are sound.
//
// Dropping every repository instead would be wrong in the other direction. A
// repository with nothing registered under it is not a container of anything,
// it is the only record of that work, and removing it takes real IP off the
// schedule with nothing left pointing at it. Of the two failures that one is
// worse, because a padded exhibit can be argued down and a missing entry
// cannot be argued back.
//
// So: a repository is excluded where at least one thing beneath it is listed
// as a work in its own right, and kept where nothing is.
function exhibitRows(rows, config) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentsOf = (row) => (Array.isArray(row.parent) ? row.parent : []);

  const eligible = (row) => !isThirdParty(row, config) && !COMPONENT_KINDS.has(row.kind);

  // Everything that stands on its own, leaving the repository question aside.
  const standalone = rows.filter((row) => {
    if (!eligible(row) || row.kind === 'Repo') return false;
    const parents = parentsOf(row);
    if (parents.length === 0) return true;
    return parents.every((id) => {
      const parent = byId.get(id);
      return !parent || parent.kind === 'Repo';
    });
  });

  // Repositories that something above is standing in for. Computed from the
  // promoted set rather than from the raw children, because a repository whose
  // only children are components has nothing representing it on the exhibit and
  // still has to speak for itself.
  const represented = new Set();
  for (const row of standalone) {
    for (const id of parentsOf(row)) {
      const parent = byId.get(id);
      if (parent && parent.kind === 'Repo') represented.add(parent.id);
    }
  }

  const keep = new Set(standalone.map((row) => row.id));
  for (const row of rows) {
    if (eligible(row) && row.kind === 'Repo' && !represented.has(row.id)) keep.add(row.id);
  }

  return rows.filter((row) => keep.has(row.id));
}

// What each entry is still missing.
function gaps(rows, config) {
  return exhibitRows(rows, config)
    .map((row) => {
      const missing = REQUIRED.filter((field) => !row[field.key]).map((field) => field.label);
      // An entry whose source is gone needs its summary to carry the claim on
      // its own, because there is nothing left to point at.
      if (row.visibility === 'No repo' && !row.exhibitSummary) {
        missing.push('source gone and no written summary');
      }
      return { row, missing };
    })
    .filter((entry) => entry.missing.length > 0);
}

function formatDate(value) {
  return value || '—';
}

function evidenceLine(row) {
  if (row.repo) return `${row.repo} (${row.visibility || 'visibility unrecorded'})`;
  if (row.visibility === 'No repo') return 'no surviving repository';
  return 'no repository recorded';
}

function renderGapReport(entries, total) {
  const lines = [];
  lines.push('## Gaps to close first');
  lines.push('');
  if (!entries.length) {
    lines.push(`All ${total} entries carry a date and a statement of authorship. Nothing to close.`);
    lines.push('');
    return lines.join('\n');
  }
  lines.push(
    `${entries.length} of ${total} entries cannot carry weight yet. Each one is listed with what it needs.`
  );
  lines.push('');
  lines.push('| Entry | Kind | Missing |');
  lines.push('|---|---|---|');
  for (const { row, missing } of entries) {
    lines.push(`| ${row.name} | ${row.kind || '—'} | ${missing.join('; ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderExhibit(rows, config, options = {}) {
  const now = options.now || new Date().toISOString().slice(0, 10);
  const entries = exhibitRows(rows, config);
  const gapEntries = gaps(rows, config);

  const complete = entries.filter(
    (row) => !gapEntries.some((entry) => entry.row.id === row.id)
  );

  const lines = [];
  lines.push('# Exhibit A — prior intellectual property');
  lines.push('');
  lines.push(`Generated ${now} from the IP inventory. **This is a draft for a lawyer to review.**`);
  lines.push('It is not legal advice, and the wording of an invention-assignment carve-out matters.');
  lines.push('');
  lines.push(
    `${entries.length} works, of which ${complete.length} are fully evidenced. `
    + `${config.excludeKindsFromExhibit.join(', ')} rows are third-party services and are excluded.`
  );
  lines.push('');

  lines.push(renderGapReport(gapEntries, entries.length));

  lines.push('## Works');
  lines.push('');

  const byCategory = new Map();
  for (const row of complete) {
    const key = row.category || 'Uncategorised';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(row);
  }

  if (!complete.length) {
    lines.push('No entry is currently complete enough to list. Close the gaps above first.');
    lines.push('');
  }

  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`### ${category}`);
    lines.push('');
    const sorted = byCategory.get(category).sort((a, b) =>
      String(a.dateStarted).localeCompare(String(b.dateStarted))
    );
    for (const row of sorted) {
      lines.push(`**${row.name}** — first created ${formatDate(row.dateStarted)}`);
      lines.push('');
      if (row.exhibitSummary) {
        lines.push(row.exhibitSummary);
      } else if (row.oneLiner) {
        lines.push(row.oneLiner);
      }
      lines.push('');
      lines.push(`- Evidence: ${evidenceLine(row)}`);
      if (row.ipDistinction) lines.push(`- Basis: ${row.ipDistinction}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { renderExhibit, renderGapReport, exhibitRows, gaps, COMPONENT_KINDS, REQUIRED };
