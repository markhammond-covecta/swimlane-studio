// swimlane-core.js
//
// The pure diagram engine shared by the Swimlane Studio web app
// (index.html) and the MCP server (server/server.js). No DOM is required:
// measureTextPx() falls back to a font-size-aware estimate when document
// is unavailable (i.e. under Node). Keep this file framework-free and
// dependency-free so both consumers can import it directly.
//
// Pipeline: parse(source) -> model; solveLayout(model) mutates the model
// with box positions + arrow polylines; render(model) emits SVG;
// renderAscii(model) emits a fixed-grid text rendering.

// ---------- parser ----------
function parse(source) {
  const lines = source.split(/\r?\n/);
  const events = [];
  const lanesSeen = new Set();
  let title = "";
  let explicitOrder = null;
  const errors = [];

  const arrowRe = /^(.+?)\s*(<-{1,2}>|<-{1,2}|>-{1,2}>|-{1,2}>)\s*(.+?)(?::\s*(.*))?$/;
  const noteRe = /^note\b(?:\s+([^:]+?))?\s*:\s*(.*)$/i;
  const sectionRe = /^\[\s*(.+?)\s*\]$/;
  const titleRe = /^title\s*:\s*(.*)$/i;
  const orderRe = /^order\s*:\s*(.*)$/i;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let raw = lines[lineNo];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("//")) continue;

    let m;
    if ((m = line.match(titleRe))) { title = m[1].trim(); continue; }
    if ((m = line.match(orderRe))) {
      explicitOrder = m[1].split(",").map(s => s.trim()).filter(Boolean);
      explicitOrder.forEach(l => lanesSeen.add(l));
      continue;
    }
    if ((m = line.match(sectionRe))) {
      events.push({ type: "section", label: m[1], lineNo });
      continue;
    }
    if ((m = line.match(noteRe))) {
      const targets = m[1] ? m[1].split(",").map(s => s.trim()).filter(Boolean) : [];
      targets.forEach(l => lanesSeen.add(l));
      events.push({ type: "note", lanes: targets, text: unescapeLabel(m[2] || ""), lineNo });
      continue;
    }
    if ((m = line.match(arrowRe))) {
      let from = m[1].trim();
      const arrow = m[2];
      let to = m[3].trim();
      const raw = unescapeLabel((m[4] || "").trim());
      const { caption: text, arrowLabel } = splitArrowLabel(raw);
      // ->, --> : forward link. When from == to, the box is in the lane
      //           and the arrow trails right to the next same-lane box.
      // <->, <-->: bidirectional link. The box has BOTH a forward link
      //           (to the next same-lane box) and a backward link (from
      //           the previous same-lane box).
      // <-, <-- : reversed (B sends to A).
      // >->, >-->: counter-back forward link. Same as -> / --> but when
      //           the previous message ran in the opposite direction
      //           (A -> B then B >-> A), the two messages share a column
      //           and render as a side-by-side counter-pair. Without
      //           >->, B -> A immediately after A -> B breaks the chain
      //           and starts a new column.
      // Trailing "<label>" in the text becomes the arrow's caption.
      if (/^<-{1,2}>$/.test(arrow)) {
        const dashed = arrow.includes("--");
        lanesSeen.add(from);
        lanesSeen.add(to);
        events.push({ type: "message", from, to, text, dashed, bidirectional: true, arrowLabel, lineNo });
        continue;
      }
      const counter = /^>-{1,2}>$/.test(arrow);
      const reversed = arrow.startsWith("<");
      const dashed = arrow.includes("--");
      if (reversed) [from, to] = [to, from];
      lanesSeen.add(from);
      lanesSeen.add(to);
      events.push({ type: "message", from, to, text, dashed, arrowLabel, counter, lineNo });
      continue;
    }

    // Backward-only box: "Lane <: text". A labelled box in the lane with
    // only an incoming blue link from the previous same-lane box.
    const incomingOnlyRe = /^([^<:]+?)\s*<:\s*(.+)$/;
    if ((m = line.match(incomingOnlyRe))) {
      const lane = m[1].trim();
      const raw = unescapeLabel(m[2].trim());
      const { caption: text, arrowLabel } = splitArrowLabel(raw);
      if (lane && text) {
        lanesSeen.add(lane);
        events.push({ type: "message", from: lane, to: lane, text, incomingOnly: true, arrowLabel, lineNo });
        continue;
      }
    }

    // Non-directed standalone box: "Lane: text". A labelled box in the
    // lane with no arrows of its own.
    const standaloneRe = /^([^:]+?):\s*(.+)$/;
    if ((m = line.match(standaloneRe))) {
      const lane = m[1].trim();
      const text = unescapeLabel(m[2].trim());
      if (lane && text) {
        lanesSeen.add(lane);
        events.push({ type: "message", from: lane, to: lane, text, standalone: true, lineNo });
        continue;
      }
    }

    errors.push(`Line ${lineNo + 1}: could not parse "${line}"`);
  }

  let laneOrder;
  if (explicitOrder && explicitOrder.length) {
    laneOrder = explicitOrder.slice();
    for (const l of lanesSeen) if (!laneOrder.includes(l)) laneOrder.push(l);
  } else {
    laneOrder = [];
    for (const ev of events) {
      if (ev.type === "message") {
        if (!laneOrder.includes(ev.from)) laneOrder.push(ev.from);
        if (!laneOrder.includes(ev.to)) laneOrder.push(ev.to);
      } else if (ev.type === "note") {
        for (const l of ev.lanes) if (!laneOrder.includes(l)) laneOrder.push(l);
      }
    }
  }

  // assign column indices to non-section events; group sections over following columns
  const positioned = [];
  const sections = [];
  let currentSection = null;
  for (const ev of events) {
    if (ev.type === "section") {
      if (currentSection) currentSection.end = positioned.length - 1;
      currentSection = { label: ev.label, start: positioned.length, end: positioned.length, lineNo: ev.lineNo };
      sections.push(currentSection);
    } else {
      ev.col = positioned.length;
      positioned.push(ev);
    }
  }
  if (currentSection) currentSection.end = positioned.length - 1;
  // discard trailing sections with no following events
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].start > positioned.length - 1) sections.splice(i, 1);
  }

  return {
    title,
    lanes: laneOrder,
    events: positioned,
    sections,
    errors,
  };
}

function unescapeLabel(s) {
  return s.replace(/\\n/g, "\n");
}

// Split a label like "Send request <urgent>" into the box caption and the
// arrow-label text. Returns { caption, arrowLabel } where arrowLabel is
// null if the input has no trailing <...> token.
function splitArrowLabel(text) {
  const m = String(text).match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (m) return { caption: m[1].trim(), arrowLabel: m[2].trim() };
  return { caption: text, arrowLabel: null };
}

function escXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- layout solver ----------
//
// The solver assigns columns to events and precomputes arrow routings.
// It enforces these rules deterministically:
//
//   1. Arrow segments are vertical or left-to-right only.
//   2. Arrows never enter a box on the right or exit a box on the left.
//   3. Arrows are single straight segments (horizontal or vertical),
//      L-shapes (two segments), or self-loops on the same box.
//   4. Arrows do not cross other arrows or other boxes.
//   5. Arrows take the shortest path satisfying the rules; ties prefer
//      fewer bends and the earliest valid column.
//   6. By default, a target box sits in the SAME column as its source
//      (boxes are vertically aligned with their source). A box is only
//      moved right when the default column is occupied or the arrow
//      would violate a rule.
//
// Geometry constants here must match the renderer's constants.

const LAYOUT = {
  COL_W: 200, BOX_W: 160, LANE_H: 110, LANE_GAP: 18,
  PAD_L: 24, CAPTION_W: 150, PAD_T_TOP: 18,
  TITLE_H_WHEN_PRESENT: 44, SECTION_H_WHEN_PRESENT: 32,
  BOX_MIN_H: 42, TEXT_LINE_H: 15, BOX_PAD_V: 12, CHAR_BUDGET: 22,
  LANE_START_OFFSET: 8,
  LANE_END_PAD: 32,
  SELF_LOOP_HEIGHT: 18,
  // Arrow caption wrap widths (chars per line). Captions longer than
  // HLABEL_MAX_CHARS wrap; the solver extends the inter-column gap so
  // the longest line still fits.
  HLABEL_MAX_CHARS: 22,
  VLABEL_MAX_CHARS: 14,
  LABEL_CHAR_PX: 6.2,      // estimated px per char for italic 11px sans
  LABEL_H_PADDING: 24,     // breathing room around a horizontal caption
};

