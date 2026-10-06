/* Branchline — js/07-rendering-1.js
   Part 7 of 19 of the former single-file app.js. Contents: rendering.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- rendering ---------------- */

  // ================= viewport virtualization =================
  // Layout stays complete in memory so all existing navigation, drag/drop,
  // undo, sync and connector math keep the exact same model. Only DOM/SVG
  // creation is virtualized: nodes and connectors well outside the camera are
  // not materialized until the camera approaches them.
  //
  // The render window is deliberately much larger than the visible viewport.
  // Panning/zooming therefore remains a cheap GPU transform for hundreds of
  // pixels at a time; we only reconcile DOM when the camera nears the edge of
  // that buffered window.
  const VIRTUAL_BUFFER_SCREEN_PX = 1000;
  const VIRTUAL_GUARD_SCREEN_PX = 320;
  let virtualAllNodes = [];
  let virtualRenderWindow = null;
  let virtualRefreshRAF = null;

  function virtualViewportRect(extraScreenPx) {
    const scale = Math.max(0.001, state.scale || 1);
    const extra = Math.max(0, extraScreenPx || 0);
    const vw = viewportEl.clientWidth || 1;
    const vh = viewportEl.clientHeight || 1;
    return {
      left: (-state.tx - extra) / scale,
      top: (-state.ty - extra) / scale,
      right: (vw - state.tx + extra) / scale,
      bottom: (vh - state.ty + extra) / scale
    };
  }

  function virtualRectIntersects(a, b) {
    return !!a && !!b
      && a.right >= b.left && a.left <= b.right
      && a.bottom >= b.top && a.top <= b.bottom;
  }

  function virtualRectContains(outer, inner) {
    return !!outer && !!inner
      && inner.left >= outer.left && inner.right <= outer.right
      && inner.top >= outer.top && inner.bottom <= outer.bottom;
  }

  function virtualNodeRect(node) {
    const w = node._w || NODE_H;
    const h = node._h || NODE_H;
    const left = state.originX + nodeLeftX(node);
    const top = state.originY + node._y + (node.oy || 0) - h / 2;
    return { left, top, right: left + w, bottom: top + h };
  }

  // Curved connectors stay inside (or very close to) the union of their two
  // endpoint boxes. A small cushion covers bezier bow/halo thickness without
  // needing expensive SVG getBBox() calls.
  function virtualConnectorRect(a, b) {
    const ar = virtualNodeRect(a), br = virtualNodeRect(b);
    const pad = 48;
    return {
      left: Math.min(ar.left, br.left) - pad,
      top: Math.min(ar.top, br.top) - pad,
      right: Math.max(ar.right, br.right) + pad,
      bottom: Math.max(ar.bottom, br.bottom) + pad
    };
  }

  function virtualPinnedIds() {
    const ids = new Set();
    if (state.selectedId) ids.add(state.selectedId);
    if (state.editingId) ids.add(state.editingId);
    if (state.linkFromId) ids.add(state.linkFromId);
    if (state.moveSourceId) ids.add(state.moveSourceId);
    if (dragCandidate && dragCandidate.id) ids.add(dragCandidate.id);
    return ids;
  }

  function virtualTreeConnectorSpecs(win) {
    const specs = [];
    const layoutMode = state.current.layout || "mindmap";
    const branches = (state.current.root.children || []).filter(n => !n.hidden);

    for (const n of virtualAllNodes) {
      if (n.collapsed || !n.children || n.children.length === 0) continue;
      for (const c of n.children) {
        if (c.hidden) continue;
        if (layoutMode === "timeline" && n === state.current.root) continue;
        if (!virtualRectIntersects(virtualConnectorRect(n, c), win)) continue;
        specs.push({
          key: `tree:h:${n.id}:${c.id}`,
          parent: n,
          child: c,
          opts: { virtualKey: `tree:h:${n.id}:${c.id}` }
        });
      }
    }

    if (layoutMode === "timeline" && branches.length) {
      const below = branches.filter(b => b.vSide !== "above");
      const above = branches.filter(b => b.vSide === "above");
      const addV = (a, b, colorNode, depth) => {
        if (!a || !b || !virtualRectIntersects(virtualConnectorRect(a, b), win)) return;
        const key = `tree:v:${a.id}:${b.id}`;
        specs.push({
          key,
          parent: a,
          child: b,
          opts: { orientation: "v", colorNode, depth, virtualKey: key }
        });
      };
      if (below.length) {
        addV(state.current.root, below[0], undefined, undefined);
        for (let i = 0; i < below.length - 1; i++) addV(below[i], below[i + 1], below[i + 1], 1);
      }
      if (above.length) {
        const last = above.length - 1;
        addV(state.current.root, above[last], undefined, undefined);
        for (let i = last; i > 0; i--) addV(above[i], above[i - 1], above[i - 1], 1);
      }
    }
    return specs;
  }

  function virtualLinkSpecs(win) {
    const specs = [];
    if (!state.current.links || !state.current.links.length) return specs;
    const byId = new Map(virtualAllNodes.map(n => [n.id, n]));
    for (const link of state.current.links) {
      const a = byId.get(link.a), b = byId.get(link.b);
      if (!a || !b || !virtualRectIntersects(virtualConnectorRect(a, b), win)) continue;
      specs.push({ key: `link:${link.id}`, link, a, b });
    }
    return specs;
  }

  function reconcileVirtualScene(force) {
    if (!state.current || state.originX == null || state.originY == null) return;
    const win = virtualViewportRect(VIRTUAL_BUFFER_SCREEN_PX);
    const pinned = virtualPinnedIds();
    const desiredNodes = new Map();

    for (const node of virtualAllNodes) {
      if (pinned.has(node.id) || virtualRectIntersects(virtualNodeRect(node), win)) {
        desiredNodes.set(node.id, node);
      }
    }

    if (force) {
      nodesLayer.innerHTML = "";
      svgEl.innerHTML = svgDefs();
    } else {
      nodesLayer.querySelectorAll(".node[data-id]").forEach((el) => {
        if (!desiredNodes.has(el.dataset.id)) el.remove();
      });
    }

    const existingNodeIds = new Set(
      Array.from(nodesLayer.querySelectorAll(".node[data-id]")).map(el => el.dataset.id)
    );
    for (const [id, node] of desiredNodes) {
      if (!existingNodeIds.has(id)) renderNode(node, state.originX, state.originY);
    }

    const treeSpecs = virtualTreeConnectorSpecs(win);
    const linkSpecs = virtualLinkSpecs(win);
    const desiredConnectorKeys = new Set([
      ...treeSpecs.map(x => x.key),
      ...linkSpecs.map(x => x.key)
    ]);

    if (!force) {
      svgEl.querySelectorAll("g.connector[data-virtual-key]").forEach((g) => {
        if (!desiredConnectorKeys.has(g.dataset.virtualKey)) g.remove();
      });
    }

    const existingConnectorKeys = new Set(
      Array.from(svgEl.querySelectorAll("g.connector[data-virtual-key]")).map(g => g.dataset.virtualKey)
    );
    for (const spec of treeSpecs) {
      if (!existingConnectorKeys.has(spec.key)) drawConnector(spec.parent, spec.child, state.originX, state.originY, spec.opts);
    }
    for (const spec of linkSpecs) {
      if (!existingConnectorKeys.has(spec.key)) drawLink(spec.a, spec.b, state.originX, state.originY, spec.link, spec.key);
    }

    // Re-apply transient visual state to newly materialized nodes.
    nodesLayer.querySelectorAll(".node").forEach((div) => {
      div.classList.toggle("link-source", !!state.linkFromId && div.dataset.id === state.linkFromId);
      div.classList.toggle("move-source", !!state.moveSourceId && div.dataset.id === state.moveSourceId);
    });

    virtualRenderWindow = win;
    applyHighlight();
  }

  function virtualWindowNeedsRefresh() {
    if (!state.current || !virtualRenderWindow) return true;
    return !virtualRectContains(virtualRenderWindow, virtualViewportRect(VIRTUAL_GUARD_SCREEN_PX));
  }

  function scheduleVirtualViewportRefresh(force) {
    if (!state.current) return;
    if (!force && !virtualWindowNeedsRefresh()) return;
    if (virtualRefreshRAF != null) {
      if (force) virtualRefreshRAF.force = true;
      return;
    }
    const token = { force: !!force };
    virtualRefreshRAF = token;
    requestAnimationFrame(() => {
      const shouldForce = token.force;
      if (virtualRefreshRAF !== token) return;
      virtualRefreshRAF = null;
      // Never tear down the DOM node that currently owns a live text edit.
      // On Android, opening the soft keyboard fires a viewport/window resize;
      // rebuilding the virtual scene at that moment removes the focused
      // contenteditable node, its blur handler commits the edit immediately,
      // and the keyboard visibly pops up then disappears. commitEdit() already
      // does a full render when editing actually ends, so simply defer any
      // virtualization refresh while state.editingId is active.
      if (state.editingId) return;
      // Do not tear down a live node drag. The 1000px render buffer easily
      // covers the gesture; a forced reconciliation runs on drop instead.
      if (dragCandidate && dragCandidate.moved) return;
      if (shouldForce || virtualWindowNeedsRefresh()) reconcileVirtualScene(shouldForce);
    });
  }

  // Fast path for edits that only change one node's visible content.
  // Re-measure that node first. If its box size changed, connector endpoints
  // and sibling layout may also need to move, so fall back to renderAll().
  // Otherwise replace only this node's DOM and leave the rest of the canvas,
  // SVG connectors and event handlers untouched.
  function refreshNodeOrRenderAll(nodeId) {
    if (!state.current || !nodeId || state.editingId) { renderAll(); return; }
    const node = findNode(nodeId);
    const oldEl = nodesLayer.querySelector(`.node[data-id="${nodeId}"]`);
    if (!node) return;

    const oldW = node._w;
    const oldH = node._h;
    computeNodeBox(node);
    if (node._w !== oldW || node._h !== oldH) {
      renderAll();
      return;
    }

    // If this node is virtualized out, its data is already current; there is
    // nothing to paint until the camera reaches it.
    if (!oldEl) {
      if (virtualRenderWindow && virtualRectIntersects(virtualNodeRect(node), virtualRenderWindow)) {
        renderNode(node, state.originX, state.originY);
        applyHighlight();
      }
      return;
    }

    const next = oldEl.nextSibling;
    oldEl.remove();
    renderNode(node, state.originX, state.originY);

    const fresh = nodesLayer.querySelector(`.node[data-id="${nodeId}"]`);
    if (fresh && next && next.parentNode === nodesLayer) nodesLayer.insertBefore(fresh, next);
    if (fresh && state.linkFromId === nodeId) fresh.classList.add("link-source");
    if (fresh && state.moveSourceId === nodeId) fresh.classList.add("move-source");
    applyHighlight();
  }

  function renderAll() {
    if (nodesLayer) nodesLayer.classList.toggle("map-icons-mono", mapIconStyle() === "mono");
    if (!state.current) {
      virtualAllNodes = [];
      virtualRenderWindow = null;
      clearCanvas();
      return;
    }
    updateUndoRedoButtons();
    emptyState.classList.add("hidden");
    nodeFabs.classList.remove("hidden");
    applyTheme();
    assignBranchColors(state.current.root);
    const bbox = layout(state.current.root);
    const pad = 140;
    const width = (bbox.maxX - bbox.minX) + pad * 2;
    const height = (bbox.maxY - bbox.minY) + pad * 2;
    const originX = -bbox.minX + pad;
    const originY = -bbox.minY + pad;

    if (state.originX !== undefined && state.originY !== undefined) {
      state.tx -= (originX - state.originX) * state.scale;
      state.ty -= (originY - state.originY) * state.scale;
    }
    state.originX = originX;
    state.originY = originY;

    worldEl.style.width = width + "px";
    worldEl.style.height = height + "px";
    svgEl.setAttribute("width", width);
    svgEl.setAttribute("height", height);
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

    virtualAllNodes = [];
    (function collect(n) {
      if (n.hidden && n !== state.current.root) return;
      virtualAllNodes.push(n);
      if (!n.collapsed) (n.children || []).forEach(collect);
    })(state.current.root);

    // Full model/layout refresh, but only the buffered viewport is materialized.
    virtualRenderWindow = null;
    reconcileVirtualScene(true);

    titleInput.value = state.current.title || "";
    updateLinkHint();
    applyTransform();

    // v535: the top Calendar is a live summary of the exact Calendar Child
    // cell objects. Any edit that refreshes the mindmap must refresh an
    // already-open Calendar too, so Note/Photo/Task/DRC/Brainstorm/etc.
    // changes appear in both places immediately.
    if (typeof calendarModal !== "undefined" && calendarModal &&
        !calendarModal.classList.contains("hidden") &&
        typeof renderCalendar === "function" && !renderAll._syncingCalendar) {
      try {
        renderAll._syncingCalendar = true;
        renderCalendar();
      } finally {
        renderAll._syncingCalendar = false;
      }
    }
  }

  // Blurs every node/connector except a chosen node and its whole branch
  // (descendants), so that part of the map stands out against everything
  // else. Re-applied at the end of every renderAll() since that rebuilds
  // nodesLayer/svgEl from scratch and would otherwise drop the classes.
  function applyHighlight() {
    nodesLayer.querySelectorAll(".node").forEach(div => div.classList.remove("highlight-dim", "highlight-focus"));
    svgEl.querySelectorAll(".connector").forEach(g => g.classList.remove("highlight-dim", "highlight-focus"));
    const activeId = state.highlightId;
    if (!activeId) return;
    const node = findNode(activeId);
    if (!node) { state.highlightId = null; return; }
    const ids = new Set();
    (function collect(n) { ids.add(n.id); (n.children || []).forEach(collect); })(node);
    nodesLayer.querySelectorAll(".node").forEach(div => {
      div.classList.add(ids.has(div.dataset.id) ? "highlight-focus" : "highlight-dim");
    });
    svgEl.querySelectorAll(".connector").forEach(g => {
      const inBranch = ids.has(g.dataset.parent) && ids.has(g.dataset.child);
      g.classList.add(inBranch ? "highlight-focus" : "highlight-dim");
    });
  }

  function setHighlight(nodeId) {
    state.highlightId = (state.highlightId === nodeId) ? null : nodeId;
    applyHighlight();
  }
  function clearHighlight() {
    if (!state.highlightId) return;
    state.highlightId = null;
    applyHighlight();
  }

  // Cross-links connect two arbitrary nodes rather than a parent to its
  // child, so there's no fixed "side" to route from/to — instead we aim
  // each end at the edge of its node along the straight line between their
  // centers, then bow the middle out a bit so it reads as distinct from
  // the tree connectors underneath it.
  function linkPath(a, b, ox, oy) {
    const ax = ox + nodeCenterX(a), ay = oy + a._y + (a.oy || 0);
    const bx = ox + nodeCenterX(b), by = oy + b._y + (b.oy || 0);
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const edgeOffset = (n) => Math.abs(ux) > Math.abs(uy) ? (n._w / 2) : (n._h / 2);
    const x1 = ax + ux * edgeOffset(a), y1 = ay + uy * edgeOffset(a);
    const x2 = bx - ux * edgeOffset(b), y2 = by - uy * edgeOffset(b);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const bow = Math.min(36, dist * 0.18);
    const cx = mx + -uy * bow, cy = my + ux * bow;
    return `M ${x1} ${y1} Q ${cx} ${cy}, ${x2} ${y2}`;
  }

  function drawLink(a, b, ox, oy, link, virtualKey) {
    const path = linkPath(a, b, ox, oy);
    const bg = (state.current.theme && state.current.theme.background) || defaultBg();
    const color = "#e0b04a";

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "connector link-connector");
    g.dataset.link = link.id;
    g.dataset.virtualKey = virtualKey || `link:${link.id}`;

    const halo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    halo.setAttribute("d", path);
    halo.setAttribute("stroke", haloColorFor(bg));
    halo.setAttribute("stroke-width", "4.6");
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke-linecap", "round");
    g.appendChild(halo);

    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", path);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", "2");
    el.setAttribute("stroke-dasharray", "1, 7");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("fill", "none");
    el.setAttribute("opacity", "0.9");
    g.appendChild(el);

    g.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLinkContextMenu(e.clientX, e.clientY, link);
    });

    svgEl.appendChild(g);
  }

  function svgDefs() {
    return `<defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.2" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <marker id="connector-arrow" viewBox="0 0 10 10" refX="8" refY="5"
              markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/>
      </marker>
    </defs>`;
  }

  // Rounded right-angle ("elbow") connector: a horizontal run out of the
  // parent, a rounded corner, a vertical run, another rounded corner, then
  // a horizontal run into the child — the classic org-chart look. Falls
  // back to a plain straight segment if there isn't room for the bend.
  function roundedElbowPath(x1, y1, x2, y2, r) {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const mx = x1 + dx / 2;
    const rr = Math.min(r, Math.abs(dx) / 2, Math.abs(dy) / 2);
    const sx = dx >= 0 ? 1 : -1;
    const sy = dy >= 0 ? 1 : -1;
    return `M ${x1} ${y1} L ${mx - sx * rr} ${y1} Q ${mx} ${y1} ${mx} ${y1 + sy * rr} L ${mx} ${y2 - sy * rr} Q ${mx} ${y2} ${mx + sx * rr} ${y2} L ${x2} ${y2}`;
  }

  // Same "elbow" idea, but for vertically-stacked hops (Timeline layout's
  // spine) — the bend happens on a horizontal run at the vertical midpoint
  // instead of a vertical run at the horizontal midpoint.
  function roundedElbowPathVertical(x1, y1, x2, y2, r) {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const my = y1 + dy / 2;
    const rr = Math.min(r, Math.abs(dx) / 2, Math.abs(dy) / 2);
    const sx = dx >= 0 ? 1 : -1;
    const sy = dy >= 0 ? 1 : -1;
    return `M ${x1} ${y1} L ${x1} ${my - sy * rr} Q ${x1} ${my} ${x1 + sx * rr} ${my} L ${x2 - sx * rr} ${my} Q ${x2} ${my} ${x2} ${my + sy * rr} L ${x2} ${y2}`;
  }

  function connectorPath(parent, child, ox, oy) {
    const px = parent._x + (parent.ox || 0), py = parent._y + (parent.oy || 0);
    const cx = child._x + (child.ox || 0), cy = child._y + (child.oy || 0);
    const sign = cx >= px ? 1 : -1;
    // Route from whichever edge of the parent box faces the child to
    // whichever edge of the child box faces the parent — with the new
    // anchored (non-centered) boxes, the child's parent-facing edge sits
    // at its fixed `_x` position, so it lines up with every sibling at
    // the same depth regardless of how wide any of their text boxes are.
    const x1 = ox + (sign > 0 ? nodeRightX(parent) : nodeLeftX(parent));
    const y1 = oy + py;
    const x2 = ox + (sign > 0 ? nodeLeftX(child) : nodeRightX(child));
    const y2 = oy + cy;
    // Connector shape — "elbow" draws a rounded right-angle org-chart-style
    // path; anything else (including "curved" and legacy/unknown values)
    // falls back to the default S-curve below. A hop's own connectorShape
    // wins if set (from the combined "Connector style" picker); otherwise
    // it falls back to the map-wide default from the root node's menu.
    const shape = child.connectorShape || (state.current.theme && state.current.theme.connectorShape) || "curved";
    if (shape === "elbow") {
      return roundedElbowPath(x1, y1, x2, y2, 14);
    }
    const dx = (x2 - x1) * 0.55;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  // Same idea as connectorPath, but for nodes stacked vertically (the
  // root-to-first-branch and branch-to-branch spine links in the Timeline
  // layout) rather than side by side. The x coordinate deliberately
  // ignores each node's manual horizontal nudge (ox) — the spine is meant
  // to read as one continuous straight line down the middle of the map
  // regardless of how far any individual branch has been dragged
  // sideways, so only the node's automatic layout position (_x, which is
  // always 0 for the root/branches in Timeline mode) feeds the x here.
  function connectorPathVertical(parent, child, ox, oy) {
    const ph = parent._h, ch = child._h;
    const py = parent._y + (parent.oy || 0);
    const cy = child._y + (child.oy || 0);
    const sign = cy >= py ? 1 : -1;
    const y1 = oy + py + sign * (ph / 2);
    const x1 = ox + parent._x;
    const y2 = oy + cy - sign * (ch / 2);
    const x2 = ox + child._x;
    const shape = child.connectorShape || (state.current.theme && state.current.theme.connectorShape) || "curved";
    if (shape === "elbow") {
      return roundedElbowPathVertical(x1, y1, x2, y2, 14);
    }
    const dy = (y2 - y1) * 0.55;
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }

  function drawConnector(parent, child, ox, oy, opts) {
    opts = opts || {};
    const orientation = opts.orientation || "h";
    const path = orientation === "v"
      ? connectorPathVertical(parent, child, ox, oy)
      : connectorPath(parent, child, ox, oy);
    const theme = state.current.theme;
    const colorNode = opts.colorNode || child;
    const color = theme.connectorMode === "custom"
      ? theme.connectorColor
      : (colorNode.color || branchColorFor(state.current.root, colorNode) || "#5b6272");
    const depth = opts.depth != null ? opts.depth : child._depth;
    // Thickness steps down by level so the trunk clearly reads as more
    // important than a leaf twig — matches the box-styling tiers (pill,
    // solid box, outlined box, plain text). Level 3+ is dotted, so it gets
    // a noticeably thinner stroke than a solid line of the same "weight"
    // would need, since dots read as thin even at low width.
    const width = depth <= 1 ? 3 : depth === 2 ? 1.8 : 1.1;
    const bg = theme.background || defaultBg();

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "connector");
    g.dataset.parent = parent.id;
    g.dataset.child = child.id;
    g.dataset.orientation = orientation;
    if (opts.virtualKey) g.dataset.virtualKey = opts.virtualKey;

    // halo underneath, so the line always reads clearly against whatever
    // background color is chosen
    const halo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    halo.setAttribute("d", path);
    halo.setAttribute("stroke", haloColorFor(bg));
    // Dotted level's halo gets a smaller bump than solid lines, so the halo
    // dots don't balloon past the thin dots they're meant to frame.
    halo.setAttribute("stroke-width", depth >= 3 ? width + 0.9 : width + 1.8);
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke-linecap", "round");
    // Keep the halo dotted in lockstep with the main line at level 3+, so it
    // doesn't show through the gaps as a solid line underneath the dots.
    if (depth >= 3) halo.setAttribute("stroke-dasharray", `0.1, ${width * 2.6}`);
    g.appendChild(halo);

    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", path);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", width);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("opacity", depth <= 1 ? "0.95" : "1");
    if (depth === 1) el.setAttribute("filter", "url(#glow)");
    // From level 3 down, switch to a dotted line — reinforces that these
    // are the least important tier, on top of the thinner stroke.
    if (depth >= 3) el.setAttribute("stroke-dasharray", `0.1, ${width * 2.6}`);
    // "Arrow" connector style — set per-hop via the combined "Connector
    // style" picker (see openConnectorContextMenu), or inherited from the
    // map-wide default (root node's menu) when this hop has no override —
    // adds an arrowhead pointing from parent to child, colored to match
    // the line via context-stroke. An explicit "line" override always
    // wins over the map-wide default.
    const wantsArrow = child.connectorStyle === "arrow"
      || (!child.connectorStyle && !!(theme && theme.connectorArrow));
    if (orientation !== "v" && wantsArrow) {
      el.setAttribute("marker-end", "url(#connector-arrow)");
    }
    g.appendChild(el);

    // A real parent→child hop (as opposed to the "v" spine connectors
    // chaining sibling branches together in Timeline mode) has an actual
    // distance the user can customize — right-click it to open a small
    // input for that. A wide invisible stroke sits on top so thin (or
    // dotted, level-3+) lines are still easy to hover and right-click.
    if (orientation !== "v") {
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", path);
      hit.setAttribute("class", "connector-hit");
      hit.setAttribute("stroke", "#000");
      hit.setAttribute("stroke-width", Math.max(14, width + 12));
      hit.setAttribute("fill", "none");
      hit.setAttribute("opacity", "0");
      g.appendChild(hit);

      g.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openConnectorContextMenu(e.clientX, e.clientY, parent, child);
      });
    }

    svgEl.appendChild(g);
  }

  // Fast-path update used while dragging or typing: recompute just the
  // connector path(s) touching one node, without a full re-render.
  function updateConnectorDom(parent, child, ox, oy) {
    const g = svgEl.querySelector(`g.connector[data-parent="${parent.id}"][data-child="${child.id}"]`);
    if (!g) return;
    const orientation = g.dataset.orientation || "h";
    const path = orientation === "v"
      ? connectorPathVertical(parent, child, ox, oy)
      : connectorPath(parent, child, ox, oy);
    g.querySelectorAll("path").forEach(p => p.setAttribute("d", path));
  }

  // Refreshes every connector touching a node, whether it's that node's tree
  // parent/children or (in Timeline mode) a spine link to a sibling branch.
  function refreshConnectorsFor(node) {
    const touching = svgEl.querySelectorAll(`g.connector[data-parent="${node.id}"], g.connector[data-child="${node.id}"]`);
    touching.forEach(g => {
      const p = findNode(g.dataset.parent), c = findNode(g.dataset.child);
      if (p && c) updateConnectorDom(p, c, state.originX, state.originY);
    });
  }

  // Fast-path used while dragging: move a node's div and the connectors
  // touching it, without re-running the full layout.
  function updateNodePositionDom(node) {
    const div = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
    if (div) {
      const w = node._w || NODE_H, h = node._h || NODE_H;
      div.style.left = (state.originX + nodeLeftX(node)) + "px";
      div.style.top = (state.originY + node._y + (node.oy || 0) - h / 2) + "px";
    }
    refreshConnectorsFor(node);
  }

  // Fast-path used while dragging: move one cross-link's path without a
  // full re-render (mirrors updateNodePositionDom for tree connectors).
  function updateLinkDom(link, a, b) {
    const g = svgEl.querySelector(`g.connector[data-link="${link.id}"]`);
    if (!g) return;
    const path = linkPath(a, b, state.originX, state.originY);
    g.querySelectorAll("path").forEach(p => p.setAttribute("d", path));
  }

  // Re-runs layout (which may reorder siblings, flip a side, or resize the
  // canvas) but — unlike renderAll() — never touches nodesLayer.innerHTML or
  // svgEl.innerHTML, so every existing node div and connector line is just
  // moved to its new spot instead of being torn down and recreated. That
  // full rebuild is what caused the visible blink when a drag crossed the
  // center line or reordered siblings. Only safe to call when the set of
  // nodes/connectors on screen hasn't changed shape (nothing added or
  // removed, no collapse toggled) — exactly the case while a drag is live.
  //
  // freezeOrigin (used while a drag is in progress) keeps state.originX/
  // originY and the world/svg canvas size exactly as they were, instead of
  // recomputing them from the fresh bounding box. Every node's on-screen
  // position is originX/originY plus its own local coordinate, so without
  // this, a side-flip or reorder that shifts the bounding box (e.g. a
  // branch now reaching further left) shifts that shared origin — which
  // visibly nudges EVERY node, including ones that didn't logically move
  // at all, like the dragged node's parent or the root. Freezing origin
  // during the drag keeps those untouched nodes visually still; the
  // canvas is resized/recentered properly in one shot once the drag ends.
  function repositionAll(freezeOrigin) {
    if (!state.current) return;
    const bbox = layout(state.current.root);

    if (!freezeOrigin) {
      const pad = 140;
      const width = (bbox.maxX - bbox.minX) + pad * 2;
      const height = (bbox.maxY - bbox.minY) + pad * 2;
      state.originX = -bbox.minX + pad;
      state.originY = -bbox.minY + pad;

      worldEl.style.width = width + "px";
      worldEl.style.height = height + "px";
      svgEl.setAttribute("width", width);
      svgEl.setAttribute("height", height);
      svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }

    const nodes = [];
    (function collect(n) { nodes.push(n); if (!n.collapsed) (n.children || []).forEach(collect); })(state.current.root);
    for (const n of nodes) updateNodePositionDom(n);

    if (state.current.links && state.current.links.length) {
      for (const link of state.current.links) {
        const a = findNode(link.a), b = findNode(link.b);
        if (a && b) updateLinkDom(link, a, b);
      }
    }
  }

  let dragCandidate = null;
  let suppressNextNodeClick = false;

  // On touch, a finger landing on a node and immediately moving is far more
  // often the start of a canvas pan/scroll than an attempt to drag that
  // node — so a node drag only actually arms after the finger has held
  // still on the node for TOUCH_DRAG_HOLD_MS. Until then, the touch is
  // "pending": if it moves more than TOUCH_DRAG_CANCEL_DIST before the
  // hold completes, it's treated as a pan starting from the node instead
  // (see the pointermove listener below); if it lifts before the hold
  // completes, it's just a tap (the existing click listener already
  // handles that). Mouse/pen drags are unaffected and still start
  // immediately on mousedown/pointerdown, since there's no scrolling
  // gesture to disambiguate from there.
  const TOUCH_DRAG_HOLD_MS = 350;
  const TOUCH_DRAG_CANCEL_DIST = 10;
  let touchDragArm = null;
  function clearTouchDragArm() {
    if (touchDragArm) { clearTimeout(touchDragArm.timer); touchDragArm = null; }
  }

  // Tracks every touch currently down anywhere in the viewport (canvas
  // background or on a node), keyed by pointerId, so a second finger
  // landing mid-gesture can be recognized as the start of a pinch-zoom
  // regardless of what the first finger touched. Mouse/pen pointers are
  // never added here — only "touch" ones (see viewportEl's pointerdown
  // listener below), since pinch is a touch-only gesture.
  const activePointers = new Map();

  // v516: a calendar can cover most of a phone screen. Treat a swipe that
  // begins on its ordinary cell/text surface like a swipe on empty canvas,
  // while preserving taps for editing and all explicit icon/badge controls.
  let calendarPanArm = null;
  function clearCalendarPanArm() { calendarPanArm = null; }
  function calendarPanSurface(target) {
    if (!target || !target.closest) return false;
    const calendar = target.closest(".node-table-calendar");
    if (!calendar) return false;
    // Explicit controls keep their own touch behavior.
    if (target.closest(".node-table-cell-icons, .task-score-badge, button, input, select, textarea, a")) return false;
    return true;
  }

  // Dragging a node's task ring / progress bar / photo strip onto a
  // *different* node moves (or, with Alt/Option held, copies) that data
  // over — an easy way to reassign a checklist or a batch of photos
  // without opening menus. Uses native HTML5 drag-and-drop rather than
  // the mouse-based dragCandidate mechanism above (which is reserved for
  // repositioning/reparenting whole nodes), so the two never collide.
  let markerDragState = null;
  const MARKER_DRAG_MIME = "application/x-branchline-marker";
  const MARKER_DRAG_TEXT_PREFIX = "branchline-marker:";
  let markerDragSeq = 0;

  function makeMarkerDragPayload(node, type, extra) {
    return Object.assign({
      type,
      sourceNodeId: node.id,
      dragToken: ++markerDragSeq
    }, extra || {});
  }

  function markerDragPayloadValid(payload) {
    return !!(payload && payload.type && payload.sourceNodeId);
  }

  function writeMarkerDragPayload(e, payload) {
    if (!e || !e.dataTransfer || !markerDragPayloadValid(payload)) return;
    const raw = JSON.stringify(payload);
    try { e.dataTransfer.effectAllowed = "copyMove"; } catch (_) {}
    // Keep a Branchline-specific MIME payload so a transient DOM rebuild or
    // browser drag lifecycle quirk cannot make the drop forget its source.
    try { e.dataTransfer.setData(MARKER_DRAG_MIME, raw); } catch (_) {}
    // Firefox requires some text payload; this also gives us a second
    // recovery path on browsers that strip custom MIME types.
    try { e.dataTransfer.setData("text/plain", MARKER_DRAG_TEXT_PREFIX + raw); } catch (_) {}
  }

  function readMarkerDragPayload(e) {
    if (markerDragPayloadValid(markerDragState)) return markerDragState;
    const dt = e && e.dataTransfer;
    if (!dt) return null;
    let raw = "";
    try { raw = dt.getData(MARKER_DRAG_MIME) || ""; } catch (_) {}
    if (!raw) {
      try {
        const textPayload = dt.getData("text/plain") || "";
        if (textPayload.startsWith(MARKER_DRAG_TEXT_PREFIX)) {
          raw = textPayload.slice(MARKER_DRAG_TEXT_PREFIX.length);
        }
      } catch (_) {}
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!markerDragPayloadValid(parsed)) return null;
      markerDragState = parsed;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function markerDragAvailable(e) {
    if (markerDragPayloadValid(markerDragState)) return true;
    const types = e && e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    try {
      return Array.from(types).includes(MARKER_DRAG_MIME);
    } catch (_) {
      return false;
    }
  }

  function clearMarkerDropHighlights() {
    // v539: include summary-Calendar cells too. They live outside nodesLayer
    // but are real marker drop targets backed by Calendar Child cells.
    document.querySelectorAll(".node.marker-drop-target, .node-table-cell.marker-drop-target")
      .forEach(d => d.classList.remove("marker-drop-target"));
  }

  // v421: use an explicit drag image sized from the actual marker wrapper.
  // Without this Chromium may snapshot the embedded DRC PNG at a much larger
  // intrinsic size than the tiny calendar-cell icon.
  function setMarkerNativeDragImage(e, sourceEl) {
    const dt = e && e.dataTransfer;
    if (!dt || typeof dt.setDragImage !== "function" || !sourceEl) return;
    const rect = sourceEl.getBoundingClientRect();
    const w = Math.max(8, Math.round(rect.width || 10));
    const h = Math.max(8, Math.round(rect.height || 10));
    const ghost = sourceEl.cloneNode(true);
    ghost.removeAttribute("id");
    ghost.classList.remove("marker-dragging");
    ghost.classList.add("marker-native-drag-ghost");
    ghost.style.setProperty("--marker-ghost-w", w + "px");
    ghost.style.setProperty("--marker-ghost-h", h + "px");
    document.body.appendChild(ghost);
    try { dt.setDragImage(ghost, Math.round(w / 2), Math.round(h / 2)); } catch (_) {}
    setTimeout(() => ghost.remove(), 0);
  }

  function startMarkerDrag(e, node, type, extra) {
    e.stopPropagation();
    if (!requireSignIn()) { e.preventDefault(); return; }
    const payload = makeMarkerDragPayload(node, type, extra);
    markerDragState = payload;
    writeMarkerDragPayload(e, payload);
    setMarkerNativeDragImage(e, e.currentTarget);
    e.currentTarget.classList.add("marker-dragging");
  }

  function endMarkerDrag(e) {
    if (e && e.currentTarget) e.currentTarget.classList.remove("marker-dragging");
    const endedToken = markerDragState && markerDragState.dragToken;
    clearMarkerDropHighlights();
    // Some Chromium/WebView builds can deliver dragend while the drop is
    // still unwinding. Clear on the next task, and only if a newer drag has
    // not started meanwhile.
    setTimeout(() => {
      if (!markerDragState || markerDragState.dragToken === endedToken) markerDragState = null;
    }, 0);
  }

  // Native HTML5 drag-and-drop is unreliable on touch browsers. Give every
  // draggable marker a pointer-driven fallback: move a finger far enough to
  // arm the drag, highlight the node/cell under it, then drop on pointerup.
  // A tap still behaves exactly like the marker's normal click action.
  let touchMarkerDrag = null;
  let suppressMarkerClickUntil = 0;
  // v435: phone marker dragging follows the same hold-before-drag rule as
  // whole-node dragging. A quick swipe that starts on an icon should pan the
  // map; only a deliberate hold can arm moving that icon.
  const TOUCH_MARKER_DRAG_HOLD_MS = TOUCH_DRAG_HOLD_MS;
  const TOUCH_MARKER_DRAG_CANCEL_DIST = TOUCH_DRAG_CANCEL_DIST;
  const TOUCH_MARKER_DRAG_DIST = 7;

  function armMarkerTouchDrag(el, node, type, extra) {
    if (!el) return;
    el.dataset.markerDragSource = "1";
    // Full-color DRC/plan/link icons often contain an <img>/<svg>; the child
    // must never start its own browser image drag instead of the marker drag.
    el.querySelectorAll("img").forEach(img => { img.draggable = false; });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || e.button !== 0) return;
      e.stopPropagation();

      // Cancel any stale pending marker gesture before arming this one.
      cleanupTouchMarkerDrag();

      const pointerId = e.pointerId;
      touchMarkerDrag = {
        pointerId,
        sourceEl: el,
        payload: makeMarkerDragPayload(node, type, extra),
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        holdReady: false,
        active: false,
        target: null,
        ghost: null,
        timer: null
      };

      // Do NOT capture the pointer yet. While this timer is pending a swipe
      // must still be allowed to turn into canvas pan. Pointer capture only
      // begins after the deliberate hold completes.
      touchMarkerDrag.timer = setTimeout(() => {
        const d = touchMarkerDrag;
        if (!d || d.pointerId !== pointerId) return;
        if (activePointers.size > 1) { cleanupTouchMarkerDrag(); return; }
        d.timer = null;
        d.holdReady = true;
        try { d.sourceEl.setPointerCapture(pointerId); } catch (_) {}
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) {}
      }, TOUCH_MARKER_DRAG_HOLD_MS);
    });
  }

  function markerDropTargetAt(x, y, payload) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    const cell = hit.closest && hit.closest(".node-table-cell");
    if (cell) {
      // v539: a top summary-Calendar date is backed by the first canonical
      // Calendar Child occurrence for that date. Treat it as that exact cell
      // for touch marker dragging, even though the modal is outside nodesLayer.
      const summaryNodeId = cell.dataset && cell.dataset.summaryNodeId;
      const nodeEl = cell.closest(".node[data-id]");
      if (summaryNodeId || nodeEl) {
        const target = {
          nodeId: summaryNodeId || nodeEl.dataset.id,
          r: Number(cell.dataset.r),
          c: Number(cell.dataset.c),
          el: cell
        };
        if (!(payload.sourceNodeId === target.nodeId &&
              payload.sourceR === target.r && payload.sourceC === target.c)) {
          return target;
        }
        return null;
      }
    }
    const nodeEl = hit.closest && hit.closest(".node[data-id]");
    if (!nodeEl) return null;
    const target = { nodeId: nodeEl.dataset.id, r: null, c: null, el: nodeEl };
    if (payload.sourceNodeId === target.nodeId &&
        payload.sourceR == null && payload.sourceC == null) return null;
    return target;
  }

  function setTouchMarkerDropTarget(target) {
    clearMarkerDropHighlights();
    if (target && target.el) target.el.classList.add("marker-drop-target");
  }

  function cleanupTouchMarkerDrag() {
    const d = touchMarkerDrag;
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
    if (d.sourceEl) d.sourceEl.classList.remove("marker-dragging");
    if (d.ghost && d.ghost.remove) d.ghost.remove();
    clearMarkerDropHighlights();
    try { d.sourceEl && d.sourceEl.releasePointerCapture(d.pointerId); } catch (_) {}
    touchMarkerDrag = null;
  }

  window.addEventListener("pointermove", (e) => {
    const d = touchMarkerDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX; d.y = e.clientY;
    const dx = d.x - d.startX, dy = d.y - d.startY;
    const dist = Math.hypot(dx, dy);

    // Finger moved before the minimum hold completed: this is a map swipe,
    // not an icon drag. Cancel the marker gesture and hand the same movement
    // to the canvas pan path from the original touch-down coordinates.
    if (!d.holdReady) {
      if (dist < TOUCH_MARKER_DRAG_CANCEL_DIST) return;
      const startX = d.startX, startY = d.startY;
      suppressMarkerClickUntil = Date.now() + 500;
      cleanupTouchMarkerDrag();
      startPan(startX, startY);
      return;
    }

    if (!d.active) {
      if (dist < TOUCH_MARKER_DRAG_DIST) return;
      if (!requireSignIn()) { cleanupTouchMarkerDrag(); return; }
      d.active = true;
      markerDragState = d.payload;
      d.sourceEl.classList.add("marker-dragging");
      const sourceRect = d.sourceEl.getBoundingClientRect();
      const ghostW = Math.max(8, Math.round(sourceRect.width || 10));
      const ghostH = Math.max(8, Math.round(sourceRect.height || 10));
      const ghost = d.sourceEl.cloneNode(true);
      ghost.removeAttribute("id");
      ghost.classList.add("marker-touch-ghost");
      ghost.classList.remove("marker-dragging");
      ghost.style.setProperty("--marker-ghost-w", ghostW + "px");
      ghost.style.setProperty("--marker-ghost-h", ghostH + "px");
      document.body.appendChild(ghost);
      d.ghost = ghost;
    }
    e.preventDefault();
    if (d.ghost) {
      d.ghost.style.left = (d.x + 12) + "px";
      d.ghost.style.top = (d.y + 12) + "px";
    }
    d.target = markerDropTargetAt(d.x, d.y, d.payload);
    setTouchMarkerDropTarget(d.target);
  }, { passive: false });

  window.addEventListener("pointerup", (e) => {
    const d = touchMarkerDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) { cleanupTouchMarkerDrag(); return; }
    e.preventDefault();
    d.target = markerDropTargetAt(e.clientX, e.clientY, d.payload) || d.target;
    const target = d.target;
    suppressMarkerClickUntil = Date.now() + 500;
    if (target) {
      markerDragState = d.payload;
      completeMarkerDrop(target.nodeId, false, target.r, target.c);
    }
    cleanupTouchMarkerDrag();
    markerDragState = null;
  }, { passive: false });

  window.addEventListener("pointercancel", (e) => {
    if (!touchMarkerDrag || e.pointerId !== touchMarkerDrag.pointerId) return;
    cleanupTouchMarkerDrag();
    markerDragState = null;
  });

  // Prevent the synthetic click that mobile browsers may emit after a
  // completed pointer drag from immediately opening the marker we just moved.
  document.addEventListener("click", (e) => {
    if (Date.now() > suppressMarkerClickUntil) return;
    const marker = e.target && e.target.closest &&
      e.target.closest('[data-marker-drag-source="1"]');
    if (!marker) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    suppressMarkerClickUntil = 0;
  }, true);

  // Applies a completed marker drop: merges the dragged data onto the
  // target (a whole node, or — when targetR/targetC are given — one
  // specific table cell of that node), then (unless the user held Alt/
  // Option to copy) clears it from the source so it reads as a move
  // rather than a duplication. The source is likewise either a whole
  // node or one of its cells, per markerDragState.sourceR/sourceC (set
  // by startMarkerDrag — see the cell icon strip and the node-level
  // strip below). Node and cell attach records share the same field
  // shapes (images/notes/urls/tasks/linkTitles — see getCellAttach and
  // the getNode*/getCell* pairs above), so every branch below reads and
  // writes `source`/`target` without caring which kind either one is —
  // that's what makes node→cell, cell→node, and cell→cell drags all
  // fall out of the same code as the original node→node case.
  function completeMarkerDrop(targetId, copy, targetR, targetC) {
    if (!markerDragState) return;
    const { type, sourceNodeId, photoIndex, overflowFrom, sourceR, sourceC, sourceTaskId, sourceSubtaskId } = markerDragState;
    const hasTargetCell = targetR != null && targetC != null;
    const hasSourceCell = sourceR != null && sourceC != null;
    // Dropping something exactly back where it came from is a no-op —
    // same node AND same cell (or same node with neither side scoped to
    // a cell, i.e. a whole-node marker dropped on its own node).
    if (sourceNodeId === targetId &&
        (hasSourceCell === hasTargetCell) &&
        (!hasSourceCell || (sourceR === targetR && sourceC === targetC))) {
      return;
    }
    const sourceNode = findNode(sourceNodeId);
    const targetNode = findNode(targetId);
    if (!sourceNode || !targetNode) return;
    const source = hasSourceCell ? getCellAttach(sourceNode, sourceR, sourceC) : sourceNode;
    const target = hasTargetCell ? getCellAttach(targetNode, targetR, targetC) : targetNode;
    if (!source || !target) return;
    const sourceTarget = { nodeId: sourceNodeId, r: sourceR, c: sourceC };
    const targetTarget = { nodeId: targetId, r: targetR, c: targetC };

    if (type === "tasks") {
      const srcTasks = getNodeTasks(source);
      if (!srcTasks.length) return;
      pushUndo();
      const carried = copy
        ? srcTasks.map(t => Object.assign({}, t, {
            id: uid(),
            subtasks: getTaskSubtasks(t).map(s => Object.assign({}, s, { id: uid() })),
          }))
        : srcTasks;
      target.tasks = getNodeTasks(target).concat(carried);
      if (!copy) {
        source.tasks = [];
        if (focusTimer && sameTarget(focusTimer.target, sourceTarget)) focusTimer.target = targetTarget;
        if (focusJustCompleted && sameTarget(focusJustCompleted.target, sourceTarget)) focusJustCompleted.target = targetTarget;
      }
    } else if (type === "affirmation") {
      const srcAff = getNodeAffirmation(source);
      if (!srcAff) return;
      pushUndo();
      const srcCopy = JSON.parse(JSON.stringify(srcAff));
      const dstAff = getNodeAffirmation(target);
      if (!dstAff) {
        target.affirmation = srcCopy;
      } else {
        const dstActive = !!(dstAff.quote || dstAff.count);
        target.affirmation = Object.assign({}, srcCopy, dstAff, {
          wins: (Number(dstAff.wins) || 0) + (Number(srcCopy.wins) || 0),
          quote: dstActive ? dstAff.quote : srcCopy.quote,
          count: dstActive ? dstAff.count : srcCopy.count,
          target: dstActive ? dstAff.target : srcCopy.target,
        });
      }
      if (!copy) source.affirmation = null;
    } else if (type === "timer") {
      const srcSeconds = getNodeTimePlayed(source);
      if (!srcSeconds) return;
      pushUndo();
      target.timePlayedSec = getNodeTimePlayed(target) + srcSeconds;
      if (!copy) {
        source.timePlayedSec = 0;
        if (nodeTimer && sameTarget(nodeTimer.target, sourceTarget)) nodeTimer.target = targetTarget;
        if (nodeTimerJustCompleted && sameTarget(nodeTimerJustCompleted, sourceTarget)) nodeTimerJustCompleted = targetTarget;
        if (timerEditingId && sameTarget(timerEditingId, sourceTarget)) timerEditingId = targetTarget;
      }
    } else if (type === "task-notes") {
      const srcTask = getNodeTasks(source).find(t => t.id === sourceTaskId);
      if (!srcTask) return;
      const srcOwner = sourceSubtaskId
        ? getTaskSubtasks(srcTask).find(s => s.id === sourceSubtaskId)
        : srcTask;
      if (!srcOwner) return;
      const srcNotes = getTaskNotes(srcOwner).slice();
      if (!srcNotes.length) return;
      const dstNotes = getNodeNotes(target).slice();
      if (srcNotes.some(isBrainstormNote) &&
          (dstNotes.some(isBrainstormNote) || hasBrainstormContent(target))) return;
      if (srcNotes.some(isDRCNote) && dstNotes.some(isDRCNote)) return;
      pushUndo();
      const carried = copy
        ? srcNotes.map(n => Object.assign({}, JSON.parse(JSON.stringify(n)), {
            id: uid(), createdAt: Date.now(), updatedAt: Date.now()
          }))
        : srcNotes;
      target.notes = dstNotes.concat(carried);
      target.note = "";
      if (carried.some(isBrainstormNote)) syncBrainstormMirrorFromNotes(target);
      if (!copy) {
        srcOwner.notes = [];
        srcOwner.note = "";
      }
    } else if (type === "photos") {
      const srcIds = getNodeImageIds(source);
      if (!srcIds.length) return;
      pushUndo();
      const carriedIds = copy ? srcIds.map((id) => duplicatePhotoRecord(id, getNodeImageIds(target))) : srcIds;
      const pairs = srcIds.map((id, i) => [id, carriedIds[i]]);
      carryPhotoTags(source, target, pairs);
      carryPhotoNotes(source, target, pairs);
      carryPhotoComments(source, target, pairs);
      carryPhotoFavorites(source, target, pairs);
      carryPhotoTimestamps(source, target, pairs);
      target.images = getNodeImageIds(target).concat(carriedIds);
      if (!copy) {
        source.images = []; source.image = null;
        // A real move (not a copy) reuses the same id on the target (see
        // carriedIds above), so the tags/notes/comments just carried over
        // would otherwise also linger under the SOURCE's own id — a
        // leftover that showed up as a permanently broken, unclickable
        // entry in the tag browser once this node no longer actually held
        // that photo (see collectPhotoTagGroups).
        srcIds.forEach(id => { setPhotoTags(source, id, null); setPhotoNotes(source, id, null); setPhotoComment(source, id, null); setPhotoTimestamp(source, id, null); });
      }
    } else if (type === "photo") {
      // A single thumbnail, dragged by its index in the source's images.
      const srcIds = getNodeImageIds(source);
      if (photoIndex == null || photoIndex < 0 || photoIndex >= srcIds.length) return;
      pushUndo();
      const movedId = srcIds[photoIndex];
      const carriedId = copy ? duplicatePhotoRecord(movedId, getNodeImageIds(target)) : movedId;
      carryPhotoTags(source, target, [[movedId, carriedId]]);
      carryPhotoNotes(source, target, [[movedId, carriedId]]);
      carryPhotoComments(source, target, [[movedId, carriedId]]);
      carryPhotoFavorites(source, target, [[movedId, carriedId]]);
      carryPhotoTimestamps(source, target, [[movedId, carriedId]]);
      target.images = getNodeImageIds(target).concat([carriedId]);
      if (!copy) {
        const remaining = srcIds.slice();
        remaining.splice(photoIndex, 1);
        source.images = remaining;
        source.image = null;
        // Same cleanup as the bulk "photos" case above.
        setPhotoTags(source, movedId, null);
        setPhotoNotes(source, movedId, null);
        setPhotoComment(source, movedId, null);
        setPhotoTimestamp(source, movedId, null);
      }
    } else if (type === "photos-overflow") {
      // The "+N" badge — everything past the thumbnails actually shown.
      const srcIds = getNodeImageIds(source);
      const carried = srcIds.slice(overflowFrom || 0);
      if (!carried.length) return;
      pushUndo();
      const carriedIds = copy ? carried.map(duplicatePhotoRecord) : carried;
      const pairs = carried.map((id, i) => [id, carriedIds[i]]);
      carryPhotoTags(source, target, pairs);
      carryPhotoNotes(source, target, pairs);
      carryPhotoComments(source, target, pairs);
      carryPhotoFavorites(source, target, pairs);
      carryPhotoTimestamps(source, target, pairs);
      target.images = getNodeImageIds(target).concat(carriedIds);
      if (!copy) {
        source.images = srcIds.slice(0, overflowFrom || 0);
        source.image = null;
        // Same cleanup as the bulk "photos" case above.
        carried.forEach(id => { setPhotoTags(source, id, null); setPhotoNotes(source, id, null); setPhotoComment(source, id, null); setPhotoTimestamp(source, id, null); });
      }
    } else if (type === "notes") {
      const srcNotes = getNodeNotes(source).slice();
      if (!srcNotes.length) return;
      const dstNotes = getNodeNotes(target).slice();
      if (srcNotes.some(isBrainstormNote) &&
          (dstNotes.some(isBrainstormNote) || hasBrainstormContent(target))) return;
      if (srcNotes.some(isDRCNote) && dstNotes.some(isDRCNote)) return;
      pushUndo();
      const carried = copy
        ? srcNotes.map(n => Object.assign({}, JSON.parse(JSON.stringify(n)), {
            id: uid(), createdAt: Date.now(), updatedAt: Date.now()
          }))
        : srcNotes;
      target.notes = dstNotes.concat(carried);
      target.note = "";
      if (carried.some(isBrainstormNote)) syncBrainstormMirrorFromNotes(target);
      if (!copy) {
        source.notes = [];
        source.note = "";
        if (srcNotes.some(isBrainstormNote)) syncBrainstormMirrorFromNotes(source);
      }
    } else if (type === "brainstorm") {
      // v424: the dedicated pink brain represents exactly one Brainstorm
      // content host. Move that Brainstorm alone, not the cell's other notes.
      // Newer data stores Brainstorm as a Note variant plus a mirror; older
      // maps may still have only host.brainstorm, so support both shapes.
      const srcNotes = getNodeNotes(source).slice();
      const srcIndex = srcNotes.findIndex(isBrainstormNote);
      const srcHasLegacy = hasBrainstormContent(source);
      if (srcIndex < 0 && !srcHasLegacy) return;

      const dstNotes = getNodeNotes(target).slice();
      const dstHasBrainstorm = dstNotes.some(isBrainstormNote) || hasBrainstormContent(target);
      if (dstHasBrainstorm) return; // one Brainstorm per node/cell

      pushUndo();
      let movedNote;
      if (srcIndex >= 0) {
        movedNote = srcNotes[srcIndex];
      } else {
        const now = Date.now();
        movedNote = {
          id: uid(),
          title: "",
          html: getBrainstormHtml(source),
          kind: "brainstorm",
          createdAt: now,
          updatedAt: now
        };
      }
      if (copy) {
        movedNote = Object.assign({}, movedNote, {
          id: uid(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }

      target.notes = dstNotes.concat([movedNote]);
      target.note = "";
      syncBrainstormMirrorFromNotes(target);

      if (!copy) {
        if (srcIndex >= 0) {
          srcNotes.splice(srcIndex, 1);
          source.notes = srcNotes;
          source.note = "";
          syncBrainstormMirrorFromNotes(source);
        } else {
          source.brainstorm = null;
        }
      }
    } else if (type === "note-single") {
      const { noteIndex } = markerDragState;
      const srcNotes = getNodeNotes(source);
      if (noteIndex == null || noteIndex < 0 || noteIndex >= srcNotes.length) return;
      const movedNote = srcNotes[noteIndex];
      const dstNotes = getNodeNotes(target).slice();
      if (isBrainstormNote(movedNote) &&
          (dstNotes.some(isBrainstormNote) || hasBrainstormContent(target))) return;
      if (isDRCNote(movedNote) && dstNotes.some(isDRCNote)) return;
      pushUndo();
      const carriedNote = copy
        ? Object.assign({}, JSON.parse(JSON.stringify(movedNote)), {
            id: uid(), createdAt: Date.now(), updatedAt: Date.now()
          })
        : movedNote;
      target.notes = dstNotes.concat([carriedNote]);
      target.note = "";
      if (isBrainstormNote(carriedNote)) syncBrainstormMirrorFromNotes(target);
      if (!copy) {
        const remaining = srcNotes.slice();
        remaining.splice(noteIndex, 1);
        source.notes = remaining;
        source.note = "";
        if (isBrainstormNote(movedNote)) syncBrainstormMirrorFromNotes(source);
      }
    } else if (type === "urls") {
      const srcUrls = getNodeUrls(source);
      if (!srcUrls.length) return;
      pushUndo();
      carryLinkTitles(source, target, srcUrls);
      carryLinkTimestamps(source, target, srcUrls);
      target.urls = getNodeUrls(target).concat(srcUrls);
      target.url = null;
      if (!copy) { source.urls = []; source.url = null; }
    } else if (type === "url-single") {
      // A single link, dragged by its index in the source's urls — same
      // shape as the "photo"/"note-single" single-item cases above.
      const { urlIndex } = markerDragState;
      const srcUrls = getNodeUrls(source);
      if (urlIndex == null || urlIndex < 0 || urlIndex >= srcUrls.length) return;
      pushUndo();
      const movedUrl = srcUrls[urlIndex];
      carryLinkTitles(source, target, [movedUrl]);
      carryLinkTimestamps(source, target, [movedUrl]);
      target.urls = getNodeUrls(target).concat([movedUrl]);
      target.url = null;
      if (!copy) {
        const remaining = srcUrls.slice();
        remaining.splice(urlIndex, 1);
        source.urls = remaining;
        source.url = null;
      }
    } else {
      return;
    }
    markerDragState = null;
    clearMarkerDropHighlights();
    renderAll();
    persist();
  }

  // v428: one in-app clipboard for ALL node/cell markers. A cell is a
  // mini-node, so the exact same snapshot can be copied from either host and
  // pasted onto either host. Text/children/table geometry are deliberately
  // excluded — this clipboard is only for things represented by icons/badges.
  let allIconsClipboard = null;

  function clonePlainIconData(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function cloneNoteForAllIcons(note) {
    const n = clonePlainIconData(note) || {};
    n.id = uid();
    const now = Date.now();
    n.createdAt = now;
    n.updatedAt = now;
    return n;
  }

  function cloneTaskForAllIcons(task) {
    const t = clonePlainIconData(task) || {};
    t.id = uid();
    if (Array.isArray(t.notes)) t.notes = t.notes.map(cloneNoteForAllIcons);
    if (Array.isArray(t.subtasks)) {
      t.subtasks = t.subtasks.map((sub) => {
        const s = clonePlainIconData(sub) || {};
        s.id = uid();
        if (Array.isArray(s.notes)) s.notes = s.notes.map(cloneNoteForAllIcons);
        return s;
      });
    }
    return t;
  }

  function allIconsSnapshot(host) {
    if (!host) return null;
    return {
      images: getNodeImageIds(host).slice(),
      photoTags: clonePlainIconData(host.photoTags || {}),
      photoNotes: clonePlainIconData(host.photoNotes || {}),
      photoComments: clonePlainIconData(host.photoComments || {}),
      photoFavorites: clonePlainIconData(host.photoFavorites || {}),
      photoTimestamps: clonePlainIconData(host.photoTimestamps || {}),

      notes: clonePlainIconData(getNodeNotes(host)),
      brainstorm: clonePlainIconData(host.brainstorm || null),

      urls: getNodeUrls(host).slice(),
      linkTitles: clonePlainIconData(host.linkTitles || {}),
      linkComments: clonePlainIconData(host.linkComments || {}),
      linkFavorites: clonePlainIconData(host.linkFavorites || {}),
      linkTimestamps: clonePlainIconData(host.linkTimestamps || {}),
      linkPhotos: clonePlainIconData(host.linkPhotos || {}),

      // The score badge IS the task icon, so copying all icons copies the
      // complete task/subtask tree represented by that badge.
      tasks: clonePlainIconData(getNodeTasks(host)),
      affirmation: clonePlainIconData(getNodeAffirmation(host)),
      timePlayedSec: getNodeTimePlayed(host)
    };
  }

  function copyAllIconsFromHost(host) {
    const snapshot = allIconsSnapshot(host);
    if (!snapshot) return;
    allIconsClipboard = {
      mapId: state.current && state.current.id,
      copiedAt: Date.now(),
      host: snapshot
    };
  }

  async function duplicateClipboardPhoto(oldId) {
    if (!oldId) return oldId;
    let blob = photoBlobCache.get(oldId) || null;
    if (!blob) {
      try {
        const rec = await PhotoDB.get(oldId);
        blob = rec && rec.blob;
        if (!blob && rec && rec.data) {
          try { blob = dataUrlToBlob(rec.data); } catch (_) {}
        }
      } catch (_) {}
    }
    if (!blob) return oldId;

    const id = uid();
    photoBlobCache.set(id, blob);
    photoCache.set(id, URL.createObjectURL(blob));
    const fp = photoFpById.get(oldId);
    if (fp) rememberPhotoFingerprint(id, fp);
    if (state.current) {
      PhotoDB.put({ id, mapId: state.current.id, blob })
        .catch(e => console.error("Copy all icons: saving photo failed", e));
    }
    return id;
  }

  async function pasteAllIconsToHost(target) {
    if (!target) return;
    if (!allIconsClipboard || !allIconsClipboard.host) {
      alert("No copied icons yet.");
      return;
    }
    const source = allIconsClipboard.host;
    pushUndo();

    // Photos + all photo-owned metadata.
    const sourcePhotoIds = Array.isArray(source.images) ? source.images : [];
    if (sourcePhotoIds.length) {
      const carriedIds = [];
      for (const id of sourcePhotoIds) carriedIds.push(await duplicateClipboardPhoto(id));
      const pairs = sourcePhotoIds.map((id, i) => [id, carriedIds[i]]);
      carryPhotoTags(source, target, pairs);
      carryPhotoNotes(source, target, pairs);
      carryPhotoComments(source, target, pairs);
      carryPhotoFavorites(source, target, pairs);
      carryPhotoTimestamps(source, target, pairs);
      target.images = getNodeImageIds(target).concat(carriedIds);
      target.image = null;
    }

    // Host-level Notes/DRC/Plan/Brainstorm. Keep the one-DRC and
    // one-Brainstorm-per-host rules while still pasting every ordinary note.
    const dstNotes = getNodeNotes(target).slice();
    let hasDstDrc = dstNotes.some(isDRCNote);
    let hasDstBrainstorm = dstNotes.some(isBrainstormNote) || hasBrainstormContent(target);
    const notesToAdd = [];
    (source.notes || []).forEach((n) => {
      if (isBrainstormNote(n)) {
        if (hasDstBrainstorm) return;
        hasDstBrainstorm = true;
      } else if (isDRCNote(n)) {
        if (hasDstDrc) return;
        hasDstDrc = true;
      }
      notesToAdd.push(cloneNoteForAllIcons(n));
    });

    // Compatibility with old maps where Brainstorm existed only in the
    // mirror field and did not yet have a Note-variant entry.
    if (!hasDstBrainstorm && source.brainstorm &&
        ((source.brainstorm.text || "").trim() || (source.brainstorm.html || "").trim())) {
      notesToAdd.push({
        id: uid(),
        title: "",
        kind: "brainstorm",
        html: source.brainstorm.html || noteHtmlFromRaw(source.brainstorm.text || ""),
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      hasDstBrainstorm = true;
    }

    if (notesToAdd.length) {
      target.notes = dstNotes.concat(notesToAdd);
      target.note = "";
      if (notesToAdd.some(isBrainstormNote)) syncBrainstormMirrorFromNotes(target);
    }

    // Links + title/comment/favorite/date + photos attached to link comments.
    const srcUrls = Array.isArray(source.urls) ? source.urls : [];
    if (srcUrls.length) {
      target.urls = getNodeUrls(target).concat(srcUrls);
      target.url = null;
      srcUrls.forEach((u) => {
        if (source.linkTitles && source.linkTitles[u]) {
          if (!target.linkTitles) target.linkTitles = {};
          if (!target.linkTitles[u]) target.linkTitles[u] = source.linkTitles[u];
        }
        if (source.linkComments && source.linkComments[u]) {
          if (!target.linkComments) target.linkComments = {};
          if (!target.linkComments[u]) target.linkComments[u] = source.linkComments[u];
        }
        if (source.linkFavorites && source.linkFavorites[u]) {
          if (!target.linkFavorites) target.linkFavorites = {};
          target.linkFavorites[u] = true;
        }
        if (source.linkTimestamps && source.linkTimestamps[u]) {
          if (!target.linkTimestamps) target.linkTimestamps = {};
          if (!target.linkTimestamps[u]) target.linkTimestamps[u] = source.linkTimestamps[u];
        }
      });

      if (source.linkPhotos) {
        for (const u of srcUrls) {
          const ids = Array.isArray(source.linkPhotos[u]) ? source.linkPhotos[u] : [];
          if (!ids.length) continue;
          if (!target.linkPhotos) target.linkPhotos = {};
          if (!Array.isArray(target.linkPhotos[u])) target.linkPhotos[u] = [];
          for (const id of ids) target.linkPhotos[u].push(await duplicateClipboardPhoto(id));
        }
      }
    }

    // Task score badge = complete task tree, including notes on tasks/subtasks.
    // v434: copied tasks already use the current 0/1 star model. Mark the
    // destination host as migrated BEFORE its pasted task list is read again;
    // otherwise getNodeTasks() treats a fresh cell host (starsReset missing)
    // as legacy 3-star data and clears the star we just copied.
    if (Array.isArray(source.tasks) && source.tasks.length) {
      const existingTasks = getNodeTasks(target).slice();
      const incomingTasks = source.tasks.map(cloneTaskForAllIcons);
      target.tasks = existingTasks.concat(incomingTasks);
      target.starsReset = true;
    }

    // Singleton status markers merge rather than erase existing target data.
    if (source.affirmation) {
      const srcAff = clonePlainIconData(source.affirmation);
      const dstAff = getNodeAffirmation(target);
      if (!dstAff) {
        target.affirmation = srcAff;
      } else {
        const dstActive = !!(dstAff.quote || dstAff.count);
        target.affirmation = Object.assign({}, srcAff, dstAff, {
          wins: (Number(dstAff.wins) || 0) + (Number(srcAff.wins) || 0),
          quote: dstActive ? dstAff.quote : srcAff.quote,
          count: dstActive ? dstAff.count : srcAff.count,
          target: dstActive ? dstAff.target : srcAff.target
        });
      }
    }

    if (Number(source.timePlayedSec) > 0) {
      target.timePlayedSec = getNodeTimePlayed(target) + Number(source.timePlayedSec);
    }

    renderAll();
    persist();
  }

  // Same little sticky-note glyph the node-level note marker uses (see
  // the photo/note/link strip in renderNode) — shared here so a note
  // attached to a table cell reads as the same icon as a note attached
  // to a whole node.
  // The DRC notebook+pencil icon — one image used everywhere a DRC is
  // shown (node strip marker, right-click menu row, notes browser).
  const NODE_DRC_ICON_DATA_URL = "data:image/png;base64,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";
  const NODE_DRC_ICON_IMG = '<img src="' + NODE_DRC_ICON_DATA_URL + '" alt="DRC" style="width:100%;height:100%;object-fit:contain;">';
  // Small inline DRC icon sized for text rows (menu labels, list icons).
  function drcIconEl(px) {
    const el = document.createElement("span");
    el.className = "drc-icon-inline";
    el.style.width = px + "px";
    el.style.height = px + "px";
    el.innerHTML = NODE_DRC_ICON_IMG;
    return el;
  }
  // The PLAN checklist-sheet icon — shown instead of the yellow sticky
  // note for any note titled "plan" or belonging to a task/subtask named
  // "plan" (see isPlanNote/isPlanNoteFor). Same embedding approach as the
  // DRC icon: a base64 PNG with the outer white background made
  // transparent.
  const NODE_PLAN_ICON_DATA_URL = "data:image/png;base64,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";
  const NODE_PLAN_ICON_IMG = '<img src="' + NODE_PLAN_ICON_DATA_URL + '" alt="Plan" style="width:100%;height:100%;object-fit:contain;">';
  function planIconEl(px) {
    const el = document.createElement("span");
    el.className = "plan-icon-inline";
    el.style.width = px + "px";
    el.style.height = px + "px";
    el.innerHTML = NODE_PLAN_ICON_IMG;
    return el;
  }

  // Trading workflow icons: Review Backtest = chart + replay arrow;
  // Take 1 trade = target + one rising execution arrow. Inline SVG keeps
  // them crisp in the tiny task/calendar markers on both phone and PC.
  const REVIEW_BACKTEST_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#5B4BC4"/><path d="M5.2 15.9l3.1-3.2 2.8 2.1 4.1-5 3.5 1.7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.4 5.2a6.3 6.3 0 0 0-8.6.8" fill="none" stroke="#9FF3FF" stroke-width="1.65" stroke-linecap="round"/><path d="M8.8 3.8v2.7h2.7" fill="none" stroke="#9FF3FF" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18.2" cy="17.9" r="2.25" fill="#F8C85C" stroke="#fff" stroke-width=".8"/></svg>';
  const TAKE_ONE_TRADE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#2463A8"/><path d="M5.2 17.7h13.6" stroke="#DCEBFF" stroke-width="1.2" stroke-linecap="round"/><path d="M7.1 7.2v7.2M6.1 9h2v3.4h-2zM11.1 5.6v9.8M10.1 8.2h2v4.8h-2zM15.2 8v7.5M14.2 10h2v3.2h-2z" fill="#fff" stroke="#fff" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 18.2l4.5-4.5 2.6 1.7 6.4-6.3" fill="none" stroke="#FFD35A" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.8 9.1h2.7v2.7" fill="none" stroke="#FFD35A" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="13.7" r="1.45" fill="#63E27D" stroke="#fff" stroke-width=".8"/></svg>';
  function specialSubtaskIconSvg(owner) {
    const name = specialSubtaskNoteTemplateName(owner);
    if (name === "Review Backtest") return REVIEW_BACKTEST_ICON_SVG;
    if (name === "Take 1 trade") return TAKE_ONE_TRADE_ICON_SVG;
    return "";
  }
  function specialSubtaskIconEl(owner, px) {
    const svg = specialSubtaskIconSvg(owner);
    if (!svg) return null;
    const el = document.createElement("span");
    el.className = "special-subtask-icon-inline";
    el.style.width = px + "px";
    el.style.height = px + "px";
    el.style.display = "inline-flex";
    el.innerHTML = svg;
    return el;
  }
  const CELL_NOTE_ICON_SVG = '<svg viewBox="0 0 24 24"><rect x="2.3" y="6.3" width="15.4" height="15.4" rx="1" fill="#E08A2E" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.3 4.3a1 1 0 011-1h12a1 1 0 011 1v12.9l-4.3 4.3H7.3a1 1 0 01-1-1z" fill="#F6E266" stroke="#000" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/><path d="M20.3 17.2l-4.3 4.3v-3a1.3 1.3 0 011.3-1.3z" fill="#F0C24E" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/><line x1="9" y1="8.2" x2="18" y2="8.2" stroke="#000" stroke-width="1.15" stroke-linecap="round"/><line x1="9" y1="11.1" x2="18" y2="11.1" stroke="#000" stroke-width="1.15" stroke-linecap="round"/><line x1="9" y1="14" x2="14.5" y2="14" stroke="#000" stroke-width="1.15" stroke-linecap="round"/><path d="M14.4 4.6l3.5-3.5" stroke="#000" stroke-width="1.3" stroke-linecap="round"/><circle cx="19" cy="1.9" r="1.5" fill="#DC7A93" stroke="#000" stroke-width="1"/></svg>';
  // Small inline sticky-note icon sized for text rows (Notes/Favorites
  // browser list rows) — the exact same SVG as the node/cell note
  // markers (CELL_NOTE_ICON_SVG), so a plain note reads as the same
  // yellow note everywhere instead of falling back to a generic emoji.
  // Mirrors drcIconEl's shape/sizing convention above.
  function noteIconEl(px) {
    const el = document.createElement("span");
    el.className = "note-icon-inline";
    el.style.width = px + "px";
    el.style.height = px + "px";
    el.innerHTML = CELL_NOTE_ICON_SVG;
    return el;
  }

  // Same brain glyph the node-level brainstorm marker uses (see the
  // photo/note/link strip in renderNode) — shared here so a cell's own
  // Brainstorm scratchpad reads as the same icon as a node's.
  const CELL_BRAINSTORM_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M12 5A3 3 0 1 1 17.598 6.5"/><path d="M12 5A3 3 0 1 0 6.402 6.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>';

  // A hidden, dedicated file input for cell photos (kept separate from
  // nodeImageInput so picking a photo for a cell can never get confused
  // with picking one for the node itself if both were somehow triggered
  // close together).
  let pendingCellPhoto = null;
  const cellImageInput = document.createElement("input");
  cellImageInput.type = "file";
  cellImageInput.accept = "image/*";
  cellImageInput.multiple = true;
  cellImageInput.style.display = "none";
  document.body.appendChild(cellImageInput);

  // Adds one or more photos to a cell's attach record — exactly
  // handleNodePhotoFiles below, scoped to one cell's `images` array
  // instead of the whole node's.
  function handleCellPhotoFiles(nodeId, r, c, fileList) {
    const node = findNode(nodeId);
    const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith("image/"));
    if (!node || !node.table || !files.length) return;
    const a = getCellAttach(node, r, c);
    if (!Array.isArray(a.images)) a.images = getCellPhotoIds(a);
    pushUndo();
    let remaining = files.length;
    let hadError = false;
    const done = () => {
      remaining--;
      if (remaining === 0) {
        a.image = null; // fully migrated onto the images array
        renderAll();
        persist();
        if (hadError) alert("Some images couldn't be read.");
      }
    };
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const id = addPhotoRecord(reader.result, { avoid: getCellPhotoIds(a) });
        a.images.push(id);
        setPhotoTimestamp(a, id, Date.now());
        done();
      };
      reader.onerror = () => { hadError = true; done(); };
      reader.readAsDataURL(file);
    });
  }

  cellImageInput.addEventListener("change", () => {
    if (cellImageInput.files && cellImageInput.files.length && pendingCellPhoto) {
      handleCellPhotoFiles(pendingCellPhoto.nodeId, pendingCellPhoto.r, pendingCellPhoto.c, cellImageInput.files);
    }
    cellImageInput.value = ""; // reset so picking the same file again still fires change
    pendingCellPhoto = null;
  });
  function openCellPhotoPicker(node, r, c) {
    if (!requireSignIn()) return;
    pendingCellPhoto = { nodeId: node.id, r, c };
    cellImageInput.click();
  }

  // Opens a cell's note in the exact same rich note editor used for a
  // node's own notes and a task's notes (see openNoteModal) — title,
  // rich text, multiple notes with paging, all of it — just scoped to
  // this one cell's attach record instead of the whole node.
  function editCellNote(node, r, c) {
    if (!requireSignIn()) return;
    openNoteModal(node.id, undefined, null, null, { r, c });
  }

  // v417: Every table/calendar cell may own one DRC note of its own.
  // Reuse the same note editor + DRC template as node-level DRC, but keep
  // the note inside this cell's attach record. Reopening jumps to the
  // existing DRC instead of creating duplicates.
  function openCellDRCModal(node, r, c) {
    if (!requireSignIn()) return;
    const notes = getCellNotes(getCellAttach(node, r, c));
    const existingDRCIndex = notes.findIndex(isDRCNote);
    openNoteModal(
      node.id,
      existingDRCIndex >= 0 ? existingDRCIndex : undefined,
      null,
      null,
      { r, c },
      existingDRCIndex < 0
    );
  }

  // Native prompt for adding a new URL to a cell — appends it to the
  // cell's `urls` array, then immediately asks for an optional display
  // name too. Exactly the node-level addNodeUrl flow above, just scoped
  // to one cell's attach record instead of the whole node.
  function addCellUrl(node, r, c) {
    if (!requireSignIn()) return;
    const input = window.prompt("URL to add to this cell:", "https://");
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    if (!trimmed) return;
    const url = normalizeUrl(trimmed);
    const name = window.prompt("Name for this link (leave blank to use the URL):", "");
    pushUndo();
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a).slice();
    urls.push(url);
    a.urls = urls;
    a.url = null; // fully migrated onto the array field
    setLinkTimestamp(a, url, Date.now());
    if (name && name.trim()) setCellLinkTitle(a, url, name);
    renderAll();
    persist();
    if (!getCellLinkTitle(a, url)) fetchCellLinkTitle(node.id, r, c, url);
  }

  // Native prompt for editing (or, if cleared, removing) one existing URL
  // by its index in the cell's `urls` array — exactly editNodeUrl above,
  // scoped to a cell.
  function editCellUrlByIndex(node, r, c, index) {
    if (!requireSignIn()) return;
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a).slice();
    if (index < 0 || index >= urls.length) return;
    const oldUrl = urls[index];
    const input = window.prompt("Edit URL (clear to remove):", oldUrl);
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    pushUndo();
    if (trimmed) {
      const newUrl = normalizeUrl(trimmed);
      urls[index] = newUrl;
      if (newUrl !== oldUrl) {
        setCellLinkTitle(a, oldUrl, null);
        a.urls = urls;
        a.url = null;
        renderAll();
        persist();
        fetchCellLinkTitle(node.id, r, c, newUrl);
        return;
      }
    } else {
      setCellLinkTitle(a, oldUrl, null);
      urls.splice(index, 1);
    }
    a.urls = urls;
    a.url = null;
    renderAll();
    persist();
  }

  // Native prompt for giving a cell's link its own custom name — exactly
  // renameNodeUrl above, scoped to a cell.
  function renameCellUrl(node, r, c, index) {
    if (!requireSignIn()) return;
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a);
    if (index < 0 || index >= urls.length) return;
    const url = urls[index];
    const input = window.prompt("Name for this link (leave blank to just show the URL):", getCellLinkTitle(a, url));
    if (input === null) return; // cancelled
    pushUndo();
    setCellLinkTitle(a, url, input);
    renderAll();
    persist();
  }

  // Removes one URL from a cell by its index — exactly removeNodeUrl
  // above, scoped to a cell.
  function removeCellUrl(node, r, c, index) {
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a).slice();
    if (index < 0 || index >= urls.length) return;
    pushUndo();
    setCellLinkTitle(a, urls[index], null);
    urls.splice(index, 1);
    a.urls = urls;
    a.url = null;
    renderAll();
    persist();
  }

