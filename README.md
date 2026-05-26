# Swimlane Studio

A single-file SPA that renders swimlane diagrams from a swimlane-style
DSL. Boxes live in their sender's lane, arrows are routed deterministically
by a layout solver, and the whole diagram exports to SVG or PNG. The diagram
can be flipped between horizontal swimlanes (lanes stacked top-to-bottom,
time flowing left-to-right) and vertical swimlanes (lanes side-by-side
left-to-right, time flowing top-to-bottom).

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
content, split-pane position, zoom level, and orientation choice all
survive reloads via `localStorage`.

## Syntax

The DSL is a line-oriented superset of swimlane syntax. Click the
**Help** button in the header for a quick in-app reference.

| Form | Meaning |
| --- | --- |
| `title: Order processing` | Diagram title (centred above the lanes). |
| `order: Customer, Storefront, API` | Force the lane order (top-to-bottom in horizontal, left-to-right in vertical). Otherwise lanes appear in the order they're first used. |
| `Alice -> Bob: Send order` | Cross-lane message. Box "Send order" in Alice's lane, arrow down/across to Bob. |
| `Alice --> Bob: ACK` | Same, but with a dashed line (typically a response). |
| `Alice -> Alice: Validate` | Same-lane forward link. Box in Alice with a horizontal trail to the next Alice-source box. |
| `Alice <-> Alice: Process` | Bidirectional same-lane: forward link plus a backward link from the previous Alice-source box. |
| `Alice <-> Bob: Sync call` | Bidirectional cross-lane: the normal cross-lane arrow plus a same-lane backward link from the previous Alice box. |
| `Bob >-> Alice: Reply` | Counter-pair forward link. After `Alice -> Bob`, this opts INTO the shared-column side-by-side rendering (down-and-up arrows next to each other). Without `>->`, the reply breaks the chain and starts a new column. |
| `Alice <: Done` | Backward-only box: incoming link from the previous Alice box, no outgoing trail. Useful for terminal states. |
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

### Wrapping

- Box captions wrap at ~22 chars per line; overlong single tokens are
  chopped so they can't overflow.
- Arrow captions wrap at ~22 chars per line (horizontal) or ~14
  (vertical), and the solver widens the inter-column gap automatically
  so even long captions don't crash into the next box.
- Lane names wrap to fit the lane width in vertical mode.

## Orientation

Toggle between **horizontal** (↔) and **vertical** (↕) layouts using
the segmented control in the diagram pane header. The choice persists
across reloads.

- **Horizontal**: lanes stack top-to-bottom; time flows left-to-right.
- **Vertical**: lanes sit side-by-side left-to-right (first-declared
  lane on the left); time flows top-to-bottom. Lane captions sit in a
  compact strip above each column with wrapping; boxes stay landscape
  for readable labels; rows are spaced just like adjacent columns in
  horizontal mode.

## Layout rules

The solver is deterministic and enforces:

1. **Arrows are vertical or strictly left-to-right.** No right-to-left
   horizontal segments. (Vertical orientation transposes the diagram,
   so these axes flip in the final SVG but the logical solver runs in
   the horizontal frame.)
2. **Arrows never enter a box on the right or exit on the left.**
3. **Arrows are either:** a straight segment, an L-shape (2 segments),
   or a Z-shape (3 segments) when entering from the left.
4. **Shortest path subject to the rules.** Ties prefer fewer bends and
   the earliest valid column.
5. **Boxes default to vertical alignment with their source.** A target
   box sits in the same column as the source unless that column/lane
   is already occupied, an intermediate-lane box would block the
   vertical, or an existing arrow at that column would overlap. In any
   of those cases the box moves right by one column.
6. **Counter-back chains break by default.** When `A -> B` is followed
   by `B -> A`, the reply starts a NEW column rather than routing back
   to A's originating box. Use `B >-> A: ...` to opt into the legacy
   shared-column counter-pair rendering (down-arrow and up-arrow
   offset by ±10 px at the same column).
7. **Variable column widths.** A column is extended automatically when
   a same-lane horizontal caption is wider than the default 40 px gap;
   long lane names extend the caption strip the same way.
8. **First box is bolded.** The first activity box in the diagram
   renders with a thicker (2.5 px vs 1.25 px) blue border to mark the
   entry point.
9. **Elbow corners are rounded** (8 px quadratic curves).

## Zoom

The diagram pane header has zoom controls:

- **−** / **+** snap to 25 % increments (25 %–400 %).
- **Fit** — exact ratio that fits the whole diagram in the viewport.
- **Reset** — 100 %.
- **Ctrl/Cmd + wheel** or **two-finger trackpad pinch** zoom around
  the cursor, anchoring the point under the gesture in place.

Zoom level persists across reloads.

## Source: New / Load / Save

The source pane has a button row:

- **New** — clear the editor (prompts if there are unsaved changes).
- **Load** — open a `.txt` file (prompts if there are unsaved changes).
- **Save** — write the editor contents to a `.txt` file. Uses
  `showSaveFilePicker` when available, falls back to a download.

"Unsaved" is measured against the last explicit Save or Load (the
baseline is persisted to `localStorage`, so the warning survives a
tab close). A browser `beforeunload` prompt fires if you try to close
the tab with unsaved edits.

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
- **Esc** closes the Help modal.

## Project layout

Everything is in `index.html`. The file is structured as:

| Section | Responsibility |
| --- | --- |
| `<style>` | Theme, pane layout, resizer, zoom and orientation toggles, help modal. |
| `parse(source)` | Tokenises the DSL into events + lane order + sections. |
| `solveLayout(model)` | Phase 1 places boxes (chained columns, counter-back break, move-right rules). Phase 1.5 computes per-column right margins for long horizontal captions and builds `colCenters`. Phase 2 computes each arrow as a polyline using stored box dimensions (which swap in vertical orientation so the rendered boxes stay landscape). |
| `render(model)` | Emits the SVG. In vertical mode it wraps the content in a transposition group and counter-transposes text via `matrix(0 1 1 0 …)` so labels stay readable. Includes `polylineToPath` for rounded elbows and `arrowLabelSvg` for arrow captions. |
| `doRender()` / drivers | Hooks the editor to the solver, manages hot-reload, source persistence, zoom (including ctrl/cmd-wheel and touch pinch), orientation toggle, New/Load/Save, the Help modal, and exports. |

## License

Private repository — no license granted.