// Returns colX(c), laneY(i), laneCY(i), and the top-of-lanes y.
// colX consults model.colCenters when populated (variable widths for
// long horizontal captions); falls back to uniform COL_W spacing
// otherwise. Phase 1 runs with the uniform fallback; Phase 1.5 sets
// colCenters before Phase 2 uses it.
//
// In vertical orientation each lane gets more "height" in horizontal
// space (which becomes lane WIDTH after the transposition transform)
// so that boxes and wrapped captions have room to breathe.
function laneHeightFor(model) {
  return model.orientation === "vertical" ? 220 : LAYOUT.LANE_H;
}
// Column spacing in the solver's horizontal frame. In vertical
// orientation this becomes the VERTICAL spacing between rows in the
// final SVG. We size it so the gap between adjacent same-lane boxes
// matches the horizontal-orientation gap (COL_W - BOX_W = 40px), i.e.
// vertical COL_W = boxH + 40 ≈ 82 for single-line text.
function colWidthFor(model) {
  if (model.orientation !== "vertical") return LAYOUT.COL_W;
  return LAYOUT.BOX_MIN_H + (LAYOUT.COL_W - LAYOUT.BOX_W);
}
function layoutMetrics(model) {
  const L = LAYOUT;
  const titleH = model.title ? L.TITLE_H_WHEN_PRESENT : 0;
  const sectionH = model.sections.length > 0 ? L.SECTION_H_WHEN_PRESENT : 0;
  const topOfLanes = L.PAD_T_TOP + titleH + sectionH;
  const captionW = (typeof model.captionW === "number") ? model.captionW : L.CAPTION_W;
  const laneH = laneHeightFor(model);
  const colX = c => {
    const cc = model.colCenters;
    if (cc && c < cc.length) return cc[c];
    if (cc && cc.length > 0) {
      const last = cc.length - 1;
      return cc[last] + (c - last) * L.COL_W;
    }
    return L.PAD_L + captionW + c * L.COL_W + L.COL_W / 2;
  };
  return {
    colX,
    laneY: i => topOfLanes + i * (laneH + L.LANE_GAP),
    laneCY: i => topOfLanes + i * (laneH + L.LANE_GAP) + laneH / 2,
    laneStartX: L.PAD_L + captionW + L.LANE_START_OFFSET,
    topOfLanes,
    laneH,
  };
}

// Cached canvas context for accurate text measurement. Falls back to a
// font-size-aware estimate when DOM is unavailable (i.e. under Node), so
// the MCP server's layout tracks the browser's reasonably closely even
// without a canvas.
const _measureCanvas = (typeof document !== "undefined") ? document.createElement("canvas") : null;
const _measureCtx = _measureCanvas ? _measureCanvas.getContext("2d") : null;
// Average advance width as a fraction of font-size for a proportional
// sans-serif (system-ui / Helvetica-like). Bold runs a touch wider.
const _AVG_ADVANCE = 0.52;
const _BOLD_ADVANCE = 0.56;
function _estimateTextPx(text, font) {
  const s = String(text);
  const m = /(\d+(?:\.\d+)?)px/.exec(font || "");
  const size = m ? parseFloat(m[1]) : 13;
  const bold = /\bbold\b|\b[6-9]00\b/.test(font || "");
  return s.length * size * (bold ? _BOLD_ADVANCE : _AVG_ADVANCE);
}
function measureTextPx(text, font) {
  if (!_measureCtx) return _estimateTextPx(text, font);
  _measureCtx.font = font;
  return _measureCtx.measureText(String(text)).width;
}
const ARROW_LABEL_FONT = 'italic 11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const LANE_CAPTION_FONT = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

function boxHeightFor(text) {
  const L = LAYOUT;
  const lines = wrap(text || "", L.CHAR_BUDGET);
  return Math.max(L.BOX_MIN_H, lines.length * L.TEXT_LINE_H + L.BOX_PAD_V * 2);
}

// Box dimensions in the SOLVER's horizontal frame. In horizontal mode
// these are the visual dimensions; in vertical mode they're swapped so
// that after the renderer's transposition the box appears LANDSCAPE
// (BOX_W along the lane direction, text-driven height across time).
function boxDimsFor(text, orientation) {
  const L = LAYOUT;
  const textH = boxHeightFor(text);
  if (orientation === "vertical") {
    return { w: textH, h: L.BOX_W };
  }
  return { w: L.BOX_W, h: textH };
}

