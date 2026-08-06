# Spend Guardrails

Spend Guardrails chooses the lowest-cost Claude model that can reliably do the
work. It keeps Sonnet as the default, moves bounded mechanical work to Haiku,
and requires a concrete capability need or failed evaluation before escalating
to Opus or Fable.

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

The ladder includes dated Claude API base prices and links to Anthropic's
official model and pricing documentation. Recheck those sources before using
the table for a budget or forecast; model availability and prices change.
