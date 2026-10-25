# VoltHub CSMS — Product, UX, Accessibility & AI Audit

**Date:** 25 October 2026  
**Scope:** `apps/web`, `apps/ai`, the API contracts consumed by the web console, and the product claims in `docs/`  
**Mode:** read-only review. No application source was modified; this report is the only file added.  
**Snapshot:** The AI receipt was regenerated at **10:32 IST on 25 Oct 2026** (87 series, three sources) while this audit was in progress. This version uses that receipt. The earlier 47-station receipt survives only in `apps/ai/reports/train-real.log`; wherever it is cited it is labelled **“prior 47-station receipt.”** The web/API review was re-checked against the current tree, including the new CarbonPilot surface.  
**Evidence:** direct file reads, contrast calculations from the design tokens, and a read-only reconstruction of the current 87-station AI test split (plus the prior 47-station split for comparison). Line numbers are as of the date above.

---

## 0. Verdict at a glance

> **The backend is more trustworthy than the frontend makes it look.** The money path has real, unusual strengths: database-enforced reservation and billing invariants, race tests, an outbox, and an OpenAPI drift gate. The web console repeatedly undermines that trust thesis by showing another station's data, closing a dialog after a failed mutation, or leaving a paid invoice looking unpaid. The AI sidecar is honestly framed as advisory and degrades gracefully, but its published metrics are still not decision-grade: the current 87-station model beats a zero forecast by only **7.1% pooled**, and zero wins on Tennessee and Korea (80 of 87 series); the calibration protocol leaks, and the test set is 24 overlapping windows per origin. The prior 47-station receipt actually lost to zero at **31 of 47 stations**. Fix truthfulness before adding surface area.

**Overall score: 4.9 / 10** — a credible engineering core that is not yet a trustworthy commercial product.

### What is genuinely working

- **Money-path correctness is architectural, not aspirational.** Reservations and billing are enforced in the database, with 201/409 race tests and SQL invariants (`docs/STRATEGY-AND-ROADMAP.md:230-235`). This is the strongest differentiator in the repo.
- **The AI service is explicitly advisory.** It carries `advisory: true`, refuses public callers with an internal token, verifies artifact checksums and feature versions, and falls back to seasonal-naive rather than inventing a forecast (`apps/ai/service.py:1-6`, `:32-57`, `:77-149`, `:259-366`).
- **The design system has a real point of view.** Dark ops surface, cream/lime palette, tabular numerals, visible focus rings, reduced-motion handling, and IST-normalized chart labels are all deliberate. The intent is better than most CSMS consoles.
- **Several failure paths are already thought through.** `PageState`, `StaleChip`, `ConfirmDialog`, and the artifact integrity checks show the team knows what honest failure looks like. The problem is inconsistent application, not absence of the idea.

### Top findings

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                 | Why it matters                                                                                                                                        | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | **Stale data is presented under the wrong station.** Dashboard and telemetry keep the previous station's payload when the selection changes; analytics and discover have no request sequencing.                                                                                                                                                                                                         | An operator can read station A's revenue or load while the UI says station B. This is a wrong-decision bug, not a cosmetic one.                       | Critical |
| 2   | **Failed mutations can look successful.** Fault completion closes the dialog after a failed `PATCH`; session and reservation actions lack busy guards; a successful reservation leaves the connector marked available.                                                                                                                                                                                  | Duplicate maintenance records, duplicate starts, repeated 409s, and loss of trust in the audit trail.                                                 | Critical |
| 3   | **The 15-minute access token has no silent refresh path.** The shared client does not time out, does not opt into credentials, and `AuthGate` only reacts after the failure.                                                                                                                                                                                                                            | Operators are ejected mid-session; hung requests leave skeletons forever; the httpOnly refresh cookie is unused in the default cross-origin topology. | High     |
| 4   | **Accessibility blockers remain on the core paths.** Map pins are interactive children of `role="img"`; toasts mount their live region only when a toast exists; charts have no table alternative; heatmap labels are 9px at ~3.96:1; the mobile drawer is not modal.                                                                                                                                   | WCAG 2.2 AA is not met for keyboard and screen-reader users; low-vision users cannot read a key telemetry view.                                       | High     |
| 5   | **AI evaluation is not decision-grade.** The current MLP beats zero by 7.1% pooled, but zero wins on Tennessee and Korea (80/87 series); 82.8% of test targets are zero; early stopping uses the conformal calibration block; 746,616 test targets are 31,109 origins × 24 overlapping leads.                                                                                                           | The headline 36% skill is carried by 7 Norwegian stations and hides source-level failure. Do not put these numbers in customer SLAs.                  | High     |
| 6   | **Provenance is spread across three generations of receipts.** The current `metrics.json` and `dataset.json` agree on 87 series / 3 sources, but `train-real.log` still describes a 47-station / 2-source run, and older 24-station simulation and 56.4-MAE claims survive in `benchmarks.json`, `docs/verification.md`, and `docs/perf.md`. The model receipt has artifact hashes but no dataset hash. | A reader cannot tell which dataset produced which number; the current receipt is not immutable evidence.                                              | High     |
| 7   | **Stale AI claims survive outside the main AI doc.** `docs/verification.md` still claims MAE 56.4, 3.5s on an A100, 15× GPU, and ~525× inference; `docs/perf.md` repeats 15×/~525×; the current receipts say 1.906 MAE, 642.61s CPU, 12.84× simulation, and 412.5× batch inference. `docs/ai-platform.md` is now current.                                                                               | In an audit-led product, stale numbers are a trust defect, not a docs chore.                                                                          | Medium   |

### The first ten decisions

1. **Stop shipping misleading state.** Reset domain state on station change; key every request by entity; cancel or ignore stale responses.
2. **Make mutation feedback truthful.** Close dialogs only on 2xx; add busy guards and idempotency keys; refresh the entity after success.
3. **Repair auth continuity.** One fetch wrapper with timeout, credentials, 401→refresh→retry, and a return path.
4. **Freeze AI claims and repair the evaluation before tuning the model.** Add the missing zero baseline, fix the calibration split, publish source/slice metrics, and bind the dataset hash into the model receipt.
5. **Clear the P0 accessibility blockers.** Map alternative, persistent live region, chart tables, modal drawer, contrast fix.
6. **Ship real payments and reconciliation.** The wallet ceremony is a demo; UPI/Razorpay and Stripe need PSP-hosted fields, webhooks, refunds, and GST.
7. **Ship signed webhooks and an SDK.** The outbox and 72-path OpenAPI surface make this the highest-leverage ecosystem move.
8. **Run a carbon-aware charging pilot with measurement and verification.** The CarbonPilot model-v1 surface already exists; the pilot needs live data, provenance, and M&V, not another dashboard.
9. **Spike OCPI 2.2 and OCPP 2.0.1 behind a conformance harness.** Do not claim either until a charger model and a roaming partner pass.
10. **Design multi-tenancy and SSO now, build with the first enterprise design partner.** SSO can land before full tenant isolation.

---

## 1. Scorecards

### 1.1 Overall

| Dimension                          |   Weight | Score /10 | Verdict                                                                                              |
| ---------------------------------- | -------: | --------: | ---------------------------------------------------------------------------------------------------- |
| Trust & correctness                |      25% |       5.0 | Excellent database invariants; UI too often hides or mislabels failure.                              |
| UX & interaction quality           |      20% |       6.0 | Distinctive visual system and some strong states; race and stale-data bugs undermine it.             |
| Accessibility (WCAG 2.2 AA)        |      15% |       4.0 | Good focus/reduced-motion foundations; core map, chart, toast, drawer, and contrast blockers remain. |
| AI / ML methodology                |      20% |       4.0 | Honest guardrails; evaluation leakage, weak baselines, and provenance gaps.                          |
| Product strategy & differentiation |      10% |       6.5 | Clear thesis and real proof assets; roadmap is broad and under-sequenced.                            |
| Integration readiness              |      10% |       4.0 | Strong OCPP/OpenAPI base; payments, notifications, maps, and accounting are demo-grade or absent.    |
| **Weighted total**                 | **100%** |   **4.9** | **Promising core; not yet trustworthy at the edges.**                                                |

### 1.2 UX sub-scorecard

| Dimension                | Score | Rationale                                                                                    |
| ------------------------ | ----: | -------------------------------------------------------------------------------------------- |
| First-run clarity        |     7 | The landing page and Discover explain the flow; the station-to-reservation step is clear.    |
| Error recovery           |     4 | Retry is a no-op on Analytics; several catches are empty; failed mutations close dialogs.    |
| Data truthfulness        |     3 | Cross-station stale data, null→zero formatters, and source-as-status pills actively mislead. |
| Keyboard & screen reader |     4 | Focus rings exist; map pins, drawer, radios, and live regions do not complete the path.      |
| Mobile                   |     5 | Responsive layout exists; 640px tables, 30px buttons, and 14px inputs create friction.       |
| Visual craft             |     8 | Coherent identity, strong typography, disciplined color; the best part of the frontend.      |
| Consistency              |     6 | Shared primitives are good ideas, but pages apply them unevenly.                             |

### 1.3 AI sub-scorecard

| Dimension                  | Score | Rationale                                                                                                                                   |
| -------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluation design          |     3 | Per-series recency folds, overlapping leads, leaked calibration, no zero baseline in the receipt.                                           |
| Data provenance            |     4 | Licenses and raw source hashes are documented; the model receipt does not bind the dataset hash, and three generations of receipts coexist. |
| Model quality              |     4 | Beats naive and zero pooled, but loses to zero on two of three sources and has a suspiciously flat horizon.                                 |
| Uncertainty                |     4 | Conformal attempt is real; absolute-kWh residuals pooled across stations produce misleading widths.                                         |
| MLOps & monitoring         |     3 | Artifact checks are good; no registry, drift, shadow, or post-deploy evaluation.                                                            |
| API guardrails             |     6 | Advisory-only, auth, checksums, and fallback are strong; contract versioning and validation are incomplete.                                 |
| Documentation truthfulness |     3 | Stale metrics and speedups contradict the committed receipts.                                                                               |

---

## 2. UX & accessibility review

### 2.1 Method and severity

- Reviewed every route and shared component under `apps/web/src`, plus the API routes the UI calls. The new CarbonPilot page and routes were included in the re-check.
- Paths in the UX tables are relative to `apps/web/src/app` unless they start with `lib/`, `components/`, or `src/`.
- Contrast ratios were calculated from the hex tokens in `globals.css`; no browser/axe run was performed. The report flags what should be confirmed with axe-core and a manual screen-reader pass.
- Severity reflects user/business impact, not code difficulty:
  - **Critical (S1):** can cause a wrong money/charging decision, data loss, or block a core task.
  - **High (S2):** likely task failure or misleading state; a workaround exists.
  - **Medium (S3):** friction, inconsistency, or degraded comprehension.
  - **Low (S4):** polish, documentation, or preference.