function solveLayout(model) {
  const L = LAYOUT;

  // Compute an effective caption strip extent.
  // In HORIZONTAL mode this is the WIDTH of the left caption strip,
  // driven by the longest lane name's rendered width.
  // In VERTICAL mode (after the renderer's transposition) the captionW
  // becomes the HEIGHT of the TOP caption strip, so it should be sized
  // by the number of wrapped caption lines, not by raw name width
  // (names wrap to fit lane width in vertical mode).
  const CAPTION_LEFT_PAD = 18;
  const CAPTION_RIGHT_PAD = 18;
  const CAPTION_LINE_H = 16;
  let captionW;
  if (model.orientation === "vertical") {
    const laneH = laneHeightFor(model);
    const maxLineWidthPx = Math.max(40, laneH - 24);
    let maxLines = 1;
    for (const lane of model.lanes) {
      let count = 0;
      for (const raw of String(lane).split("\n")) {
        const words = raw.split(/\s+/).filter(Boolean);
        if (!words.length) { count++; continue; }
        let cur = "";
        for (const w of words) {
          const candidate = cur ? cur + " " + w : w;
          if (cur && measureTextPx(candidate, LANE_CAPTION_FONT) > maxLineWidthPx) {
            count++;
            cur = w;
          } else {
            cur = candidate;
          }
        }
        if (cur) count++;
      }
      if (count > maxLines) maxLines = count;
    }
    // Slim top strip — only the space the wrapped caption lines need
    // plus a small breathing margin.
    captionW = maxLines * CAPTION_LINE_H + 14;
  } else {
    captionW = L.CAPTION_W;
    for (const lane of model.lanes) {
      for (const ln of String(lane).split("\n")) {
        const px = measureTextPx(ln, LANE_CAPTION_FONT) + CAPTION_LEFT_PAD + CAPTION_RIGHT_PAD;
        if (px > captionW) captionW = px;
      }
    }
  }
  model.captionW = captionW;

  const M = layoutMetrics(model);
  const laneIdx = new Map(model.lanes.map((l, i) => [l, i]));

  const placedBoxes = [];
  const boxByPos = new Map(); // "col,lane" → placedBoxes index
  // Track the lane ranges occupied by cross-lane arrows, keyed by column.
  // Used in Phase 1 to push boxes right when a new cross-lane arrow would
  // share a column with an existing one over an overlapping lane range
  // (except for true counter-pairs which we render side-by-side instead).
  const arrowsByCol = new Map(); // col → [{minLane, maxLane, fromI, toI}]
  function arrowConflictsAtCol(col, fromI, toI) {
    const existing = arrowsByCol.get(col);
    if (!existing) return false;
    const newMin = Math.min(fromI, toI);
    const newMax = Math.max(fromI, toI);
    for (const a of existing) {
      // Lane-range overlap is a proxy for Y-range overlap of the vertical
      // arrow segments at this column.
      if (a.minLane >= newMax || newMin >= a.maxLane) continue;
      // Counter-pair (A→B and B→A): rendered side-by-side, not a conflict.
      if (a.fromI === toI && a.toI === fromI) continue;
      return true;
    }
    return false;
  }
  function recordArrowAtCol(col, fromI, toI) {
    if (fromI === toI) return;
    if (!arrowsByCol.has(col)) arrowsByCol.set(col, []);
    arrowsByCol.get(col).push({
      minLane: Math.min(fromI, toI),
      maxLane: Math.max(fromI, toI),
      fromI, toI,
    });
  }

  function colLaneTaken(col, lane) {
    return boxByPos.has(`${col},${lane}`);
  }
  function getBoxAt(col, lane) {
    const id = boxByPos.get(`${col},${lane}`);
    return id !== undefined ? placedBoxes[id] : null;
  }

  // ----- Phase 1: assign each statement to a column -----
  //
  // Statements form chains. A chain continues as long as the previous
  // statement's DESTINATION matches the current statement's SOURCE — i.e.,
  // the previous receiver passes control to the next sender. Chained
  // statements share a column so their boxes sit one directly below
  // the next, connected by a vertical arrow.
  //
  // When the chain breaks (or after a note), a new column starts.
  //
  // Exception: when the chain would CONTINUE but the new message also
  // flips back (current source = prev destination AND current
  // destination = prev source — i.e., A -> B then B -> A), the chain
  // is BROKEN by default so B's reply box lands in a new column rather
  // than routing back to A's originating box. The `>->` / `>-->` arrow
  // syntax opts back into the old shared-column counter-pair rendering.
  let lastStmtCol = -1;
  let prevDestI = -1;
  let prevSrcI = -1;

  for (const ev of model.events) {
    if (ev.type === "note") {
      const tH = boxHeightFor(ev.text);
      const dims = boxDimsFor(ev.text, model.orientation);
      const maxCol = placedBoxes.reduce((m, p) => Math.max(m, p.col), -1);
      ev.col = maxCol + 1;
      ev.boxH = dims.h;
      ev.arrowPath = null;
      ev.selfLoop = false;
      if (ev.lanes && ev.lanes.length > 0) {
        const indices = ev.lanes.map(l => laneIdx.get(l)).filter(i => i !== undefined);
        if (indices.length === 1) {
          const id = placedBoxes.length;
          placedBoxes.push({ col: ev.col, lane: indices[0], h: tH, type: "note" });
          boxByPos.set(`${ev.col},${indices[0]}`, id);
        } else if (indices.length > 1) {
          indices.sort((a, b) => a - b);
          const top = M.laneY(indices[0]) + 10;
          const bottom = M.laneY(indices[indices.length - 1]) + L.LANE_H - 10;
          const id = placedBoxes.length;
          placedBoxes.push({
            col: ev.col, type: "note", lanes: indices, h: bottom - top,
            rect: {
              left: M.colX(ev.col) - L.BOX_W / 2,
              right: M.colX(ev.col) + L.BOX_W / 2,
              top, bottom,
            },
          });
          indices.forEach(li => boxByPos.set(`${ev.col},${li}`, id));
        }
      }
      lastStmtCol = ev.col;
      prevDestI = -1; // notes break any chain
      prevSrcI = -1;
      continue;
    }
    if (ev.type !== "message") continue;

    const fromI = laneIdx.get(ev.from);
    const toI = laneIdx.get(ev.to);
    if (fromI === undefined || toI === undefined) continue;
    const tH = boxHeightFor(ev.text);
    const dims = boxDimsFor(ev.text, model.orientation);

    // Standalone (non-directed) boxes have no arrows of their own, but
    // they DO honour the chain rule for column placement so the previous
    // event's outgoing arrow can land on them. When the previous event
    // sent control to this lane (prevDestI === fromI), the standalone box
    // takes the same column so the cross-lane arrow terminates on it.
    // Otherwise it goes to the next free column.
    if (ev.standalone) {
      let myCol;
      if (prevDestI === fromI && lastStmtCol >= 0) {
        myCol = lastStmtCol;
      } else {
        myCol = lastStmtCol + 1;
      }
      while (colLaneTaken(myCol, fromI)) myCol++;
      ev.col = myCol;
      ev.boxH = dims.h;
      ev.boxW = dims.w;
      ev.selfLoop = false;
      const id = placedBoxes.length;
      placedBoxes.push({ col: myCol, lane: fromI, w: dims.w, h: dims.h, type: "message" });
      boxByPos.set(`${myCol},${fromI}`, id);
      lastStmtCol = myCol;
      prevDestI = -1;
      prevSrcI = -1;
      continue;
    }

    let myCol;
    // A counter-back is the case where the new message exactly reverses
    // the previous one (A -> B then B -> A). By default we BREAK the
    // chain there so the reply isn't routed back to the originating
    // sender's box. The `>->` syntax sets ev.counter and opts back into
    // the shared-column counter-pair rendering.
    const isCounterBack = (prevSrcI !== -1 && prevSrcI === toI && prevDestI === fromI);
    const chainBreakForCounter = isCounterBack && !ev.counter;
    if (prevDestI === fromI && lastStmtCol >= 0 && !chainBreakForCounter) {
      myCol = lastStmtCol; // chain continues in the same column
    } else {
      myCol = lastStmtCol + 1; // new chain starts a new column
    }
    // Move right past columns where this box can't be placed:
    //   * the (col, lane) slot is already taken, or
    //   * a cross-lane arrow would pass through a box in an intermediate
    //     lane, or
    //   * a cross-lane arrow would visually overlap an existing arrow at
    //     this column (excluding true counter-pairs A→B / B→A).
    while (true) {
      if (colLaneTaken(myCol, fromI)) { myCol++; continue; }
      if (fromI !== toI) {
        const minLane = Math.min(fromI, toI);
        const maxLane = Math.max(fromI, toI);
        let blocked = false;
        for (let li = minLane + 1; li < maxLane; li++) {
          if (getBoxAt(myCol, li)) { blocked = true; break; }
        }
        if (blocked) { myCol++; continue; }
        if (arrowConflictsAtCol(myCol, fromI, toI)) { myCol++; continue; }
      }
      break;
    }

    ev.col = myCol;
    ev.boxH = dims.h;
    ev.boxW = dims.w;
    // Self-loops are no longer produced by any syntax; the <-> form now
    // means "bidirectional same-lane links" (forward + backward).
    ev.selfLoop = false;

    const id = placedBoxes.length;
    placedBoxes.push({ col: myCol, lane: fromI, w: dims.w, h: dims.h, type: "message" });
    boxByPos.set(`${myCol},${fromI}`, id);
    recordArrowAtCol(myCol, fromI, toI);

    lastStmtCol = myCol;
    prevDestI = toI;
    prevSrcI = fromI;
  }

  // ----- Phase 1.5: extend inter-column gaps for long horizontal captions -----
  //
  // Same-lane forward links draw a horizontal arrow in the gap between
  // the source box and the next same-lane box. The default gap is
  // COL_W - BOX_W = 40px, which is too narrow for captions wider than
  // a handful of characters. Here we wrap each such caption at
  // HLABEL_MAX_CHARS and, if the longest wrapped line wouldn't fit in
  // the default gap, attribute the extra width to colRightMargin[col]
  // so subsequent columns shift right. Each unit of right margin
  // widens the local gap by exactly the same amount.
  const colRightMargin = [];
  const maxColPlaced = placedBoxes.reduce((m, b) => Math.max(m, b.col), -1);
  for (const ev of model.events) {
    if (ev.type !== "message" || !ev.arrowLabel) continue;
    if (ev.from !== ev.to) continue;
    if (ev.standalone || ev.incomingOnly) continue;
    const fromI = laneIdx.get(ev.from);
    if (fromI === undefined) continue;

    // Find the next box in this lane (any type).
    let nextCol = null;
    for (const p of placedBoxes) {
      if (p.col <= ev.col) continue;
      if (p.lane === fromI || (p.lanes && p.lanes.includes(fromI))) {
        if (nextCol === null || p.col < nextCol) nextCol = p.col;
      }
    }
    const targetCol = nextCol !== null ? nextCol : (ev.col + 1);

    // Wrap the caption and find the widest line (canvas-measured).
    const lines = wrap(ev.arrowLabel, L.HLABEL_MAX_CHARS);
    let widest = 0;
    for (const ln of lines) {
      const px = measureTextPx(ln, ARROW_LABEL_FONT);
      if (px > widest) widest = px;
    }
    const needed = widest + L.LABEL_H_PADDING;

    const colsApart = targetCol - ev.col;
    const effColW = colWidthFor(model);
    // In vertical mode the effective box "width" (along the col axis)
    // is the small text-driven boxH; in horizontal mode it's BOX_W.
    const effBoxAlong = (model.orientation === "vertical")
      ? boxHeightFor(ev.text)
      : L.BOX_W;
    const defaultGap = colsApart * effColW - effBoxAlong;
    if (needed > defaultGap) {
      const extra = needed - defaultGap;
      // Apply to ev.col's right margin. With this model, each unit of
      // right margin widens the gap by exactly one unit (boxes at
      // col ev.col stay put; cols after ev.col shift right by `extra`).
      colRightMargin[ev.col] = Math.max(colRightMargin[ev.col] || 0, extra);
    }
  }

  // Build colCenters. We compute one extra "virtual" column past the
  // last placed column so M.colX(maxColPlaced + 1) is defined — this
  // covers same-lane arrows that have no next box and need to extend
  // one column further right. The diagram's visual width
  // (model.totalColsW) only sums the *actual* placed columns; the
  // virtual column's space falls naturally into LANE_END_PAD.
  const colCenters = [];
  const totalCols = Math.max(maxColPlaced + 2, 1);
  const effColW = colWidthFor(model);
  let cursorX = L.PAD_L + captionW;
  let totalColsW = 0;
  for (let c = 0; c < totalCols; c++) {
    colCenters.push(cursorX + effColW / 2);
    const colSpan = effColW + (colRightMargin[c] || 0);
    cursorX += colSpan;
    if (c <= maxColPlaced) totalColsW += colSpan;
  }
  model.colCenters = colCenters;
  model.colRightMargin = colRightMargin;
  model.totalColsW = totalColsW;

  // ----- Phase 2: compute each statement's arrow -----
  //
  // Every message statement gets its OWN arrow that goes from its box
  // (in the source lane) to a point in the destination lane at the same
  // column. If a box happens to live at that column in the destination
  // lane, the arrow lands on that box's top/bottom edge; otherwise it
  // terminates at the destination lane's centre y.
  //
  // When two chained statements form a counter-pair at the same column
  // (A → B at col N, then B → A at col N), the two arrows would
  // overlap geometrically. We offset them ±10px so both stay visible:
  // down-arrows shift left, up-arrows shift right.
  for (let evIdx = 0; evIdx < model.events.length; evIdx++) {
    const ev = model.events[evIdx];
    if (ev.type !== "message") continue;
    const fromI = laneIdx.get(ev.from);
    const toI = laneIdx.get(ev.to);
    if (fromI === undefined || toI === undefined) {
      ev.arrowPath = null; ev.arrowPathIn = null; continue;
    }

    const myBox = getBoxAt(ev.col, fromI);
    if (!myBox) { ev.arrowPath = null; ev.arrowPathIn = null; continue; }

    ev.arrowPath = null;
    ev.arrowPathIn = null;
    ev.arrowFlow = false;

    // ----- Outgoing arrow (forward link) -----
    // Skipped for <: (incomingOnly) and Lane: text (standalone).
    if (!ev.incomingOnly && !ev.standalone) {
      if (fromI === toI) {
        // Same-lane forward link — BLUE trail to the next box in this
        // lane (message, standalone, or note). Stops the trail from
        // running through a later note's footprint.
        let nextBox = null;
        for (const p of placedBoxes) {
          if (p.col <= ev.col) continue;
          if (p.lane === fromI || (p.lanes && p.lanes.includes(fromI))) {
            if (!nextBox || p.col < nextBox.col) nextBox = p;
          }
        }
        const cy = M.laneCY(fromI);
        const myW = (typeof myBox.w === "number") ? myBox.w : L.BOX_W;
        const nextW = (nextBox && typeof nextBox.w === "number") ? nextBox.w : L.BOX_W;
        const aRight = M.colX(ev.col) + myW / 2;
        const bLeft = nextBox
          ? M.colX(nextBox.col) - nextW / 2
          : M.colX(ev.col + 1) - L.BOX_W / 2;
        if (aRight < bLeft) {
          ev.arrowPath = [{ x: aRight, y: cy }, { x: bLeft, y: cy }];
          ev.arrowFlow = true;
        }
      } else {
        // Cross-lane forward link — BLACK message arrow (vertical or elbow).
        const myCy = M.laneCY(fromI);
        const destCy = M.laneCY(toI);
        const goingDown = destCy > myCy;
        const colCx = M.colX(ev.col);

        const minLane = Math.min(fromI, toI);
        const maxLane = Math.max(fromI, toI);
        let blocked = false;
        for (let li = minLane + 1; li < maxLane; li++) {
          if (getBoxAt(ev.col, li)) { blocked = true; break; }
        }

        if (blocked) {
          const myW = (typeof myBox.w === "number") ? myBox.w : L.BOX_W;
          const sourceX = colCx + myW / 2;
          // Midpoint of the gap to the next column (handles variable
          // column spacing introduced for long horizontal captions).
          let elbowX = (M.colX(ev.col) + M.colX(ev.col + 1)) / 2;
          // If a counter-pair also routes around the same obstruction
          // it would collide on the same elbow x. Offset the verticals
          // by ±8 px in the inter-column gap, with the earlier event
          // taking the inner position.
          const counterEv = model.events.find(e =>
            e !== ev && e.type === "message" && e.col === ev.col &&
            laneIdx.get(e.from) === toI && laneIdx.get(e.to) === fromI
          );
          if (counterEv) {
            const isFirst = model.events.indexOf(ev) < model.events.indexOf(counterEv);
            elbowX += isFirst ? -8 : 8;
            ev.labelSide = isFirst ? "left" : "right";
          }
          ev.arrowPath = [
            { x: sourceX, y: myCy },
            { x: elbowX, y: myCy },
            { x: elbowX, y: destCy },
          ];
        } else {
          // Look for a destination box at this column. If none is there,
          // look ahead to the nearest later box in the destination lane —
          // a message, standalone, or note. Route to that box with a
          // Z-shape so the arrow lands on the actual "next thing" the
          // receiver does instead of hanging in empty space.
          let destBox = getBoxAt(ev.col, toI);
          let destCol = ev.col;
          if (!destBox) {
            for (const p of placedBoxes) {
              if (p.col <= ev.col) continue;
              if (p.lane === toI || (p.lanes && p.lanes.includes(toI))) {
                if (!destBox || p.col < destCol) {
                  destBox = p;
                  destCol = p.col;
                }
              }
            }
          }

          if (destBox && destCol > ev.col) {
            // Z-shape across columns: exit source top/bottom, vertical at
            // source column to the destination lane's centre, then
            // horizontal right into the destination box's LEFT edge.
            const sourceX = colCx;
            const sourceY = goingDown ? myCy + myBox.h / 2 : myCy - myBox.h / 2;
            const destW = (typeof destBox.w === "number") ? destBox.w : L.BOX_W;
            const destLeft = M.colX(destCol) - destW / 2;
            ev.arrowPath = [
              { x: sourceX, y: sourceY },
              { x: sourceX, y: destCy },
              { x: destLeft, y: destCy },
            ];
          } else {
            // Same column (or no destination box at all).
            let hasCounter = false;
            let counterEv = null;
            if (destBox && destBox.type === "message") {
              const found = model.events.find(e =>
                e.type === "message" && e.col === ev.col && laneIdx.get(e.from) === toI
              );
              if (found && laneIdx.get(found.to) === fromI) {
                hasCounter = true;
                counterEv = found;
              }
            }
            let isFirst = true;
            if (hasCounter && counterEv) {
              isFirst = model.events.indexOf(ev) < model.events.indexOf(counterEv);
            }
            const offset = hasCounter ? (isFirst ? -10 : 10) : 0;
            const x = colCx + offset;
            const sourceY = goingDown ? myCy + myBox.h / 2 : myCy - myBox.h / 2;
            const destY = destBox
              ? (goingDown ? destCy - destBox.h / 2 : destCy + destBox.h / 2)
              : destCy;
            ev.arrowPath = [
              { x, y: sourceY },
              { x, y: destY },
            ];
            if (hasCounter) ev.labelSide = isFirst ? "left" : "right";
          }
        }
      }
    }

    // ----- Incoming arrow (backward link) -----
    // Drawn for <-> and <: events: a horizontal arrow from the IMMEDIATE
    // predecessor box in this event's source lane. The predecessor is
    // any earlier box that lives in this lane — message, standalone, or
    // backward-only — picked by greatest column < ev.col. Dedupes when
    // the previous event already owns a same-lane forward link that
    // already lands on this box.
    if ((ev.bidirectional || ev.incomingOnly) && !ev.standalone) {
      let prevBox = null, prevEv = null;
      for (let j = evIdx - 1; j >= 0; j--) {
        const e = model.events[j];
        if (e.type !== "message") continue;
        if (laneIdx.get(e.from) !== fromI) continue;
        if (typeof e.col !== "number" || e.col >= ev.col) continue;
        const b = getBoxAt(e.col, fromI);
        if (b) { prevBox = b; prevEv = e; break; }
      }
      if (prevBox && prevEv) {
        const prevIsSameLane = laneIdx.get(prevEv.from) === laneIdx.get(prevEv.to);
        const prevHasOut = prevIsSameLane && !prevEv.incomingOnly && !prevEv.standalone;
        if (!prevHasOut) {
          const cy = M.laneCY(fromI);
          const prevW = (typeof prevBox.w === "number") ? prevBox.w : L.BOX_W;
          const myW = (typeof myBox.w === "number") ? myBox.w : L.BOX_W;
          const aRight = M.colX(prevBox.col) + prevW / 2;
          const bLeft = M.colX(ev.col) - myW / 2;
          if (aRight < bLeft) {
            ev.arrowPathIn = [{ x: aRight, y: cy }, { x: bLeft, y: cy }];
          }
        }
      }
    }
  }

  // Within-lane blue connectors are now driven by A -> A statements
  // (Phase 2 above sets ev.arrowFlow = true on them). There are no
  // automatically-generated blue arrows.
  model.flowArrows = [];

  // Map section event-index references to column references for the renderer.
  for (const s of model.sections) {
    const startEv = model.events[s.start];
    const endEv = model.events[s.end];
    s.startCol = startEv ? startEv.col : 0;
    s.endCol = endEv ? endEv.col : 0;
  }
}

