/* Branchline — js/08-rendering-2.js
   Part 8 of 19 of the former single-file app.js. Contents: rendering (part 2).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  // Right-click on one of a cell's link icons — exactly
  // openUrlSingleManageMenu above, scoped to a cell: rename/remove this
  // one link, click to edit its URL.
  function openCellUrlManageMenu(node, r, c, index, x, y) {
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a);
    const u = urls[index];
    if (!u) return;
    resetContextMenu();
    const it = document.createElement("div");
    it.className = "ctx-item";
    it.title = u;
    const labelSpan = document.createElement("span");
    labelSpan.className = "ctx-item-label";
    labelSpan.appendChild(cellLinkRowFragment(u, a));
    it.appendChild(labelSpan);
    const popup = document.createElement("span");
    popup.className = "ctx-item-remove ctx-item-popup";
    popup.textContent = "🪟";
    popup.title = "Open in a new window (smaller than this one)";
    popup.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); openUrlAsPopup(u); });
    it.appendChild(popup);
    const rename = document.createElement("span");
    rename.className = "ctx-item-remove ctx-item-rename";
    rename.textContent = "✎";
    rename.title = "Rename";
    rename.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); renameCellUrl(node, r, c, index); });
    it.appendChild(rename);
    const comment = document.createElement("span");
    comment.className = "ctx-item-remove ctx-item-comment";
    comment.textContent = "💬";
    comment.title = "Comment";
    comment.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); commentOnCellUrl(node, r, c, index); });
    it.appendChild(comment);
    const rm = document.createElement("span");
    rm.className = "ctx-item-remove";
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); removeCellUrl(node, r, c, index); });
    it.appendChild(rm);
    it.addEventListener("click", () => { closeContextMenu(); editCellUrlByIndex(node, r, c, index); });
    ctxMenu.appendChild(it);
    positionContextMenu(x, y);
  }

  // Same comment editor as commentOnNodeUrl, scoped to one table cell's
  // link (see getCellLinkComment/setCellLinkComment).
  function commentOnCellUrl(node, r, c, index) {
    if (!requireSignIn()) return;
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a);
    const u = urls[index];
    if (!u) return;
    openLinkCommentModal(u, {
      get: () => getCellLinkComment(getCellAttach(node, r, c), u),
      set: (v) => setCellLinkComment(getCellAttach(node, r, c), u, v),
      getFavorite: () => getLinkFavorite(getCellAttach(node, r, c), u),
      setFavorite: (v) => setLinkFavorite(getCellAttach(node, r, c), u, v),
    });
  }

  // The "+" button's menu — same reused ctx-menu the node right-click
  // menu and the note/link picker popups use (see openContextMenu /
  // openNoteManageMenu), just scoped to one cell instead of a whole
  // node. Lets you add, replace, or remove each of the six attachment
  // kinds a cell can carry: photo, note, link, task, timer, and the
  // affirmation game — the last two reuse the exact same modal/interface
  // as their node-level counterparts (see openTimerModal/openAffirmationGame),
  // just aimed at this one cell instead of the whole node.
  function openCellAddMenu(node, r, c, x, y) {
    if (!requireSignIn()) return;
    resetContextMenu();
    ctxMenu.classList.add("cell-context-menu");
    const a = getCellAttach(node, r, c);

    const addSection = (title) => {
      if (ctxMenu.childElementCount) {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        ctxMenu.appendChild(sep);
      }
      const head = document.createElement("div");
      head.className = "ctx-item ctx-item-header cell-menu-header";
      const span = document.createElement("span");
      span.className = "ctx-item-label";
      span.textContent = title;
      head.appendChild(span);
      ctxMenu.appendChild(head);
    };

    const addItem = (label, fn, opts) => {
      const o = opts || {};
      const it = document.createElement("div");
      it.className = "ctx-item" + (o.disabled ? " disabled" : "") + (o.danger ? " danger" : "");
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.textContent = label;
      it.appendChild(labelSpan);
      if (o.hint) {
        const hint = document.createElement("span");
        hint.className = "cell-menu-hint";
        hint.textContent = o.hint;
        it.appendChild(hint);
      }
      if (!o.disabled) {
        it.addEventListener("click", (e) => {
          e.stopPropagation();
          closeContextMenu();
          fn();
        });
      }
      ctxMenu.appendChild(it);
    };

    // Clipboard lives at the top so it is always visible without scrolling.
    addSection("Clipboard");
    addItem("📋 Copy all icons", () => copyAllIconsFromHost(a));
    addItem("📥 Paste all icons", () => pasteAllIconsToHost(a));

    addSection("Content");
    addItem("🖼️ Add photo…", () => openCellPhotoPicker(node, r, c));
    if (cellHasImages(a)) {
      const cellPhotos = getCellPhotos(a);
      addItem(cellPhotos.length > 1 ? "👁️ View photos…" : "👁️ View photo…", () => openCellPhotoModal(node.id, r, c, 0));
      addItem("🗑️ Remove all photos", () => {
        pushUndo();
        const removedCellIds = getCellPhotoIds(a).slice();
        a.images = null;
        a.image = null;
        removedCellIds.forEach(id => { if (!String(id).startsWith("data:")) deletePhotoRecord(id); });
        renderAll();
        persist();
      }, { danger: true });
    }

    addItem(cellHasNotes(a) ? `📝 Notes (${getCellNotes(a).length})…` : "📝 Add note…", () => editCellNote(node, r, c));
    if (cellHasNotes(a)) {
      addItem("🗑️ Remove all notes", () => {
        pushUndo();
        a.note = null;
        a.notes = null;
        a.brainstorm = null;
        renderAll();
        persist();
      }, { danger: true });
    }
    addSection("Work");

    const prog = nodeTaskProgress(a);
    addItem(prog.total ? `✅ Tasks… (${prog.done}/${prog.total})` : "✅ Add tasks…", () => openTasksModal(node.id, r, c));

    const played = getNodeTimePlayed(a);
    addItem(played ? `⏱️ Timer — ${formatTimePlayed(played)}…` : "⏱️ Add timer…", () => openTimerModal(node.id, r, c));
    if (played) {
      addItem("🗑️ Remove timer", () => {
        pushUndo();
        a.timePlayedSec = 0;
        renderAll();
        persist();
      }, { danger: true });
    }

    addItem("🧠 Brainstorm…", () => openBrainstormModal(node.id, r, c));

    const drcFilled = getCellNotes(a).filter(n => isDRCNote(n) && drcNoteIsFilled(n)).length;
    addItem(drcFilled > 0 ? `📋 DRC (${drcFilled} filled in)…` : "📋 DRC…", () => openCellDRCModal(node, r, c));

    const urls = getCellUrls(a);
    const commented = urls.filter(u => getCellLinkComment(a, u)).length;
    addItem(commented > 0 ? `🔗 Links (${commented} commented)…` : "🔗 Add link…", () => addCellUrl(node, r, c));

    const wins = nodeAffirmationWins(a);
    addItem(wins ? `🎮 Affirmation game (✓ ${wins})` : "🎮 Affirmation game", () => openAffirmationGame(node.id, r, c));

    addSection("Cell");
    if (state.cellRange && state.cellRange.nodeId === node.id &&
        (state.cellRange.r1 > state.cellRange.r0 || state.cellRange.c1 > state.cellRange.c0)) {
      const rr = state.cellRange;
      const mergeRows = rr.r1 - rr.r0 + 1, mergeCols = rr.c1 - rr.c0 + 1;
      addItem(`Merge cells (${mergeRows}×${mergeCols})`, () => {
        pushUndo();
        mergeCellRange(node, rr.r0, rr.c0, rr.r1, rr.c1);
        state.cellRange = null;
        renderAll();
        persist();
      });
    }
    const currentMerge = getCellMerge(node, r, c);
    if (currentMerge && (currentMerge.r1 > currentMerge.r0 || currentMerge.c1 > currentMerge.c0)) {
      addItem("Unmerge cells", () => {
        pushUndo();
        unmergeCellAt(node, r, c);
        renderAll();
        persist();
      });
    }

    addSection("Appearance");

    const combinedOn = !!a.bold && !!a.allCaps;
    addItem(combinedOn ? "𝐀𝐀 Bold + ALL CAPS ✓" : "𝐀𝐀 Bold + ALL CAPS", () => {
      pushUndo();
      const turnOn = !(a.bold && a.allCaps);
      a.bold = turnOn;
      a.allCaps = turnOn;
      renderAll();
      persist();
    });
    addItem(a.struck ? "~~ Remove strikethrough" : "~~ Strikethrough", () => {
      pushUndo();
      a.struck = !a.struck;
      renderAll();
      persist();
    });

    const fillLabel = document.createElement("div");
    fillLabel.className = "ctx-item cell-menu-subhead";
    fillLabel.textContent = "Fill color";
    ctxMenu.appendChild(fillLabel);
    {
      const swatchRow = document.createElement("div");
      swatchRow.className = "ctx-swatches";
      const resetSwatch = document.createElement("span");
      resetSwatch.className = "ctx-swatch ctx-swatch-reset" + (!a.fillColor ? " active" : "");
      resetSwatch.title = "Default";
      resetSwatch.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        a.fillColor = null;
        closeContextMenu();
        renderAll();
        persist();
      });
      swatchRow.appendChild(resetSwatch);
      PALETTE.forEach(c => {
        const s = document.createElement("span");
        s.className = "ctx-swatch" + (a.fillColor === c ? " active" : "");
        s.style.background = c;
        s.addEventListener("click", (e) => {
          e.stopPropagation();
          pushUndo();
          a.fillColor = c;
          closeContextMenu();
          renderAll();
          persist();
        });
        swatchRow.appendChild(s);
      });
      ctxMenu.appendChild(swatchRow);
    }

    const fontLabel = document.createElement("div");
    fontLabel.className = "ctx-item cell-menu-subhead";
    fontLabel.textContent = "Font color";
    ctxMenu.appendChild(fontLabel);
    {
      const swatchRow = document.createElement("div");
      swatchRow.className = "ctx-swatches";
      const resetSwatch = document.createElement("span");
      resetSwatch.className = "ctx-swatch ctx-swatch-reset" + (!a.fontColor ? " active" : "");
      resetSwatch.title = "Default";
      resetSwatch.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        a.fontColor = null;
        closeContextMenu();
        renderAll();
        persist();
      });
      swatchRow.appendChild(resetSwatch);
      PALETTE.forEach(c => {
        const s = document.createElement("span");
        s.className = "ctx-swatch" + (a.fontColor === c ? " active" : "");
        s.style.background = c;
        s.addEventListener("click", (e) => {
          e.stopPropagation();
          pushUndo();
          a.fontColor = c;
          closeContextMenu();
          renderAll();
          persist();
        });
        swatchRow.appendChild(s);
      });
      ctxMenu.appendChild(swatchRow);
    }

    const alignLabel = document.createElement("div");
    alignLabel.className = "ctx-item cell-menu-subhead";
    alignLabel.textContent = "Text align";
    ctxMenu.appendChild(alignLabel);
    {
      const row = document.createElement("div");
      row.className = "ctx-align-row";
      [["left", "Left"], ["center", "Center"], ["right", "Right"]].forEach(([val, txt]) => {
        const btn = document.createElement("div");
        const isActive = (a.align || "left") === val;
        btn.className = "ctx-align-btn" + (isActive ? " active" : "");
        btn.textContent = txt;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          pushUndo();
          a.align = val === "left" ? null : val;
          closeContextMenu();
          renderAll();
          persist();
        });
        row.appendChild(btn);
      });
      ctxMenu.appendChild(row);
    }

    positionContextMenu(x, y);
  }

  // The row of small icons under a cell's text — one per attachment it  // The row of small icons under a cell's text — one per attachment it
  // currently holds (photo/note/link/task), plus a trailing "+" to add
  // more. Mirrors the node-level photo/note/link strip (see renderNode)
  // at a smaller scale, and reads/writes node.table.attach[r][c] instead
  // of the node's own fields.
  function mapIconStyle() {
    return state.current && state.current.iconStyle === "mono" ? "mono" : "color";
  }
  function setMapIconStyle(mode) {
    if (!state.current || !["color", "mono"].includes(mode)) return;
    pushUndo();
    state.current.iconStyle = mode;
    renderAll();
    persist();
  }
  function taskBadgeStyle() {
    const v = state.current && state.current.taskBadgeStyle;
    return v === "color" || v === "size" || v === "both" ? v : "both";
  }
  function taskBadgeClass(points, extraClass) {
    const mode = taskBadgeStyle();
    return "task-score-badge " + extraClass +
      " task-badge-" + mode + " score-" + cellScoreBand(points);
  }
  function setTaskBadgeStyle(mode) {
    if (!state.current || !["color", "size", "both"].includes(mode)) return;
    pushUndo();
    state.current.taskBadgeStyle = mode;
    renderAll();
    persist();
  }
  function cellScoreBand(points) {
    const p = Math.max(0, Number(points) || 0);
    if (p >= 100) return "very-high";
    if (p >= 75) return "high";
    if (p >= 50) return "strong";
    if (p >= 25) return "medium";
    if (p >= 10) return "low";
    return "very-low";
  }

  function buildCellScoreBadge(node, r, c, a) {
    const prog = nodeTaskProgress(a);
    const hasTasks = getNodeTasks(a).length > 0;
    // v409: keep the badge available as the cell's fast Tasks entry point.
    // A task list with zero points still gets a "0" badge so it can always
    // be reopened directly from the calendar/table cell.
    if (!prog || !hasTasks) return null;
    const points = Math.max(0, Number(prog.done) || 0);
    const badge = document.createElement("span");
    badge.className = taskBadgeClass(points, "node-table-cell-score-badge");
    badge.textContent = String(points);
    badge.title = `${points} progress points${prog.total ? ` / ${prog.total} total` : ""} — click to open Tasks`;
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    badge.setAttribute("aria-label", `Open Tasks — ${points} progress points`);

    const openTasks = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTasksModal(node.id, r, c);
    };
    badge.addEventListener("mousedown", (e) => e.stopPropagation());
    badge.addEventListener("pointerdown", (e) => e.stopPropagation());
    badge.addEventListener("click", openTasks);
    badge.addEventListener("dblclick", (e) => e.stopPropagation());
    badge.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openTasks(e);
    });

    // The badge is now the ONLY task marker in a cell. Keep the old task
    // icon's drag behavior here so node↔cell / cell↔cell task moves still work.
    if (hasTasks) {
      badge.draggable = true;
      badge.title += " — drag to move tasks (hold Alt to copy)";
      badge.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "tasks", { sourceR: r, sourceC: c }));
      armMarkerTouchDrag(badge, node, "tasks", { sourceR: r, sourceC: c });
      badge.addEventListener("dragend", endMarkerDrag);
    }
    return badge;
  }

  function buildCellIconStrip(node, r, c) {
    const a = getCellAttach(node, r, c);
    const strip = document.createElement("div");
    strip.className = "node-table-cell-icons";
    strip.addEventListener("mousedown", (e) => e.stopPropagation());
    strip.addEventListener("pointerdown", (e) => e.stopPropagation());
    strip.addEventListener("click", (e) => e.stopPropagation());

    // One thumbnail per photo (capped, with a "+N" overflow badge past
    // the cap), same treatment as the node-level photo strip (see
    // renderNode) — click to view, drag onto a node to move/copy it
    // there (see startMarkerDrag/completeMarkerDrop), right-click a
    // single thumbnail to remove just that one.
    const cellImages = getCellPhotos(a);
    if (cellImages.length) {
      const overflow = cellImages.length > 4;
      const shownCount = overflow ? 1 : cellImages.length;
      for (let i = 0; i < shownCount; i++) {
        const thumb = document.createElement("span");
        thumb.className = "node-table-cell-icon node-table-cell-photo";
        const fullSrc = cellImages[i];
        const cachedThumb = getMarkerThumb(fullSrc, () => {
          const liveThumb = nodesLayer.querySelector(`.node[data-id="${node.id}"] .node-table-cell[data-r="${r}"][data-c="${c}"] .node-table-cell-photo[data-src-index="${i}"]`);
          if (liveThumb) liveThumb.style.backgroundImage = `url("${nodeThumbCache.get(fullSrc)}")`;
        });
        thumb.dataset.srcIndex = String(i);
        thumb.style.backgroundImage = `url("${cachedThumb || fullSrc}")`;
        thumb.draggable = true;
        thumb.addEventListener("dragend", endMarkerDrag);
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          openCellPhotoModal(node.id, r, c, i);
        });
        if (overflow) {
          thumb.title = `${cellImages.length} photos — click to view the first, drag to move them all onto a node or cell (hold Alt to copy)`;
          thumb.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photos", { sourceR: r, sourceC: c }));
          armMarkerTouchDrag(thumb, node, "photos", { sourceR: r, sourceC: c });
          const badge = document.createElement("span");
          badge.className = "node-marker-count";
          badge.textContent = String(cellImages.length);
          thumb.appendChild(badge);
        } else {
          thumb.title = "Click to view — drag onto a node or cell to move it there (hold Alt to copy) — right-click to remove";
          thumb.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photo", { photoIndex: i, sourceR: r, sourceC: c }));
          armMarkerTouchDrag(thumb, node, "photo", { photoIndex: i, sourceR: r, sourceC: c });
          thumb.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!requireSignIn()) return;
            pushUndo();
            const ids = getCellPhotoIds(a).slice();
            const removedId = ids[i];
            ids.splice(i, 1);
            a.images = ids;
            a.image = null;
            if (!String(removedId).startsWith("data:")) deletePhotoRecord(removedId);
            renderAll();
            persist();
          });
        }
        strip.appendChild(thumb);
      }
    }
    {
      const notes = getCellNotes(a);
      // v432: a cell is a mini-node not only for its own notes, but also for
      // the note markers owned by tasks/subtasks inside the cell. Copy/Paste
      // all icons already carries the complete task tree; render those nested
      // markers here too so a pasted cell does not appear to lose Note/DRC.
      // Brainstorm host notes are skipped because the shared 🧠 marker below
      // owns them, exactly like the node strip.
      notes.forEach((n, i) => {
        if (isBrainstormNote(n)) return;
        const noteIcon = document.createElement("span");
        noteIcon.className = "node-table-cell-icon node-table-cell-note" +
          (isDRCNote(n) ? " node-table-cell-drc" : "");
        noteIcon.innerHTML = isDRCNote(n)
          ? NODE_DRC_ICON_IMG
          : (isPlanNote(n) ? NODE_PLAN_ICON_IMG : CELL_NOTE_ICON_SVG);
        noteIcon.title = (isDRCNote(n)
          ? (drcNoteIsFilled(n) ? "DRC — filled in" : "DRC — not filled in yet")
          : notePreviewText(n)) + " — drag onto a node or cell to move (hold Alt to copy)";
        noteIcon.draggable = true;
        noteIcon.addEventListener("dragstart", (e) =>
          startMarkerDrag(e, node, "note-single", { noteIndex: i, sourceR: r, sourceC: c }));
        armMarkerTouchDrag(noteIcon, node, "note-single", { noteIndex: i, sourceR: r, sourceC: c });
        noteIcon.addEventListener("dragend", endMarkerDrag);
        noteIcon.addEventListener("click", () => openNoteModal(node.id, i, null, null, { r, c }));
        strip.appendChild(noteIcon);
      });

      const tasksWithNotes = getNodeTasks(a).filter(taskHasNotes);
      const subtasksWithNotes = getNodeTasks(a).flatMap((t) =>
        getTaskSubtasks(t).filter(taskHasNotes).map((sub) => ({ t, sub }))
      );

      tasksWithNotes.forEach((t) => {
        const first = getTaskNotes(t)[0];
        if (!first) return;
        const isDrc = isDRCNote(first);
        const icon = document.createElement("span");
        icon.className = "node-table-cell-icon node-table-cell-note node-table-cell-task-note" +
          (isDrc ? " node-table-cell-drc" : "");
        icon.innerHTML = isDrc
          ? NODE_DRC_ICON_IMG
          : (isPlanNoteFor(first, t) ? NODE_PLAN_ICON_IMG : CELL_NOTE_ICON_SVG);
        icon.title = isDrc
          ? `Task "${t.text || "(untitled task)"}" — DRC, ${drcNoteIsFilled(first) ? "filled in" : "not filled in yet"}`
          : `Task "${t.text || "(untitled task)"}" — ${notePreviewText(first)}`;
        icon.title += " — drag onto a node or cell to move this task's note(s) (hold Alt to copy)";
        icon.draggable = true;
        icon.addEventListener("dragstart", (e) =>
          startMarkerDrag(e, node, "task-notes", { sourceTaskId: t.id, sourceR: r, sourceC: c }));
        armMarkerTouchDrag(icon, node, "task-notes", { sourceTaskId: t.id, sourceR: r, sourceC: c });
        icon.addEventListener("dragend", endMarkerDrag);
        icon.addEventListener("click", () => openNoteModal(node.id, undefined, null, t.id, { r, c }));
        strip.appendChild(icon);
      });

      subtasksWithNotes.forEach(({ t, sub }) => {
        const first = getTaskNotes(sub)[0];
        if (!first) return;
        const isDrc = isDRCNote(first);
        const icon = document.createElement("span");
        icon.className = "node-table-cell-icon node-table-cell-note node-table-cell-subtask-note" +
          (isDrc ? " node-table-cell-drc" : "");
        icon.innerHTML = isDrc
          ? NODE_DRC_ICON_IMG
          : (isPlanNoteFor(first, sub) ? NODE_PLAN_ICON_IMG : CELL_NOTE_ICON_SVG);
        icon.title = isDrc
          ? `Subtask "${sub.text || "(untitled subtask)"}" — DRC, ${drcNoteIsFilled(first) ? "filled in" : "not filled in yet"}`
          : `Subtask "${sub.text || "(untitled subtask)"}" — ${notePreviewText(first)}`;
        icon.title += " — drag onto a node or cell to move this subtask's note(s) (hold Alt to copy)";
        icon.draggable = true;
        icon.addEventListener("dragstart", (e) =>
          startMarkerDrag(e, node, "task-notes", {
            sourceTaskId: t.id,
            sourceSubtaskId: sub.id,
            sourceR: r,
            sourceC: c
          }));
        armMarkerTouchDrag(icon, node, "task-notes", {
          sourceTaskId: t.id,
          sourceSubtaskId: sub.id,
          sourceR: r,
          sourceC: c
        });
        icon.addEventListener("dragend", endMarkerDrag);
        icon.addEventListener("click", () =>
          openNoteModal(node.id, undefined, null, t.id, { r, c }, false, sub.id));
        strip.appendChild(icon);
      });
    }
    // One icon per link (instead of a single icon), same treatment as
    // the node-level link markers (see renderNode) — each link is
    // independently visible, clickable, and editable via right-click.
    getCellUrls(a).forEach((u, i) => {
      const linkIcon = document.createElement("span");
      linkIcon.className = "node-table-cell-icon node-table-cell-link";
      linkIcon.innerHTML = linkIconFor(u);
      const linkTitle = getCellLinkTitle(a, u);
      linkIcon.title = (linkTitle || u) + " — drag onto a node or cell to move (hold Alt to copy)";
      linkIcon.draggable = true;
      attachLinkCommentTooltip(linkIcon, u, () => getCellLinkComment(getCellAttach(node, r, c), u), () => getCellLinkTitle(getCellAttach(node, r, c), u));
      linkIcon.addEventListener("click", () => openLinkSmart(u, {
        videoKey: videoItemKey(node.id, r, c, u),
        get: () => getCellLinkComment(getCellAttach(node, r, c), u),
        set: (v) => setCellLinkComment(getCellAttach(node, r, c), u, v),
        getFavorite: () => getLinkFavorite(getCellAttach(node, r, c), u),
        setFavorite: (v) => setLinkFavorite(getCellAttach(node, r, c), u, v),
        getPhotos: () => getCellLinkPhotos(getCellAttach(node, r, c), u),
        addPhoto: (dataUrl) => addCellLinkPhoto(getCellAttach(node, r, c), u, dataUrl),
        removePhoto: (id) => removeCellLinkPhoto(getCellAttach(node, r, c), u, id),
      }));
      linkIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "url-single", { urlIndex: i, sourceR: r, sourceC: c }));
      armMarkerTouchDrag(linkIcon, node, "url-single", { urlIndex: i, sourceR: r, sourceC: c });
      linkIcon.addEventListener("dragend", endMarkerDrag);
      linkIcon.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openCellUrlManageMenu(node, r, c, i, e.clientX, e.clientY);
      });
      strip.appendChild(linkIcon);
    });
    const cellAffirmationWins = nodeAffirmationWins(a);
    if (cellAffirmationWins) {
      const affIcon = document.createElement("span");
      affIcon.className = "node-table-cell-icon node-table-cell-affirmation";
      affIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5L19.5 7"/></svg>';
      affIcon.title = `Affirmation game — ${cellAffirmationWins} round${cellAffirmationWins === 1 ? "" : "s"} completed — click to play; drag to move (hold Alt to copy)`;
      affIcon.draggable = true;
      affIcon.addEventListener("dragstart", (e) =>
        startMarkerDrag(e, node, "affirmation", { sourceR: r, sourceC: c }));
      armMarkerTouchDrag(affIcon, node, "affirmation", { sourceR: r, sourceC: c });
      affIcon.addEventListener("dragend", endMarkerDrag);
      affIcon.addEventListener("click", () => openAffirmationGame(node.id, r, c));
      if (cellAffirmationWins > 1) {
        const affCount = document.createElement("span");
        affCount.className = "node-marker-count";
        affCount.textContent = String(cellAffirmationWins);
        affIcon.appendChild(affCount);
      }
      strip.appendChild(affIcon);
    }
    const cellTimePlayed = getNodeTimePlayed(a);
    if (cellTimePlayed) {
      const tbadge = document.createElement("span");
      tbadge.className = "node-table-cell-icon node-table-cell-timer";
      tbadge.title = `${formatTimePlayed(cellTimePlayed)} logged — click to add more; drag to move (hold Alt to copy)`;
      tbadge.draggable = true;
      tbadge.addEventListener("dragstart", (e) =>
        startMarkerDrag(e, node, "timer", { sourceR: r, sourceC: c }));
      armMarkerTouchDrag(tbadge, node, "timer", { sourceR: r, sourceC: c });
      tbadge.addEventListener("dragend", endMarkerDrag);
      tbadge.addEventListener("click", () => openTimerModal(node.id, r, c));
      const tlabel = document.createElement("span");
      tlabel.textContent = formatTimePlayed(cellTimePlayed);
      tbadge.appendChild(tlabel);
      strip.appendChild(tbadge);
    }
    // v432: Brainstorm-prefixed subtasks inside a cell share the cell's one
    // Brainstorm marker, matching the one-marker-per-node rule. This is what
    // makes Paste all icons visibly preserve a "brainstorm..." subtask marker
    // even before any Brainstorm text has been written.
    const cellHasBrainstorm =
      hasBrainstormContent(a) ||
      getNodeTasks(a).some((t) => getTaskSubtasks(t).some(subtaskHasBrainstormMarker));
    if (cellHasBrainstorm) {
      // Same brain-with-count marker as the node-level strip (see
      // renderNode) — click jumps straight into the scratchpad for this cell.
      // v424: this is also a real Branchline marker drag, so moving the brain
      // moves the Brainstorm content itself instead of only dragging its emoji.
      const bIcon = document.createElement("span");
      bIcon.className = "node-table-cell-icon node-table-cell-brainstorm";
      bIcon.textContent = "🧠";
      bIcon.title = "Brainstorm — click to keep writing; drag onto a node or cell to move (hold Alt to copy).";
      bIcon.draggable = true;
      bIcon.addEventListener("dragstart", (e) =>
        startMarkerDrag(e, node, "brainstorm", { sourceR: r, sourceC: c }));
      armMarkerTouchDrag(bIcon, node, "brainstorm", { sourceR: r, sourceC: c });
      bIcon.addEventListener("dragend", endMarkerDrag);
      bIcon.addEventListener("click", () => openBrainstormModal(node.id, r, c));
      strip.appendChild(bIcon);
    }

    // Calendar tables stay visually clean: cell actions are available
    // from right-click/long-press only, so don't render a trailing + in
    // every date cell. Existing attachment markers still remain visible.
    if (!node.table.calendar) {
      const addBtn = document.createElement("span");
      addBtn.className = "node-table-cell-icon node-table-cell-add";
      addBtn.textContent = "+";
      addBtn.title = "Add a photo, note, link, task, timer, affirmation game, brainstorm, or DRC to this cell";
      addBtn.addEventListener("click", (e) => openCellAddMenu(node, r, c, e.clientX, e.clientY));
      strip.appendChild(addBtn);
    }

    return strip;
  }

  // v404: calendars made by v398-v403 were stored Sun→Sat. Convert those
  // existing calendar children once in memory so old maps immediately match
  // the new Monday→Sunday order too. Date-cell attachment objects move with
  // their actual date, so notes/photos/tasks/links/Brainstorms do not jump to
  // a different day merely because the visible weekday columns changed.
  function ensureCalendarMondayFirst(node) {
    if (!node || !node.table || !node.table.calendar || !Array.isArray(node.table.cells)) return false;
    const table = node.table;
    const year = Number(table.calendarYear);
    const month = Number(table.calendarMonth);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return false;

    const headers = table.cells[1] || [];
    const newStart = (new Date(year, month - 1, 1).getDay() + 6) % 7;

    // Already Monday-first (including the very early calendar prototype):
    // just normalize its metadata and leave the stored cells untouched.
    if (headers[0] === "Mon" && headers[6] === "Sun") {
      table.calendarStart = newStart;
      table.calendarWeekStartsMonday = true;
      return false;
    }

    // Only transform the known Sunday-first shape. Unknown/custom weekday
    // rows are left alone rather than guessing and risking user data.
    if (!(headers[0] === "Sun" && headers[1] === "Mon" && headers[6] === "Sat")) return false;

    const oldCells = table.cells.map(row => Array.isArray(row) ? row.slice() : []);
    const oldAttach = ensureTableAttach(node).map(row => (row || []).slice());
    const oldStart = Number.isFinite(Number(table.calendarStart))
      ? Number(table.calendarStart)
      : new Date(year, month - 1, 1).getDay(); // Sunday = 0

    const prevDays = new Date(year, month - 1, 0).getDate();
    const days = new Date(year, month, 0).getDate();
    const newCells = [
      (oldCells[0] || [String(month).padStart(2, "0") + "/" + String(year).slice(-2), "", "", "", "", "", ""]).slice(0, 7),
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    ];
    while (newCells[0].length < 7) newCells[0].push("");

    let nextDay = 1;
    for (let week = 0; week < 6; week++) {
      const row = new Array(7).fill("");
      for (let col = 0; col < 7; col++) {
        const slot = week * 7 + col;
        const dayIndex = slot - newStart + 1;
        if (dayIndex < 1) row[col] = String(prevDays + dayIndex);
        else if (dayIndex > days) row[col] = String(nextDay++);
        else row[col] = String(dayIndex);
      }
      newCells.push(row);
    }

    const newAttach = newCells.map(row => row.map(() => ({})));

    // Preserve title-row attachment data as-is.
    for (let c = 0; c < 7; c++) {
      if (oldAttach[0] && oldAttach[0][c]) newAttach[0][c] = oldAttach[0][c];
    }
    // Weekday row rotates Sun from the first old column to the last new one.
    for (let c = 0; c < 6; c++) {
      if (oldAttach[1] && oldAttach[1][c + 1]) newAttach[1][c] = oldAttach[1][c + 1];
    }
    if (oldAttach[1] && oldAttach[1][0]) newAttach[1][6] = oldAttach[1][0];

    // Move each stored date cell by its absolute offset from this month's
    // first day. The Monday-first 42-day window differs by at most one
    // boundary day from the old Sunday-first window.
    for (let r = 2; r < oldCells.length; r++) {
      for (let c = 0; c < 7; c++) {
        const oldSlot = (r - 2) * 7 + c;
        const dayIndex = oldSlot - oldStart + 1;
        const newSlot = dayIndex + newStart - 1;
        if (newSlot < 0 || newSlot >= 42) continue;
        const nr = 2 + Math.floor(newSlot / 7);
        const nc = newSlot % 7;
        if (oldCells[r] && oldCells[r][c] != null) newCells[nr][nc] = oldCells[r][c];
        if (oldAttach[r] && oldAttach[r][c]) newAttach[nr][nc] = oldAttach[r][c];
      }
    }

    table.cells = newCells;
    table.attach = newAttach;
    table.calendarStart = newStart;
    table.calendarWeekStartsMonday = true;
    return true;
  }

  // Builds the actual <table> for a table node (see nodeIsTable) inside
  // its div, using the exact column widths / row heights computeNodeBox
  // (via computeTableBox) already worked out — so what's on screen always
  // matches the box the layout/connector code positioned it with. Every
  // cell holds its own contentEditable text field plus a small icon strip
  // (see buildCellIconStrip) for that cell's own photo/note/link/task
  // attachments; text edits commit on blur (see the "blur" listener
  // below) rather than live per-keystroke, which keeps this simple at
  // the cost of the box only resizing to fit new text once you click
  // away from the cell.
  function renderTableGrid(div, node) {
    ensureCalendarMondayFirst(node);
    ensureTableAttach(node);
    const cells = node.table.cells;
    const cols = Math.max(1, ...cells.map(r => r.length));
    const colWidths = node._tableColWidths || new Array(cols).fill(node.table.calendar ? 70 : TABLE_CELL_MIN_W);
    const rowHeights = node._tableRowHeights || cells.map(() => TABLE_CELL_MIN_H);

    const table = document.createElement("table");
    const calendarStyles = ["classic", "transparent", "glass", "paper", "minimal", "dark", "pastel"];
    const calendarStyle = calendarStyles.includes(node.table.calendarStyle)
      ? node.table.calendarStyle
      : "classic";
    table.className = "node-table"
      + (node.table.gridStyle === "outline" ? " node-table-outline" : "")
      + (node.table.calendar ? ` node-table-calendar calendar-style-${calendarStyle}` : "");
    table.addEventListener("mousedown", (e) => e.stopPropagation());
    table.addEventListener("pointerdown", (e) => e.stopPropagation());
    table.addEventListener("dblclick", (e) => e.stopPropagation());

    const colgroup = document.createElement("colgroup");
    colWidths.forEach((w) => {
      const col = document.createElement("col");
      // v399: phase2-layout now computes the real 2× table width and
      // includes calendar spacing/padding in node._w. Render that exact width
      // here so the grid stays inside the node border.
      const renderedW = Math.max(w, node.table.calendar ? 70 : 88);
      col.style.width = renderedW + "px";
      col.style.minWidth = renderedW + "px";
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);

    const tbody = document.createElement("tbody");
    cells.forEach((row, r) => {
      const tr = document.createElement("tr");
      tr.style.height = (rowHeights[r] || TABLE_CELL_MIN_H) + "px";
      for (let c = 0; c < cols; c++) {
        // A cell covered by another cell's merge (see mergeCellRange)
        // renders no <td> of its own at all — the origin cell's rowSpan/
        // colSpan below covers this spot instead.
        if (!isMergeOrigin(node, r, c)) continue;
        const span = cellSpan(node, r, c);
        const a = getCellAttach(node, r, c);
        const td = document.createElement("td");
        td.className = "node-table-cell";
        if (node.table.calendar) {
          if (r === 0) td.classList.add("calendar-title-cell");
          else if (r === 1) td.classList.add("calendar-weekday-cell");
          else {
            td.classList.add("calendar-day-cell");
            const start = Number(node.table.calendarStart ?? ((new Date(node.table.calendarYear || 2000, (node.table.calendarMonth || 1) - 1, 1).getDay() + 6) % 7));
            const monthDays = new Date(node.table.calendarYear || 2000, node.table.calendarMonth || 1, 0).getDate();
            const slot = (r - 2) * 7 + c;
            const dayIndex = slot - start + 1;
            if (dayIndex < 1 || dayIndex > monthDays) td.classList.add("calendar-outside-month");
            const now = new Date();
            if (Number(node.table.calendarYear) === now.getFullYear() &&
                Number(node.table.calendarMonth) === now.getMonth() + 1 &&
                dayIndex === now.getDate()) td.classList.add("calendar-today");
          }
        }
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        if (span.rowSpan > 1) td.rowSpan = span.rowSpan;
        if (span.colSpan > 1) td.colSpan = span.colSpan;
        if (a.fillColor) td.style.background = a.fillColor;
        if (cellAttachHasStripIcon(a)) td.classList.add("has-cell-icons");
        if (state.selectedCell && state.selectedCell.nodeId === node.id &&
            state.selectedCell.r === r && state.selectedCell.c === c) {
          td.classList.add("cell-selected");
        }
        if (state.cellRange && state.cellRange.nodeId === node.id &&
            r >= state.cellRange.r0 && r <= state.cellRange.r1 &&
            c >= state.cellRange.c0 && c <= state.cellRange.c1) {
          td.classList.add("range-selected");
        }
        td.addEventListener("click", (e) => {
          e.stopPropagation();
          handleTableCellClick(node, r, c, e.shiftKey);
          // The whole cell is an editing target, including empty space below
          // short text. Clicking that padding focuses the cell editor and
          // places the caret at the end instead of doing nothing.
          if (!e.shiftKey && e.target === td) {
            const editor = td.querySelector(".node-table-cell-text");
            if (editor) {
              editor.focus();
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        });
        td.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!requireSignIn()) return;
          state.selectedId = node.id;
          state.selectedCell = { nodeId: node.id, r, c };
          state.cellRangeAnchor = { nodeId: node.id, r, c };
          document.querySelectorAll(".node-table-cell.cell-selected")
            .forEach(el => el.classList.remove("cell-selected"));
          td.classList.add("cell-selected");
          openCellAddMenu(node, r, c, e.clientX, e.clientY);
        });

        // Accept a photo/note/link/task marker dragged from a node or
        // another cell (see startMarkerDrag/completeMarkerDrop) — stops
        // propagation so it lands on this one cell instead of also
        // bubbling up to the whole-node drop handler below.
        td.addEventListener("dragover", (e) => {
          if (!markerDragAvailable(e)) return;
          const drag = markerDragState;
          if (drag && drag.sourceNodeId === node.id && drag.sourceR === r && drag.sourceC === c) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
          td.classList.add("marker-drop-target");
        });
        td.addEventListener("dragleave", (e) => {
          if (e.relatedTarget && td.contains(e.relatedTarget)) return;
          td.classList.remove("marker-drop-target");
        });
        td.addEventListener("drop", (e) => {
          const drag = readMarkerDragPayload(e);
          if (!drag) return;
          if (drag.sourceNodeId === node.id && drag.sourceR === r && drag.sourceC === c) return;
          e.preventDefault();
          e.stopPropagation();
          td.classList.remove("marker-drop-target");
          completeMarkerDrop(node.id, e.altKey, r, c);
        });

        const textEl = document.createElement("div");
        textEl.className = "node-table-cell-text";
        textEl.contentEditable = "true";
        textEl.spellcheck = false;
        textEl.textContent = row[c] || "";
        textEl.style.color = a.fontColor || "";
        textEl.style.textAlign = a.align || (node.table.calendar ? "center" : "");
        textEl.style.textTransform = a.allCaps ? "uppercase" : "";
        textEl.style.textDecoration = a.struck ? "line-through" : "";
        if (node.table.calendar && (r === 0 || r === 1)) {
          textEl.style.fontWeight = r === 0 ? "900" : "800";
        } else {
          textEl.style.fontWeight = a.bold ? "800" : "";
        }
        textEl.addEventListener("click", (e) => { e.stopPropagation(); handleTableCellClick(node, r, c, e.shiftKey); });
        textEl.addEventListener("blur", () => {
          const newText = textEl.textContent;
          if (newText === (cells[r][c] || "")) return;
          if (!requireSignIn()) { textEl.textContent = cells[r][c] || ""; return; }
          pushUndo();
          cells[r][c] = newText;
          // Do not rebuild the whole table merely because the caret leaves
          // a cell. A render swaps the contentEditable DOM node and makes
          // the caret appear to jump/disappear. Keep the edited cell intact;
          // the next deliberate click/render will naturally recompute layout.
          persist();
        });

        // v415: a table/calendar cell is always contenteditable, which meant
        // the global "paste onto selected node/cell" shortcut skipped it.
        // Intercept attachment-like clipboard content here instead:
        //   copied image       -> cell photo
        //   copied URL/link    -> cell link
        //   copied YouTube URL -> same cell link, therefore same video icon/player
        // Plain text that is not exactly one URL keeps the browser's normal
        // paste behavior and remains editable cell text.
        textEl.addEventListener("paste", (e) => {
          if (!requireSignIn()) return;
          const cd = e.clipboardData;
          if (!cd) return;
          const items = cd.items ? Array.from(cd.items) : [];
          const imageItem = items.find(i => i.type && i.type.startsWith("image/"));
          const file = imageItem && imageItem.getAsFile();
          const url = !file ? pasteableUrlFromClipboard(cd) : null;
          if (!file && !url) return;

          e.preventDefault();
          e.stopPropagation();
          // Keep the cell as the active paste target even though renderAll()
          // below will replace this contenteditable element.
          state.selectedId = node.id;
          state.selectedCell = { nodeId: node.id, r, c };

          if (file) handleCellPhotoFiles(node.id, r, c, [file]);
          else pasteUrlOntoCell(node.id, r, c, url);
        });
        td.appendChild(textEl);
        td.appendChild(buildCellIconStrip(node, r, c));
        const scoreBadge = buildCellScoreBadge(node, r, c, a);
        if (scoreBadge) td.appendChild(scoreBadge);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    div.appendChild(table);
  }

  // Click handling for a table cell, shared by the cell's <td> and its
  // text div. A plain click selects just that one cell and plants a new
  // range anchor there (see state.cellRangeAnchor); a shift-click, as
  // long as the anchor belongs to this same table, extends the
  // selection into a rectangle between the anchor and the clicked cell
  // (see state.cellRange) — that rectangle is what "Merge cells" (in
  // openCellAddMenu) acts on.
  //
  // A plain click on a cell that's already the selected one (no range to
  // draw or clear) is just caret placement inside the contentEditable text
  // box that's already on screen — skip the renderAll() in that case, since
  // rebuilding the grid would swap in a fresh <div> and throw away the caret
  // position the browser just set from this very click. Every other case
  // (selecting a different cell, or drawing/clearing a range highlight)
  // still needs the full redraw.
  function handleTableCellClick(node, r, c, shiftKey) {
    if (shiftKey && state.cellRangeAnchor && state.cellRangeAnchor.nodeId === node.id) {
      const anchor = state.cellRangeAnchor;
      state.cellRange = {
        nodeId: node.id,
        r0: Math.min(anchor.r, r), r1: Math.max(anchor.r, r),
        c0: Math.min(anchor.c, c), c1: Math.max(anchor.c, c),
      };
      state.selectedId = node.id;
      state.selectedCell = { nodeId: node.id, r, c };
      renderAll();
      return;
    }
    // A normal click does not need a full canvas rebuild. Re-rendering
    // here destroys the contentEditable element after the browser has
    // placed its caret, which is why the text cursor could flash and
    // immediately disappear on the first click into a different cell.
    state.cellRangeAnchor = { nodeId: node.id, r, c };
    state.cellRange = null;
    selectNode(node.id, { nodeId: node.id, r, c });
    // Keep selection visuals current without replacing the table DOM.
    document.querySelectorAll(".node-table-cell.cell-selected")
      .forEach(el => el.classList.remove("cell-selected"));
    const liveCell = nodesLayer.querySelector(
      `.node[data-id="${node.id}"] .node-table-cell[data-r="${r}"][data-c="${c}"]`
    );
    if (liveCell) liveCell.classList.add("cell-selected");
    document.querySelectorAll(".node-table-cell.range-selected").forEach(el => el.classList.remove("range-selected"));
  }


  function renderNode(node, ox, oy) {
    const depth = node._depth;
    const w = node._w || NODE_H;
    const h = node._h || (depth === 0 ? ROOT_H : NODE_H);
    const div = document.createElement("div");
    // Older saves may have `glow: true` from before named intensities
    // existed — treat that the same as "soft" instead of producing a
    // dead "glow-true" class that matches no CSS rule.
    const glowVariant = node.glow === true ? "soft" : node.glow;
    div.className = `node depth-${Math.min(depth, 3)}` + (node.id === state.selectedId ? " selected" : "") + (node.struck ? " struck" : "") + (glowVariant ? ` glow-${glowVariant}` : "");
    div.dataset.id = node.id;
    div.style.left = (ox + nodeLeftX(node)) + "px";
    div.style.top = (oy + node._y + (node.oy || 0) - h / 2) + "px";
    div.style.width = w + "px";
    div.style.height = h + "px";
    div.title = node.text;

    const theme = state.current.theme;
    if (depth === 0) {
      // The root/"mother topic" node has its own optional custom color
      // (node.color), separate from branch colors below it — when set,
      // it replaces the default navy/orange look with a matching
      // gradient fill and border, the same way a branch's color tints
      // its own node. Falls back to the original fixed look when unset.
      const rootColor = node.color;
      if (rootColor) {
        const lighter = blendHex(rootColor, "#ffffff", 0.18);
        const darker = blendHex(rootColor, "#000000", 0.5);
        div.style.background = `linear-gradient(155deg, ${lighter} 0%, ${darker} 65%)`;
        div.style.border = `2px solid ${rootColor}`;
        div.style.setProperty("--sel-color", rootColor);
      } else {
        div.style.border = "2px solid #F5A25C";
      }
    }

    const color = depth === 0 ? null : (node.color || branchColorFor(state.current.root, node) || "#5b6272");
    // What's actually visible behind this node's text, used both to keep
    // the editing caret visible and, for the solid-filled first level
    // only, to pick a plain black/white text color with good contrast
    // against that fill — every level below that tints its text with
    // the branch color instead (see below).
    let effectiveBg = theme.background || defaultBg();
    if (color) {
      div.style.setProperty("--sel-color", color);
      if (depth === 1) {
        div.style.background = color;
        effectiveBg = color;
      } else if (depth === 2) {
        // Level 3: outlined box only — transparent fill, branch color on the border.
        div.style.background = "transparent";
        div.style.borderColor = color;
      } else {
        // Level 4 and deeper: no box at all — no fill, no border — just
        // the text, tinted with the branch color so nodes still read as
        // part of their branch without a bordered box around them.
        div.style.background = "transparent";
        div.style.color = color;
      }
    }
    if (depth === 0) effectiveBg = node.color ? blendHex(node.color, "#000000", 0.5) : "#0A0B24"; // matches --root-fill, or the custom root color's dark gradient end
    // Level 3+ nodes (outlined boxes and, deeper still, no box at all)
    // have their text tinted with the branch color instead of plain
    // black/white, so the color story stays consistent all the way down
    // the branch rather than only kicking in once the box disappears —
    // unless the user has set a custom font color, which still wins.
    div.style.color = node.fontColor
      ? node.fontColor
      : (color && depth > 1 && theme.fontMode !== "custom")
      ? color
      : (theme.fontMode === "custom" ? theme.fontColor : caretColorFor(effectiveBg));
    div.style.caretColor = caretColorFor(effectiveBg);
    div.style.fontWeight = node.bold ? (depth === 0 ? "900" : "800") : "";
    div.style.textTransform = node.allCaps ? "uppercase" : "";

    // The root node's title used to scroll like a marquee when it ran
    // long, rather than wrapping/clipping — removed at the user's
    // request in favor of plain text, same as every other node.
    if (nodeIsTable(node)) {
      renderTableGrid(div, node);
    } else {
    div.textContent = node.text || (node.id === state.editingId ? "" : "(untitled)");

    if (node.id === state.editingId) {
      div.contentEditable = "true";
      div.spellcheck = false;
      div.addEventListener("input", () => autosizeEditingBox(div, node));
      // Pasting an image while typing a node's text would otherwise let
      // the browser embed it directly inline in the contenteditable box
      // (rendered at full size, blowing up the node on the canvas). Route
      // it to the node's photo attachments instead, same as pasting an
      // image with the node just selected (not being edited) already does.
      div.addEventListener("paste", (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const imageItem = Array.from(items).find(i => i.type && i.type.startsWith("image/"));
        if (!imageItem) return;
        const file = imageItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        handleNodePhotoFiles(node.id, [file]);
      });
    }
    }

    // The root node doubles as a small live clock — current time,
    // UTC/US(NY)/UK world clocks, the Vietnamese weekday+date, and the
    // lunar date, right in the map's central node. Filled in once here
    // (see rootClockValues) and kept ticking afterward by rootClockTick,
    // a separate 1-second interval that just walks back in and updates
    // this block's text — see "root node live clock" above. Hidden while
    // actively editing the title, same as every other marker below.
    if (depth === 0 && node.id !== state.editingId && !isClockHidden()) {
      const clockBlock = document.createElement("span");
      clockBlock.className = "node-clock-block";
      const v = rootClockValues(new Date());

      const timeEl = document.createElement("span");
      timeEl.className = "node-clock-time";
      timeEl.textContent = v.time;
      clockBlock.appendChild(timeEl);

      const worldRow = document.createElement("span");
      worldRow.className = "node-clock-world";
      [["UTC", "utc", v.utc], ["NY", "us", v.us], ["UK", "uk", v.uk]].forEach(([label, key, val]) => {
        const cell = document.createElement("span");
        cell.className = "node-clock-tz";
        const lab = document.createElement("b");
        lab.textContent = label;
        const t = document.createElement("span");
        t.dataset.tz = key;
        t.textContent = val;
        cell.appendChild(lab);
        cell.appendChild(t);
        worldRow.appendChild(cell);
      });
      clockBlock.appendChild(worldRow);

      const solarEl = document.createElement("span");
      solarEl.className = "node-clock-solar";
      solarEl.textContent = v.solar;
      clockBlock.appendChild(solarEl);

      const lunarEl = document.createElement("span");
      lunarEl.className = "node-clock-lunar";
      lunarEl.textContent = v.lunar;
      clockBlock.appendChild(lunarEl);

      div.appendChild(clockBlock);
    }

    // collapse toggle — hidden while actively editing so it doesn't sit
    // inside the contenteditable box and throw off caret placement.
    if (node.children && node.children.length > 0 && node.id !== state.editingId) {
      const toggle = document.createElement("span");
      toggle.className = "node-collapse";
      if (depth > 0 && node._x < 0) {
        toggle.style.right = "auto";
        toggle.style.left = "-9px";
      }
      if (node.collapsed) {
        // Collapsed: the toggle doubles as the child-count badge — the
        // number itself sits on the clickable circle instead of a separate
        // inert badge floating at the corner, so tapping the count is what
        // expands the branch back open.
        toggle.classList.add("node-collapse-count");
        toggle.textContent = String(countAll(node));
        toggle.title = "Expand children";
      } else {
        toggle.textContent = "–";
      }
      toggle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      toggle.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        node.collapsed = !node.collapsed;
        renderAll();
        persist();
      });
      div.appendChild(toggle);
    }

    const nodeUrls = getNodeUrls(node);
    const nodeNotes = getNodeNotes(node);
    // Tasks with their own note(s) surface a note marker on the node too,
    // same icon as a node's own notes, so a note tucked away inside a
    // task's checklist isn't invisible from the mindmap itself.
    const tasksWithNotes = getNodeTasks(node).filter(taskHasNotes);
    // Every subtask that has its own note(s) — same idea as tasksWithNotes,
    // just one level down (see getTaskSubtasks/taskHasNotes, which work on
    // a subtask object exactly like a task one).
    const subtasksWithNotes = getNodeTasks(node).flatMap((t) =>
      getTaskSubtasks(t).filter(taskHasNotes).map((s) => ({ t, s }))
    );
    // Brainstorm is stored separately from rich notes (s.brainstorm), so it
    // needs its own node-strip bucket. Prefix alone is enough to surface the
    // icon, matching the "brainstorm..." affordance inside the Tasks modal.
    const subtasksWithBrainstorm = getNodeTasks(node).flatMap((t) =>
      getTaskSubtasks(t).filter(subtaskHasBrainstormMarker).map((s) => ({ t, s }))
    );
    // v324: Brainstorm is node-scoped. A node gets at most one pink brain
    // marker, whether Brainstorm is opened directly or surfaced by one or
    // more "brainstorm..." subtasks.
    const nodeHasBrainstormMarker =
      (hasBrainstormContent(node) || subtasksWithBrainstorm.length > 0) &&
      !nodeNotes.some(isBrainstormNote);
    const affirmationWins = nodeAffirmationWins(node);
    const taskProg = nodeTaskProgress(node);

    const nodeImages = getNodeImages(node);
    const nodeImageIds = getNodeImageIds(node);
    const timePlayed = getNodeTimePlayed(node);
    // Note, link, affirmation-completion, and time-played markers all
    // render inline as cells of this same strip, right alongside the
    // photo thumbnails, instead of floating outside the node — so every
    // attachment/status indicator for a node lives in one place, all at
    // the same cell size. Only the task-progress bar stays separate,
    // since it's a full-width row rather than a small cell.
    const stripIconCount =
      stripBucketCount(nodeNotes.length)
      + stripBucketCount(nodeUrls.length)
      + tasksWithNotes.length
      + subtasksWithNotes.length
      + (affirmationWins ? 1 : 0)
      + (timePlayed ? 1 : 0)
      + (nodeHasBrainstormMarker ? 1 : 0);
    if ((stripIconCount || nodeImages.length) && node.id !== state.editingId) {
      const strip = document.createElement("span");
      // A handful of items deserve bigger cells than a full grid of them
      // would — "large" only kicks in when everything still fits in one
      // row (under the 5-column cap). Past STRIP_OVERFLOW_CAP photos,
      // collapse to a single cover thumbnail + count badge (see the loop
      // below) rather than one tile per photo, so a node with many photos
      // stays compact. Notes and links get the exact same treatment
      // further down (see notesOverflow/urlsOverflow below).
      const overflow = nodeImages.length > STRIP_OVERFLOW_CAP;
      const shownCount = overflow ? 1 : nodeImages.length;
      const itemCount = stripIconCount + shownCount;
      const large = itemCount <= 10;
      strip.className = "node-photo-strip" + (large ? " large" : "");
      strip.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      strip.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      if (nodeImages.length) {
        // Dragging the strip's own background (not a specific icon/thumb,
        // which each have their own drag handlers) moves every photo at
        // once — matches dragging the old standalone photo strip.
        strip.title = "Drag onto another node to move the photos there (hold Alt to copy)";
        strip.draggable = true;
        strip.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photos"));
        armMarkerTouchDrag(strip, node, "photos");
        strip.addEventListener("dragend", endMarkerDrag);
      }
      // Pin the strip's actual width in JS to exactly what fits `cols`
      // cells per row (same formula computeNodeBox uses to reserve room
      // in the node box), instead of trusting the CSS max-width to land
      // on the same number — a few px of drift between the two would
      // make the browser wrap to an extra row the box never made room
      // for, pushing cells outside the frame.
      const thumbPx = large ? 18 : 13.5;
      const gapPx = 3;
      const cols = Math.min(itemCount, 5);
      strip.style.width = (cols * thumbPx + (cols - 1) * gapPx) + "px";

      // Shared markup for the note icon — same SVG whether it's one of a
      // node's own notes, a task's note, or (once collapsed) the single
      // stand-in icon for an overflowed pile of notes.
      const NODE_NOTE_ICON_SVG = '<svg viewBox="0 0 24 24"><rect x="2.3" y="6.3" width="15.4" height="15.4" rx="1" fill="#E08A2E" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.3 4.3a1 1 0 011-1h12a1 1 0 011 1v12.9l-4.3 4.3H7.3a1 1 0 01-1-1z" fill="#F6E266" stroke="#000" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/><path d="M20.3 17.2l-4.3 4.3v-3a1.3 1.3 0 011.3-1.3z" fill="#F0C24E" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/><line x1="9" y1="8.2" x2="18" y2="8.2" stroke="#000" stroke-width="1.15" stroke-linecap="round"/><line x1="9" y1="11.1" x2="18" y2="11.1" stroke="#000" stroke-width="1.15" stroke-linecap="round"/><line x1="9" y1="14" x2="14.5" y2="14" stroke="#000" stroke-width="1.15" stroke-linecap="round"/><path d="M14.4 4.6l3.5-3.5" stroke="#000" stroke-width="1.3" stroke-linecap="round"/><circle cx="19" cy="1.9" r="1.5" fill="#DC7A93" stroke="#000" stroke-width="1"/></svg>';

      // DRC note marker — the exact notebook+pencil icon the user
      // supplied, embedded as a base64 PNG data URI (background flood-
      // filled to transparent, palette-quantized to keep this constant
      // small) so a "Daily Report Card" note reads as visibly different
      // from a regular note at a glance on the node itself (see the
      // isDRCNote branch below).

      // Brainstorm marker icon — Lucide's "brain" glyph, drawn with
      // currentColor like the affirmation checkmark so its purple tint
      // comes purely from CSS (.node-brainstorm-marker) rather than
      // being baked into the SVG.
      const NODE_BRAINSTORM_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M12 5A3 3 0 1 1 17.598 6.5"/><path d="M12 5A3 3 0 1 0 6.402 6.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>';

      // One icon per note (instead of a single icon plus a count badge),
      // same cell size/box as a photo thumbnail — each is independently
      // clickable/draggable, so a node with several notes reads at a
      // glance as "several notes" without needing to decode a number.
      // Past STRIP_OVERFLOW_CAP notes, same collapse-to-one-icon treatment
      // as photos: a single note icon carrying a count badge stands in
      // for the lot, and click/right-click both open the full list
      // (openNoteManageMenu) instead of one specific note.
      const notesOverflow = nodeNotes.length > STRIP_OVERFLOW_CAP;
      (notesOverflow ? nodeNotes.slice(0, 1) : nodeNotes).forEach((n, i) => {
        const noteIcon = document.createElement("span");
        noteIcon.className = "node-photo-thumb node-note-marker" +
          (isDRCNote(n) ? " node-drc-marker" : "") +
          (isBrainstormNote(n) ? " node-brainstorm-marker" : "");
        noteIcon.innerHTML = isBrainstormNote(n) ? "🧠" :
          (isDRCNote(n) ? NODE_DRC_ICON_IMG : (isPlanNote(n) ? NODE_PLAN_ICON_IMG : NODE_NOTE_ICON_SVG));
        noteIcon.draggable = true;
        noteIcon.addEventListener("dragend", endMarkerDrag);
        if (notesOverflow) {
          noteIcon.title = `${nodeNotes.length} notes — click to view the list, or drag to move them all onto another node (hold Alt to copy)`;
          noteIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "notes"));
          armMarkerTouchDrag(noteIcon, node, "notes");
          noteIcon.addEventListener("click", (e) => { e.stopPropagation(); openNoteManageMenu(node.id, e.clientX, e.clientY); });
          const badge = document.createElement("span");
          badge.className = "node-marker-count";
          badge.textContent = String(nodeNotes.length);
          noteIcon.appendChild(badge);
        } else {
          // DRC notes get a status-aware tooltip (filled-in or not)
          // instead of the plain content preview, so hovering tells you
          // at a glance whether today's report still needs filling out.
          noteIcon.title = isBrainstormNote(n) ? "Brainstorm" :
            (isDRCNote(n)
              ? (drcNoteIsFilled(n) ? "DRC — filled in" : "DRC — not filled in yet")
              : notePreviewText(n));
          noteIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "note-single", { noteIndex: i }));
          armMarkerTouchDrag(noteIcon, node, "note-single", { noteIndex: i });
          noteIcon.addEventListener("click", (e) => {
            e.stopPropagation();
            openNoteModal(node.id, i);
          });
        }
        noteIcon.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openNoteManageMenu(node.id, e.clientX, e.clientY);
        });
        strip.appendChild(noteIcon);
      });

      // Same note icon again, one per task that has notes on it — click
      // opens that task's own note editor directly (the exact same rich
      // editor as above, just scoped to the task; see openNoteModal).
      // Not draggable: unlike a node's own notes, a task's notes stay
      // with the task, not the node, so they don't make sense to drag
      // onto another node on their own.
      tasksWithNotes.forEach((t) => {
        const taskNoteIcon = document.createElement("span");
        // A task's note counts as a DRC note by the same rule as a
        // node's own notes — title exactly "DRC" (see isDRCNote) — so it
        // gets the same clipboard icon here too, not just at the node
        // level.
        const firstTaskNote = getTaskNotes(t)[0];
        const taskNoteIsDRC = isDRCNote(firstTaskNote);
        taskNoteIcon.className = "node-photo-thumb node-note-marker node-task-note-marker" + (taskNoteIsDRC ? " node-drc-marker" : "");
        taskNoteIcon.innerHTML = taskNoteIsDRC ? NODE_DRC_ICON_IMG : (isPlanNoteFor(firstTaskNote, t) ? NODE_PLAN_ICON_IMG : NODE_NOTE_ICON_SVG);
        // A task's own name already works as that note's title, so unlike
        // a node's or cell's own notes (notePreviewText), this never falls
        // back to a body-text preview — only the note's own separate
        // title, if it happens to have one of its own distinct from the
        // task name, is ever appended. A DRC note gets the same
        // filled-in-or-not status line the node-level DRC icon uses,
        // instead of that title suffix.
        if (taskNoteIsDRC) {
          const status = drcNoteIsFilled(firstTaskNote) ? "filled in" : "not filled in yet";
          taskNoteIcon.title = `Task "${t.text || "(untitled task)"}" — DRC, ${status}`;
        } else {
          const noteTitle = (firstTaskNote.title || "").trim();
          const titleSuffix = noteTitle ? ` — ${noteTitle.length > 40 ? noteTitle.slice(0, 39) + "…" : noteTitle}` : "";
          taskNoteIcon.title = `Task "${t.text || "(untitled task)"}"${titleSuffix}`;
        }
        taskNoteIcon.title += " — drag onto a node or cell to move this task's note(s) (hold Alt to copy)";
        taskNoteIcon.draggable = true;
        taskNoteIcon.addEventListener("dragstart", (e) =>
          startMarkerDrag(e, node, "task-notes", { sourceTaskId: t.id }));
        armMarkerTouchDrag(taskNoteIcon, node, "task-notes", { sourceTaskId: t.id });
        taskNoteIcon.addEventListener("dragend", endMarkerDrag);
        taskNoteIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openNoteModal(node.id, undefined, null, t.id);
        });
        taskNoteIcon.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openTasksModal(node.id);
        });
        strip.appendChild(taskNoteIcon);
      });

      // Same again, one per subtask that has its own note(s) — a subtask
      // named "DRC" shares the node's single DRC note instead (see the
      // redirect in openNoteModal), so it never shows up here on its own;
      // it already reads on the node as part of the DRC note above.
      subtasksWithNotes.forEach(({ t, s }) => {
        const subtaskNoteIcon = document.createElement("span");
        const firstSubtaskNote = getTaskNotes(s)[0];
        const subtaskNoteIsDRC = isDRCNote(firstSubtaskNote);
        subtaskNoteIcon.className = "node-photo-thumb node-note-marker node-subtask-note-marker" + (subtaskNoteIsDRC ? " node-drc-marker" : "");
        subtaskNoteIcon.innerHTML = subtaskNoteIsDRC ? NODE_DRC_ICON_IMG : (isPlanNoteFor(firstSubtaskNote, s) ? NODE_PLAN_ICON_IMG : NODE_NOTE_ICON_SVG);
        if (subtaskNoteIsDRC) {
          const status = drcNoteIsFilled(firstSubtaskNote) ? "filled in" : "not filled in yet";
          subtaskNoteIcon.title = `Subtask "${s.text || "(untitled subtask)"}" (in "${t.text || "(untitled task)"}") — DRC, ${status}`;
        } else {
          const noteTitle = (firstSubtaskNote.title || "").trim();
          const titleSuffix = noteTitle ? ` — ${noteTitle.length > 40 ? noteTitle.slice(0, 39) + "…" : noteTitle}` : "";
          subtaskNoteIcon.title = `Subtask "${s.text || "(untitled subtask)"}" (in "${t.text || "(untitled task)"}")${titleSuffix}`;
        }
        subtaskNoteIcon.title += " — drag onto a node or cell to move this subtask's note(s) (hold Alt to copy)";
        subtaskNoteIcon.draggable = true;
        subtaskNoteIcon.addEventListener("dragstart", (e) =>
          startMarkerDrag(e, node, "task-notes", { sourceTaskId: t.id, sourceSubtaskId: s.id }));
        armMarkerTouchDrag(subtaskNoteIcon, node, "task-notes", { sourceTaskId: t.id, sourceSubtaskId: s.id });
        subtaskNoteIcon.addEventListener("dragend", endMarkerDrag);
        subtaskNoteIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openNoteModal(node.id, undefined, null, t.id, undefined, false, s.id);
        });
        subtaskNoteIcon.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openTasksModal(node.id);
        });
        strip.appendChild(subtaskNoteIcon);
      });

      // v324: no per-subtask Brainstorm markers in the node strip.
      // All Brainstorm-prefixed subtasks share the node's single marker.

      // One icon per link (instead of a single icon plus a count/chooser
      // menu), same treatment as the per-note icons above — each link is
      // independently visible, clickable, draggable, and editable, so a
      // node with several links reads at a glance without a submenu. Past
      // STRIP_OVERFLOW_CAP links, collapses the same way notes/photos do:
      // one representative link icon with a count badge, opening the full
      // list (openLinksManageMenu) on click or right-click.
      const urlsOverflow = nodeUrls.length > STRIP_OVERFLOW_CAP;
      (urlsOverflow ? nodeUrls.slice(0, 1) : nodeUrls).forEach((u, i) => {
        const urlIcon = document.createElement("span");
        urlIcon.className = "node-photo-thumb node-url-marker";
        urlIcon.draggable = true;
        urlIcon.addEventListener("dragend", endMarkerDrag);
        if (urlsOverflow) {
          urlIcon.innerHTML = LINK_ICON_SVGS.link;
          urlIcon.title = `${nodeUrls.length} links — click to view the list, or drag to move them all onto another node (hold Alt to copy)`;
          urlIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "urls"));
          armMarkerTouchDrag(urlIcon, node, "urls");
          urlIcon.addEventListener("click", (e) => { e.stopPropagation(); openLinksManageMenu(node.id, e.clientX, e.clientY); });
          const badge = document.createElement("span");
          badge.className = "node-marker-count";
          badge.textContent = String(nodeUrls.length);
          urlIcon.appendChild(badge);
        } else {
          urlIcon.innerHTML = linkIconFor(u);
          const linkTitle = getLinkTitle(node, u);
          urlIcon.title = linkTitle || u;
          attachLinkCommentTooltip(urlIcon, u, () => getLinkComment(findNode(node.id) || node, u), () => getLinkTitle(findNode(node.id) || node, u));
          urlIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "url-single", { urlIndex: i }));
          armMarkerTouchDrag(urlIcon, node, "url-single", { urlIndex: i });
          urlIcon.addEventListener("click", (e) => {
            e.stopPropagation();
            openLinkSmart(u, {
              videoKey: `${node.id}|${u}`,
              get: () => getLinkComment(findNode(node.id) || node, u),
              set: (v) => setLinkComment(findNode(node.id) || node, u, v),
              getFavorite: () => getLinkFavorite(findNode(node.id) || node, u),
              setFavorite: (v) => setLinkFavorite(findNode(node.id) || node, u, v),
              getPhotos: () => getLinkPhotos(findNode(node.id) || node, u),
              addPhoto: (dataUrl) => addLinkPhoto(findNode(node.id) || node, u, dataUrl),
              removePhoto: (id) => removeLinkPhoto(findNode(node.id) || node, u, id),
            });
          });
        }
        urlIcon.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (urlsOverflow) openLinksManageMenu(node.id, e.clientX, e.clientY);
          else openUrlSingleManageMenu(node.id, i, e.clientX, e.clientY);
        });
        strip.appendChild(urlIcon);
      });

      if (affirmationWins) {
        const affIcon = document.createElement("span");
        affIcon.className = "node-photo-thumb node-affirmation-marker";
        affIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5L19.5 7"/></svg>';
        affIcon.title = `Affirmation game — ${affirmationWins} round${affirmationWins === 1 ? "" : "s"} completed — click to play; drag to move (hold Alt to copy)`;
        affIcon.draggable = true;
        affIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "affirmation"));
        armMarkerTouchDrag(affIcon, node, "affirmation");
        affIcon.addEventListener("dragend", endMarkerDrag);
        affIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openAffirmationGame(node.id);
        });
        if (affirmationWins > 1) {
          const affCount = document.createElement("span");
          affCount.className = "node-marker-count";
          affCount.textContent = String(affirmationWins);
          affIcon.appendChild(affCount);
        }
        strip.appendChild(affIcon);
      }

      for (let i = 0; i < shownCount; i++) {
        const thumb = document.createElement("span");
        thumb.className = "node-photo-thumb";
        // Use the small pre-cropped stand-in (see getMarkerThumb) instead
        // of painting the full-resolution photo into this tiny box — keeps
        // the canvas cheap to composite no matter how many/how large the
        // attached photos are. Falls back to the full image for the one
        // frame before its thumbnail has been generated.
        const fullSrc = nodeImages[i];
        const cachedThumb = getMarkerThumb(fullSrc, () => {
          const liveThumb = nodesLayer.querySelector(`.node[data-id="${node.id}"] .node-photo-thumb[data-src-index="${i}"]`);
          if (liveThumb) liveThumb.style.backgroundImage = `url("${nodeThumbCache.get(fullSrc)}")`;
        });
        thumb.dataset.srcIndex = String(i);
        thumb.style.backgroundImage = `url("${cachedThumb || fullSrc}")`;
        thumb.draggable = true;
        thumb.addEventListener("dragend", endMarkerDrag);
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          openPhotoModal(node.id, i);
        });
        if (overflow) {
          // The one cell stands in for the whole collection — a count
          // badge (photos are the one "how many things" marker that
          // still uses a number, since a wall of tiny individual
          // thumbnails past a handful gets unreadable) instead of a wall
          // of individual thumbnails, and dragging/clicking it acts on
          // all the photos together rather than just this one.
          thumb.title = `${nodeImages.length} photos — click to view, or drag to move them all onto another node (hold Alt to copy)`;
          thumb.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photos"));
          armMarkerTouchDrag(thumb, node, "photos");
          const badge = document.createElement("span");
          badge.className = "node-marker-count";
          badge.textContent = String(nodeImages.length);
          thumb.appendChild(badge);
        } else {
          thumb.title = "Click to view photo — drag onto another node to move it there (hold Alt to copy)";
          thumb.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photo", { photoIndex: i }));
          armMarkerTouchDrag(thumb, node, "photo", { photoIndex: i });
          // Small dot marking that this specific photo has a comment
          // attached (see photoComments / photo-modal-comment-row) — only
          // meaningful here, one thumb per actual photo; the single
          // overflow cover thumbnail above stands for the whole pile and
          // already carries its own count badge, so it skips this.
          const comment = getPhotoComment(node, nodeImageIds[i]);
          if (comment) {
            thumb.classList.add("node-photo-thumb-has-comment");
            thumb.title += " — has a comment";
          }
        }
        strip.appendChild(thumb);
      }

      if (timePlayed) {
        const tbadge = document.createElement("span");
        tbadge.className = "node-photo-thumb node-timer-badge";
        tbadge.title = `${formatTimePlayed(timePlayed)} logged — click to add more; drag to move (hold Alt to copy)`;
        tbadge.draggable = true;
        tbadge.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "timer"));
        armMarkerTouchDrag(tbadge, node, "timer");
        tbadge.addEventListener("dragend", endMarkerDrag);
        tbadge.addEventListener("mousedown", (e) => { e.stopPropagation(); });
        tbadge.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
        tbadge.addEventListener("click", (e) => { e.stopPropagation(); openTimerModal(node.id); });
        const tlabel = document.createElement("span");
        tlabel.textContent = formatTimePlayed(timePlayed);
        tbadge.appendChild(tlabel);
        strip.appendChild(tbadge);
      }

      if (nodeHasBrainstormMarker) {
        // v324: the one shared pink Brainstorm marker for this node.
        const bIcon = document.createElement("span");
        bIcon.className = "node-photo-thumb node-brainstorm-marker";
        bIcon.textContent = "🧠";
        const ownsBrainstorm = hasBrainstormContent(node);
        bIcon.title = ownsBrainstorm
          ? "Brainstorm — click to keep writing; drag onto a node or cell to move (hold Alt to copy)."
          : "Brainstorm — click to keep writing.";
        if (ownsBrainstorm) {
          bIcon.draggable = true;
          bIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "brainstorm"));
          armMarkerTouchDrag(bIcon, node, "brainstorm");
          bIcon.addEventListener("dragend", endMarkerDrag);
        }
        bIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openBrainstormModal(node.id);
        });
        strip.appendChild(bIcon);
      }

      div.appendChild(strip);
    }

    // v418: Node Tasks use the same score badge as table/calendar cells.
    // Score controls both color and size; click opens Tasks and drag keeps
    // the old task-move behavior from the removed progress bar.
    if (getNodeTasks(node).length && node.id !== state.editingId) {
      const points = Math.max(0, Number(taskProg.done) || 0);
      const badge = document.createElement("span");
      badge.className = taskBadgeClass(points, "node-task-score-badge");
      badge.textContent = String(points);
      badge.title = `${points} progress points${taskProg.total ? ` / ${taskProg.total} total` : ""} — click to open Tasks; drag onto another node to move the tasks there (hold Alt to copy)`;
      badge.setAttribute("role", "button");
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("aria-label", `Open Tasks — ${points} progress points`);
      const openTasks = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTasksModal(node.id);
      };
      badge.addEventListener("mousedown", (e) => e.stopPropagation());
      badge.addEventListener("pointerdown", (e) => e.stopPropagation());
      badge.addEventListener("click", openTasks);
      badge.addEventListener("dblclick", (e) => e.stopPropagation());
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") openTasks(e);
      });
      badge.draggable = true;
      badge.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "tasks"));
      armMarkerTouchDrag(badge, node, "tasks");
      badge.addEventListener("dragend", endMarkerDrag);
      div.appendChild(badge);
    }

    function beginNodeDrag(e) {
      e.stopPropagation();
      if (!requireSignIn()) return;
      if (node.id === state.editingId) return;
      // A second (or third) finger landing on the node — e.g. the start of
      // a pinch that happens to begin over a node — shouldn't kick off a
      // node drag; only the first touch/click does.
      if (e.pointerType && activePointers.size > 1) return;
      dragCandidate = {
        id: node.id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startOx: node.ox || 0,
        startOy: node.oy || 0,
        // Absolute (layout-space) Y at the moment the drag starts, tracked
        // independently of node._y so it stays correct even after a sibling
        // reorder shifts the node into a new slot mid-drag.
        startAbsY: node._y + (node.oy || 0),
        moved: false,
        dropTargetId: null,
        // How much of the current drag delta is already "baked into" the
        // dragged nodes' left/top (as opposed to sitting in a live CSS
        // transform — see the mousemove handler). Starts at zero since
        // left/top haven't moved yet.
        bakedDx: 0,
        bakedDy: 0,
        // Snapshot every descendant's current offset so the whole branch can
        // be translated by the same delta as the node being dragged.
        descendants: collectDescendants(node).map(c => ({
          id: c.id,
          startOx: c.ox || 0,
          startOy: c.oy || 0
        }))
      };
    }
    div.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      beginNodeDrag(e);
    });
    div.addEventListener("pointerdown", (e) => {
      // Mouse is already handled by the mousedown listener above. Pen
      // behaves like mouse — a drag can start right away. Touch instead
      // only *arms* here; the actual drag only begins once the hold timer
      // in this arm fires (see TOUCH_DRAG_HOLD_MS above), so a quick swipe
      // starting on a node pans the canvas instead of yanking the node.
      if (e.pointerType === "mouse") return;
      if (e.pointerType !== "touch") { beginNodeDrag(e); return; }
      if (node.id === state.editingId) return;
      if (activePointers.size > 1) return;
      clearTouchDragArm();
      const pointerId = e.pointerId, clientX = e.clientX, clientY = e.clientY;
      touchDragArm = {
        pointerId,
        startClientX: clientX,
        startClientY: clientY,
        timer: setTimeout(() => {
          if (!touchDragArm || touchDragArm.pointerId !== pointerId) return;
          touchDragArm = null;
          beginNodeDrag({ pointerType: "touch", pointerId, clientX, clientY, stopPropagation() {} });
        }, TOUCH_DRAG_HOLD_MS)
      };
    });
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (suppressNextNodeClick) { suppressNextNodeClick = false; return; }
      if (state.linkFromId) { completeLinkTo(node.id); return; }
      selectNode(node.id);
    });
    div.addEventListener("dblclick", (e) => { e.stopPropagation(); startEdit(node.id); });
    div.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); selectNode(node.id); openContextMenu(e.clientX, e.clientY, node); });

    // Accept a task-ring / progress-bar / photo-strip drag started on some
    // other node — or a photo/note/link/task dragged up from one of THIS
    // node's own cells (sourceR/sourceC set), which is a legitimate move
    // even though sourceNodeId matches this node's id. Only a whole-node
    // marker (no source cell) dropped back on its own node is a no-op —
    // that case is excluded below.
    div.addEventListener("dragover", (e) => {
      if (!markerDragAvailable(e)) return;
      const drag = markerDragState;
      if (drag && drag.sourceNodeId === node.id && drag.sourceR == null && drag.sourceC == null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      div.classList.add("marker-drop-target");
    });
    div.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && div.contains(e.relatedTarget)) return;
      div.classList.remove("marker-drop-target");
    });
    div.addEventListener("drop", (e) => {
      const drag = readMarkerDragPayload(e);
      if (!drag) return;
      if (drag.sourceNodeId === node.id && drag.sourceR == null && drag.sourceC == null) return;
      e.preventDefault();
      e.stopPropagation();
      div.classList.remove("marker-drop-target");
      completeMarkerDrop(node.id, e.altKey);
    });

    div.addEventListener("blur", () => { if (state.editingId === node.id) commitEdit(div); });
    div.addEventListener("keydown", (e) => nodeKeydown(e, node, div));

    nodesLayer.appendChild(div);

    if (node.id === state.editingId) {
      // Focus synchronously, not via requestAnimationFrame — the div is
      // already attached to the DOM (appendChild just above), and on
      // touch devices a deferred focus() falls outside the tap's "user
      // activation" window, so the on-screen keyboard doesn't reopen for
      // the new node (e.g. right after tapping the add-child/add-sibling
      // buttons) even though focus visibly lands there.
      div.focus();
      placeCaretAtEnd(div);
    }
  }

  // Reads a contenteditable node's text back out while preserving line
  // breaks the browser may represent as <br> or nested <div>s.
  function getEditableText(div) {
    let text = "";
    div.childNodes.forEach((node) => {
      if (node.nodeType === 3) {
        text += node.textContent;
      } else if (node.nodeName === "BR") {
        text += "\n";
      } else if (node.nodeType === 1 && (node.classList.contains("node-collapse") || node.classList.contains("node-badge") || node.classList.contains("node-photo-strip") || node.classList.contains("node-task-score-badge"))) {
        // These are UI overlays (collapse toggle, child-count badge, note
        // icon, photo thumbnail) rendered inside the node box, not part of
        // the typed text — skip them or their glyphs (e.g. "–") get
        // appended to the text.
      } else if (node.nodeName === "DIV" || node.nodeName === "P") {
        if (text.length && !text.endsWith("\n")) text += "\n";
        text += node.textContent;
      } else {
        text += node.textContent;
      }
    });
    return text.trim();
  }

  // Grows (or shrinks) the node box live as the person types, keeping it
  // centered on its layout position, so text never overflows its box.
  function autosizeEditingBox(div, node) {
    const text = getEditableText(div);
    const box = computeNodeBox(Object.assign({}, node, { text }));
    node._w = box.w;
    node._h = box.h;
    const cy = state.originY + node._y + (node.oy || 0);
    div.style.width = box.w + "px";
    div.style.height = box.h + "px";
    div.style.left = (state.originX + nodeLeftX(node)) + "px";
    div.style.top = (cy - box.h / 2) + "px";
    refreshConnectorsFor(node);
  }

  function countAll(node) {
    let n = 0;
    (function walk(x) { for (const c of x.children || []) { n++; walk(c); } })(node);
    return n;
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // When the caret is moved by hand (via a Range/Selection API call rather
  // than an actual key/mouse event the browser itself is handling), the
  // browser's own "keep the caret on screen" auto-scroll never kicks in —
  // that only fires for caret movement it drove itself. noteHandleEnter
  // below builds new lines and repositions the caret this way, which is
  // why hitting Enter at the bottom of a long note used to leave the new
  // line (and the caret on it) scrolled out of view. Call this right after
  // any such programmatic caret move to bring it back into view by hand.
  function scrollCaretIntoView(el) {
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

