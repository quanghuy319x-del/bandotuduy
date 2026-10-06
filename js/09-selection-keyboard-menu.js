/* Branchline — js/09-selection-keyboard-menu.js
   Part 9 of 19 of the former single-file app.js. Contents: selection / editing, cross-links, move-to-new-parent (context menu), keyboard, context menu.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- selection / editing ---------------- */

  function findNode(id, node = state.current && state.current.root) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const r = findNode(id, c);
      if (r) return r;
    }
    return null;
  }

  function findParent(id, node = state.current && state.current.root) {
    if (!node) return null;
    for (const c of node.children || []) {
      if (c.id === id) return node;
      const r = findParent(id, c);
      if (r) return r;
    }
    return null;
  }

  // Every node in the current map, regardless of collapsed state — unlike
  // the layout/render walks (which skip collapsed branches because they
  // don't need to be drawn), callers like the photo-tag browser need to
  // find tagged photos even when they're tucked inside a collapsed branch.
  function collectAllNodesFlat(node = state.current && state.current.root, out = []) {
    if (!node) return out;
    out.push(node);
    (node.children || []).forEach(c => collectAllNodesFlat(c, out));
    return out;
  }

  // v419: content-host parity. A table/calendar cell is a mini-node for
  // content features; only its visual/container form differs from a node.
  function contentNodeLabel(node) {
    if (!node) return "Untitled node";
    const text = String(node.text || "").trim();
    if (text) return text;
    const title = node.table && node.table.cells && node.table.cells[0] && node.table.cells[0][0];
    return String(title || "").trim() || "Untitled node";
  }
  function contentCellLabel(node, r, c) {
    const value = node && node.table && node.table.cells && node.table.cells[r]
      ? String(node.table.cells[r][c] || "").trim()
      : "";
    return value || `Cell ${r + 1},${c + 1}`;
  }
  // v525: label used for auto-naming Brainstorm/DRC notes. Calendar date
  // cells include their real month (including spillover dates), e.g. 30/9.
  function contentHostAutoTitleBase(node, cellPos) {
    if (!cellPos) return contentNodeLabel(node);
    const r = cellPos.r, c = cellPos.c;
    if (node && node.table && node.table.calendar && r >= 2) {
      const year = Number(node.table.calendarYear);
      const month = Number(node.table.calendarMonth);
      if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
        const start = Number.isFinite(Number(node.table.calendarStart))
          ? Number(node.table.calendarStart)
          : (new Date(year, month - 1, 1).getDay() + 6) % 7;
        const offset = (r - 2) * 7 + c - start;
        const d = new Date(year, month - 1, 1 + offset);
        return `${d.getDate()}/${d.getMonth() + 1}`;
      }
    }
    return contentCellLabel(node, r, c);
  }
  function specialNoteAutoTitle(node, cellPos, kind) {
    return `${contentHostAutoTitleBase(node, cellPos)} ${kind}`.trim();
  }
  function collectContentHosts() {
    const out = [];
    collectAllNodesFlat().forEach((node) => {
      const nodeLabel = contentNodeLabel(node);
      out.push({ node, host: node, r: null, c: null, nodeLabel, hostLabel: nodeLabel });
      if (!node.table || !Array.isArray(node.table.attach)) return;
      node.table.attach.forEach((row, r) => (row || []).forEach((host, c) => {
        if (!host) return;
        out.push({
          node, host, r, c, nodeLabel,
          hostLabel: `${nodeLabel} → ${contentCellLabel(node, r, c)}`
        });
      }));
    });
    return out;
  }
  function browserItemHost(node, item) {
    if (!node || !item) return null;
    return item.r != null && item.c != null ? getCellAttach(node, item.r, item.c) : node;
  }
  function browserItemCellPos(item) {
    return item && item.r != null && item.c != null ? { r: item.r, c: item.c } : null;
  }
  function videoItemKey(nodeId, r, c, url) {
    return r != null && c != null
      ? `${nodeId}|cell:${r},${c}|${url}`
      : `${nodeId}|${url}`;
  }
  function photoGroupItemMatches(it, nodeId, cellPos, id) {
    const r = cellPos ? cellPos.r : null;
    const c = cellPos ? cellPos.c : null;
    return !!it && it.nodeId === nodeId &&
      (it.r ?? null) === r && (it.c ?? null) === c && it.id === id;
  }
  function openBrowserPhotoItem(item, index, group) {
    if (!item) return;
    if (item.r != null && item.c != null) {
      openCellPhotoModal(item.nodeId, item.r, item.c, index, group);
    } else {
      openPhotoModal(item.nodeId, index, group);
    }
  }

  // Un-collapses every ancestor of a node so it's actually visible/findable
  // in the DOM before we try to select or center the camera on it.
  function expandAncestorsOf(id) {
    let cur = findParent(id);
    while (cur) {
      cur.collapsed = false;
      cur = findParent(cur.id);
    }
  }

  // Groups every photo tag used anywhere in the current map by tag text
  // (case-insensitively, keeping whichever casing was typed first), each
  // with the list of {nodeId, id} photos carrying that tag. Powers the
  // "Photo tags" browser.
  function collectPhotoTagGroups() {
    const groups = new Map();
    let cleaned = false;
    collectContentHosts().forEach(({ node, host, r, c, hostLabel }) => {
      if (!host.photoTags) return;
      const liveIds = new Set(getNodeImageIds(host));
      Object.keys(host.photoTags).forEach((id) => {
        if (!liveIds.has(id)) {
          delete host.photoTags[id];
          cleaned = true;
          return;
        }
        (host.photoTags[id] || []).forEach((tag) => {
          const key = tag.toLowerCase();
          if (!groups.has(key)) groups.set(key, { label: tag, items: [] });
          groups.get(key).items.push({ nodeId: node.id, r, c, id, hostLabel });
        });
      });
    });
    if (cleaned) persist();
    return Array.from(groups.values()).sort((a, b) =>
      b.items.length - a.items.length || a.label.localeCompare(b.label));
  }

  // Selects a node, expanding any collapsed ancestors so it renders, then
  // pans/centers the camera on it.
  function focusNodeInCanvas(nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    expandAncestorsOf(nodeId);
    state.selectedId = nodeId;
    state.editingId = null;
    renderAll();
    requestAnimationFrame(() => {
      const div = nodesLayer.querySelector(`.node[data-id="${nodeId}"]`);
      if (div) {
        const cx = div.offsetLeft + div.offsetWidth / 2;
        const cy = div.offsetTop + div.offsetHeight / 2;
        const vw = viewportEl.clientWidth;
        const vh = viewportEl.clientHeight;
        state.tx = vw / 2 - cx * state.scale;
        state.ty = vh / 2 - cy * state.scale;
        applyTransform();
        persistViewOnly();
      }
    });
  }

  // Selects a node, pans/centers the camera on it, and optionally opens the
  // photo modal to a specific photo on that node once the camera's
  // settled — used when jumping to a photo from the tag browser. When
  // `tagGroup` is passed, the main photo modal's prev/next will continue
  // stepping through every photo sharing that tag (across nodes) instead
  // of just this node's own photos.
  function jumpToNode(nodeId, focusId, tagGroup) {
    const node = findNode(nodeId);
    if (!node) return;
    focusNodeInCanvas(nodeId);
    requestAnimationFrame(() => {
      if (focusId) {
        const idx = getNodeImageIds(node).indexOf(focusId);
        if (idx >= 0) openPhotoModal(nodeId, idx, tagGroup);
      }
    });
  }

  // Flat list of every descendant under `node` (not including node itself),
  // used to drag a whole branch as one unit and to reset it after a reparent.
  function collectDescendants(node) {
    const list = [];
    (function walk(n) {
      (n.children || []).forEach(c => { list.push(c); walk(c); });
    })(node);
    return list;
  }

  // True if `id` belongs to node's own subtree (itself or any descendant) —
  // used to stop a branch from being dropped onto itself or its own child.
  function isWithinSubtree(node, id) {
    if (node.id === id) return true;
    for (const c of node.children || []) {
      if (isWithinSubtree(c, id)) return true;
    }
    return false;
  }

  // Moves a node (and everything under it) to become the last child of a
  // different node — this is what a completed drag-to-reparent does.
  function reparentNode(nodeId, newParentId) {
    const node = findNode(nodeId);
    const newParent = findNode(newParentId);
    if (!node || !newParent) return;
    const oldParent = findParent(nodeId);
    if (!oldParent) return; // the central node has no parent — can't be moved
    const idx = oldParent.children.findIndex(c => c.id === nodeId);
    if (idx === -1) return;
    oldParent.children.splice(idx, 1);
    newParent.children.push(node);
    newParent.collapsed = false;
    // Drop the manual nudge offset so the branch settles into its fresh
    // auto-layout spot under the new parent instead of an old, unrelated one.
    // Reset the whole subtree, not just the moved node, since it was dragged
    // (and dropped) as one unit.
    node.ox = 0;
    node.oy = 0;
    // Drop any explicit left/right override the node had picked up from a
    // drag under its old parent — under the new parent it should go back
    // to inheriting that branch's side until the user flips it again.
    node.side = null;
    // Same for an explicit above/below override from Timeline mode — it
    // only means anything for a direct child of the root, so it doesn't
    // carry over to a new (non-root) parent.
    node.vSide = null;
    // Same for the cached Timeline auto-balanced side (see layoutTimeline)
    // — it's scoped to whichever branch's left/right split it was computed
    // against, so it doesn't carry over to a new parent either.
    node._autoSide = null;
    // Same for a custom connector distance — a distance tailored to the
    // old parent isn't meaningful under a new one.
    node.xGap = null;
    // A node's own .color only ever means "this is a top-level branch and
    // this is its branch color" (set by assignBranchColors, or by the
    // "Branch color" swatch picker) — every other node just inherits
    // whichever branch it descends from (see branchColorFor), it never
    // has a real .color of its own. So if this node WAS a top-level
    // branch and is now being tucked under a different node, drop that
    // leftover color; left in place, it would keep outranking (via
    // `node.color || branchColorFor(...)`) the color of whatever branch
    // it's actually part of now, forever. Its own descendants can never
    // end up at depth 1 as a result of this move either (only `node`
    // itself, if dropped directly on the root, can) — clear any
    // color they're separately carrying from a past life too.
    if (newParent !== state.current.root) node.color = null;
    collectDescendants(node).forEach(d => { d.ox = 0; d.oy = 0; d._autoSide = null; d.color = null; });
    state.selectedId = node.id;
    renderAll();
  }

  // While dragging, checks whether the node has been pulled far enough past
  // an adjacent sibling (same parent) to swap places with it — repeated so a
  // fast drag can hop past more than one sibling in a single move. Returns
  // true if the sibling order actually changed, so the caller knows to
  // re-run layout. For most nodes this is a plain positional swap. For a
  // root-level branch in Mindmap layout, swapping past a sibling on the
  // *other* side of the map is treated as the user dragging that branch
  // across the center line: only the dragged node's side flips to follow
  // it — the neighbor it passed keeps whichever side it was already on, so
  // one drag never yanks an unrelated branch to the opposite side too.
  // Reorders a node among its siblings to match where it's currently being
  // dragged, vertically. This only ever touches array order (top-to-bottom
  // stacking) — it must NOT also decide the node's left/right side. Left
  // and right branches sit interleaved in the same array (not grouped), so
  // a purely vertical drag can easily swap past a sibling that happens to
  // be on the other side; flipping side on that alone was causing nodes to
  // jump to the opposite side from a plain up/down drag. Side is decided
  // separately, only from actual horizontal position, by
  // maybeFlipSideOnDrop() once the drag ends.
  function maybeReorderSiblings(node, targetAbsY) {
    const parent = findParent(node.id);
    if (!parent || !parent.children || parent.children.length < 2) return false;
    const siblings = parent.children;
    let idx = siblings.indexOf(node);
    if (idx === -1) return false;
    let changed = false;

    while (idx > 0 && targetAbsY < siblings[idx - 1]._y) {
      siblings[idx] = siblings[idx - 1];
      siblings[idx - 1] = node;
      idx--;
      changed = true;
    }
    while (idx < siblings.length - 1 && targetAbsY > siblings[idx + 1]._y) {
      siblings[idx] = siblings[idx + 1];
      siblings[idx + 1] = node;
      idx++;
      changed = true;
    }

    if (!changed) return false;
    layout(state.current.root);
    return true;
  }

  // Called once a drag finishes (mouseup), for any node at any depth in
  // Mindmap or Timeline layout: if the node ended up on the opposite side
  // of the center line from where it's currently drawn, give it an
  // explicit side override so it — and everything under it, via
  // place()/placeLocal() — flips to fan out the other way instead of
  // staying stuck following its parent branch's side. Returns true if a
  // flip happened, so the caller knows to snap the drag offset back to
  // zero and re-render.
  function maybeFlipSideOnDrop(node) {
    const layoutMode = (state.current && state.current.layout) || "mindmap";
    // "Righty mindmap" only ever fans one direction (right), so there's
    // no opposite side to flip to.
    if (layoutMode === "logic" || layoutMode === "righty") return false;
    // node._x is 0 for the root, and also for a Timeline branch's own node
    // (it sits directly on the spine) — neither has a side of its own to
    // flip; only their descendants do.
    if (!node._x) return false;
    // In Mindmap mode only a top-level branch (depth 1) can have its own
    // side — every deeper node just inherits its branch's direction (see
    // layoutMindmap's place()), so setting .side on a deeper node here
    // would have no visible effect. Block it rather than silently writing
    // a .side that layout ignores.
    if (layoutMode === "mindmap" && node._depth !== 1) return false;
    const finalWorldX = node._x + (node.ox || 0);
    if (finalWorldX === 0) return false;
    const curSide = node._x > 0 ? "right" : "left";
    const newSide = finalWorldX > 0 ? "right" : "left";
    if (newSide === curSide) return false;
    node.side = newSide;
    return true;
  }

  // Same idea, but live — called on every mousemove while a node is being
  // dragged, so its subtree flips direction the instant it crosses the
  // center line instead of waiting for the mouse to be released. Besides
  // setting the side, this has to keep the drag feeling continuous: the
  // dragged node must stay exactly under the cursor across the flip (its
  // own _x jumps when the side changes, so ox/startOx are re-anchored to
  // compensate), and every descendant is re-anchored to that SAME (ox, oy)
  // offset — not reset to zero — so the whole subtree keeps moving as one
  // rigid unit. That matters because each connector's on-screen length is
  // (clean gap) + (this node's ox − its parent's ox): as long as every
  // node in the subtree shares the identical ox/oy, that second term stays
  // zero and every connector's distance is exactly its clean gap,
  // unchanged by the flip — only the underlying clean layout (and so which
  // direction each hop fans) actually mirrors.
  function maybeFlipSideDuringDrag(node, dxLocal, dyLocal) {
    const layoutMode = (state.current && state.current.layout) || "mindmap";
    if (layoutMode === "logic" || layoutMode === "righty") return false;
    if (!node._x) return false;
    if (layoutMode === "mindmap" && node._depth !== 1) return false;
    const worldX = node._x + (node.ox || 0);
    const worldY = node._y + (node.oy || 0);
    if (worldX === 0) return false;
    const curSide = node._x > 0 ? "right" : "left";
    const newSide = worldX > 0 ? "right" : "left";
    if (newSide === curSide) return false;

    node.side = newSide;
    layout(state.current.root);

    node.ox = worldX - node._x;
    node.oy = worldY - node._y;
    dragCandidate.startOx = node.ox - dxLocal;
    // Vertical layout can shift too (e.g. a top-level branch moving
    // between the left/right lists re-centers both), so re-anchor the
    // reorder target the same way the horizontal one is re-anchored above.
    dragCandidate.startAbsY = worldY - dyLocal;

    dragCandidate.descendants.forEach(d => {
      d.startOx = node.ox - dxLocal;
      d.startOy = node.oy - dyLocal;
    });

    return true;
  }

  // Same idea as maybeFlipSideOnDrop, but for a Timeline branch's place
  // relative to the root along the vertical spine rather than a node's
  // side of a horizontal fan. Every top-level branch used to be locked
  // below the root, so there was nothing to flip; now dragging one up
  // past the root's own center gives it an explicit node.vSide =
  // "above" override (mirroring .side/"left"/"right"), sending it onto
  // the top half of the spine instead — everything else about it
  // (its own left/right-fanning children, its color, etc.) is untouched.
  // A null/missing vSide always means "below", the original default, so
  // maps saved before this feature keeps every branch exactly where it
  // was.
  function maybeFlipVSideOnDrop(node) {
    const layoutMode = (state.current && state.current.layout) || "mindmap";
    // Only a top-level branch sits directly on the spine; anything deeper
    // just fans left/right off its own branch and has no "above/below
    // the root" position of its own to flip.
    if (layoutMode !== "timeline" || node._depth !== 1) return false;
    const finalWorldY = node._y + (node.oy || 0);
    if (finalWorldY === 0) return false;
    const curVSide = node.vSide === "above" ? "above" : "below";
    const newVSide = finalWorldY < 0 ? "above" : "below";
    if (newVSide === curVSide) return false;
    node.vSide = newVSide === "above" ? "above" : null;
    return true;
  }

  // Live version of maybeFlipVSideOnDrop, called on every mousemove so a
  // branch crosses onto the other half of the spine the instant it's
  // dragged past the root, same continuous-drag treatment
  // maybeFlipSideDuringDrag gives a left/right flip: the node stays under
  // the cursor across the flip (oy/startAbsY re-anchored to compensate)
  // and every descendant rides along on that same offset so the whole
  // branch keeps moving as one rigid unit.
  function maybeFlipVSideDuringDrag(node, dxLocal, dyLocal) {
    const layoutMode = (state.current && state.current.layout) || "mindmap";
    if (layoutMode !== "timeline" || node._depth !== 1) return false;
    const worldX = node._x + (node.ox || 0);
    const worldY = node._y + (node.oy || 0);
    const curVSide = node.vSide === "above" ? "above" : "below";
    const newVSide = worldY < 0 ? "above" : "below";
    if (newVSide === curVSide) return false;

    node.vSide = newVSide === "above" ? "above" : null;
    layout(state.current.root);

    node.ox = worldX - node._x;
    node.oy = worldY - node._y;
    dragCandidate.startOx = node.ox - dxLocal;
    dragCandidate.startAbsY = worldY - dyLocal;

    dragCandidate.descendants.forEach(d => {
      d.startOx = node.ox - dxLocal;
      d.startOy = node.oy - dyLocal;
    });

    return true;
  }

  // While dragging a node, figure out whether the pointer is currently over
  // a different, droppable node, and keep the highlight in sync.
  function updateDropTarget(e, node) {
    let targetId = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetDiv = el && el.closest ? el.closest(".node[data-id]") : null;
    if (targetDiv) {
      const id = targetDiv.dataset.id;
      // Hovering over the node's OWN current parent isn't a meaningful
      // reparent (it's already there) — most importantly, that parent is
      // very often the root itself, and in Timeline mode a top-level
      // branch has to pass right over the root's box on its way to being
      // dragged above it. Without this guard, releasing the mouse there
      // was read as "drop onto root" (reparentNode), which silently
      // resets the branch's vSide/side/order — instead of the intended
      // above/below flip (see maybeFlipVSideOnDrop/maybeFlipSideOnDrop),
      // which only ever fires once no drop target is set.
      const curParent = findParent(node.id);
      const isOwnParent = curParent && curParent.id === id;
      if (id !== node.id && !isOwnParent && !isWithinSubtree(node, id)) targetId = id;
    }
    if (dragCandidate.dropTargetId && dragCandidate.dropTargetId !== targetId) {
      const prevDiv = nodesLayer.querySelector(`.node[data-id="${dragCandidate.dropTargetId}"]`);
      if (prevDiv) prevDiv.classList.remove("drop-target");
    }
    dragCandidate.dropTargetId = targetId;
    if (targetId) {
      const div = nodesLayer.querySelector(`.node[data-id="${targetId}"]`);
      if (div) div.classList.add("drop-target");
    }
  }

  // Toggles just the .selected class between two nodes' existing DOM
  // elements — used instead of a full renderAll() when a click only
  // changes which node is selected (see selectNode below). A full
  // renderAll() tears down and rebuilds every node's DOM from scratch,
  // which would reset other per-node DOM state on every single click.
  function updateSelectedClasses(prevId, id) {
    if (prevId) {
      const prevDiv = nodesLayer.querySelector(`.node[data-id="${prevId}"]`);
      if (prevDiv) prevDiv.classList.remove("selected");
    }
    if (id) {
      const div = nodesLayer.querySelector(`.node[data-id="${id}"]`);
      if (div) div.classList.add("selected");
    }
  }

  function selectNode(id, cellPos) {
    if (state.editingId === id) { state.selectedCell = cellPos || null; return; } // a click inside the box being edited is just caret placement, not a request to stop editing
    const wasEditing = !!state.editingId;
    commitEditIfActive({ render: false });
    const prevId = state.selectedId;
    state.selectedId = id;
    state.selectedCell = cellPos || null;
    if (wasEditing) {
      // Text/size may have just changed, which can shift the whole
      // layout — needs the real thing.
      renderAll();
      return;
    }
    updateSelectedClasses(prevId, id);
  }

  function startEdit(id) {
    if (!requireSignIn()) return;
    state.selectedId = id;
    state.editingId = id;
    renderAll();
  }

  // `render` can be set to false by a caller that is about to make further
  // state changes (e.g. creating and focusing a new node) and will do its
  // own single renderAll() afterward — see commitEditIfActive below for why
  // that matters on touch devices.
  function commitEdit(div, { render = true } = {}) {
    const id = div.dataset.id;
    const node = findNode(id);
    if (!node) return;
    const text = getEditableText(div);
    if (node.text !== text) {
      pushUndo();
      node.text = text;
      // The central/root node's text doubles as the map's title everywhere
      // else (sidebar list, title field) — keep them in sync.
      if (state.current && node.id === state.current.root.id) {
        state.current.title = text;
        titleInput.value = text;
        renderSidebar();
      }
    }
    state.editingId = null;
    if (render) renderAll();
    persist();
  }

  // Saves whatever is currently being typed before anything else (switching
  // maps, selecting another node, clicking empty canvas) is allowed to clear
  // state.editingId. Every place that ends editing should call this first —
  // otherwise the in-progress text is discarded instead of saved, which is
  // what was happening when clicking outside a node's box.
  //
  // Pass { render: false } when the caller is going to change more state
  // right after (e.g. fabTargetNode, before creating+focusing a new node)
  // and will call renderAll() itself once at the end. Doing two separate
  // renderAll() passes back-to-back — one here to exit the old node's edit,
  // one later to create and focus the new node — makes the whole sequence
  // take long enough that touch browsers stop treating the later focus()
  // as part of the original tap, so the on-screen keyboard doesn't reopen
  // even though focus visibly lands on the new node.
  function commitEditIfActive({ render = true } = {}) {
    if (!state.editingId) return;
    const div = nodesLayer.querySelector(`.node[data-id="${state.editingId}"]`);
    if (div) commitEdit(div, { render });
    else state.editingId = null;
  }

  function addChild(parentId) {
    if (!requireSignIn()) return null;
    const parent = findNode(parentId);
    if (!parent) return null;
    pushUndo();
    const n = newNode("");
    if (typeof parent.childrenGap === "number" && parent.childrenGap >= 0) {
      n.xGap = parent.childrenGap;
      n.childrenGap = parent.childrenGap;
    }
    // A branch-level font color is a style for the whole subtree, not only
    // the nodes that happened to exist when the color was chosen. New
    // descendants therefore inherit the parent's explicit fontColor too.
    n.fontColor = parent.fontColor || null;
    parent.children.push(n);
    parent.collapsed = false;
    return n;
  }

  // Same idea as addChild, but the new node holds a small editable grid
  // (see nodeIsTable) instead of a plain text label — offered from the
  // node right-click menu as "Add table child".
  function addTableChild(parentId) {
    if (!requireSignIn()) return null;
    const parent = findNode(parentId);
    if (!parent) return null;
    pushUndo();
    const n = newNode("");
    if (typeof parent.childrenGap === "number" && parent.childrenGap >= 0) {
      n.xGap = parent.childrenGap;
      n.childrenGap = parent.childrenGap;
    }
    n.fontColor = parent.fontColor || null;
    n.table = { cells: defaultTableCells() };
    parent.children.push(n);
    parent.collapsed = false;
    return n;
  }

  function addCalendarChild(parentId) {
    if (!requireSignIn()) return null;
    const parent = findNode(parentId);
    if (!parent) return null;

    const raw = prompt("Calendar month (MM/YY) — leave empty for automatic", "");
    if (raw === null) return null;

    let month, year;
    const entered = raw.trim();
    if (!entered) {
      // Empty input is context-aware:
      // - from a calendar node, continue with the next month;
      // - from any other node, create the current month.
      if (parent.table && parent.table.calendar) {
        const baseMonth = Number(parent.table.calendarMonth) || (new Date().getMonth() + 1);
        const baseYear = Number(parent.table.calendarYear) || new Date().getFullYear();
        const next = new Date(baseYear, baseMonth, 1); // JS month is 0-based; baseMonth => next month
        month = next.getMonth() + 1;
        year = next.getFullYear();
      } else {
        const now = new Date();
        month = now.getMonth() + 1;
        year = now.getFullYear();
      }
    } else {
      const m = entered.match(/^(0?[1-9]|1[0-2])\/(\d{2}|\d{4})$/);
      if (!m) { alert("Enter month as MM/YY, for example 09/26, or leave it empty."); return null; }
      month = Number(m[1]);
      year = Number(m[2]);
      if (year < 100) year += 2000;
    }
    pushUndo();
    const n = newNode("");
    if (typeof parent.childrenGap === "number" && parent.childrenGap >= 0) {
      n.xGap = parent.childrenGap;
      n.childrenGap = parent.childrenGap;
    }
    n.fontColor = parent.fontColor || null;

    // v404: calendar children use the familiar Monday→Sunday week order.
    // Keep a complete six-week grid, including faded neighboring-month dates.
    const cells = [
      [String(month).padStart(2, "0") + "/" + String(year).slice(-2), "", "", "", "", "", ""],
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    ];
    const first = new Date(year, month - 1, 1);
    const start = (first.getDay() + 6) % 7; // Monday = 0
    const prevDays = new Date(year, month - 1, 0).getDate();
    const days = new Date(year, month, 0).getDate();
    let nextDay = 1;
    for (let week = 0; week < 6; week++) {
      const row = new Array(7).fill("");
      for (let col = 0; col < 7; col++) {
        const slot = week * 7 + col;
        const dayIndex = slot - start + 1;
        if (dayIndex < 1) row[col] = String(prevDays + dayIndex);
        else if (dayIndex > days) row[col] = String(nextDay++);
        else row[col] = String(dayIndex);
      }
      cells.push(row);
    }
    n.table = {
      cells,
      gridStyle: "grid",
      calendar: true,
      calendarStyle: "classic",
      calendarMonth: month,
      calendarYear: year,
      calendarStart: start,
      calendarWeekStartsMonday: true,
      merges: [{ r0: 0, c0: 0, r1: 0, c1: 6 }]
    };
    parent.children.push(n);
    parent.collapsed = false;
    return n;
  }

  function tableAddRow(node) {
    const cols = (node.table.cells[0] || [""]).length;
    node.table.cells.push(new Array(cols).fill(""));
  }
  function tableAddColumn(node) {
    node.table.cells.forEach(row => row.push(""));
  }
  function tableRemoveRow(node) {
    if (node.table.cells.length > 1) node.table.cells.pop();
  }
  function tableRemoveColumn(node) {
    if (node.table.cells[0].length > 1) node.table.cells.forEach(row => row.pop());
  }

  function addSibling(nodeId) {
    if (!requireSignIn()) return null;
    const node = findNode(nodeId);
    if (!node) return null;
    const parent = findParent(nodeId);
    if (!parent) return addChild(nodeId); // root has no siblings -> add child instead
    pushUndo();
    const n = newNode("");
    if (typeof parent.childrenGap === "number" && parent.childrenGap >= 0) {
      n.xGap = parent.childrenGap;
      n.childrenGap = parent.childrenGap;
    }
    // Siblings belong to the same branch level, so they inherit the common
    // parent's branch font color rather than falling back to the original
    // automatic/default color.
    n.fontColor = parent.fontColor || null;
    const idx = parent.children.findIndex(c => c.id === nodeId);
    parent.children.splice(idx + 1, 0, n);
    return n;
  }

  function deleteBranch(nodeId) {
    if (!requireSignIn()) return;
    const parent = findParent(nodeId);
    if (!parent) { alert("The central idea can't be deleted."); return; }
    const node = findNode(nodeId);
    if (node.children && node.children.length > 0) {
      if (!confirm("Delete this node and all its children?")) return;
    }
    pushUndo();
    const removedIds = new Set();
    (function collect(n) { removedIds.add(n.id); (n.children || []).forEach(collect); })(node);
    parent.children = parent.children.filter(c => c.id !== nodeId);
    // any cross-link touching a node that no longer exists gets cleaned up too
    if (state.current.links && state.current.links.length) {
      state.current.links = state.current.links.filter(l => !removedIds.has(l.a) && !removedIds.has(l.b));
    }
    state.selectedId = parent.id;
    renderAll();
    persist();
  }

  /* ---------------- cross-links ---------------- */

  let defaultHintHTML = null;
  function updateLinkHint() {
    if (!hintBar) return;
    if (defaultHintHTML === null) defaultHintHTML = hintBar.innerHTML;
    if (state.linkFromId) {
      viewportEl.classList.add("linking");
      viewportEl.classList.remove("moving");
      hintBar.innerHTML = `<span>Click another node to link it &middot; <kbd>Esc</kbd> cancel</span>`;
    } else if (state.moveSourceId) {
      viewportEl.classList.remove("linking");
      viewportEl.classList.add("moving");
      hintBar.innerHTML = `<span>Right-click the new parent and choose "Move to here" &middot; or click a different map in the sidebar to move it there &middot; <kbd>Esc</kbd> cancel</span>`;
    } else {
      viewportEl.classList.remove("linking");
      viewportEl.classList.remove("moving");
      hintBar.innerHTML = defaultHintHTML;
    }
  }

  // Enters "pick the other end" mode: the next node the person clicks gets
  // linked to `nodeId`. Clicking the same node, empty canvas, or Escape
  // cancels it instead of completing a link.
  function startLinkFrom(nodeId) {
    if (!findNode(nodeId)) return;
    commitEditIfActive();
    state.linkFromId = nodeId;
    state.editingId = null;
    renderAll();
  }

  function cancelLinking() {
    if (!state.linkFromId) return;
    state.linkFromId = null;
    renderAll();
  }

  /* ---------------- move-to-new-parent (context menu) ---------------- */

  // Enters "pick the destination" mode: right-clicking a different node
  // next and choosing "Move to here" reparents `nodeId` there. This is a
  // click-based alternative to drag-and-drop reparenting — same end
  // result (reparentNode), just without needing to drag across a
  // possibly zoomed-out/scrolled canvas. Mirrors startLinkFrom above.
  function startMoveFrom(nodeId) {
    if (!findNode(nodeId)) return;
    commitEditIfActive();
    state.moveSourceId = nodeId;
    state.linkFromId = null;
    state.editingId = null;
    renderAll();
    renderSidebar(); // highlights every OTHER map as a drop target too (see completeMoveToMap)
  }

  function cancelMove() {
    if (!state.moveSourceId) return;
    state.moveSourceId = null;
    renderAll();
    renderSidebar();
  }

  // Whether targetId is a legal drop point for the pending move: not the
  // node itself, not somewhere inside its own subtree (would orphan it),
  // and not its current parent already (a no-op that would still cost an
  // undo step and a save).
  function canMoveSourceTo(targetId) {
    const srcId = state.moveSourceId;
    if (!srcId || !targetId || srcId === targetId) return false;
    const src = findNode(srcId);
    if (!src || !findNode(targetId)) return false;
    if (isWithinSubtree(src, targetId)) return false;
    const parent = findParent(srcId);
    if (parent && parent.id === targetId) return false;
    return true;
  }

  function completeMoveTo(targetId) {
    const srcId = state.moveSourceId;
    if (!canMoveSourceTo(targetId)) { state.moveSourceId = null; renderAll(); renderSidebar(); return; }
    state.moveSourceId = null;
    pushUndo();
    reparentNode(srcId, targetId);
    renderSidebar();
    persist();
  }

  // The cross-map counterpart of completeMoveTo: instead of picking a new
  // parent within the same tree (right-click → "Move to here"), the person
  // picks a whole different map from the sidebar while a move is pending
  // (see renderSidebar's .move-target rows). The moved branch lands as a
  // new top-level child of that map's root — same one-click simplicity as
  // the same-map version. Once it's there, opening that map and dragging
  // it deeper works exactly like any other reparent.
  async function completeMoveToMap(targetMapId) {
    const srcId = state.moveSourceId;
    const src = findNode(srcId);
    const parent = findParent(srcId);
    const targetMap = state.maps.find(m => m.id === targetMapId);
    state.moveSourceId = null;
    if (!src || !parent || !targetMap || !state.current || targetMap.id === state.current.id) {
      renderAll();
      renderSidebar();
      return;
    }
    pushUndo();

    // Detach from the source map's tree (mirrors reparentNode's removal
    // half) and drop any cross-links that touched the moved subtree — a
    // link is two node ids inside ONE map's `links` array, so a link to a
    // node about to live in a different map can't be expressed anymore.
    const movedIds = new Set();
    (function collect(n) { movedIds.add(n.id); (n.children || []).forEach(collect); })(src);
    parent.children = parent.children.filter(c => c.id !== srcId);
    if (state.current.links && state.current.links.length) {
      state.current.links = state.current.links.filter(l => !movedIds.has(l.a) && !movedIds.has(l.b));
    }
    if (state.selectedId && movedIds.has(state.selectedId)) state.selectedId = parent.id;
    if (state.highlightId && movedIds.has(state.highlightId)) state.highlightId = null;

    // The destination map may not have been opened yet this session, so
    // it could still be missing fields the running code assumes exist —
    // bring it up to date with the same one-time migrations openMap()
    // applies before writing into it.
    ensureTheme(targetMap);
    ensureLinks(targetMap);
    ensureLayout(targetMap);
    ensureFavorite(targetMap);
    ensureTrash(targetMap);
    ensureSidesRepaired(targetMap);
    ensureAffirmationMigrated(targetMap);
    if (!targetMap._photosMigrated) await ensurePhotosMigrated(targetMap);

    // The moved subtree's own photos live in PhotoDB tagged with the
    // source map's id (see PhotoDB/loadPhotoCacheForMap) — re-tag every
    // one to the destination map so it isn't orphaned there and actually
    // loads once that map is opened.
    const photoIds = collectReferencedPhotoIds(src);
    // src is already detached from the source tree, so this is what the
    // nodes staying behind still use.
    const stayingPhotoIds = collectReferencedPhotoIds(state.current.root);
    for (const id of photoIds) {
      const blob = photoBlobCache.get(id);
      if (blob === undefined) continue; // already gone/never loaded — nothing to carry over
      if (stayingPhotoIds.has(id)) {
        // Shared with a node that stays in this map: the moved branch gets
        // its own copy (new id) in the destination, the original stays put.
        try {
          const copyId = uid();
          (function swapIn(n) { replacePhotoIdInNode(n, id, copyId); (n.children || []).forEach(swapIn); })(src);
          await PhotoDB.put({ id: copyId, mapId: targetMap.id, blob });
        } catch (e) { console.error("Copying shared photo to new map failed", e); }
        continue;
      }
      try {
        await PhotoDB.put({ id, mapId: targetMap.id, blob });
        // No longer part of the currently-open (source) map — drop it
        // from both caches, revoking its object URL so the Blob isn't
        // held alive by a URL nothing points to anymore.
        const url = photoCache.get(id);
        if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ } }
        photoCache.delete(id);
        photoBlobCache.delete(id);
      } catch (e) { console.error("Moving photo to new map failed", e); }
    }

    // Same reset reparentNode applies when a branch lands under a new
    // parent — a manual nudge offset, an explicit left/right or Timeline
    // above/below override, a custom connector distance, and a top-level
    // branch color all only ever made sense relative to the old map, not
    // this one.
    targetMap.root.collapsed = false;
    if (!targetMap.root.children) targetMap.root.children = [];
    targetMap.root.children.push(src);
    src.ox = 0; src.oy = 0; src.side = null; src.vSide = null; src._autoSide = null; src.xGap = null; src.color = null;
    collectDescendants(src).forEach(d => { d.ox = 0; d.oy = 0; d._autoSide = null; d.color = null; });

    try {
      await DB.put(targetMap);
      await FolderDB.save(targetMap);
      await DriveDB.save(targetMap);
    } catch (e) { console.error("Saving the moved-to map failed", e); }

    renderAll();
    renderSidebar();
    persist(); // saves state.current (the source map) with the branch removed
  }

  function linkExists(aId, bId) {
    return (state.current.links || []).some(l =>
      (l.a === aId && l.b === bId) || (l.a === bId && l.b === aId));
  }

  function completeLinkTo(targetId) {
    const fromId = state.linkFromId;
    state.linkFromId = null;
    if (!fromId || !targetId || fromId === targetId) { renderAll(); return; }
    if (!findNode(fromId) || !findNode(targetId)) { renderAll(); return; }
    if (linkExists(fromId, targetId)) { renderAll(); return; }
    pushUndo();
    if (!state.current.links) state.current.links = [];
    state.current.links.push({ id: uid(), a: fromId, b: targetId });
    renderAll();
    persist();
  }

  function linksForNode(nodeId) {
    return (state.current.links || []).filter(l => l.a === nodeId || l.b === nodeId);
  }

  function removeLink(linkId) {
    if (!state.current || !state.current.links) return;
    pushUndo();
    state.current.links = state.current.links.filter(l => l.id !== linkId);
    renderAll();
    persist();
  }

  /* ---------------- keyboard ---------------- */

  function nodeKeydown(e, node, div) {
    const editing = state.editingId === node.id;
    if (editing) {
      if (e.key === "Tab") {
        e.preventDefault();
        commitEdit(div);
        const n = addChild(node.id);
        if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
        persist();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdit(div);
        const n = addSibling(node.id);
        if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
        persist();
      } else if (e.key === "Escape") {
        e.preventDefault();
        commitEdit(div);
      }
      e.stopPropagation();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (!state.current) return;
    const activeIsEditable = document.activeElement && document.activeElement.isContentEditable;
    const activeIsInput = document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA");
    if (activeIsEditable || activeIsInput) return; // handled by node/title listeners

    if (state.linkFromId && e.key === "Escape") {
      e.preventDefault();
      cancelLinking();
      return;
    }
    if (state.moveSourceId && e.key === "Escape") {
      e.preventDefault();
      cancelMove();
      return;
    }
    if (state.highlightId && e.key === "Escape") {
      e.preventDefault();
      clearHighlight();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.selectedCell && state.selectedCell.nodeId === state.selectedId) {
        const node = findNode(state.selectedCell.nodeId);
        if (node) addCellUrl(node, state.selectedCell.r, state.selectedCell.c);
      } else if (state.selectedId) {
        addNodeUrl(state.selectedId);
      }
      return;
    }
    if (!state.selectedId) {
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        state.selectedId = state.current.root.id;
      }
      return;
    }
    const node = findNode(state.selectedId);
    if (!node) return;

    if (e.key === "Tab") {
      e.preventDefault();
      const n = addChild(node.id);
      if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
      persist();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = addSibling(node.id);
      if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
      persist();
    } else if (e.key === "F2") {
      e.preventDefault();
      startEdit(node.id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteBranch(node.id);
    } else if (e.key === " ") {
      e.preventDefault();
      if (node.children && node.children.length) {
        pushUndo();
        node.collapsed = !node.collapsed;
        renderAll();
        persist();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      pushUndo();
      node.struck = !node.struck;
      renderAll();
      persist();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      navigate(node, e.key);
    }
  });

  function navigate(from, dir) {
    const all = [];
    (function collect(n) { all.push(n); if (!n.collapsed) (n.children || []).forEach(collect); })(state.current.root);
    const dx = dir === "ArrowRight" ? 1 : dir === "ArrowLeft" ? -1 : 0;
    const dy = dir === "ArrowDown" ? 1 : dir === "ArrowUp" ? -1 : 0;
    let best = null, bestScore = Infinity;
    for (const n of all) {
      if (n.id === from.id) continue;
      const ddx = n._x - from._x, ddy = n._y - from._y;
      if (dx !== 0 && Math.sign(ddx || 0) !== dx && !(dx === 1 && n._depth > from._depth) && !(dx === -1 && n._depth < from._depth)) {
        // fallback simple directional filter
      }
      const alongAxis = dx !== 0 ? ddx * dx : ddy * dy;
      if (alongAxis <= 0) continue;
      const perpPenalty = dx !== 0 ? Math.abs(ddy) : Math.abs(ddx);
      const score = alongAxis + perpPenalty * 2;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) { state.selectedId = best.id; renderAll(); }
  }

  /* ---------------- context menu ---------------- */

  // Combined "Connector style" picker — one shared row of three
  // mutually-exclusive buttons (Curved / Elbow / Arrow) used identically
  // in three places: the root node's menu (sets the map-wide default),
  // a "mother" node's bulk picker (sets all of its direct children's
  // hops at once), and a single connector's own right-click menu (sets
  // just that one hop). `read()` returns which button should show as
  // active ("curved" | "elbow" | "arrow" | null for a mixed bulk
  // selection with no single answer), and `choose(value)` applies a click.
  function renderConnectorStyleRow(ctxMenu, label, read, choose) {
    const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
    const labelEl = document.createElement("div");
    labelEl.className = "ctx-item"; labelEl.style.cursor = "default";
    labelEl.textContent = label;
    ctxMenu.appendChild(labelEl);

    const row = document.createElement("div");
    row.className = "ctx-style-row";
    const current = read();
    [["curved", "Curved"], ["elbow", "Elbow"], ["arrow", "Arrow"]].forEach(([val, text]) => {
      const btn = document.createElement("div");
      btn.className = "ctx-style-btn" + (current === val ? " active" : "");
      btn.textContent = text;
      btn.addEventListener("click", () => {
        closeContextMenu();
        pushUndo();
        choose(val);
        renderAll();
        persist();
      });
      row.appendChild(btn);
    });
    ctxMenu.appendChild(row);
  }

  function openContextMenu(x, y, node) {
    resetContextMenu();
    ctxMenu.classList.add("node-context-menu");

    // Renders a plain array of [label, fn, removeFn?] rows the same way
    // every "generic action" group below does — factored out once so
    // each group can just build its own small array and hand it here,
    // rather than repeating this same DOM-building loop per group.
    const renderItemRows = (list) => {
      for (const [label, fn, removeFn] of list) {
        const it = document.createElement("div");
        it.className = "ctx-item";
        const labelSpan = document.createElement("span");
        labelSpan.className = "ctx-item-label";
        labelSpan.textContent = label;
        it.appendChild(labelSpan);
        if (removeFn) {
          const rm = document.createElement("span");
          rm.className = "ctx-item-remove";
          rm.textContent = "✕";
          rm.title = "Remove";
          // Stop the click from also bubbling into the row's own handler
          // below (which would open the edit prompt right after removing).
          rm.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); removeFn(); });
          it.appendChild(rm);
        }
        it.addEventListener("click", () => { closeContextMenu(); fn(); });
        ctxMenu.appendChild(it);
      }
    };
    const addSep = () => { const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep); };
    const addSection = (title) => {
      if (ctxMenu.childElementCount) addSep();
      const head = document.createElement("div");
      head.className = "ctx-item ctx-item-header";
      const span = document.createElement("span");
      span.className = "ctx-item-label";
      span.textContent = title;
      head.appendChild(span);
      ctxMenu.appendChild(head);
    };

    // v431: node and cell menus now start with the same Clipboard block.
    addSection("Clipboard");
    renderItemRows([
      ["📋 Copy all icons", () => copyAllIconsFromHost(node)],
      ["📥 Paste all icons", () => pasteAllIconsToHost(node)],
    ]);

    addSection("Node");

    // Group: structure — renaming, moving, and other actions that change
    // where/how this node sits in the tree, not what it contains.
    const structureItems = [];
    // Double-click/F2 rename a node's text just fine with a mouse and
    // keyboard, but neither is reliable on a touchscreen — a double-tap
    // doesn't always synthesize a dblclick event, and there's no F2 key.
    // Long-press already opens this menu on touch, so put Rename here too.
    if (!nodeIsTable(node)) {
      structureItems.push(["✏️ Rename", () => {
        const touchPhone = window.matchMedia("(pointer: coarse)").matches ||
          window.matchMedia("(max-width: 640px)").matches;
        if (!touchPhone) {
          startEdit(node.id);
          return;
        }
        // v370: phone rename deliberately does not use the canvas
        // contenteditable. Android can dismiss that keyboard as the
        // long-press/context-menu gesture finishes. A native text prompt
        // owns focus independently of the canvas and remains stable.
        const next = window.prompt("Rename node", node.text || "");
        if (next === null) return;
        const value = next.trim();
        if (value === (node.text || "")) return;
        pushUndo();
        node.text = value;
        if (state.current && node.id === state.current.root.id) {
          state.current.title = value;
          titleInput.value = value;
          renderSidebar();
        }
        renderAll();
        persist();
      }]);
    }
    // Move-to-new-parent, as an alternative to dragging the node across
    // the canvas (handy when the destination is far away or off-screen).
    // The root has no parent, so it can never be the thing being moved —
    // but it's always a legal destination, handled by the block below.
    if (node !== state.current.root) {
      if (state.moveSourceId === node.id) {
        structureItems.push(["🚫 Cancel move", () => cancelMove()]);
      } else {
        structureItems.push(["📦 Move…", () => startMoveFrom(node.id)]);
      }
    }
    if (state.moveSourceId && state.moveSourceId !== node.id && canMoveSourceTo(node.id)) {
      structureItems.push(["📥 Move to here", () => completeMoveTo(node.id)]);
    }
    structureItems.push([node.struck ? "~~ Remove strikethrough" : "~~ Strikethrough", () => { pushUndo(); node.struck = !node.struck; renderAll(); persist(); }]);

    // v592: Hide keeps the node and its whole branch in the map data but
    // removes it from the canvas. Restore hidden direct children from their
    // parent's menu so hiding never strands data with no way back.
    if (node !== state.current.root) {
      structureItems.push(["🙈 Hide node", () => {
        pushUndo();
        node.hidden = true;
        const parent = findParent(node.id);
        state.selectedId = parent ? parent.id : state.current.root.id;
        renderAll();
        persist();
      }]);
    }
    const hiddenChildren = (node.children || []).filter(child => child.hidden);
    if (hiddenChildren.length) {
      structureItems.push([`👁️ Show hidden nodes (${hiddenChildren.length})`, () => {
        pushUndo();
        hiddenChildren.forEach(child => { child.hidden = false; });
        renderAll();
        persist();
      }]);
    }
    if (node.children && node.children.length > 0) {
      structureItems.push([node.collapsed ? "▸ Expand" : "▾ Collapse", () => { pushUndo(); node.collapsed = !node.collapsed; renderAll(); persist(); }]);
    }
    if (node.ox || node.oy) {
      structureItems.push(["↺ Reset position", () => { pushUndo(); delete node.ox; delete node.oy; renderAll(); persist(); }]);
    }
    renderItemRows(structureItems);

    // Group: content — the stuff actually living on this node (table
    // structure, notes, photos), kept apart from the structural actions
    // above since these add/change what the node holds rather than where
    // it sits.
    addSection("Content");
    const contentItems = [];
    contentItems.push(["▦ Add table child", () => {
      const n = addTableChild(node.id);
      if (n) { state.selectedId = n.id; renderAll(); persist(); }
    }]);
    contentItems.push(["📅 Add calendar child", () => {
      const n = addCalendarChild(node.id);
      if (n) { state.selectedId = n.id; renderAll(); persist(); }
    }]);
    if (nodeIsTable(node)) {
      contentItems.push(["⬇️ Add row", () => { pushUndo(); tableAddRow(node); renderAll(); persist(); }]);
      contentItems.push(["➡️ Add column", () => { pushUndo(); tableAddColumn(node); renderAll(); persist(); }]);
      if (node.table.cells.length > 1) {
        contentItems.push(["⬆️ Remove row", () => { pushUndo(); tableRemoveRow(node); renderAll(); persist(); }]);
      }
      if (node.table.cells[0].length > 1) {
        contentItems.push(["⬅️ Remove column", () => { pushUndo(); tableRemoveColumn(node); renderAll(); persist(); }]);
      }
      // "Outline only" hides every interior cell border and keeps just
      // the table's outer edge (plus a thin rule under the second row,
      // for a header-style divider) — see the .node-table-outline CSS
      // and renderTableGrid's table.classList.add below. Handy for
      // calendar-style tables where a full interior grid looks noisy.
      const outline = node.table.gridStyle === "outline";
      contentItems.push([outline ? "▦ Grid lines: show all cells" : "▦ Grid lines: outline only", () => {
        pushUndo();
        node.table.gridStyle = outline ? "grid" : "outline";
        renderAll();
        persist();
      }]);
      if (node.table.calendar) {
        const calendarStyleOptions = [
          ["classic", "Classic"],
          ["transparent", "Transparent"],
          ["glass", "Glass"],
          ["paper", "Paper"],
          ["minimal", "Minimal"],
          ["dark", "Dark"],
          ["pastel", "Pastel"]
        ];
        const currentCalendarStyle = calendarStyleOptions.some(([key]) => key === node.table.calendarStyle)
          ? node.table.calendarStyle
          : "classic";
        calendarStyleOptions.forEach(([key, label]) => {
          contentItems.push([
            (currentCalendarStyle === key ? "✓ " : "○ ") + "Calendar style: " + label,
            () => {
              if ((node.table.calendarStyle || "classic") === key) return;
              pushUndo();
              node.table.calendarStyle = key;
              renderAll();
              persist();
            }
          ]);
        });
      }
    }
    contentItems.push([nodeHasNotes(node) ? `📝 Notes (${getNodeNotes(node).length})…` : "📝 Add note…", () => openNoteModal(node.id)]);
    contentItems.push(["🖼️ Add photo…", () => openNodePhotoPicker(node.id)]);
    if (nodeHasImages(node)) {
      contentItems.push([getNodeImageIds(node).length > 1 ? "👁️ View photos…" : "👁️ View photo…", () => openPhotoModal(node.id, 0)]);
      contentItems.push(["🗑️ Remove all photos", () => {
        pushUndo();
        getNodeImageIds(node).forEach(deletePhotoRecord);
        node.images = []; node.image = null; node.photoTags = {}; node.photoNotes = {}; node.photoComments = {};
        renderAll(); persist();
      }]);
    }
    renderItemRows(contentItems);

    // Group: reference — actions that read/export/mark this branch
    // rather than change or add to it.
    addSection("Reference");
    renderItemRows([
      ["📋 Copy as outline", () => copyNodeBranchToClipboard(node)],
      [state.highlightId === node.id ? "🖍️ Remove highlight" : "🖍️ Highlight branch", () => setHighlight(node.id)],
    ]);

    // Tasks, Timer, Brainstorm, commented Links, and the Affirmation game —
    // grouped together in their own section (separated by a divider)
    // rather than scattered among the generic node actions above, since
    // these five are exactly the things nodeTaskProgress adds points for
    // (see that function's comments), i.e. the "work on this node for
    // score" actions as opposed to editing/formatting it.
    // The Affirmation game row carries a small "✎" button on its right
    // edge (reusing the same corner-icon slot as the ✕ remove buttons
    // elsewhere in this menu) that opens the shared lines-editor modal
    // instead of starting a round.
    {
      addSection("Work");

      const addGroupRow = (label, fn) => {
        const row = document.createElement("div");
        row.className = "ctx-item";
        const labelSpan = document.createElement("span");
        labelSpan.className = "ctx-item-label";
        labelSpan.textContent = label;
        row.appendChild(labelSpan);
        row.addEventListener("click", () => { closeContextMenu(); fn(); });
        ctxMenu.appendChild(row);
        return row;
      };

      {
        const prog = nodeTaskProgress(node);
        const label = prog.total ? `✅ Tasks… (${prog.done}/${prog.total})` : "✅ Add tasks…";
        addGroupRow(label, () => openTasksModal(node.id));
      }
      {
        const played = getNodeTimePlayed(node);
        const label = played ? `⏱️ Timer — ${formatTimePlayed(played)}…` : "⏱️ Add timer…";
        addGroupRow(label, () => openTimerModal(node.id));
      }
      {
        addGroupRow("🧠 Brainstorm…", () => openBrainstormModal(node.id));
      }
      {
        // Shortcut: opens this node's DRC note, pre-filled with the
        // "DRC" note template (see getDRCTemplateText / the forceDRCTemplate
        // branch in openNoteModal) the first time, or just reopens the
        // existing one on every click after that — only one DRC note is
        // allowed per node. Unlike the automatic prefill, this isn't tied
        // to any task being named "DRC". The label shows how many filled-in
        // DRC notes exist so far (see drcNoteIsFilled) — no longer a point
        // value, since DRC notes stopped contributing to the task score.
        const drcFilled = getNodeNotes(node).filter(n => isDRCNote(n) && drcNoteIsFilled(n)).length;
        const label = drcFilled > 0 ? `DRC (${drcFilled} filled in)…` : "DRC…";
        const drcItem = addGroupRow(label, () => openNoteModal(node.id, undefined, null, null, null, true));
        // Same notebook+pencil image as the DRC marker on the node itself,
        // instead of a 📋 emoji, so the two match.
        const drcLabelSpan = drcItem.querySelector(".ctx-item-label");
        if (drcLabelSpan) drcLabelSpan.prepend(drcIconEl(16));
      }
      {
        // Only *commented* links score points (see nodeTaskProgress), so
        // the count shown here — unlike the plain "Add link…" action this
        // replaces — reflects how many of the node's links have a comment
        // set, not just how many links exist. Still just opens the normal
        // add-link prompt; commenting on a link itself happens from that
        // link's own icon.
        const urls = getNodeUrls(node);
        const commented = urls.filter(u => getLinkComment(node, u)).length;
        const label = commented > 0 ? `🔗 Links (${commented} commented)…` : "🔗 Add link…";
        addGroupRow(label, () => addNodeUrl(node.id));
      }

      const wins = nodeAffirmationWins(node);
      const gameItem = addGroupRow(
        wins ? `🎮 Affirmation game (✓ ${wins})` : "🎮 Affirmation game",
        () => openAffirmationGame(node.id)
      );
      const editBtn = document.createElement("span");
      editBtn.className = "ctx-item-remove ctx-item-edit-affirmation";
      editBtn.textContent = "✎";
      editBtn.title = "Edit affirmation lines";
      // Stop the click from also bubbling into the row's own handler
      // above (which would start a game round right after opening the
      // editor).
      editBtn.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); openAffirmationQuotesModal(); });
      gameItem.appendChild(editBtn);
    }

    // Glow effect picker — several intensities/speeds rather than a plain
    // on/off toggle, plus "None" to turn it off. Reuses the same
    // label-then-row layout as the branch color swatches below.
    {
      addSection("Appearance");
      const label = document.createElement("div");
      label.className = "ctx-item"; label.style.cursor = "default";
      label.textContent = "✨ Glow effect";
      ctxMenu.appendChild(label);

      const row = document.createElement("div");
      row.className = "ctx-glow-options";
      const GLOW_OPTIONS = [
        [null, "None"],
        ["soft", "Soft"],
        ["fast", "Fast"],
        ["blink", "Blink"],
      ];
      const currentGlow = node.glow === true ? "soft" : (node.glow || null);
      GLOW_OPTIONS.forEach(([value, glowLabel]) => {
        const opt = document.createElement("span");
        opt.className = "ctx-glow-opt" + (currentGlow === value ? " active" : "");
        opt.textContent = glowLabel;
        opt.addEventListener("click", () => {
          pushUndo();
          node.glow = value;
          closeContextMenu();
          renderAll();
          persist();
        });
        row.appendChild(opt);
      });
      ctxMenu.appendChild(row);
    }

    // v513: map-wide Task badge appearance. Stored in the map itself so
    // phone/PC and Drive copies keep the same visual rule.
    {
      const label = document.createElement("div");
      label.className = "ctx-item"; label.style.cursor = "default";
      label.textContent = "🏷️ Task badge style";
      ctxMenu.appendChild(label);
      const row = document.createElement("div");
      row.className = "ctx-glow-options";
      const current = taskBadgeStyle();
      [["color", "Color"], ["size", "Size"], ["both", "Both"]].forEach(([value, text]) => {
        const opt = document.createElement("span");
        opt.className = "ctx-glow-opt" + (current === value ? " active" : "");
        opt.textContent = text;
        opt.addEventListener("click", () => {
          closeContextMenu();
          setTaskBadgeStyle(value);
        });
        row.appendChild(opt);
      });
      ctxMenu.appendChild(row);
    }

    // v514: node/cell attachment marker style, independent from task badge styling.
    {
      const label = document.createElement("div");
      label.className = "ctx-item"; label.style.cursor = "default";
      label.textContent = "◐ Node / cell icon style";
      ctxMenu.appendChild(label);
      const row = document.createElement("div");
      row.className = "ctx-glow-options";
      const current = mapIconStyle();
      [["color", "Color"], ["mono", "Black & white"]].forEach(([value, text]) => {
        const opt = document.createElement("span");
        opt.className = "ctx-glow-opt" + (current === value ? " active" : "");
        opt.textContent = text;
        opt.addEventListener("click", () => {
          closeContextMenu();
          setMapIconStyle(value);
        });
        row.appendChild(opt);
      });
      ctxMenu.appendChild(row);
    }

    // Connector style — map-wide default, so it only makes sense to offer
    // on the root (level 0) node rather than per-branch. Any individual
    // node's or connector's own picker can still override it for just
    // that hop (see the bulk "children" picker below, and
    // openConnectorContextMenu for a single hop).
    if (node === state.current.root) {
      renderConnectorStyleRow(ctxMenu, "🔀 Connector style",
        () => {
          ensureTheme(state.current);
          return state.current.theme.connectorArrow ? "arrow" : (state.current.theme.connectorShape || "curved");
        },
        (val) => {
          ensureTheme(state.current);
          if (val === "arrow") {
            state.current.theme.connectorArrow = true;
          } else {
            state.current.theme.connectorArrow = false;
            state.current.theme.connectorShape = val;
          }
        }
      );
    }

    // Hide clock/calendar — moved here from the theme panel. Even though
    // the live clock only ever renders on the root node (and the 📅
    // Calendar button lives in the toolbar), the toggle is offered from
    // every node's right-click menu, not just root's, so it's reachable
    // without having to navigate back to the root first. Saved per-map —
    // see isClockHidden/ensureClockHidden — so it only affects the
    // mindmap currently open.
    {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const clockItem = document.createElement("div");
      clockItem.className = "ctx-item";
      clockItem.textContent = isClockHidden() ? "🕐 Show root node clock & 📅 Calendar button" : "🕐 Hide root node clock & 📅 Calendar button";
      clockItem.addEventListener("click", () => { closeContextMenu(); setClockHidden(!isClockHidden()); });
      ctxMenu.appendChild(clockItem);
    }

    // A "mother" node with children gets a single input that sets the
    // distance for ALL of its descendants' connectors at once — every
    // generation below this node, not just its direct children — so one
    // number gives the whole subtree consistent spacing in one go. The
    // per-connector right-click menu (see openConnectorContextMenu) still
    // works for tweaking just one hop afterward.
    if (node.children && node.children.length) {
      const sep0 = document.createElement("div"); sep0.className = "ctx-sep"; ctxMenu.appendChild(sep0);
      const distLabel = document.createElement("div");
      distLabel.className = "ctx-item";
      distLabel.style.cursor = "default";
      distLabel.textContent = "↔️ Children distance";
      ctxMenu.appendChild(distLabel);

      const distRow = document.createElement("div");
      distRow.className = "ctx-distance-row";
      const distInput = document.createElement("input");
      distInput.type = "number";
      distInput.min = String(MIN_X_GAP);
      distInput.max = String(MAX_X_GAP);
      distInput.step = "5";
      distInput.value = Math.round(gapFor(node.children[0]));
      distInput.className = "ctx-distance-input";
      distRow.appendChild(distInput);
      const distUnit = document.createElement("span");
      distUnit.className = "ctx-distance-unit";
      distUnit.textContent = "px";
      distRow.appendChild(distUnit);
      ctxMenu.appendChild(distRow);

      const allDescendants = collectDescendants(node);

      distRow.addEventListener("click", (e) => e.stopPropagation());
      distInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { distInput.blur(); closeContextMenu(); }
      });
      distInput.addEventListener("change", () => {
        const v = parseFloat(distInput.value);
        if (Number.isNaN(v)) return;
        const clamped = Math.max(MIN_X_GAP, Math.min(MAX_X_GAP, Math.round(v)));
        pushUndo();
        allDescendants.forEach(d => { d.xGap = clamped; d.childrenGap = clamped; });
        node.childrenGap = clamped;
        renderAll();
        persist();
      });

      const anyCustomGap = allDescendants.some(d => typeof d.xGap === "number" && d.xGap >= 0);
      if (anyCustomGap) {
        const resetAll = document.createElement("div");
        resetAll.className = "ctx-item";
        resetAll.textContent = "↺ Reset all to default spacing";
        resetAll.addEventListener("click", () => {
          closeContextMenu();
          pushUndo();
          allDescendants.forEach(d => { d.xGap = null; delete d.childrenGap; });
          delete node.childrenGap;
          renderAll();
          persist();
        });
        ctxMenu.appendChild(resetAll);
      }

      // Bulk connector style — same combined Curved/Elbow/Arrow picker as
      // the per-connector menu (see openConnectorContextMenu), but applied
      // to every direct child's connector at once instead of one at a time.
      renderConnectorStyleRow(ctxMenu, "🔀 Children connector style",
        () => {
          ensureTheme(state.current);
          const values = node.children.map((c) => {
            if (c.connectorStyle === "arrow") return "arrow";
            if (c.connectorStyle === "line") return c.connectorShape || state.current.theme.connectorShape || "curved";
            return state.current.theme.connectorArrow ? "arrow" : (c.connectorShape || state.current.theme.connectorShape || "curved");
          });
          return values.every(v => v === values[0]) ? values[0] : null;
        },
        (val) => {
          node.children.forEach((c) => {
            if (val === "arrow") {
              c.connectorStyle = "arrow";
            } else {
              c.connectorStyle = "line";
              c.connectorShape = val;
            }
          });
        }
      );
    }

    const existingLinks = linksForNode(node.id);
    if (existingLinks.length) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      for (const link of existingLinks) {
        const otherId = link.a === node.id ? link.b : link.a;
        const other = findNode(otherId);
        const it = document.createElement("div");
        it.className = "ctx-item danger";
        it.textContent = `🔗 Remove link to "${other ? (other.text || "(untitled)") : "unknown node"}"`;
        it.addEventListener("click", () => { closeContextMenu(); removeLink(link.id); });
        ctxMenu.appendChild(it);
      }
    }

    const topAncestor = findTopAncestor(node);

    // v601: keep the node styling controls together and easy to scan.
    // Text Format only changes text/formatting; Font Color keeps the
    // existing subtree behavior; Fill Color keeps the existing branch/root
    // fill behavior.
    {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const label = document.createElement("div");
      label.className = "ctx-item";
      label.style.cursor = "default";
      label.style.fontWeight = "700";
      label.textContent = "✍️ Text Format";
      ctxMenu.appendChild(label);

      const boldItem = document.createElement("div");
      boldItem.className = "ctx-item" + (node.bold ? " active" : "");
      boldItem.innerHTML = node.bold ? "<b>B Bold ✓</b>" : "<b>B Bold</b>";
      boldItem.addEventListener("click", () => {
        closeContextMenu();
        pushUndo();
        node.bold = !node.bold;
        renderAll();
        persist();
      });
      ctxMenu.appendChild(boldItem);

      const combinedOn = !!node.bold && !!node.allCaps;
      const formatItem = document.createElement("div");
      formatItem.className = "ctx-item" + (combinedOn ? " active" : "");
      formatItem.innerHTML = combinedOn ? "<b>𝐀𝐀 Bold + All Case ✓</b>" : "<b>𝐀𝐀 Bold + All Case</b>";
      formatItem.addEventListener("click", () => {
        closeContextMenu();
        pushUndo();
        const turnOn = !(node.bold && node.allCaps);
        node.bold = turnOn;
        node.allCaps = turnOn;
        renderAll();
        persist();
      });
      ctxMenu.appendChild(formatItem);

      const capItem = document.createElement("div");
      capItem.className = "ctx-item";
      capItem.textContent = "Aa First Letter Cap";
      capItem.title = "Capitalize the first letter of every word";
      capItem.addEventListener("click", () => {
        const original = String(node.text || "");
        const capped = original.replace(/(^|[^\p{L}])(\p{L})/gu,
          (_, prefix, letter) => prefix + letter.toUpperCase());
        closeContextMenu();
        if (capped === original) return;
        pushUndo();
        node.text = capped;
        renderAll();
        persist();
      });
      ctxMenu.appendChild(capItem);
    }

    // Font color is independent of fill color. Choosing it on a node applies
    // to that node AND its whole descendant subtree, preserving the existing
    // style-parent behavior.
    {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const label = document.createElement("div");
      label.className = "ctx-item";
      label.style.cursor = "default";
      label.style.fontWeight = "700";
      label.textContent = "🔤 Font Color";
      ctxMenu.appendChild(label);
      const sw = document.createElement("div"); sw.className = "ctx-swatches";
      const resetSwatch = document.createElement("span");
      resetSwatch.className = "ctx-swatch ctx-swatch-reset" + (!node.fontColor ? " active" : "");
      resetSwatch.title = "Default";
      resetSwatch.addEventListener("click", () => {
        pushUndo();
        (function apply(n) {
          if (!n) return;
          n.fontColor = null;
          (n.children || []).forEach(apply);
        })(node);
        closeContextMenu();
        renderAll();
        persist();
      });
      sw.appendChild(resetSwatch);
      PALETTE.forEach(c => {
        const s = document.createElement("span");
        s.className = "ctx-swatch" + (node.fontColor === c ? " active" : "");
        s.style.background = c;
        s.addEventListener("click", () => {
          pushUndo();
          (function apply(n) {
            if (!n) return;
            n.fontColor = c;
            (n.children || []).forEach(apply);
          })(node);
          closeContextMenu();
          renderAll();
          persist();
        });
        sw.appendChild(s);
      });
      ctxMenu.appendChild(sw);
    }

    // Fill color keeps the existing semantics: a non-root node edits the
    // top-level branch fill; the root edits its own fill.
    {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const label = document.createElement("div");
      label.className = "ctx-item";
      label.style.cursor = "default";
      label.style.fontWeight = "700";
      label.textContent = "🎨 Fill Color";
      label.title = topAncestor ? "Applies to this branch fill" : "Applies to the root node fill";
      ctxMenu.appendChild(label);

      const sw = document.createElement("div");
      sw.className = "ctx-swatches";
      const fillTarget = topAncestor || node;
      PALETTE.forEach(c => {
        const s = document.createElement("span");
        s.className = "ctx-swatch" + (fillTarget.color === c ? " active" : "");
        s.style.background = c;
        s.addEventListener("click", () => {
          pushUndo();
          fillTarget.color = c;
          closeContextMenu();
          renderAll();
          persist();
        });
        sw.appendChild(s);
      });
      ctxMenu.appendChild(sw);
    }

    if (findParent(node.id)) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const del = document.createElement("div");
      del.className = "ctx-item danger";
      del.textContent = "🗑️ Delete branch (Del)";
      del.addEventListener("click", () => { closeContextMenu(); deleteBranch(node.id); });
      ctxMenu.appendChild(del);
    }

    positionContextMenu(x, y);
  }

  function openLinkContextMenu(x, y, link) {
    resetContextMenu();
    const del = document.createElement("div");
    del.className = "ctx-item danger";
    del.textContent = "Delete link";
    del.addEventListener("click", () => { closeContextMenu(); removeLink(link.id); });
    ctxMenu.appendChild(del);

    positionContextMenu(x, y);
  }

  // The lower bound has to stay at or below the smallest distance the
  // layout can ever hand out by default — an elbow-shaped connector below
  // the root already defaults to X_GAP / 2 (see defaultGapForDepth), which
  // is well under what used to be the floor here. Whenever that default
  // fell below the input's own declared `min`, the field opened already
  // out of range, and typing into it (particularly on level-2+ nodes,
  // since only THEIR default sits below the old floor) never produced a
  // value the input would accept.
  const MIN_X_GAP = 10;
  const MAX_X_GAP = 900;

  // Right-click on a parent→child connector: lets the user type an exact
  // pixel distance for that one hop (see gapFor/place/placeLocal), instead
  // of only being able to eyeball it by dragging.
  function openConnectorContextMenu(x, y, parent, child) {
    resetContextMenu();

    const isCustom = typeof child.xGap === "number" && child.xGap >= 0;
    const currentGap = isCustom ? child.xGap : defaultGapForDepth(child._depth);

    const label = document.createElement("div");
    label.className = "ctx-item";
    label.style.cursor = "default";
    label.textContent = "Connector distance";
    ctxMenu.appendChild(label);

    const row = document.createElement("div");
    row.className = "ctx-distance-row";
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(MIN_X_GAP);
    input.max = String(MAX_X_GAP);
    input.step = "5";
    input.value = Math.round(currentGap);
    input.className = "ctx-distance-input";
    row.appendChild(input);
    const unit = document.createElement("span");
    unit.className = "ctx-distance-unit";
    unit.textContent = "px";
    row.appendChild(unit);
    ctxMenu.appendChild(row);

    // Keep clicks/typing in the input from bubbling to the document-level
    // listener that closes the menu on any outside click.
    row.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { input.blur(); closeContextMenu(); }
    });
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (Number.isNaN(v)) return;
      const clamped = Math.max(MIN_X_GAP, Math.min(MAX_X_GAP, Math.round(v)));
      pushUndo();
      child.xGap = clamped;
      renderAll();
      persist();
    });

    if (isCustom) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const reset = document.createElement("div");
      reset.className = "ctx-item";
      reset.textContent = "Reset to default spacing";
      reset.addEventListener("click", () => {
        closeContextMenu();
        pushUndo();
        child.xGap = null;
        renderAll();
        persist();
      });
      ctxMenu.appendChild(reset);
    }

    renderConnectorStyleRow(ctxMenu, "Connector style",
      () => {
        ensureTheme(state.current);
        if (child.connectorStyle === "arrow") return "arrow";
        if (child.connectorStyle === "line") return child.connectorShape || state.current.theme.connectorShape || "curved";
        return state.current.theme.connectorArrow ? "arrow" : (child.connectorShape || state.current.theme.connectorShape || "curved");
      },
      (val) => {
        if (val === "arrow") {
          child.connectorStyle = "arrow";
        } else {
          child.connectorStyle = "line";
          child.connectorShape = val;
        }
      }
    );

    positionContextMenu(x, y);
    setTimeout(() => input.focus(), 0);
  }

  // Flattens a node and its descendants into an indented outline, e.g.:
  //   Project Launch
  //     - Research
  //       - Competitors
  //       - Market size
  //     - Design
  // Each level adds two spaces of indent plus a "- " marker, so depth
  // stays readable even if leading whitespace gets collapsed by whatever
  // it's pasted into (email clients, chat apps, etc. often strip runs of
  // spaces) — the accumulating "- " prefixes still show the level.
  function nodeBranchToOutline(node) {
    const lines = [];
    (function walk(n, depth) {
      const label = nodeIsTable(n)
        ? n.table.cells.map(row => row.map(c => c || "").join(" | ")).join(" / ") || "(empty table)"
        : ((n.text || "(untitled)").trim() || "(untitled)");
      const indent = "  ".repeat(depth);
      const marker = depth ? "- " : "";
      lines.push(indent + marker + label);
      (n.children || []).filter(Boolean).forEach(c => walk(c, depth + 1));
    })(node, 0);
    return lines.join("\n");
  }

  async function copyNodeBranchToClipboard(node) {
    const text = nodeBranchToOutline(node);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("no clipboard API");
      }
      showToast("Copied to clipboard");
    } catch (err) {
      // Fallback for browsers/contexts without navigator.clipboard
      // (e.g. non-secure local file contexts in some browsers).
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Copied to clipboard");
      } catch (err2) {
        showToast("Couldn't copy — try again");
      }
    }
  }

  let toastEl = null;
  let toastHideTimer = null;
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "app-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth; // restart CSS transition
    toastEl.classList.add("show");
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  function findTopAncestor(node) {
    if (!state.current) return null;
    if (node === state.current.root) return null;
    let found = null;
    (function walk(n, top) {
      for (const c of n.children || []) {
        const t = top || c;
        if (c === node) { found = t; return; }
        walk(c, t);
      }
    })(state.current.root, null);
    return found;
  }

  function closeContextMenu() { ctxMenu.classList.add("hidden"); }
  document.addEventListener("click", closeContextMenu);
  // Capture-phase "scroll" is meant to close the menu when the page/canvas
  // behind it scrolls out from under it — but "scroll" events still fire
  // through the capture phase on ancestors even though they don't bubble,
  // so without this guard, scrolling *inside* the menu's own internal
  // scroll area (see .ctx-menu's overflow-y in the CSS) was closing it
  // immediately instead of letting it scroll.
  document.addEventListener("scroll", (e) => {
    if (e.target === ctxMenu || (e.target.nodeType === 1 && ctxMenu.contains(e.target))) return;
    closeContextMenu();
  }, true);

