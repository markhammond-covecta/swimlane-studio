# Swimlane Studio

A single-file SPA that renders horizontal swimlane diagrams from a
swimlane-style DSL. Boxes live in their sender's lane, arrows are
routed deterministically by a layout solver, and the whole diagram
exports to SVG or PNG.

![Screenshot](docs/screenshot.png)

## Quick start

```sh
python3 -m http.server 8765
open http://localhost:8765/index.html
```

That's it — `index.html` is fully self-contained (no build step, no
external libraries). The page polls its own `Last-Modified` header
every ~1.5s and reloads itself when the file changes on disk, so
editing the file in another tool gives you a live preview. The editor
content and split-pane position survive reloads via `localStorage`.

## Syntax

The DSL is a line-oriented superset of swimlane syntax.

| Form | Meaning |
| --- | --- |
| `title: Order processing` | Diagram title (centred above the lanes). |
| `order: Customer, Storefront, API` | Force the lane order (top to bottom). Otherwise lanes appear in the order they're first used. |
| `Alice -> Bob: Send order` | Cross-lane message. Box "Send order" in Alice's lane, vertical/elbow arrow down to Bob. |
| `Alice --> Bob: ACK` | Same, but with a dashed line (used for returns / async). |
| `Alice -> Alice: Validate` | Same-lane forward link. Box in Alice with a blue horizontal trail to the next Alice-source box. |
| `Alice <-> Alice: Process` | Bidirectional same-lane: forward link plus a backward link from the previous Alice-source box. |
| `Alice <-> Bob: Sync call` | Bidirectional cross-lane: the normal cross-lane arrow plus a same-lane backward link from the previous Alice box. |
| `Alice <: Done` | Backward-only box: incoming blue link from the previous Alice box, no outgoing trail. Useful for terminal states. |
| `Alice: Read output` | Standalone (non-directed) box — no arrows of its own; receives any cross-lane arrow targeting Alice at the same column. |
| `[ Section name ]` | Labelled section banner spanning the columns that follow. |
| `note Alice: Inspect logs` | Yellow note attached to a single lane. |
| `note Alice, Bob: Drift window\n2s` | Multi-lane note (uses `\n` for line breaks). |
| `# …` or `// …` | Comment line. |

### Arrow labels

Any message text ending in `<…>` puts the bracketed text on the arrow
itself as an italic caption, separately from the box label.

```
Browser -> Server: Send request <synchronous call>
```

renders a "Send request" box with "synchronous call" beside the arrow.

## Layout rules

The solver is deterministic and enforces:

1. **Arrows are vertical or strictly left-to-right.** No right-to-left
   horizontal segments.
2. **Arrows never enter a box on the right or exit on the left.**
3. **Arrows are either:** a straight segment, an L-shape (2 segments),
   a Z-shape (3 segments) when entering from the left, or a self-loop
   on the same box.
4. **Shortest path subject to the rules.** Ties prefer fewer bends and
   the earliest valid column.
5. **Boxes default to vertical alignment with their source.** A target
   box sits in the same column as the source unless that column/lane
   is already occupied, an intermediate-lane box would block the
   vertical, or an existing arrow at that column would overlap. In any
   of those cases the box moves right by one column.
6. **Counter-pair arrows** (A→B and B→A at the same column) are
   rendered side-by-side with a ±10 px offset; the chronologically
   earlier event goes on the left.
7. **Elbow corners are rounded** (8 px quadratic curves).

## Export

- **Download SVG** / **Copy SVG** — raw vector source.
- **Download PNG** / **Copy PNG** — rendered at 2× scale onto a white
  canvas.
- **Copy source** — copies the editor's DSL to the clipboard.

`Copy PNG` requires HTTPS or localhost (it uses the asynchronous
`ClipboardItem` API).

## Keyboard / mouse

- Drag the central divider to resize the source and diagram panes; the
  position persists. Arrow keys nudge it by 20 px. Double-click resets
  the default split.
- The diagram pane scrolls independently; large diagrams scroll
  horizontally and vertically.

## Project layout

Everything is in `index.html`. The file is structured as:

| Section | Responsibility |
| --- | --- |
| `<style>` | Theme, layout, resizer styling. |
| `parse(source)` | Tokenises the DSL into events + lane order + sections. |
| `solveLayout(model)` | Phase 1 places boxes (chained columns, move-right rules). Phase 2 computes each arrow as a polyline. Phase 3 maps sections back to columns. |
| `render(model)` | Emits the SVG. Includes `polylineToPath` for rounded elbows and `arrowLabelSvg` for captions. |
| `doRender()` / drivers | Hooks the editor to the solver, manages hot-reload, source persistence, resizing, and exports. |

## License

Private repository — no license granted.
