# ADR-0013: Benchmark methodology — pre-registered metrics and a claims budget

Date: 2026-09 · Status: accepted

## Context

The repo's receipts culture (BUG-010 stripped unmeasured perf numbers; the AI
sidecar publishes `beats_naive: false` when true) is its most valuable asset. The
FC-HCC loop adds economic claims (cost, peak, deadline satisfaction) that are even
easier to fake accidentally: seeds, contention levels, and baseline choices can
flip a result. A methodology decided AFTER results exist is not a methodology.

## Decision

The benchmark suite follows the blueprint's scientific reporting rules, scaled to
what the repo can honestly measure today:

- **One script per experiment** in `bench/` (`e1-cost.js`, …) emitting
  `bench/results/<id>.json` with an environment block (node, platform, CPUs,
  timestamp) and the full seed/params — reproducible by one command.
- **Pre-registration**: each script carries its hypothesis, metric definitions,
  and acceptance threshold in its header BEFORE results are committed. Changing a
  metric after results exist requires a new experiment id (e1b, e2b, …).
- **Paired comparisons, same seed stream**: FC-HCC and baselines (uncontrolled,
  static-cap) run against identical scenario streams per seed; deltas are paired,
  not independent. Determinism rule: same seed ⇒ same scenario fleet.
- **Claims budget**: the README/CHANGELOG may only claim numbers that exist in
  `bench/results/` with a matching committed script — the docs-lint spirit of the
  OpenAPI drift gate generalized to prose.
- **E1 (energy cost)**: FC-HCC merit-order LP vs uncontrolled vs static-cap under
  a 10 kW site cap, 15-min intervals, 8-vehicle contention ladder; metrics:
  cost_units, peak_kw, unmet_kwh per seed. First receipt: 20 seeds (deterministic
  surrogate LP ⇒ variance across seeds comes from arrival streams only); CIs enter
  with the stochastic twin (Phase 6).

## Consequences

- Every optimization claim is arguable by data, not by adjective; a failed
  experiment is published as-is (negative results are assets).
- The suite grows with the twin: 30-seed bootstrap CIs and perfect-foresight LP
  upper bounds enter when the generative simulator lands, without redefining
  existing metric names.

## Rejected alternatives

- Hand-run "spot checks" recorded in prose: unreproducible, unverifiable, and the
  exact BUG-010 failure mode this ADR exists to prevent.
- Reporting only the best seed: cherry-picking is p-hacking with extra steps;
  paired deltas across the full pre-registered seed set are the minimum honest unit.
