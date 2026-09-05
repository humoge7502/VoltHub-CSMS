// ESLint 10 flat config (replaces the pre-flat .eslintrc.json).
// Mirrors the old rule set exactly so the upgrade is a config-shape change, not a
// policy change: eslint:recommended + no-unused-vars/eqeqeq/no-throw-literal/etc.,
// with the same per-directory overrides (web JSX, test/script console, k6 files).
'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Node 20+ exposes globalThis.crypto (webcrypto) and WebSocket; this codebase
// idiomatically does `const crypto = require('crypto')` / `const WebSocket =
// require('ws')`, which no-redeclare would now flag against those globals. Drop
// them from the linted global scope (the old env-based config never saw them).
const nodeGlobals = { ...globals.node };
delete nodeGlobals.crypto;
delete nodeGlobals.WebSocket;

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/package-lock.json',
      '.shot-tmp/**',
      'data/**',
    ],
  },
  js.configs.recommended,
  {
    // Base: CommonJS node files. The old config used env:{node,browser} which eslint
    // excluded from no-redeclare; flat-config globals do not get that exemption, so
    // browser globals (WebSocket, etc.) must stay scoped to the web override below —
    // otherwise `const crypto = require('crypto')` redeclares the browser crypto global.
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'log'] }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-throw-literal': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Next.js App Router client/server pages: ESM + JSX. no-unused-vars stays off
    // (JSX element props / hook returns are conventionally loose, as before).
    files: ['apps/web/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: { 'no-unused-vars': 'off' },
  },
  {
    files: ['**/test/**/*.js', 'scripts/**/*.js', 'apps/worker/src/**/*.js', 'apps/simulator/src/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/load/**/*.js', 'bench/k6-*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-console': 'off', 'no-undef': 'off', 'no-unused-vars': 'off', 'prefer-const': 'off' },
  },
];
