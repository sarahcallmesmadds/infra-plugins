# Spend Guardrails

Spend Guardrails chooses the lowest-cost available AI model that can reliably
do the work. It supports Anthropic Claude and OpenAI, verifies exact model IDs,
pricing, and lifecycle status against current official sources, and requires a
concrete capability need or failed evaluation before escalating.

It works in both Claude Code and Codex. The skill is advisory and read-only: it
does not change files or account settings. It uses read-only web lookups to
verify current model IDs, pricing, and lifecycle status, so web access is
required for an exact recommendation. Without it, the skill returns a
capability tier and clearly withholds unverified IDs and prices.

## Install

Add the `infra-plugins` marketplace, then install `spend-guardrails` from it. In Claude
Code:

```text
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install spend-guardrails@infra-plugins
```

No setup or configuration is required. Ask a model-selection question in a new
chat as soon as installation finishes.

## Use it

Ask:

> Which current model should this task use, and why?

Name the provider and target surface when they matter, for example “Which
current OpenAI API model should run these workers?” The skill returns a verified
model ID when official sources are available, why it fits, why a cheaper model
does not, and the observable condition that would justify escalation. Without
live verification, it returns only the capability tier and tells you to verify
an exact ID before pinning it.

It also helps design mixed-model agent workflows: a premium planning pass when
needed, balanced implementation agents, and economy fan-out where verification
is strong. Recurring agents should always pin a verified model, and premium or
maximum models should never be inherited without a written reason.

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
`tests/fixtures/spend-guardrails-evals.json`. They cover bounded economy
fan-out, a premium cross-system refactor, and important work that should remain
on the balanced tier for both providers. These cases record human-observed
results; they do not pretend that a string assertion can execute and grade
model judgment.