- Priority: **P0** now (≤1 week), **P1** next two sprints (≤3 weeks), **P2** within 90 days.
- **Catalogue notation:** each finding is prefixed with its severity (**S1** critical, **S2** high, **S3** medium, **S4** low). The section heading is the delivery priority (P0–P2), which is not the same thing.

### 2.2 The trust gap

The product thesis is "certainty is a database property." The UI currently violates that promise in four distinct ways:

1. **Wrong entity, right-looking screen.** The dashboard and telemetry pages keep the prior station's payload when the selection changes. If the new station fails, the old data stays on screen under a "reconnecting" chip (`dashboard/page.js:31,60-97`; `telemetry/page.js:33-65`). The user has no way to know the numbers belong to a different station.
2. **Silent failure.** Several catches are empty (`dashboard/page.js:77-88`; `analytics/page.js:31-33`; `profile/page.js:15-17`). A panel simply does not update, and the last value remains. The absence of an error is interpreted as success.
3. **False success.** `faults/page.js:40-52` catches a failed completion, sets the error, then closes the dialog and reloads anyway. `session/[id]/page.js:66-103` and `reservations/page.js:45-73` fire mutations without a busy guard, so a double click can duplicate the request. `stations/[id]/page.js:46-68` shows "BOOKED" while leaving the connector marked available and the form active, inviting a duplicate 409.
4. **Unknown rendered as zero.** `inr(null)` returns `₹0` and `kwh(null)` returns `0.00 kWh` (`ui.js:39-40`). Missing data is not zero; in a billing console, the difference is material.

This is not a visual-polish problem. A user who sees station A's revenue under station B's name will not trust the invoice. The fix pattern is consistent:

- Reset domain state when the selected entity changes.
- Key requests by entity and ignore responses that no longer match.
- Model mutations as `idle → busy → success | error`; close only on success.
- Render unknown as `—`, never as zero.
- Put the server error code and a human sentence on screen; log the correlation ID.

### 2.3 P0 catalogue — fix before the next demo

| ID    | Finding                                                                                                                                                                                                                                                   | Evidence                                                                                                                   | Impact                                                                                                                                                                          | Fix                                                                                                                                                                        | Effort | Depends on              | When     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----------------------- | -------- |
| UX-01 | **S2 · No silent auth refresh; no request timeout.** The 15-min access token expires; `api()` does not send cookies or abort; `AuthGate` only reacts after a failure.                                                                                     | `ui.js:20-38`, `:240-254`; `login/form.js:44-48`; `server.js:76`; `middleware/auth.js:108-119`                             | Operators are ejected mid-session. Hung requests leave skeletons indefinitely. The httpOnly refresh cookie is unused in the default `localhost:3000 → localhost:4000` topology. | One wrapper: `AbortController` 10s timeout, `credentials:'include'`, 401→`POST /auth/refresh`→retry once, then redirect with `returnTo`; keep access token in memory.      |   2–3d | Refresh endpoint exists | Week 1   |
| UX-02 | **S1 · Cross-station stale data and response races.** `gotDataRef` is never reset; dashboard/telemetry keep old payloads; analytics/discover have no sequence guard.                                                                                      | `dashboard/page.js:31,60-97`; `telemetry/page.js:33-65`; `analytics/page.js:23-34`; `discover/page.js:22-37`               | Station B can display station A's revenue/load. A failed B load looks like "reconnecting" with A's data.                                                                        | Reset `a/live/faults/strip/curve/heat` on `sel` change; key requests by station; `AbortController` + sequence; apply only latest; stale chip only for the current station. |     2d | UX-01 wrapper           | Week 1   |
| UX-03 | **S1 · Failed mutations look successful.** Fault completion closes after failure; session/reservation actions lack busy guards; reservation success leaves the connector available.                                                                       | `faults/page.js:40-52`; `session/[id]/page.js:66-103,282-302`; `reservations/page.js:45-73`; `stations/[id]/page.js:46-68` | Duplicate maintenance records, double starts, repeated 409s, false audit trail.                                                                                                 | Mutation state machine; close only on 2xx; inline error; disable competing actions; idempotency key; refresh entity.                                                       |   2–3d | UX-02                   | Week 1   |
| UX-04 | **S1 · Paid invoice detail stays unpaid.** Pay refreshes the list but not the open `det`; no dates or export.                                                                                                                                             | `invoices/page.js:41-55,141-185`                                                                                           | Driver may pay twice or open a support ticket; finance cannot reconcile or file.                                                                                                | Patch/reload `det`; show `issued_at`/`paid_at`; PDF/CSV; itemized panel as dialog/region with focus.                                                                       |   1–2d | —                       | Week 1   |
| UX-05 | **S2 · Reservation timezone and validation are ambiguous.** `datetime-local` is browser-local; the confirmation shows only `BOOKED #` (no time or zone), while the Reservations list formats IST; duration is unvalidated; availability is not refreshed. | `stations/[id]/page.js:7-10,35-36,51-59,159-166`; `ui.js:41-48`; `reservations/page.js:7-14`                               | A user outside IST books the wrong hour and cannot verify it from the confirmation; empty/invalid duration yields raw `Invalid time value`; duplicate 409.                      | Show local + IST in the confirmation; explicit zone or ISO input with preview; validate 15–120; refresh connectors after success; server round-trip check.                 |     2d | —                       | Week 1–2 |

### 2.4 P1 catalogue — next two sprints

| ID    | Finding                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                | Impact                                                                                                                                                 | Fix                                                                                                                                                                   | Effort | Depends on      | When     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | --------------- | -------- |
| UX-06 | **S2 · Map and chart accessibility.** The corridor SVG is `role="img"` but contains `role="button"` pins; line/heatmap have no table alternative; heatmap labels are hardcoded `#6B7681` at 9px (~3.96:1).                                                                                                            | `ui.js:348-418`; `ui.js:426-475` (labels at `:461,:466`); `ui.js:480-550`                               | Screen-reader users cannot reliably select stations; low-vision users cannot read the matrix. WCAG 1.1.1, 1.4.3, 4.1.2 risk.                           | SVG `aria-hidden`; accessible station list/buttons outside it; `<details>` data tables; use `--tx3` and ≥11px; test NVDA/VoiceOver.                                   |   2–3d | Design review   | Week 2   |
| UX-07 | **S2 · Live regions are unreliable.** Toasts mount their `aria-live` container only when items exist; auto-dismiss after 4.2s; no pause/dismiss. PageState loading has `aria-busy` but no live status.                                                                                                                | `ui.js:173-195,204-237`                                                                                 | First toast may not be announced; errors disappear before they are read; AT users do not know content is loading.                                      | Persistent root live region; `role="status"`/`alert`; errors persist until dismissed; pause on hover/focus; sr-only loading text.                                     |     1d | —               | Week 1   |
| UX-08 | **S2 · Drawer and skip link are incomplete.** Drawer is a nav, not a modal: no focus trap, scroll lock, outside click, or `aria-modal`; skip target lacks `tabIndex={-1}`.                                                                                                                                            | `nav.js:39-85`; `layout.js:55-57,67`                                                                    | Keyboard/screen-reader focus escapes behind the open drawer; skip link may move visual focus without moving keyboard focus.                            | Use `<dialog>` or a focus trap; return focus; lock scroll; close outside; `main tabIndex={-1}`.                                                                       |   1–2d | —               | Week 2   |
| UX-09 | **S2 · Session page announces too much and assures too little.** 404/403 polls forever every 5s; `aria-live` wraps a count-up that updates every RAF; "● receiving" is static during errors; operator controls show without a role gate or busy guard.                                                                | `session/[id]/page.js:42-49,116-141,282-302`                                                            | AT announcement spam; false "live" assurance; drivers see controls that return 403; endless requests.                                                  | Stop poll on 404/403 with back/retry; announce meaningful deltas at 15–30s; derive connection state from last tick; hide operator controls for drivers; busy/disable. |     2d | UX-01           | Week 2   |
| UX-10 | **S2 · Retry is a no-op on Analytics and Carbon; the KPI is mislabeled.** `setSel(x=>x)` bails out on both pages; "Utilization signal" displays active count, not utilization.                                                                                                                                        | `analytics/page.js:23-34,43,49`; `carbon/page.js:84`                                                    | Retry never recovers; capacity planning reads a number that means something else.                                                                      | Retry nonce/increment on both pages; compute occupied connector-hours / available connector-hours; label active count separately; sequence guard.                     |     1d | UX-02           | Week 1   |
| UX-11 | **S2 · Admin control surface is not operable.** `role="tablist"` contains plain buttons with `aria-pressed`, no tabs/tabpanels/arrow keys; tariff form hardcodes group 1, ₹24/kWh, ₹20 fee; operator creation has no password field and the API defaults to `Temp@1234`; audit time is browser-local; no busy states. | `admin/page.js:26-36,48-67,109-119,136-161,297`; `routes.js:1025`                                       | AT confusion; cannot model real tariffs; shared default password is insecure; audit timestamps are ambiguous.                                          | Proper tabs or segmented buttons; real tariff editor with bands/group; password setup link/one-time token; IST; busy/idempotency.                                     |   3–4d | Security review | Week 2–3 |
| UX-12 | **S3 · Notification semantics are wrong.** Unread/read are encoded as `BOOKED`/`EXPIRED` pills; no link to the related reservation/session/invoice; no mark-all; no unread badge; mark-read has no busy guard.                                                                                                        | `notifications/page.js:21-28,57-72`                                                                     | Users misread event type and cannot act on the notification.                                                                                           | Unread dot + `aria-label`; link related entity; mark-all; nav badge; optimistic update with rollback.                                                                 |     2d | —               | Week 3   |
| UX-13 | **S2 · Reservation start can use the wrong tariff or wrong window.** Active-tariff fetch failure silently omits `planId`; "plug in" starts immediately regardless of the booked window; no countdown/expiry; cancel has no busy guard.                                                                                | `reservations/page.js:26-33,45-55,56-73`                                                                | Wrong tariff or billing dispute; start outside the reservation; duplicate requests.                                                                    | Block start until tariff loaded; show plan; server enforce window; countdown; busy; idempotency.                                                                      |     2d | UX-03           | Week 2–3 |
| UX-14 | **S3 · History loses context and misstates order.** A load-more failure sets page-level `err`, replacing the loaded table; copy says "oldest ledger to newest" while the API sorts newest first; plain `<a>` forces a full reload.                                                                                    | `history/page.js:12-28,32,55`; `routes.js:644`                                                          | Users lose their place and misread chronology; navigation is slow.                                                                                     | Inline pagination error, keep rows; copy "newest first"; `Link`; cursor retry.                                                                                        | 0.5–1d | —               | Week 1   |
| UX-15 | **S3 · Discover masks the real error and polls blindly.** Every failure becomes "API unreachable — start it"; no sequence guard; 15s poll runs in hidden tabs; connector select does not trigger search; selection is not clamped when the filter removes it.                                                         | `discover/page.js:22-37,55-66`                                                                          | Wrong diagnosis; battery drain; filter appears broken; detail panel empties.                                                                           | Surface real error/code; abort/sequence; pause on `document.hidden`; debounce/filter on change; clamp selection.                                                      |     2d | UX-02           | Week 2   |
| UX-16 | **S2 · Profile and wallet mishandle failure and destructive actions.** `/me` failure redirects to login even on 500/network; add-vehicle error uses success styling; no edit/delete; unlink has no confirm; radio arrow keys change mode but not focus; demo key dies with the tab.                                   | `profile/page.js:11-18,19-29,61-103`; `wallet/page.js:93-108,258-300,486-489`; `wallet-client.js:19-45` | Users lose sessions on transient errors; cannot correct data; accidental unlink; keyboard focus lands on `tabIndex=-1`; cannot top up after tab close. | Differentiate 401 vs 5xx; error alert; edit/delete; ConfirmDialog; move focus in radio group; persist demo key with warning or require injected wallet; IST.          |     3d | UX-03           | Week 3   |
| UX-17 | **S3 · Login and session chrome erode trust.** Stale "66 paths" (landing says 72); `noValidate` disables native email validation; no forgot password/SSO/show password; `setToken` then full reload; SessionLinks renders logged-out before hydration.                                                                | `login/form.js:13,44-48,77`; `page.js:114`; `session-links.js:11-19`                                    | Conversion and trust loss; inaccessible errors; no recovery path; nav flicker.                                                                         | Generate copy from OpenAPI; inline validation; password reset/SSO; show password; client navigation; hydrate-safe session state.                                      |   2–3d | —               | Week 2–3 |

