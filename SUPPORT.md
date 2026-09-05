# Support

You found a wall. Here's where to hit it, in order:

| You need…                                        | Go to                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A question** ("why does the relay ack twice?") | [Discussions → Q&A](https://github.com/humoge7502/VoltHub-CSMS/discussions/categories/q-a). The template asks what you already read — the [ADRs](docs/adr/) answer most of it.              |
| **A design idea** ("swap the relay for NATS?")   | [Discussions → Ideas](https://github.com/humoge7502/VoltHub-CSMS/discussions/categories/ideas) — name the trade-off and the rejected alternative, like an ADR would.                        |
| **A bug**                                        | [Open an issue](https://github.com/humoge7502/VoltHub-CSMS/issues/new?template=bug_report.yml). Include: scenario, expected vs actual, and what actually ran (the repo's own receipts bar). |
| **A feature request**                            | Same issue flow — be honest about scope; single-maintainer bandwidth is a real constraint.                                                                                                  |
| **A security vulnerability**                     | **Do not open an issue.** Follow [`SECURITY.md`](SECURITY.md) — private reporting, 48-hour acknowledgment.                                                                                  |
| **"Is this production-ready?"**                  | Read [`docs/verification.md`](docs/verification.md) and [Honest limits](README.md#honest-limits) first — the answer is written down on purpose.                                             |

## Before asking

1. `npm install && npm run dev:api` — the local profile boots seeded in seconds, no Docker.
2. Search [past discussions](https://github.com/humoge7502/VoltHub-CSMS/discussions) — if it's a trade-off, it may already be an [ADR](docs/adr/).
3. The [docs site](https://humoge7502.github.io/VoltHub-CSMS/) is the 1-page tour.

## Response expectations

Solo maintainer, best-effort support: questions usually answered within a few
days; security reports acknowledged within 48 hours. This section is itself a
commitment — it will be updated if it stops being true.
