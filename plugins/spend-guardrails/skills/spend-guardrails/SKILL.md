---
name: spend-guardrails
description: Choose the lowest-cost available AI model that can reliably complete a task, verify current model availability and pricing before naming exact IDs, avoid deprecated or retired models, pin models for recurring work, and define evidence-based escalation triggers. Use when selecting Anthropic Claude or OpenAI models, reviewing model spend, designing mixed-model agent workflows, assigning subagents, or migrating work away from an old model.
---

# Spend guardrails

Choose the lowest capability tier that reliably holds the work. Move down for
bounded mechanical volume. Move up only for a named capability need or a failed
evaluation.

## Verify the live catalog

Before returning an exact model ID, availability claim, or price:

1. Identify the provider and target surface. API, Claude Code, Codex, and hosted
   chat products may expose different models.
2. Read the provider's current official model catalog and model-selection guide.
3. Check the official deprecation or retirement notice for the candidate.
4. Check current official pricing only when the decision needs a numerical cost
   comparison.
5. State the verification date and link the sources in the recommendation.

For Anthropic, begin with the official
[models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
[pricing guide](https://platform.claude.com/docs/en/about-claude/pricing), and
[model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).
For OpenAI, begin with the official
[models catalog](https://developers.openai.com/api/docs/models),
[model guidance](https://developers.openai.com/api/docs/guides/latest-model),
and [deprecations](https://developers.openai.com/api/docs/deprecations).

Treat embedded model knowledge as a hint, never the source of truth. If current
official sources are unavailable, recommend a capability tier without an exact
ID or price and say that live verification was unavailable. Never guess.

## Handle model lifecycle

- Never recommend a retired model.
- Do not start new work on a deprecated model. Name the provider's current
  replacement and the migration check the workload must pass.
- If an existing workflow pins a deprecated model, report the retirement date
  when published and propose a tested migration rather than silently changing
  it.
- Treat a new model as a candidate, not an automatic upgrade. Compare it on
  representative evaluations at the current effort level and one cheaper
  setting or tier.
- Keep a working pin when a new release does not improve reliability, latency,
  or total cost for that workload.

## Choose the tier

Use these provider-neutral tiers after verifying which current models fill them:

| Tier | Start here for |
|---|---|
| Economy | Classification, extraction, formatting, bulk sweeps, simple QA, and bounded work with cheap deterministic verification |
| Balanced | The default for coding, analysis, documents, integrations, research, and most tool-using agents |
| Premium | Complex agentic coding, architecture, large refactors, difficult synthesis, and long autonomous work |
| Maximum | The hardest long-running or deeply ambiguous work, only when the provider offers a higher tier and the capability is demonstrably necessary |

Current dated examples belong in the release evaluations, not in this decision
rule. Providers do not need to expose the same number of tiers.

1. Define the result and how it will be checked.
2. Start with the verified balanced tier unless the work plainly fits a
   neighboring tier.
3. Use the verified economy tier only when the task is bounded, failures are
   easy to detect, and volume or latency makes the savings material.
4. Use the verified premium tier when success depends on sustained planning,
   cross-system judgment, or complex autonomous execution that the balanced
   tier has failed or is not designed to carry.
5. Use a verified maximum tier only with explicit opt-in. State the capability
   need, why premium is insufficient, and what ends the expensive run.

Before changing tiers, tune the current model's effort when that control is
available. Effort is often a cheaper lever than a model upgrade.

## Split planning from execution

For work that needs a premium planning pass but routine execution:

- Have the verified premium model produce the architecture, decision record,
  or bounded work plan.
- Pin the verified balanced model on implementation agents.
- Pin the verified economy model on mechanical fan-out only when checks are
  strong.
- Return to the planner only when execution hits a named escalation trigger.

Do not leave subagents or scheduled tasks on an inherited model by accident.
Pin the chosen model in their configuration. Never leave recurring work on a
premium or maximum model without a written reason.

## Escalate on evidence

Valid escalation signals include:

- a task-specific evaluation fails after one focused revision;
- the model loses constraints across a long context or multistep tool run;
- architecture spans enough systems that local fixes conflict;
- ambiguity cannot be reduced with a short question, plan, or smaller task;
- the cost of a wrong answer clearly exceeds the incremental model cost.

Do not escalate because the work is visible, urgent, executive-facing, or
described as strategic. Those facts change review rigor, not model capability.

## Report the decision

When live verification succeeds, return:

```text
Model: <verified model id>
Provider and surface: <where this ID is available>
Why: <one sentence tied to the task>
Why not cheaper: <the specific capability or failed check>
Escalate if: <observable trigger>
Lifecycle: <active, or migration note if reviewing an existing deprecated pin>
Cost note: <only when volume, context, caching, or recurring runs matter>
Verified: <date and official source links>
```

When live verification fails, replace `Model` with `Capability tier`, omit exact
pricing, and say that an exact ID must be checked before pinning it.