### 2.5 P2 catalogue — schedule within 90 days

| ID    | Finding                                                                                                                                                                  | Evidence                                                                  | Impact                                                                     | Fix                                                                                                  | Effort | Depends on    | When     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -----: | ------------- | -------- |
| UX-18 | **S3 · Unknown values render as zero.** `inr(null)` → `₹0`; `kwh(null)` → `0.00 kWh`; generic empty states.                                                              | `ui.js:39-40,173-195`                                                     | Users see zero instead of unknown and draw the wrong conclusion.           | Return `—` for null/undefined/NaN; explicit zero branch; typed formatters; page-specific empty copy. |     1d | UX-02         | Week 2   |
| UX-19 | **S3 · Mobile tables and touch targets.** Tables are min-width 640 with horizontal scroll and no sticky first column; buttons are 36px/30px; inputs are 14px (iOS zoom). | `globals.css:435-436,458-459,514-525,637-638`                             | Operators must pan; small targets; zoom jumps on focus.                    | Card rows below 640px; sticky first column; 44px targets; 16px inputs; test at 360px.                |     2d | —             | Week 3–4 |
| UX-20 | **S3 · Error boundaries leak internals and do not report.** Route/global boundaries print raw `error.message`; no correlation ID or telemetry.                           | `error.js:10`; `global-error.js:28`                                       | Internal details leak; production failures are invisible.                  | Generic copy + code/request ID; Sentry/OTel; log once; keep the reset path.                          |     1d | Observability | Week 3   |
| UX-21 | **S3 · Timezone inconsistency.** Wallet ledger, admin audit, and notifications use browser locale/timezone; charts and history use IST.                                  | `wallet/page.js:486-489`; `admin/page.js:297`; `notifications/page.js:69` | Operators in different zones read different timestamps for the same event. | One `fmtDateTime` with explicit `Asia/Kolkata` and a visible zone; store UTC.                        |   0.5d | —             | Week 2   |
| UX-22 | **S3 · Invoice detail is not a dialog and cannot be filed.** The itemized section has no focus management, dates, PDF/CSV, or GST fields.                                | `invoices/page.js:141-185`                                                | Keyboard users lose focus; finance cannot export or file.                  | Dialog/region with heading and focus; issued/paid dates; PDF/CSV; GSTIN/HSN if applicable.           |   1–2d | UX-04         | Week 3   |

### 2.6 Additional low-severity observations

- `Pill` is used to encode non-status data: telemetry renders `AVAILABLE`/`OFFLINE` for the data source (`telemetry/page.js:146`), and notifications use `BOOKED`/`EXPIRED` for read state (`notifications/page.js:66`). This teaches users that the pill is decorative, which weakens real status signals.
- `StaleChip` says "showing last good data" but does not say **whose** data or **how old** it is (`ui.js:82-88`). Add station and timestamp.
- The empty corridor map renders a schematic with no pins when `stations` is empty (`ui.js:480-550`); prefer the existing `EmptyState` and skip the map.
- `PageState` prints `String(error)` directly (`ui.js:181-190`). Map known codes to human copy and keep the technical detail behind a disclosure.
- The app is dark-only by design (`globals.css:7`). That is a legitimate brand choice, but it removes a user preference; if light mode is out of scope, say so in the accessibility statement.
- The "66 paths" copy also appears in `docs/startup/product-thesis.md:21`, so the inconsistency is not only a login-page typo.
- **CarbonPilot repeats the chart-label defect.** The carbon page feeds `g_per_kwh` through `Line`'s `avg_kw` slot; the SVG aria-label is hardcoded "Load curve" (`carbon/page.js:75,115`; `ui.js:377`), so a screen reader hears the wrong chart. The receipt table formats IST but the header says only "Interval end" (`carbon/page.js:203,212`). Add a `label` prop and a visible zone.
- **Carbon is not auth-gated.** A signed-out visitor gets a raw 401 in `PageState` with a dead retry instead of the login CTA (`carbon/page.js:27-54,84`; `ui.js:240-254`). The route is correctly `authRequired`; the page is the gap.

### 2.7 Accessibility specifics

| WCAG area                    | Evidence                                                      | Status                                                                                  | Fix                                                                              |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1.1.1 Non-text content       | `ui.js:348-418`, `:426-475`, `:480-550`                       | Charts/map have only a terse `aria-label`; no data table.                               | Add `<details>` tables and an accessible station list.                           |
| 1.3.1 Info and relationships | `admin/page.js:109-119`                                       | `tablist` without `tab`/`tabpanel`; `aria-pressed` on tabs.                             | Use real tabs or a plain segmented control with `aria-pressed` and no `tablist`. |
| 1.4.3 Contrast               | `ui.js:461,466`                                               | `#6B7681` on `#11151A` ≈ **3.96:1** at 9px; fails 4.5:1 for normal text.                | Use `var(--tx3)` (≈6.1:1) and ≥11px.                                             |
| 2.1.1 Keyboard               | `ui.js:504-517`; `nav.js:39-85`                               | Map pins are keyboard handlers inside `role="img"`; drawer has no focus trap.           | Move pins to real buttons outside the SVG; trap/return focus in drawer.          |
| 2.4.1 Bypass blocks          | `layout.js:55-57,67`                                          | Skip link target is not programmatically focusable.                                     | `tabIndex={-1}` on `<main>`, verify focus ring.                                  |
| 2.4.3 Focus order            | `wallet/page.js:258-300`                                      | Arrow keys change mode but do not move focus; focus stays on a now `tabIndex=-1` radio. | Move focus with selection; roving tabindex pattern complete.                     |
| 3.3.1 Error identification   | `profile/page.js:19-29`; `ui.js:181-190`                      | Add-vehicle error uses success styling; raw server strings elsewhere.                   | `role="alert"`, human message, field association.                                |
| 3.3.2 Labels/instructions    | `stations/[id]/page.js:146-166`                               | Timezone and duration constraints are not stated.                                       | Label zone, show min/max, inline validation.                                     |
| 4.1.2 Name/role/value        | `ui.js:492-517`; `admin/page.js:115`; `telemetry/page.js:146` | Interactive descendants of `role="img"`; tablist misuse; status pills encode source.    | Correct roles and names; remove `role="img"` from interactive containers.        |
| 4.1.3 Status messages        | `ui.js:204-237`; `ui.js:173-195`                              | Live region mounts with content; loading has no status text.                            | Persistent live root; sr-only loading/status.                                    |
| 2.2.1 Timing                 | `ui.js:209`                                                   | Error toasts auto-dismiss in 4.2s with no pause.                                        | Persistent errors; pause on hover/focus; manual dismiss.                         |

**Accessibility acceptance criteria for the 90-day gate:**

- Keyboard-only completion of Discover → Reserve → Session → Invoice → Wallet.
- NVDA/VoiceOver can select a station from the map alternative and hear the current state.
- Zero critical/serious axe violations on the five core routes.
- All data charts have a table alternative.
- All timestamps show a zone; all money/energy values have units.
- No status message disappears before 8 seconds without a pause mechanism.

---

## 3. Product strategy

### 3.1 The strategic question

The repo already has a differentiated thesis: **a CSMS whose plans are the plans your chargers can execute, with an audit trail.** The product thesis reports simulation evidence for that claim: certificate shortfall 42.6% → 2.36%, deadline miss 56.6% → 15.7%, and a 1,280 kWh plan-honesty gap closed to 0.011 kWh (`docs/startup/product-thesis.md:26-29`). That is a stronger story than "another charging dashboard."

The strategic question is therefore not "which features are missing?" It is:

> **Which additions make the trust thesis legible to a buyer, and which make it monetizable without diluting it?**

The current roadmap in `docs/STRATEGY-AND-ROADMAP.md:48-70` lists many of the right vectors, but it ranks them by category rather than by proof-to-revenue sequence. The ranking below is by **differentiation and defensibility**, with a separate urgency note.

### 3.2 Ranked differentiation opportunities

| Rank | Opportunity                                             | Type                          | Defensibility | Feasibility | Effort | 90-day role |
| ---: | ------------------------------------------------------- | ----------------------------- | ------------- | ----------- | -----: | ----------- |
|    1 | **Provable correctness & settlement receipts**          | Trust differentiator          | High          | High        |   2–3w | Now         |
|    2 | **Carbon-aware charging with provenance and M&V**       | Product differentiator        | Medium–High   | Medium–High |   6–8w | Next        |
|    3 | **Developer platform: signed webhooks + SDK + sandbox** | Ecosystem                     | Medium        | High        |   4–6w | Next        |
|    4 | **Tariff replay & settlement sandbox**                  | Sales/audit tool              | Medium        | High        |   2–3w | Next        |
|    5 | **OCPP 2.0.1 + ISO 15118 Plug & Charge**                | Enterprise/grid               | Medium–High   | Medium–Low  | 10–14w | Later       |
|    6 | **OCPI 2.2 roaming (CPO + EMSP)**                       | Revenue unlock / table stakes | Low–Medium    | Medium      |   6–8w | Later       |
|    7 | **Offline-first PWA + guest QR checkout**               | Acquisition/reliability       | Low–Medium    | High        |   4–6w | Later       |
|    8 | **Multi-tenant isolation + SSO/SCIM**                   | Enterprise gate               | Medium        | Medium      |  8–12w | Later       |
|    9 | **Payments orchestration & reconciliation**             | Table stakes                  | Low           | Medium      |   4–6w | Now         |

