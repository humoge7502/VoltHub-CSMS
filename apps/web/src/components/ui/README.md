# UI primitives — Grid Current enforcement point

`src/lib/ui.js` exports `Kpi`, `Pill` (dot+label, status colors only),
`Line` (inline SVG, hairline grid, IST labels, flat fill), `Heatmap`
(carbon→cream→lime), `CorridorMap` (keyless schematic, keyboard-selectable
pins, list-mode fallback = the station list), `PageHead`, `Section`,
`Statband`, `EmptyState`, `PageState`, `Toasts`, `AuthGate`,
`ConfirmDialog` (native `<dialog>` — no `window.confirm`/`prompt`), and
`StationPicker`.
Review checklist §21.4 applies here: no glass/gradients, no emoji icons,
tabular numerals for every number, ≤2 animated props per screen.
