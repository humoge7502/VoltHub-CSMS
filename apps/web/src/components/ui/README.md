# UI primitives — Grid Current enforcement point

`src/lib/ui.js` exports `Kpi`, `Pill` (dot+label, status colors only),
`Line` (inline SVG, hairline grid, IST labels), `Heatmap` (carbon→cream→lime),
`CorridorMap` (keyless schematic, list-mode fallback = the station list).
Review checklist §21.4 applies here: no glass/gradients, no emoji icons,
tabular numerals for every number, ≤2 animated props per screen.