**Why this order.** Ranks 1 and 9 are "now" because they protect the trust thesis and the money path. Ranks 2–4 are the best ratio of differentiation to effort: carbon gives the product a reason to exist beyond uptime, webhooks create switching costs, and replay turns the tariff engine into a sales demo. Ranks 5–8 are real, but they are multi-quarter commitments that should follow proof, not precede it.

### 3.3 Opportunity notes and measurable targets

#### 1. Provable correctness and settlement receipts — now

The repo already has the ingredients: race tests, SQL invariants, OpenAPI drift, an outbox, and an append-only ledger. Turn them into a **public, signed receipt**:

- A build receipt: commit, migration hash, OpenAPI hash, test transcript, timestamp, signature.
- A per-invoice settlement statement: meter values → tariff version → invoice lines → ledger entry → payment reference.
- A public `/receipts` page that renders the latest passing run and links to the raw JSON.

**Targets:** 100% of invoices have a verifiable settlement statement; the race suite is public and reproducible; p95 receipt lookup <200 ms; zero unexplained ledger deltas for 30 consecutive days.

**Why it is defensible:** a competitor can copy a dashboard, but not the database invariants and the test transcript without re-architecting. This is the trust brand made tangible.

#### 2. Carbon-aware charging with provenance and M&V — next

The repo already ships a deterministic CarbonPilot model-v1: an operator page, read-only carbon routes, per-session receipts, advisory labels, carbon-aware control-plan solving, and tests (`apps/web/src/app/carbon/page.js`, `apps/api/src/carbon-routes.js`, `apps/api/src/carbon/intensity.js`, `apps/api/src/control/controller.js:267-342`). The gap is not another carbon UI or another scheduler; it is **live data, provenance, immutable receipt persistence, and M&V**. Keep model-v1 as a fallback and add:

- Ingest grid carbon intensity (actual and forecast) with source, region, timestamp, method version, and confidence.
- Schedule against price + carbon + deadline + site cap through the existing `POST /control/plan`; emit an OCPP charging profile.
- Persist planned vs delivered energy and the per-session carbon receipt (today it is computed on read).
- Run a baseline comparison (price-only vs price+carbon) over a 30-day replay.

**Targets:** 15% median gCO2/kWh reduction vs price-only over a 30-day replay; cost increase ≤5%; 100% of schedules carry carbon provenance; M&V within ±10%; zero greenwashing claims without a receipt.

**Why it is a wedge:** India's grid is carbon-intensive and increasingly time-varying; European fleets face CSRD/RE100 reporting. A verified carbon receipt is more valuable than another utilization chart. The current model is a deterministic function of region and time, not a live grid signal; that is honestly labelled “model-v1” and “not a meter,” but it cannot support a customer claim until a provider, provenance, and M&V are attached.

#### 3. Developer platform: signed webhooks + SDK + sandbox — next

The outbox and 72-path OpenAPI surface are an underused asset. Add:

- Tenant-scoped API keys with scopes and rotation.
- Signed webhooks (HMAC, timestamp, idempotency key) for reservation, session, invoice, wallet, and fault events.
- Retries with exponential backoff, dead-letter, replay, and delivery receipts.
- A sandbox tenant and generated TypeScript/Python SDKs.

**Targets:** 3 design partners; p95 delivery <60s; 99.9% delivery success; 0 signature failures; 10 production keys; a partner can go from key to first event in <30 minutes.

**Why it works:** webhooks create integration depth and switching costs without a new UI. It also forces the event contract to be clean, which improves the audit story.

#### 4. Tariff replay and settlement sandbox — next

A read-only replay of 30 days of sessions and meter values under a proposed tariff, with an invoice diff. This is the fastest way to sell a tariff change to a CPO and the fastest way to catch billing regressions.

**Targets:** 30-day replay <60s; invoice diff = 0 when replaying the production tariff; five sales demos; one pricing change validated before production.

**Why it is differentiated:** most CSMS demos show a dashboard. Showing a CFO the exact bill under a new tariff, with a diff and an audit trail, is a buying moment.

#### 5. OCPP 2.0.1 + ISO 15118 Plug & Charge — later

This is a real enterprise/grid capability, but it is not a weekend spike. Build a **conformance harness first**: boot/security events, device model, profiles, certificate lifecycle, transaction events, and PnC (EIM/autocharge first, then ISO 15118-2/20).

**Targets:** 3 charger models pass the harness; 95% PnC success on the lab fleet; 100% profile conformance; zero safety violations in a 30-day pilot.

**Risks:** firmware variance, certificate operations, and the temptation to claim "2.0.1 ready" before a charger model passes. Do not put it on the pricing page until the harness is green.

#### 6. OCPI 2.2 roaming (CPO + EMSP) — later

OCPI is table stakes for B2B deals, not a moat. Implement tokens, locations, sessions, CDRs, and signed CDR exchange; add a reconciliation and dispute workflow.

**Targets:** one CPO and one EMSP in sandbox; 100% CDR match; <2% disputes; 99.5% handshake success; one paid roaming session end-to-end.

**Risks:** version fragmentation, settlement/FX, PII/GDPR, and availability. Use the correctness receipts as the trust differentiator in roaming negotiations.

#### 7. Offline-first PWA + guest QR checkout — later

A thin PWA is enough: installable shell, cached station data, a queue for non-money actions, and a QR deep link that lets a guest start a session without an app. Money mutations stay online and idempotent.

**Targets:** <3 minutes from QR scan to charging; 95% of queued offline actions sync; <1% duplicate sessions; no offline wallet mutation.

**Why not a native app first:** the acquisition friction is the problem, not the app-store presence. A PWA plus QR solves the same job at a fraction of the cost.

#### 8. Multi-tenant isolation + SSO/SCIM — later

Separate the two problems:

- **SSO (SAML/OIDC) + SCIM** can ship in 2–3 weeks on the existing user model and unlocks single-tenant enterprise buyers.
- **Tenant isolation** is the 8–12 week part: `tenant_id` on every row, row-level security, per-tenant configuration, and cross-tenant tests.

**Targets:** 2 tenants with 0 cross-tenant reads in a pen test; SAML and OIDC login; SCIM provisioning; 99.9% login success; one enterprise design partner.

#### 9. Payments orchestration and reconciliation — now, table stakes

The wallet ceremony is a good demo, but real money needs a PSP: Razorpay/UPI for India and Stripe for global cards. Keep card data out of scope with PSP-hosted fields; treat webhooks as the source of truth; reconcile every capture, refund, and chargeback to the ledger.

**Targets:** 98% auto-reconciled; <0.1% unmatched; T+1 settlement visibility; refunds within T+2; zero card data stored; GST-compliant invoice fields.

### 3.4 Better ideas than the usual roadmap

These are higher-leverage than a native mobile app, white-label theming, or a generic chatbot:

- **Correctness receipts as a public artifact.** Makes the trust thesis buyable.
- **Tariff replay/settlement sandbox.** Turns pricing into a demonstrable, low-risk decision.
- **Carbon passport per session.** A verified gCO2/kWh receipt with source and method; useful for ESG reporting and driver trust.
- **Conformance harness as a product.** Certify charger models and integrators; this becomes a moat around OCPP 2.0.1.
- **Grid flexibility / M&V.** Measure load shifting and capacity relief; utilities and aggregators pay for verified outcomes.
- **Guest QR checkout.** Removes the app-install step at the moment of need.

### 3.5 What not to build now

- **Native iOS/Android app.** The PWA + QR path solves acquisition at lower cost; revisit after product-market fit.
- **V2G/V2H dispatch.** The metering and settlement model is not ready; it would add sign-convention risk to the ledger.
- **White-label theming.** A reseller channel without a second design partner is premature.
- **Blockchain or tokenized carbon.** The audit trail is the product; a chain adds complexity without a buyer.
- **Autonomous control.** The current advisory-only boundary is a feature. Keep a human in the loop until the evaluation and safety case are much stronger.
- **Generic AI chatbot.** It would dilute the "provable operations" positioning and has no data moat.

### 3.6 North-star metrics

| Area     | Metric                                         | 90-day target                           |
| -------- | ---------------------------------------------- | --------------------------------------- |
| Trust    | Core-flow silent failures                      | 0                                       |
| Trust    | Reservation/payment race correctness           | 100% of seeded races resolved by DB     |
| UX       | Time to first charging session                 | <3 minutes                              |
| UX       | Core-flow task success (moderated)             | ≥95%                                    |
| A11y     | Critical/serious axe violations on core routes | 0                                       |
| AI       | MAE skill vs zero on nonzero hours             | ≥20%                                    |
| AI       | Interval coverage per station-scale slice      | 80% ±2 pts                              |
| AI       | Reproducibility from receipt                   | 100% (dataset + code + artifact hashes) |
| Payments | Auto-reconciled transactions                   | ≥98%                                    |
| Webhooks | p95 delivery latency                           | <60 seconds                             |
| Roaming  | CDR match rate                                 | 100%                                    |
| Carbon   | gCO2/kWh reduction vs price-only (pilot)       | ≥15%                                    |

---

## 4. AI & data science review

### 4.1 Verdict

The AI sidecar is **honestly engineered but not yet empirically trustworthy**. The good parts are real: advisory-only, internal auth, artifact checksums, feature-version checks, graceful fallback, deterministic LP for optimization, and a conformal attempt. The evaluation, however, is not strong enough to support the headline claims. The current receipts should be treated as **a promising baseline**, not a production accuracy statement.

### 4.2 What the system claims

`apps/ai/reports/metrics.json` (regenerated **2026-10-25T05:02Z**) reports:

- 87 series across Korea, Norway, and Tennessee; **239,960 panel rows**; 4 rolling-origin folds, 270 test hours per fold.
- **31,109 test origins × 24 leads = 746,616 scored targets.**
- MLP MAE **1.9060 kWh**, RMSE **6.9986**, relative MAE vs seasonal-naive **0.6398**, skill vs seasonal-naive **36.02%**, skill vs weekly mean **33.64%**.
- Per-source MAE: Norway **3.5996**, Tennessee **2.3797**, Korea **1.1396**.
- 80% intervals: empirical coverage **80.29%**, mean width **5.159 kWh**, 662,952 calibration points.
- Training: **642.61 seconds on CPU**.

The earlier **prior 47-station receipt** survives in `apps/ai/reports/train-real.log`: 402,934 rows, stride 2 to 201,467, 25,113 origins × 24 = 602,712 targets, MLP MAE 2.5332, RMSE 9.2071, relative MAE 0.6189, skill 38.11%, coverage 79.52%, width 2.367 kWh, 3,426s CPU. It is useful as a before/after check, not as the current claim.

### 4.3 Independent reconstruction

