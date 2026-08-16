---
name: say-it-simply
description: Rewrite an answer that did not land. Reorder it around what the user needs to do, replace jargon with plain language, and choose a clear shape for a decision, status, finding, explanation, or draft. Use when the user pushes back on an answer, asks for plain language, or says they are lost or do not understand.
---

# say-it-simply

Rewrite an answer so the user can repeat the main point and knows what to do.
This shapes writing as it is produced. Its sibling `slop-check` reports on
writing that already exists, and the two are not the same job.

## The core test

The failure is often order rather than length. Cutting words does not fix an
answer whose ask is buried, whose status replaces a next action, or whose
decisions run together without a recommendation.

Before returning the rewrite, ask:

1. Can the user repeat the main point in one sentence?
2. Do they know what they need to do, decide, or stop worrying about?

## Pick the shape

Choose the shape that matches the reply:

| Kind | Shape |
|---|---|
| Decision | Numbered options, recommendation marked, context underneath |
| Status | What the user needs to do, then what happens next |
| Finding | The problem, then what it has cost so far |
| Explanation | The one sentence to remember, then why it matters |
| Draft | The ask, then one line describing the draft |

A finding always says what it has cost, including "nothing yet" when true. A
decision always carries a marked recommendation. Options without a recommendation
hand the analysis back to the user.

## Replace jargon rather than defining it

Defining a specialist term still makes the user carry it. Prefer the effect in
plain language:

| Instead of | Write |
|---|---|
| a shadowed entry | the name points at the wrong document |
| reconcile | check the saved records and repair disagreements |
| dependency review | check the things that rely on this change |
| mutation testing | break it on purpose to confirm the tests notice |
| publish, when nothing becomes public | save a private copy |

Use the user's own vocabulary when it is available in the conversation or in a
documented user-owned configuration file. Do not infer personal preferences from
the plugin author's examples, repository, or identity. Give exact commands only
when the user needs to run them.

## Distinguish related things

When two related tools or actions appear, say which one the user reaches for and
what the other one does. Name the action first, explain its effect, then explain
the related report or summary.

For example: logging records a problem; a weekly summary only gathers problems
that were already logged.

## Keep names; remove addresses unless needed

A name helps the user locate the subject. An address is useful only when they
need to navigate to it.

| Kind | Include it? |
|---|---|
| Product, plugin, skill, or feature name | Yes; add a short plain-language description if needed |
| File path, commit hash, pull request number, or internal record ID | Only when the user is going there or needs to verify it |

Do not strip every identifier in the name of simplicity. A report without the
name of the thing that changed is clear but unusable.

## End on the user's position

The last line states what the user does, decides, or can stop worrying about.
Put process, caveats, and unresolved detail above it. End with one of:

- the action to take;
- the decision to make; or
- a direct statement that nothing is needed from the user.

## Do not narrate unrelated process

Do not include self-corrections, method notes, failed attempts, or a history of
how the answer was produced unless they change what the user should trust. If a
process detail matters, give it one line and connect it to the decision.

## Make claims checkable

- Give the most useful checkable fact, not a sales pitch about diligence.
- Name any gap plainly in one line.
- Distinguish facts proved by running something from facts learned by reading.
- If the user questions a claim, say what evidence would settle it and obtain
  that evidence when the request authorizes doing so.

## Cuts that apply to every shape

- Lead with the answer before the reasoning.
- Use a table when several exact mappings or comparisons need to be scanned.
- Number proposed actions in execution order.
- Once numbered options are shown, keep their numbers stable. Append new options
  or explicitly replace and repeat the whole list.
- Give each reviewed item its own verdict rather than referring to another item
  only by position.
- Explain what a count measures and whether it is expected; omit decorative counts.
- Offer secondary detail when it is optional instead of front-loading it.

## How to use this

When the user pushes back, take the answer that drew the pushback, identify its
kind, and rewrite it in the matching shape. Do not apologise, explain the first
failure, or provide both versions. Return only the improved answer.

When invoked without text to rewrite, briefly state what the skill does and ask
for the text. Do not invent an example answer.

## User-owned preferences

Personal vocabulary, formatting choices, prohibited terms, and standing examples
belong outside this shipped skill. If a user supplies them, follow the connected
product's documented user-owned configuration or memory mechanism. The reusable
rules in this file remain neutral for every installer.

## What this is not

It is not a fixed length limit. A short answer can still hide the point, and a
long answer can work when its order is clear.

It is not an automatic hook. Do not turn it into one without explicit user
approval.
