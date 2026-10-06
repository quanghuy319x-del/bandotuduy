/* Branchline — js/15-tasks-editor-1.js
   Part 15 of 19 of the former single-file app.js. Contents: tasks editor.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- tasks editor ---------------- */

  const tasksModal = $("#tasks-modal");
  const tasksModalTitle = $("#tasks-modal-title");
  const tasksCard = $(".tasks-modal-card");
  const tasksResizeHandle = $("#tasks-resize-handle");
  const tasksListEl = $("#tasks-list");
  const tasksNewInput = $("#tasks-new-input");
  const tasksProgressBar = $("#tasks-progress-bar");
  const tasksProgressLabel = $("#tasks-progress-label");
  const tasksSortStarsBtn = $("#tasks-sort-stars");
  const tasksFontColorToggleBtn = $("#tasks-font-color-toggle");
  const tasksTemplatesBtn = $("#tasks-templates-btn");
  const tasksRandomBtn = $("#tasks-random-btn");
  const tasksDeleteListBtn = $("#tasks-delete-list");
  const tasksFocusTimerEl = $("#tasks-focus-timer");
  let tasksEditingTarget = null; // {nodeId, r, c} — r/c null when the modal is open for a whole node instead of one table cell
  let tasksMapStateAtOpen = null;
  function tasksMapStateSignature(target) {
    if (!target) return null;
    const host = resolveHost(target.nodeId, target.r, target.c);
    if (!host) return null;
    try { return JSON.stringify(getNodeTasks(host)); }
    catch (e) { return null; }
  }
  // Guards the same race as noteIsResizing above: dragging the resize
  // handle and releasing the mouse past the card's edge fires a "click"
  // on the modal backdrop right after mouseup, which would otherwise
  // close the tasks modal mid-drag.
  let tasksIsResizing = false;
  // Custom two-axis resize grip, same approach as setupNoteResize, but
  // the chosen size is also remembered across reloads (localStorage),
  // which the note editor's resize doesn't do.
  const TASKS_CARD_SIZE_KEY = "branchline_tasks_card_size";
  (function setupTasksResize() {
    try {
      const saved = JSON.parse(localStorage.getItem(TASKS_CARD_SIZE_KEY) || "null");
      if (saved && saved.w && saved.h) {
        tasksCard.style.width = saved.w + "px";
        tasksCard.style.height = saved.h + "px";
      }
    } catch (e) {}

    let startX, startY, startW, startH;

    function onMove(e) {
      const dw = e.clientX - startX;
      const dh = e.clientY - startY;
      const maxW = window.innerWidth * 0.94;
      const maxH = window.innerHeight * 0.9;
      tasksCard.style.width = clamp(startW + dw, 480, maxW) + "px";
      tasksCard.style.height = clamp(startH + dh, 320, maxH) + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      const rect = tasksCard.getBoundingClientRect();
      try {
        localStorage.setItem(TASKS_CARD_SIZE_KEY, JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }));
      } catch (e) {}
      setTimeout(() => { tasksIsResizing = false; }, 0);
    }
    function onResizeStart(e) {
      e.preventDefault();
      e.stopPropagation();
      tasksIsResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = tasksCard.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
    tasksResizeHandle.addEventListener("mousedown", onResizeStart);
    tasksResizeHandle.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      onResizeStart(e);
    });
  })();
  // Which tasks have their subtask checklist explicitly collapsed in the
  // tasks modal — subtasks are expanded by default, so this only tracks
  // the ones someone has double-clicked closed. Keyed by task id, kept
  // for the life of the page (not persisted) so it survives re-renders
  // but resets on reload.
  const collapsedSubtaskIds = new Set();
  // The subtask most recently chosen by the "🎲 Random" button — drawn
  // highlighted in the tasks modal until it's done, another one is
  // picked, or the modal closes. Just an id; nothing is saved.
  let randomPickedSubtaskId = null;
  // Every unfinished subtask across the WHOLE task list (all tasks),
  // each paired with the task it belongs to.
  function unfinishedSubtasksOfHost(host) {
    return getNodeTasks(host).flatMap((t) =>
      getTaskSubtasks(t).filter((s) => !s.done && !s.failed).map((s) => ({ t, s }))
    );
  }

  // Shared color-dot popover for a task's optional color label (see
  // getTaskColor/setTaskColor) — one instance reused by every task row,
  // in both the Tasks modal and the Calendar day modal's task list,
  // since both render the same underlying task objects. Same
  // fixed-viewport-coordinates + clamp positioning as the photo modal's
  // symbol popover (see positionPhotoSymbolPopover).
  let taskColorPopoverCtx = null; // { t, rerender } — set by openTaskColorPopover
  const taskColorPopover = document.createElement("div");
  taskColorPopover.className = "task-color-popover hidden";
  const taskColorNoneSwatch = document.createElement("span");
  taskColorNoneSwatch.className = "task-color-swatch task-color-swatch-none";
  taskColorNoneSwatch.title = "No color";
  taskColorNoneSwatch.addEventListener("click", (e) => { e.stopPropagation(); applyTaskColor(null); });
  taskColorPopover.appendChild(taskColorNoneSwatch);
  PALETTE.forEach((c) => {
    const sw = document.createElement("span");
    sw.className = "task-color-swatch";
    sw.style.background = c;
    sw.dataset.color = c;
    sw.addEventListener("click", (e) => { e.stopPropagation(); applyTaskColor(c); });
    taskColorPopover.appendChild(sw);
  });
  document.body.appendChild(taskColorPopover);

  function applyTaskColor(color) {
    if (!taskColorPopoverCtx) return;
    const { t, rerender } = taskColorPopoverCtx;
    pushUndo();
    setTaskColor(t, color);
    persist();
    closeTaskColorPopover();
    rerender();
  }
  function openTaskColorPopover(btn, t, rerender) {
    taskColorPopoverCtx = { t, rerender };
    taskColorPopover.querySelectorAll(".task-color-swatch").forEach((sw) => {
      sw.classList.toggle("active", getTaskColor(t) === (sw.dataset.color || null));
    });
    taskColorPopover.classList.remove("hidden");
    positionTaskColorPopover(btn);
  }
  function openTaskColorPopoverAt(x, y, t, rerender) {
    taskColorPopoverCtx = { t, rerender };
    taskColorPopover.querySelectorAll(".task-color-swatch").forEach((sw) => {
      sw.classList.toggle("active", getTaskColor(t) === (sw.dataset.color || null));
    });
    taskColorPopover.classList.remove("hidden");
    const margin = 8;
    const popRect = taskColorPopover.getBoundingClientRect();
    let left = Math.max(margin, Math.min(x, window.innerWidth - popRect.width - margin));
    let top = Math.max(margin, Math.min(y, window.innerHeight - popRect.height - margin));
    taskColorPopover.style.left = left + "px";
    taskColorPopover.style.top = top + "px";
  }
  function closeTaskColorPopover() {
    taskColorPopover.classList.add("hidden");
    taskColorPopoverCtx = null;
  }
  function positionTaskColorPopover(btn) {
    const margin = 8;
    const btnRect = btn.getBoundingClientRect();
    const popRect = taskColorPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6;
    }
    taskColorPopover.style.left = `${left}px`;
    taskColorPopover.style.top = `${top}px`;
  }
  taskColorPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!taskColorPopover.classList.contains("hidden") &&
        !taskColorPopover.contains(e.target) &&
        !e.target.closest(".task-color-dot")) {
      closeTaskColorPopover();
    }
  });

  // Templates popover — opened from the tasks modal's "📋 Templates"
  // button. Its top row saves the *entire* current task list under a
  // name (see saveTaskListAsTemplate above); below that is every
  // previously saved list-template, each insertable onto whichever
  // node's task list is currently open. Same fixed-viewport popover
  // pattern as the task-color one just above.
  const taskTemplatesPopover = document.createElement("div");
  taskTemplatesPopover.className = "task-templates-popover hidden";
  document.body.appendChild(taskTemplatesPopover);

  function renderTaskTemplatesPopover() {
    taskTemplatesPopover.innerHTML = "";
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    const currentTaskCount = host ? getNodeTasks(host).length : 0;

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "task-template-save-btn";
    saveBtn.textContent = "💾 Save this list as a template…";
    saveBtn.disabled = !currentTaskCount;
    saveBtn.title = currentTaskCount
      ? `Save all ${currentTaskCount} task(s) here as a reusable template`
      : "This list is empty — add a task first";
    saveBtn.addEventListener("click", () => {
      if (!host) return;
      const name = window.prompt("Name this task-list template:", "");
      if (name === null) return; // cancelled
      const clean = name.trim();
      // Saving under a name that already exists would otherwise leave two
      // near-identical templates behind — offer to replace that one's
      // tasks in place instead of always creating a new entry.
      const existing = clean && getTaskListTemplates().find(t => t.name.trim().toLowerCase() === clean.toLowerCase());
      if (existing) {
        if (!confirm(`A template named "${existing.name}" already exists. Replace it with the current list?`)) return;
        updateTaskListTemplate(existing.id, host);
        showToast(`Replaced template "${existing.name}"`);
      } else {
        saveTaskListAsTemplate(host, name);
        showToast("Saved task list as a template");
      }
      renderTaskTemplatesPopover();
    });
    taskTemplatesPopover.appendChild(saveBtn);

    const templates = getTaskListTemplates();
    if (!templates.length) {
      const empty = document.createElement("div");
      empty.className = "task-templates-empty";
      empty.textContent = "No saved templates yet.";
      taskTemplatesPopover.appendChild(empty);
      return;
    }
    const divider = document.createElement("div");
    divider.className = "task-templates-divider";
    taskTemplatesPopover.appendChild(divider);
    templates.forEach((tpl) => {
      const row = document.createElement("div");
      row.className = "task-template-row";
      const label = document.createElement("span");
      label.className = "task-template-row-label";
      const count = (tpl.tasks || []).length;
      label.textContent = `${tpl.name} (${count} task${count === 1 ? "" : "s"})`;
      label.title = `Add these ${count} task(s) to the current list`;
      label.addEventListener("click", () => {
        const t2 = tasksEditingTarget;
        const h2 = t2 && resolveHost(t2.nodeId, t2.r, t2.c);
        if (!h2) return;
        insertTaskListTemplate(tpl, h2);
        closeTaskListActionUI();
        renderTasksModal();
        // Android can deliver the tail end of the same tap after the task
        // list re-renders. Close once more on the next frame so neither the
        // template picker nor the ••• action menu can be left covering it.
        requestAnimationFrame(closeTaskListActionUI);
      });
      // Overwrites this template's saved tasks with whatever's on the
      // currently open list — the explicit way to update a template
      // without retyping its exact name into the save prompt above.
      const replace = document.createElement("button");
      replace.type = "button";
      replace.className = "task-template-row-replace";
      replace.title = currentTaskCount
        ? `Replace "${tpl.name}" with the current list (${currentTaskCount} task${currentTaskCount === 1 ? "" : "s"})`
        : "This list is empty — add a task first";
      replace.textContent = "🔁";
      replace.disabled = !currentTaskCount;
      replace.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!host || !currentTaskCount) return;
        if (!confirm(`Replace template "${tpl.name}" with the current list?`)) return;
        updateTaskListTemplate(tpl.id, host);
        renderTaskTemplatesPopover();
        showToast(`Replaced template "${tpl.name}"`);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "task-template-row-del";
      del.title = "Delete this template";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete the template "${tpl.name}"?`)) return;
        deleteTaskListTemplate(tpl.id);
        renderTaskTemplatesPopover();
      });
      row.appendChild(label);
      row.appendChild(replace);
      row.appendChild(del);
      taskTemplatesPopover.appendChild(row);
    });
  }
  function openTaskTemplatesPopover(btn) {
    renderTaskTemplatesPopover();
    taskTemplatesPopover.classList.remove("hidden");
    positionTaskTemplatesPopover(btn);
    // Pull whatever the other device saved, then redraw if it added any.
    syncTaskTemplatesWithDrive().then((changed) => {
      if (changed && !taskTemplatesPopover.classList.contains("hidden")) {
        renderTaskTemplatesPopover();
        positionTaskTemplatesPopover(btn);
      }
    });
  }
  function closeTaskTemplatesPopover() {
    taskTemplatesPopover.classList.add("hidden");
  }

  // Close every floating/expanded Task List action layer together. On
  // touch browsers the template picker is body-level while Font/Sort/
  // Templates/Random live inside a <details>, so closing only one layer
  // can leave the other sitting over the task list after a template is
  // applied.
  function closeTaskListActionUI() {
    closeTaskTemplatesPopover();
    const compact = tasksModal.querySelector(".tasks-compact-menu");
    if (compact) compact.removeAttribute("open");
  }
  function positionTaskTemplatesPopover(btn) {
    const margin = 8;
    const btnRect = btn.getBoundingClientRect();
    const popRect = taskTemplatesPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6;
    }
    taskTemplatesPopover.style.left = `${left}px`;
    taskTemplatesPopover.style.top = `${top}px`;
  }
  if (tasksTemplatesBtn) {
    tasksTemplatesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (taskTemplatesPopover.classList.contains("hidden")) openTaskTemplatesPopover(tasksTemplatesBtn);
      else closeTaskTemplatesPopover();
    });
  }
  taskTemplatesPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!taskTemplatesPopover.classList.contains("hidden") &&
        !taskTemplatesPopover.contains(e.target) &&
        e.target !== tasksTemplatesBtn) {
      closeTaskTemplatesPopover();
    }
  });

  // Per-task focus timer — a lightweight, non-persisted countdown so the
  // person can start a quick focus session on one task at a time. It
  // keeps running (via setInterval) even if the tasks modal is closed or
  // switched to a different node, so leaving the modal doesn't cancel it.
  // Starts short — an extra "+1m" button lets you stack on more time
  // instead of committing to a long duration up front.
  const FOCUS_DURATION = 1 * 60; // 1 minute
  const FOCUS_EXTEND = 1 * 60; // added per "+1m" click
  let focusTimer = null; // { target: {nodeId, r, c}, taskId, subtaskId, taskText, remaining, duration, paused, intervalId } — subtaskId is null for a task-level timer
  let focusJustCompleted = null; // { target, taskId, subtaskId } — shown briefly after a session finishes
  let lastFocusTaskText = ""; // kept around so the "Time's up!" tab title can still name the task once focusTimer itself is cleared

  // The browser tab title mirrors the countdown, so the time is visible
  // even when this tab isn't the active one. BASE_TITLE is captured once
  // up front (before anything ever overwrites document.title) so it can
  // always be restored exactly once the timer/alarm is done.
  const BASE_TITLE = document.title;
  const TITLE_TASK_MAX = 40;

  function titleTaskLabel(text) {
    const t = (text || "").trim() || "Focus";
    return t.length > TITLE_TASK_MAX ? t.slice(0, TITLE_TASK_MAX - 1) + "…" : t;
  }

  function updateFocusTitle() {
    if (focusTimer) {
      document.title = `${focusTimer.paused ? "⏸" : "⏱"} ${formatFocusTime(focusTimer.remaining)} · ${titleTaskLabel(focusTimer.taskText)}`;
    } else if (focusChimeIntervalId) {
      document.title = `⏰ Time's up! · ${titleTaskLabel(lastFocusTaskText)}`;
    } else {
      document.title = BASE_TITLE;
    }
  }

  function formatFocusTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Single focus-timer widget, shown once at the top of the tasks modal
  // (next to its title) rather than duplicated on every task/subtask row.
  // It isn't tied to any particular task — just a general session for
  // whatever the person is working through in this list.
  function renderFocusTimerWidget() {
    if (!tasksFocusTimerEl) return;
    tasksFocusTimerEl.innerHTML = "";

    if (focusTimer) {
      const timeLabel = document.createElement("span");
      timeLabel.className = "task-timer-time" + (focusTimer.paused ? " paused" : "");
      timeLabel.textContent = formatFocusTime(focusTimer.remaining);
      timeLabel.title = focusTimer.paused ? "Focus timer paused" : "Focusing — time remaining";

      const pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "task-timer-btn";
      pauseBtn.title = focusTimer.paused ? "Resume" : "Pause";
      pauseBtn.textContent = focusTimer.paused ? "▶" : "⏸";
      pauseBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFocusPause(); });

      const extendBtn = document.createElement("button");
      extendBtn.type = "button";
      extendBtn.className = "task-timer-btn task-timer-extend";
      extendBtn.title = "Add 1 more minute";
      extendBtn.textContent = "+1m";
      extendBtn.addEventListener("click", (e) => { e.stopPropagation(); extendFocusTimer(FOCUS_EXTEND); });

      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "task-timer-btn task-timer-stop";
      stopBtn.title = "Stop focus timer";
      stopBtn.textContent = "■";
      stopBtn.addEventListener("click", (e) => { e.stopPropagation(); stopFocusTimer(); });

      tasksFocusTimerEl.appendChild(timeLabel);
      tasksFocusTimerEl.appendChild(pauseBtn);
      tasksFocusTimerEl.appendChild(stopBtn);
      tasksFocusTimerEl.appendChild(extendBtn);
    } else if (focusJustCompleted) {
      const doneLabel = document.createElement("span");
      doneLabel.className = "task-timer-done-label";
      doneLabel.textContent = "✓ Focus done";
      doneLabel.title = "Tap anywhere to stop the chime";
      tasksFocusTimerEl.appendChild(doneLabel);
    } else {
      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.className = "task-timer-btn task-timer-start";
      startBtn.title = "Start a focus timer (1 min, +1m button to extend)";
      startBtn.textContent = "⏱";
      startBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startFocusTimer(tasksEditingTarget, null, "Focus session");
      });
      tasksFocusTimerEl.appendChild(startBtn);
    }
  }

  function refreshTasksModalIfOpen(target) {
    if (!tasksModal.classList.contains("hidden") && sameTarget(tasksEditingTarget, target)) {
      renderTasksModal();
    }
  }

  function startFocusTimer(target, taskId, taskText, subtaskId = null) {
    stopFocusTimer();
    stopFocusChime();
    focusJustCompleted = null;
    focusTimer = {
      target, taskId, subtaskId, taskText,
      remaining: FOCUS_DURATION,
      duration: FOCUS_DURATION,
      paused: false,
      ticksSincePersist: 0,
      badgeRenderAttempted: false,
      intervalId: setInterval(focusTimerTick, 1000),
    };
    updateFocusTitle();
    refreshTasksModalIfOpen(target);
  }

  function focusTimerTick() {
    if (!focusTimer || focusTimer.paused) return;
    focusTimer.remaining--;

    // Task-list focus time counts toward the same saved "time played" total
    // as the node timer. If the node timer is already running for this exact
    // target, don't double-count the same second.
    const nodeTimerAlreadyCounting =
      nodeTimer && !nodeTimer.paused && sameTarget(nodeTimer.target, focusTimer.target);
    if (!nodeTimerAlreadyCounting) {
      const host = resolveHost(focusTimer.target.nodeId, focusTimer.target.r, focusTimer.target.c);
      if (host) {
        host.timePlayedSec = getNodeTimePlayed(host) + 1;
        unsavedEdits = true;
        focusTimer.ticksSincePersist++;
        if (focusTimer.ticksSincePersist >= 10) {
          focusTimer.ticksSincePersist = 0;
          persist();
        }
        updateNodeTimerLiveUI(focusTimer.target);
      }
    }

    if (focusTimer.remaining <= 0) {
      focusTimerComplete();
      return;
    }
    updateFocusTitle();
    refreshTasksModalIfOpen(focusTimer.target);
  }

  function toggleFocusPause() {
    if (!focusTimer) return;
    focusTimer.paused = !focusTimer.paused;
    if (focusTimer.paused && focusTimer.ticksSincePersist) {
      focusTimer.ticksSincePersist = 0;
      persist();
    }
    updateFocusTitle();
    refreshTasksModalIfOpen(focusTimer.target);
  }

  // Stacks more time onto a running (or paused) timer, e.g. from a "+1m"
  // button — lets a short default session grow as long as needed instead
  // of forcing a long duration up front.
  function extendFocusTimer(seconds) {
    if (!focusTimer) return;
    focusTimer.remaining += seconds;
    focusTimer.duration += seconds;
    updateFocusTitle();
    refreshTasksModalIfOpen(focusTimer.target);
  }

  function stopFocusTimer() {
    if (focusTimer && focusTimer.intervalId) clearInterval(focusTimer.intervalId);
    const prev = focusTimer;
    focusTimer = null;
    if (prev && prev.ticksSincePersist) persist();
    updateFocusTitle();
    if (prev) {
      updateNodeTimerLiveUI(prev.target);
      refreshTasksModalIfOpen(prev.target);
    }
  }

  function focusTimerComplete() {
    const finished = focusTimer;
    if (finished && finished.intervalId) clearInterval(finished.intervalId);
    focusTimer = null;
    if (finished) {
      lastFocusTaskText = finished.taskText;
      if (finished.ticksSincePersist) persist();
      updateNodeTimerLiveUI(finished.target);
    }
    startFocusChime();
    updateFocusTitle();
    if (finished) {
      focusJustCompleted = { target: finished.target, taskId: finished.taskId, subtaskId: finished.subtaskId };
      refreshTasksModalIfOpen(finished.target);
      setTimeout(() => {
        if (focusJustCompleted && focusJustCompleted.taskId === finished.taskId && focusJustCompleted.subtaskId === finished.subtaskId) {
          focusJustCompleted = null;
          refreshTasksModalIfOpen(finished.target);
        }
      }, 4000);
    }
  }

  // The alarm keeps chiming — not just a single beep — until the person
  // dismisses it with any click/tap/keypress anywhere on the page, or
  // starts another focus timer. A generous safety cap stops it on its
  // own if the tab is left unattended, so it can never ring forever.
  const FOCUS_CHIME_INTERVAL = 1500;
  const FOCUS_CHIME_MAX_MS = 5 * 60 * 1000; // 5 minutes, just in case
  let focusChimeIntervalId = null;
  let focusChimeCapTimeoutId = null;
  let focusChimeDismissHandler = null;

  function startFocusChime() {
    stopFocusChime();
    playFocusChime();
    focusChimeIntervalId = setInterval(playFocusChime, FOCUS_CHIME_INTERVAL);
    focusChimeCapTimeoutId = setTimeout(stopFocusChime, FOCUS_CHIME_MAX_MS);
    focusChimeDismissHandler = () => stopFocusChime();
    // capture:true so it fires even if the click lands on something that
    // would otherwise stop propagation before reaching document.
    document.addEventListener("pointerdown", focusChimeDismissHandler, { capture: true, once: true });
    document.addEventListener("keydown", focusChimeDismissHandler, { capture: true, once: true });
    updateFocusTitle();
  }

  function stopFocusChime() {
    if (focusChimeIntervalId) { clearInterval(focusChimeIntervalId); focusChimeIntervalId = null; }
    if (focusChimeCapTimeoutId) { clearTimeout(focusChimeCapTimeoutId); focusChimeCapTimeoutId = null; }
    if (focusChimeDismissHandler) {
      document.removeEventListener("pointerdown", focusChimeDismissHandler, { capture: true });
      document.removeEventListener("keydown", focusChimeDismissHandler, { capture: true });
      focusChimeDismissHandler = null;
    }
    updateFocusTitle();
  }

  // A short two-tone chime via the Web Audio API — no audio file needed,
  // and it fails silently if the browser blocks autoplay before any
  // user gesture (there will have been one, since a click started the
  // timer, but this stays defensive either way).
  function playFocusChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      [880, 1174.66].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.value = 0.0001;
        o.connect(g);
        g.connect(ctx.destination);
        const start = ctx.currentTime + i * 0.16;
        g.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        o.start(start);
        o.stop(start + 0.55);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch (e) { /* ignore — chime is a nice-to-have, not essential */ }
  }


  // Reordering tasks by drag — drag the ⠿ handle on the left of any task
  // up or down to drop it before/after another task in the list.
  let taskDragState = null;

  function startTaskDrag(e, li, taskId) {
    e.stopPropagation();
    if (!requireSignIn()) { e.preventDefault(); return; }
    taskDragState = { taskId };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
    li.classList.add("task-dragging");
  }

  function endTaskDrag(li) {
    li.classList.remove("task-dragging");
    taskDragState = null;
    tasksListEl.querySelectorAll(".task-row").forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
  }

  // Phone task dragging: require a deliberate hold before the drag arms.
  // This replaces the browser's native touch-drag timing on narrow screens,
  // which can otherwise start while the user only meant to tap/scroll.
  function installTaskTouchDrag(handle, li, taskId) {
    const HOLD_MS = 800;
    const MOVE_TOLERANCE_SQ = 144; // 12px
    let timer = null;
    let pointerId = null;
    let startX = 0, startY = 0;
    let active = false;
    let ghost = null;
    let dropTarget = null; // { taskId, before }

    const clearHints = () => {
      if (!tasksListEl) return;
      tasksListEl.querySelectorAll(".task-row.drag-over-top, .task-row.drag-over-bottom")
        .forEach(el => el.classList.remove("drag-over-top", "drag-over-bottom"));
    };

    const removeGhost = () => {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
    };

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      active = false;
      clearHints();
      removeGhost();
      li.classList.remove("task-dragging", "touch-dragging");
      taskDragState = null;
      dropTarget = null;
      pointerId = null;
    };

    const makeGhost = (x, y) => {
      ghost = document.createElement("div");
      ghost.className = "subtask-touch-ghost";
      const label = li.querySelector(".task-text");
      ghost.textContent = label ? label.textContent : "";
      document.body.appendChild(ghost);
      ghost.style.left = (x + 12) + "px";
      ghost.style.top = (y + 12) + "px";
    };

    const moveGhost = (x, y) => {
      if (!ghost) return;
      const margin = 6;
      const maxX = Math.max(margin, window.innerWidth - ghost.offsetWidth - margin);
      const maxY = Math.max(margin, window.innerHeight - ghost.offsetHeight - margin);
      ghost.style.left = Math.max(margin, Math.min(x + 12, maxX)) + "px";
      ghost.style.top = Math.max(margin, Math.min(y + 12, maxY)) + "px";
    };

    const findTarget = (x, y) => {
      clearHints();
      dropTarget = null;
      const stack = document.elementsFromPoint
        ? document.elementsFromPoint(x, y)
        : [document.elementFromPoint(x, y)];
      for (const el of stack) {
        if (!el || !el.closest) continue;
        const row = el.closest(".task-row[data-task-id]");
        if (!row || row === li || !tasksListEl.contains(row)) continue;
        const rect = row.getBoundingClientRect();
        const before = (y - rect.top) < rect.height / 2;
        row.classList.toggle("drag-over-top", before);
        row.classList.toggle("drag-over-bottom", !before);
        dropTarget = { taskId: row.dataset.taskId, before };
        break;
      }
    };

    const autoScroll = (y) => {
      if (!tasksListEl) return;
      const r = tasksListEl.getBoundingClientRect();
      const edge = 44;
      if (y < r.top + edge) tasksListEl.scrollTop -= 12;
      else if (y > r.bottom - edge) tasksListEl.scrollTop += 12;
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      if (e.isPrimary === false) return;
      if (!window.matchMedia("(max-width: 640px)").matches) return;
      if (!requireSignIn()) return;
      e.stopPropagation();
      reset();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        active = true;
        taskDragState = { taskId };
        li.classList.add("task-dragging", "touch-dragging");
        try { handle.setPointerCapture(pointerId); } catch (err) {}
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
        makeGhost(startX, startY);
        findTarget(startX, startY);
      }, HOLD_MS);
    }, { passive: true });

    handle.addEventListener("pointermove", (e) => {
      if (pointerId == null || e.pointerId !== pointerId) return;
      if (!active) {
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if ((dx * dx + dy * dy) > MOVE_TOLERANCE_SQ) reset();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      moveGhost(e.clientX, e.clientY);
      autoScroll(e.clientY);
      findTarget(e.clientX, e.clientY);
    }, { passive: false });

    const finish = (e, commit) => {
      if (pointerId == null || e.pointerId !== pointerId) return;
      if (active) {
        e.preventDefault();
        e.stopPropagation();
      }
      const target = dropTarget ? { ...dropTarget } : null;
      try { handle.releasePointerCapture(pointerId); } catch (err) {}
      reset();
      if (commit && target && target.taskId) {
        reorderTask(taskId, target.taskId, target.before);
      }
    };

    handle.addEventListener("pointerup", (e) => finish(e, true), { passive: false });
    handle.addEventListener("pointercancel", (e) => finish(e, false), { passive: false });
    handle.addEventListener("click", (e) => {
      if (window.matchMedia("(max-width: 640px)").matches) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    handle.addEventListener("contextmenu", (e) => {
      if (window.matchMedia("(max-width: 640px)").matches) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  // Single "★ Sort" button that alternates between two one-click reorders
  // each time it's pressed: star (then color) first, then color-only next
  // time, then back to star, etc. Each press is a real edit (goes through
  // pushUndo like any other reorder) using a stable sort, so equally-
  // ranked tasks keep their existing relative order. tasksSortMode tracks
  // which sort the *next* press will apply, and the button's label always
  // shows that upcoming action.
  let tasksSortMode = "star";
  function sortTasksModal() {
    if (!requireSignIn()) return;
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    const tasks = getNodeTasks(host);
    if (tasks.length < 2) return;
    const cmp = tasksSortMode === "star"
      ? compareTasksByStarAndColor
      : (a, b) => taskColorSortIndex(a) - taskColorSortIndex(b);
    const sorted = tasks.slice().sort(cmp);
    pushUndo();
    host.tasks = sorted;
    persist();
    tasksSortMode = tasksSortMode === "star" ? "color" : "star";
    updateTasksSortBtnLabel();
    renderTasksModal();
  }
  function updateTasksSortBtnLabel() {
    tasksSortStarsBtn.textContent = tasksSortMode === "star" ? "★ Sort" : "🎨 Sort";
    tasksSortStarsBtn.title = tasksSortMode === "star"
      ? "Sort tasks by star, then color. Click again to sort by color instead."
      : "Sort tasks by color, ignoring star. Click again to sort by star instead.";
  }

  function reorderTask(sourceTaskId, targetTaskId, before) {
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    if (!host || sourceTaskId === targetTaskId) return;
    const tasks = getNodeTasks(host).slice();
    const fromIdx = tasks.findIndex(x => x.id === sourceTaskId);
    if (fromIdx === -1) return;
    const [moved] = tasks.splice(fromIdx, 1);
    const toIdx = tasks.findIndex(x => x.id === targetTaskId);
    if (toIdx === -1) {
      tasks.push(moved);
    } else {
      tasks.splice(before ? toIdx : toIdx + 1, 0, moved);
    }
    pushUndo();
    host.tasks = tasks;
    persist();
    renderTasksModal();
  }

  // Reordering subtasks by drag — same ⠿ handle convention as tasks. A
  // subtask can be dropped on another subtask row (to land at that exact
  // spot) or directly on a task's own row (to land at the end of that
  // task's list) — either way, it works both within the same task and
  // across two different tasks.
  let subtaskDragState = null;
  // v463: phone dragging is explicit. Long-press only opens the menu; choosing
  // Move arms exactly one subtask for direct touch-drag until drop/cancel.
  let subtaskTouchMoveMode = null; // { taskId, subtaskId }
  const SHARED_QUEUE_TASK_ID = "__shared_queue__";

  // Which tasks currently have their "add a subtask" input expanded —
  // it starts life as a small + button and swaps for the input on
  // click, collapsing back once you click away with nothing typed.
  let subtaskAddOpenFor = new Set();

  // ---- Line breaks between subtask pills ----------------------------
  // Click in the gap between two pills (or in the empty space beside
  // one) to drop a blinking caret there, then press Enter to force the
  // pill after the caret onto a new line. Enter again adds a blank line;
  // Backspace takes a break back out; ←/→ walk the caret between pills;
  // Esc (or clicking away) hides it. The break is stored on the pill it
  // sits in front of as `brBefore` (a small count), so the subtask data
  // model — and progress counting — is untouched.
  let subtaskCaret = null;        // { taskId, beforeId } while a caret is showing
  let subtaskCaretBusy = false;   // true while a re-render is swapping the list out

  function clearSubtaskCaret() {
    subtaskCaret = null;
    document.querySelectorAll(".subtask-caret").forEach(el => el.remove());
  }

  function enhanceSubtaskList(list, t, rerender) {
    const subs = getTaskSubtasks(t);
    const rows = Array.from(list.children).filter(el => el.classList.contains("subtask-row"));
    if (rows.length !== subs.length) return;
    list.tabIndex = -1;

    // Line-break spacers: the first forces a wrap, any extras are blank lines.
    rows.forEach((row, i) => {
      const n = Math.max(0, Math.min(5, subs[i].brBefore | 0));
      for (let k = 0; k < n; k++) {
        const br = document.createElement("li");
        br.className = "subtask-break" + (k > 0 ? " subtask-break-extra" : "");
        list.insertBefore(br, row);
      }
    });

    function placeCaret() {
      list.querySelectorAll(".subtask-caret").forEach(el => el.remove());
      if (!subtaskCaret || subtaskCaret.taskId !== t.id) return;
      const i = subs.findIndex(x => x.id === subtaskCaret.beforeId);
      if (i === -1) return;
      const caret = document.createElement("li");
      caret.className = "subtask-caret";
      list.insertBefore(caret, rows[i]);
    }
    placeCaret();
    if (subtaskCaret && subtaskCaret.taskId === t.id) {
      requestAnimationFrame(() => { if (list.isConnected) list.focus({ preventScroll: true }); });
    }

    // Which gap did the click land in? Nearest pill wins (vertical
    // distance weighted more so a click beside a line stays on that
    // line); left half of it = before, right half = after.
    function gapIndexFor(e) {
      let best = -1, bestD = Infinity;
      rows.forEach((row, i) => {
        const r = row.getBoundingClientRect();
        const dx = e.clientX < r.left ? r.left - e.clientX : (e.clientX > r.right ? e.clientX - r.right : 0);
        const dy = e.clientY < r.top ? r.top - e.clientY : (e.clientY > r.bottom ? e.clientY - r.bottom : 0);
        const d = dx * dx + dy * dy * 4;
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best === -1) return -1;
      const r = rows[best].getBoundingClientRect();
      return e.clientX < (r.left + r.right) / 2 ? best : best + 1;
    }

    list.addEventListener("mousedown", (e) => {
      const c = e.target.classList;
      // (Not the pill itself: cancelling mousedown on it would stop it being dragged.)
      const isGap = e.target === list || (c && (c.contains("subtask-break") || c.contains("subtask-caret")));
      if (!isGap) { if (subtaskCaret) clearSubtaskCaret(); return; }
      e.preventDefault();
      const idx = gapIndexFor(e);
      document.querySelectorAll(".subtask-caret").forEach(el => el.remove());
      // Nothing follows the very end of the list, so there's nothing to break.
      if (idx < 0 || idx >= subs.length) { subtaskCaret = null; return; }
      subtaskCaret = { taskId: t.id, beforeId: subs[idx].id };
      placeCaret();
      list.focus({ preventScroll: true });
    });

    function commit() {
      persist();
      subtaskCaretBusy = true;
      rerender();
      requestAnimationFrame(() => { subtaskCaretBusy = false; });
    }

    list.addEventListener("keydown", (e) => {
      if (!subtaskCaret || subtaskCaret.taskId !== t.id) return;
      const i = subs.findIndex(x => x.id === subtaskCaret.beforeId);
      if (i === -1) return;
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (!requireSignIn()) return;
        pushUndo();
        subs[i].brBefore = Math.min(5, (subs[i].brBefore | 0) + 1);
        commit();
      } else if (e.key === "Backspace") {
        e.preventDefault(); e.stopPropagation();
        if (!(subs[i].brBefore > 0)) return;
        if (!requireSignIn()) return;
        pushUndo();
        subs[i].brBefore -= 1;
        if (!subs[i].brBefore) delete subs[i].brBefore;
        commit();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        const j = i + (e.key === "ArrowLeft" ? -1 : 1);
        if (j < 0 || j >= subs.length) return;
        subtaskCaret = { taskId: t.id, beforeId: subs[j].id };
        placeCaret();
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        clearSubtaskCaret();
        list.blur();
      }
    });

    list.addEventListener("blur", () => {
      if (subtaskCaretBusy) return;
      if (subtaskCaret && subtaskCaret.taskId === t.id) clearSubtaskCaret();
    });
  }

  function startSubtaskDrag(e, row, taskId, subtaskId) {
    e.stopPropagation();
    if (!requireSignIn()) { e.preventDefault(); return; }
    subtaskDragState = { taskId, subtaskId };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
    row.classList.add("task-dragging");
  }

  function endSubtaskDrag(row) {
    row.classList.remove("task-dragging");
    subtaskDragState = null;
    tasksListEl.querySelectorAll(".subtask-row").forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
    tasksListEl.querySelectorAll(".task-row.subtask-drop-target, .subtask-panel.subtask-drop-target")
      .forEach(r => r.classList.remove("subtask-drop-target"));
  }

  // Moves a subtask to a new spot — anywhere in its own task's list, or
  // into a different task's list entirely. `targetTaskId`/`targetSubtaskId`
  // describe where it's landing: pass a specific targetSubtaskId (plus
  // `before`) to drop it right next to that subtask, or leave
  // targetSubtaskId null to just drop it at the end of targetTaskId's list
  // (e.g. when it's dropped on the task's row rather than one of its
  // existing subtasks).
  function moveSubtask(sourceTaskId, sourceSubtaskId, targetTaskId, targetSubtaskId, before) {
    const target = tasksEditingTarget;
    const host = target && resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    if (sourceTaskId === targetTaskId && sourceSubtaskId === targetSubtaskId) return;

    const tasks = getNodeTasks(host);
    const sourceIsQueue = sourceTaskId === SHARED_QUEUE_TASK_ID;
    const targetIsQueue = targetTaskId === SHARED_QUEUE_TASK_ID;
    const sourceTask = sourceIsQueue ? null : tasks.find(x => x.id === sourceTaskId);
    const targetTask = targetIsQueue ? null : tasks.find(x => x.id === targetTaskId);
    if ((!sourceIsQueue && !sourceTask) || (!targetIsQueue && !targetTask)) return;
    const sameContainer = sourceTaskId === targetTaskId;
    if (!sameContainer && !targetIsQueue && blockStarredTaskSubtaskOverflow(targetTask)) return;

    const originalQueue = getDRCQueueItems().slice();
    const sourceSubs = sourceIsQueue ? originalQueue.slice() : getTaskSubtasks(sourceTask).slice();
    const fromIdx = sourceSubs.findIndex(x => x.id === sourceSubtaskId);
    if (fromIdx === -1) return;
    const [moved] = sourceSubs.splice(fromIdx, 1);

    pushUndo();

    let destSubs;
    if (sameContainer) {
      destSubs = sourceSubs;
    } else if (targetIsQueue) {
      // When Queue is also the source, use the already-trimmed list.
      destSubs = sourceIsQueue ? sourceSubs : originalQueue.slice();
    } else {
      destSubs = getTaskSubtasks(targetTask).slice();
    }

    const toIdx = targetSubtaskId ? destSubs.findIndex(x => x.id === targetSubtaskId) : -1;
    if (toIdx === -1) destSubs.push(moved);
    else destSubs.splice(before ? toIdx : toIdx + 1, 0, moved);

    const now = Date.now();
    const deleted = getDeletedDRCQueueItems();
    let queueChanged = false;

    if (sourceIsQueue) {
      queueChanged = true;
      if (!targetIsQueue) {
        deleted[moved.id] = Math.max(Number(deleted[moved.id]) || 0, now);
        saveDRCQueueItems(sourceSubs);
      }
    } else {
      sourceTask.subtasks = sourceSubs;
    }

    if (targetIsQueue) {
      queueChanged = true;
      moved.updatedAt = now;
      moved.done = !!moved.done;
      moved.failed = !!moved.failed;
      if (deleted[moved.id]) delete deleted[moved.id];
      saveDRCQueueItems(destSubs);
    } else {
      targetTask.subtasks = destSubs;
    }

    if (!sameContainer) {
      if (sourceTask) syncTaskDoneFromSubtasks(sourceTask);
      if (targetTask) syncTaskDoneFromSubtasks(targetTask);
    }

    if (queueChanged) {
      saveDeletedDRCQueueItems(deleted);
      scheduleTaskTemplateSync();
    }
    persist();
    renderTasksModal();
  }

  // Moves a subtask onto a task belonging to a *different* node entirely
  // (unlike moveSubtask above, which only reshuffles within the currently
  // open Tasks modal's own host). `targetTaskId` null means "create a new
  // task on targetNode named newTaskText and drop the subtask into that".
  function moveSubtaskToNode(sourceTaskId, sourceSubtaskId, targetNode, targetTaskId, newTaskText) {
    const target = tasksEditingTarget;
    const sourceHost = target && resolveHost(target.nodeId, target.r, target.c);
    if (!sourceHost || !targetNode) return;
    const sourceTasks = getNodeTasks(sourceHost);
    const sourceTask = sourceTasks.find(x => x.id === sourceTaskId);
    if (!sourceTask) return;
    const sourceSubs = getTaskSubtasks(sourceTask).slice();
    const fromIdx = sourceSubs.findIndex(x => x.id === sourceSubtaskId);
    if (fromIdx === -1) return;

    pushUndo();

    const [moved] = sourceSubs.splice(fromIdx, 1);
    sourceTask.subtasks = sourceSubs;

    if (!Array.isArray(targetNode.tasks)) targetNode.tasks = [];
    let targetTask = targetTaskId ? getNodeTasks(targetNode).find(x => x.id === targetTaskId) : null;
    if (targetTask && blockStarredTaskSubtaskOverflow(targetTask)) return;
    if (!targetTask) {
      targetTask = { id: uid(), text: (newTaskText || "").trim() || "(untitled task)", done: false, stars: 0, due: null, subtasks: [] };
      targetNode.tasks = targetNode.tasks.concat([targetTask]);
    }
    if (!Array.isArray(targetTask.subtasks)) targetTask.subtasks = [];
    targetTask.subtasks = targetTask.subtasks.concat([moved]);

    // Moving a subtask in or out changes what each task's own subtasks
    // add up to, which can flip its auto-derived done state.
    syncTaskDoneFromSubtasks(sourceTask);
    syncTaskDoneFromSubtasks(targetTask);

    persist();
    renderTasksModal();
    showToast(`Moved to "${targetNode.text || "(untitled)"}"`);
  }

  // Popover for "Move to another node…" (see openSubtaskContextMenu): a
  // two-step picker since there's no way to drag a subtask onto a node on
  // the canvas while the Tasks modal — a full-screen overlay — is open.
  // Step 1 searches/lists every node in the map (collectAllNodesFlat);
  // picking one moves to step 2, which lists that node's existing tasks
  // plus a "new task" input, either of which completes the move.
  let subtaskMovePopoverEl = null;
  let subtaskMovePopoverOutsideHandler = null;
  function closeSubtaskMovePopover() {
    if (subtaskMovePopoverEl) { subtaskMovePopoverEl.remove(); subtaskMovePopoverEl = null; }
    if (subtaskMovePopoverOutsideHandler) {
      document.removeEventListener("mousedown", subtaskMovePopoverOutsideHandler);
      subtaskMovePopoverOutsideHandler = null;
    }
  }
  function openSubtaskMoveToNodePopover(x, y, sourceTask, subtask) {
    closeSubtaskMovePopover();
    const pop = document.createElement("div");
    pop.className = "folder-move-popover subtask-move-popover";
    let selectedNode = null;

    function reposition() {
      const margin = 8;
      let left = x, top = y;
      left = Math.max(margin, Math.min(left, window.innerWidth - pop.offsetWidth - margin));
      top = Math.max(margin, Math.min(top, window.innerHeight - pop.offsetHeight - margin));
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }

    function renderNodeList() {
      pop.innerHTML = "";
      selectedNode = null;
      const searchRow = document.createElement("div");
      searchRow.className = "folder-move-add-row";
      const search = document.createElement("input");
      search.type = "text";
      search.className = "folder-move-add-input";
      search.placeholder = "Search nodes…";
      search.spellcheck = false;
      search.autocomplete = "off";
      search.addEventListener("click", (e) => e.stopPropagation());
      search.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); closeSubtaskMovePopover(); }
      });
      searchRow.appendChild(search);
      pop.appendChild(searchRow);

      const list = document.createElement("div");
      pop.appendChild(list);

      const allNodes = collectAllNodesFlat().filter(n => n.id !== (tasksEditingTarget && tasksEditingTarget.nodeId));
      function renderMatches() {
        list.innerHTML = "";
        const q = search.value.trim().toLowerCase();
        const matches = (q ? allNodes.filter(n => (n.text || "").toLowerCase().includes(q)) : allNodes).slice(0, 200);
        if (!matches.length) {
          const empty = document.createElement("div");
          empty.className = "folder-move-option";
          empty.textContent = "No matching nodes";
          list.appendChild(empty);
          return;
        }
        matches.forEach((n) => {
          const opt = document.createElement("button");
          opt.type = "button";
          opt.className = "folder-move-option";
          opt.textContent = n.text || "(untitled)";
          opt.addEventListener("mousedown", (e) => e.preventDefault());
          opt.addEventListener("click", (e) => {
            e.stopPropagation();
            renderTaskList(n);
            reposition();
          });
          list.appendChild(opt);
        });
      }
      search.addEventListener("input", renderMatches);
      renderMatches();
      reposition();
      setTimeout(() => search.focus(), 0);
    }

    function renderTaskList(node) {
      selectedNode = node;
      pop.innerHTML = "";

      const backRow = document.createElement("button");
      backRow.type = "button";
      backRow.className = "folder-move-option subtask-move-back";
      backRow.textContent = `← ${node.text || "(untitled)"}`;
      backRow.title = "Back to node search";
      backRow.addEventListener("mousedown", (e) => e.preventDefault());
      backRow.addEventListener("click", (e) => { e.stopPropagation(); renderNodeList(); });
      pop.appendChild(backRow);

      getNodeTasks(node).forEach((t) => {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "folder-move-option";
        opt.textContent = t.text || "(untitled task)";
        opt.addEventListener("mousedown", (e) => e.preventDefault());
        opt.addEventListener("click", (e) => {
          e.stopPropagation();
          moveSubtaskToNode(sourceTask.id, subtask.id, node, t.id, null);
          closeSubtaskMovePopover();
        });
        pop.appendChild(opt);
      });

      const addRow = document.createElement("div");
      addRow.className = "folder-move-add-row";
      const addInput = document.createElement("input");
      addInput.type = "text";
      addInput.className = "folder-move-add-input";
      addInput.placeholder = "New task…";
      addInput.spellcheck = false;
      addInput.autocomplete = "off";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "folder-move-add-btn";
      addBtn.textContent = "+";
      addBtn.title = "Create task and move here";
      function submitNewTask() {
        const name = addInput.value.trim();
        if (!name) { addInput.focus(); return; }
        moveSubtaskToNode(sourceTask.id, subtask.id, node, null, name);
        closeSubtaskMovePopover();
      }
      addBtn.addEventListener("mousedown", (e) => e.preventDefault());
      addBtn.addEventListener("click", (e) => { e.stopPropagation(); submitNewTask(); });
      addInput.addEventListener("click", (e) => e.stopPropagation());
      addInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submitNewTask(); }
        else if (e.key === "Escape") { e.preventDefault(); closeSubtaskMovePopover(); }
      });
      addRow.append(addInput, addBtn);
      pop.appendChild(addRow);
      reposition();
      setTimeout(() => addInput.focus(), 0);
    }

    document.body.appendChild(pop);
    renderNodeList();
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    subtaskMovePopoverEl = pop;
    subtaskMovePopoverOutsideHandler = (e) => {
      if (!pop.contains(e.target)) closeSubtaskMovePopover();
    };
    setTimeout(() => document.addEventListener("mousedown", subtaskMovePopoverOutsideHandler), 0);
  }

  function openTasksModal(nodeId, r, c) {
    const host = resolveHost(nodeId, r, c);
    if (!host) return;
    commitEditIfActive();
    closeContextMenu();
    tasksEditingTarget = { nodeId, r, c };
    tasksMapStateAtOpen = tasksMapStateSignature(tasksEditingTarget);

    // v506: "Add tasks..." on a whole node starts from the saved "Daily Task"
    // template instead of a blank list. Existing task lists are never touched,
    // and table/calendar cells keep their old blank-start behavior.
    // If this device has not pulled templates from Drive yet, retry once after
    // the normal template sync; only apply if the user still has this same
    // empty node task list open, so an async sync can never overwrite work.
    const tryApplyDailyTaskDefault = () => {
      if (r != null || c != null || getNodeTasks(host).length) return false;
      const tpl = findTaskListTemplateByName("Daily Task");
      if (!tpl) return false;
      insertTaskListTemplate(tpl, host);
      return true;
    };
    if (!tryApplyDailyTaskDefault()) {
      syncTaskTemplatesWithDrive().then(() => {
        if (!tasksEditingTarget ||
            tasksEditingTarget.nodeId !== nodeId ||
            tasksEditingTarget.r != null || tasksEditingTarget.c != null ||
            tasksModal.classList.contains("hidden") ||
            getNodeTasks(host).length) return;
        if (tryApplyDailyTaskDefault()) renderTasksModal();
      }).catch(() => {});
    }

    const node = findNode(nodeId);
    const cellText = (r != null && node && node.table && node.table.cells[r]) ? node.table.cells[r][c] : null;
    const label = r == null ? ((node && node.text) || "(untitled)") : (cellText || `Cell (row ${r + 1}, col ${c + 1})`);
    tasksModalTitle.textContent = `Tasks — ${label}`;
    renderTasksModal();
    zoomModalOpen(tasksModal);
    requestAnimationFrame(() => {
      // On phones, open the task list in a passive/minimized state:
      // size the quick-add field but don't focus it, so the on-screen
      // keyboard does not pop up until the user deliberately taps an input.
      autosizeTextarea(tasksNewInput);
      if (!window.matchMedia("(max-width: 640px)").matches) tasksNewInput.focus();
    });
  }

  function closeTasksModal() {
    const redrawMap = tasksEditingTarget
      ? tasksMapStateAtOpen !== tasksMapStateSignature(tasksEditingTarget)
      : false;
    const redrawNodeId = tasksEditingTarget && tasksEditingTarget.nodeId;
    tasksEditingTarget = null;
    tasksMapStateAtOpen = null;
    randomPickedSubtaskId = null;
    subtaskAddOpenFor.clear();
    closeTaskTemplatesPopover();
    zoomModalClose(tasksModal);
    // Opening and closing Tasks without changing anything used to rebuild the
    // entire canvas. Only redraw when task data that affects the node actually
    // changed during this modal session.
    if (redrawMap) refreshNodeOrRenderAll(redrawNodeId);
  }