I rebuilt the current 87-station panel from `data/hourly/panel.npz` with `ingest.py`/`contract.py`, applied the same `--max-rows 240000` stride (**step 3: 719,880 contract rows → 239,960**) and the same `fold_masks` protocol (4 folds, 45 backtest days, 10 calibration days, 1 purge day, 24h horizon). The reconstruction produced **31,109 origins × 24 = 746,616 targets**, matching the receipt. Scoring a **zero forecast** (predict 0 for every target) on the same matrix gives:

| Slice     | MLP MAE (receipt) | Zero-forecast MAE | Seasonal-naive MAE | Weekly-mean MAE | Test zero share |
| --------- | ----------------: | ----------------: | -----------------: | --------------: | --------------: |
| Pooled    |        **1.9060** |        **2.0524** |             2.9790 |          2.8721 |          82.78% |
| Tennessee |        **2.3797** |        **2.2486** |             4.0363 |               — |          91.99% |
| Norway    |        **3.5996** |        **6.3113** |             4.4015 |               — |          50.22% |
| Korea     |        **1.1396** |        **1.1111** |             1.6823 |               — |          79.37% |

Additional reconstruction facts:

- The pooled MLP beats zero by **7.1%** (2.0524 vs 1.9060), but **zero wins on Tennessee** (2.2486 vs 2.3797) and **Korea** (1.1111 vs 1.1396). Those two sources contain **80 of the 87 series**.
- Norway has only **7 series** and **8.1% of test points**; the MLP is **43% better** there (3.5996 vs 6.3113), and that one source carries the pooled result.
- Test targets: mean **2.0524 kWh**, median **0**, p90 **6.2733**, p99 **44.4671**, p99.9 **73.747**, max **147.3837**; **82.78%** are zero.
- The prior 47-station receipt had a larger pooled advantage over zero (**11.5%**: 2.5332 vs 2.8611) but lost at **31 of 47 stations** and on Tennessee. The new data mix has not made the model robust; it has changed which source carries it.
- This is a **source-level** result, not a station-level count: per-station MLP errors are not published. The 80/87 figure is the number of series in the two sources where zero wins.

**How to read this.** A zero forecast is not a deployable product. It is a diagnostic baseline: if a constant beats the model on two of three sources, the pooled MAE is not a reliable measure of useful forecasting. The 36% skill vs seasonal-naive is real, but it says the MLP beats a weak baseline, not a trivial one. The pooled average is dominated by the 8% of points where Norway's load is large. Judge the model on **nonzero-hour skill, peak timing, quantile loss, and capacity exceedance**, not only pooled MAE.

### 4.4 Methodology and leakage findings

| ID    | Finding                                                                                                                                                                                                                                                            | Evidence                                                                     | Why it matters                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI-01 | **Early stopping and conformal calibration share one block.** `val=(X[ca], Y[ca])` selects the model, then residuals from the same block calibrate the intervals.                                                                                                  | `train.py:370-388`                                                           | Selection bias shrinks the calibration residuals; the split-conformal guarantee is void. The observed 80.29% coverage may be luck. Use a third block or nested CV. |
| AI-02 | **The 746,616 test targets are 24× overlapping.** 31,109 origins × 24 leads; adjacent origins share 23 of 24 targets.                                                                                                                                              | `metrics.json:20-27`; `train.py:110-134`                                     | Effective sample size is ~31k, not 746k. Confidence intervals and coverage estimates are too narrow, and pooled MAE over-weights long events.                      |
| AI-03 | **The deployed artifact is not the evaluated model.** Final fit uses all rows, including test periods, with no validation; the scaler is fit on all rows.                                                                                                          | `train.py:453-460`                                                           | The receipt describes fold models, not the `model.pt` customers receive. Add a final holdout and a shadow evaluation.                                              |
| AI-04 | **Stride sampling is undisclosed.** 719,880 contract rows are reduced by `step=3` to 239,960; the receipt records panel rows but no `step` or `sampled` field.                                                                                                     | `train.py:341-346`; `metrics.json:14-19`                                     | The test set and baselines are not reproducible from the receipt alone; sampling can change fold composition.                                                      |
| AI-05 | **Folds are per-series recency, not aligned calendar time.** Each station's test window is relative to its own last observation.                                                                                                                                   | `train.py:110-134`                                                           | The pooled test is a mosaic of 2018–21 Norway, 2021–23 Korea, and 2024–25 Tennessee; "future" performance is not a coherent temporal holdout.                      |
| AI-06 | **Three provenance generations coexist, and the receipt has no dataset hash.** Current `metrics.json`/`dataset.json` agree on 87 series / 3 sources; `train-real.log` is a 47-station run; older claims survive in docs.                                           | `metrics.json:1-27`; `dataset.json:926-943`; `train-real.log:1-3`            | A reader cannot tie the metric to an immutable snapshot, and the 47-station log looks current. Bind `dataset_sha256` and the snapshot ID into every receipt.       |
| AI-07 | **Calendar features use UTC, not station-local time.** All sources are normalised to UTC, then `calendar_features` uses the UTC hour/day; Norway's naive timestamps are attached as UTC.                                                                           | `contract.py:93-104,123`; `ingest.py:220,271-272`                            | Norway is off by 1–2 hours and Korea's KST evening peak appears at 09:00–13:00 UTC. A pooled model cannot learn local behaviour cleanly; no holidays.              |
| AI-08 | **Conformal intervals add signed per-horizon residuals pooled across all stations.** Mean width is 5.159 kWh.                                                                                                                                                      | `contract.py:243-297`; `metrics.json:146-156`                                | A pooled per-horizon band is too wide for small stations and too narrow for large ones; 80.29% marginal coverage hides conditional undercoverage.                  |
| AI-09 | **"MASE" is relative MAE.** It divides test MAE by the test seasonal-naive MAE, not the standard in-sample scaling.                                                                                                                                                | `contract.py:320-326`; `metrics.json:122`                                    | The label overstates comparability with standard MASE; call it `relative_mae_vs_naive168`.                                                                         |
| AI-10 | **Label construction can invent temporal shape.** Tennessee and Korea session energy is spread across overlap hours; the Norway file is named `Dataset4_hourly_predictions.csv`, its local timestamps are attached as UTC, and gaps are asserted to be true zeros. | `ingest.py:103-118,133-185,193-237`                                          | The model may learn the aggregation artifact rather than measured load. Raw SHA-256 exists, but column-level provenance and a timezone declaration do not.         |
| AI-11 | **Metrics omit the decisions the product needs.** No peak timing, capacity exceedance, quantile/pinball point score, cost-weighted error, or per-hour skill. Per-horizon MAE goes 1.6746 → 1.9332 (+15.4%), but h3–h24 is flat at 1.88–1.95.                       | `metrics.json:111-114`; `train.py:443`                                       | A flat horizon curve suggests a level/climatology forecast, not a diurnal shape. MAE alone cannot tell an operator whether to shift load.                          |
| AI-12 | **Cold start is not evaluated.** Stations are pooled, but there is no leave-one-station-out test.                                                                                                                                                                  | `train.py:365-416`                                                           | A new station's first weeks are the actual commercial case; pooled random-station metrics do not prove it.                                                         |
| AI-13 | **Anomaly detection is uncalibrated.** Median/MAD per session with a method string, but no method version, labeled precision/recall, or per-connector thresholds; `checked` still counts skipped sessions.                                                         | `service.py:773-845`                                                         | Thresholds are plausible but unproven; false positives erode operator trust.                                                                                       |
| AI-14 | **Optimizer repeats the last price/carbon value for short arrays** and uses hard energy equality. It validates duplicates, deadlines, site cap, and per-vehicle max kW, but has no ramp, phase, connector assignment, or shortfall slack.                          | `service.py:871-964` (extend at `:888-893`)                                  | A short TOU/carbon array misprices later hours; infeasible demand returns no partial/shortfall plan.                                                               |
| AI-15 | **Stale AI claims survive in two docs.** `docs/verification.md` says MAE 56.4, 3.5s on an A100, 15× GPU, ~525× inference; `docs/perf.md` repeats 15×/~525×; current receipts say 1.906, 642.61s CPU, 12.84×, 412.5×. `docs/ai-platform.md` is now current.         | `docs/verification.md:367-370`; `docs/perf.md:47-49`; `benchmarks.json:5-16` | In an audit-led product, stale numbers are a trust defect, not a docs chore.                                                                                       |

### 4.5 Metrics critique

- **Pooled MAE is the wrong headline.** It mixes a 91.99%-zero Tennessee with a 50.22%-zero Norway and a 79.37%-zero Korea; the pooled zero share is 82.78%. Report per-station, per-source, per-zero-state, and per-horizon metrics.
- **The baseline set still omits the strongest trivial baseline.** Zero-forecast MAE is **2.0524 pooled**, 2.2486 Tennessee, 1.1111 Korea, and 6.3113 Norway. It beats the MLP on Tennessee and Korea (**80 of 87 series**), and the MLP's 7.1% pooled advantage depends on **7 Norwegian series**. Seasonal-naive is worse than the weekly mean; ridge is worse than both (3.2679). Add zero, persistence, and a GBDT baseline to the receipt.
- **The "skill" number is fragile.** 36.02% vs seasonal-naive and 33.64% vs weekly mean are pooled; zero wins on two of three sources. A model that adds value only in Norway is a source-specific model, not a general forecaster.
- **The horizon curve is flat after h3.** h1 is 1.6746 and h24 is 1.9332 (**+15.4%**), but h3–h24 stays in a narrow 1.88–1.95 band. That is not a normal degradation curve for load; check hour-of-day skill and peak timing, not just MAE.
- **The tail is heavy.** RMSE **6.9986** vs MAE **1.9060**; p99 **44.4671**, p99.9 **73.747**, max **147.3837**. The business cares about the tail (capacity, demand charges), so report p95/p99 error and exceedance rates.
- **Coverage is marginal, not conditional.** 80.29% overall looks good; fold 3 is **76.37%**, and the mean width is **5.159 kWh** across stations whose means differ by orders of magnitude. Per-station and per-scale coverage is unknown.
- **The interval names are hardcoded.** The API always returns `p10`/`p90` even if `interval_level` changes (`service.py:319-346`). Use `lower`/`upper` + `level`, or enforce 0.8 at load.

### 4.6 Model, feature, and dataset improvements