// ---------- renderer ----------
//
// Layout model:
//   * Each `A -> B: text` message becomes a labelled activity box in lane B
//     at the message's column. An arrow connects from the previous box in
//     lane A (or from A's lane start, if none) to this new box.
//   * `A -> A: text` (self-message) draws a small loop arrow on top of the
//     box in addition to any chaining arrow.
//   * Arrows are either: (a) straight horizontal (same lane); (b) elbowed
//     L-shape: right → vertical → right (different lanes); (c) loop on a
//     box (self-message). All segments are vertical or left-to-right.
//   * Notes render as yellow boxes (single lane or spanning multiple lanes).
//   * Sections render as labelled banners above the lanes.

function render(model) {
  const L = LAYOUT;
  const numLanes = model.lanes.length;
  const hasSections = model.sections.length > 0;

  // Number of columns is derived from the maximum solved column.
  let maxCol = -1;
  for (const ev of model.events) {
    if (typeof ev.col === "number" && ev.col > maxCol) maxCol = ev.col;
  }
  const numCols = Math.max(maxCol + 1, 1);

  const PAD_R = 32;
  const PAD_B = 28;
  const TITLE_H = model.title ? L.TITLE_H_WHEN_PRESENT : 0;
  const SECTION_H = hasSections ? L.SECTION_H_WHEN_PRESENT : 0;
  const TOP_OF_LANES = L.PAD_T_TOP + TITLE_H + SECTION_H;

  // Cumulative width of the column band. Uses the solver-precomputed
  // model.totalColsW (which accounts for per-column right margins) when
  // available, otherwise falls back to uniform spacing.
  const captionW = (typeof model.captionW === "number") ? model.captionW : L.CAPTION_W;
  const colsBandW = (typeof model.totalColsW === "number")
    ? model.totalColsW
    : numCols * L.COL_W;
  const totalW = Math.ceil(L.PAD_L + captionW + colsBandW + L.LANE_END_PAD + PAD_R);
  const laneH = laneHeightFor(model);
  const totalH = Math.ceil(TOP_OF_LANES + numLanes * laneH + (numLanes - 1) * L.LANE_GAP + PAD_B);

  const laneIdx = new Map();
  model.lanes.forEach((l, i) => laneIdx.set(l, i));

  const laneY = i => TOP_OF_LANES + i * (laneH + L.LANE_GAP);
  const laneCY = i => laneY(i) + laneH / 2;
  const colX = c => {
    const cc = model.colCenters;
    if (cc && c < cc.length) return cc[c];
    if (cc && cc.length > 0) {
      const last = cc.length - 1;
      return cc[last] + (c - last) * L.COL_W;
    }
    return L.PAD_L + captionW + c * L.COL_W + L.COL_W / 2;
  };

  // Vertical orientation: transpose the diagram so (x, y) becomes (y, x).
  // This makes the original lane axis (y) the new horizontal axis (lanes
  // become columns running left-to-right in declaration order), and the
  // original col axis (x) becomes the new vertical axis (time runs
  // top-to-bottom). Each <text> element gets a matching local
  // transposition around its anchor so labels render horizontally.
  const isVertical = model.orientation === "vertical";
  // In vertical orientation we render the title OUTSIDE the
  // transposition group so it appears at the TOP centre of the final
  // SVG (rather than rotated onto the left edge). The transposed
  // content is pushed DOWN by vertTopOffset to make room for the
  // title strip.
  const vertTopOffset = isVertical ? TITLE_H : 0;
  const svgW = isVertical ? totalH : totalW;
  const svgH = isVertical ? totalW + vertTopOffset : totalH;
  const tx = (x, y) => isVertical
    ? ` transform="matrix(0 1 1 0 ${x - y} ${y - x})"`
    : "";

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">`);

  parts.push(`<defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10.5" markerHeight="10.5" markerUnits="userSpaceOnUse" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/>
    </marker>
    <marker id="ah-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10.5" markerHeight="10.5" markerUnits="userSpaceOnUse" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/>
    </marker>
  </defs>`);

  if (model.title && isVertical) {
    // Render title OUTSIDE the transposition group, at the top centre
    // of the final vertical SVG.
    const titleX = svgW / 2;
    const titleY = L.PAD_T_TOP + 26;
    parts.push(`<text x="${titleX}" y="${titleY}" text-anchor="middle" font-size="18" font-weight="600" fill="#111827">${escXml(model.title)}</text>`);
  }

  if (isVertical) {
    // Transpose: (x, y) → (y, x). Lane 0 (declared first) ends up on
    // the LEFT in the final SVG and time runs top-to-bottom.
    // Then translate down by vertTopOffset so the transposed content
    // sits below the title strip.
    parts.push(`<g transform="translate(0 ${vertTopOffset}) matrix(0 1 1 0 0 0)">`);
  }

  if (model.title && !isVertical) {
    const titleX = totalW / 2;
    const titleY = L.PAD_T_TOP + 26;
    parts.push(`<text x="${titleX}" y="${titleY}" text-anchor="middle" font-size="18" font-weight="600" fill="#111827">${escXml(model.title)}</text>`);
  }

  if (hasSections) {
    const bannerY = TOP_OF_LANES - SECTION_H + 6;
    for (const s of model.sections) {
      const sc = typeof s.startCol === "number" ? s.startCol : s.start;
      const ec = typeof s.endCol === "number" ? s.endCol : s.end;
      if (sc > ec) continue;
      const x1 = colX(sc) - L.COL_W / 2 + 4;
      const x2 = colX(ec) + L.COL_W / 2 - 4;
      const w = x2 - x1;
      const labelX = (x1 + x2) / 2;
      const labelY = bannerY + 15;
      const sLine = (typeof s.lineNo === "number") ? ` data-line="${s.lineNo}"` : "";
      parts.push(`<rect x="${x1}" y="${bannerY}" width="${w}" height="22" rx="6" ry="6" fill="#eff6ff" stroke="#bfdbfe"${sLine}/>`);
      parts.push(`<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="600" fill="#1d4ed8"${tx(labelX, labelY)}${sLine}>${escXml(s.label)}</text>`);
      parts.push(`<line x1="${x1}" y1="${TOP_OF_LANES - 2}" x2="${x1}" y2="${totalH - PAD_B + 4}" stroke="#dbeafe" stroke-dasharray="3 4" stroke-width="1"/>`);
      parts.push(`<line x1="${x2}" y1="${TOP_OF_LANES - 2}" x2="${x2}" y2="${totalH - PAD_B + 4}" stroke="#dbeafe" stroke-dasharray="3 4" stroke-width="1"/>`);
    }
  }

  // Lane frames span the full lane area (caption + box columns). In
  // horizontal orientation the lane caption is rendered as left-aligned
  // text inside the frame, before the first box. In vertical
  // orientation we render the caption later (after closing the
  // transposition group) so we can centre and wrap it cleanly in the
  // final coordinate system.
  model.lanes.forEach((lane, i) => {
    const y = laneY(i);
    const frameX = L.PAD_L;
    const frameW = captionW + colsBandW + L.LANE_END_PAD;
    parts.push(`<rect x="${frameX}" y="${y}" width="${frameW}" height="${laneH}" rx="10" ry="10" fill="#fafbfc" stroke="#d6dae0" stroke-width="1.25"/>`);

    if (!isVertical) {
      const capLines = lane.split("\n");
      const cy = y + laneH / 2;
      const capLineH = 16;
      const startY = cy - ((capLines.length - 1) * capLineH) / 2;
      capLines.forEach((ln, k) => {
        const lx = L.PAD_L + 18;
        const ly = startY + k * capLineH;
        parts.push(`<text x="${lx}" y="${ly}" text-anchor="start" dominant-baseline="middle" fill="#1f2937" font-size="14" font-weight="600">${escXml(ln)}</text>`);
      });
    }
  });

  // Build the visual model from the solver's output. Each event has its
  // resolved col + boxH and (for messages) the arrow segments.
  const boxes = [];
  const floatingNotes = [];
  let firstActivityMarked = false;

  model.events.forEach(ev => {
    if (ev.type === "message") {
      // Activity box sits in the SOURCE (sender) lane.
      const fromI = laneIdx.get(ev.from);
      if (fromI === undefined) return;
      const lines = wrap(ev.text || "", L.CHAR_BUDGET);
      const h = ev.boxH || boxHeightFor(ev.text);
      const w = ev.boxW || L.BOX_W;
      const toI = laneIdx.get(ev.to);
      const labelCenterY = (toI !== undefined && toI !== fromI)
        ? (laneCY(fromI) + laneCY(toI)) / 2
        : null;
      boxes.push({
        col: ev.col,
        cx: colX(ev.col),
        cy: laneCY(fromI),
        w,
        h,
        lines,
        type: "activity",
        isFirst: !firstActivityMarked,
        dashed: ev.dashed,
        selfLoop: ev.selfLoop,
        arrowPath: ev.arrowPath || null,
        arrowFlow: !!ev.arrowFlow,
        arrowPathIn: ev.arrowPathIn || null,
        arrowLabel: ev.arrowLabel || null,
        labelSide: ev.labelSide || null,
        arrowLabelCenterY: labelCenterY,
        lineNo: ev.lineNo,
      });
      firstActivityMarked = true;
    } else if (ev.type === "note") {
      const lines = wrap(ev.text || "", L.CHAR_BUDGET);
      if (!ev.lanes || ev.lanes.length === 0) {
        floatingNotes.push({ cx: colX(ev.col), lines });
        return;
      }
      const indices = ev.lanes.map(l => laneIdx.get(l)).filter(i => i !== undefined).sort((a, b) => a - b);
      if (!indices.length) return;
      const top = laneY(indices[0]) + 10;
      const bottom = laneY(indices[indices.length - 1]) + laneH - 10;
      boxes.push({
        col: ev.col,
        cx: colX(ev.col),
        cy: (top + bottom) / 2,
        w: L.BOX_W,
        h: bottom - top,
        lines,
        type: "note",
        lineNo: ev.lineNo,
      });
    }
  });

  // Floating notes above the lane area
  floatingNotes.forEach(fn => {
    const w = L.BOX_W;
    const h = Math.max(24, fn.lines.length * L.TEXT_LINE_H + 10);
    const cy = Math.max(L.PAD_T_TOP + TITLE_H + h / 2, 8 + h / 2);
    parts.push(`<rect x="${fn.cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="4" fill="#fef3c7" stroke="#f59e0b"/>`);
    const startDy = -(fn.lines.length - 1) * L.TEXT_LINE_H / 2;
    const tspans = fn.lines.map((ln, i) => `<tspan x="${fn.cx}" dy="${i === 0 ? startDy : L.TEXT_LINE_H}">${escXml(ln)}</tspan>`).join("");
    parts.push(`<text x="${fn.cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#78350f"${tx(fn.cx, cy)}>${tspans}</text>`);
  });

  // Helper: emit a data-line attribute when lineNo is set, so the
  // shape can be matched up with its statement in the source pane.
  const dl = ln => (typeof ln === "number") ? ` data-line="${ln}"` : "";

  // Render arrow segments precomputed by the solver, then self-loops, all
  // behind the box rectangles so the boxes draw on top.
  // Blue within-lane flow arrows (drawn behind boxes and message arrows).
  if (model.flowArrows && model.flowArrows.length) {
    for (const fa of model.flowArrows) {
      if (!fa.path || fa.path.length < 2) continue;
      const d = polylineToPath(fa.path);
      parts.push(`<path d="${d}" fill="none" stroke="#374151" stroke-width="1.5" marker-end="url(#ah)"/>`);
    }
  }

  boxes.forEach(box => {
    if (box.type !== "activity") return;
    const dash = box.dashed ? ' stroke-dasharray="6 4"' : "";
    const ln = dl(box.lineNo);
    if (box.arrowPath && box.arrowPath.length >= 2) {
      const d = polylineToPath(box.arrowPath);
      parts.push(`<path d="${d}" fill="none" stroke="#374151" stroke-width="1.5" marker-end="url(#ah)"${dash}${ln}/>`);
    }
    if (box.arrowPathIn && box.arrowPathIn.length >= 2) {
      const d = polylineToPath(box.arrowPathIn);
      parts.push(`<path d="${d}" fill="none" stroke="#374151" stroke-width="1.5" marker-end="url(#ah)"${ln}/>`);
    }
    if (box.arrowLabel) {
      // The caption attaches to the FORWARD arrow when one exists (-> and
      // <->). When only an incoming arrow exists (the <: form), the
      // caption goes on it instead.
      if (box.arrowPath) {
        parts.push(arrowLabelSvg(box.arrowPath, box.arrowLabel, box.labelSide, box.arrowLabelCenterY, isVertical, box.lineNo));
      } else if (box.arrowPathIn) {
        parts.push(arrowLabelSvg(box.arrowPathIn, box.arrowLabel, null, null, isVertical, box.lineNo));
      }
    }
    if (box.selfLoop) {
      const x1 = box.cx - 16;
      const x2 = box.cx + 16;
      const yTop = box.cy - box.h / 2;
      const yArc = yTop - L.SELF_LOOP_HEIGHT;
      const d = polylineToPath([
        { x: x1, y: yTop },
        { x: x1, y: yArc },
        { x: x2, y: yArc },
        { x: x2, y: yTop },
      ]);
      parts.push(`<path d="${d}" fill="none" stroke="#374151" stroke-width="1.5" marker-end="url(#ah)"${dash}${ln}/>`);
    }
  });

  // Render the boxes in front of the arrows. In vertical mode the box
  // dimensions stored on each box already account for the transposition
  // (w and h are swapped relative to the desired landscape final
  // appearance), so the rendered rect naturally lands at the right
  // position with the right edges for arrows to dock onto.
  boxes.forEach(box => {
    const x = box.cx - box.w / 2;
    const y = box.cy - box.h / 2;
    const ln = dl(box.lineNo);
    if (box.type === "activity") {
      const strokeWidth = box.isFirst ? 2.5 : 1.25;
      parts.push(`<rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" rx="6" ry="6" fill="#dbeafe" stroke="#3b82f6" stroke-width="${strokeWidth}"${ln}/>`);
    } else if (box.type === "note") {
      parts.push(`<rect x="${x}" y="${y}" width="${box.w}" height="${box.h}" rx="6" ry="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.1"${ln}/>`);
    }
    const startDy = -(box.lines.length - 1) * L.TEXT_LINE_H / 2;
    const tspans = box.lines.map((ln2, i) => `<tspan x="${box.cx}" dy="${i === 0 ? startDy : L.TEXT_LINE_H}">${escXml(ln2)}</tspan>`).join("");
    const fill = box.type === "note" ? "#78350f" : "#1e3a8a";
    parts.push(`<text x="${box.cx}" y="${box.cy}" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="${fill}" font-weight="500"${tx(box.cx, box.cy)}${ln}>${tspans}</text>`);
  });

  if (isVertical) {
    parts.push(`</g>`);
    // Lane captions in vertical mode are rendered OUTSIDE the
    // transposition group so we can use native SVG positioning:
    // centred above each lane column with proper word wrap.
    // The lane's final centre x is the same value as the lane's
    // centre y in the horizontal frame (because the parent transform
    // swaps x and y).
    const captionStripFinalCenterY = vertTopOffset + L.PAD_L + captionW / 2;
    const captionFontSize = 14;
    const capLineH = 16;
    const maxLineWidthPx = Math.max(40, laneH - 24);
    model.lanes.forEach((lane, i) => {
      const colCenterFinalX = laneCY(i);
      // Wrap each line of the lane name to fit the column width.
      const rawLines = String(lane).split("\n");
      const wrapped = [];
      for (const raw of rawLines) {
        const words = raw.split(/\s+/).filter(Boolean);
        if (words.length === 0) { wrapped.push(""); continue; }
        let cur = "";
        for (const w of words) {
          const candidate = cur ? cur + " " + w : w;
          if (cur && measureTextPx(candidate, LANE_CAPTION_FONT) > maxLineWidthPx) {
            wrapped.push(cur);
            cur = w;
          } else {
            cur = candidate;
          }
        }
        if (cur) wrapped.push(cur);
      }
      const startY = captionStripFinalCenterY - ((wrapped.length - 1) * capLineH) / 2;
      wrapped.forEach((ln, k) => {
        const y = startY + k * capLineH;
        parts.push(`<text x="${colCenterFinalX}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="#1f2937" font-size="${captionFontSize}" font-weight="600">${escXml(ln)}</text>`);
      });
    });
  }
  parts.push(`</svg>`);
  return parts.join("");
}

