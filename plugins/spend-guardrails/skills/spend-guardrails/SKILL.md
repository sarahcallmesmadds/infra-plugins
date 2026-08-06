---
name: spend-guardrails
description: Choose the lowest-cost Claude model that can reliably complete a task, pin models for subagents and scheduled work, and define evidence-based escalation triggers. Use when selecting a model, reviewing model spend, designing agent workflows, assigning subagents, or deciding whether work needs Haiku, Sonnet, Opus, or Fable.
---

# Spend guardrails

Choose the lowest rung that reliably holds the work. Default to Sonnet. Move
down for bounded mechanical volume and move up only for a named capability need
or a failed evaluation.

## Current ladder

Prices are Claude API base rates per million tokens, verified 2026-08-05 from
Anthropic's [model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
and [pricing guide](https://platform.claude.com/docs/en/about-claude/pricing).
Recheck them before producing a budget or cost forecast.

| Rung | Model | Input / output | Start here for |
|---|---|---:|---|
| 1 | `claude-haiku-4-5` | $1 / $5 | Classification, extraction, formatting, bulk sweeps, simple QA, and other bounded work with cheap verification |
| 2 | `claude-sonnet-5` | $3 / $15 | The default: coding, analysis, documents, integrations, research, and most tool-using agents |
| 3 | `claude-opus-5` | $5 / $25 | Complex agentic coding, architecture, large refactors, difficult synthesis, and multihour autonomous work |
| 4 | `claude-fable-5` | $10 / $50 | The hardest long-running or deeply ambiguous work when the highest available capability is necessary |

Sonnet 5 has introductory API pricing through 2026-08-31. The table shows its
standard price so a durable workflow does not depend on a temporary discount.

## Choose the rung

1. Define the result and how it will be checked.
2. Start with Sonnet unless the work plainly fits a neighboring rung.
3. Use Haiku only when the task is bounded, failures are easy to detect, and
   volume or latency makes the savings material.
4. Use Opus when success depends on sustained planning, cross-system judgment,
   or complex autonomous execution that Sonnet has failed or is not designed
   to carry.
5. Use Fable only with explicit opt-in. State the capability need, why Opus is
   insufficient, and what ends the expensive run.

Before changing models, tune the current model's effort when that control is
available. Effort is often a cheaper lever than a model upgrade.

## Split planning from execution

For work that needs a premium planning pass but routine execution:

- Have Opus produce the architecture, decision record, or bounded work plan.
- Pin Sonnet on implementation agents.
- Pin Haiku on mechanical fan-out and verification only when checks are strong.
- Return to the planner only when execution hits a named escalation trigger.

Do not leave subagents or scheduled tasks on an inherited model by accident.
Pin the chosen model in their configuration. Never leave recurring work on
Opus or Fable without a written reason.

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

When asked which model to use, return:

```text
Model: <model id>
Why: <one sentence tied to the task>
Why not cheaper: <the specific capability or failed check>
Escalate if: <observable trigger>
Cost note: <only when volume, context, caching, or recurring runs matter>
```

If no cheaper model was considered because Sonnet is the default, say that
plainly instead of inventing a rejection.
