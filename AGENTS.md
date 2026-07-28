# CiteLoom Agent Guidance


# Evidence Before Change

Do not modify code, configuration, tests, documentation, data, or infrastructure
until the proposed change is supported by repository or system evidence.

Treat the first explanation and first solution as hypotheses, not conclusions.

## Before Editing

For non-trivial work, establish:

* the intended outcome
* the current behaviour
* the component that owns that behaviour
* the invariant or contract affected
* the relevant callers, tests, configuration, and dependency versions
* the material unknowns
* at least one credible alternative

Use read-only inspection before the first consequential edit.

Do not infer architecture, ownership, behaviour, or requirements from filenames,
conventions, memory, or familiarity when direct inspection is available.

## Evidence Labels

Distinguish internally between:

* **Observed:** directly inspected, executed, or measured
* **Derived:** follows from verified code, types, constraints, or documentation
* **Assumed:** plausible but unverified
* **Unknown:** insufficient evidence

Never present an assumption as a fact.

Never implement against a material assumption when it can be verified at
reasonable cost.

Convert material assumptions into investigation steps.

## Multiple Hypotheses

Do not search only for evidence supporting the first explanation.

For ambiguous bugs, behaviour, or design decisions:

1. identify the strongest credible explanations
2. state what evidence would distinguish them
3. inspect for both supporting and contradicting evidence
4. discard explanations that fail
5. proceed with the explanation best supported by the repository and observed
   behaviour

Do not create artificial alternatives merely to satisfy a quota.

One serious competing explanation is better than several cosmetic variations.

## Compare Solutions Before Choosing

For non-trivial changes, inspect whether the problem is already addressed by:

* existing repository code
* an established project abstraction
* configuration
* a stronger invariant or data model
* a supported framework feature
* the standard library
* a maintained dependency
* a smaller local change
* deletion or simplification of existing code

Do not select the first workable solution.

Prefer the least complex option that satisfies the requirements and material
risks.

## Repository Before External Patterns

Understand the repository before applying generic external guidance.

Inspect local conventions, versions, abstractions, and constraints first.

Use official documentation when behaviour is version-sensitive, unclear, or
potentially outdated.

Generic examples do not override repository-specific architecture without
evidence that the repository approach is wrong or obsolete.

## Earn the Right to Edit

Before a consequential edit, be able to answer:

1. What evidence shows the current behaviour?
2. What evidence shows the behaviour is wrong or incomplete?
3. Which invariant or requirement is affected?
4. Why is this the correct component to change?
5. Which simpler or existing alternatives were considered?
6. What material assumptions remain?
7. How will the result be verified?

If any answer is missing and could materially change the implementation,
continue investigating.

## Stop Conditions

Stop editing and reconsider when:

* repository evidence contradicts the current explanation
* the affected ownership boundary differs from what was assumed
* a simpler existing solution is discovered
* the change becomes materially broader or riskier
* tests reveal a different root cause
* a load-bearing assumption cannot be verified
* the selected approach no longer preserves the required invariant

Do not improvise past contradictory evidence.

Update the plan or recommendation before continuing.

## Reporting

For non-trivial work, communicate concisely:

* what was observed
* what remains assumed or unknown
* which approach was selected
* which credible alternative was rejected and why
* what was actually verified

Do not expose private chain-of-thought.

Present evidence, decisions, trade-offs, and unresolved uncertainty.

## Tooling and Verification

- Use pnpm and the scripts declared in `package.json`.
- Use `pnpm typecheck`, `pnpm lint`, and `pnpm build` for standard validation.