// Convert a list of solver-emitted segments (each {type:'h',x1,x2,y} or
// {type:'v',x,y1,y2}) into a single SVG path string. The first segment
// gets a moveto; subsequent segments are joined as line-tos.
function segmentsToPath(segs) {
  if (!segs || segs.length === 0) return "";
  const first = segs[0];
  const start = first.type === "h"
    ? { x: first.x1, y: first.y }
    : { x: first.x, y: first.y1 };
  const parts = [`M ${start.x} ${start.y}`];
  let cur = start;
  // For each segment we step from `cur` to the segment's far end. Because
  // segments are emitted in path order from the solver, the far end is
  // whichever endpoint is not equal to `cur`.
  for (const s of segs) {
    let nx, ny;
    if (s.type === "h") {
      const a = { x: s.x1, y: s.y };
      const b = { x: s.x2, y: s.y };
      ({ x: nx, y: ny } = (Math.abs(a.x - cur.x) + Math.abs(a.y - cur.y) < 0.5) ? b : a);
    } else {
      const a = { x: s.x, y: s.y1 };
      const b = { x: s.x, y: s.y2 };
      ({ x: nx, y: ny } = (Math.abs(a.x - cur.x) + Math.abs(a.y - cur.y) < 0.5) ? b : a);
    }
    parts.push(`L ${nx} ${ny}`);
    cur = { x: nx, y: ny };
  }
  return parts.join(" ");
}

