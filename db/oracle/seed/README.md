# Seed — deterministic, coherent, story-shaped (§16)

`scripts/seed/generate.js` (RNG `20260904`) drives the same package semantics the
API uses: 18–21h peak weighting, one faulted CCS2 highway connector, tariff
v1→v2 mid-window, one EXPIRED no-show, one thin wallet. `demo` profile
(12 users / 60 sessions) boots in <1s; `SEED_PROFILE=full` scales to
~400 users / 400 sessions. The runner re-checks Q25/Q19/billing/meter invariants
and exits non-zero on any violation.