| Change                                                                                         | Why                                                                | Expected effect (target; validate in backtest)                                                            | Effort | Priority |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -----: | -------- |
| **Three-way split: train / early-stop / calibration**                                          | Restore conformal validity; remove selection bias.                 | Coverage 80% ±2 on every fold and station-scale slice; no optimistic width.                               |   1–2d | P0       |
| **Add zero, weekly-mean, persistence, ridge, and LightGBM baselines**                          | Establish honest skill; catch station-level failure.               | Never worse than zero on any source; target ≥20% MAE improvement over the best baseline on nonzero hours. |   3–5d | P0       |
| **Per-source and per-station promotion gate**                                                  | A pooled average hides two-source failure.                         | No source worse than zero; no station worse than zero by >10%; publish the table.                         |   2–3d | P0       |
| **Scale intervals by station scale (normalized residuals or quantile model)**                  | Constant absolute width is wrong for heterogeneous stations.       | Conditional coverage 80% ±5 across small/medium/large stations; width proportional to load.               |   3–5d | P0       |
| **Align evaluation by calendar time and add a prospective holdout**                            | Per-series recency creates a mosaic, not a future.                 | A realistic 30-day out-of-time test; report degradation vs backtest.                                      |   2–3d | P0       |
| **Station-local timezone, holidays, weather, and station attributes**                          | Diurnal/weekday/seasonal drivers are currently UTC and incomplete. | 5–15% MAE reduction on peak hours; better peak timing (hypothesis).                                       |   1–2w | P1       |
| **Global model with station embeddings + GBDT ensemble**                                       | Capture cross-station structure while allowing local shape.        | 5–15% MAE reduction and 20–30% peak-timing improvement vs current MLP (hypothesis).                       |   2–4w | P1       |
| **Probabilistic forecast (quantile regression / NGBoost / conformalized quantile regression)** | Point forecasts cannot support capacity decisions.                 | Lower pinball loss; calibrated 80/90% intervals; useful p90 for capacity.                                 |   2–3w | P1       |
| **Leave-one-station-out and cold-start evaluation**                                            | New stations are the commercial case.                              | Quantify first-30-day error; hierarchical priors or a similarity model.                                   |   1–2w | P2       |
| **Dataset manifest: license, URL, SHA256, row counts, timezone, aggregation version**          | Provenance is currently narrative, not verifiable.                 | 100% reproducible receipts; every metric tied to a dataset hash; no orphan 47-station log.                |   3–5d | P0       |
| **Data quality gates: gaps, duplicates, negative energy, session outliers, zero share**        | Prevent label-construction artifacts from becoming "signal."       | Fewer silent data regressions; explicit quality flags in the receipt.                                     |     1w | P1       |
| **Peak/tail metrics: peak timing, p90/p99 error, capacity exceedance, cost-weighted MAE**      | Match the operator's decision.                                     | Metrics that correlate with demand charges and SLA risk.                                                  |   3–5d | P0       |

**Expected-effect caveat:** the percentage ranges are engineering targets, not guarantees. They must be accepted or rejected by the repaired backtest, not asserted in marketing.

**Remediation sequence (AI):**

- **Week 1 — stop the leak (P0, blocks every accuracy claim):** AI-01 three-way split, AI-02 origin-level clustering, AI-03 final holdout, AI-04 record the stride, AI-06 dataset hash, AI-08 station-scaled intervals.
- **Week 2 — make the baseline honest (P0, blocks promotion):** zero/ridge/GBDT baselines per source, the per-source gate, AI-11 peak/tail metrics, AI-09 rename.
- **Weeks 3–6 — fix the inputs (P1, depends on the Week 1 snapshot):** AI-05 calendar alignment, AI-07 local time/holidays, AI-10 data-quality gates, AI-12 leave-one-station-out.
- **Weeks 5–8 — calibrate the operational surfaces (P1):** AI-13 anomaly labels and per-connector thresholds; AI-14 ramp/phase/connector/slack constraints, which depend on connector and carbon data.
- **Continuous:** AI-15 docs generated from receipts; CI fails when a doc number diverges from `metrics.json`.

### 4.7 MLOps, drift, and monitoring design

**Pipeline**

```
licensed source → ingest manifest (license, SHA256, row counts, timezone, version)
→ immutable snapshot (object store / DVC)
→ data-quality gates
→ feature build (offline = online contract)
→ rolling-origin backtest + slice metrics
→ evaluation gates
→ model registry (code SHA, dataset SHA, artifact SHA, metrics)
→ shadow/canary
→ production monitoring
→ retrain (scheduled or drift-triggered)
```

**Data quality gates**

- Expected row counts and station coverage per source.
- Timestamp monotonicity, duplicates, gaps, timezone presence.
- Negative/NaN/infinite energy rejection.
- Session-duration outliers (>24h) rejected or flagged.
- Zero-share and total-kWh bounds per source; alert on a >5-point shift.
- Source checksum matches the manifest.

**Model and serving monitoring**

| Signal                           | Why                                   | Alert threshold (initial)                         |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- |
| MAE / pinball by station and day | Detect accuracy drift                 | >1.25× the 28-day baseline for 3 consecutive days |
| Bias (mean error)                | Detect systematic under/over-forecast | absolute bias >10% of mean load for 3 days        |
| Interval coverage                | Detect calibration drift              | <75% or >85% over 7 days                          |
| Peak timing error                | Detect shape degradation              | p90 >2 hours for 7 days                           |
| Zero-rate and nonzero-hour error | Detect regime change                  | >5-point shift vs training                        |
| Feature drift (PSI/KS)           | Early warning before error            | PSI >0.2 on top features                          |
| Fallback rate                    | Detect artifact/feature failures      | >5% of requests                                   |
| Data freshness                   | Detect stale inputs                   | anchor older than 2 hours                         |
| p95 latency / 5xx                | Detect serving issues                 | >500ms / >0.1%                                    |

**Registry and promotion**

- Every artifact stores: code commit, dataset hash, feature version, training config, seed, metrics, slice metrics, calibration table, and a model card.
- Promotion gates: beats the best baseline on nonzero hours; coverage 80% ±2 per slice; no station worse than zero by more than 10%; prospective shadow period ≥2 weeks.
- Rollback is a one-command switch to the previous artifact; fallback remains seasonal-naive.

**Governance**

- Model card: intended use (advisory planning), non-goals (real-time control, safety), known limitations (sparse stations, new stations, holidays).
- Human override and audit for any schedule that uses a forecast.
- No PII in features; document retention for meter/session data.
- Monthly review of drift, incidents, and override rate.

### 4.8 API contract and guardrails

| Area                  | Current                                                                                                                           | Required change                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Version identity      | `model` name per station; `feature_version` at the response root; no dataset/artifact ID                                          | Add `model_version`, `dataset_version`, `artifact_sha256`, `request_id`; return them in every response and log them.                                                                       |
| Intervals             | `p10`/`p90` hardcoded even if `interval_level` changes                                                                            | Return `lower`/`upper` + `level`, or enforce 0.8 and reject other levels at load.                                                                                                          |
| Forecast input        | Accepts timestamps or values; fallback reasons are good                                                                           | Require tz-aware, monotonic timestamps; reject duplicates/gaps over a threshold; return `history_quality` and `anchor_used`.                                                               |
| Forecast output       | 24h fixed, `hours` truncates; good                                                                                                | Add `expires_at`, `fallback_reason` code, `model_version`; keep `advisory: true`.                                                                                                          |
| Optimizer arrays      | `price_per_kwh` min length 1; carbon optional; short arrays repeat last value                                                     | Require `len == window_hours` (or an explicit `broadcast` flag); reject NaN/negative; validate carbon units and source.                                                                    |
| Optimizer constraints | Hard energy equality; per-hour site cap; per-vehicle max kW                                                                       | Add ramp rate, three-phase/site transformer, connector assignment, and a slack variable with a shortfall penalty; return binding constraints and a minimum-shortfall plan when infeasible. |
| Carbon objective      | Optimizer takes `carbon_g_per_kwh` + scalar `carbon_weight` with no source/version; the CarbonPilot receipt is a separate surface | Add `carbon_source`, `carbon_forecast_version`, `carbon_confidence`; separate cost and carbon objectives in the response and link the schedule to a receipt.                               |
| Anomalies             | Median/MAD, threshold, reasons, a `method` string; no calibration                                                                 | Add `method_version`, labeled precision/recall, `evaluated` vs `skipped` counts; calibrate thresholds per connector type.                                                                  |
| Auth/network          | Shared internal token, production guard, constant-time compare                                                                    | Keep; add rotation, mTLS/network policy, per-caller rate limits, request size limits.                                                                                                      |
| Observability         | Basic FastAPI logs                                                                                                                | Add OpenTelemetry traces, RED metrics, structured logs with request ID, and per-station forecast error metrics.                                                                            |
| Fallback              | Honest seasonal-naive + reason                                                                                                    | Keep; add a fallback counter and an alert when the model is unavailable.                                                                                                                   |

### 4.9 AI release gate

Do not promote a model or publish accuracy claims until all of the following are true:

- [ ] Every receipt carries the same dataset hash and snapshot ID; the orphan 47-station log is archived, not presented as current.
- [ ] Three-way split; no early stopping on calibration residuals.
- [ ] Zero, weekly-mean, persistence, ridge, and GBDT baselines reported per source and per station; no source is worse than zero.
- [ ] 31,109 origins (not 746,616 "points") disclosed; confidence intervals clustered by origin/station.
- [ ] Coverage reported per station-scale slice and per zero/nonzero state; mean width reported against station scale.
- [ ] Peak timing, p90/p99 error, and capacity exceedance reported.
- [ ] Prospective shadow period ≥2 weeks; the deployed artifact is the one evaluated.
- [ ] Docs regenerated from receipts; no stale 56.4/3.5s/15×/~525× claims in `verification.md` or `perf.md`.

---

## 5. Advanced features

The following are the 8 features worth building. They are grouped by theme rather than ranked; §3.2 is the priority order. Each includes an architecture sketch, data-model impact, API surface, effort, risks, and differentiation.

### A1. Carbon-aware charging with provenance and M&V

**What:** Extend the existing CarbonPilot surface from a deterministic model-v1 into a live, auditable carbon-aware charging product: schedule against price, grid intensity, deadline, and site cap; issue a per-session carbon receipt; verify the outcome against a baseline.

**Current state:** `apps/web/src/app/carbon/page.js`, `apps/api/src/carbon-routes.js`, and `apps/api/src/carbon/intensity.js` already ship model-v1: region mapping, a 48h forecast, per-session receipts, station/site summaries, advisory/source labels, RBAC, and tests. The control plan already solves price + carbon + deadline + site cap, emits a counterfactual, and compiles OCPP profiles (`apps/api/src/control/controller.js:267-342,369`). It is deterministic and explicitly labelled "not a meter." The missing pieces are **live data, forecast skill, immutable receipt persistence, and M&V** — not another dashboard or scheduler.

**Architecture sketch:**

- Keep model-v1 as a labelled fallback. Add a carbon-provider adapter behind `forecast()`; ingest actual and forecast intensity every 15 minutes into Timescale with source, method version, confidence, and quality flags. Never overwrite the inputs behind a historical receipt.
- Add a carbon forecast service for 24h p50/p90 intensity; feed it to the existing control-plan solver, which already handles price + carbon + deadline + site cap.
- Harden the existing OCPP profile path; the meter pipeline records delivered kWh; persist a durable plan→session link and the receipt at close (plan decisions are stored, but the receipt is computed on read).
- An M&V job replays the same sessions under a price-only baseline and reports gCO2/kWh, cost delta, and peak impact.

