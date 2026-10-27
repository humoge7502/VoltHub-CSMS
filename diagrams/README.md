# diagrams

Two kinds of source live here, on purpose.

## DA3 — the money-to-analytics path

| File                     | What it is                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- |
| `da3.html`               | **The authored render.** CSS layout, console palette, the one that ships.     |
| `scripts/render-da3.mjs` | Rasterises each `[data-diagram]` section to `diagrams/out/da3-*.png` at 2×.   |
| `diagrams/out/da3.pdf`   | The same two diagrams, vector, one page each — for handouts and print.        |
| `da3-pipeline.mmd`       | Portable Mermaid source of the same pipeline (renders on GitHub, in editors). |
| `da3-schema.mmd`         | Portable Mermaid source of the same schema.                                   |

Why two sources: Mermaid's auto-layout turned the pipeline into a 10:1 strip and the schema
into a 1:3.2 tower. Neither survives being scaled into a README, and the labels wrapped
mid-word. The HTML version is the one to use in anything a human reads; the `.mmd` files
stay because they are diffable text and render anywhere without a toolchain.

```bash
node scripts/render-da3.mjs            # -> diagrams/out/da3-{pipeline,schema}.png
node scripts/render-da3.mjs --scale 1  # smaller files for the web
node scripts/render-da3.mjs --pdf      # -> diagrams/out/da3.pdf (PNGs too)
```

The PDF is not a wrapped PNG: Chromium embeds real glyphs, so the text stays selectable
and the hairlines stay sharp at any zoom. Pages are sized to the diagram's own design
width (2200 px ≈ 582 mm), so nothing is scaled down — print it on A2 or larger, or let
the viewer fit it to A4/A3 where the labels are still legible.

Editing a diagram means editing `da3.html` **and** the matching `.mmd` — they describe the
same system and a reviewer should be able to diff either one.

## The rest — Mermaid sources (render with `mmdc`)

- `system-architecture.mmd` — clients → monolith → Oracle/Timescale
- `er-model.mmd` — 25 entities, weak/EER/multivalued/derived annotated
- `reservation-race.mmd` — R1 sequence: FOR UPDATE serializes A/B → 201+409
- `session-lifecycle.mmd` — OCPP × billing × connector state machines

```bash
npx -y @mermaid-js/mermaid-cli -i diagrams/reservation-race.mmd -o out/reservation-race.svg
```

`mermaid.theme.json` + `puppeteer.json` in this folder are the palette and the browser
config used above (`-c` and `-p`); pass `-t base` as well, because mmdc's CLI default
theme overrides the config file's `theme` key.
