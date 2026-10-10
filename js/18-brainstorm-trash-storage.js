/* Branchline — js/18-brainstorm-trash-storage.js
   Part 18 of 19 of the former single-file app.js. Contents: node brainstorm scratchpad, affirmation lines manager, trash modal, storage modal, photo tag browser.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- node brainstorm scratchpad ---------------- */
  // A per-node (or per-cell) free-typed note scratchpad — reached from
  // the same right-click menu as the Timer and Affirmation game, but far
  // simpler than either: a contenteditable scratchpad (host.brainstorm =
  // {text, html}) that autosaves as you type, no quote to match and
  // nothing to start or stop. Every non-empty line written is worth 1
  // point toward the task score (see nodeTaskProgress/brainstormPoints
  // above) and shows as a small brain badge on the node/cell itself
  // (see renderNode). Uses the same host-based {nodeId, r, c} target
  // pattern as the timer above (see resolveHost).
  //
  // `text` is the plain-text version (one line per paragraph, via
  // .innerText) that brainstormLineCount/brainstormPoints score against;
  // `html` is the same content with each line's own color baked in (see
  // brainstormAutoColorLines below), reusing the exact same per-paragraph
  // cycling palette as the node note editor (see noteColorForOrdinal) so
  // separate lines are just as easy to tell apart here as they are there.
  const brainstormModal = $("#brainstorm-modal");
  const brainstormNodeLabel = $("#brainstorm-node-label");
  const brainstormTextarea = $("#brainstorm-textarea");
  const brainstormProgressLabel = $("#brainstorm-progress-label");
  const brainstormClearBtn = $("#brainstorm-clear-btn");
  const brainstormCard = $(".brainstorm-modal-card");
  const brainstormResizeHandle = $("#brainstorm-resize-handle");
  // Target can be a node, table cell, task, or subtask. taskId/subtaskId are
  // optional, so all older node/cell callers keep working unchanged.
  let brainstormEditingId = null; // {nodeId, r, c, taskId, subtaskId}
  let brainstormSaveTimer = null;

  function resolveBrainstormTarget(target) {
    if (!target) return null;
    const base = resolveHost(target.nodeId, target.r, target.c);
    if (!base) return null;
    // v324: Brainstorm is deliberately node/cell scoped. Task/subtask callers
    // keep the same API, but resolve to the owning node/cell so every
    // Brainstorm entry point opens the same scratchpad.
    return base;
  }

  function brainstormTargetLabel(target) {
    if (!target) return "";
    const node = findNode(target.nodeId);
    if (!node) return "";
    const base = resolveHost(target.nodeId, target.r, target.c);
    if (!base) return node.text || "(untitled)";
    if (target.taskId) {
      const task = getNodeTasks(base).find(x => x.id === target.taskId);
      if (task && target.subtaskId) {
        const sub = getTaskSubtasks(task).find(x => x.id === target.subtaskId);
        if (sub) return sub.text || "(untitled subtask)";
      }
      if (task) return task.text || "(untitled task)";
    }
    if (target.r != null && node.table && node.table.cells[target.r]) {
      return node.table.cells[target.r][target.c] || `Cell (row ${target.r + 1}, col ${target.c + 1})`;
    }
    return node.text || "(untitled)";
  }
  let brainstormIsResizing = false;

  // Same custom drag-to-resize grip as the note editor (see
  // setupNoteResize) — kept as its own copy rather than a shared function
  // since the two modals' card/handle elements differ, but the behavior
  // (and min/max bounds) match exactly for a consistent feel.
  (function setupBrainstormResize() {
    let startX, startY, startW, startH;
    function onMove(e) {
      const dw = e.clientX - startX;
      const dh = e.clientY - startY;
      const maxW = window.innerWidth * 0.96;
      const maxH = window.innerHeight * 0.92;
      brainstormCard.style.width = clamp(startW + dw, 420, maxW) + "px";
      brainstormCard.style.height = clamp(startH + dh, 320, maxH) + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setTimeout(() => { brainstormIsResizing = false; }, 0);
    }
    function onResizeStart(e) {
      e.preventDefault();
      e.stopPropagation();
      brainstormIsResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = brainstormCard.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
    brainstormResizeHandle.addEventListener("mousedown", onResizeStart);
    brainstormResizeHandle.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      onResizeStart(e);
    });
  })();

  // Gives every plain line its own color, cycling through the same
  // palette as the note editor's numbered-list lines (see
  // noteAutoColorParagraphs, which this mirrors exactly) — only touches
  // lines that don't have a color yet, so existing lines keep the color
  // they were given rather than shifting as new ones are added below
  // them. Numbered/checklist lines keep their own ordinal-based color
  // (see brainstormSetOrderedLineColor) and image lines have no text to
  // color, so both are skipped here instead of getting a paragraph color
  // too.
  function brainstormAutoColorLines(container = brainstormTextarea) {
    let idx = 0;
    Array.from(container.children).forEach(el => {
      const text = el.textContent || "";
      if (/^(\d+\.\s|[☐☑])\s?/.test(text)) return;
      if (el.querySelector && el.querySelector("img")) return;
      if (el.classList && el.classList.contains("note-mood")) return; // the Mood To Day block has its own colors
      if (!el.style.color) el.style.color = noteColorForOrdinal(idx + 1);
      idx++;
    });
  }

  // v334: legacy Brainstorm cards are retired; remove only runtime
  // decoration from old content and leave the user's text untouched.
  function refreshBrainstormCards() {
    brainstormTextarea.classList.remove("drc-cards");
    Array.from(brainstormTextarea.children).forEach((el) => drcSetCardState(el, null));
  }

  // Same recolor ring as the note editor's cards (see the note editor's
  // bindDRCCardColorDot call for the DRC-note version of this comment).
  bindDRCCardColorDot(
    brainstormTextarea,
    () => brainstormTextarea.getAttribute("contenteditable") !== "false" && brainstormTextarea.classList.contains("drc-cards"),
    (head, color) => {
      brainstormPushUndo();
      head.setAttribute("data-card-color", color);
      refreshBrainstormCards();
      scheduleBrainstormAutosave();
    }
  );

  // ---- "😊 Mood To Day" block, brainstorm version ----
  // Same block and behavior as the note editor's (see noteInsertMoodBlock/
  // noteBuildMoodBlock above); duplicated against this editor's own
  // undo/current-line/autosave helpers rather than shared, since the two
  // editors don't share a DOM root.
  function brainstormInsertMoodBlock() {
    brainstormPushUndo();
    const sel = window.getSelection();
    let line = (sel.rangeCount && brainstormTextarea.contains(sel.anchorNode)) ? brainstormCurrentLine() : null;
    if (line && line.nodeType !== 1) line = null;
    const isBlank = (el) => !(el.textContent || "").replace(/[\u200b\u00a0]/g, "").trim() && !el.querySelector("img") && !el.hasAttribute("data-mood-block");
    const block = noteBuildMoodBlock();
    if (line && line.parentNode === brainstormTextarea) {
      if (isBlank(line)) line.replaceWith(block);
      else line.after(block);
    } else {
      brainstormTextarea.appendChild(block);
    }
    let tail = block.nextElementSibling;
    if (!tail || !isBlank(tail)) {
      tail = document.createElement("div");
      tail.appendChild(document.createElement("br"));
      block.after(tail);
    }
    brainstormTextarea.focus();
    const range = document.createRange();
    range.selectNodeContents(tail);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    refreshBrainstormCards();
    brainstormAutoColorLines();
    scheduleBrainstormAutosave();
  }
  $("#brainstorm-tool-mood").addEventListener("mousedown", (e) => {
    e.preventDefault();
    brainstormInsertMoodBlock();
  });
  brainstormTextarea.addEventListener("click", (e) => {
    const face = e.target && e.target.closest ? e.target.closest(".note-mood-face") : null;
    if (!face || !brainstormTextarea.contains(face)) return;
    if (brainstormTextarea.getAttribute("contenteditable") === "false") return;
    const block = face.closest(".note-mood");
    if (!block) return;
    brainstormPushUndo();
    const wasSelected = face.classList.contains("selected");
    block.querySelectorAll(".note-mood-face").forEach((f) => {
      f.classList.remove("selected");
      f.setAttribute("aria-pressed", "false");
    });
    if (wasSelected) {
      block.removeAttribute("data-mood");
    } else {
      face.classList.add("selected");
      face.setAttribute("aria-pressed", "true");
      block.setAttribute("data-mood", face.dataset.moodValue);
    }
    scheduleBrainstormAutosave();
  });

  // Colors a line based on the number in its own "N. " prefix, or clears
  // the color if the line isn't numbered — same idea as the note
  // editor's noteSetOrderedLineColor.
  function brainstormSetOrderedLineColor(el) {
    if (!el) return;
    const match = (el.textContent || "").match(/^(\d+)\.\s/);
    el.style.color = match ? noteColorForOrdinal(parseInt(match[1], 10)) : "";
  }

  // Re-applies auto ordinal colors across every line, for a brainstorm
  // loaded from storage that has numbered prefixes but no inline color
  // saved yet.
  function brainstormSyncAllOrderedColors(container = brainstormTextarea) {
    Array.from(container.children).forEach(el => {
      if (/^\d+\.\s/.test(el.textContent || "") && !el.style.color) {
        brainstormSetOrderedLineColor(el);
      }
    });
  }

  // Keeps a line's strikethrough in sync with its checklist glyph — same
  // idea as the note editor's noteSyncLineChecked.
  function brainstormSyncLineChecked(el) {
    if (!el) return;
    el.classList.toggle("note-line-checked", /^☑(\s|$)/.test(el.textContent || ""));
  }

  function brainstormSyncAllCheckedLines(container = brainstormTextarea) {
    brainstormSyncLineChecked(container);
    Array.from(container.children).forEach(brainstormSyncLineChecked);
  }

  // Renders host.brainstorm.html if it's already been colored, or builds
  // a fresh one-<div>-per-line version from the plain-text field (same
  // conversion the note editor uses for old plain-text notes — see
  // noteHtmlFromRaw) for a scratchpad that predates this coloring, or was
  // never opened in a browser session yet.
  function getBrainstormHtml(host) {
    const b = getNodeBrainstorm(host);
    if (b && b.html) return b.html;
    return noteHtmlFromRaw(getBrainstormText(host));
  }

  // v421: node and cell are independent Brainstorm content hosts. The
  // node's one-Brainstorm rule still absorbs legacy task/subtask Brainstorms
  // belonging to that node, while every table/calendar cell owns its own
  // single Brainstorm and is never migrated into the parent node.
  function nodeBrainstormOwner(node) {
    if (!node) return null;
    const hasContent = (host) => {
      const b = host && getNodeBrainstorm(host);
      return !!(b && ((b.text || "").trim() || (b.html || "").trim()));
    };
    if (hasContent(node)) return node;
    const tasks = getNodeTasks(node);
    for (const task of tasks) {
      if (hasContent(task)) return task;
      for (const subtask of getTaskSubtasks(task)) {
        if (hasContent(subtask)) return subtask;
      }
    }
    return null;
  }

  function openBrainstormModal(nodeId, r, c, taskId, subtaskId) {
    // v421: every table/calendar cell is a mini-node content host and owns
    // exactly one Brainstorm of its own. A Brainstorm-prefixed task/subtask
    // inside that cell opens this same shared cell Brainstorm, mirroring the
    // one-Brainstorm-per-node rule for tasks/subtasks on a normal node.
    const node = findNode(nodeId);
    if (!node) return;

    if (r != null && c != null && node.table) {
      const host = getCellAttach(node, r, c);
      const notes = getCellNotes(host).slice();
      let index = notes.findIndex(isBrainstormNote);
      if (index < 0) {
        const legacyHtml = hasBrainstormContent(host) ? getBrainstormHtml(host) : "";
        pushUndo();
        notes.push({
          id: uid(),
          title: specialNoteAutoTitle(node, { r, c }, "Brainstorm"),
          html: legacyHtml,
          kind: "brainstorm",
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        host.notes = notes;
        host.note = null;
        syncBrainstormMirrorFromNotes(host);

        // v541: Calendar is a live view of Calendar Child cells. The Brainstorm
        // marker already exists in canonical cell data at this point, so update
        // the open summary Calendar immediately instead of waiting for a later
        // full render / Drive persistence cycle.
        if (calendarModal && !calendarModal.classList.contains("hidden")) {
          renderCalendar();
        }
        // Also paint the canonical Calendar Child cell immediately. This is
        // intentionally before persist(): UI synchronization must never wait
        // for IndexedDB or Drive.
        refreshNodeOrRenderAll(node.id);
        persist();
        index = notes.length - 1;
      }
      openNoteModal(nodeId, index, null, null, { r, c });
      return;
    }

    // Normal nodes keep the existing single Brainstorm shared by the node.
    // v359: Brainstorm no longer owns an editor/toolbar. Migrate legacy
    // content once, then open the ordinary Note editor.
    const owner = nodeBrainstormOwner(node);
    if (owner && owner !== node && !hasBrainstormContent(node)) {
      node.brainstorm = JSON.parse(JSON.stringify(getNodeBrainstorm(owner) || { text: "", html: "" }));
    }
    const notes = getNodeNotes(node).slice();
    let index = notes.findIndex(isBrainstormNote);
    if (index < 0) {
      const legacyHtml = hasBrainstormContent(node) ? getBrainstormHtml(node) : "";
      pushUndo();
      notes.push({ id: uid(), title: specialNoteAutoTitle(node, null, "Brainstorm"), html: legacyHtml, kind: "brainstorm", createdAt: Date.now(), updatedAt: Date.now() });
      node.notes = notes;
      node.note = "";
      syncBrainstormMirrorFromNotes(node);
      persist();
      index = notes.length - 1;
    }
    openNoteModal(nodeId, index);
  }

  function closeBrainstormModal() {
    const target = brainstormEditingId;
    flushBrainstormAutosave();
    brainstormEditingId = null;
    zoomModalClose(brainstormModal);

    if (target && target.subtaskId) {
      if (!tasksModal.classList.contains("hidden")) renderTasksModal();
      if (calDayModalDate) {
        renderCalDayModal();
        renderCalendar();
      }
      refreshNodeOrRenderAll(target.nodeId);
    } else {
      renderAll();
    }
  }

  function renderBrainstormModal() {
    const t = brainstormEditingId;
    const host = t ? resolveBrainstormTarget(t) : null;
    if (!host) { closeBrainstormModal(); return; }
    brainstormNodeLabel.textContent = brainstormTargetLabel(t);
    brainstormTextarea.innerHTML = getBrainstormHtml(host);
    brainstormSyncAllCheckedLines();
    brainstormSyncAllOrderedColors();
    brainstormAutoColorLines();
    refreshBrainstormCards();
    brainstormResetUndoHistory();
    renderBrainstormProgress(host);
  }

  function renderBrainstormProgress(host) {
    const lines = brainstormLineCount(host);
    brainstormProgressLabel.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
  }

  // Debounced autosave: fires a short beat after the user stops typing,
  // so the scratchpad saves itself without needing an explicit Save
  // click — same 500ms pattern as the node/task note editor (see
  // scheduleNoteAutosave).
  function scheduleBrainstormAutosave() {
    const t = brainstormEditingId;
    if (!t) return;
    const host = resolveBrainstormTarget(t);
    if (!host) return;
    brainstormAutoColorLines();
    if (!host.brainstorm) host.brainstorm = { text: "", html: "" };
    host.brainstorm.text = brainstormTextarea.innerText;
    host.brainstorm.html = brainstormTextarea.innerHTML;
    unsavedEdits = true;
    renderBrainstormProgress(host);
    updateBrainstormLiveUI(t);

    // v509: Brainstorm mutates the canonical map before its normal debounce,
    // so protect every keystroke immediately just like the global persist()
    // path. Drive/full persistence remains debounced for performance.
    if (state.current) {
      state.current.updatedAt = nextUpdatedAt(state.current);
      state.current.view = { scale: state.scale, tx: state.tx, ty: state.ty };
      DB.put(state.current).catch((e) => console.error("Immediate Brainstorm local save failed", e));
    }

    clearTimeout(brainstormSaveTimer);
    brainstormSaveTimer = setTimeout(() => { pushUndo(); persist(); }, 500);
  }

  function flushBrainstormAutosave() {
    if (!brainstormSaveTimer) return;
    clearTimeout(brainstormSaveTimer);
    brainstormSaveTimer = null;
    persist();
  }

  // Cheap live update — pushes the new line/point count straight into
  // the node's (or table cell's) badge on the canvas without a full
  // renderAll(), same idea as updateNodeTimerLiveUI above.
  function updateBrainstormLiveUI(target) {
    if (!target) return;
    const host = resolveBrainstormTarget(target);
    if (!host) return;
    const pts = brainstormPoints(host);
    const lineCount = brainstormLineCount(host);

    // Task/subtask Brainstorm is rendered inside the Tasks/Calendar modal,
    // not as a marker on the canvas node itself.
    if (target.subtaskId) {
      document.querySelectorAll(
        `.subtask-row[data-task-id="${target.taskId}"][data-subtask-id="${target.subtaskId}"] .subtask-brainstorm-icon`
      ).forEach((badge) => {
        badge.title = pts
          ? `Brainstorm — ${pts} point${pts === 1 ? "" : "s"} (${lineCount} lines)`
          : "Brainstorm — tap to start";
      });
      return;
    }

    const badge = target.r == null
      ? nodesLayer.querySelector(`.node[data-id="${target.nodeId}"] .node-brainstorm-marker`)
      : nodesLayer.querySelector(`.node[data-id="${target.nodeId}"] .node-table-cell[data-r="${target.r}"][data-c="${target.c}"] .node-table-cell-brainstorm`);
    if (badge) {
      badge.title = `Brainstorm — ${pts} point${pts === 1 ? "" : "s"} (${lineCount} lines). Click to keep writing.`;
    } else if (pts > 0 && target.nodeId !== state.editingId) {
      renderAll();
    }
  }

  // ---- Rich-text toolbar (undo/redo, bold, AA, numbered list, checklist,
  // strikethrough, image, color, symbol) — same exact behavior as the
  // node/task note editor's toolbar above, just bound to
  // brainstormTextarea instead of noteTextarea. Kept as its own copy
  // (rather than sharing the note editor's functions directly) since the
  // two editors' DOM elements differ and the note editor's own toolbar
  // listeners are attached via a couple of `document.querySelectorAll`
  // calls that would otherwise also pick up these buttons.
  const BRAINSTORM_UNDO_LIMIT = 100;
  let brainstormUndoStack = [];
  let brainstormRedoStack = [];
  let brainstormLastPushAt = 0;
  const brainstormUndoBtn = $("#brainstorm-tool-undo");
  const brainstormRedoBtn = $("#brainstorm-tool-redo");

  function updateBrainstormUndoButtons() {
    if (brainstormUndoBtn) brainstormUndoBtn.disabled = !brainstormUndoStack.length;
    if (brainstormRedoBtn) brainstormRedoBtn.disabled = !brainstormRedoStack.length;
  }

  // Records the editor's current state onto the undo stack. Call this
  // immediately BEFORE a mutation, not after — same contract as the note
  // editor's notePushUndo. Same fix applied here as notePushUndo/pushUndo
  // above: brainstorm pads can embed pasted images too, so this reuses
  // pushBoundedSnapshot instead of a bare count-capped push.
  function brainstormPushUndo() {
    pushBoundedSnapshot(brainstormUndoStack, brainstormTextarea.innerHTML, BRAINSTORM_UNDO_LIMIT);
    brainstormRedoStack = [];
    brainstormLastPushAt = Date.now();
    updateBrainstormUndoButtons();
  }

  // Clears the local undo history — called whenever a different
  // node/cell's brainstorm is loaded into the shared editor (see
  // renderBrainstormModal), so undo never reaches back into a scratchpad
  // that's no longer open.
  function brainstormResetUndoHistory() {
    brainstormUndoStack = [];
    brainstormRedoStack = [];
    brainstormLastPushAt = 0;
    updateBrainstormUndoButtons();
    brainstormUppercasePending = false;
    updateBrainstormToolActiveStates();
  }

  // --- Bold / AA "pressed while it applies to what you type next" state,
  // same idea as the note editor's noteUppercasePending above. ---
  let brainstormUppercasePending = false;
  let brainstormUppercaseInserting = false; // re-entrancy guard for the hook below

  function updateBrainstormToolActiveStates() {
    let boldOn = false;
    try { boldOn = document.queryCommandState("bold"); } catch (_) { /* ignore */ }
    $("#brainstorm-tool-bold").classList.toggle("active", !!boldOn);
    const brainstormBoldUpperBtn = $("#brainstorm-tool-bold-upper");
    if (brainstormBoldUpperBtn) {
      const bbOn = brainstormUppercasePending && !!boldOn;
      brainstormBoldUpperBtn.classList.toggle("active", bbOn);
      brainstormBoldUpperBtn.setAttribute("aria-pressed", String(bbOn));
    }
  }

  function brainstormRestoreSnapshot(html) {
    brainstormTextarea.innerHTML = html;
    brainstormSyncAllCheckedLines();
    brainstormSyncAllOrderedColors();
    brainstormAutoColorLines();
    refreshBrainstormCards();
    placeCaretAtEnd(brainstormTextarea);
    scheduleBrainstormAutosave();
    updateBrainstormUndoButtons();
  }

  function brainstormUndo() {
    if (!brainstormUndoStack.length) return;
    pushBoundedSnapshot(brainstormRedoStack, brainstormTextarea.innerHTML, BRAINSTORM_UNDO_LIMIT);
    brainstormRestoreSnapshot(brainstormUndoStack.pop());
  }

  function brainstormRedo() {
    if (!brainstormRedoStack.length) return;
    pushBoundedSnapshot(brainstormUndoStack, brainstormTextarea.innerHTML, BRAINSTORM_UNDO_LIMIT);
    brainstormRestoreSnapshot(brainstormRedoStack.pop());
  }

  function brainstormCurrentLine(container = brainstormTextarea) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType === 3) {
      node = node.parentNode;
    } else if (node.childNodes.length) {
      const idx = Math.min(Math.max(range.startOffset - 1, 0), node.childNodes.length - 1);
      node = node.childNodes[idx];
    }
    while (node && node !== container && node.parentNode !== container) {
      node = node.parentNode;
    }
    return node === container ? null : node;
  }

  function brainstormCaretIsAtLineStart(lineDiv) {
    if (!lineDiv) return false;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    const preRange = document.createRange();
    preRange.selectNodeContents(lineDiv);
    try {
      preRange.setEnd(range.startContainer, range.startOffset);
    } catch (err) {
      return false;
    }
    return preRange.toString().length === 0;
  }

  function brainstormSelectLine(lineDiv) {
    const target = lineDiv || brainstormTextarea;
    const r = document.createRange();
    r.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function brainstormToggleLinePrefix(prefixRegex, makePrefix) {
    brainstormTextarea.focus();
    brainstormPushUndo();
    const lineDiv = brainstormCurrentLine();
    const el = lineDiv || brainstormTextarea;
    const text = el.textContent;
    const match = text.match(prefixRegex);
    el.textContent = match ? text.slice(match[0].length) : makePrefix() + text;
    brainstormSyncLineChecked(el);
    placeCaretAtEnd(el);
    scheduleBrainstormAutosave();
  }

  function brainstormToggleOrderedList() {
    brainstormTextarea.focus();
    brainstormPushUndo();
    const lineDiv = brainstormCurrentLine();
    const el = lineDiv || brainstormTextarea;
    const text = el.textContent;
    const match = text.match(/^\d+\.\s+/);
    if (match) {
      el.textContent = text.slice(match[0].length);
      el.style.color = "";
    } else {
      el.textContent = "1. " + text;
      brainstormSetOrderedLineColor(el);
    }
    brainstormSyncLineChecked(el);
    placeCaretAtEnd(el);
    scheduleBrainstormAutosave();
  }

  function brainstormApplyForeColor(color) {
    brainstormTextarea.focus();
    brainstormPushUndo();
    const sel = window.getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      brainstormSelectLine(brainstormCurrentLine());
    }
    document.execCommand("foreColor", false, color);
    scheduleBrainstormAutosave();
  }

  function brainstormApplyStrikethrough() {
    brainstormTextarea.focus();
    brainstormPushUndo();
    const sel = window.getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      brainstormSelectLine(brainstormCurrentLine());
    }
    document.execCommand("strikeThrough");
    scheduleBrainstormAutosave();
  }

  function brainstormApplyBold() {
    brainstormTextarea.focus();
    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    if (collapsed) {
      document.execCommand("bold");
    } else {
      brainstormPushUndo();
      document.execCommand("bold");
      scheduleBrainstormAutosave();
    }
    updateBrainstormToolActiveStates();
  }

  function brainstormApplyUppercase() {
    brainstormTextarea.focus();
    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    if (collapsed) {
      brainstormUppercasePending = !brainstormUppercasePending;
      updateBrainstormToolActiveStates();
      return;
    }
    brainstormPushUndo();
    const text = sel.toString();
    if (!text) return;
    document.execCommand("insertText", false, text.toUpperCase());
    scheduleBrainstormAutosave();
    updateBrainstormToolActiveStates();
  }

  function brainstormApplyBoldUppercase() {
    brainstormTextarea.focus();
    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    let boldOn = false;
    try { boldOn = document.queryCommandState("bold"); } catch (_) {}

    if (collapsed) {
      const bbOn = brainstormUppercasePending && boldOn;
      brainstormUppercasePending = !bbOn;
      try {
        if (bbOn && boldOn) document.execCommand("bold", false, null);
        else if (!bbOn && !boldOn) document.execCommand("bold", false, null);
      } catch (_) {}
      updateBrainstormToolActiveStates();
      return;
    }

    brainstormPushUndo();
    if (!applyBoldUppercaseSelection(brainstormTextarea)) return;
    brainstormUppercasePending = true;
    try {
      if (!document.queryCommandState("bold")) document.execCommand("bold", false, null);
    } catch (e) {
      try { document.execCommand("bold", false, null); } catch (_) {}
    }
    brainstormTextarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    scheduleBrainstormAutosave();
    updateBrainstormToolActiveStates();
  }

  function brainstormInsertSymbol(symbol) {
    brainstormTextarea.focus();
    brainstormPushUndo();
    document.execCommand("insertText", false, symbol);
    scheduleBrainstormAutosave();
  }

  // Enter key on a numbered or checklist line continues the pattern,
  // same as the note editor's noteHandleEnter.
  // Mirrors noteHandlePlainLineEnter above — see its comment for why the
  // split is done by hand instead of relying on the browser's native
  // Enter handling (which can nest a new plain line inside the previous
  // one, breaking brainstormAutoColorLines' per-line color cycling).
  function brainstormHandlePlainLineEnter(el, sel) {
    if (el === brainstormTextarea) return false; // no wrapping div yet — let the browser create the very first one
    brainstormPushUndo();
    const range = sel.getRangeAt(0);
    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    // An empty line (no children yet) has nothing after the caret to
    // move — end the range right where it started rather than calling
    // setEndAfter(el), which would straddle el's own boundary and throw.
    if (el.lastChild) afterRange.setEndAfter(el.lastChild);
    else afterRange.setEnd(range.startContainer, range.startOffset);
    const frag = afterRange.extractContents();
    const newDiv = document.createElement("div");
    if (frag.hasChildNodes()) newDiv.appendChild(frag);
    else newDiv.appendChild(document.createElement("br"));
    if (!el.hasChildNodes()) el.appendChild(document.createElement("br"));
    el.parentNode.insertBefore(newDiv, el.nextSibling);
    brainstormAutoColorLines();
    const caretRange = document.createRange();
    caretRange.selectNodeContents(newDiv);
    caretRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caretRange);
    scrollCaretIntoView(newDiv);
    scheduleBrainstormAutosave();
    return true;
  }

  function brainstormHandleEnter() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    const lineDiv = brainstormCurrentLine();
    const el = lineDiv || brainstormTextarea;
    const lineText = el.textContent;
    const numMatch = lineText.match(/^(\d+)\.\s+/);
    const checkMatch = lineText.match(/^([☐☑])\s+/);
    if (!numMatch && !checkMatch) return brainstormHandlePlainLineEnter(el, sel);
    const prefix = (numMatch || checkMatch)[0];
    const rest = lineText.slice(prefix.length);
    if (rest.trim() === "") {
      brainstormPushUndo();
      el.textContent = "";
      placeCaretAtEnd(el);
      scrollCaretIntoView(el);
      scheduleBrainstormAutosave();
      return true;
    }

    const range = sel.getRangeAt(0);
    let beforeCaretLen = lineText.length;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      beforeCaretLen = preRange.toString().length;
    } catch (err) { /* keep fallback */ }

    const caretInRest = Math.max(0, Math.min(rest.length, beforeCaretLen - prefix.length));
    const before = rest.slice(0, caretInRest);
    const after = rest.slice(caretInRest);

    brainstormPushUndo();
    const nextPrefix = numMatch ? `${parseInt(numMatch[1], 10) + 1}. ` : "☐ ";
    el.textContent = prefix + before;
    if (numMatch) brainstormSetOrderedLineColor(el);
    brainstormSyncLineChecked(el);

    const newDiv = document.createElement("div");
    newDiv.textContent = nextPrefix + after;
    if (numMatch) brainstormSetOrderedLineColor(newDiv);
    brainstormSyncLineChecked(newDiv);
    if (lineDiv && lineDiv.parentNode) {
      lineDiv.parentNode.insertBefore(newDiv, lineDiv.nextSibling);
    } else {
      brainstormTextarea.appendChild(newDiv);
    }

    const textNode = newDiv.firstChild;
    const caretRange = document.createRange();
    if (textNode && textNode.nodeType === 3) {
      caretRange.setStart(textNode, Math.min(nextPrefix.length, textNode.length));
    } else {
      caretRange.selectNodeContents(newDiv);
    }
    caretRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caretRange);
    scrollCaretIntoView(newDiv);
    scheduleBrainstormAutosave();
    return true;
  }

  // Images are embedded directly as data-URI <img> tags, same as the
  // note editor (see noteInsertImages).
  const brainstormImageInput = $("#brainstorm-image-input");
  let brainstormImageInsertLine = null;
  let brainstormImageInsertAtStart = false;

  // Same small starting size as photos dropped into a note (see
  // NOTE_IMG_DEFAULT_INSERT_WIDTH/HEIGHT) — the ➖/➕ buttons resize from there.
  function brainstormInsertImages(dataUrls, targetLine, atStart) {
    brainstormTextarea.focus();
    brainstormPushUndo();
    const lineDiv = targetLine !== undefined ? targetLine : brainstormCurrentLine();
    const validLine = lineDiv && lineDiv.parentNode === brainstormTextarea;
    const parent = validLine ? lineDiv.parentNode : brainstormTextarea;

    if (atStart && validLine) {
      dataUrls.forEach((dataUrl) => {
        const imgLine = document.createElement("div");
        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.width = `${NOTE_IMG_DEFAULT_INSERT_WIDTH}px`;
        img.style.height = `${NOTE_IMG_DEFAULT_INSERT_HEIGHT}px`;
        imgLine.appendChild(img);
        parent.insertBefore(imgLine, lineDiv);
      });
      const range = document.createRange();
      range.setStart(lineDiv, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      let cursor = validLine ? lineDiv : parent.lastChild;
      let lastImgLine = null;
      dataUrls.forEach((dataUrl) => {
        const imgLine = document.createElement("div");
        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.width = `${NOTE_IMG_DEFAULT_INSERT_WIDTH}px`;
        img.style.height = `${NOTE_IMG_DEFAULT_INSERT_HEIGHT}px`;
        imgLine.appendChild(img);
        parent.insertBefore(imgLine, cursor ? cursor.nextSibling : null);
        cursor = imgLine;
        lastImgLine = imgLine;
      });
      const afterLine = document.createElement("div");
      afterLine.appendChild(document.createElement("br"));
      parent.insertBefore(afterLine, lastImgLine ? lastImgLine.nextSibling : null);
      placeCaretAtEnd(afterLine);
    }
    scheduleBrainstormAutosave();
  }

  function brainstormInsertImage(dataUrl, targetLine, atStart) {
    brainstormInsertImages([dataUrl], targetLine, atStart);
  }

  function brainstormHandleImageFiles(fileList, targetLine, atStart) {
    const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith("image/"));
    if (!files.length) return;
    let hadError = false;
    Promise.all(files.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => { hadError = true; resolve(null); };
      reader.readAsDataURL(file);
    })))
      .then((dataUrls) => Promise.all(dataUrls.map(downscaleNoteImageDataUrl)))
      .then((dataUrls) => {
      const loaded = dataUrls.filter(Boolean);
      if (loaded.length) brainstormInsertImages(loaded, targetLine, atStart);
      if (hadError) alert("Some images couldn't be read.");
    });
  }

  function brainstormHandleImageFile(file, targetLine, atStart) {
    if (!file) return;
    brainstormHandleImageFiles([file], targetLine, atStart);
  }

  $("#brainstorm-tool-image").addEventListener("mousedown", (e) => e.preventDefault());
  $("#brainstorm-tool-image").addEventListener("click", () => {
    brainstormImageInsertLine = brainstormCurrentLine();
    brainstormImageInsertAtStart = brainstormCaretIsAtLineStart(brainstormImageInsertLine);
    brainstormImageInput.click();
  });
  brainstormImageInput.addEventListener("change", () => {
    if (brainstormImageInput.files && brainstormImageInput.files.length) {
      brainstormHandleImageFiles(brainstormImageInput.files, brainstormImageInsertLine, brainstormImageInsertAtStart);
    }
    brainstormImageInput.value = "";
  });

  brainstormTextarea.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        e.preventDefault();
        const pasteLine = brainstormCurrentLine();
        const pasteAtStart = brainstormCaretIsAtLineStart(pasteLine);
        brainstormHandleImageFile(item.getAsFile(), pasteLine, pasteAtStart);
        return;
      }
    }
  });

  function brainstormDraggedImageFile(e) {
    const dt = e.dataTransfer;
    if (!dt) return null;
    const fromFiles = dt.files && Array.from(dt.files).find(f => f.type && f.type.startsWith("image/"));
    if (fromFiles) return fromFiles;
    const hasImageItem = dt.items && Array.from(dt.items).some(i => i.type && i.type.startsWith("image/"));
    return hasImageItem ? true : null;
  }

  brainstormTextarea.addEventListener("dragover", (e) => {
    if (brainstormDraggedImageFile(e)) {
      e.preventDefault();
      brainstormTextarea.classList.add("drag-over");
    }
  });
  brainstormTextarea.addEventListener("dragleave", () => brainstormTextarea.classList.remove("drag-over"));
  brainstormTextarea.addEventListener("drop", (e) => {
    const file = brainstormDraggedImageFile(e);
    if (file && file !== true) {
      e.preventDefault();
      brainstormTextarea.classList.remove("drag-over");
      brainstormHandleImageFile(file);
    } else {
      brainstormTextarea.classList.remove("drag-over");
    }
  });

  // Hover −/+ buttons on photos — the same floating pair the note editor
  // uses (see showNoteImageShrinkBtn), wired to this editor's own undo and
  // autosave.
  const NOTE_IMG_HOST_BRAINSTORM = { pushUndo: () => brainstormPushUndo(), save: () => scheduleBrainstormAutosave() };
  brainstormTextarea.addEventListener("mouseover", (e) => {
    if (e.target && e.target.tagName === "IMG") showNoteImageShrinkBtn(e.target, NOTE_IMG_HOST_BRAINSTORM);
  });
  brainstormTextarea.addEventListener("mouseout", (e) => {
    if (e.target && e.target.tagName === "IMG" &&
        !noteImageShrinkBtn.contains(e.relatedTarget) && !noteImageGrowBtn.contains(e.relatedTarget)) {
      scheduleHideNoteImageShrinkBtn();
    }
  });
  brainstormTextarea.addEventListener("scroll", () => {
    if (noteImageShrinkTarget && brainstormTextarea.contains(noteImageShrinkTarget)) positionNoteImageShrinkBtn(noteImageShrinkTarget);
  });

  // Clicking directly on a checklist glyph toggles it, or on an image
  // opens the photo viewer — same as the note editor.
  brainstormTextarea.addEventListener("click", (e) => {
    if (e.target && e.target.tagName === "IMG") {
      openNotePhotoViewer(e.target, brainstormTextarea);
      return;
    }
    const lineDiv = brainstormCurrentLine();
    const text = (lineDiv || brainstormTextarea).textContent;
    if (!/^[☐☑]\s/.test(text)) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    if (!sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(lineDiv || brainstormTextarea);
    preRange.setEnd(range.startContainer, range.startOffset);
    if (preRange.toString().length > 1) return;
    brainstormPushUndo();
    const el = lineDiv || brainstormTextarea;
    el.textContent = text.replace(/^[☐☑]/, m => (m === "☐" ? "☑" : "☐"));
    brainstormSyncLineChecked(el);
    scheduleBrainstormAutosave();
  });

  brainstormUndoBtn.addEventListener("mousedown", (e) => e.preventDefault());
  brainstormUndoBtn.addEventListener("click", () => brainstormUndo());
  brainstormRedoBtn.addEventListener("mousedown", (e) => e.preventDefault());
  brainstormRedoBtn.addEventListener("click", () => brainstormRedo());

  $("#brainstorm-tool-ol").addEventListener("mousedown", (e) => {
    e.preventDefault();
    brainstormToggleOrderedList();
  });
  $("#brainstorm-tool-check").addEventListener("mousedown", (e) => {
    e.preventDefault();
    brainstormToggleLinePrefix(/^[☐☑]\s+/, () => "☐ ");
  });
  $("#brainstorm-tool-tab").addEventListener("mousedown", (e) => {
    e.preventDefault();
    insertNoteDotTab(brainstormTextarea, brainstormPushUndo);
  });
  $("#brainstorm-tool-strike").addEventListener("mousedown", (e) => {
    e.preventDefault();
    brainstormApplyStrikethrough();
  });
  $("#brainstorm-tool-bold").addEventListener("mousedown", (e) => {
    e.preventDefault();
    brainstormApplyBold();
  });
  $("#brainstorm-tool-bold-upper").addEventListener("mousedown", (e) => {
    e.preventDefault();
    brainstormApplyBoldUppercase();
  });
  document.querySelectorAll(".brainstorm-color-swatch").forEach(btn => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      brainstormApplyForeColor(btn.dataset.color);
      setBrainstormColorTrigger(btn.dataset.color);
    });
    btn.addEventListener("click", () => { closeBrainstormColorPopover(); });
  });
  $("#brainstorm-color-custom").addEventListener("input", (e) => {
    brainstormApplyForeColor(e.target.value);
    setBrainstormColorTrigger(e.target.value);
  });
  $("#brainstorm-color-custom").addEventListener("mousedown", (e) => e.stopPropagation());

  const brainstormColorTriggerBtn = $("#brainstorm-tool-color");
  const brainstormColorPopover = $("#brainstorm-color-popover");
  brainstormColorTriggerBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (brainstormColorPopover.classList.contains("hidden")) {
      openBrainstormColorPopover();
    } else {
      closeBrainstormColorPopover();
    }
  });
  brainstormColorPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!brainstormColorPopover.classList.contains("hidden") &&
        !brainstormColorPopover.contains(e.target) && e.target !== brainstormColorTriggerBtn) {
      closeBrainstormColorPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!brainstormColorPopover.classList.contains("hidden")) positionBrainstormColorPopover();
  });
  function openBrainstormColorPopover(){
    brainstormColorPopover.classList.remove("hidden");
    positionBrainstormColorPopover();
  }
  function closeBrainstormColorPopover(){ brainstormColorPopover.classList.add("hidden"); }
  function positionBrainstormColorPopover(){
    const margin = 8;
    const btnRect = brainstormColorTriggerBtn.getBoundingClientRect();
    const popRect = brainstormColorPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6;
    }
    brainstormColorPopover.style.left = `${left}px`;
    brainstormColorPopover.style.top = `${top}px`;
  }
  function setBrainstormColorTrigger(color){ $("#brainstorm-color-trigger-swatch").style.background = color; }

  const brainstormSymbolTriggerBtn = $("#brainstorm-tool-symbol");
  const brainstormSymbolPopover = $("#brainstorm-symbol-popover");
  document.querySelectorAll(".brainstorm-symbol-swatch").forEach(btn => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      brainstormInsertSymbol(btn.dataset.symbol);
    });
    btn.addEventListener("click", () => { closeBrainstormSymbolPopover(); });
  });
  brainstormSymbolTriggerBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (brainstormSymbolPopover.classList.contains("hidden")) {
      openBrainstormSymbolPopover();
    } else {
      closeBrainstormSymbolPopover();
    }
  });
  brainstormSymbolPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!brainstormSymbolPopover.classList.contains("hidden") &&
        !brainstormSymbolPopover.contains(e.target) && e.target !== brainstormSymbolTriggerBtn) {
      closeBrainstormSymbolPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!brainstormSymbolPopover.classList.contains("hidden")) positionBrainstormSymbolPopover();
  });
  function openBrainstormSymbolPopover(){
    brainstormSymbolPopover.classList.remove("hidden");
    positionBrainstormSymbolPopover();
  }
  function closeBrainstormSymbolPopover(){ brainstormSymbolPopover.classList.add("hidden"); }
  function positionBrainstormSymbolPopover(){
    const margin = 8;
    const btnRect = brainstormSymbolTriggerBtn.getBoundingClientRect();
    const popRect = brainstormSymbolPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6;
    }
    brainstormSymbolPopover.style.left = `${left}px`;
    brainstormSymbolPopover.style.top = `${top}px`;
  }

  // Groups plain typing into undo-sized bursts, same 600ms pattern as
  // the note editor.
  const BRAINSTORM_TYPING_BURST_MS = 600;
  brainstormTextarea.addEventListener("beforeinput", () => {
    const now = Date.now();
    if (now - brainstormLastPushAt > BRAINSTORM_TYPING_BURST_MS || !brainstormUndoStack.length) {
      pushBoundedSnapshot(brainstormUndoStack, brainstormTextarea.innerHTML, BRAINSTORM_UNDO_LIMIT);
    }
    brainstormRedoStack = [];
    brainstormLastPushAt = now;
    updateBrainstormUndoButtons();
  });
  // While "type in caps" mode is armed (AA button pressed), transform
  // each character as it's typed, same as the note editor.
  brainstormTextarea.addEventListener("beforeinput", (e) => {
    if (!brainstormUppercasePending || brainstormUppercaseInserting) return;
    if (e.inputType === "insertText" && e.data) {
      e.preventDefault();
      brainstormUppercaseInserting = true;
      document.execCommand("insertText", false, e.data.toUpperCase());
      brainstormUppercaseInserting = false;
    }
  });
  brainstormTextarea.addEventListener("mousedown", () => {
    if (brainstormUppercasePending) {
      brainstormUppercasePending = false;
      updateBrainstormToolActiveStates();
    }
  });
  document.addEventListener("selectionchange", () => {
    if (!brainstormModal.classList.contains("hidden") && document.activeElement === brainstormTextarea) {
      updateBrainstormToolActiveStates();
    }
  });

  brainstormTextarea.addEventListener("input", () => { brainstormAutoColorLines(); scheduleBrainstormAutosave(); });
  brainstormTextarea.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let Tab/Enter/Delete/etc trigger canvas shortcuts while typing
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      insertNoteDotTab(brainstormTextarea, brainstormPushUndo);
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey && !e.metaKey && !e.altKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (brainstormTextarea.contains(range.commonAncestorContainer)) {
          const backward = e.key === "Backspace";
          const tab = noteDotTabAtEditingEdge(brainstormTextarea, range, backward);
          if (tab) {
            e.preventDefault();
            deleteNoteDotTab(brainstormTextarea, tab, brainstormPushUndo,
              backward ? "deleteContentBackward" : "deleteContentForward");
            return;
          }
        }
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) brainstormRedo(); else brainstormUndo();
      return;
    }
    // Same Ctrl/Cmd+B and Caps Lock shortcuts as the note editor — see
    // noteHandleEnter's keydown handler for why these are intercepted.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      brainstormApplyBold();
      return;
    }
    if (e.key === "CapsLock") {
      brainstormApplyUppercase();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); closeBrainstormModal(); return; }
    if (e.key === "Enter" && e.shiftKey) {
      requestAnimationFrame(updateBrainstormToolActiveStates);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (brainstormHandleEnter()) {
        e.preventDefault();
        refreshBrainstormCards();
      }
    }
  });

  brainstormClearBtn.addEventListener("click", () => {
    const t = brainstormEditingId;
    if (!t) return;
    const host = resolveBrainstormTarget(t);
    if (!host || !getBrainstormText(host)) return;
    pushUndo();
    host.brainstorm = { text: "", html: "" };
    brainstormTextarea.innerHTML = "";
    brainstormResetUndoHistory();
    renderBrainstormProgress(host);
    persist();
    updateBrainstormLiveUI(t);
  });

  $("#brainstorm-back").addEventListener("click", closeBrainstormModal);
  // Same fix as noteModal above: require the mousedown to have started on
  // the backdrop too, so dragging a text selection past the card's edge
  // doesn't get misread as a click-away-to-close.
  let brainstormBackdropMousedown = false;
  brainstormModal.addEventListener("mousedown", (e) => { brainstormBackdropMousedown = (e.target === brainstormModal); });
  brainstormModal.addEventListener("click", (e) => {
    if (!brainstormIsResizing && e.target === brainstormModal && brainstormBackdropMousedown) closeBrainstormModal();
  });

  /* ---------------- affirmation lines manager ---------------- */
  // Lets the person edit the pool of lines itself: rename any existing
  // line in place, delete one, or add new ones. Changes save immediately
  // (debounced text edits save on blur/Enter) via saveAffirmationQuotes().

  const affirmationQuotesModal = $("#affirmation-quotes-modal");
  const affirmationQuotesListEl = $("#affirmation-quotes-list");
  const affirmationQuotesNewInput = $("#affirmation-quotes-new-input");

  function openAffirmationQuotesModal() {
    renderAffirmationQuotesModal();
    zoomModalOpen(affirmationQuotesModal);
    requestAnimationFrame(() => affirmationQuotesNewInput.focus());
  }
  function closeAffirmationQuotesModal() {
    zoomModalClose(affirmationQuotesModal, () => { affirmationQuotesNewInput.value = ""; });
  }

  function renderAffirmationQuotesModal() {
    affirmationQuotesListEl.innerHTML = "";
    if (!affirmationQuotesList.length) {
      const empty = document.createElement("li");
      empty.className = "affirmation-quotes-empty";
      empty.textContent = "No lines yet — add one below.";
      affirmationQuotesListEl.appendChild(empty);
      return;
    }
    affirmationQuotesList.forEach((quote, idx) => {
      const li = document.createElement("li");
      li.className = "affirmation-quote-row";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "affirmation-quote-row-input";
      input.spellcheck = false;
      input.value = quote;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); input.value = quote; input.blur(); }
      });
      input.addEventListener("blur", () => {
        const v = input.value.trim();
        if (v && v !== affirmationQuotesList[idx]) {
          affirmationQuotesList[idx] = v;
          saveAffirmationQuotes();
        } else {
          input.value = affirmationQuotesList[idx];
        }
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "affirmation-quote-row-delete";
      del.title = "Remove this line";
      del.textContent = "×";
      del.addEventListener("click", () => {
        affirmationQuotesList.splice(idx, 1);
        saveAffirmationQuotes();
        renderAffirmationQuotesModal();
      });

      li.appendChild(input);
      li.appendChild(del);
      affirmationQuotesListEl.appendChild(li);
    });
  }

  function addAffirmationQuoteFromModal() {
    const v = affirmationQuotesNewInput.value.trim();
    if (!v) return;
    affirmationQuotesList.push(v);
    saveAffirmationQuotes();
    affirmationQuotesNewInput.value = "";
    renderAffirmationQuotesModal();
  }

  $("#affirmation-quotes-close").addEventListener("click", closeAffirmationQuotesModal);
  affirmationQuotesModal.addEventListener("click", (e) => { if (e.target === affirmationQuotesModal) closeAffirmationQuotesModal(); });
  affirmationQuotesNewInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); addAffirmationQuoteFromModal(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAffirmationQuotesModal(); }
  });
  document.addEventListener("keydown", (e) => {
    if (affirmationQuotesModal.classList.contains("hidden")) return;
    if (e.key === "Escape" && document.activeElement !== affirmationQuotesNewInput) closeAffirmationQuotesModal();
  });

  /* ---------------- trash modal ---------------- */

  const trashModal = $("#trash-modal");
  const trashListEl = $("#trash-list");

  function openTrashModal() {
    renderTrashModal();
    zoomModalOpen(trashModal);
  }
  function closeTrashModal() {
    zoomModalClose(trashModal);
  }

  function renderTrashModal() {
    updateTrashBadge();
    trashListEl.innerHTML = "";
    const trashed = trashedMapsList().sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
    if (!trashed.length) {
      const empty = document.createElement("li");
      empty.className = "trash-empty";
      empty.textContent = "Trash is empty.";
      trashListEl.appendChild(empty);
      $("#trash-empty-btn").disabled = true;
      return;
    }
    $("#trash-empty-btn").disabled = false;
    trashed.forEach((m) => {
      const li = document.createElement("li");
      li.className = "trash-row";

      const text = document.createElement("div");
      text.className = "trash-row-text";
      const name = document.createElement("span");
      name.className = "trash-row-name";
      name.textContent = m.title || "Untitled map";
      const rel = relTime(m.trashedAt);
      const meta = document.createElement("span");
      meta.className = "trash-row-meta";
      meta.textContent = rel === "now" ? "Trashed just now" : `Trashed ${rel} ago`;
      text.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "trash-row-actions";
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "trash-row-restore";
      restoreBtn.textContent = "Restore";
      restoreBtn.addEventListener("click", () => restoreMap(m.id));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "trash-row-delete";
      delBtn.textContent = "Delete forever";
      delBtn.addEventListener("click", () => permanentlyDeleteMap(m.id));
      actions.append(restoreBtn, delBtn);

      li.append(text, actions);
      trashListEl.appendChild(li);
    });
  }

  $("#btn-trash").addEventListener("click", openTrashModal);
  $("#trash-close").addEventListener("click", closeTrashModal);
  $("#trash-empty-btn").addEventListener("click", emptyTrash);
  trashModal.addEventListener("click", (e) => { if (e.target === trashModal) closeTrashModal(); });
  document.addEventListener("keydown", (e) => {
    if (trashModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeTrashModal();
  });

  /* ---------------- storage modal ---------------- */
  // Answers "why is this site using way more browser storage than my
  // maps look like they should?" — almost always either (a) trashed
  // maps, which are only ever soft-deleted (see deleteMap) and keep
  // every one of their photo rows in PhotoDB until Empty Trash actually
  // runs, or (b) leftover photo rows in PhotoDB that nothing in the
  // current node tree references anymore (gcOrphanedPhotos above exists
  // for exactly this, but is deliberately never called automatically —
  // see the big comment on it — so it only ever runs from the button
  // here, on the one map that's actually open).

  const storageModal = $("#storage-modal");
  const storageListEl = $("#storage-list");
  const storageTotalLine = $("#storage-total-line");

  function formatStorageBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  // Blob rows report their own size directly; legacy pre-Blob rows only
  // have a base64 `data:` string, whose raw byte count is ~3/4 of the
  // string length minus the "data:image/...;base64," header — close
  // enough for a usage estimate, not worth decoding just to measure.
  async function estimateMapPhotoBytes(mapId) {
    let total = 0;
    try {
      const rows = await PhotoDB.getAllForMap(mapId);
      for (const r of rows) {
        if (r.blob && typeof r.blob.size === "number") total += r.blob.size;
        else if (typeof r.data === "string") {
          const commaIdx = r.data.indexOf(",");
          total += Math.floor((r.data.length - (commaIdx + 1)) * 0.75);
        }
      }
    } catch (e) { /* best-effort estimate */ }
    return total;
  }

  async function openStorageModal() {
    zoomModalOpen(storageModal);
    try { await migrateLegacyRecoveryPhotoSharing(); } catch (e) {
      console.warn("Storage recovery-photo migration skipped", e);
    }
    await renderStorageModal();
  }
  function closeStorageModal() {
    zoomModalClose(storageModal);
  }

  async function renderStorageModal() {
    storageListEl.innerHTML = "";
    storageTotalLine.textContent = "Calculating…";
    $("#storage-empty-trash-btn").disabled = trashedMapsList().length === 0;

    const rows = await Promise.all(state.maps.map(async (m) => {
      let photoBytes = 0;
      let photoCount = 0;
      let sharedCount = 0;
      let sharedSourceName = "";
      let ownIds = new Set();
      try {
        const photoRows = await PhotoDB.getAllForMap(m.id);
        ownIds = new Set(photoRows.map((r) => r.id));
        photoCount = photoRows.length;
        for (const r of photoRows) {
          if (r.blob && typeof r.blob.size === "number") photoBytes += r.blob.size;
          else if (typeof r.data === "string") {
            const commaIdx = r.data.indexOf(",");
            photoBytes += Math.floor((r.data.length - (commaIdx + 1)) * 0.75);
          }
        }

        const sourceId = sharedPhotoSourceMapId(m);
        if (sourceId) {
          const sourceMap = state.maps.find((x) => x.id === sourceId);
          sharedSourceName = sourceMap ? (sourceMap.title || "source map") : "source map";
          const sourceRows = await PhotoDB.getAllForMap(sourceId);
          const sourceIds = new Set(sourceRows.map((r) => r.id));
          collectReferencedPhotoIds(m.root).forEach((id) => {
            if (!ownIds.has(id) && sourceIds.has(id)) sharedCount++;
          });
        }
      } catch (e) { /* best-effort estimate */ }
      // Actual UTF-8 JSON payload size of nodes/text/settings only.
      // Photo Blob bytes are counted only under the map that physically owns
      // them. Shared recovery references therefore do not inflate Total.
      const treeBytes = new Blob([JSON.stringify(m)], { type: "application/json" }).size;
      return { map: m, treeBytes, photoBytes, photoCount, sharedCount, sharedSourceName, bytes: photoBytes + treeBytes };
    }));
    rows.sort((a, b) => b.bytes - a.bytes);

    // Rows in PhotoDB whose mapId doesn't match ANY map this browser
    // still knows about — active or trashed. These are invisible to
    // every other view in the app (Trash included, since their owning
    // map record is already gone) and can only ever have come from a
    // map being deleted without its photos being cleaned up first: an
    // older build's delete path, or a write that got interrupted
    // partway through permanentlyDeleteMap/emptyTrash. Safe to delete
    // outright — by definition nothing references them anymore.
    const knownMapIds = new Set(state.maps.map(m => m.id));
    let orphanBytes = 0;
    let orphanIds = [];
    try {
      const allPhotoRows = await PhotoDB.getAllRaw();
      for (const r of allPhotoRows) {
        if (knownMapIds.has(r.mapId)) continue;
        orphanIds.push(r.id);
        if (r.blob && typeof r.blob.size === "number") orphanBytes += r.blob.size;
        else if (typeof r.data === "string") {
          const commaIdx = r.data.indexOf(",");
          orphanBytes += Math.floor((r.data.length - (commaIdx + 1)) * 0.75);
        }
      }
    } catch (e) { /* best-effort scan */ }
    storageOrphanIds = orphanIds;
    const orphanBtn = $("#storage-orphan-btn");
    orphanBtn.disabled = orphanIds.length === 0;
    orphanBtn.textContent = orphanIds.length
      ? `Delete ${orphanIds.length} unowned photo${orphanIds.length === 1 ? "" : "s"} (${formatStorageBytes(orphanBytes)})`
      : "No unowned photos found";

    const trashedTotal = rows.filter(r => r.map.trashedAt).reduce((s, r) => s + r.bytes, 0);
    const mapDataTotal = rows.reduce((s, r) => s + r.treeBytes, 0);
    const photoTotal = rows.reduce((s, r) => s + r.photoBytes, 0);
    const grandTotal = mapDataTotal + photoTotal + orphanBytes;

    let quotaLine = "";
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (typeof est.usage === "number") {
          quotaLine = ` Chrome reports ${formatStorageBytes(est.usage)} actually on disk for this site — the gap from the estimate above is normal IndexedDB/browser overhead.`;
        }
      } catch (e) { /* estimate() not available in this context */ }
    }
    const parts = [
      `Map data: ~${formatStorageBytes(mapDataTotal)}`,
      `Photos: ~${formatStorageBytes(photoTotal)}`,
      `Total: ~${formatStorageBytes(grandTotal)} across ${rows.length} map${rows.length === 1 ? "" : "s"}`
    ];
    if (trashedTotal > 0) parts.push(`~${formatStorageBytes(trashedTotal)} of that is sitting in the trash`);
    if (orphanBytes > 0) parts.push(`~${formatStorageBytes(orphanBytes)} more is unowned photo data`);
    storageTotalLine.textContent = parts.join(" · ") + `.${quotaLine}`;

    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "trash-empty";
      empty.textContent = "No maps yet.";
      storageListEl.appendChild(empty);
      return;
    }

    rows.forEach(({ map: m, treeBytes, photoBytes, photoCount, sharedCount, sharedSourceName, bytes }) => {
      const li = document.createElement("li");
      li.className = "trash-row" + (m.trashedAt ? " storage-row-trashed" : "");

      const text = document.createElement("div");
      text.className = "trash-row-text";
      const name = document.createElement("span");
      name.className = "trash-row-name";
      name.textContent = m.title || "Untitled map";
      const meta = document.createElement("span");
      meta.className = "trash-row-meta";
      meta.textContent =
        `Map data: ${formatStorageBytes(treeBytes)} · ` +
        `Photos owned: ${formatStorageBytes(photoBytes)} (${photoCount})` +
        (sharedCount ? ` · Shared photos: ${sharedCount} from "${sharedSourceName}"` : "") +
        ` · Total stored here: ${formatStorageBytes(bytes)}`;
      text.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "trash-row-actions";
      if (m.trashedAt) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "trash-row-delete";
        delBtn.textContent = "Delete forever";
        delBtn.addEventListener("click", async () => {
          await permanentlyDeleteMap(m.id);
          renderStorageModal();
        });
        actions.appendChild(delBtn);
      }

      li.append(text, actions);
      storageListEl.appendChild(li);
    });
  }

  let storageOrphanIds = [];

  $("#btn-storage").addEventListener("click", openStorageModal);
  $("#storage-close").addEventListener("click", closeStorageModal);
  $("#storage-empty-trash-btn").addEventListener("click", async () => {
    await emptyTrash();
    renderStorageModal();
  });
  $("#storage-cleanup-btn").addEventListener("click", async () => {
    if (!state.current) { showToast("Open a map first."); return; }
    const before = await estimateMapPhotoBytes(state.current.id);
    await gcOrphanedPhotos(state.current);
    await loadPhotoCacheForMap(state.current.id); // refresh the in-tab cache to match what's left on disk
    const after = await estimateMapPhotoBytes(state.current.id);
    const freed = before - after;
    showToast(freed > 0 ? `Freed ${formatStorageBytes(freed)} of unused photos on this map.` : "No unused photos found on this map.");
    renderStorageModal();
  });
  // Folds photos that are byte-for-byte identical (added before identical
  // photos shared an id) onto one id per picture, on the currently open map.
  $("#storage-merge-btn").addEventListener("click", async () => {
    if (!state.current) { showToast("Open a map first."); return; }
    if (!requireSignIn()) return;
    if (!confirm("Merge identical photos on this map? Photos that are exactly the same picture will share one stored copy. Nothing you see changes, but this clears the undo history.")) return;
    showToast("Checking photos…");
    const map = state.current;
    await photoFpIndexPromise; // make sure every stored photo has been fingerprinted
    if (state.current !== map) return;
    const before = await estimateMapPhotoBytes(map.id);
    const groups = new Map();
    collectReferencedPhotoIds(map.root).forEach((id) => {
      const fp = photoFpById.get(id);
      if (!fp || !photoBlobCache.has(id)) return;
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(id);
    });
    let merged = 0;
    groups.forEach((ids) => {
      if (ids.length < 2) return;
      const keep = ids[0];
      ids.slice(1).forEach((dupId) => {
        (function walk(n) { merged += replacePhotoIdInNode(n, dupId, keep); (n.children || []).forEach(walk); })(map.root);
      });
    });
    if (!merged) { showToast("No identical photos to merge."); return; }
    // The old ids no longer exist in the tree, so earlier undo snapshots
    // would point at photos that are about to be swept — drop them.
    state.undoStack = [];
    state.redoStack = [];
    renderAll();
    persist();
    // Get the merged tree onto disk BEFORE sweeping the now-unused photo
    // rows, so a crash in between can never leave the saved map pointing
    // at photos that no longer exist.
    try { await DB.put(map); } catch (e) {
      showToast("Couldn't save the merge — nothing was deleted.");
      renderStorageModal();
      return;
    }
    await gcOrphanedPhotos(map);
    await loadPhotoCacheForMap(map.id);
    const after = await estimateMapPhotoBytes(map.id);
    const freed = before - after;
    showToast(`Merged ${merged} duplicate photo reference${merged === 1 ? "" : "s"}` + (freed > 0 ? ` — freed ${formatStorageBytes(freed)}.` : "."));
    renderStorageModal();
  });
  $("#storage-cleanup-all-btn").addEventListener("click", async () => {
    if (!confirm(`Scan all ${state.maps.length} map${state.maps.length === 1 ? "" : "s"} for unused photo bytes and delete them? This can't be undone.`)) return;
    let before = 0;
    for (const m of state.maps) before += await estimateMapPhotoBytes(m.id);
    for (const m of state.maps) await gcOrphanedPhotos(m);
    // Only the currently-open map's photos are cached in this tab (see
    // photoCache/photoBlobCache) — refresh that one so anything just
    // deleted from under it doesn't leave a dangling object URL around.
    if (state.current) await loadPhotoCacheForMap(state.current.id);
    let after = 0;
    for (const m of state.maps) after += await estimateMapPhotoBytes(m.id);
    const freed = before - after;
    showToast(freed > 0 ? `Freed ${formatStorageBytes(freed)} of unused photos across all maps.` : "No unused photos found.");
    renderStorageModal();
  });
  $("#storage-orphan-btn").addEventListener("click", async () => {
    if (!storageOrphanIds.length) return;
    if (!confirm(`Permanently delete ${storageOrphanIds.length} photo${storageOrphanIds.length === 1 ? "" : "s"} left behind by maps that no longer exist? This can't be undone.`)) return;
    await PhotoDB.deleteMany(storageOrphanIds);
    storageOrphanIds = [];
    renderStorageModal();
  });
  storageModal.addEventListener("click", (e) => { if (e.target === storageModal) closeStorageModal(); });
  document.addEventListener("keydown", (e) => {
    if (storageModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeStorageModal();
  });

  /* ---------------- photo tag browser ---------------- */

  const tagBrowserModal = $("#tagbrowser-modal");
  const tagBrowserListView = $("#tagbrowser-list-view");
  const tagBrowserGalleryView = $("#tagbrowser-gallery-view");
  const tagBrowserTagList = $("#tagbrowser-tag-list");
  const tagBrowserGalleryGrid = $("#tagbrowser-gallery-grid");
  const tagBrowserGalleryTitle = $("#tagbrowser-gallery-title");

  // The tag browser now lives inside the Photos browser (its 🏷 Tags
  // button), so when it's opened from there the list view shows a back
  // arrow that returns to Photos instead of just closing.
  const tagBrowserListBack = $("#tagbrowser-list-back");

  function openTagBrowserModal(fromPhotos) {
    renderTagBrowserList();
    tagBrowserGalleryView.classList.add("hidden");
    tagBrowserListView.classList.remove("hidden");
    tagBrowserListBack.classList.toggle("hidden", !fromPhotos);
    zoomModalOpen(tagBrowserModal);
  }
  function closeTagBrowserModal() {
    zoomModalClose(tagBrowserModal);
  }

  function renderTagBrowserList() {
    tagBrowserTagList.innerHTML = "";
    const groups = collectPhotoTagGroups();
    if (!groups.length) {
      const empty = document.createElement("li");
      empty.className = "tagbrowser-empty";
      empty.textContent = "No tagged photos yet — open a photo and add a tag to start grouping them here.";
      tagBrowserTagList.appendChild(empty);
      return;
    }
    groups.forEach((group) => {
      const li = document.createElement("li");
      li.className = "tagbrowser-tag-row";

      const thumb = document.createElement("img");
      thumb.className = "tagbrowser-tag-thumb";
      thumb.alt = "";
      // Defensive fallback: if this photo's bytes genuinely aren't in
      // this browser's local PhotoDB (data loss, or a not-yet-finished
      // cache load), hide the broken-image icon rather than show it.
      const thumbUrl = photoUrl(group.items[0].id);
      if (thumbUrl) thumb.src = thumbUrl; else thumb.style.visibility = "hidden";
      thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });

      const name = document.createElement("span");
      name.className = "tagbrowser-tag-name";
      name.textContent = group.label;

      const count = document.createElement("span");
      count.className = "tagbrowser-tag-count";
      count.textContent = String(group.items.length);

      const chevron = document.createElement("span");
      chevron.className = "tagbrowser-tag-chevron";
      chevron.textContent = "›";

      li.append(thumb, name, count, chevron);
      li.addEventListener("click", () => openTagGallery(group));
      tagBrowserTagList.appendChild(li);
    });
  }

  function openTagGallery(group) {
    tagBrowserGalleryTitle.textContent = group.label;
    tagBrowserGalleryGrid.innerHTML = "";
    group.items.forEach((it) => {
      const node = findNode(it.nodeId);
      if (!node) return;
      const host = browserItemHost(node, it);
      if (!host) return;
      const cell = document.createElement("div");
      cell.className = "tagbrowser-gallery-item";

      const thumb = document.createElement("img");
      thumb.className = "tagbrowser-gallery-thumb";
      thumb.alt = "";
      const thumbUrl = photoUrl(it.id);
      if (thumbUrl) thumb.src = thumbUrl; else thumb.style.visibility = "hidden";
      thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });

      const label = document.createElement("span");
      label.className = "tagbrowser-gallery-label";
      label.textContent = it.hostLabel || contentNodeLabel(node);

      cell.append(thumb, label);
      cell.addEventListener("click", () => {
        const idx = getNodeImageIds(host).indexOf(it.id);
        if (idx < 0) return;
        const fromPhotos = !tagBrowserListBack.classList.contains("hidden");
        const ret = {
          label: fromPhotos ? `Photos › ${group.label}` : `tag “${group.label}”`,
          restore: () => { openTagBrowserModal(fromPhotos); openTagGallery(group); },
        };
        closeTagBrowserModal();
        withViewerReturn(ret, () => openBrowserPhotoItem(it, idx, group));
      });
      tagBrowserGalleryGrid.appendChild(cell);
    });
    tagBrowserListView.classList.add("hidden");
    tagBrowserGalleryView.classList.remove("hidden");
  }

  tagBrowserListBack.addEventListener("click", () => {
    closeTagBrowserModal();
    openPhotosBrowserModal();
  });
  $("#tagbrowser-close").addEventListener("click", closeTagBrowserModal);
  $("#tagbrowser-gallery-close").addEventListener("click", closeTagBrowserModal);
  $("#tagbrowser-back").addEventListener("click", () => {
    tagBrowserGalleryView.classList.add("hidden");
    tagBrowserListView.classList.remove("hidden");
  });
  tagBrowserModal.addEventListener("click", (e) => { if (e.target === tagBrowserModal) closeTagBrowserModal(); });
  document.addEventListener("keydown", (e) => {
    if (tagBrowserModal.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      if (!tagBrowserGalleryView.classList.contains("hidden")) {
        tagBrowserGalleryView.classList.add("hidden");
        tagBrowserListView.classList.remove("hidden");
      } else {
        closeTagBrowserModal();
      }
    }
  });

  // Comment browser — same idea as the tag browser above (collect every
  // photo carrying the attribute across the whole map, click to jump
  // straight to it), but flat rather than grouped, since a comment is
  // freeform text rather than a shared label multiple photos sit under.
  // A search box stands in for the tag browser's grouping, so comments
  // are still findable at scale instead of only visible one-at-a-time
  // inside whichever photo they're attached to.
  const commentBrowserModal = $("#commentbrowser-modal");
  const commentBrowserGrid = $("#commentbrowser-grid");
  const commentBrowserSearch = $("#commentbrowser-search");
  let commentBrowserItems = [];

  function collectPhotoCommentItems() {
    const items = [];
    let cleaned = false;
    collectContentHosts().forEach(({ node, host, r, c, hostLabel }) => {
      if (!host.photoComments) return;
      const liveIds = new Set(getNodeImageIds(host));
      Object.keys(host.photoComments).forEach((id) => {
        if (!liveIds.has(id)) {
          delete host.photoComments[id];
          cleaned = true;
          return;
        }
        items.push({ nodeId: node.id, r, c, id, comment: host.photoComments[id], nodeLabel: hostLabel });
      });
    });
    if (cleaned) persist();
    return items.sort((a, b) => a.nodeLabel.localeCompare(b.nodeLabel));
  }

  function openCommentBrowserModal(keep) {
    commentBrowserItems = collectPhotoCommentItems();
    if (keep !== true) commentBrowserSearch.value = "";
    renderCommentBrowserGrid();
    zoomModalOpen(commentBrowserModal);
    if (keep !== true) requestAnimationFrame(() => commentBrowserSearch.focus());
  }
  function closeCommentBrowserModal() {
    zoomModalClose(commentBrowserModal);
  }

  function renderCommentBrowserGrid() {
    const q = commentBrowserSearch.value.trim().toLowerCase();
    const filtered = !q ? commentBrowserItems : commentBrowserItems.filter(it =>
      it.comment.toLowerCase().includes(q) || it.nodeLabel.toLowerCase().includes(q));
    commentBrowserGrid.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "tagbrowser-hint";
      empty.textContent = commentBrowserItems.length
        ? "No comments match that search."
        : "No commented photos yet — open a photo and add a comment below it to start collecting them here.";
      commentBrowserGrid.appendChild(empty);
      return;
    }
    // Every commented photo (not just the filtered/visible ones) so
    // prev/next inside the opened photo modal steps through the full set,
    // same as a tag group does — the search box only narrows what's shown
    // here, not what you can browse once you're inside a photo.
    const group = { label: "Comments", items: commentBrowserItems.map(it => ({ nodeId: it.nodeId, r: it.r, c: it.c, id: it.id })) };
    filtered.forEach((it) => {
      const node = findNode(it.nodeId);
      if (!node) return; // stale entry (shouldn't normally happen)
      const cell = document.createElement("div");
      cell.className = "tagbrowser-gallery-item";

      const thumb = document.createElement("img");
      thumb.className = "tagbrowser-gallery-thumb";
      thumb.alt = "";
      const thumbUrl = photoUrl(it.id);
      if (thumbUrl) thumb.src = thumbUrl; else thumb.style.visibility = "hidden";
      thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });

      const label = document.createElement("span");
      label.className = "tagbrowser-gallery-label";
      label.textContent = it.nodeLabel;

      const excerpt = document.createElement("span");
      excerpt.className = "commentbrowser-excerpt";
      excerpt.textContent = it.comment.length > 140 ? it.comment.slice(0, 140) + "…" : it.comment;

      cell.append(thumb, label, excerpt);
      cell.addEventListener("click", () => {
        const host = browserItemHost(node, it);
        const idx = host ? getNodeImageIds(host).indexOf(it.id) : -1;
        if (idx < 0) return;
        const ret = makeBrowserReturn("Photo comments", commentBrowserGrid, openCommentBrowserModal, null);
        closeCommentBrowserModal();
        withViewerReturn(ret, () => openBrowserPhotoItem(it, idx, group));
      });
      commentBrowserGrid.appendChild(cell);
    });
  }

  $("#btn-commentbrowser").addEventListener("click", openCommentBrowserModal);
  $("#commentbrowser-close").addEventListener("click", closeCommentBrowserModal);
  commentBrowserModal.addEventListener("click", (e) => { if (e.target === commentBrowserModal) closeCommentBrowserModal(); });
  commentBrowserSearch.addEventListener("input", renderCommentBrowserGrid);
  document.addEventListener("keydown", (e) => {
    if (commentBrowserModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeCommentBrowserModal();
  });

