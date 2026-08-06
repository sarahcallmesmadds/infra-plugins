# Spend Guardrails

Spend Guardrails chooses the lowest-cost available AI model that can reliably
do the work. It supports Anthropic Claude and OpenAI, verifies exact model IDs,
pricing, and lifecycle status against current official sources, and requires a
concrete capability need or failed evaluation before escalating.

It works in both Claude Code and Codex. The skill is advisory and read-only: it
does not call tools, change files, or alter account settings.

## Install

Add the `smadds` marketplace, then install `spend-guardrails` from it. In Claude
Code:

```text
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install spend-guardrails@smadds
```

No setup or configuration is required. Ask a model-selection question in a new
chat as soon as installation finishes.

## Use it

Ask:

> Which Claude model should this task use?

The skill returns the model ID, why it fits, why a cheaper model does not, and
the observable condition that would justify another escalation.

It also helps design mixed-model agent workflows: a premium planning pass when
needed, Sonnet implementation agents, and Haiku fan-out where verification is
strong. Recurring agents should always pin their model, and Opus or Fable
should never be inherited without a written reason.

## Pricing

The selection framework uses stable economy, balanced, premium, and maximum
capability tiers. Before it names an exact model or price, it checks the target
provider's current official catalog, pricing, and deprecation notices. It never
recommends a retired model or starts new work on a deprecated model.

If current sources cannot be reached, the skill returns a capability tier and
plainly withholds an unverified model ID or price. New releases and retirements
therefore do not require a manual plugin edit before the next recommendation;
the dated release evaluations are evidence and fallback context, not the live
catalog.

## Release verification

The rerunnable, provider-specific forward-evaluation cases live in
`tests/fixtures/spend-guardrails-evals.json`. They cover bounded Haiku fan-out,
an Opus-worthy cross-system refactor, important work that should remain on
Sonnet, and the equivalent OpenAI tiers. These cases record human-observed
results; they do not pretend that a string assertion can execute and grade
model judgment.
