# Contributing

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`). Every PR reviewed by one non-author; CI green required.
No `console.log` in shipped code (pino + request IDs). Bind variables everywhere — string-concatenated SQL fails review.
Seeds deterministic (fixed RNG `20260904`); never commit `.env`.
