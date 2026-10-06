/* Branchline — js/10-canvas-toolbar-drc.js
   Part 10 of 19 of the former single-file app.js. Contents: canvas pan / zoom, toolbar, global shortcuts (map list / new), theme panel, toolbar quote banner, DRC "cards".
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- canvas pan / zoom ---------------- */

  function applyTransform() {
    worldEl.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    scheduleVirtualViewportRefresh(false);
    // Only promote #world to its own composited GPU layer *while* pan/zoom
    // is actually moving. Chromium (and others) render a composited layer
    // by scaling a cached bitmap rather than re-rasterizing text/lines at
    // the new scale, which is what was making the map look blurry once
    // zoomed in — especially visible on a high-DPI/4K display. Dropping
    // will-change back to "auto" a beat after the last change forces a
    // fresh, crisp repaint at rest; it's re-applied on the next move so
    // panning/zooming itself still stays smooth.
    worldEl.style.willChange = "transform";
    if (transformSettleTimer) clearTimeout(transformSettleTimer);
    transformSettleTimer = setTimeout(() => { worldEl.style.willChange = "auto"; }, 160);
  }
  let transformSettleTimer = null;

  let panning = false, panStart = null;
  // Set while two (or more) touches are down at once — drives pinch-zoom
  // instead of the single-finger pan/drag handling below. See the
  // viewportEl pointerdown listener for how it's populated.
  let pinchState = null;

  function startPan(clientX, clientY) {
    // What was on screen before this press decides how much has to be
    // redrawn afterwards (see the end of this function).
    const hadEditing = !!state.editingId;
    const hadCellState = !!(state.selectedCell || state.cellRange || state.cellRangeAnchor);
    const prevSelectedId = state.selectedId;
    // render:false — this function renders (at most) once itself below;
    // letting commitEditIfActive render too made every click on empty
    // canvas rebuild the whole map twice.
    commitEditIfActive({ render: false });
    panning = true;
    panStart = { x: clientX, y: clientY, tx: state.tx, ty: state.ty };
    viewportEl.classList.add("panning");
    state.selectedId = null;
    state.selectedCell = null;
    state.cellRangeAnchor = null;
    state.cellRange = null;
    state.editingId = null;
    // Deliberately NOT clearing linkFromId/moveSourceId here. Both
    // "pick the other end"/"pick the destination" modes are meant to
    // support a target that's off-screen — startMoveFrom's whole point is
    // letting you pan across the canvas to reach a far-away parent — so a
    // pan (which is exactly how you'd scroll to find that target) must not
    // cancel the pending link/move. Escape, completing the action, or
    // explicitly choosing "Cancel move" are the only ways to back out (see
    // updateLinkHint's hint text).
    //
    // Leaving an edit box or a table-cell selection needs the real
    // thing (text may have changed size; cell highlights are drawn per
    // render). A plain deselect only has to drop the .selected class —
    // same cheap path selectNode uses — instead of tearing down and
    // rebuilding every node, connector and photo thumbnail on the map
    // just because the empty background was pressed.
    if (hadEditing || hadCellState) renderAll();
    else updateSelectedClasses(prevSelectedId, null);
  }

  viewportEl.addEventListener("mousedown", (e) => {
    if (e.target.closest(".node") || e.target.closest("#node-fabs")) return;
    startPan(e.clientX, e.clientY);
  });

  // Touch handling for pan/pinch-zoom lives separately from the mouse path
  // above rather than trying to reuse mousedown, since touch needs to
  // recognize a *second* finger landing (anywhere, including on top of a
  // node) as the start of a pinch. This listener runs in the capture phase
  // so it always sees every touch inside the viewport even though a node's
  // own pointerdown handler (bubble phase, see beginNodeDrag) stops
  // propagation for its own purposes.
  viewportEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      // Second finger down — cleanly end whatever single-finger gesture
      // (pan or node drag) the first finger had already started, then
      // switch entirely to pinch-zoom.
      finishInteraction();
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
      const rect = viewportEl.getBoundingClientRect();
      pinchState = {
        startDist: dist,
        startScale: state.scale,
        // World-space point currently under the pinch midpoint — held
        // fixed under the fingers as they move, the same way the wheel
        // zoom below keeps the point under the cursor fixed.
        anchorX: (midX - rect.left - state.tx) / state.scale,
        anchorY: (midY - rect.top - state.ty) / state.scale
      };
    } else if (activePointers.size === 1 && calendarPanSurface(e.target)) {
      // Do not pan yet: a stationary touch is still a normal calendar tap.
      // Once the finger moves beyond the same threshold used for node swipes,
      // pointermove promotes this gesture to canvas panning.
      calendarPanArm = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    } else if (activePointers.size === 1 && !e.target.closest(".node") && !e.target.closest("#node-fabs")) {
      startPan(e.clientX, e.clientY);
    }
  }, { capture: true });

  function handleMoveAt(e) {
    if (panning) {
      state.tx = panStart.tx + (e.clientX - panStart.x);
      state.ty = panStart.ty + (e.clientY - panStart.y);
      applyTransform();
      return;
    }
    if (!dragCandidate) return;
    const node = findNode(dragCandidate.id);
    if (!node) { dragCandidate = null; return; }
    const dxScreen = e.clientX - dragCandidate.startClientX;
    const dyScreen = e.clientY - dragCandidate.startClientY;
    if (!dragCandidate.moved) {
      if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD) return;
      dragCandidate.moved = true;
      pushUndo();
      const div = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
      // Cache the dragged node's own div and every descendant's div once,
      // here, rather than re-querying the DOM on every mousemove — the
      // per-frame handler below only ever touches these cached elements.
      dragCandidate.div = div;
      dragCandidate.descendants.forEach(d => {
        d.div = nodesLayer.querySelector(`.node[data-id="${d.id}"]`);
        // Descendants ride along via the same live-drag transform as the
        // dragged node itself (see the mousemove handler) but don't carry
        // the .dragging class that gives it a will-change hint — set it
        // directly so the whole branch gets promoted to the compositor,
        // not just the node under the cursor.
        if (d.div) d.div.style.willChange = "transform";
      });
      if (div) {
        div.classList.add("dragging");
        // The dragged box always sits right under the cursor, so without
        // this, elementFromPoint below would just find itself and never
        // the node underneath it that it's about to be dropped onto.
        div.style.pointerEvents = "none";
      }
    }
    const dxLocal = dxScreen / state.scale;
    const dyLocal = dyScreen / state.scale;
    node.ox = dragCandidate.startOx + dxLocal;

    // Flip immediately if this drag just carried the node across the
    // center line — see maybeFlipSideDuringDrag for how it keeps the node
    // under the cursor and lets its children reflow to the new side right
    // away, while the mouse is still held.
    const flippedH = maybeFlipSideDuringDrag(node, dxLocal, dyLocal);
    // Same idea, but for a top-level Timeline branch crossing above/below
    // the root along the vertical spine (see maybeFlipVSideDuringDrag).
    const flippedV = maybeFlipVSideDuringDrag(node, dxLocal, dyLocal);
    const flipped = flippedH || flippedV;

    // Where the node "wants" to be vertically, tracked from the drag start
    // rather than from node._y directly, so it stays correct across any
    // sibling reorder that happens below.
    const targetAbsY = dragCandidate.startAbsY + dyLocal;
    const reordered = maybeReorderSiblings(node, targetAbsY);
    node.oy = targetAbsY - node._y;

    if (reordered || flipped) {
      // Sibling order or side changed — everyone needs a fresh layout pass,
      // not just this node, so the siblings/descendants that shifted are
      // actually redrawn. repositionAll(true) re-runs layout but moves
      // existing DOM elements in place rather than wiping and recreating
      // them (that full rebuild is what caused the visible blink crossing
      // the center line), and keeps the canvas origin frozen so unrelated
      // nodes — like the dragged node's parent or the root — don't visibly
      // shift just because the bounding box changed shape mid-drag. The
      // canvas gets resized/recentered properly once the drag ends.
      repositionAll(true);
      // repositionAll just wrote fresh left/top for this node (and every
      // descendant, via the loop below) reflecting the FULL delta so far.
      // Any transform left over from the plain-drag path below would now
      // double-count that delta, and the running "baked" total needs to
      // catch up to match, so the next plain-drag frame computes the right
      // remaining delta instead of jumping.
      if (dragCandidate.div) dragCandidate.div.style.transform = "";
      dragCandidate.descendants.forEach(d => { if (d.div) d.div.style.transform = ""; });
      dragCandidate.bakedDx = dxLocal;
      dragCandidate.bakedDy = dyLocal;
    } else {
      // No reorder/flip this frame — the common case on every mousemove.
      // Rewriting left/top here (as updateNodePositionDom does) forces the
      // browser to lay out and repaint the whole node box every frame,
      // including everything rendered inside it — a big photo strip makes
      // that repaint far more expensive, which is exactly what made drags
      // feel unsmooth on photo-heavy nodes. A CSS transform for just the
      // delta since the last full reposition is compositor-only: the node
      // (photos and all) is repainted once, then just moved as a bitmap,
      // so the drag stays smooth regardless of how much is inside the box.
      const tdx = dxLocal - dragCandidate.bakedDx;
      const tdy = dyLocal - dragCandidate.bakedDy;
      const t = `translate(${tdx}px, ${tdy}px)`;
      if (dragCandidate.div) dragCandidate.div.style.transform = t;
      dragCandidate.descendants.forEach(d => { if (d.div) d.div.style.transform = t; });
      // Connector lines are cheap SVG path updates (not affected by photo
      // count), so they still get refreshed every frame for a live feel.
      refreshConnectorsFor(node);
    }

    // Carry every descendant along by the same delta so a branch moves as
    // one rigid unit instead of the parent sliding out from under its kids.
    dragCandidate.descendants.forEach(d => {
      const dNode = findNode(d.id);
      if (!dNode) return;
      dNode.ox = d.startOx + dxLocal;
      dNode.oy = d.startOy + dyLocal;
      if (reordered || flipped) {
        // A full reposition already ran above (using each descendant's
        // pre-update ox/oy) — redo it now that the up-to-date offsets are
        // set, so descendants land exactly on this frame's delta too.
        updateNodePositionDom(dNode);
      } else {
        // Position is already handled by the shared transform above; just
        // keep this descendant's connectors in sync.
        refreshConnectorsFor(dNode);
      }
    });

    // The central node has nowhere to be reparented to, so only offer a
    // drop target for everything else.
    if (findParent(node.id)) updateDropTarget(e, node);
  }
  window.addEventListener("mousemove", handleMoveAt);
  // Touch/pen pointermove: pinch-zoom takes priority whenever two touches
  // are down; otherwise it's the same pan/node-drag handling as mouse.
  //
  // Touch fires pointermove far more often than the screen can actually
  // repaint (many phones sample touch at 90-120+Hz against a 60Hz+
  // display), and every event here does real work — updateDropTarget's
  // elementFromPoint forces a synchronous layout, plus multiple style
  // writes. Running all of that once per raw touch event, rather than
  // once per rendered frame, is what made drags feel laggy on phones:
  // the browser was doing several frames' worth of layout/paint work for
  // a single visible frame. Instead, each raw event just records the
  // latest pointer position; the actual drag/pan/pinch math and DOM
  // writes run at most once per animation frame, via rAF, using only the
  // freshest position. Nothing but a cheap Map/variable write happens
  // outside that rAF callback, so a flurry of touch events between two
  // frames costs almost nothing extra.
  let pendingTouchMoveEvent = null;
  let touchMoveRAF = null;
  function processPendingTouchMove() {
    touchMoveRAF = null;
    const e = pendingTouchMoveEvent;
    pendingTouchMoveEvent = null;
    if (!e) return;
    if (pinchState && activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
      const newScale = clamp(pinchState.startScale * (dist / pinchState.startDist), 0.25, 2.5);
      const rect = viewportEl.getBoundingClientRect();
      state.scale = newScale;
      state.tx = (midX - rect.left) - pinchState.anchorX * newScale;
      state.ty = (midY - rect.top) - pinchState.anchorY * newScale;
      applyTransform();
      return;
    }
    handleMoveAt(e);
  }
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") return;
    // A touch that's still waiting out its hold timer (see the node's
    // pointerdown listener above) and has now moved far enough is a swipe,
    // not a hold-to-drag — cancel the pending node drag and start panning
    // the canvas from here instead, same as a touch that started on empty
    // canvas would.
    if (calendarPanArm && calendarPanArm.pointerId === e.pointerId && !pinchState) {
      const dx = e.clientX - calendarPanArm.startX;
      const dy = e.clientY - calendarPanArm.startY;
      if (Math.hypot(dx, dy) >= TOUCH_DRAG_CANCEL_DIST) {
        const arm = calendarPanArm;
        clearCalendarPanArm();
        startPan(arm.startX, arm.startY);
      }
    }
    if (touchDragArm && touchDragArm.pointerId === e.pointerId) {
      const dx = e.clientX - touchDragArm.startClientX;
      const dy = e.clientY - touchDragArm.startClientY;
      if (Math.hypot(dx, dy) >= TOUCH_DRAG_CANCEL_DIST) {
        const arm = touchDragArm;
        clearTouchDragArm();
        startPan(arm.startClientX, arm.startClientY);
      }
    }
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Keep only clientX/clientY (that's all handleMoveAt/updateDropTarget
    // need) rather than the whole event object, since the browser may
    // reuse/invalidate the event by the time the rAF callback runs.
    pendingTouchMoveEvent = { clientX: e.clientX, clientY: e.clientY };
    if (touchMoveRAF == null) touchMoveRAF = requestAnimationFrame(processPendingTouchMove);
  });
  function finishInteraction() {
    if (panning) { panning = false; viewportEl.classList.remove("panning"); persistViewOnly(); }
    if (dragCandidate) {
      const node = findNode(dragCandidate.id);
      const moved = dragCandidate.moved;
      const dropTargetId = dragCandidate.dropTargetId;
      if (node) {
        const div = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
        if (div) { div.classList.remove("dragging"); div.style.pointerEvents = ""; div.style.transform = ""; }
      }
      // Clear any leftover live-drag transform (and its will-change hint)
      // on the descendants too — repositionAll/reparentNode below
      // re-establish the real left/top, but neither touches these.
      dragCandidate.descendants.forEach(d => {
        if (d.div) { d.div.style.transform = ""; d.div.style.willChange = ""; }
      });
      if (dropTargetId) {
        const targetDiv = nodesLayer.querySelector(`.node[data-id="${dropTargetId}"]`);
        if (targetDiv) targetDiv.classList.remove("drop-target");
      }
      if (moved && node && dropTargetId) {
        reparentNode(node.id, dropTargetId);
      } else if (moved && node) {
        // Live flip during the drag (see maybeFlipSideDuringDrag) already
        // keeps side in sync on every frame — this only catches the rare
        // case a flip is still needed right at the moment of release.
        const worldXAtDrop = node._x + (node.ox || 0);
        const worldYAtDrop = node._y + (node.oy || 0);
        const flippedH = maybeFlipSideOnDrop(node);
        const flippedV = maybeFlipVSideOnDrop(node);
        if (flippedH || flippedV) {
          layout(state.current.root);
          // Keep the node exactly where it visually was at release instead
          // of letting it jump to the new side's raw slot center.
          node.ox = worldXAtDrop - node._x;
          node.oy = worldYAtDrop - node._y;
        }
        // Deliberately no ox/oy reset here. They're already recomputed
        // fresh on every mousemove to reflect exactly where the node was
        // dragged to relative to its current (possibly reordered or
        // flipped) automatic slot — there's nothing to "clean up". Zeroing
        // them unconditionally used to snap the node onto its slot's raw
        // center on drop, and since whether a reorder happened was tracked
        // with a flag that, once set, never cleared even if a later swing
        // of the drag undid it, a long or fast drag could end up snapping
        // the node all the way back to right where it started.
        //
        // The canvas origin/size was frozen for the whole drag (see
        // repositionAll's freezeOrigin) so nothing not actually moving —
        // like the dragged node's parent or the root — visibly drifted.
        // Now that the drag is over, settle it properly in one shot.
        repositionAll(false);
      }
      dragCandidate = null;
      if (moved) {
        suppressNextNodeClick = true;
        scheduleVirtualViewportRefresh(true);
        persist();
      }
    }
  }
  window.addEventListener("mouseup", finishInteraction);
  function onTouchPointerEnd(e) {
    if (e.pointerType === "mouse") return;
    activePointers.delete(e.pointerId);
    if (calendarPanArm && calendarPanArm.pointerId === e.pointerId) clearCalendarPanArm();
    // Finger lifted before the hold timer armed a drag — this was just a
    // tap (the click listener already handles that), so drop the pending
    // arm instead of letting a stale timer fire against a released finger.
    if (touchDragArm && touchDragArm.pointerId === e.pointerId) clearTouchDragArm();
    // Drop any move still queued for the next frame — it holds a stale
    // position from before release, and applying it after finishInteraction()
    // below has already cleared dragCandidate/panning could otherwise let a
    // fresh gesture starting on the very next frame briefly see leftover state.
    if (touchMoveRAF != null) { cancelAnimationFrame(touchMoveRAF); touchMoveRAF = null; }
    pendingTouchMoveEvent = null;
    if (pinchState) {
      if (activePointers.size < 2) {
        pinchState = null;
        persistViewOnly();
        if (activePointers.size === 1) {
          // One finger remains down after the pinch ends — resume panning
          // from here instead of leaving the gesture stuck until the next
          // fresh touch.
          const remaining = Array.from(activePointers.values())[0];
          startPan(remaining.x, remaining.y);
        }
      }
      return;
    }
    finishInteraction();
  }
  window.addEventListener("pointerup", onTouchPointerEnd);
  window.addEventListener("pointercancel", onTouchPointerEnd);

  viewportEl.addEventListener("wheel", (e) => {
    if (!state.current) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.0012;
    const newScale = clamp(state.scale * (1 + delta), 0.25, 2.5);
    const rect = viewportEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - state.tx) / state.scale, wy = (my - state.ty) / state.scale;
    state.tx = mx - wx * newScale;
    state.ty = my - wy * newScale;
    state.scale = newScale;
    applyTransform();
    persistViewOnly();
  }, { passive: false });

  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#zoom-in").addEventListener("click", () => { state.scale = clamp(state.scale * 1.15, 0.25, 2.5); applyTransform(); persistViewOnly(); });
  $("#zoom-out").addEventListener("click", () => { state.scale = clamp(state.scale / 1.15, 0.25, 2.5); applyTransform(); persistViewOnly(); });
  $("#zoom-reset").addEventListener("click", () => { state.scale = 1; state.tx = 60; state.ty = 60; applyTransform(); persistViewOnly(); });
  window.addEventListener("resize", debounce(() => {
    // Android soft-keyboard open/close presents as a resize. Rebuilding the
    // node layer while a node is contenteditable destroys its focus and closes
    // the keyboard, so wait until commitEdit() performs the normal full render.
    if (state.editingId) return;
    scheduleVirtualViewportRefresh(true);
  }, 120));

  // Floating add-child / add-sibling buttons — same effect as the Tab/Enter
  // shortcuts, for anyone who'd rather click (or has no keyboard handy).
  // Falls back to the central node when nothing is selected yet, same as
  // the global Tab/Enter handler above.
  function fabTargetNode() {
    if (!state.current) return null;
    // render: false — the fab click handlers below set state.selectedId /
    // state.editingId for the *new* node right after this returns, then do
    // their own single renderAll(). That renderAll() both commits the DOM
    // change that drops the old node out of edit mode and creates+focuses
    // the new node's div in one pass, instead of two renderAll() passes
    // back-to-back (see commitEditIfActive's comment for why that matters).
    commitEditIfActive({ render: false });
    return (state.selectedId && findNode(state.selectedId)) || state.current.root;
  }
  // Belt-and-suspenders alongside the closest("#node-fabs") checks in the
  // pan-start handlers above: stop the mousedown here too so a click never
  // races a pan-start that would null out state.selectedId first.
  $("#fab-add-child").addEventListener("mousedown", (e) => e.stopPropagation());
  $("#fab-add-sibling").addEventListener("mousedown", (e) => e.stopPropagation());
  $("#fab-add-child").addEventListener("click", () => {
    const node = fabTargetNode();
    if (!node) return;
    const n = addChild(node.id);
    if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
    persist();
  });
  $("#fab-add-sibling").addEventListener("click", () => {
    const node = fabTargetNode();
    if (!node) return;
    const n = addSibling(node.id);
    if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
    persist();
  });

  /* ---------------- toolbar ---------------- */

  titleInput.addEventListener("input", () => {
    if (!state.current) return;
    if (!isEditingAllowed()) {
      titleInput.value = state.current.title || "";
      requireSignIn();
      return;
    }
    state.current.title = titleInput.value;
    // Keep the central node's text in sync with the title field, the same
    // way editing the central node itself updates the title (see commitEdit).
    if (state.current.root.text !== titleInput.value) {
      state.current.root.text = titleInput.value;
      renderAll();
    }
    renderSidebar();
    persist();
  });
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") titleInput.blur(); });

  layoutSelect.addEventListener("change", () => {
    if (!state.current) return;
    state.current.layout = layoutSelect.value;
    state.selectedId = null;
    state.selectedCell = null;
    state.cellRangeAnchor = null;
    state.cellRange = null;
    renderAll();
    persist();
  });

  $("#btn-new-map").addEventListener("click", createMap);
  $("#btn-empty-new").addEventListener("click", createMap);
  $("#btn-delete-map").addEventListener("click", () => { if (state.current) deleteMap(state.current.id); });

  // Clears every node's manual drag offset (ox/oy) in one go, so the whole
  // map snaps back to the automatic layout — the fix for branches that have
  // drifted into overlapping each other after being nudged around.
  function autoArrange() {
    if (!state.current) return;
    // v555: Auto-arrange is an explicit request to recompute layout, not
    // merely a "clear manual drag offsets" command. Always run it, even
    // when ox/oy are already zero. Also clear transient layout caches so
    // collapsed descendants cannot leave stale vertical space behind.
    pushUndo();
    (function clear(n) {
      delete n.ox; delete n.oy;
      delete n._subtreeH;
      delete n._x; delete n._y;
      (n.children || []).forEach(clear);
    })(state.current.root);
    renderAll();
    persist();
  }
  $("#btn-auto-arrange").addEventListener("click", autoArrange);

  $("#btn-help").addEventListener("click", () => zoomModalOpen($("#help-modal")));
  $("#help-close").addEventListener("click", () => zoomModalClose($("#help-modal")));
  $("#help-modal").addEventListener("click", (e) => { if (e.target.id === "help-modal") zoomModalClose(e.currentTarget); });

  $("#btn-export").addEventListener("click", async () => {
    if (!state.current) return;
    const portable = await inlinePhotosForPortableCopy(state.current);
    const blob = new Blob([JSON.stringify(portable, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.current.title || "mindmap").replace(/[^a-z0-9\-_]+/gi, "_") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#btn-import").addEventListener("click", () => {
    if (!requireSignIn()) return;
    $("#file-import").click();
  });
  $("#file-import").addEventListener("change", async (e) => {
    if (!requireSignIn()) { e.target.value = ""; return; }
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.root || !data.root.id) throw new Error("bad format");
      data.id = uid(); // avoid collisions
      data.updatedAt = Date.now();
      data.trashedAt = null; // an imported map always lands in the active list, never pre-trashed
      ensureTheme(data);
      ensureLayout(data);
      ensureFavorite(data);
      ensureSidesRepaired(data);
      // An imported .json is always the self-contained, inline-photos
      // format (see inlinePhotosForPortableCopy) — pull those bytes into
      // this browser's own photo store now, replacing them with ids.
      await ensurePhotosMigrated(data);
      state.maps.unshift(data);
      sortMaps(state.maps);
      await DB.put(data);
      await FolderDB.save(data);
      await DriveDB.save(data);
      await openMap(data.id);
    } catch (err) {
      alert("Couldn't import that file — it doesn't look like a Branchline map.");
    }
    e.target.value = "";
  });

  /* ---------------- global shortcuts (map list / new) ---------------- */

  document.addEventListener("keydown", (e) => {
    // Was missing TEXTAREA here — only INPUT and contenteditable were
    // excluded, so typing a plain "n" while focused in any <textarea>
    // (the affirmation editor, a photo/video/link comment box, the
    // brainstorm pad, etc.) fell straight through to createMap() below
    // and silently spawned a brand-new blank mindmap mid-sentence. This
    // is what was happening while editing an affirmation, since almost
    // any English or Vietnamese line contains the letter "n" somewhere.
    const activeIsEditable = document.activeElement && (document.activeElement.isContentEditable || document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA");
    if (activeIsEditable) return;
    // Same reasoning, for modals with no text field to catch it: the note
    // editor, task list, photo/video (YouTube) viewer, trash, storage,
    // etc. — an "n" typed there (nothing focused, or focus on a plain
    // button) fell through the check above and still spawned a new map
    // behind the open modal. Same ".modal:not(.hidden)" guard the global
    // paste handler (further down) already uses, for the same reason.
    if (document.querySelector(".modal:not(.hidden)")) return;
    if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey) createMap();
  });

  /* ---------------- theme panel ---------------- */

  const themeModal = $("#theme-modal");
  const bgInput = $("#theme-bg");
  const connectorModeSel = $("#theme-connector-mode");
  const connectorColorInput = $("#theme-connector-color");
  const fontModeSel = $("#theme-font-mode");
  const fontColorInput = $("#theme-font-color");

  function openThemePanel() {
    if (!state.current) return;
    ensureTheme(state.current);
    const t = state.current.theme;
    bgInput.value = t.background || defaultBg();
    connectorModeSel.value = t.connectorMode;
    connectorColorInput.value = t.connectorColor;
    connectorColorInput.disabled = t.connectorMode !== "custom";
    fontModeSel.value = t.fontMode;
    fontColorInput.value = t.fontColor;
    zoomModalOpen(themeModal);
  }


  function updateTheme(patch) {
    if (!state.current) return;
    Object.assign(state.current.theme, patch);
    applyTheme();
    renderAll();
    persist();
  }

  $("#btn-theme").addEventListener("click", openThemePanel);
  $("#theme-close").addEventListener("click", () => zoomModalClose(themeModal));
  themeModal.addEventListener("click", (e) => { if (e.target === themeModal) zoomModalClose(themeModal); });

  /* ---------------- toolbar quote banner ----------------
     Ported from a companion clock/timer page: a short scrolling
     affirmation in the toolbar, picked from (or added to) a small
     editable list. v609 unifies this with the per-node Affirmation
     typing-practice game: the running bar, its picker/editor, and the game
     all read and edit affirmationQuotesList. The "quote banner" internal
     ids are retained only for compatibility with the existing UI.

     Redesigned to one interaction per action instead of a list-plus-a-
     separate-editor-textarea-plus-a-dual-purpose-Save/Add-button: tap a
     line to use it, ✏️ to fix it in place, 🗑 to remove it, one input at
     the top to add a new one. Also collapses storage down to a single
     persisted list (seeded from the defaults once) plus the current
     line's own text — the old scheme re-merged a separate saved list
     against the hardcoded defaults on every read, so editing the text
     of a default line didn't replace it, it silently left the original
     behind and appended the edited text as a second, near-duplicate
     entry every time. */

  const QUOTE_BANNER_LIST_KEY = "branchlineQuoteBannerList_v1";
  const QUOTE_BANNER_CURRENT_KEY = "branchlineQuoteBannerCurrent_v1";

  const DEFAULT_QUOTE_BANNER_LINES = [
    "a successful life start with a successful day",
    "buồn như buồn, vui như vui, phiền não như phiền não",
    "Nó là chính nó",
    "Phiền Não Tức Bồ Đề",
    "ta là cái biết thân tâm hoàn cảnh",
    "tham sân si tức bồ đề",
    "thêm cũng ko được, bớt cũng chẳng xong",
    "Tôi hoàn toàn chấp nhận hiện tại",
    "tôi không muốn thay đổi bất cứ điều gì",
    "trăm triệu hạt mưa ko hạt nào rơi nhầm chỗ",
    "Tri kiến lập tri là gốc của vô minh",
    "Tự Nhiên tâm là đạo",
    "Tôi bình tĩnh, tập trung và làm đúng kế hoạch",
    "Tôi chỉ giao dịch khi có vị trí đẹp và xác suất cao",
    "Tôi kiên nhẫn chờ failure test rõ ràng",
    "Tôi bảo vệ vốn trước, lợi nhuận đến sau",
    "Tôi vào lệnh nhỏ, thoát nhanh, không hy vọng",
    "Tôi làm đúng quy trình, không revenge trade",
    "Tôi đọc thanh khoản, range và phản ứng giá thật chậm rãi"
  ];

  const quoteBannerEl = $("#toolbar-quote-banner");
  const quoteBannerMarquee = $("#quote-banner-marquee");
  const quoteBannerModal = $("#quote-banner-modal");
  const quoteBannerListEl = $("#quote-banner-list");
  const quoteBannerAddInput = $("#quote-banner-add-input");
  let editingQuoteBannerIndex = null; // which row (if any) is mid-inline-edit

  // v609: running text and typing game share affirmationQuotesList.
  // Keep these wrapper names because the banner UI already calls them.
  function getQuoteBannerLines() {
    if (!Array.isArray(affirmationQuotesList)) affirmationQuotesList = [];
    if (!affirmationQuotesList.length) {
      affirmationQuotesList.push(...DEFAULT_QUOTE_BANNER_LINES);
      saveAffirmationQuotes();
    }
    return affirmationQuotesList;
  }

  function saveQuoteBannerLines(list) {
    // Preserve the same array identity where possible so the game and both
    // list editors immediately see one another's changes.
    const clean = (Array.isArray(list) ? list : [])
      .map(v => String(v || "").trim())
      .filter(Boolean);
    affirmationQuotesList.splice(0, affirmationQuotesList.length, ...clean);
    saveAffirmationQuotes();
  }

  function applyQuoteBanner(text) {
    const clean = (text || "").trim();
    if (!clean || !quoteBannerMarquee) return;
    quoteBannerMarquee.textContent = clean;
    localStorage.setItem(QUOTE_BANNER_CURRENT_KEY, clean);
  }

  function syncQuoteBannerToMasterList() {
    if (!quoteBannerMarquee) return;
    const list = getQuoteBannerLines();
    if (!list.length) {
      quoteBannerMarquee.textContent = "Add an affirmation…";
      try { localStorage.removeItem(QUOTE_BANNER_CURRENT_KEY); } catch (e) {}
      return;
    }
    const visible = (quoteBannerMarquee.textContent || "").trim();
    const saved = localStorage.getItem(QUOTE_BANNER_CURRENT_KEY);
    const keep = list.includes(visible) ? visible : (saved && list.includes(saved) ? saved : null);
    applyQuoteBanner(keep || list[Math.floor(Math.random() * list.length)]);
  }

  function initQuoteBanner() {
    if (!quoteBannerEl) return;
    syncQuoteBannerToMasterList();
  }

  function renderQuoteBannerList() {
    const list = getQuoteBannerLines();
    const current = quoteBannerMarquee ? quoteBannerMarquee.textContent : null;
    quoteBannerListEl.innerHTML = "";
    list.forEach((text, index) => {
      const row = document.createElement("div");
      row.className = "quote-banner-item" + (text === current ? " selected" : "");

      if (index === editingQuoteBannerIndex) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "quote-banner-item-edit-input";
        input.maxLength = 200;
        input.value = text;
        const commit = () => {
          const val = input.value.trim();
          editingQuoteBannerIndex = null;
          if (val && val !== text) {
            const wasCurrent = text === current;
            list[index] = val;
            saveQuoteBannerLines(list);
            if (wasCurrent) applyQuoteBanner(val);
          }
          renderQuoteBannerList();
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); editingQuoteBannerIndex = null; renderQuoteBannerList(); }
        });
        input.addEventListener("blur", commit);
        row.appendChild(input);
        quoteBannerListEl.appendChild(row);
        requestAnimationFrame(() => { input.focus(); input.select(); });
        return;
      }

      const label = document.createElement("span");
      label.textContent = text;
      label.title = "Tap to use this line";
      label.addEventListener("click", () => { applyQuoteBanner(text); renderQuoteBannerList(); });

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "quote-banner-item-btn";
      editBtn.title = "Edit this line";
      editBtn.setAttribute("aria-label", "Edit this line");
      editBtn.textContent = "✏️";
      editBtn.addEventListener("click", (e) => { e.stopPropagation(); editingQuoteBannerIndex = index; renderQuoteBannerList(); });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "quote-banner-item-btn quote-banner-item-delete";
      deleteBtn.title = "Delete this line";
      deleteBtn.setAttribute("aria-label", "Delete this line");
      deleteBtn.textContent = "🗑";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasCurrent = text === current;
        list.splice(index, 1);
        saveQuoteBannerLines(list);
        if (wasCurrent && list.length) applyQuoteBanner(list[Math.floor(Math.random() * list.length)]);
        renderQuoteBannerList();
      });

      row.append(label, editBtn, deleteBtn);
      quoteBannerListEl.appendChild(row);
    });
  }

  function addQuoteBannerLine() {
    const val = quoteBannerAddInput.value.trim();
    if (!val) return;
    const list = getQuoteBannerLines();
    list.push(val);
    saveQuoteBannerLines(list);
    quoteBannerAddInput.value = "";
    applyQuoteBanner(val);
    renderQuoteBannerList();
  }

  function openQuoteBannerModal() {
    editingQuoteBannerIndex = null;
    quoteBannerAddInput.value = "";
    renderQuoteBannerList();
    zoomModalOpen(quoteBannerModal);
  }

  function randomizeQuoteBanner() {
    const list = getQuoteBannerLines();
    const current = quoteBannerMarquee ? quoteBannerMarquee.textContent : null;
    const others = list.filter((t) => t !== current);
    applyQuoteBanner(others.length ? others[Math.floor(Math.random() * others.length)] : list[0]);
    renderQuoteBannerList();
  }

  if (quoteBannerEl) {
    initQuoteBanner();
    quoteBannerEl.addEventListener("click", openQuoteBannerModal);
    quoteBannerEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openQuoteBannerModal(); }
    });
    $("#quote-banner-add-btn").addEventListener("click", addQuoteBannerLine);
    quoteBannerAddInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); addQuoteBannerLine(); }
    });
    $("#quote-banner-random").addEventListener("click", randomizeQuoteBanner);
    $("#quote-banner-close").addEventListener("click", () => zoomModalClose(quoteBannerModal));
    quoteBannerModal.addEventListener("click", (e) => { if (e.target === quoteBannerModal) zoomModalClose(quoteBannerModal); });
  }

  /* ---------------- DRC "cards" ---------------- */
  // A DRC note shows each section heading
  // (📊 OVERVIEW, ✅ GOOD, …) and the lines typed under it as one rounded,
  // tinted card — the same look as a colored task row — with a small ring
  // at the heading's right edge that opens a swatch popover to recolor
  // that card.
  //
  // Purely a *decoration* layered on the editor's existing flat line
  // <div>s: nothing is wrapped or moved, so Enter, checklists, undo and
  // every other line-based editing feature keep working exactly as
  // before. Which lines belong to which card is recomputed from position
  // (a card = its heading line + everything up to the next heading), so a
  // line typed under a heading is in that card immediately. Only the
  // chosen color is stored, as a `data-card-color` attribute on the heading
  // line; the classes/CSS variables that draw the card are stripped again
  // before a note/template is saved (see drcStripCardMarkup).
  //
  // Which lines count as headings: any line marked data-card (added with
  // the note editor's card button), and — in a DRC note — any line whose
  // text equals one of the "DRC" note template's lines.
  const DRC_CARD_COLORS = ["#6F94CC", "#5DBB63", "#E84D42", "#F39236", "#756BD1", "#0BC09C", "#E86BB8", "#F2C94C"];
  const DRC_CARD_NEUTRAL = "#9A9A94";
  const DRC_CARD_CLASSES = ["drc-card-line", "drc-card-head", "drc-card-last", "drc-card-gap"];
  const drcCardSig = new WeakMap(); // line element -> last decoration applied (skips redundant DOM writes)

  function drcNorm(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function drcIsBlankLine(el) {
    return !(el.textContent || "").replace(/[\u200b\u00a0]/g, "").trim() && !(el.querySelector && el.querySelector("img"));
  }
  function drcCardPaint(color) {
    const hex = (color && /^#[0-9a-f]{6}$/i.test(color)) ? color : DRC_CARD_NEUTRAL;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return { accent: hex, tint: `rgba(${r}, ${g}, ${b}, 0.10)`, strong: `rgba(${r}, ${g}, ${b}, 0.20)` };
  }
  function drcResetLine(el) {
    el.classList.remove(...DRC_CARD_CLASSES);
    el.style.removeProperty("--dc-accent");
    el.style.removeProperty("--dc-tint");
    el.style.removeProperty("--dc-strong");
    if (!el.getAttribute("style")) el.removeAttribute("style");
    if (!el.getAttribute("class")) el.removeAttribute("class");
  }
  // state: null (plain line) or { head, last, gap, color }.
  function drcSetCardState(el, state) {
    const sig = state ? `${state.head ? 1 : 0}${state.last ? 1 : 0}${state.gap ? 1 : 0}|${state.color}` : "none";
    if (drcCardSig.get(el) === sig) return;
    // A plain line that was never decorated: leave its markup completely
    // alone (so opening an ordinary note can't alter its stored HTML).
    if (!state && !el.classList.contains("drc-card-line") && !el.classList.contains("drc-card-gap")
        && (el.getAttribute("style") || "").indexOf("--dc-") === -1) {
      drcCardSig.set(el, sig);
      return;
    }
    drcResetLine(el);
    if (state) {
      if (state.gap) {
        el.classList.add("drc-card-gap");
      } else {
        const p = drcCardPaint(state.color);
        el.classList.add("drc-card-line");
        if (state.head) el.classList.add("drc-card-head");
        if (state.last) el.classList.add("drc-card-last");
        el.style.setProperty("--dc-accent", p.accent);
        el.style.setProperty("--dc-tint", p.tint);
        el.style.setProperty("--dc-strong", p.strong);
      }
    }
    drcCardSig.set(el, sig);
  }

  // The template's own sections as [{ title, color }] — colors come from
  // each line's data-card-color, else a default by position. Used to
  // recognise (and color) the heading lines inside a DRC note.
  function drcTemplateCards() {
    const raw = getDRCTemplateText();
    const found = [];
    if (looksLikeHtml(raw)) {
      const box = document.createElement("div");
      box.innerHTML = raw;
      Array.from(box.childNodes).forEach((n) => {
        if (n.nodeType === 3) {
          const t = drcNorm(n.nodeValue);
          if (t) found.push({ title: t, color: null });
        } else if (n.nodeType === 1) {
          const t = drcNorm(n.textContent);
          if (t) found.push({ title: t, color: n.getAttribute("data-card-color") || null });
        }
      });
    } else {
      raw.split("\n").map(drcNorm).filter(Boolean).forEach((t) => found.push({ title: t, color: null }));
    }
    // While 🎨 auto-color is off, a section with no color of its own
    // (nothing picked via the recolor ring, nothing baked into the
    // template) falls back to neutral instead of the auto-cycled palette —
    // same "off means plain/uniform" rule noteAutoColorParagraphs follows
    // for line text, now applied to card backgrounds too.
    return found.map((c, i) => ({ title: c.title, color: c.color || (noteAutoColorEnabled ? DRC_CARD_COLORS[i % DRC_CARD_COLORS.length] : null) }));
  }

  // mode: "note" (a DRC note: headings are the "DRC" template's lines plus
  // any line marked data-card) | "cards" (any other note that has cards:
  // headings are only the lines marked data-card — see noteAddCard) |
  // null (not a card view: clear it).
  function decorateDRCCards(root, mode) {
    if (!root) return;
    const kids = Array.from(root.children).filter((el) => el.tagName !== "BR");
    if (!mode) {
      root.classList.remove("drc-cards");
      kids.forEach((el) => drcSetCardState(el, null));
      return;
    }
    root.classList.add("drc-cards");
    const titleColor = mode === "note"
      ? new Map(drcTemplateCards().map((c) => [drcNorm(c.title), c.color]))
      : new Map();
    const isHead = (el) => {
      // A card added with the editor's "🗂 Add card" button is marked on
      // the line itself — even while its heading is still blank.
      if (el.hasAttribute("data-card")) return true;
      const t = drcNorm(el.textContent);
      // Otherwise a blank line is never a heading — it belongs to the
      // card above it.
      if (!t) return false;
      return titleColor.has(t);
    };
    let i = 0;
    while (i < kids.length) {
      const head = kids[i];
      if (!isHead(head)) {
        drcSetCardState(head, null);
        // A stray copy of a card color on a non-heading line (the browser
        // can clone attributes when a line is split) has no meaning.
        if (head.hasAttribute("data-card-color")) head.removeAttribute("data-card-color");
        i++;
        continue;
      }
      let j = i + 1;
      while (j < kids.length && !isHead(kids[j])) j++;
      // A color picked on this heading (the ring) wins; otherwise the
      // "DRC" template's color for that section.
      let color = head.getAttribute("data-card-color");
      if (!color) color = titleColor.get(drcNorm(head.textContent));
      // Every line up to the next heading is part of this card — blank
      // ones included. They used to be drawn as a card-less "gap" once past
      // the last filled line, which left the caret outside any card
      // (e.g. right after pressing Enter, before typing anything).
      for (let k = i; k < j; k++) {
        drcSetCardState(kids[k], { head: k === i, last: k === j - 1, color });
      }
      i = j;
    }
  }

  // Removes everything decorateDRCCards adds (classes + CSS variables) from
  // an HTML string, keeping the real content and data-card-color — so a
  // saved note/template is the same as it would have been without cards,
  // and just opening a note never counts as editing it.
  function drcStripCardMarkup(html) {
    if (!html || (html.indexOf("drc-card") === -1 && html.indexOf("--dc-") === -1)) return html;
    const box = document.createElement("div");
    box.innerHTML = html;
    box.querySelectorAll("[class*='drc-card'], [style*='--dc-']").forEach(drcResetLine);
    return box.innerHTML;
  }

  // ---- Card color popover (reuses the task color-dot popover styling) ----
  const drcCardPopover = document.createElement("div");
  drcCardPopover.className = "task-color-popover drc-card-popover hidden";
  let drcCardPopoverPick = null; // callback(color | "none") for the popover's current owner
  (function buildDrcCardPopover() {
    const none = document.createElement("span");
    none.className = "task-color-swatch task-color-swatch-none";
    none.title = "No color";
    none.dataset.color = "none";
    drcCardPopover.appendChild(none);
    PALETTE.forEach((c) => {
      const sw = document.createElement("span");
      sw.className = "task-color-swatch";
      sw.style.background = c;
      sw.dataset.color = c;
      drcCardPopover.appendChild(sw);
    });
    drcCardPopover.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    drcCardPopover.addEventListener("click", (e) => {
      const sw = e.target.closest(".task-color-swatch");
      if (!sw) return;
      e.stopPropagation();
      const pick = drcCardPopoverPick;
      closeDrcCardPopover();
      if (pick) pick(sw.dataset.color);
    });
    document.body.appendChild(drcCardPopover);
    document.addEventListener("mousedown", (e) => {
      if (!drcCardPopover.classList.contains("hidden") && !drcCardPopover.contains(e.target)) closeDrcCardPopover();
    });
  })();
  function closeDrcCardPopover() {
    drcCardPopover.classList.add("hidden");
    drcCardPopoverPick = null;
  }
  function openDrcCardPopover(head, pick) {
    const cur = head.getAttribute("data-card-color");
    drcCardPopover.querySelectorAll(".task-color-swatch").forEach((sw) => {
      sw.classList.toggle("active", sw.dataset.color === cur);
    });
    drcCardPopoverPick = pick;
    drcCardPopover.classList.remove("hidden");
    const margin = 8;
    const r = head.getBoundingClientRect();
    const pop = drcCardPopover.getBoundingClientRect();
    let left = r.right - 34 + 8 - pop.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pop.width - margin));
    let top = r.top + r.height / 2 + 14;
    if (top + pop.height > window.innerHeight - margin) top = r.top + r.height / 2 - pop.height - 14;
    drcCardPopover.style.left = `${left}px`;
    drcCardPopover.style.top = `${Math.max(margin, top)}px`;
  }

  // The recolor ring is drawn by CSS (::after) on the card's heading line,
  // so there's no real button to click — a click/tap counts as hitting it
  // when it lands on a heading line's right-hand edge.
  function drcCardDotHit(root, e) {
    const head = e.target && e.target.closest ? e.target.closest(".drc-card-head") : null;
    if (!head || head.parentNode !== root) return null;
    const r = head.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    return (e.clientX >= r.right - 38 && e.clientX <= r.right && Math.abs(e.clientY - cy) <= 18) ? head : null;
  }
  // `canEdit()` gates it (a locked note shouldn't be recolorable);
  // `apply(head, color)` writes the color and does whatever refresh/save
  // the owning editor needs.
  function bindDRCCardColorDot(root, canEdit, apply) {
    root.addEventListener("mousedown", (e) => { if (drcCardDotHit(root, e)) e.preventDefault(); });
    root.addEventListener("click", (e) => {
      const head = drcCardDotHit(root, e);
      if (!head || !canEdit()) return;
      e.preventDefault();
      e.stopPropagation();
      openDrcCardPopover(head, (color) => apply(head, color));
    });
    root.addEventListener("mousemove", (e) => {
      root.style.cursor = drcCardDotHit(root, e) ? "pointer" : "";
    });
  }

