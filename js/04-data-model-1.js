/* Branchline — js/04-data-model-1.js
   Part 4 of 19 of the former single-file app.js. Contents: data model.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- data model ---------------- */

  function newNode(text) {
    // `side` starts unset on every node. For a direct child of the root in
    // Mindmap layout it gets assigned "left"/"right" automatically the
    // first time it's laid out as a top-level branch — see layoutMindmap —
    // and then stays put across reorders. Any node at any depth can also
    // pick up an explicit "left"/"right" override once the user drags it
    // across the center line: that override makes its whole subtree fan
    // out the same direction as it, instead of blindly following whichever
    // side its parent branch happens to be on — see place() / placeLocal()
    // and maybeFlipSideOnDrop().
    //
    // `xGap` starts unset too. It's the horizontal distance from this
    // node's own parent, overriding the normal depth-based default (wider
    // for the root's direct children, ROOT_X_GAP, then X_GAP for every hop
    // after that). Set by right-clicking the connector above this node —
    // see openConnectorContextMenu() — and, unlike `side`, it only ever
    // affects this one node's own distance from its parent; descendants
    // keep using their own default (or their own override) measured onward
    // from wherever this node ends up.
    //
    // `connectorStyle` is null to inherit the map-wide arrow default, or
    // an explicit "line" (force no arrowhead) or "arrow" (force an
    // arrowhead) that overrides it for just this hop.
    //
    // `connectorShape` works the same way for the line's routing: null
    // inherits the map-wide "curved"/"elbow" default, or an explicit
    // value overrides it for just this hop. Both are set from the
    // combined "Connector style" picker on the connector's own
    // right-click menu, or in bulk from a parent node's menu.
    // `fontColor` is a per-node text color override — null to keep
    // inheriting whatever color the depth/branch rules (and the map-wide
    // custom font color, if the theme has one) would otherwise produce,
    // or an explicit hex string that wins over all of that. Set from the
    // "Font color" swatch row on the node's own right-click menu; a table
    // cell gets the same override on its own attach record instead (see
    // getCellAttach) so a single cell's text can be recolored without
    // affecting the rest of the table.
    return { id: uid(), text: text || "", children: [], collapsed: false, color: null, fontColor: null, bold: false, allCaps: false, struck: false, note: "", notes: [], image: null, images: [], url: null, urls: [], side: null, xGap: null, connectorStyle: null, connectorShape: null, table: null };
  }

  // A "table" node swaps its normal text label for a small editable grid
  // (node.table.cells, a rows x cols array of strings) — everything else
  // about it (drag, color, notes, photos, tasks, connectors...) works the
  // same as any other node. See addTableChild / computeTableBox / the
  // table-rendering branch of renderNode.
  function nodeIsTable(node) {
    return !!(node && node.table && Array.isArray(node.table.cells) && node.table.cells.length);
  }
  function defaultTableCells() {
    return [["", ""], ["", ""]];
  }

  // A table cell can carry the same small set of attachments a regular
  // node can (a photo, a note, a link, a task) — stored in a parallel
  // grid, node.table.attach[r][c], that's kept the same shape as
  // node.table.cells rather than folded into the cell's own text. Each
  // entry is `{ image, note, url, task: { text, done } }`, any of which
  // can be missing/null. ensureTableAttach pads/trims that grid to match
  // cells (rows/cols) on every render, so tableAddRow/Column/Remove*
  // don't each need their own bookkeeping for it — adding or removing a
  // row/column just works the next time the table is drawn.
  function ensureTableAttach(node) {
    if (!node.table) return [];
    const cells = node.table.cells;
    if (!Array.isArray(node.table.attach)) node.table.attach = [];
    const attach = node.table.attach;
    attach.length = cells.length;
    for (let r = 0; r < cells.length; r++) {
      if (!Array.isArray(attach[r])) attach[r] = [];
      attach[r].length = cells[r].length;
      for (let c = 0; c < cells[r].length; c++) {
        if (!attach[r][c] || typeof attach[r][c] !== "object") attach[r][c] = {};
      }
      node.table.attach[r] = attach[r];
    }
    // A row/column can only ever be removed from the end (see
    // tableRemoveRow/tableRemoveColumn), so a saved merge (see
    // mergeCellRange below) can end up pointing past the grid's current
    // bounds. Clip each merge to whatever's still there, and drop it
    // entirely once it no longer covers more than one cell — same
    // "sanitize on every render" spirit as the padding above, so no
    // removal call site needs its own merge bookkeeping.
    if (Array.isArray(node.table.merges) && node.table.merges.length) {
      const rows = cells.length;
      const cols = cells[0] ? cells[0].length : 0;
      node.table.merges = node.table.merges
        .map(m => ({ r0: m.r0, c0: m.c0, r1: Math.min(m.r1, rows - 1), c1: Math.min(m.c1, cols - 1) }))
        .filter(m => m.r0 <= m.r1 && m.c0 <= m.c1 && m.r0 < rows && m.c0 < cols && (m.r1 > m.r0 || m.c1 > m.c0));
    }
    return attach;
  }
  // A table cell can be merged with its neighbors into one rectangular
  // block — node.table.merges is a flat list of {r0, c0, r1, c1} rects
  // (inclusive), each naming the covered cells. The top-left cell of a
  // rect (r0, c0) is that block's "origin": it's the only one that
  // actually renders a <td> (with rowSpan/colSpan set to cover the rest —
  // see renderTableGrid), keeps its own text/attach record, and is what
  // buildCellIconStrip/openCellAddMenu are called with. The other cells
  // covered by the rect are simply skipped when rendering; their
  // underlying text/attach data is left untouched so unmerging restores
  // whatever was there before, rather than being lost.
  function ensureTableMerges(node) {
    if (!node.table) return [];
    if (!Array.isArray(node.table.merges)) node.table.merges = [];
    return node.table.merges;
  }
  function getCellMerge(node, r, c) {
    return ensureTableMerges(node).find(m => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null;
  }
  function isMergeOrigin(node, r, c) {
    const m = getCellMerge(node, r, c);
    return !m || (m.r0 === r && m.c0 === c);
  }
  function cellSpan(node, r, c) {
    const m = getCellMerge(node, r, c);
    return m ? { rowSpan: m.r1 - m.r0 + 1, colSpan: m.c1 - m.c0 + 1 } : { rowSpan: 1, colSpan: 1 };
  }
  // Merges the rectangle between two corner cells. Any existing merge
  // that overlaps the new rectangle is dropped first — merging a
  // selection that partly overlaps other merged blocks folds everything
  // into one new block instead of leaving stale, now-inconsistent ones
  // behind.
  function mergeCellRange(node, r0, c0, r1, c1) {
    const merges = ensureTableMerges(node);
    const nr0 = Math.min(r0, r1), nr1 = Math.max(r0, r1);
    const nc0 = Math.min(c0, c1), nc1 = Math.max(c0, c1);
    node.table.merges = merges.filter(m => m.r1 < nr0 || m.r0 > nr1 || m.c1 < nc0 || m.c0 > nc1);
    node.table.merges.push({ r0: nr0, c0: nc0, r1: nr1, c1: nc1 });
  }
  function unmergeCellAt(node, r, c) {
    const merges = ensureTableMerges(node);
    const idx = merges.findIndex(m => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);
    if (idx !== -1) merges.splice(idx, 1);
  }
  function getCellAttach(node, r, c) {
    const a = ensureTableAttach(node)[r][c];
    // A cell used to hold a single task as a.task = {text, done}. Tasks
    // are now a full list (a.tasks = [{id, text, done, stars, due,
    // subtasks, notes}]) matching node.tasks exactly, so a getNodeTasks/
    // nodeTaskProgress/the whole Tasks modal work unchanged on a cell —
    // this lazily upgrades an old single task into a one-item list the
    // first time the cell is touched, same spirit as the photo/note
    // migrations elsewhere in this file.
    if (a && a.task && a.task.text) {
      if (!Array.isArray(a.tasks)) a.tasks = [];
      a.tasks.push({ id: uid(), text: a.task.text, done: !!a.task.done, stars: 0, due: null });
    }
    if (a && a.task) a.task = null;
    return a;
  }
  function cellAttachHasAny(a) {
    return !!(a && (a.image || (a.images && a.images.length) || a.note || (a.notes && a.notes.length) || a.url || (a.urls && a.urls.length) || (a.tasks && a.tasks.length) || (a.affirmation && (a.affirmation.wins || a.affirmation.quote)) || a.timePlayedSec || (a.brainstorm && a.brainstorm.text)));
  }
  function cellAttachHasStripIcon(a) {
    // v410: tasks no longer render a second icon in the bottom strip.
    // Their top-right score badge IS the task marker.
    return !!(a && (
      a.image || (a.images && a.images.length) ||
      a.note || (a.notes && a.notes.length) ||
      a.url || (a.urls && a.urls.length) ||
      (a.affirmation && (a.affirmation.wins || a.affirmation.quote)) ||
      a.timePlayedSec ||
      (a.brainstorm && a.brainstorm.text)
    ));
  }

  // A handful of features (the affirmation typing game, the countdown
  // "time played" timer) originally only ever lived on a whole node —
  // every one of their functions takes a node and reads/writes a couple
  // of plain fields on it (node.affirmation, node.timePlayedSec). A table
  // cell's attachment record (see getCellAttach above) is just as plain
  // an object, so instead of duplicating all of that logic for cells,
  // every call site now goes through a "target" — {nodeId, r, c}, with r
  // and c omitted for the node-level case — and resolveHost() below
  // returns whichever plain object (the node itself, or one cell's
  // attach record) that target actually refers to. Everything downstream
  // (getNodeAffirmation, getNodeTimePlayed, the game, the timer) keeps
  // working completely unchanged on top of whatever object comes back.
  function resolveHost(nodeId, r, c) {
    const node = findNode(nodeId);
    if (!node) return null;
    if (r == null || c == null) return node;
    if (!node.table) return null;
    return getCellAttach(node, r, c);
  }
  // Compares two targets ({nodeId, r, c}) for equality — used wherever a
  // running timer/game needs to check "is this the same target I'm
  // already showing/tracking", since two plain objects with the same
  // shape are never === to each other.
  function sameTarget(t1, t2) {
    if (!t1 || !t2) return t1 === t2;
    return t1.nodeId === t2.nodeId && (t1.r ?? null) === (t2.r ?? null) && (t1.c ?? null) === (t2.c ?? null);
  }
  // Every photo id currently attached to any cell of this node's table —
  // used alongside getNodeImageIds() wherever a node's photos need to be
  // enumerated for garbage collection, export, or Drive/folder sync, so a
  // cell's photo is treated as "in use" exactly like a node's own.
  function getCellImageIds(node) {
    if (!node || !node.table || !Array.isArray(node.table.attach)) return [];
    const ids = [];
    node.table.attach.forEach(row => (row || []).forEach(a => ids.push(...getCellPhotoIds(a))));
    return ids;
  }

  // Nodes used to hold a single `image` data-URL; they now hold an `images`
  // array of photo *ids* (see PhotoDB above) so multiple photos can be
  // attached without embedding their bytes in the node tree. This reads
  // either legacy shape so maps saved before that change still display
  // (ensurePhotosMigrated is what actually converts them to ids, but
  // rendering shouldn't have to wait on that finishing).
  function getNodeImageIds(node) {
    if (!node) return [];
    if (Array.isArray(node.images) && node.images.length) return node.images;
    if (node.image) return [node.image];
    return [];
  }
  // Resolves those ids to actual data URLs for rendering (img src,
  // background-image, canvas drawing, etc.) — every existing call site
  // that just wants to *look at* a node's photos keeps working exactly
  // as before; only code that needs the photo's stable identity (tags,
  // delete, drag/copy) should use getNodeImageIds instead.
  function getNodeImages(node) {
    return getNodeImageIds(node).map(id => (typeof id === "string" && id.startsWith("data:")) ? id : photoUrl(id));
  }
  function nodeHasImages(node) {
    return getNodeImageIds(node).length > 0;
  }

  // Photo tags are keyed by the photo's own (stable) id rather than its
  // index in `images`, so a tag stays attached to the right photo even
  // as photos are added, deleted, reordered, or dragged onto another
  // node — no index bookkeeping required.
  function getPhotoTags(node, photoId) {
    if (!node || !node.photoTags || !photoId) return [];
    return Array.isArray(node.photoTags[photoId]) ? node.photoTags[photoId] : [];
  }
  function setPhotoTags(node, photoId, tags) {
    if (!node || !photoId) return;
    if (!node.photoTags) node.photoTags = {};
    if (tags && tags.length) node.photoTags[photoId] = tags;
    else delete node.photoTags[photoId];
  }
  function addPhotoTag(node, photoId, tag) {
    const clean = (tag || "").trim().replace(/\s+/g, " ").slice(0, 24);
    if (!clean) return false;
    const tags = getPhotoTags(node, photoId);
    if (tags.some(t => t.toLowerCase() === clean.toLowerCase())) return false;
    setPhotoTags(node, photoId, tags.concat([clean]));
    return true;
  }
  function removePhotoTag(node, photoId, tag) {
    setPhotoTags(node, photoId, getPhotoTags(node, photoId).filter(t => t !== tag));
  }
  // When a photo is moved/copied onto another node (see completeMarkerDrop),
  // carry its tags along so they don't silently disappear. `idPairs` is a
  // list of [sourceId, targetId] — the same id for a move, a fresh id for
  // a copy (see duplicatePhotoRecord).
  function carryPhotoTags(source, target, idPairs) {
    if (!source || !target || !source.photoTags) return;
    (idPairs || []).forEach(([fromId, toId]) => {
      const tags = source.photoTags[fromId];
      if (!tags || !tags.length) return;
      if (!target.photoTags) target.photoTags = {};
      const existing = target.photoTags[toId] || [];
      target.photoTags[toId] = existing.concat(tags.filter(t => !existing.includes(t)));
    });
  }

  // Photo notes are the same rich, multi-entry note editor used for a
  // node's own notes, just scoped to one photo instead — keyed by the
  // photo's own (stable) id, same reasoning as photoTags above, so a
  // photo's notes stay attached to it through adds/deletes/reorders/
  // drags/crops. Each entry is `{id, title, html}`, identical shape to
  // a node's own `notes` array (see getNodeNotes) — the note editor
  // itself doesn't need to know which kind of target it's editing.
  function getPhotoNotes(node, photoId) {
    if (!node || !node.photoNotes || !photoId) return [];
    return Array.isArray(node.photoNotes[photoId]) ? node.photoNotes[photoId] : [];
  }
  function setPhotoNotes(node, photoId, notes) {
    if (!node || !photoId) return;
    if (!node.photoNotes) node.photoNotes = {};
    if (notes && notes.length) node.photoNotes[photoId] = notes;
    else delete node.photoNotes[photoId];
  }
  function photoHasNotes(node, photoId) {
    return getPhotoNotes(node, photoId).length > 0;
  }
  // Same carry-along behavior as carryPhotoTags — a moved/copied/cropped
  // photo keeps its notes rather than silently losing them.
  function carryPhotoNotes(source, target, idPairs) {
    if (!source || !target || !source.photoNotes) return;
    (idPairs || []).forEach(([fromId, toId]) => {
      const notes = source.photoNotes[fromId];
      if (!notes || !notes.length) return;
      if (!target.photoNotes) target.photoNotes = {};
      const existing = target.photoNotes[toId] || [];
      target.photoNotes[toId] = existing.concat(notes);
    });
  }

  // A single freeform comment per photo — same auto-growing textarea UI
  // as the video modal's inline comment box below the player (see
  // videoModalCommentInput), just anchored under the photo viewer
  // instead. Keyed by the photo's own (stable) id, same reasoning as
  // photoTags/photoNotes above, so a comment stays attached to the right
  // photo through adds/deletes/reorders/drags/crops.
  function getPhotoComment(node, photoId) {
    return (node && node.photoComments && node.photoComments[photoId]) || "";
  }
  function setPhotoComment(node, photoId, comment) {
    if (!node || !photoId) return;
    if (!node.photoComments) node.photoComments = {};
    const clean = (comment || "").trim();
    if (clean) node.photoComments[photoId] = clean;
    else delete node.photoComments[photoId];
  }
  // Same carry-along behavior as carryPhotoTags/carryPhotoNotes — a moved/
  // copied/cropped photo keeps its comment rather than silently losing it.
  function carryPhotoComments(source, target, idPairs) {
    if (!source || !target || !source.photoComments) return;
    (idPairs || []).forEach(([fromId, toId]) => {
      const comment = source.photoComments[fromId];
      if (!comment) return;
      if (!target.photoComments) target.photoComments = {};
      if (!target.photoComments[toId]) target.photoComments[toId] = comment;
    });
  }

  // A photo can be starred as a favorite, same "keyed by the photo's own
  // stable id" pattern as photoTags/photoNotes/photoComments above, so the
  // star stays attached to the right photo through adds/deletes/reorders/
  // drags/crops. Powers both the star toggle in the photo viewer and the
  // "Favorites" sidebar browser (see collectFavoriteItems).
  function getPhotoFavorite(node, photoId) {
    return !!(node && node.photoFavorites && photoId && node.photoFavorites[photoId]);
  }
  function setPhotoFavorite(node, photoId, val) {
    if (!node || !photoId) return;
    if (!node.photoFavorites) node.photoFavorites = {};
    if (val) node.photoFavorites[photoId] = true;
    else delete node.photoFavorites[photoId];
  }
  function togglePhotoFavorite(node, photoId) {
    setPhotoFavorite(node, photoId, !getPhotoFavorite(node, photoId));
    return getPhotoFavorite(node, photoId);
  }
  // Same carry-along behavior as carryPhotoTags/carryPhotoNotes/
  // carryPhotoComments — a moved/copied/cropped photo keeps its favorite
  // star rather than silently losing it.
  function carryPhotoFavorites(source, target, idPairs) {
    if (!source || !target || !source.photoFavorites) return;
    (idPairs || []).forEach(([fromId, toId]) => {
      if (!source.photoFavorites[fromId]) return;
      if (!target.photoFavorites) target.photoFavorites = {};
      target.photoFavorites[toId] = true;
    });
  }

  // When a photo was actually attached — keyed by the photo's own stable
  // id, same pattern as photoTags/photoNotes/photoComments/photoFavorites
  // above. Powers the "Photos" sidebar browser's Date sort (see
  // collectAllPhotos). Photos attached before this field existed have no
  // entry here; collectAllPhotos backfills one lazily (stamps it with
  // "now" the first time that photo is listed) rather than leaving it
  // permanently dateless — same lazy-backfill idea as a note's createdAt
  // (see captureActiveNote).
  function getPhotoTimestamp(node, photoId) {
    return (node && node.photoTimestamps && photoId && node.photoTimestamps[photoId]) || 0;
  }
  function setPhotoTimestamp(node, photoId, ts) {
    if (!node || !photoId) return;
    if (!node.photoTimestamps) node.photoTimestamps = {};
    if (ts) node.photoTimestamps[photoId] = ts;
    else delete node.photoTimestamps[photoId];
  }
  // Same carry-along behavior as carryPhotoFavorites — a moved/copied/
  // cropped photo keeps its "date added" rather than silently losing it
  // (and, for a move, looking freshly backfilled on the target node).
  function carryPhotoTimestamps(source, target, idPairs) {
    if (!source || !target || !source.photoTimestamps) return;
    (idPairs || []).forEach(([fromId, toId]) => {
      const ts = source.photoTimestamps[fromId];
      if (!ts) return;
      if (!target.photoTimestamps) target.photoTimestamps = {};
      target.photoTimestamps[toId] = ts;
    });
  }

  // On-canvas photo markers are tiny (9–18px), but a full photo is stored
  // at its original resolution (no downscaling) so the lightbox still
  // looks sharp — full quality, exactly as attached. Painting that
  // full-resolution bitmap as the background-image of a dozen little
  // thumbnails is what actually made the canvas heavy to composite once
  // a few photo-heavy nodes were on screen — every pan/drag frame has to
  // recomposite all of that
  // decoded pixel data even though only a handful of on-screen pixels are
  // ever visible. This cache holds a small, pre-cropped stand-in (keyed by
  // the full photo's own data URL, so it's computed once per photo and
  // reused everywhere that photo appears) built once and reused instead.
  // Sized for the worst case on-screen footprint of a "large" thumbnail
  // (18 CSS px) at max zoom (2.5x, see the zoom handlers) on a high-DPI
  // screen, with a little headroom — not a fixed guess — so photos stay
  // sharp all the way to full zoom instead of turning soft once the small
  // stand-in gets stretched past its own resolution.
  const THUMB_DISPLAY_PX = Math.round(clamp(18 * 2.5 * (window.devicePixelRatio || 1) * 1.15, 96, 240));
  // Bounded LRU: keyed by the *full* base64 photo data URL, so left
  // unbounded this grows forever across a session (every photo ever
  // viewed, in every map, stays resident — full-size base64 keys and
  // all) and was a real path to an "Out of memory" tab crash on long
  // sessions with lots of photos. Capped here so old entries get
  // evicted once the cache fills up instead of accumulating forever.
  const NODE_THUMB_CACHE_MAX = 300;
  const nodeThumbCache = new Map(); // full data URL -> small data URL
  const nodeThumbPending = new Set(); // full data URLs queued or in flight
  // A cold render of a photo-heavy map (thumbnail cache empty) used to call
  // getMarkerThumb for every node's photos in one synchronous pass, which
  // fired off a full-resolution decode for each one at the same time —
  // dozens/hundreds of concurrent decodes, each holding tens of MB of raw
  // pixel data, was a real "Out of memory" tab-crash path even though the
  // *cached* thumbnails themselves are tiny. Capped here so only a handful
  // of photos are ever being decoded at once; the rest wait in line and
  // pick up the (still-correct) full-res fallback image until their turn.
  const NODE_THUMB_MAX_CONCURRENT = 4;
  let nodeThumbActive = 0;
  const nodeThumbQueue = [];
  function runNextThumbJob() {
    if (nodeThumbActive >= NODE_THUMB_MAX_CONCURRENT) return;
    const job = nodeThumbQueue.shift();
    if (!job) return;
    nodeThumbActive++;
    const { fullDataUrl, onReady } = job;
    const finish = () => {
      nodeThumbActive--;
      nodeThumbPending.delete(fullDataUrl);
      runNextThumbJob();
    };
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.width, img.height) || 1;
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_DISPLAY_PX;
        canvas.height = THUMB_DISPLAY_PX;
        canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, THUMB_DISPLAY_PX, THUMB_DISPLAY_PX);
        if (nodeThumbCache.size >= NODE_THUMB_CACHE_MAX) {
          const oldestKey = nodeThumbCache.keys().next().value;
          nodeThumbCache.delete(oldestKey);
        }
        nodeThumbCache.set(fullDataUrl, canvas.toDataURL("image/jpeg", 0.7));
        onReady();
      } finally {
        // Drop the full-res <img> reference immediately so it (and its
        // decoded bitmap) is eligible for GC right away rather than
        // lingering until this closure itself is collected.
        img.onload = img.onerror = null;
        finish();
      }
    };
    img.onerror = () => { finish(); };
    img.src = fullDataUrl;
  }
  function getMarkerThumb(fullDataUrl, onReady) {
    const cached = nodeThumbCache.get(fullDataUrl);
    if (cached) {
      // Refresh recency: delete + re-set moves this key to the end of
      // the Map's iteration order, which is what makes "delete the
      // first key" below an actual least-recently-used eviction.
      nodeThumbCache.delete(fullDataUrl);
      nodeThumbCache.set(fullDataUrl, cached);
      return cached;
    }
    if (!nodeThumbPending.has(fullDataUrl)) {
      nodeThumbPending.add(fullDataUrl);
      nodeThumbQueue.push({ fullDataUrl, onReady });
      runNextThumbJob();
    }
    return null;
  }

  // Nodes used to hold a single freeform `note` string; they now hold a
  // `notes` array (each `{id, html}`) so more than one note can be
  // attached. This reads either shape so maps saved before the change
  // still work without a migration step.
  function getNodeNotes(node) {
    if (!node) return [];
    if (Array.isArray(node.notes) && node.notes.length) return node.notes;
    if (node.note && node.note.trim()) return [{ id: uid(), title: "", html: node.note }];
    return [];
  }
  function nodeHasNotes(node) {
    return getNodeNotes(node).length > 0;
  }

  // A task's notes use the exact same rich, multi-entry note editor as a
  // node's own notes (see getNodeNotes above and openNoteModal below) —
  // title, rich text, multiple notes with paging, all of it — just scoped
  // to one task instead of the whole node. Reads either the old single
  // plain/HTML `note` string (from before this existed) or the new
  // `notes` array, same fallback shape as getNodeNotes.
  function getTaskNotes(t) {
    if (!t) return [];
    if (Array.isArray(t.notes) && t.notes.length) return t.notes;
    if (t.note && t.note.trim()) return [{ id: uid(), title: "", html: t.note }];
    return [];
  }
  function taskHasNotes(t) {
    return getTaskNotes(t).length > 0;
  }

  // A subtask's own Note title is not independent metadata: it always
  // mirrors the current subtask name. Keep every existing note entry in
  // sync so renaming a subtask also renames its note immediately.
  function syncSubtaskNoteTitles(s) {
    if (!s) return;
    const title = (s.text || "").trim();
    if (Array.isArray(s.notes)) {
      s.notes.forEach((n) => { if (n) n.title = title; });
    }
  }

  // A table cell's note uses the exact same rich, multi-entry note editor
  // as a node's own notes (see getNodeNotes/openNoteModal) — title, rich
  // text, multiple notes with paging, all of it — just scoped to one
  // cell's attach record instead of the whole node. Reads either the old
  // single plain-text `note` string (from before this existed) or the
  // new `notes` array, same fallback shape as getNodeNotes/getTaskNotes.
  function getCellNotes(a) {
    if (!a) return [];
    if (Array.isArray(a.notes) && a.notes.length) return a.notes;
    if (a.note && a.note.trim()) return [{ id: uid(), title: "", html: a.note }];
    return [];
  }
  function cellHasNotes(a) {
    return getCellNotes(a).length > 0;
  }

  // A table cell's photos use the exact same multi-photo model as a
  // node's own photos (see getNodeImageIds/getNodeImages above) — an
  // array of PhotoDB ids — just scoped to one cell's attach record
  // instead of the whole node. Reads either the old single plain `image`
  // id (from before this existed) or the new `images` array, same
  // fallback shape as getNodeImageIds.
  function getCellPhotoIds(a) {
    if (!a) return [];
    if (Array.isArray(a.images) && a.images.length) return a.images;
    if (a.image) return [a.image];
    return [];
  }
  function getCellPhotos(a) {
    return getCellPhotoIds(a).map(id => (typeof id === "string" && id.startsWith("data:")) ? id : photoUrl(id));
  }
  function cellHasImages(a) {
    return getCellPhotoIds(a).length > 0;
  }

  // Short label for a note, for the menus below — its title if it has
  // one, otherwise a plain-text preview of the body.
  function notePreviewText(n) {
    const title = (n.title || "").trim();
    if (title) return title.length > 40 ? title.slice(0, 39) + "…" : title;
    const tmp = document.createElement("div");
    tmp.innerHTML = n.html || "";
    const text = (tmp.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return "(empty note)";
    return text.length > 40 ? text.slice(0, 39) + "…" : text;
  }

  // Right-click on a note marker — same shape as openUrlManageMenu: each
  // row opens that note in the editor, plus a ✕ to delete it on the spot
  // without opening the editor. A "+" button up in the header gives a
  // fast one-click way to start a brand-new note, without having to
  // scan down past however many notes are already listed below it.
  function openNoteManageMenu(nodeId, x, y) {
    const node = findNode(nodeId);
    if (!node) return;
    const notes = getNodeNotes(node);
    if (!notes.length) return;
    resetContextMenu();

    const header = document.createElement("div");
    header.className = "ctx-item ctx-item-header";
    header.style.cursor = "default";
    const headerLabel = document.createElement("span");
    headerLabel.className = "ctx-item-label";
    headerLabel.textContent = `Notes (${notes.length})`;
    header.appendChild(headerLabel);
    const addBtn = document.createElement("span");
    addBtn.className = "ctx-item-add";
    addBtn.textContent = "+";
    addBtn.title = "Add a new note";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      openNoteModal(nodeId, notes.length);
    });
    header.appendChild(addBtn);
    ctxMenu.appendChild(header);

    notes.forEach((n, i) => {
      const it = document.createElement("div");
      it.className = "ctx-item";
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      if (isBrainstormNote(n)) {
        labelSpan.textContent = "🧠 " + notePreviewText(n);
      } else if (isDRCNote(n)) {
        // DRC notes get the same notebook+pencil image as everywhere else.
        labelSpan.textContent = notePreviewText(n);
        labelSpan.prepend(drcIconEl(16));
      } else if (isPlanNote(n)) {
        labelSpan.textContent = notePreviewText(n);
        labelSpan.prepend(planIconEl(16));
      } else {
        labelSpan.textContent = "📝 " + notePreviewText(n);
      }
      labelSpan.addEventListener("click", () => { closeContextMenu(); openNoteModal(nodeId, i); });
      it.appendChild(labelSpan);
      const removeBtn = document.createElement("span");
      removeBtn.className = "ctx-item-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "Delete this note";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        const remaining = getNodeNotes(node).slice();
        remaining.splice(i, 1);
        node.notes = remaining;
        node.note = "";
        closeContextMenu();
        renderAll();
        persist();
      });
      it.appendChild(removeBtn);
      ctxMenu.appendChild(it);
    });
    positionContextMenu(x, y);
  }

  // Nodes used to hold a single `url` string; they now hold a `urls` array
  // so multiple links can be attached. This reads either shape so maps
  // saved before the change still work without a migration step.
  function getNodeUrls(node) {
    if (!node) return [];
    if (Array.isArray(node.urls) && node.urls.length) return node.urls;
    if (node.url) return [node.url];
    return [];
  }
  function nodeHasUrls(node) {
    return getNodeUrls(node).length > 0;
  }

  // A link's display title is kept separate from the URL itself — stored
  // on the node as { [url]: title }, content-addressed the same way photo
  // tags used to be (a URL, unlike a photo's bytes, IS a stable identity
  // on its own, so there's no need for the id-store treatment photos got —
  // see getNodeImageIds/PhotoDB above). Populated either by fetchLinkTitle
  // (best-effort, see below) or by hand via "Rename link…".
  function getLinkTitle(node, url) {
    return (node && node.linkTitles && node.linkTitles[url]) || "";
  }
  // A short freeform note about one specific link, independent of its
  // title — stored the same way as linkTitles (an { [url]: text } map on
  // the node), and surfaced as a tooltip when hovering the link's icon
  // (see attachLinkCommentTooltip) rather than inside any menu text.
  function getLinkComment(node, url) {
    return (node && node.linkComments && node.linkComments[url]) || "";
  }
  function setLinkComment(node, url, comment) {
    if (!node || !url) return;
    if (!node.linkComments) node.linkComments = {};
    const clean = (comment || "").trim();
    if (clean) node.linkComments[url] = clean;
    else delete node.linkComments[url];
  }
  function setLinkTitle(node, url, title) {
    if (!node || !url) return;
    if (!node.linkTitles) node.linkTitles = {};
    const clean = (title || "").trim();
    if (clean) node.linkTitles[url] = clean;
    else delete node.linkTitles[url];
  }
  // Photo(s) attached to a link's comment — e.g. a screenshot pasted into
  // the YouTube player's comment box. Stored as an ordered list of
  // PhotoDB ids, same { [url]: ... } map shape as linkComments/
  // linkFavorites above, so a link can carry several photos alongside
  // its text comment.
  function getLinkPhotos(node, url) {
    return (node && node.linkPhotos && node.linkPhotos[url]) || [];
  }
  function addLinkPhoto(node, url, dataUrl) {
    if (!node || !url) return null;
    const id = addPhotoRecord(dataUrl, { avoid: getLinkPhotos(node, url) });
    if (!node.linkPhotos) node.linkPhotos = {};
    if (!node.linkPhotos[url]) node.linkPhotos[url] = [];
    node.linkPhotos[url].push(id);
    return id;
  }
  function removeLinkPhoto(node, url, photoId) {
    if (!node || !node.linkPhotos || !node.linkPhotos[url]) return;
    node.linkPhotos[url] = node.linkPhotos[url].filter((id) => id !== photoId);
    if (!node.linkPhotos[url].length) delete node.linkPhotos[url];
    deletePhotoRecord(photoId);
  }
  // A link (or, since a YouTube URL is just a link that opens in the video
  // player, a video too) can be starred as a favorite — same { [url]: true }
  // map on the node as linkTitles/linkComments. Powers the star toggle in
  // the link comment modal and the video modal, and the "Favorites"
  // sidebar browser (see collectFavoriteItems).
  function getLinkFavorite(node, url) {
    return !!(node && node.linkFavorites && url && node.linkFavorites[url]);
  }
  function setLinkFavorite(node, url, val) {
    if (!node || !url) return;
    if (!node.linkFavorites) node.linkFavorites = {};
    if (val) node.linkFavorites[url] = true;
    else delete node.linkFavorites[url];
  }
  function toggleLinkFavorite(node, url) {
    setLinkFavorite(node, url, !getLinkFavorite(node, url));
    return getLinkFavorite(node, url);
  }
  // Carries link titles along when links are dragged onto another node
  // (see completeMarkerDrop's "urls" branch) — same idea as carryPhotoTags.
  function carryLinkTitles(source, target, urls) {
    if (!source || !target || !source.linkTitles) return;
    urls.forEach((u) => {
      const title = source.linkTitles[u];
      if (!title) return;
      if (!target.linkTitles) target.linkTitles = {};
      if (!target.linkTitles[u]) target.linkTitles[u] = title;
    });
  }

  // When a URL was actually added to a node — same { [url]: ts } map shape
  // as linkTitles/linkFavorites above. Powers the "Videos" sidebar
  // browser's Date sort (see collectAllVideos). Links added before this
  // field existed have no entry here; collectAllVideos backfills one
  // lazily the first time that link is listed, same idea as
  // getPhotoTimestamp above / a note's createdAt (see captureActiveNote).
  function getLinkTimestamp(node, url) {
    return (node && node.linkTimestamps && url && node.linkTimestamps[url]) || 0;
  }
  function setLinkTimestamp(node, url, ts) {
    if (!node || !url) return;
    if (!node.linkTimestamps) node.linkTimestamps = {};
    if (ts) node.linkTimestamps[url] = ts;
    else delete node.linkTimestamps[url];
  }
  // Same carry-along behavior as carryLinkTitles — a moved/copied link
  // keeps its "date added" instead of looking freshly backfilled on the
  // target node.
  function carryLinkTimestamps(source, target, urls) {
    if (!source || !target || !source.linkTimestamps) return;
    urls.forEach((u) => {
      const ts = source.linkTimestamps[u];
      if (!ts) return;
      if (!target.linkTimestamps) target.linkTimestamps = {};
      if (!target.linkTimestamps[u]) target.linkTimestamps[u] = ts;
    });
  }
  // Best-effort: tries to get the target page's actual title so the link
  // list can show a real name instead of the raw URL.
  //
  // For most ordinary websites this quietly does nothing: it only works
  // when the target server's CORS policy allows a cross-origin fetch of
  // the page (most sites don't set that header), and it's even less
  // likely to succeed at all when this app is opened as a local file
  // rather than served over http/https — which is exactly why
  // "Rename link…" exists as the reliable fallback.
  //
  // YouTube was assumed to be a reliable exception via its public "oEmbed"
  // endpoint (meant for other pages to read a video's title without
  // scraping/signing in) — but in practice YouTube's oEmbed response does
  // NOT include an Access-Control-Allow-Origin header, so the browser
  // blocks a direct fetch() to it with a CORS error, same as almost every
  // other site. This code path is kept in case a CORS-friendly proxy is
  // added later, but today it never actually succeeds — "Rename link…" is
  // the only reliable way to set a name for any link, YouTube included.
  function youtubeVideoId(u) {
    try {
      const p = new URL(u);
      const host = p.hostname.toLowerCase().replace(/^www\.|^m\./, "");
      if (host === "youtu.be") return p.pathname.slice(1) || null;
      if (host === "youtube.com") {
        if (p.pathname === "/watch") return p.searchParams.get("v");
        const m = p.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/);
        if (m) return m[2];
      }
    } catch (e) { /* not a parseable URL */ }
    return null;
  }

  // NOTE: YouTube's oEmbed endpoint does NOT send an Access-Control-Allow-Origin
  // header, so a direct browser fetch() to it is CORS-blocked in every browser,
  // every time — it is not actually more reliable than any other site. This
  // used to be assumed to work and silently never did; kept here only so a
  // future CORS proxy can be swapped in, but for now this always falls
  // through to the catch block below and the raw URL/manual rename is used.
  async function fetchLinkTitle(node, url) {
    let title = null;
    const ytId = youtubeVideoId(url);
    try {
      if (ytId) {
        const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (res.ok) title = (await res.json()).title;
      } else {
        const res = await fetch(url, { mode: "cors" });
        if (res.ok) title = new DOMParser().parseFromString(await res.text(), "text/html").title;
      }
    } catch (e) {
      // CORS-blocked, offline, or unreachable — leave the URL as the label.
      // Logged (not surfaced to the user) so this failure is at least
      // visible in devtools instead of vanishing silently.
      console.warn("Branchline: couldn't auto-fetch link title for", url, e);
    }
    title = (title || "").trim();
    // Re-fetch the live node/url by identity — several seconds may have
    // passed, during which the node could have been deleted or this
    // exact URL removed/edited away, or the person could have already
    // set their own title manually (which should win over an auto one).
    const liveNode = findNode(node.id);
    if (!title || !liveNode || !getNodeUrls(liveNode).includes(url) || getLinkTitle(liveNode, url)) return;
    setLinkTitle(liveNode, url, title.slice(0, 80));
    renderAll();
    persist();
  }

  // Per-node checklist ("today's tasks"). Stored as node.tasks = [{id,
  // text, done}], separate from the freeform note so progress can be
  // computed and shown right on the node in the mindmap.
  function getNodeTasks(node) {
    if (!(node && Array.isArray(node.tasks))) return [];
    if (!node.starsReset) {
      // One-time reset for lists saved under the old 3-star / 3x rules:
      // every existing star is removed (even a lone one), then the list is
      // marked so stars the user adds from now on are kept. Same
      // lazy-upgrade idea as getCellAttach below, so it covers maps loaded
      // from anywhere (this browser, Drive, an import), and it's saved
      // along with the next normal save.
      node.tasks.forEach((t) => {
        if (t && getTaskStars(t) > 0) { t.stars = 0; t.starred = false; }
      });
      node.starsReset = true;
    } else {
      enforceSingleStar(node.tasks);
    }
    return node.tasks;
  }
  // Safety net: only one starred task is allowed per list (see
  // MAX_STARRED_TASKS). If a list somehow ends up with more than one (e.g. a
  // copy synced from a device on an older version), all its stars are removed.
  function enforceSingleStar(tasks) {
    let starred = 0;
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i] && getTaskStars(tasks[i]) > 0) starred++;
    }
    if (starred <= MAX_STARRED_TASKS) return;
    tasks.forEach((t) => {
      if (t && getTaskStars(t) > 0) { t.stars = 0; t.starred = false; }
    });
  }
  function nodeHasTasks(node) {
    return getNodeTasks(node).length > 0;
  }
  // Tasks carry a 0–1 "stars" priority flag, used only for progress
  // weighting (see nodeTaskProgress) — it does not affect task order.
  // Also tolerates old maps saved before this existed, which only ever
  // had a boolean `starred` flag, treated as 1 star. Old maps saved
  // while 2/3-star levels existed are clamped down to 1.
  function getTaskStars(t) {
    if (typeof t.stars === "number" && !Number.isNaN(t.stars)) return clamp(Math.round(t.stars), 0, 1);
    return t.starred ? 1 : 0;
  }
  // Only 1 task per task list (node or table cell) can be starred at
  // once — starring another is blocked until the current one is unstarred.
  // Lists saved before this limit have all their stars removed once (see
  // getNodeTasks / enforceSingleStar).
  const MAX_STARRED_TASKS = 1;
  // v574: starred/priority tasks can contain up to ten subtasks.
  const MAX_STARRED_TASK_SUBTASKS = 10;
  function starredTaskSubtaskCapReached(t, incoming = 1) {
    return getTaskStars(t) > 0 && getTaskSubtasks(t).length + incoming > MAX_STARRED_TASK_SUBTASKS;
  }
  function blockStarredTaskSubtaskOverflow(t, incoming = 1) {
    if (!starredTaskSubtaskCapReached(t, incoming)) return false;
    showToast("Starred tasks can have maximum 10 subtasks");
    return true;
  }
  function blockStarIfTooManySubtasks(t) {
    if (getTaskSubtasks(t).length <= MAX_STARRED_TASK_SUBTASKS) return false;
    showToast("A task with more than 10 subtasks cannot be starred");
    return true;
  }
  // How many times more a starred task counts toward progress.
  const STARRED_TASK_WEIGHT = 10;
  function taskStarCapReached(host) {
    return getNodeTasks(host).filter(x => getTaskStars(x) > 0).length >= MAX_STARRED_TASKS;
  }
  function blockedByStarCap(host, t) {
    if (getTaskStars(t) > 0 || !taskStarCapReached(host)) return false;
    showToast("Only 1 starred task allowed — unstar the other one first");
    return true;
  }
  // A task's optional color label — one swatch from the same shared
  // PALETTE used for node/branch/font colors, shown as a light tinted
  // fill on the whole task row. Purely a visual tag: doesn't affect
  // progress, sorting, or the star-priority system above. Absent (no
  // `color` field) means "no color".
  function getTaskColor(t) {
    return (t && t.color) || null;
  }
  function setTaskColor(t, color) {
    if (!t) return;
    if (color) t.color = color;
    else delete t.color;
  }
  // Converts a task's color (a "#rrggbb" PALETTE swatch) into a low-alpha
  // rgba() fill so it reads as a light tint behind the row's text/icons
  // rather than a solid block. Returns null for no color.
  function taskColorTint(color) {
    if (!color || color[0] !== "#" || color.length !== 7) return null;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return `rgba(${r}, ${g}, ${b}, 0.16)`;
  }
  // Font color for a task and its subtasks — always a stable per-task
  // hash pick from the shared PALETTE, independent of the task's color
  // label (getTaskColor)/background tint (taskColorTint). Two tasks that
  // share the same color-label background fill still get different font
  // colors this way, since the hash is keyed on the task's own id rather
  // than on the shared label. Tasks with no id (shouldn't normally
  // happen) fall back to the first palette entry.
  function taskAutoColor(t) {
    if (!t || !t.id) return PALETTE[0];
    const id = String(t.id);
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }
  // Global on/off switch for task font color: "dynamic" keeps the
  // per-task hash color from taskAutoColor above; "black" flattens every
  // task/subtask's font to plain black instead. Remembered across
  // reloads via localStorage, same pattern as SIDEBAR_HIDDEN_KEY.
  const TASK_FONT_BLACK_KEY = "branchline_task_font_black";
  // Saved task-list templates (see the "📋 Templates" toolbar button in
  // the tasks modal) — a node's *entire* task list (every task's text,
  // color, and subtask text) can be saved here once, under a name, then
  // dropped onto any other node as a fresh set of tasks. Shared across
  // every map/node (not per-map data), same as the quote banner lines
  // below, since a template like "Morning routine" is just as useful on
  // a different node or a different map.
  const TASK_TEMPLATES_KEY = "branchlineTaskListTemplates_v1";
  let taskFontBlackMode = false;
  try { taskFontBlackMode = localStorage.getItem(TASK_FONT_BLACK_KEY) === "1"; } catch (e) {}
  function setTaskFontBlackMode(on) {
    taskFontBlackMode = !!on;
    try { localStorage.setItem(TASK_FONT_BLACK_KEY, taskFontBlackMode ? "1" : "0"); } catch (e) {}
  }
  // Use this instead of calling taskAutoColor(t) directly anywhere a
  // task/subtask's font color is applied, so the black-mode override
  // above takes effect everywhere at once.
  function taskFontColor(t) {
    return taskFontBlackMode ? "#000000" : taskAutoColor(t);
  }
  // Shared ordering for the "★ Sort" actions (Tasks modal + day popup):
  // starred tasks first, then grouped by color label (in PALETTE order,
  // so the grouping is stable and matches the order swatches are offered
  // in), with uncolored tasks last within each star group.
  function taskColorSortIndex(t) {
    const color = getTaskColor(t);
    const idx = color ? PALETTE.indexOf(color) : -1;
    return idx === -1 ? PALETTE.length : idx;
  }
  function compareTasksByStarAndColor(a, b) {
    return (getTaskStars(b) - getTaskStars(a)) || (taskColorSortIndex(a) - taskColorSortIndex(b));
  }
  function nodeTaskProgress(node) {
    const tasks = getNodeTasks(node);
    // Progress is subtask-based: a task with subtasks contributes their
    // done/total counts. A task with none of its own counts as a single
    // unit instead (done via its own checkbox), so plain tasks still
    // move the needle. A starred task counts 10x toward the weight, so
    // marking (or completing subtasks of) a starred task moves the
    // node's ring/bar further.
    let total = 0, done = 0, failed = 0;
    tasks.forEach((t) => {
      const stars = getTaskStars(t);
      const weight = stars > 0 ? STARRED_TASK_WEIGHT : 1;
      const subs = getTaskSubtasks(t);
      if (subs.length) {
        total += subs.length * weight;
        done += subs.filter(s => s.done).length * weight;
        failed += subs.filter(s => s.failed && !s.done).length * weight;
      } else {
        total += weight;
        if (t.done) done += weight;
        else if (t.failed) failed += weight;
      }
    });
    // Each completed round of the affirmation typing game (node.affirmation.wins
    // — see below) is worth a flat 3 points toward the same done/total tally,
    // always fully "done" since a win is a win: 1 round = 3, 2 rounds = 6, etc.
    const wins = (node && node.affirmation && node.affirmation.wins) || 0;
    if (wins > 0) {
      const affirmationPoints = wins * 3;
      total += affirmationPoints;
      done += affirmationPoints;
    }
    // Every full minute actually logged on the node's countdown timer
    // (node.timePlayedSec — see getNodeTimePlayed) is worth 3 more points,
    // same "always fully done" treatment: 1m = 3, 2m = 6, etc. Partial
    // seconds under a full minute don't count yet.
    const timedMinutes = Math.floor(getNodeTimePlayed(node) / 60);
    if (timedMinutes > 0) {
      const timerPoints = timedMinutes * 3;
      total += timerPoints;
      done += timerPoints;
    }
    // Each link that's been given a comment (node.linkComments — see
    // getLinkComment/setLinkComment) is worth another flat 3 points, same
    // "always fully done" treatment as the above: one commented link = 3,
    // two commented links = 6, etc. A link with no comment set contributes
    // nothing here (it's already covered by whatever it's otherwise worth).
    const commentedLinks = getNodeUrls(node).filter(u => getLinkComment(node, u)).length;
    if (commentedLinks > 0) {
      const commentPoints = commentedLinks * 3;
      total += commentPoints;
      done += commentPoints;
    }
    // v360: Brainstorm is a Note variant only; it does not add task-progress points.
    // DRC notes no longer add points to the task tally (used to add a
    // flat 5 per filled-in DRC note via drcPoints — see drcPoints/
    // drcNoteIsFilled, still used elsewhere for the icon/tooltip status,
    // just not counted toward done/total here anymore).
    return { done, total, failed, pct: total ? done / total : 0 };
  }

  // Subtasks — a small checklist living on a single task, stored as
  // t.subtasks = [{id, text, done}]. Checking every subtask marks the
  // parent task done automatically, and toggling the parent's own
  // checkbox cascades to all of its subtasks — the same way nested
  // checklists behave in most task apps.
  function getTaskSubtasks(t) {
    return (t && Array.isArray(t.subtasks)) ? t.subtasks : [];
  }
  function taskSubtaskProgress(t) {
    const subs = getTaskSubtasks(t);
    const total = subs.length;
    const done = subs.filter(s => s.done).length;
    return { done, total, pct: total ? done / total : 0 };
  }

  // How "done" a single task is, as a 0–1 fraction: a task with subtasks
  // is as done as its subtasks are (partial credit counts), otherwise
  // it's a flat 1 or 0 from its own checkbox.
  function taskEffectiveDoneFraction(t) {
    const subs = getTaskSubtasks(t);
    if (subs.length) return subs.filter(s => s.done).length / subs.length;
    return t.done ? 1 : 0;
  }
  // Recomputes a task's own `done` from its subtasks (all done => task
  // done). No-op for tasks without any subtasks yet.
  function syncTaskDoneFromSubtasks(t) {
    const subs = getTaskSubtasks(t);
    if (subs.length) {
      t.done = subs.every(s => s.done);
      // Mirror image: a task is failed once EVERY subtask is failed.
      t.failed = subs.every(s => s.failed);
    }
  }

  // "Failed" — the opposite of done. A task/subtask is done, failed, or
  // neither, never both: marking one clears the other. It counts toward
  // the progress total like any unfinished item (it isn't "done") but is
  // shown separately, and a failed task is never flagged overdue.
  // Stored as `failed: true` on the task/subtask object, so it rides
  // along with the map through IndexedDB, Drive and Export like `done`.
  function setTaskDone(t, on) {
    t.done = !!on;
    if (t.done) t.failed = false;
    getTaskSubtasks(t).forEach(s => { s.done = t.done; if (t.done) s.failed = false; });
  }
  function setTaskFailed(t, on) {
    t.failed = !!on;
    if (t.failed) t.done = false;
    // Cascades to every subtask, same as the done checkbox does.
    getTaskSubtasks(t).forEach(s => { s.failed = t.failed; if (t.failed) s.done = false; });
  }
  function setSubtaskDone(t, s, on) {
    s.done = !!on;
    if (s.done) s.failed = false;
    syncTaskDoneFromSubtasks(t);
  }
  function setSubtaskFailed(t, s, on) {
    s.failed = !!on;
    if (s.failed) s.done = false;
    syncTaskDoneFromSubtasks(t);
  }
  // The little ✗ button on task rows. (Subtask pills don't have one — they
  // are marked failed from their right-click menu only.)
  function makeTaskFailButton(failed, onToggle, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = (cls || "task-fail-btn") + (failed ? " failed" : "");
    b.textContent = "\u2717";
    b.title = failed ? "Marked as failed \u2014 click to clear" : "Mark as failed";
    b.setAttribute("aria-label", failed ? "Clear failed mark" : "Mark as failed");
    b.setAttribute("aria-pressed", failed ? "true" : "false");
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); onToggle(); });
    return b;
  }

  // Task-list templates — a whole node's task list, saved as one named
  // template (each task's text, color, priority star and subtask text plus
  // the line breaks between subtask pills — not done state, ids, due dates
  // or notes: a template is a reusable shape, not a snapshot of one specific
  // in-progress list) from the tasks modal's
  // "📋 Templates" button, then insertable onto any other node's task
  // list from that same button. Stored the same way as the quote banner
  // lines (a flat JSON array under one localStorage key), shared across
  // every map since a template is just as useful on a different node or
  // map as the one it came from.
  function getTaskListTemplates() {
    try {
      const saved = JSON.parse(localStorage.getItem(TASK_TEMPLATES_KEY));
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return [];
  }
  function saveTaskListTemplates(list) {
    try { localStorage.setItem(TASK_TEMPLATES_KEY, JSON.stringify(list)); } catch (e) {}
  }
  // v506: resolve a task-list template by name case-insensitively. If the
  // same name exists more than once, use the most recently updated copy.
  function findTaskListTemplateByName(name) {
    const want = (name || "").trim().toLowerCase();
    let best = null;
    getTaskListTemplates().forEach((tpl) => {
      if (!tpl || (tpl.name || "").trim().toLowerCase() !== want) return;
      if (!Array.isArray(tpl.tasks) || !tpl.tasks.length) return;
      if (!best || (tpl.updatedAt || 0) > (best.updatedAt || 0)) best = tpl;
    });
    return best;
  }
  // The reusable "shape" of `host`'s current task list — same array
  // saveTaskListAsTemplate/updateTaskListTemplate both store, factored
  // out so a fresh save and an overwrite of an existing template snapshot
  // the list identically.
  function snapshotTasksForTemplate(host) {
    return getNodeTasks(host).map(t => ({
      text: (t.text || "").trim() || "Untitled task",
      color: getTaskColor(t) || null,
      // Preserve the task's reusable priority marker. Done/failed/due remain
      // progress-specific and intentionally do not belong to a template.
      stars: getTaskStars(t) > 0 ? 1 : 0,
      // brBefore = the line breaks entered *between* subtask pills (see
      // enhanceSubtaskList), remembered so a template restores the same
      // pill layout. Only stored when non-zero.
      subtasks: getTaskSubtasks(t).map(s => {
        const o = { text: s.text || "" };
        const br = Math.max(0, Math.min(5, s.brBefore | 0));
        if (br) o.brBefore = br;
        return o;
      }).filter(s => s.text.trim())
    }));
  }
  // Saves a copy of every task on `host` as a new named template. Returns
  // the saved template, or null if the list was empty (nothing to save).
  function saveTaskListAsTemplate(host, name) {
    const tasks = snapshotTasksForTemplate(host);
    if (!tasks.length) return null;
    const tpl = { id: uid(), name: (name || "").trim() || "Untitled template", tasks, updatedAt: Date.now() };
    const list = getTaskListTemplates();
    list.push(tpl);
    saveTaskListTemplates(list);
    scheduleTaskTemplateSync();
    return tpl;
  }
  // Overwrites an existing template's task snapshot in place (same id and
  // name) with `host`'s current task list — used by the 🔁 button on a
  // saved template row, so updating a template doesn't leave a stray
  // duplicate behind. Returns true if a matching template was found.
  function updateTaskListTemplate(id, host) {
    const tasks = snapshotTasksForTemplate(host);
    if (!tasks.length) return false;
    const list = getTaskListTemplates();
    const tpl = list.find(t => t.id === id);
    if (!tpl) return false;
    tpl.tasks = tasks;
    tpl.updatedAt = Date.now();
    saveTaskListTemplates(list);
    scheduleTaskTemplateSync();
    return true;
  }
  function deleteTaskListTemplate(id) {
    saveTaskListTemplates(getTaskListTemplates().filter(tpl => tpl.id !== id));
    // Remember the deletion (a "tombstone") so the other device's copy
    // doesn't just bring the template back on the next sync.
    const gone = getDeletedTaskTemplates();
    gone[id] = Date.now();
    saveDeletedTaskTemplates(gone);
    scheduleTaskTemplateSync();
  }

