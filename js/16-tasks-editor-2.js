/* Branchline — js/16-tasks-editor-2.js
   Part 16 of 19 of the former single-file app.js. Contents: tasks editor (part 2).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  // Right-click (or long-press on touch) menu for a single subtask pill —
  // replaces the hover-only copy (⧉) and delete (×) buttons that used to
  // sit inside every pill. Reuses the shared ctx-menu element.
  function copySubtaskText(text) {
    const done = () => showToast("Subtask copied");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      // Fallback for contexts without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (err) {}
      document.body.removeChild(ta);
      done();
    }
  }
  function openSubtaskContextMenu(x, y, t, s, rerender, openNotes) {
    resetContextMenu();
    ctxMenu.classList.add("subtask-context-menu");
    const addItem = (label, cls, fn) => {
      const it = document.createElement("div");
      it.className = "ctx-item" + (cls ? " " + cls : "");
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.textContent = label;
      it.appendChild(labelSpan);
      it.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); fn(); });
      ctxMenu.appendChild(it);
    };
    if (openNotes) {
      const n = getTaskNotes(s).length;
      addItem(n ? `📝 Notes (${n})…` : "📝 Add note…", "", openNotes);
    }
    addItem("Rename", "", () => {
      if (!requireSignIn()) return;
      const next = prompt("Rename subtask", s.text || "");
      if (next === null) return;
      const clean = next.trim();
      if (!clean || clean === (s.text || "")) return;
      pushUndo();
      s.text = clean;
      syncSubtaskNoteTitles(s);
      persist();
      rerender();
    });
    addItem(s.done ? "↩ Mark undone" : "✓ Mark done", "", () => {
      pushUndo();
      setSubtaskDone(t, s, !s.done);
      persist();
      rerender();
    });
    addItem(s.failed ? "\u21a9 Clear failed" : "Mark failed", "", () => {
      pushUndo();
      setSubtaskFailed(t, s, !s.failed);
      persist();
      rerender();
    });
    addItem(s.emergencyGlow ? "🚨 Turn off emergency glow" : "🚨 Emergency glow", "", () => {
      if (!requireSignIn()) return;
      pushUndo();
      s.emergencyGlow = !s.emergencyGlow;
      persist();
      rerender();
    });
    addItem("Copy text", "", () => copySubtaskText(s.text));
    addItem("↔ Move", "", () => {
      if (!requireSignIn()) return;
      subtaskTouchMoveMode = { taskId: t.id, subtaskId: s.id };
      document.querySelectorAll(".subtask-row.subtask-move-ready").forEach(el => el.classList.remove("subtask-move-ready"));
      const armed = tasksListEl && tasksListEl.querySelector(`.subtask-row[data-task-id="${CSS.escape(t.id)}"][data-subtask-id="${CSS.escape(s.id)}"]`);
      if (armed) armed.classList.add("subtask-move-ready");
      showToast("Move ready — drag this subtask");
    });

    // Add/remove a visual break AFTER this pill by storing brBefore on
    // the following subtask. Both Tasks and Calendar already render it.
    const menuSubs = getTaskSubtasks(t);
    const menuIndex = menuSubs.findIndex(x => x.id === s.id);
    const menuNext = menuIndex >= 0 && menuIndex < menuSubs.length - 1
      ? menuSubs[menuIndex + 1]
      : null;
    if (menuNext) {
      addItem(menuNext.brBefore ? "Remove line break" : "Add line break", "", () => {
        if (!requireSignIn()) return;
        pushUndo();
        if (menuNext.brBefore) delete menuNext.brBefore;
        else menuNext.brBefore = 1;
        persist();
        rerender();
      });
    }

    addItem("Move to Queue Tasks", "", () => {
      if (!requireSignIn()) return;
      const queue = getDRCQueueItems().slice();
      const deleted = getDeletedDRCQueueItems();

      pushUndo();

      // Remove it from its current normal task.
      t.subtasks = getTaskSubtasks(t).filter(x => x !== s);
      syncTaskDoneFromSubtasks(t);

      // Keep the complete subtask object (including notes/state) when it
      // becomes a Queue item, and mark it fresh for shared Queue sync.
      s.updatedAt = Date.now();
      queue.push(s);
      if (deleted[s.id]) delete deleted[s.id];
      saveDRCQueueItems(queue);
      saveDeletedDRCQueueItems(deleted);
      scheduleTaskTemplateSync();

      persist();
      rerender();
      showToast("Moved to Queue Tasks");
    });
    addItem("Move to another node…", "", () => {
      openSubtaskMoveToNodePopover(x, y, t, s);
    });
    addItem("Delete subtask", "danger", () => {
      if (!requireSignIn()) return;
      if (!confirm(`Delete the subtask "${s.text || "Untitled subtask"}"?`)) return;
      pushUndo();
      t.subtasks = getTaskSubtasks(t).filter(x => x !== s);
      syncTaskDoneFromSubtasks(t);
      persist();
      rerender();
    });
    positionContextMenu(x, y);
  }

  // Right-click / long-press menu for a task row. Phone task text stays
  // read-only until Rename is explicitly chosen here, preventing an
  // accidental tap from summoning the on-screen keyboard.
  function openTaskContextMenu(x, y, host, t, rerender, opts = {}) {
    resetContextMenu();
    const addItem = (label, cls, fn) => {
      const it = document.createElement("div");
      it.className = "ctx-item" + (cls ? " " + cls : "");
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.textContent = label;
      it.appendChild(labelSpan);
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        fn();
      });
      ctxMenu.appendChild(it);
    };

    const chooseDueDate = () => {
      const input = document.createElement("input");
      input.type = "date";
      input.value = t.due || "";
      input.style.position = "fixed";
      input.style.left = "-10000px";
      input.style.top = "0";
      document.body.appendChild(input);
      const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
      input.addEventListener("change", () => {
        pushUndo();
        t.due = input.value || null;
        persist();
        rerender();
        cleanup();
      }, { once:true });
      input.addEventListener("blur", () => setTimeout(cleanup, 0), { once:true });
      try {
        if (input.showPicker) input.showPicker();
        else input.click();
      } catch (err) {
        input.click();
      }
    };

    addItem("Rename", "", () => {
      if (!requireSignIn()) return;
      const next = prompt("Rename task", t.text || "");
      if (next === null) return;
      const clean = next.trim();
      if (!clean || clean === (t.text || "")) return;
      pushUndo();
      t.text = clean;
      persist();
      rerender();
    });

    if (opts.openNotes) {
      const n = getTaskNotes(t).length;
      addItem(n ? `📝 Notes (${n})…` : "📝 Add note…", "", opts.openNotes);
    }

    addItem("＋ Add subtask", "", () => {
      collapsedSubtaskIds.delete(t.id);
      subtaskAddOpenFor.add(t.id);
      rerender();
    });
    addItem(t.done ? "↩ Mark undone" : "✓ Mark done", "", () => {
      if (!requireSignIn()) return;
      pushUndo();
      setTaskDone(t, !t.done);
      persist();
      rerender();
    });
    addItem(t.failed ? "↩ Clear failed" : "Mark failed", "", () => {
      if (!requireSignIn()) return;
      pushUndo();
      setTaskFailed(t, !t.failed);
      persist();
      rerender();
    });
    addItem(getTaskStars(t) > 0 ? "☆ Remove star" : "★ Star task", "", () => {
      if (!requireSignIn()) return;
      if (!getTaskStars(t) && (blockedByStarCap(host, t) || blockStarIfTooManySubtasks(t))) return;
      pushUndo();
      t.stars = getTaskStars(t) > 0 ? 0 : 1;
      t.starred = t.stars > 0;
      persist();
      rerender();
    });
    addItem("🎨 Color…", "", () => openTaskColorPopoverAt(x, y, t, rerender));
    addItem(t.due ? `📅 Due: ${t.due}…` : "📅 Set due date…", "", chooseDueDate);
    if (t.due) {
      addItem("Clear due date", "", () => {
        if (!requireSignIn()) return;
        pushUndo();
        t.due = null;
        persist();
        rerender();
      });
    }
    if (opts.jumpToNode) addItem("Jump to node", "", opts.jumpToNode);

    addItem("Move to Queue Tasks", "", () => {
      if (!requireSignIn()) return;

      const subtasks = getTaskSubtasks(t).slice();
      const queueItems = subtasks.length ? subtasks : [t];
      const queue = getDRCQueueItems().slice();
      const deleted = getDeletedDRCQueueItems();
      const now = Date.now();

      pushUndo();

      // A task with subtasks contributes only its subtasks to Queue Tasks.
      // A standalone task itself becomes one queue subtask.
      queueItems.forEach((item, index) => {
        item.updatedAt = now + index;
        queue.push(item);
        if (deleted[item.id]) delete deleted[item.id];
      });

      // In both cases the original normal task is gone after the move.
      host.tasks = getNodeTasks(host).filter(x => x !== t);

      saveDRCQueueItems(queue);
      saveDeletedDRCQueueItems(deleted);
      scheduleTaskTemplateSync();

      persist();
      rerender();
      showToast(subtasks.length
        ? `Moved ${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"} to Queue Tasks`
        : "Moved task to Queue Tasks");
    });

    addItem("Delete task", "danger", () => {
      if (!requireSignIn()) return;
      if (!confirm(`Delete the task "${t.text || "Untitled task"}"?`)) return;
      pushUndo();
      host.tasks = getNodeTasks(host).filter(x => x !== t);
      persist();
      rerender();
    });
    positionContextMenu(x, y);
  }

  function installTaskContextLongPress(row, openMenu) {
    // Open slightly before Android/Chromium's native long-press text
    // selection normally kicks in. Scrolling still cancels via movement.
    const HOLD_MS = 420;
    const MOVE_TOLERANCE_SQ = 144;
    let timer = null;
    let pointerId = null;
    let startX = 0, startY = 0;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pointerId = null;
    };

    row.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      if (e.isPrimary === false) return;
      if (!window.matchMedia("(max-width: 640px)").matches) return;
      // Controls keep their own tap/hold behavior. The task background
      // and task text are the menu targets.
      if (e.target.closest && e.target.closest(
        "button,input,.task-checkbox,.task-fail-btn,.task-star,.task-color-dot,.task-delete,.task-drag-handle,.task-note-btn,.task-due-btn,.task-subtask-btn,.task-source-node"
      )) return;
      if (e.target.closest && e.target.closest('[contenteditable="true"]')) return;

      cancel();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        row.__taskLongPressConsumed = true;
        clearTimeout(row.__taskLongPressResetTimer);
        row.__taskLongPressResetTimer = setTimeout(() => {
          row.__taskLongPressConsumed = false;
        }, 900);
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
        closeContextMenu();
        openMenu(startX, startY);
      }, HOLD_MS);
    }, { passive: true });

    row.addEventListener("pointermove", (e) => {
      if (pointerId == null || e.pointerId !== pointerId || !timer) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if ((dx * dx + dy * dy) > MOVE_TOLERANCE_SQ) cancel();
    }, { passive: true });
    row.addEventListener("pointerup", cancel, { passive: true });
    row.addEventListener("pointercancel", cancel, { passive: true });

    row.addEventListener("click", (e) => {
      if (!row.__taskLongPressConsumed) return;
      e.preventDefault();
      e.stopPropagation();
      row.__taskLongPressConsumed = false;
    }, true);
  }

  // Mobile browsers do not reliably synthesize `contextmenu` for an element
  // that is also draggable (our subtask pills are).  Give touch/pen input an
  // explicit long-press detector instead.  A small movement tolerance keeps
  // normal vertical scrolling from opening the menu, and the consumed flag
  // suppresses the synthetic click many browsers emit after the hold —
  // otherwise a successful long-press would also toggle the subtask done.
  function installSubtaskLongPress(row, openMenu) {
    // v462 phone gesture:
    //   hold -> menu only
    //   choose Move in that menu -> arm this pill
    //   then drag it directly (no second hold required)
    // Ordinary touch movement remains scrolling, so menu vs drag cannot be confused.
    const MENU_MS = 520;
    const MOVE_SQ = 144; // 12px
    let menuTimer = null;
    let pointerId = null;
    let startX = 0, startY = 0;
    let dragArmed = false, dragging = false;
    let ghost = null, hoverTarget = null;

    const clearTimers = () => {
      if (menuTimer) clearTimeout(menuTimer);
      menuTimer = null;
    };
    const clearHover = () => {
      tasksListEl.querySelectorAll(".subtask-row.drag-over-top, .subtask-row.drag-over-bottom")
        .forEach(el => el.classList.remove("drag-over-top", "drag-over-bottom"));
      tasksListEl.querySelectorAll(".task-row.subtask-drop-target, .subtask-panel.subtask-drop-target")
        .forEach(el => el.classList.remove("subtask-drop-target"));
      hoverTarget = null;
    };
    const removeGhost = () => {
      if (ghost) ghost.remove();
      ghost = null;
    };
    const reset = () => {
      clearTimers();
      clearHover();
      removeGhost();
      row.classList.remove("task-dragging", "subtask-touch-drag-armed");
      if (dragging) subtaskDragState = null;
      pointerId = null;
      dragArmed = false;
      dragging = false;
    };
    const markConsumed = () => {
      row.__subtaskLongPressConsumed = true;
      clearTimeout(row.__subtaskLongPressResetTimer);
      row.__subtaskLongPressResetTimer = setTimeout(() => {
        row.__subtaskLongPressConsumed = false;
      }, 900);
    };
    const beginTouchDrag = (e) => {
      if (dragging || !dragArmed) return;
      if (!requireSignIn()) { reset(); return; }
      clearTimers();
      dragging = true;
      markConsumed();
      closeContextMenu();
      subtaskDragState = {
        taskId: row.dataset.taskId,
        subtaskId: row.dataset.subtaskId
      };
      row.classList.remove("subtask-touch-drag-armed");
      row.classList.add("task-dragging");
      ghost = row.cloneNode(true);
      ghost.classList.remove("task-dragging");
      ghost.classList.add("subtask-touch-drag-ghost");
      ghost.removeAttribute("id");
      document.body.appendChild(ghost);
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) {}
    };
    const moveGhost = (x, y) => {
      if (!ghost) return;
      ghost.style.left = x + "px";
      ghost.style.top = y + "px";
    };
    const findDrop = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const subRow = el.closest && el.closest(".subtask-row");
      if (subRow && subRow !== row) {
        const taskId = subRow.dataset.taskId;
        if (taskId === subtaskDragState.taskId) {
          const r = subRow.getBoundingClientRect();
          return {
            kind: "subtask",
            taskId,
            subtaskId: subRow.dataset.subtaskId,
            before: x < (r.left + r.right) / 2,
            el: subRow
          };
        }
        // Crossing tasks: the entire destination task card is the target.
        const panel = subRow.closest(".subtask-panel");
        return { kind: "task", taskId: panel?.dataset.taskId || taskId, el: panel || subRow };
      }
      const panel = el.closest && el.closest(".subtask-panel[data-task-id]");
      if (panel) return { kind: "task", taskId: panel.dataset.taskId, el: panel };
      const taskRow = el.closest && el.closest(".task-row[data-task-id]");
      if (taskRow) return { kind: "task", taskId: taskRow.dataset.taskId, el: taskRow };
      return null;
    };
    const paintDrop = (target) => {
      clearHover();
      hoverTarget = target;
      if (!target) return;
      if (target.kind === "subtask") {
        target.el.classList.toggle("drag-over-top", !!target.before);
        target.el.classList.toggle("drag-over-bottom", !target.before);
      } else {
        target.el.classList.add("subtask-drop-target");
        const id = target.taskId;
        tasksListEl.querySelectorAll(`.task-row[data-task-id="${CSS.escape(id)}"], .subtask-panel[data-task-id="${CSS.escape(id)}"]`)
          .forEach(el => el.classList.add("subtask-drop-target"));
      }
    };

    row.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      if (e.isPrimary === false) return;
      if (e.target.closest && e.target.closest('[contenteditable="true"]')) return;
      reset();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const explicitlyArmed = !!subtaskTouchMoveMode &&
        subtaskTouchMoveMode.taskId === row.dataset.taskId &&
        subtaskTouchMoveMode.subtaskId === row.dataset.subtaskId;
      dragArmed = explicitlyArmed;
      row.classList.toggle("subtask-touch-drag-armed", explicitlyArmed);
      if (!explicitlyArmed) menuTimer = setTimeout(() => {
        menuTimer = null;
        if (pointerId == null || dragging) return;
        dragArmed = false;
        row.classList.remove("subtask-touch-drag-armed");
        markConsumed();
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
        closeContextMenu();
        openMenu(startX, startY);
      }, MENU_MS);
    }, { passive: true });

    row.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const moved = (dx * dx + dy * dy) > MOVE_SQ;
      if (!moved) return;

      if (!dragArmed && !dragging) {
        // v463: without explicit Move mode, movement is always normal scrolling.
        reset();
        return;
      }
      if (!dragging) beginTouchDrag(e);
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      moveGhost(e.clientX, e.clientY);
      paintDrop(findDrop(e.clientX, e.clientY));
    }, { passive: false });

    const finish = (e, cancelled) => {
      if (e.pointerId !== pointerId) return;
      if (dragging) {
        e.preventDefault();
        e.stopPropagation();
        const target = cancelled ? null : (hoverTarget || findDrop(e.clientX, e.clientY));
        const sourceTaskId = subtaskDragState && subtaskDragState.taskId;
        const sourceSubtaskId = subtaskDragState && subtaskDragState.subtaskId;
        if (target && sourceTaskId && sourceSubtaskId) {
          if (target.kind === "subtask") {
            moveSubtask(sourceTaskId, sourceSubtaskId, target.taskId, target.subtaskId, target.before);
          } else if (target.taskId !== sourceTaskId) {
            moveSubtask(sourceTaskId, sourceSubtaskId, target.taskId, null, false);
          }
        }
      }
      if (dragging) {
        subtaskTouchMoveMode = null;
        document.querySelectorAll(".subtask-row.subtask-move-ready").forEach(el => el.classList.remove("subtask-move-ready"));
      }
      reset();
    };
    row.addEventListener("pointerup", (e) => finish(e, false), { passive: false });
    row.addEventListener("pointercancel", (e) => finish(e, true), { passive: false });

    row.addEventListener("click", (e) => {
      if (!row.__subtaskLongPressConsumed) return;
      e.preventDefault();
      e.stopPropagation();
      row.__subtaskLongPressConsumed = false;
    }, true);
  }

  // Builds the expanded subtask checklist panel for one task — a nested
  // <li> (so it sits inline in the same <ul> right under its task row)
  // holding a checkbox list plus a small "add subtask" input.
  function renderSubtaskPanel(node, t) {
    const wrap = document.createElement("li");
    wrap.className = "subtask-panel";
    wrap.dataset.taskId = t.id;
    // Keep the panel's fill in sync with its task row's own color tint
    // (rather than the flat --panel-2 default), so a colored task and
    // its open subtask list read as one continuous, matching card.
    wrap.style.background = taskColorTint(getTaskColor(t)) || "";

    // The task header row and this panel are visually one card, but they
    // are sibling <li>s in the DOM. Make the ENTIRE panel a target when
    // moving a subtask from another task, including empty space around/
    // between its existing subtask pills.
    const setWholeTaskDropHighlight = (on) => {
      wrap.classList.toggle("subtask-drop-target", !!on);
      const taskRow = tasksListEl.querySelector(`.task-row[data-task-id="${t.id}"]`);
      if (taskRow) taskRow.classList.toggle("subtask-drop-target", !!on);
    };
    wrap.addEventListener("dragover", (e) => {
      if (!subtaskDragState || subtaskDragState.taskId === t.id) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setWholeTaskDropHighlight(true);
    });
    wrap.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
      setWholeTaskDropHighlight(false);
    });
    wrap.addEventListener("drop", (e) => {
      if (!subtaskDragState || subtaskDragState.taskId === t.id) return;
      e.preventDefault();
      e.stopPropagation();
      setWholeTaskDropHighlight(false);
      moveSubtask(
        subtaskDragState.taskId,
        subtaskDragState.subtaskId,
        t.id,
        null,
        false
      );
    });

    const list = document.createElement("ul");
    list.className = "subtask-list";

    getTaskSubtasks(t).forEach((s) => {
      const row = document.createElement("li");
      row.className = "subtask-row" + (s.done ? " done" : "") + (s.failed ? " failed" : "") + (s.emergencyGlow ? " emergency-glow" : "") + (!s.done && !s.failed && s.id === randomPickedSubtaskId ? " picked" : "");
      row.dataset.taskId = t.id;
      row.dataset.subtaskId = s.id;

      row.addEventListener("dragover", (e) => {
        if (!subtaskDragState) return;

        // Crossing into ANOTHER task: don't make the user aim at this
        // individual pill. Let the event bubble to the parent subtask-panel,
        // whose full rectangle represents the target task card.
        if (subtaskDragState.taskId !== t.id) return;

        // Within the SAME task, individual pills still provide precise
        // left/right reordering exactly as before.
        if (subtaskDragState.subtaskId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        row.classList.toggle("drag-over-top", before);
        row.classList.toggle("drag-over-bottom", !before);
      });
      row.addEventListener("dragleave", (e) => {
        if (e.relatedTarget && row.contains(e.relatedTarget)) return;
        row.classList.remove("drag-over-top", "drag-over-bottom");
      });
      row.addEventListener("drop", (e) => {
        if (!subtaskDragState) return;
        if (subtaskDragState.taskId !== t.id) return; // whole task card handles it
        if (subtaskDragState.subtaskId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        row.classList.remove("drag-over-top", "drag-over-bottom");
        moveSubtask(subtaskDragState.taskId, subtaskDragState.subtaskId, t.id, s.id, before);
      });

      // Desktop: whole-pill drag to reorder. Phone: dragging is disabled;
      // a long hold opens the subtask menu instead.
      const subtaskPhoneMode = window.matchMedia("(max-width: 640px)").matches;
      row.draggable = !subtaskPhoneMode;
      row.addEventListener("dragstart", (e) => startSubtaskDrag(e, row, t.id, s.id));
      row.addEventListener("dragend", () => endSubtaskDrag(row));

      const stext = document.createElement("span");
      stext.className = "subtask-text";
      stext.contentEditable = "false";
      stext.spellcheck = false;
      stext.textContent = s.text;
      // Skip the auto color once done — the .subtask-row.done .subtask-text
      // rule (dim + strikethrough) is the done indicator and would
      // otherwise be masked by this inline color, which always wins.
      if (!s.done && !s.failed) stext.style.color = taskFontColor(t);
      // The pill ellipsizes long text, so the title tooltip is the only
      // way to read it in full without double-clicking into edit mode.
      stext.title = s.text;

      // No more checkbox — a single click anywhere on the pill (other
      // than its note icon, or while its text is
      // mid-edit) toggles done. A short timer tells a single click apart
      // from the first half of a double-click, which opens text editing
      // instead (see the dblclick handler right below).
      let subtaskClickTimer = null;
      row.addEventListener("click", (e) => {
        if (row.__subtaskLongPressConsumed) {
          e.preventDefault();
          e.stopPropagation();
          row.__subtaskLongPressConsumed = false;
          if (subtaskClickTimer) { clearTimeout(subtaskClickTimer); subtaskClickTimer = null; }
          return;
        }
        if (stext.contentEditable === "true") return;
        // Phone: require the long-press/right-click menu for done/undone.
        if (subtaskPhoneMode) return;
        if (subtaskClickTimer) { clearTimeout(subtaskClickTimer); subtaskClickTimer = null; return; }
        subtaskClickTimer = setTimeout(() => {
          subtaskClickTimer = null;
          pushUndo();
          setSubtaskDone(t, s, !s.done);
          persist();
          renderTasksModal();
        }, 220);
      });

      stext.addEventListener("dblclick", (e) => {
        e.preventDefault();
        row.draggable = false;
        stext.contentEditable = "true";
        stext.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(stext);
        sel.removeAllRanges();
        sel.addRange(range);
      });
      // v508: save an in-progress subtask rename on every keystroke too.
      const subtaskEditOriginal = s.text;
      const subtaskBrainstormBefore = isBrainstormPrefixText(s.text) || hasBrainstormContent(s);
      let subtaskEditUndoPushed = false;
      stext.addEventListener("input", () => {
        if (!subtaskEditUndoPushed) { pushUndo(); subtaskEditUndoPushed = true; }
        s.text = stext.textContent;
        syncSubtaskNoteTitles(s);
        persist();
      });
      stext.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); stext.blur(); }
        else if (e.key === "Escape") {
          e.preventDefault();
          s.text = subtaskEditOriginal;
          stext.textContent = subtaskEditOriginal;
          syncSubtaskNoteTitles(s);
          persist();
          stext.blur();
        }
      });
      stext.addEventListener("blur", () => {
        const v = stext.textContent.trim();
        if (v) {
          if (v !== s.text) {
            s.text = v;
            syncSubtaskNoteTitles(s);
            persist();
          }
        } else {
          s.text = subtaskEditOriginal;
          stext.textContent = subtaskEditOriginal;
          syncSubtaskNoteTitles(s);
          persist();
        }
        const brainstormVisibilityChanged = subtaskBrainstormBefore !== (isBrainstormPrefixText(s.text) || hasBrainstormContent(s));
        stext.textContent = s.text;
        stext.title = s.text;
        stext.contentEditable = "false";
        row.draggable = !window.matchMedia("(max-width: 640px)").matches;
        if (brainstormVisibilityChanged) renderTasksModal();
      });

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Desktop keeps right-click; phone uses the explicit long-press
        // handler below so the browser's native context menu stays suppressed.
        if (window.matchMedia("(max-width: 640px) and (any-pointer: coarse)").matches) return;
        if (row.__subtaskLongPressConsumed) return;
        openSubtaskContextMenu(e.clientX, e.clientY, t, s, () => renderTasksModal(), openSubtaskNotes);
      });

      // Notes on a subtask — same editor as a task's notes (see
      // openNoteModal's subtaskId). Added from the right-click menu; once
      // a subtask has notes, a small note icon on the pill opens them directly.
      const openSubtaskNotes = () => {
        const target = tasksEditingTarget;
        if (!target) return;
        openNoteModal(node.id, undefined, null, t.id, target.r != null ? { r: target.r, c: target.c } : null, false, s.id);
      };
      installSubtaskLongPress(row, (x, y) => {
        openSubtaskContextMenu(x, y, t, s, () => renderTasksModal(), openSubtaskNotes);
      });
      const subtaskNotesForS = getTaskNotes(s);
      // A subtask literally named "DRC" behaves exactly like a task named
      // "DRC" (see the redirect in openNoteModal above): it shares the
      // node's single DRC note rather than owning one of its own, so the
      // icon shows up front — before any note exists — the same way a
      // DRC task's note button always shows the DRC image (see
      // taskNotes/noteBtn above).
      const subtaskIsDRC = isDRCNote(subtaskNotesForS[0]) || (s.text || "").trim().toUpperCase() === "DRC";
      // Same idea for a subtask named "plan": isPlanNoteFor also checks the
      // subtask's own name, so the plan icon shows up front — before any
      // note exists — just like the DRC icon does, and like a "plan" task's
      // note button already does.
      const subtaskIsPlan = isPlanNoteFor(subtaskNotesForS[0], s);

      // "brainstorm..." prefix behaves like the DRC special-name affordance:
      // the icon exists before there is any content. Unlike DRC, Brainstorm
      // is its own scratchpad type (host.brainstorm), not a rich note, so this
      // icon opens the existing Brainstorm editor directly on this subtask.
      const subtaskIsBrainstorm = subtaskHasBrainstormMarker(s);
      let brainstormIcon = null;
      if (subtaskIsBrainstorm) {
        brainstormIcon = document.createElement("span");
        brainstormIcon.className = "subtask-note-icon subtask-brainstorm-icon";
        brainstormIcon.textContent = "🧠";
        brainstormIcon.title = hasBrainstormContent(s) ? "Brainstorm — tap to keep writing" : "Brainstorm — tap to start";
        brainstormIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          const target = tasksEditingTarget;
          if (!target) return;
          openBrainstormModal(
            node.id,
            target.r != null ? target.r : null,
            target.c != null ? target.c : null,
            t.id,
            s.id
          );
        });
      }

      let snote = null;
      if (subtaskNotesForS.length || subtaskIsDRC || subtaskIsPlan) {
        snote = document.createElement("span");
        snote.className = "subtask-note-icon";
        if (subtaskIsDRC) snote.appendChild(drcIconEl(13));
        else if (subtaskIsPlan) snote.appendChild(planIconEl(13));
        else snote.innerHTML = CELL_NOTE_ICON_SVG; // same sticky-note icon as everywhere else
        snote.title = subtaskNotesForS.length ? `Notes (${subtaskNotesForS.length})` : "Add note";
        snote.addEventListener("click", (e) => { e.stopPropagation(); openSubtaskNotes(); });
      }

      // No inline menu/drag button on phone — hold the pill to open its menu.
      row.appendChild(stext);
      if (brainstormIcon) row.appendChild(brainstormIcon);
      if (snote) row.appendChild(snote);
      list.appendChild(row);
    });

    // "+" trigger for adding another subtask now lives at the end of
    // this task's own subtask list (it used to sit on the main task
    // row) — hidden while the add-input below is already open, so the
    // two don't show at once.
    if (!subtaskAddOpenFor.has(t.id)) {
      const addTriggerLi = document.createElement("li");
      addTriggerLi.className = "subtask-add-trigger";
      const addTriggerBtn = document.createElement("button");
      addTriggerBtn.type = "button";
      addTriggerBtn.className = "subtask-add-btn";
      addTriggerBtn.title = "Add a subtask";
      addTriggerBtn.textContent = "+";
      addTriggerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        subtaskAddOpenFor.add(t.id);
        renderTasksModal();
      });
      addTriggerLi.appendChild(addTriggerBtn);
      list.appendChild(addTriggerLi);
    }

    enhanceSubtaskList(list, t, () => renderTasksModal());
    wrap.appendChild(list);

    // The "+" trigger itself now lives on the main task row, next to its
    // timer, so it's reachable without opening the panel first. This add
    // row only needs to exist while that trigger has put it into "open"
    // (typing) mode.
    if (subtaskAddOpenFor.has(t.id)) {
      const addRow = document.createElement("div");
      addRow.className = "subtask-add-row";

      const addInput = document.createElement("textarea");
      addInput.rows = 1;
      addInput.className = "subtask-new-input autosize-input";
      addInput.placeholder = "Add a subtask and press Enter…";
      addInput.spellcheck = false;
      addInput.dataset.taskId = t.id;
      addInput.addEventListener("click", (e) => e.stopPropagation());
      addInput.addEventListener("input", () => autosizeTextarea(addInput));
      addInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const v = addInput.value.trim();
          if (!v) return;
          if (blockStarredTaskSubtaskOverflow(t)) return;
          pushUndo();
          if (!Array.isArray(t.subtasks)) t.subtasks = [];
          t.subtasks.push({ id: uid(), text: v, done: false });
          // A brand-new subtask is unchecked, so the parent can no longer
          // be considered fully done (or fully failed).
          t.done = false;
          t.failed = false;
          persist();
          renderTasksModal();
          // Re-render rebuilds the DOM, so re-focus the (new) input for
          // this same task, letting the person add several in a row.
          requestAnimationFrame(() => {
            const el = tasksListEl.querySelector(`.subtask-new-input[data-task-id="${t.id}"]`);
            if (el) el.focus();
          });
        } else if (e.key === "Escape") {
          e.preventDefault();
          addInput.blur();
        }
      });
      addInput.addEventListener("blur", () => {
        // Nothing typed — collapse the input away again. A pending value
        // is left as-is (re-opening keeps it) rather than lost.
        if (!addInput.value.trim()) {
          subtaskAddOpenFor.delete(t.id);
          renderTasksModal();
        }
      });
      addRow.appendChild(addInput);
      wrap.appendChild(addRow);
      requestAnimationFrame(() => addInput.focus());
    }

    return wrap;
  }

  // v543: Task score/count changes must repaint their node/cell badge while
  // the Task List is still open. Previously the canonical badge was usually
  // refreshed only when Tasks closed, which made Calendar badges look delayed.
  // Cache the score signature so UI-only Task renders (expand/collapse, focus
  // timer ticks, etc.) do not trigger expensive map/Calendar redraws.
  let liveTaskBadgeSignature = "";
  function syncOpenTaskBadgeUI(target, host) {
    if (!target || !host) return;
    const prog = nodeTaskProgress(host);
    const sig = [
      target.nodeId, target.r == null ? "" : target.r, target.c == null ? "" : target.c,
      getNodeTasks(host).length, Number(prog.done) || 0, Number(prog.total) || 0
    ].join("|");
    if (sig === liveTaskBadgeSignature) return;
    liveTaskBadgeSignature = sig;

    // Paint from the already-mutated in-memory task objects first. Never wait
    // for IndexedDB/Drive persistence before the badge reflects the edit.
    refreshNodeOrRenderAll(target.nodeId);
    if (calendarModal && !calendarModal.classList.contains("hidden")) {
      renderCalendar();
    }
  }

  function renderTasksModal() {
    const target = tasksEditingTarget;
    if (!target) return;
    const node = findNode(target.nodeId);
    const host = resolveHost(target.nodeId, target.r, target.c);
    if (!node || !host) { closeTasksModal(); return; }
    renderFocusTimerWidget();
    const tasks = getNodeTasks(host);
    tasksListEl.innerHTML = "";
    renderSharedQueueTask();
    if (Date.now() - taskTemplateLastSyncAt > 5000 && !taskTemplateSyncRunning) {
      syncTaskTemplatesWithDrive().then((changed) => {
        if (changed && tasksEditingTarget) renderTasksModal();
      });
    }
    tasks.forEach((t) => {
      const li = document.createElement("li");
      const subProg = taskSubtaskProgress(t);
      // The panel (and its border/fill) should only ever appear for a task
      // that actually has subtasks, or one whose "+" button was just
      // clicked to start adding its first one — not for every plain task
      // by default.
      const subExpanded = (subProg.total > 0 || subtaskAddOpenFor.has(t.id)) && !collapsedSubtaskIds.has(t.id);
      const showingSubtasks = subExpanded && subProg.total > 0;
      li.className = "task-row" + (t.done ? " done" : "") + (t.failed ? " failed" : "") + (getTaskStars(t) > 0 ? " starred" : "") + (showingSubtasks ? " has-open-subtasks" : "");
      li.dataset.taskId = t.id;
      const rowColor = getTaskColor(t);
      li.style.background = taskColorTint(rowColor) || "";

      li.addEventListener("dragover", (e) => {
        if (taskDragState && taskDragState.taskId !== t.id) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = li.getBoundingClientRect();
          const before = (e.clientY - rect.top) < rect.height / 2;
          li.classList.toggle("drag-over-top", before);
          li.classList.toggle("drag-over-bottom", !before);
        } else if (subtaskDragState) {
          // A subtask dragged onto a task's own row (rather than one of
          // its existing subtask rows) — drop it at the end of this
          // task's subtask list. Works for a different task or, just as
          // well, sending it to the bottom of its own current task.
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          li.classList.add("subtask-drop-target");
        }
      });
      li.addEventListener("dragleave", (e) => {
        if (e.relatedTarget && li.contains(e.relatedTarget)) return;
        li.classList.remove("drag-over-top", "drag-over-bottom", "subtask-drop-target");
      });
      li.addEventListener("drop", (e) => {
        if (taskDragState && taskDragState.taskId !== t.id) {
          e.preventDefault();
          const rect = li.getBoundingClientRect();
          const before = (e.clientY - rect.top) < rect.height / 2;
          li.classList.remove("drag-over-top", "drag-over-bottom");
          reorderTask(taskDragState.taskId, t.id, before);
        } else if (subtaskDragState) {
          e.preventDefault();
          li.classList.remove("subtask-drop-target");
          moveSubtask(subtaskDragState.taskId, subtaskDragState.subtaskId, t.id, null, false);
        }
      });

      const handle = document.createElement("span");
      handle.className = "task-drag-handle";
      handle.textContent = "⠿";
      handle.title = window.matchMedia("(max-width: 640px)").matches
        ? "Hold to drag"
        : "Drag to reorder";
      handle.draggable = !window.matchMedia("(max-width: 640px)").matches;
      handle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      handle.addEventListener("dragstart", (e) => startTaskDrag(e, li, t.id));
      handle.addEventListener("dragend", () => endTaskDrag(li));
      installTaskTouchDrag(handle, li, t.id);

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "task-checkbox";
      cb.checked = !!t.done;
      cb.addEventListener("change", () => {
        pushUndo();
        // Checking/unchecking a task with subtasks cascades to all of
        // them, mirroring the auto-complete-parent behavior below.
        // (Marking done also clears a failed mark.)
        setTaskDone(t, cb.checked);
        persist();
        renderTasksModal();
      });

      // ✗ — mark this task failed (the opposite of the done checkbox).
      const failBtn = makeTaskFailButton(!!t.failed, () => {
        pushUndo();
        setTaskFailed(t, !t.failed);
        persist();
        renderTasksModal();
      });

      const stars = getTaskStars(t);
      const star = document.createElement("button");
      star.type = "button";
      star.className = "task-star" + (stars > 0 ? " starred" : "");
      star.textContent = stars > 0 ? "★" : "☆";
      star.title = stars > 0
        ? "Starred — counts 10x toward progress. Click to clear."
        : "Star this task for priority — counts 10x toward progress";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        if (blockedByStarCap(host, t)) return;
        if (stars === 0 && blockStarIfTooManySubtasks(t)) return;
        const next = stars > 0 ? 0 : 1;
        pushUndo();
        t.stars = next;
        t.starred = t.stars > 0; // kept in sync for older code paths reading the legacy flag
        persist();
        renderTasksModal();
      });

      // Optional color label (see getTaskColor/setTaskColor) — click opens
      // the shared swatch popover. The button itself is a small hollow
      // ring in the current color (the light fill on the whole row is
      // the primary indicator), or a faint dashed ring when there isn't
      // one set yet.
      const colorBtn = document.createElement("button");
      colorBtn.type = "button";
      const taskColor = getTaskColor(t);
      colorBtn.className = "task-color-dot" + (taskColor ? "" : " task-color-dot-empty");
      if (taskColor) colorBtn.style.borderColor = taskColor;
      colorBtn.title = taskColor ? "Change color label" : "Add a color label";
      colorBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      colorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openTaskColorPopover(colorBtn, t, renderTasksModal);
      });

      const text = document.createElement("span");
      text.className = "task-text";
      const taskPhoneMode = window.matchMedia("(max-width: 640px)").matches;
      text.contentEditable = taskPhoneMode ? "false" : "true";
      text.spellcheck = false;
      text.textContent = t.text;
      // Skip the auto color once done — .task-row.done .task-text (dim)
      // is the done indicator and would otherwise be masked by this
      // inline color, which always wins over a class-based rule.
      if (!t.done && !t.failed) text.style.color = taskFontColor(t);
      // v508: keep the model + IndexedDB current on every keystroke, not
      // only on blur. This protects an in-progress rename from sudden F5/power loss.
      const taskEditOriginal = t.text;
      let taskEditUndoPushed = false;
      text.addEventListener("input", () => {
        const live = text.textContent;
        if (!taskEditUndoPushed) { pushUndo(); taskEditUndoPushed = true; }
        t.text = live;
        persist();
      });
      text.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); text.blur(); }
        else if (e.key === "Escape") {
          e.preventDefault();
          t.text = taskEditOriginal;
          text.textContent = taskEditOriginal;
          persist();
          text.blur();
        }
      });
      text.addEventListener("blur", () => {
        const v = text.textContent.trim();
        if (v) {
          if (v !== t.text) { t.text = v; persist(); }
          text.textContent = t.text;
        } else {
          t.text = taskEditOriginal;
          text.textContent = taskEditOriginal;
          persist();
        }
      });

      li.addEventListener("contextmenu", (e) => {
        if (e.target.closest("button,input,.task-checkbox,.task-fail-btn,.task-star,.task-color-dot,.task-delete,.task-drag-handle,.task-note-btn,.task-due-btn,.task-subtask-btn")) return;
        e.preventDefault();
        e.stopPropagation();
        // Phone uses the explicit long-press helper below.
        if (window.matchMedia("(max-width: 640px) and (any-pointer: coarse)").matches) return;
        openTaskContextMenu(e.clientX, e.clientY, host, t, () => renderTasksModal(), {
          openNotes: () => openNoteModal(node.id, undefined, null, t.id, target.r != null ? { r: target.r, c: target.c } : null)
        });
      });
      installTaskContextLongPress(li, (x, y) => {
        openTaskContextMenu(x, y, host, t, () => renderTasksModal(), {
          openNotes: () => openNoteModal(node.id, undefined, null, t.id, target.r != null ? { r: target.r, c: target.c } : null)
        });
      });

      // Double-clicking anywhere on the row (other than its own controls,
      // which have their own click behavior) opens/closes this task's
      // subtask panel — replaces the old separate ▸/▾ expand button.
      li.title = subExpanded
        ? "Double-click to hide subtasks"
        : (subProg.total ? `${subProg.done} of ${subProg.total} subtasks — double-click to view` : "Double-click to add subtasks");
      li.addEventListener("dblclick", (e) => {
        if (e.target.closest(".task-checkbox, .task-fail-btn, .task-star, .task-color-dot, .task-delete, .task-drag-handle, .task-note-btn, .task-due-btn, .task-text")) return;
        if (subExpanded) {
          collapsedSubtaskIds.add(t.id);
        } else {
          collapsedSubtaskIds.delete(t.id);
          // No subtasks yet — double-clicking to "expand" should behave
          // like pressing the + button: open the add-subtask input.
          if (!subProg.total) subtaskAddOpenFor.add(t.id);
        }
        renderTasksModal();
      });

      // Due date — feeds the toolbar's 📅 Calendar month view. Click
      // anywhere on the button to open a native date picker positioned
      // right over it; picking a date (or clearing it) stamps t.due as
      // a plain "YYYY-MM-DD" string, same convention as the standalone
      // Tasks app.
      const dueDate = t.due ? fromISODate(t.due) : null;
      const isOverdue = !!(dueDate && !t.done && !t.failed && dueDate < startOfToday());
      const dueBtn = document.createElement("span");
      dueBtn.className = "task-due-btn" + (t.due ? " has-due" : "") + (isOverdue ? " overdue" : "");
      dueBtn.title = t.due ? "Change or clear due date" : "Set a due date";
      const dueIcon = document.createElement("span");
      dueIcon.className = "task-due-icon";
      dueIcon.textContent = "📅";
      dueBtn.appendChild(dueIcon);
      if (t.due) {
        const dueLabel = document.createElement("span");
        dueLabel.className = "task-due-label";
        dueLabel.textContent = `${dueDate.getMonth() + 1}/${dueDate.getDate()}`;
        dueBtn.appendChild(dueLabel);
      }
      const dueInput = document.createElement("input");
      dueInput.type = "date";
      dueInput.className = "task-due-input";
      if (t.due) dueInput.value = t.due;
      dueInput.addEventListener("click", (e) => e.stopPropagation());
      dueInput.addEventListener("change", () => {
        pushUndo();
        t.due = dueInput.value || null;
        persist();
        renderTasksModal();
      });
      dueBtn.appendChild(dueInput);

      // A task's note(s) now use the exact same rich, multi-entry note
      // editor as a node's own notes (title, rich text, multiple notes
      // with paging) — see openNoteModal/getTaskNotes — just opened from
      // this one button instead of a strip of per-note icons.
      const noteBtn = document.createElement("button");
      noteBtn.type = "button";
      const taskNotes = getTaskNotes(t);
      // v464: a Brainstorm task gets the same pink brain note affordance as
      // a Brainstorm subtask. It opens the host/node's one shared Brainstorm,
      // rather than creating an ordinary task Note.
      const taskIsBrainstorm = isBrainstormPrefixText(t.text) || hasBrainstormContent(t);
      noteBtn.className = "task-note-btn" + (taskNotes.length || taskIsBrainstorm ? " has-note" : "") +
        (taskIsBrainstorm ? " task-brainstorm-note-btn" : "");
      noteBtn.title = taskIsBrainstorm
        ? "Brainstorm — tap to keep writing"
        : (taskNotes.length ? `Notes (${taskNotes.length})` : "Add note");
      if (taskIsBrainstorm) {
        noteBtn.textContent = "🧠";
      } else if (isDRCNote(taskNotes[0]) || (t.text || "").trim().toUpperCase() === "DRC") {
        noteBtn.appendChild(drcIconEl(16));
      } else if (isPlanNoteFor(taskNotes[0], t)) {
        noteBtn.appendChild(planIconEl(16));
      } else {
        noteBtn.innerHTML = CELL_NOTE_ICON_SVG;
      }
      noteBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      noteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (taskIsBrainstorm) {
          openBrainstormModal(
            node.id,
            target.r != null ? target.r : null,
            target.c != null ? target.c : null,
            t.id,
            null
          );
        } else {
          openNoteModal(node.id, undefined, null, t.id, target.r != null ? { r: target.r, c: target.c } : null);
        }
      });

      const del = document.createElement("button");
      del.className = "task-delete";
      del.title = "Delete task";
      del.textContent = "×";
      del.addEventListener("click", () => {
        if (!requireSignIn()) return;
        if (!confirm(`Delete the task "${t.text || "Untitled task"}"?`)) return;
        pushUndo();
        host.tasks = getNodeTasks(host).filter(x => x !== t);
        persist();
        renderTasksModal();
      });

      // Keep the row intentionally minimal: reorder handle and task name.
      // Add subtask now lives in the right-click / long-press menu; the
      // trailing + inside the expanded subtask panel remains unchanged.
      li.appendChild(handle);
      li.appendChild(text);
      if (taskIsBrainstorm) li.appendChild(noteBtn);
      tasksListEl.appendChild(li);

      if (subExpanded) tasksListEl.appendChild(renderSubtaskPanel(node, t));
    });

    const prog = nodeTaskProgress(host);
    tasksProgressBar.style.width = Math.round(prog.pct * 100) + "%";
    tasksProgressBar.classList.toggle("done", prog.pct >= 1);
    tasksProgressLabel.textContent = prog.total
      ? `${prog.done} of ${prog.total} done`
      : "No tasks yet";
    tasksSortStarsBtn.disabled = tasks.length < 2;
    tasksRandomBtn.disabled = unfinishedSubtasksOfHost(host).length === 0;
    if (tasksDeleteListBtn) tasksDeleteListBtn.disabled = tasks.length === 0;
    updateTaskFontColorToggleBtn();

    // v543: repaint score badge immediately after any score/count mutation.
    syncOpenTaskBadgeUI(target, host);
  }

  // 🎲 Random — picks one unfinished subtask uniformly from every task in
  // the list (not just within a single task), highlights it and scrolls
  // it into view. Avoids repeating the previous pick when there's a choice.
  function pickRandomSubtask() {
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    let pool = unfinishedSubtasksOfHost(host);
    if (!pool.length) { showToast("No unfinished subtasks to pick from"); return; }
    if (pool.length > 1) pool = pool.filter(({ s }) => s.id !== randomPickedSubtaskId);
    const { t, s } = pool[Math.floor(Math.random() * pool.length)];
    randomPickedSubtaskId = s.id;
    // Make sure its task's subtask panel isn't collapsed, or the pick would be hidden.
    collapsedSubtaskIds.delete(t.id);
    renderTasksModal();
    const row = tasksListEl.querySelector(`.subtask-row[data-subtask-id="${s.id}"]`);
    if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    showToast(`🎲 ${s.text}`);
  }
  tasksRandomBtn.addEventListener("click", pickRandomSubtask);

  // Deletes the WHOLE task list currently open in the modal (node or one
  // calendar/table cell). This is a list-level action, so it lives in the
  // same ••• menu as Font / Sort / Templates / Random rather than on each
  // individual task row.
  function deleteCurrentTaskList() {
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    const tasks = getNodeTasks(host);
    if (!tasks.length) {
      showToast("Task list is already empty");
      closeTaskListActionUI();
      return;
    }

    const subtaskCount = tasks.reduce((sum, t) => sum + getTaskSubtasks(t).length, 0);
    const details = [
      `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      subtaskCount ? `${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}` : null
    ].filter(Boolean).join(" and ");
    if (!confirm(`Delete this entire task list? This will remove ${details}, including their notes.`)) return;

    pushUndo();
    host.tasks = [];
    // Clear the legacy single-task field too, so an old cell save cannot
    // lazily recreate a deleted list via getCellAttach().
    if (Object.prototype.hasOwnProperty.call(host, "task")) host.task = null;

    closeTaskListActionUI();

    // v547: deletion is a visual mutation first. Remove the task badge/icon
    // from the owning node/cell (and open top Calendar) before any persistence
    // work, so the UI never waits on IndexedDB/Drive/close-modal cleanup.
    const deletedTarget = tasksEditingTarget && { ...tasksEditingTarget };
    if (deletedTarget) {
      refreshNodeOrRenderAll(deletedTarget.nodeId);
      if (calendarModal && !calendarModal.classList.contains("hidden")) renderCalendar();
    }
    persist();
    showToast("Task list deleted");
    closeTasksModal();
  }
  if (tasksDeleteListBtn) tasksDeleteListBtn.addEventListener("click", deleteCurrentTaskList);

  // Reflects the current taskFontBlackMode on the toggle button itself
  // (label + pressed state) — called whenever the tasks modal (re)renders.
  function updateTaskFontColorToggleBtn() {
    tasksFontColorToggleBtn.textContent = taskFontBlackMode ? "⚫ Font" : "🎨 Font";
    tasksFontColorToggleBtn.title = taskFontBlackMode
      ? "Task text is plain black — click to use dynamic per-task colors again"
      : "Task text uses dynamic per-task colors — click to make it all black";
    tasksFontColorToggleBtn.classList.toggle("active", taskFontBlackMode);
  }

  function addTaskFromModal() {
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    const val = tasksNewInput.value.trim();
    if (!val) return;
    pushUndo();
    if (!Array.isArray(host.tasks)) host.tasks = [];

    // v518: every quick "Add task" starts from the saved "Daily Task"
    // template shape by default. The text the user just entered remains the
    // new task's title; reusable template fields (subtasks/color/star) are
    // copied from the first task in Daily Task. If the template is missing,
    // preserve the old plain-task behavior rather than blocking creation.
    const dailyTpl = findTaskListTemplateByName("Daily Task");
    const seed = dailyTpl && Array.isArray(dailyTpl.tasks) ? dailyTpl.tasks[0] : null;
    let starAvailable = !getNodeTasks(host).some(t => getTaskStars(t) > 0);
    const wantsStar = !!seed && getTaskStars(seed) > 0;
    const stars = wantsStar && starAvailable ? 1 : 0;
    const newTask = {
      id: uid(), text: val, done: false, stars, starred: stars > 0, due: null,
      subtasks: seed ? (seed.subtasks || []).map(s => {
        const sub = { id: uid(), text: s.text, done: false };
        if (s.brBefore > 0) sub.brBefore = Math.min(5, s.brBefore | 0);
        return sub;
      }) : []
    };
    if (seed && seed.color) newTask.color = seed.color;
    host.tasks = host.tasks.concat([newTask]);
    host.starsReset = true;
    tasksNewInput.value = "";
    autosizeTextarea(tasksNewInput);
    persist();
    renderTasksModal();
  }

  // Grows a textarea's height to fit whatever's been typed (up to its
  // CSS max-height, after which it scrolls), so a long task/subtask is
  // visible in full while composing instead of scrolling sideways in a
  // single-line box.
  function autosizeTextarea(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  tasksNewInput.addEventListener("input", () => autosizeTextarea(tasksNewInput));
  // Belt-and-suspenders for the keyboard-overlap fix above: the CSS
  // --keyboard-inset padding shifts the whole modal up, but if the task
  // list itself is long enough that the modal card was already scrolled,
  // the input can still end up just out of view. A short delay lets the
  // on-screen keyboard's open animation (and the resulting visualViewport
  // resize) finish first, so scrollIntoView measures against the final,
  // keyboard-shrunk layout rather than the pre-keyboard one.
  tasksNewInput.addEventListener("focus", () => {
    setTimeout(() => tasksNewInput.scrollIntoView({ block: "nearest", behavior: "smooth" }), 300);
  });
  tasksNewInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addTaskFromModal(); }
    else if (e.key === "Escape") { e.preventDefault(); closeTasksModal(); }
  });
  $("#tasks-back").addEventListener("click", closeTasksModal);
  $("#tasks-close").addEventListener("click", closeTasksModal);
  tasksSortStarsBtn.addEventListener("click", sortTasksModal);
  tasksFontColorToggleBtn.addEventListener("click", () => {
    setTaskFontBlackMode(!taskFontBlackMode);
    renderTasksModal();
    // Keep the calendar day popup's task list (same task objects, same
    // taskFontColor) in sync if it happens to be open at the same time.
    const calDayModalEl = $("#cal-day-modal");
    if (calDayModalEl && !calDayModalEl.classList.contains("hidden")) renderCalDayModal();
  });
  tasksModal.addEventListener("click", (e) => { if (!tasksIsResizing && e.target === tasksModal) closeTasksModal(); });
  document.addEventListener("keydown", (e) => {
    if (tasksModal.classList.contains("hidden")) return;
    if (e.key === "Escape" && document.activeElement !== tasksNewInput) closeTasksModal();
  });