**Data model impact:** new `carbon_intensity_snapshot`, `carbon_forecast`, and `carbon_plan` tables; extend `carbon_receipt` with provider/snapshot IDs, confidence, and planned-vs-delivered energy. Money-path tables unchanged; carbon is an attribute of the session, not a second ledger.

**API surface:** the existing `GET /carbon/regions`, `/carbon/forecast`, `/stations/{id}/carbon`, `/carbon/receipt/{sessionId}`, and `/carbon/summary`; add `GET /carbon/providers`, `POST /carbon/reconcile`, a persisted receipt lookup, and `GET /carbon/mv?window=`.

**Effort:** 6–8 weeks on the existing surface; 10–12 for production with M&V.

**Risks:** carbon data accuracy and licensing; greenwashing claims; forecast error; grid-operator data access; double counting; a provider revision silently changing history. Mitigate with immutable snapshots, confidence, a public methodology, and a visible model/provider label on every receipt.

**Differentiation:** high. A verified carbon receipt per kWh is more defensible than a carbon dashboard, and it fits both Indian grid economics and European ESG reporting.

### A2. Signed webhook and event platform

**What:** A tenant-scoped event API with signed webhooks, retries, replay, and SDKs, built on the existing outbox.

**Architecture sketch:**

- The outbox already emits domain events. Add `webhook_endpoint` and `webhook_delivery` tables in Oracle; a worker dispatches with HMAC-SHA256 over `timestamp.body`, an idempotency key, and exponential backoff.
- Delivery receipts and a dead-letter queue are queryable; a replay endpoint re-emits a stored event.
- Block private IPs (SSRF), enforce HTTPS, rotate secrets, and document at-least-once semantics.
- Generate TypeScript and Python SDKs from the OpenAPI schema; provide a sandbox tenant.

**Data model impact:** `webhook_endpoint` (tenant, URL, secret hash, events, active), `webhook_delivery` (event ID, endpoint, status, attempts, next_retry, response code, signature), `event` retention. No change to money tables.

