# Final review patterns

Use this after implementing the round. It is a compact portable version of the recurring patterns found across historical Devin reviews.

1. Documentation or examples contradict runtime behavior.
2. A paired file, test, fixture, or duplicate copy was not updated.
3. A renamed symbol, command, field, or type still has consumers.
4. A configuration value is declared, loaded, documented, or deployed inconsistently.
5. An error is swallowed, converted to false success, or left unhandled.
6. A regex, glob, path boundary, or shell parser misses an ordinary edge case.
7. A filter, authorization check, validation step, or default is absent.
8. Async work races, rejects without handling, or reports completion too early.
9. A schema, fixture, serialized shape, or count drifted from its source of truth.
10. A test proves the happy path but cannot fail for the reported regression.
11. A hardcoded user, machine, secret, repository, or environment assumption escaped into shared code.
12. A branch is unreachable, a condition is inverted, or a comparison excludes its boundary.

For each match, search adjacent surfaces before deciding it is isolated. Cite exact files and lines in the round record.
