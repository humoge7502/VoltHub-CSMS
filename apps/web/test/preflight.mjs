#!/usr/bin/env node
/* global process, console, fetch, AbortSignal */
// Both browser suites expect a console already listening at BASE_URL. Without this
// check the first symptom was a 45-second Playwright navigation timeout and a stack
// dump, which reads like a broken page instead of a missing server.
export async function requireServer(base) {
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(5000) });
    console.log(`preflight: ${base} answered ${r.status}`);
  } catch (e) {
    console.error(
      `preflight: nothing answering at ${base} (${e.message}).\n` +
        '  start the console first: npm run build -w apps/web && npm run start -w apps/web'
    );
    process.exit(2);
  }
}
