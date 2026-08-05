# Paired and adjacent file audit

Discover pairs from the repository in front of you. Do not ship a universal hardcoded map.

Check these relationships for every touched file:

| Changed surface | Audit alongside it |
|---|---|
| Implementation | Unit tests, integration tests, fixtures, snapshots, mocks |
| Public function or type | Callers, importers, generated types, schemas, examples |
| Configuration | Loaders, defaults, example config, deployment config, validation |
| CLI or command | Help text, command registry, docs, completions, parsing tests |
| Hook | Hook manifest, event fixture, executable bit, installation docs |
| Skill | Frontmatter, linked references/scripts, plugin docs, discovery metadata |
| Manifest or version | Marketplace entry, alternate manifests, lockfiles |
| Documentation claim | Runtime source of truth, other copies, counts, cross-references |
| State or plan document | Frontmatter, body tables, requirements, roadmap |

Use repository search to find:

- files with the same basename or stem;
- imports and references to changed symbols;
- duplicated or installed copies;
- tests and fixtures in mirrored directory structures;
- prose naming changed commands, fields, paths, versions, or counts.

Record each candidate in `paired_file_audit` as `changed`, `checked`, or `not-applicable`, with a reason. A list of filenames without outcomes is not an audit.
