# Security Policy

Argon2id password hashing (prod; scrypt locally with identical interface), 15-min JWT + rotating SHA-256 refresh with family revocation, RBAC guards + `VOLTHUB_APP_ROLE` least-privilege grants (no DELETE anywhere, no UPDATE on ledger/audit/readings, connector status via gateway only).
Bind variables everywhere; Zod/shared validation at edge + Oracle CHECKs (DB never trusts app). No card data, ever — internal wallet ledger only. Report issues privately to the repo owners.