// Convert a polyline (array of {x,y}) to an SVG path string with rounded
// corners at every interior point. The corner radius is automatically
// clamped to half the length of the shorter adjacent segment so corners
// never overshoot. Two-point paths return a plain straight line.
function polylineToPath(points, radius = 8) {
  if (!points || points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const d1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const d2 = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }
    const t1 = r / d1;
    const t2 = r / d2;
    const p1x = curr.x + (prev.x - curr.x) * t1;
    const p1y = curr.y + (prev.y - curr.y) * t1;
    const p2x = curr.x + (next.x - curr.x) * t2;
    const p2y = curr.y + (next.y - curr.y) * t2;
    d += ` L ${p1x} ${p1y} Q ${curr.x} ${curr.y} ${p2x} ${p2y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

// Render an italic caption tied to an arrow. Horizontal arrows get the
// label centred above the longest segment; vertical arrows get the label
// to the side of the longest segment (right by default, or left/right
// when explicitly forced — used when a box has both an outgoing and an
// incoming arrow that would otherwise overlap).
function arrowLabelSvg(arrowPath, label, side, centerY, isVertical, lineNo) {
  if (!label || !arrowPath || arrowPath.length < 2) return "";
  let bestI = 0, bestLen = 0;
  for (let i = 0; i < arrowPath.length - 1; i++) {
    const p1 = arrowPath[i], p2 = arrowPath[i + 1];
    const len = Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y);
    if (len > bestLen) { bestLen = len; bestI = i; }
  }
  const p1 = arrowPath[bestI], p2 = arrowPath[bestI + 1];
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const isHorizontal = Math.abs(p1.y - p2.y) < 0.5;

  const fontSize = 11;
  const lineH = 13;
  const maxChars = isHorizontal ? LAYOUT.HLABEL_MAX_CHARS : LAYOUT.VLABEL_MAX_CHARS;
  const lines = wrap(label, maxChars);

  let x, y, anchor, baseline;
  // For "above the arrow" placement we move the anchor BACK along the
  // text's perpendicular axis by enough that the bottom of a single
  // line of caption text still clears the line. We use a slightly
  // larger gap for multi-line labels.
  const aboveGap = 6;
  if (isVertical) {
    // After the diagram's transposition, a horizontal segment in the
    // solver frame is a VERTICAL arrow in the final SVG, and vice
    // versa. We pick label positioning so the caption ends up
    // centred and CLEAR of the visual arrow line.
    if (isHorizontal) {
      // Final: vertical arrow. Place label to the side in final
      // (= above/below the horizontal segment in solver frame).
      const useSide = side || "right";
      x = midX;
      y = useSide === "left" ? midY + 8 : midY - 8;
      anchor = "middle";
      baseline = useSide === "left" ? "hanging" : "auto";
    } else {
      // Final: horizontal arrow. Centre the label horizontally on
      // the arrow midpoint, with its baseline a few pixels ABOVE the
      // arrow line so the line doesn't strike through the text.
      // In solver coords this means anchoring at (midX - aboveGap,
      // midY): solver x maps to final y, so a smaller solver x is
      // higher up in the final SVG.
      x = midX - aboveGap;
      y = (typeof centerY === "number") ? centerY : midY;
      anchor = "middle";
      baseline = "auto";
    }
  } else if (isHorizontal) {
    x = midX;
    y = midY - 6;
    anchor = "middle";
    baseline = "auto";
  } else {
    const useSide = side || "right";
    if (useSide === "left") {
      x = midX - 8;
      anchor = "end";
    } else {
      x = midX + 8;
      anchor = "start";
    }
    // Prefer the caller's centerY (midpoint between source and destination
    // box centres) so labels are exactly between the boxes regardless of
    // box height differences. Fall back to the arrow segment's geometric
    // midpoint when no centerY is supplied.
    y = (typeof centerY === "number") ? centerY : midY;
    baseline = "middle";
  }

  // Stack lines upward (last line at the baseline) when the label sits
  // ABOVE the arrow line so the bottom of the text clears the arrow,
  // otherwise centre the lines symmetrically around the anchor.
  const aboveArrow = isHorizontal || (isVertical && !isHorizontal);
  const startDy = aboveArrow
    ? -(lines.length - 1) * lineH
    : -(lines.length - 1) * lineH / 2;
  const tspans = lines.map((ln, i) => {
    const dy = i === 0 ? startDy : lineH;
    return `<tspan x="${x}" dy="${dy}">${escXml(ln)}</tspan>`;
  }).join("");
  // Match the diagram's parent transposition with a local counter-
  // transposition around the text's anchor so the label reads normally.
  const xform = isVertical ? ` transform="matrix(0 1 1 0 ${x - y} ${y - x})"` : "";
  const lineAttr = (typeof lineNo === "number") ? ` data-line="${lineNo}"` : "";
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-size="${fontSize}" fill="#475569" font-style="italic"${xform}${lineAttr}>${tspans}</text>`;
}

