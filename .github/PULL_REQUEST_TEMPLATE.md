# Pull Request

## What

<!-- one paragraph: what changes and why (link the B2G-/BUG-/SEC- ID if applicable) -->

## How verified

- [ ] `npm test` green (local store)
- [ ] `npm run test:race -w apps/api` green
- [ ] `node apps/api/test/security.js` green (if security-adjacent)
- [ ] `STORE=oracle` suite green (if engine-facing — db-tests job covers it)
- [ ] No string-concatenated SQL; binds only (CONTRIBUTING rule)
- [ ] Docs updated if behavior/claims changed (README / SECURITY.md / ADR)

## Risk

<!-- what could this break? single-VM scope assumed -->