**API surface:** `POST/GET/DELETE /webhooks`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/replay`, `GET /events`, `POST /sandbox/events`.

**Effort:** 4–6 weeks.

**Risks:** SSRF, secret leakage, duplicate delivery, ordering expectations, and support load. Publish a clear delivery contract and a status page.

**Differentiation:** medium. It creates integration depth and switching costs; it also forces a clean event contract that improves auditability.

### A3. OCPI 2.2 roaming (CPO + EMSP)

**What:** Standard roaming endpoints for tokens, locations, sessions, and CDRs, with signed CDR exchange and reconciliation.

**Architecture sketch:**

- OCPI HTTP service (CPO and EMSP roles) with version negotiation, token cache, and idempotency keys.
- Map VoltHub stations/connectors to OCPI locations/EVSEs; map sessions to CDRs; sign CDRs; exchange with a roaming hub or direct partner.
- A reconciliation worker matches CDRs to invoices/ledger entries; a dispute workflow handles mismatches.
- Rate limits and availability SLOs; sandbox partner configuration.

**Data model impact:** `roaming_token`, `roaming_location`, `roaming_session`, `cdr`, `cdr_dispute`, `roaming_partner`; currency/FX fields; idempotency keys. Oracle owns the money-adjacent CDR; Timescale owns the session telemetry.

**API surface:** `/ocpi/2.2.1/tokens`, `/locations`, `/sessions`, `/cdrs` (CPO and EMSP), plus admin partner/config endpoints.

**Effort:** 6–8 weeks for a pilot; 10–12 for production settlement.

**Risks:** version fragmentation, CDR disputes, FX, PII/GDPR, partner availability. Start with one hub/partner, not all.

**Differentiation:** low–medium as a standard, high as a revenue unlock. Use correctness receipts and reconciliation as the trust differentiator in partner negotiations.

### A4. OCPP 2.0.1 + ISO 15118 Plug & Charge

**What:** A 2.0.1 gateway with security events, device model, charging profiles, certificate lifecycle, and PnC.

**Architecture sketch:**

- Protocol adapter per charge point; device model and EVSE/connector mapping; security event log; certificate store and OCSP/CRL checks.
- Charging profile engine (stack levels, purposes, schedules); transaction events; meter values.
- PnC: EIM/autocharge first, then ISO 15118-2/20 with contract certificates; authorization cache and fallback.
- Conformance harness: boot/security, profiles, transactions, certificates, firmware variance.

**Data model impact:** `charge_point` protocol/firmware, `evse`, `connector`, `charging_profile`, `certificate`, `authorization_cache`, `transaction`, `security_event`. Some are Timescale (meter/events), some Oracle (certificates/transactions).

**API surface:** `/ocpp/2.0.1` (WebSocket), `/certificates`, `/charging-profiles`, `/plug-and-charge/authorize`, `/conformance/runs`.

**Effort:** 10–14 weeks for a lab pilot; longer for production certification.

**Risks:** firmware variance, certificate operations, safety, and overclaiming. Do not market "2.0.1 ready" until 3 charger models pass.

**Differentiation:** medium–high. It is an enterprise/grid door-opener and a real barrier to competitors.

### A5. Offline-first PWA + guest QR checkout

**What:** An installable, cached console with a queue for non-money actions, plus a QR flow that lets a guest start a session without an app.

**Architecture sketch:**

- Next.js PWA with a service worker caching the shell and station metadata; IndexedDB queue for reserve/cancel/start with idempotency keys; background sync.
- Guest QR deep link → phone OTP → PSP payment method token → session start; no card data stored.
- Money mutations stay online; the queue rejects them; conflict resolution is server-authoritative.
- Push notifications for session events (web push; fallback SMS/WhatsApp).

**Data model impact:** client-side `offline_action` queue; server `guest_session` (contact, consent, PSP token, session), `idempotency_key`; no new money ledger. Add `push_subscription`.

**API surface:** `POST /guest/sessions`, `POST /guest/otp`, `POST /reservations` with `Idempotency-Key`, `GET /stations/{id}/qr`, `POST /push/subscribe`.

**Effort:** 4–6 weeks.

**Risks:** stale cache, duplicate actions, payment security, iOS push limits, and consent. Keep the offline scope narrow and visibly label cached data.

**Differentiation:** low–medium. It improves acquisition and reliability at remote sites; it is not a moat by itself.

### A6. Multi-tenant isolation + SSO/SCIM

**What:** Tenant-scoped data and configuration, with SAML/OIDC SSO and SCIM provisioning for enterprise buyers.

**Architecture sketch:**

- Tenant context middleware; `tenant_id` on every row; row-level security or schema-per-tenant; per-tenant encryption keys for secrets.
- OIDC/SAML via a managed IdP (Keycloak/Auth0/WorkOS); JIT provisioning; SCIM 2.0 for users/groups.
- Per-tenant branding/config; audit every cross-tenant admin action; migration/backfill plan.
- SSO can ship first on the existing user model; full isolation follows.

**Data model impact:** `tenant`, `tenant_user`, `sso_config`, `scim_token`, `tenant_config`; `tenant_id` on all domain tables; unique constraints scoped by tenant. This is the largest migration in the list.

**API surface:** `/tenants`, `/tenants/{id}/sso`, `/scim/v2/Users`, `/scim/v2/Groups`; tenant claim in tokens; admin impersonation with audit.

**Effort:** SSO 2–3 weeks; full multi-tenancy 8–12 weeks.

**Risks:** cross-tenant leakage, migration downtime, support complexity, and IdP edge cases. Pen-test isolation before the first enterprise tenant.

**Differentiation:** medium. It is an enterprise gate, not a wedge; sell it after the trust and carbon stories.

### A7. Tariff replay and settlement sandbox

**What:** A read-only replay of historical sessions and meter values under a proposed tariff, with an invoice diff and export.

**Architecture sketch:**

- Snapshot sessions, meter values, and tariff versions into a read-only sandbox schema.
- A deterministic replay engine applies the candidate tariff, produces invoice lines, and diffs against production.
- Scenario versioning, approval workflow, and export; no writes to production.
- Optional what-if for carbon or demand charges.

**Data model impact:** `replay_scenario`, `replay_run`, `replay_result`, `replay_diff`; read-only views over Oracle/Timescale; no changes to money tables.

**API surface:** `POST /sandbox/replays`, `GET /sandbox/replays/{id}`, `GET /sandbox/replays/{id}/diff`, `GET /sandbox/replays/{id}/export`.

**Effort:** 2–3 weeks.

**Risks:** data privacy, compute cost, divergence from production logic. Share the tariff calculation module between production and replay; test with a golden dataset.

**Differentiation:** medium. It is a powerful sales and audit tool: "show me the bill under your tariff" is a buying moment.

### A8. Correctness receipts and settlement statements

**What:** A signed, public proof that the money path passed its invariants, plus a per-invoice settlement statement.

**Architecture sketch:**

- CI emits a receipt: commit, migration hash, OpenAPI hash, race-test transcript, invariant results, timestamp, signature.
- Store receipts in an append-only table; publish a `/receipts` page and raw JSON.
- Settlement statement links meter values → tariff version → invoice lines → ledger entry → payment reference.
- Sign with a managed key; publish the verification recipe.

**Data model impact:** `correctness_receipt`, `receipt_artifact`, `settlement_statement`; append-only; no changes to domain tables.

**API surface:** `GET /receipts`, `GET /receipts/{id}`, `GET /invoices/{id}/statement`, public read for receipts; signed JSON.

**Effort:** 2–3 weeks.

**Risks:** signing-key management, flaky tests, overclaiming. A receipt is only useful if the test suite is trustworthy; fix flaky tests first.

**Differentiation:** high. It makes the core thesis visible and is hard to copy without the architecture.

---

## 6. Integrations

| Area                       | Recommendation                                                                      | Flow                                                                                          |               Effort | Value           | Risks / notes                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------: | --------------- | ------------------------------------------------------------------------------------------ |
| **Payments**               | Razorpay/UPI for India + Stripe for global cards; PSP-hosted fields                 | Checkout → PSP webhook → ledger capture → invoice reconciliation → refund/chargeback workflow |                 4–6w | High            | PCI scope, KYC, chargebacks, GST; never store card data.                                   |
| **Notifications**          | SES + Twilio/WhatsApp Business + web push                                           | Domain event → template → channel → delivery receipt → preference center                      |                 1–2w | High            | Consent, DLT/template approval in India, quiet hours, retries.                             |
| **Maps**                   | Mapbox or Google Maps; OSM fallback for cost control                                | Geocode stations → map tiles → directions/deep link → cache                                   |                   1w | Medium          | Quota/cost, India accuracy, attribution.                                                   |
| **Observability**          | OpenTelemetry + Grafana + Sentry                                                    | Traces gateway→API→outbox→Timescale; logs with request ID; SLO dashboards                     |                 1–2w | High            | Cardinality, PII redaction, cost.                                                          |
| **Accounting**             | Zoho Books or Tally (India), QuickBooks (global)                                    | Invoice/credit note sync → tax codes → payment reconciliation → export                        |                 2–3w | Medium–High     | GST treatment, chart-of-accounts mapping, idempotency.                                     |
| **Roaming**                | Hubject/Gireve or direct OCPI partners                                              | Token/location/session/CDR exchange → reconciliation → dispute                                |                 6–8w | High            | Version fragmentation, settlement/FX, PII/GDPR; start with one partner.                    |
| **Carbon data** (optional) | Electricity Maps/WattTime or grid operator, behind the existing CarbonPilot surface | Provider → immutable snapshot → carbon schedule → persisted receipt → M&V                     | 3–4w (provider only) | High for carbon | Licensing, accuracy, methodology, greenwashing risk; keep model-v1 as a labelled fallback. |

**Sequencing:** payments and notifications first (they complete the core loop), observability in parallel (you cannot operate what you cannot see), maps with the PWA/guest work, accounting after payments stabilize, roaming after the API/webhook contract is clean, carbon data with the carbon pilot.

---

## 7. 90-day roadmap

### 7.1 Plan

| Window         | Workstream               | Deliverables                                                                                                    | Exit criteria                                                                                                                                  | Dependencies                  |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Weeks 1–2**  | Truth & safety           | UX-01…UX-05, UX-07, UX-10, UX-14, UX-18; map/chart a11y spike; AI evaluation freeze                             | 0 P0 UX findings; 0 critical/serious axe on core routes; AI receipt reproducible with dataset hash, zero baseline, and separated calibration   | None                          |
| **Weeks 3–4**  | Money loop               | PSP sandbox (UPI + card), webhook idempotency, invoice dates/PDF/CSV, notification service, GST fields          | One real ₹1 test payment end-to-end; 100% webhook idempotency; 99% notification delivery in sandbox                                            | Payments account/KYC          |
| **Weeks 5–6**  | Developer platform + PWA | API keys, signed webhooks, SDKs, sandbox tenant; PWA shell, QR guest flow, offline queue                        | 3 design partners; webhook p95 <60s; guest-to-charge <3 min in lab                                                                             | Event contract; PSP           |
| **Weeks 7–8**  | Protocol proof           | OCPI 2.2 sandbox (tokens/locations/CDRs); OCPP 2.0.1 conformance harness; multi-tenant/SSO design doc           | One OCPI handshake + CDR; 3 charger models pass harness; threat model signed off                                                               | Partner sandbox; lab chargers |
| **Weeks 9–12** | Pilot & enterprise       | Carbon-aware pilot with live provider + M&V; OCPI production pilot; SSO/SCIM prototype; SLOs and audit receipts | Carbon reduction ≥15% vs baseline; every receipt verifies and names its provider; CDR match 100%; 2 tenants isolated in pen test; 99.9% uptime | Carbon data; partner; IdP     |

### 7.2 Critical path

1. **Truth fixes → payments.** A payment flow on top of stale invoice state will create support tickets; fix UX-04 and mutation feedback first.
2. **AI evaluation → carbon pilot.** Carbon scheduling needs a carbon signal with provenance and calibrated uncertainty; do not sell M&V on model-v1 or build a customer claim on the current intervals.
3. **Event contract → webhooks → OCPI.** A clean domain event schema is the common dependency; do not build three separate integrations.
4. **Conformance harness → OCPP 2.0.1 marketing.** The harness is the gate; without it, the claim is not credible.
5. **SSO → multi-tenant.** SSO is a fast enterprise unlock; full isolation follows with the first design partner.

### 7.3 Staffing assumption

- 2 full-stack engineers (web/API)
- 1 frontend/accessibility engineer
- 1.5 data/ML engineers
- 1 platform/SRE engineer
- 0.5 product designer
- 1 product/partnerships lead

This is a plan for a small team; if staffing is lower, cut scope in this order: OCPP 2.0.1 lab → multi-tenant build → accounting integration. Do not cut the truth fixes or the AI evaluation repair.

### 7.4 KPI dashboard for the 90 days

| Area        | Metric                                     | Target | Instrumentation               |
| ----------- | ------------------------------------------ | ------ | ----------------------------- |
| Trust       | Silent mutation failures                   | 0      | Client error taxonomy + audit |
| Trust       | Core-flow success (reserve/start/pay)      | ≥99.5% | Event funnel                  |
| UX          | Time to first session                      | <3 min | Client timestamps             |
| A11y        | Critical/serious axe violations            | 0      | CI axe + manual               |
| AI          | MAE skill vs best baseline (nonzero hours) | ≥20%   | Backtest receipt              |
| AI          | Coverage per station-scale slice           | 80% ±2 | Calibration report            |
| AI          | Reproducibility                            | 100%   | Dataset/code/artifact hashes  |
| Payments    | Auto-reconciled                            | ≥98%   | PSP webhook + ledger          |
| Webhooks    | p95 delivery                               | <60s   | Delivery table                |
| Roaming     | CDR match                                  | 100%   | Reconciliation report         |
| Carbon      | gCO2/kWh reduction                         | ≥15%   | M&V report                    |
| Reliability | Uptime                                     | 99.9%  | SLO dashboard                 |

---

## Appendix A — Evidence index

**Web**

- `apps/web/src/lib/ui.js` — API client, formatters, PageState, toasts, AuthGate, charts, map, dialogs.
- `apps/web/src/app/globals.css` — tokens, focus, motion, buttons, forms, tables, responsive rules.
- `apps/web/src/app/discover/page.js` — polling, search, map, selection.
- `apps/web/src/app/dashboard/page.js` — station switching, stale data, fan-out.
- `apps/web/src/app/telemetry/page.js` — heatmap/load curve, stale state, source pill.
- `apps/web/src/app/analytics/page.js` — retry, race, utilization label.
- `apps/web/src/app/session/[id]/page.js` — live session, aria-live, operator actions.
- `apps/web/src/app/stations/[id]/page.js` — reservation timezone, availability, tariffs.
- `apps/web/src/app/faults/page.js` — completion flow, severity mapping.
- `apps/web/src/app/history/page.js` — pagination, order, link.
- `apps/web/src/app/invoices/page.js` — pay/detail, export.
- `apps/web/src/app/reservations/page.js` — tariff fallback, start/cancel.
- `apps/web/src/app/notifications/page.js` — read state, deep links.
- `apps/web/src/app/admin/page.js` — tabs, tariffs, operator creation, audit time.
- `apps/web/src/app/profile/page.js` — `/me` failure, vehicles.
- `apps/web/src/app/wallet/page.js`, `apps/web/src/lib/wallet-client.js` — unlink, radio, demo key, timezone.
- `apps/web/src/app/login/form.js`, `apps/web/src/app/session-links.js`, `apps/web/src/app/nav.js`, `apps/web/src/app/layout.js`, `apps/web/src/app/error.js`, `apps/web/src/app/global-error.js`.

**API**

- `apps/api/src/routes.js` — auth, sessions, invoices, admin users, reservation behavior.
- `apps/api/src/middleware/auth.js` — token/cookie helpers.
- `apps/api/src/server.js` — CORS credentials.

**AI**

- `apps/ai/train.py` — folds, stride, early stopping, final fit, metrics.
- `apps/ai/contract.py` — calendar features, target scaling, conformal, metrics.
- `apps/ai/ingest.py` — source loaders, timezone, overlap-weighted aggregation.
- `apps/ai/service.py` — forecast, anomalies, optimizer, auth, artifact load.
- `apps/api/src/carbon-routes.js`, `apps/api/src/carbon/intensity.js`, `apps/web/src/app/carbon/page.js` — CarbonPilot model-v1, receipts, summary, page.
- `apps/ai/reports/metrics.json` (current 87-series receipt), `dataset.json`, `benchmarks.json`, `train-real.log` (prior 47-station run).
- `docs/ai-platform.md`, `docs/verification.md`, `docs/perf.md`, `docs/adr/0017-carbon-aware-charging.md`, `apps/ai/README.md`.

**Strategy**

- `docs/STRATEGY-AND-ROADMAP.md`, `docs/startup/product-thesis.md`, `docs/research/paper.md`, `docs/adr/0015-acceptance-envelope-scheduling.md`.

## Appendix B — Reconstruction method and limitations

**Method**

- Read `apps/ai/ingest.py`, `contract.py`, and `train.py`; loaded the current 87-series panel from `data/hourly/panel.npz` with the same contract.
- Applied the same `--max-rows 240000` stride: **719,880 contract rows → 239,960 (step 3)**.
- Applied the same `fold_masks` protocol: 4 folds, 45 backtest days, 10 calibration days, 1 purge day, 24h horizon.
- Reconstructed **31,109 origins × 24 leads = 746,616 targets**, matching `metrics.json:20-27`.
- Scored a zero forecast on that matrix and compared it with the receipt's MLP, seasonal-naive, weekly-mean, and per-source MAEs; computed zero share and the test distribution.
- Repeated the prior 47-station reconstruction separately (402,934 rows → step 2 → 201,467; 25,113 origins × 24 = 602,712) for the before/after comparison. It is not the current claim.
- No source files were modified. The reconstruction was read-only and is reproducible from the code paths cited.

**Limitations**

- The MLP predictions come from the published receipt, not a fresh full retrain. The zero baseline was scored on the reconstructed masks; matching the point count is consistency evidence, not proof of identical fold composition.
- The zero comparison is **source-level** because per-station MLP errors are not published. "80 of 87 series" counts the series in Tennessee and Korea where zero wins; it is not a station-level win count.
- The raw files are present and match `dataset.json`'s SHA-256 digests, but `panel.npz` was transient/truncated during the audit. The comparison therefore validates the receipt's shape and source-level metrics, not a byte-identical snapshot.
- `metrics.json` carries artifact hashes but no dataset hash, so the reconstruction cannot prove which dataset snapshot produced `model.pt`.
- No browser/axe run was performed; contrast is calculated from CSS hex values. Confirm with axe-core and NVDA/VoiceOver before signing an accessibility statement.
- The AI expected-effect ranges are engineering targets, not measured outcomes. They must be validated by the repaired backtest.
- This is a product/UX/AI audit, not a full security review. The default operator password and auth cookie findings are flagged because they affect trust; a dedicated security audit is still required.
- CarbonPilot model-v1 is a deterministic function of region and time, not a live grid measurement. No provider data or M&V results were available to audit.

## Appendix C — Glossary

- **ACN / CDR:** OCPI session/charge-detail record used for roaming settlement.
- **CPO / EMSP:** Charge Point Operator / E-Mobility Service Provider.
- **EIM / PnC:** External Identification Means / Plug & Charge (ISO 15118).
- **M&V:** Measurement and verification of a load/carbon intervention against a baseline.
- **MASE:** Mean absolute scaled error; this repo's implementation is relative MAE, not standard MASE.
- **OCPI / OCPP:** Open Charge Point Interface / Open Charge Point Protocol.
- **SCIM:** System for Cross-domain Identity Management.
- **ToU:** Time-of-use tariff.

---

_End of report._