function wrap(text, maxChars) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    if (!para) { lines.push(""); continue; }
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      // Chop overlong words first so a single token can't overrun the
      // available width. Each chopped chunk goes on its own line; the
      // tail (which is now <= maxChars) falls through to the regular
      // word-fits-or-starts-a-new-line path below.
      let w = word;
      while (w.length > maxChars) {
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      if (!w) continue;
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [""];
}

// ---------- ASCII renderer ----------
//
// renderAscii(model) draws the diagram onto a fixed character grid and
// returns a plain-text string. It works off the LOGICAL model from
// parse() (lanes + positioned events, each owning one column) rather than
// the pixel layout from solveLayout(), so it does not need to be solved
// first and every glyph snaps to an integer grid cell — connectors line
// up exactly. ASCII output is always laid out horizontally (lanes stacked
// top-to-bottom, time flowing left-to-right) regardless of model
// orientation.
//
// Line cells are tracked as a bitmask (Up|Down|Left|Right) so that
// crossings and box/arrow junctions resolve to the correct box-drawing
// glyph automatically. Text and arrowheads are written to a separate
// glyph layer that wins over the line layer.
function renderAscii(model) {
  const lanes = model.lanes || [];
  if (!lanes.length) return "(empty diagram)\n";

  const laneIdx = new Map(lanes.map((l, i) => [l, i]));
  const WRAP = 14;       // label wrap width (chars)
  const PADX = 1;        // horizontal padding inside a box
  const COL_GAP = 3;     // blank columns between boxes (room for "─►")
  const BAND_GAP = 2;    // blank rows between lanes (room for arrowheads)
  const U = 1, D = 2, L = 4, R = 8;
  const BITCH = {
    1: "│", 2: "│", 3: "│", 4: "─", 8: "─", 12: "─",
    9: "└", 5: "┘", 10: "┌", 6: "┐",
    11: "├", 7: "┤", 14: "┬", 13: "┴", 15: "┼",
  };

  const evs = (model.events || []).filter(e => e.type === "message" || e.type === "note");
  if (!evs.length) {
    // Lanes but no events: just list the lane names.
    return lanes.join("\n") + "\n";
  }

  // --- per-event box geometry ---
  // Notes carry a "note" tag line, so they need one extra content row and
  // their width must also fit the tag.
  for (const ev of evs) {
    const lines = wrap(ev.text || "", WRAP);
    const tagRows = ev.type === "note" ? 1 : 0;
    const innerW = Math.max(3, tagRows ? 4 : 0, ...lines.map(s => s.length));
    ev._box = { lines, innerW, w: innerW + 2 * PADX + 2, h: lines.length + tagRows + 2 };
  }

  const maxCol = evs.reduce((m, e) => Math.max(m, e.col), 0);
  const cols = maxCol + 1;
  const colW = new Array(cols).fill(6);
  for (const ev of evs) colW[ev.col] = Math.max(colW[ev.col], ev._box.w);

  // --- horizontal positions ---
  const gutterW = Math.max(4, ...lanes.map(l => l.length)) + 1;
  const colX = new Array(cols);
  let x = gutterW + 1;
  for (let c = 0; c < cols; c++) { colX[c] = x; x += colW[c] + COL_GAP; }
  const W = x;

  // --- band (lane) vertical positions ---
  const bandH = lanes.map(() => 3);
  for (const ev of evs) {
    const spanLanes = ev.type === "note" && ev.lanes && ev.lanes.length
      ? ev.lanes.map(l => laneIdx.get(l)).filter(i => i != null)
      : [laneIdx.get(ev.from)];
    if (spanLanes.length === 1 && spanLanes[0] != null) {
      bandH[spanLanes[0]] = Math.max(bandH[spanLanes[0]], ev._box.h);
    }
  }
  const sectionRows = (model.sections && model.sections.length) ? 2 : 0;
  const titleRows = model.title ? 2 : 0;
  const laneTop = [], laneBot = [];
  let y = sectionRows + titleRows;
  for (let i = 0; i < lanes.length; i++) {
    laneTop[i] = y;
    laneBot[i] = y + bandH[i] - 1;
    y = laneBot[i] + 1 + BAND_GAP;
  }
  const H = y;

  // --- grid layers ---
  const glyph = Array.from({ length: H }, () => new Array(W).fill(" "));
  const mask = Array.from({ length: H }, () => new Array(W).fill(0));
  const inb = (px, py) => px >= 0 && px < W && py >= 0 && py < H;
  const putGlyph = (px, py, ch) => { if (inb(px, py)) glyph[py][px] = ch; };
  const putText = (px, py, s) => { for (let k = 0; k < s.length; k++) putGlyph(px + k, py, s[k]); };
  const addMask = (px, py, bits) => { if (inb(px, py)) mask[py][px] |= bits; };

  function drawBox(bx, by, bw, bh, lines, opts = {}) {
    for (let i = 1; i < bw - 1; i++) { addMask(bx + i, by, L | R); addMask(bx + i, by + bh - 1, L | R); }
    for (let j = 1; j < bh - 1; j++) { addMask(bx, by + j, U | D); addMask(bx + bw - 1, by + j, U | D); }
    addMask(bx, by, D | R); addMask(bx + bw - 1, by, D | L);
    addMask(bx, by + bh - 1, U | R); addMask(bx + bw - 1, by + bh - 1, U | L);
    const startLine = opts.tag ? 1 : 0;
    if (opts.tag) putText(bx + 1 + PADX, by + 1, opts.tag);
    for (let li = 0; li < lines.length; li++) putText(bx + 1 + PADX, by + 1 + startLine + li, lines[li]);
  }

  const centerX = ev => colX[ev.col] + Math.floor(ev._box.w / 2);
  const boxTopRow = ev => laneTop[laneIdx.get(ev.from)];
  const boxBotRow = ev => laneTop[laneIdx.get(ev.from)] + ev._box.h - 1;
  const boxMidRow = ev => laneTop[laneIdx.get(ev.from)] + Math.floor(ev._box.h / 2);

  // Draw boxes first, then arrows on top (arrow junctions merge into box edges).
  for (const ev of evs) {
    if (ev.type === "note") {
      const li = (ev.lanes || []).map(l => laneIdx.get(l)).filter(i => i != null);
      if (li.length > 1) {
        const top = Math.min(...li), bot = Math.max(...li);
        drawBox(colX[ev.col], laneTop[top], ev._box.w, laneBot[bot] - laneTop[top] + 1, ev._box.lines, { tag: "note" });
      } else {
        const i = li.length ? li[0] : 0;
        drawBox(colX[ev.col], laneTop[i], ev._box.w, ev._box.h, ev._box.lines, { tag: "note" });
      }
      continue;
    }
    drawBox(colX[ev.col], boxTopRow(ev), ev._box.w, ev._box.h, ev._box.lines);
  }

  function arrowLabelBeside(ev, ax, ay, rightLimitX) {
    if (!ev.arrowLabel) return;
    const limit = rightLimitX != null ? rightLimitX : (ev.col + 1 < cols ? colX[ev.col + 1] : W);
    const avail = (limit - (ax + 2)) - 1;
    if (avail <= 0) return;
    const txt = ev.arrowLabel.length > avail ? ev.arrowLabel.slice(0, Math.max(0, avail)) : ev.arrowLabel;
    putText(ax + 2, ay, txt);
  }

  function nextSameLaneCol(ev) {
    const fi = laneIdx.get(ev.from);
    let best = null;
    for (const e of evs) {
      if (e === ev || e.type === "note") continue;
      if (e.col > ev.col && laneIdx.get(e.from) === fi) {
        if (best == null || e.col < best.col) best = e;
      }
    }
    return best;
  }
  function prevSameLaneCol(ev) {
    const fi = laneIdx.get(ev.from);
    let best = null;
    for (const e of evs) {
      if (e === ev || e.type === "note") continue;
      if (e.col < ev.col && laneIdx.get(e.from) === fi) {
        if (best == null || e.col > best.col) best = e;
      }
    }
    return best;
  }
  // The box a cross-lane arrow connects to: the next box (later column)
  // whose own lane is this message's TARGET lane. That box is the target
  // actor's next action — i.e. it received this message. Mirrors the SVG,
  // where the arrow lands on that box rather than in empty lane space.
  function receivingBox(ev) {
    const ti = laneIdx.get(ev.to);
    let best = null;
    for (const e of evs) {
      if (e === ev || e.type === "note") continue;
      if (e.col > ev.col && laneIdx.get(e.from) === ti) {
        if (best == null || e.col < best.col) best = e;
      }
    }
    return best;
  }

  for (const ev of evs) {
    if (ev.type === "note") continue;
    const fi = laneIdx.get(ev.from), ti = laneIdx.get(ev.to);

    if (fi === ti) {
      // Same-lane link: horizontal trail to/from an adjacent same-lane box.
      const row = boxMidRow(ev);
      if (ev.standalone) continue;
      if (ev.incomingOnly) {
        const prev = prevSameLaneCol(ev);
        const toX = colX[ev.col] - 1;
        const fromX = prev ? colX[prev.col] + prev._box.w : colX[ev.col] - 3;
        for (let p = fromX; p < toX; p++) addMask(p, row, L | R);
        if (prev) addMask(colX[prev.col] + prev._box.w - 1, boxMidRow(prev), R);
        putGlyph(toX, row, "►");
        continue;
      }
      const next = nextSameLaneCol(ev);
      const fromX = colX[ev.col] + ev._box.w;
      addMask(colX[ev.col] + ev._box.w - 1, row, R);
      if (next) {
        const toX = colX[next.col] - 1;
        for (let p = fromX; p < toX; p++) addMask(p, row, L | R);
        putGlyph(toX, row, "►");
      } else {
        addMask(fromX, row, L | R); addMask(fromX + 1, row, L | R);
        putGlyph(fromX + 2, row, "►");
      }
      arrowLabelBeside(ev, fromX, row);
      continue;
    }

    // Cross-lane arrow. If a later box in the target lane receives this
    // message, route to it with an L-shape (vertical then horizontal into
    // its left edge); otherwise point into the empty target lane.
    const cx = centerX(ev);
    const recv = receivingBox(ev);
    if (ti > fi) { // downward
      addMask(cx, boxBotRow(ev), D);
      if (recv) {
        const midR = boxMidRow(recv);
        const headX = colX[recv.col] - 1;
        for (let yy = boxBotRow(ev) + 1; yy < midR; yy++) addMask(cx, yy, U | D);
        addMask(cx, midR, U | R);                 // └ elbow
        for (let p = cx + 1; p < headX; p++) addMask(p, midR, L | R);
        putGlyph(headX, midR, "►");
        if (ev.bidirectional) putGlyph(cx, boxBotRow(ev) + 1, "▲");
        arrowLabelBeside(ev, cx, boxBotRow(ev) + 1, colX[recv.col]);
      } else {
        const headY = laneTop[ti] - 1;
        for (let yy = boxBotRow(ev) + 1; yy < headY; yy++) addMask(cx, yy, U | D);
        putGlyph(cx, headY, "▼");
        if (ev.bidirectional) putGlyph(cx, boxBotRow(ev) + 1, "▲");
        arrowLabelBeside(ev, cx, Math.floor((boxBotRow(ev) + headY) / 2));
      }
    } else { // upward
      addMask(cx, boxTopRow(ev), U);
      if (recv) {
        const midR = boxMidRow(recv);
        const headX = colX[recv.col] - 1;
        for (let yy = boxTopRow(ev) - 1; yy > midR; yy--) addMask(cx, yy, U | D);
        addMask(cx, midR, D | R);                 // ┌ elbow
        for (let p = cx + 1; p < headX; p++) addMask(p, midR, L | R);
        putGlyph(headX, midR, "►");
        if (ev.bidirectional) putGlyph(cx, boxTopRow(ev) - 1, "▼");
        arrowLabelBeside(ev, cx, boxTopRow(ev) - 1, colX[recv.col]);
      } else {
        const headY = laneBot[ti] + 1;
        for (let yy = boxTopRow(ev) - 1; yy > headY; yy--) addMask(cx, yy, U | D);
        putGlyph(cx, headY, "▲");
        if (ev.bidirectional) putGlyph(cx, boxTopRow(ev) - 1, "▼");
        arrowLabelBeside(ev, cx, Math.floor((boxTopRow(ev) + headY) / 2));
      }
    }
  }

  // --- section banners (top strip) ---
  if (sectionRows) {
    for (const s of model.sections) {
      const sx = colX[s.start];
      const ex = colX[s.end] + colW[s.end] - 1;
      const label = `[ ${s.label} ]`;
      putText(sx, 0, label.slice(0, Math.max(0, ex - sx + 1)));
      for (let p = sx; p <= ex; p++) addMask(p, 1, L | R);
    }
  }

  // --- title ---
  if (titleRows) {
    const t = model.title;
    putText(Math.max(0, Math.floor((W - t.length) / 2)), sectionRows, t);
  }

  // --- compose ---
  const out = [];
  for (let py = 0; py < H; py++) {
    let line = "";
    for (let px = 0; px < W; px++) {
      const g = glyph[py][px];
      if (g !== " ") line += g;
      else line += (mask[py][px] ? BITCH[mask[py][px]] : " ");
    }
    out.push(line.replace(/\s+$/, ""));
  }
  // Lane names in the left gutter, vertically centred in each band.
  for (let i = 0; i < lanes.length; i++) {
    const row = laneTop[i] + Math.floor(bandH[i] / 2);
    const name = lanes[i].slice(0, gutterW - 1);
    let line = out[row] || "";
    while (line.length < gutterW) line += " ";
    out[row] = name + line.slice(name.length);
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

export {
  parse,
  solveLayout,
  render,
  renderAscii,
  wrap,
  escXml,
  LAYOUT,
  layoutMetrics,
  laneHeightFor,
  colWidthFor,
  boxDimsFor,
  boxHeightFor,
  measureTextPx,
};
