/* Branchline — js/17-calendar-game-timer.js
   Part 17 of 19 of the former single-file app.js. Contents: calendar (📅 toolbar button), affirmation typing game, node timer ("time played").
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- calendar (📅 toolbar button) ----------------
     A single month grid across every task, on every node, in the
     current map that has a due date — the Calendar tab from the
     standalone Tasks app, promoted into Branchline as a read-through
     view over the same per-node task lists (nothing new is stored;
     it just reads node.tasks[].due across the whole tree, including
     inside collapsed branches). Tapping a day opens a popup with that
     day's full due list; each row can be checked off and jumped to on
     the canvas, same as tapping a task normally would. */
  const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const calendarModal = $("#calendar-modal");
  const calendarCard = calendarModal.querySelector(".calendar-modal-card");
  const calendarResizeHandle = $("#calendar-resize-handle");
  const calMonthLabelEl = $("#cal-month-label");
  const calWeekdaysEl = $("#calendar-weekdays");
  const calGridEl = $("#calendar-grid");
  const calPrevBtn = $("#cal-prev-btn");
  const calNextBtn = $("#cal-next-btn");
  const calMonthViewBtn = $("#cal-view-month");
  const calQuarterViewBtn = $("#cal-view-quarter");
  const calSixViewBtn = $("#cal-view-six");
  const calOptionsBtn = $("#cal-options-btn");
  const calOptionsMenu = $("#cal-options-menu");
  const calDayModalBackdrop = $("#cal-day-modal-backdrop");
  const calDayModalTitle = $("#cal-day-modal-title");
  const calDayModalList = $("#cal-day-modal-task-list");
  const calDayModalEmpty = $("#cal-day-modal-empty-state");
  const calDayNewInput = $("#cal-day-new-input");
  const calDaySortBtn = $("#cal-day-sort-stars");
  let calCursor = new Date();
  calCursor.setDate(1); // first of the currently-displayed month
  let calDayModalDate = null; // "YYYY-MM-DD" of the day currently shown, or null when closed
  let calDaySortMode = "off"; // "off" | "star" | "color" — view-only sort toggle for the day popup, reset each time it opens
  let calViewMode = "month";
  try {
    const savedCalView = localStorage.getItem("branchline_calendar_view");
    if (savedCalView === "quarter" || savedCalView === "six") calViewMode = savedCalView;
  } catch (e) {}
  function calendarDesktopViewMode() {
    return window.matchMedia("(min-width: 641px)").matches ? calViewMode : "month";
  }
  function calendarQuarterActive() {
    return calendarDesktopViewMode() === "quarter";
  }
  function calendarSixActive() {
    return calendarDesktopViewMode() === "six";
  }

  // v611: remember the desktop Calendar window size per device.
  // The same saved card size is reused for Month / Q / 6M; each view then
  // reflows its cells/icons proportionally inside that remembered window.
  const CALENDAR_WINDOW_SIZE_KEY = "branchline_calendar_window_size_v1";

  function restoreCalendarWindowSize() {
    if (!calendarCard || window.matchMedia("(max-width: 640px)").matches) return;
    try {
      const saved = JSON.parse(localStorage.getItem(CALENDAR_WINDOW_SIZE_KEY) || "null");
      if (!saved || !Number.isFinite(Number(saved.width)) || !Number.isFinite(Number(saved.height))) return;
      const maxW = window.innerWidth * 0.96;
      const maxH = window.innerHeight * 0.92;
      const w = clamp(Number(saved.width), 420, maxW);
      const h = clamp(Number(saved.height), 320, maxH);
      calendarCard.style.width = w + "px";
      calendarCard.style.height = h + "px";
      syncCalendarResponsiveMetrics();
    } catch (e) {}
  }

  function saveCalendarWindowSize() {
    if (!calendarCard || window.matchMedia("(max-width: 640px)").matches) return;
    const rect = calendarCard.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    try {
      localStorage.setItem(CALENDAR_WINDOW_SIZE_KEY, JSON.stringify({
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }));
    } catch (e) {}
  }

  // Same custom two-axis resize behavior as the Note window.
  // Calendar contents are CSS-grid/container-query based, so Month/Q/6M
  // reflow continuously while the card is being resized.
  let calendarIsResizing = false;
  (function setupCalendarResize() {
    if (!calendarCard || !calendarResizeHandle) return;
    let startX, startY, startW, startH;

    restoreCalendarWindowSize();

    function onMove(e) {
      const dw = e.clientX - startX;
      const dh = e.clientY - startY;
      const maxW = window.innerWidth * 0.96;
      const maxH = window.innerHeight * 0.92;
      calendarCard.style.width = clamp(startW + dw, 420, maxW) + "px";
      calendarCard.style.height = clamp(startH + dh, 320, maxH) + "px";
      syncCalendarResponsiveMetrics();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      saveCalendarWindowSize();
      syncCalendarResponsiveMetrics();
      setTimeout(() => { calendarIsResizing = false; }, 0);
    }
    function onResizeStart(e) {
      if (window.matchMedia("(max-width: 640px)").matches) return;
      e.preventDefault();
      e.stopPropagation();
      calendarIsResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = calendarCard.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
    calendarResizeHandle.addEventListener("mousedown", onResizeStart);
    calendarResizeHandle.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      onResizeStart(e);
    });
  })();

  // v610: size every Calendar view from the actual resized window.
  // The grid CSS below makes Month/Q/6M date rows fill the available height.
  // This measurement then derives icon/text/padding sizes from the real date
  // cell rectangle, using whichever dimension (width or height) is tighter.
  // Result: dragging the window wider/taller or narrower/shorter continuously
  // scales cells AND their contents rather than only changing empty space.
  let calendarResponsiveRaf = 0;
  function syncCalendarResponsiveMetrics() {
    if (window.matchMedia("(max-width: 640px)").matches) {
      calGridEl.style.removeProperty("--cal-r-icon");
      calGridEl.style.removeProperty("--cal-r-pad");
      return;
    }
    if (calendarResponsiveRaf) cancelAnimationFrame(calendarResponsiveRaf);
    calendarResponsiveRaf = requestAnimationFrame(() => {
      calendarResponsiveRaf = 0;
      const cell = calGridEl.querySelector(".calendar-cell:not(.other-month)") ||
        calGridEl.querySelector(".calendar-cell");
      if (!cell) return;
      const rect = cell.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;

      const px = (n) => n.toFixed(2) + "px";
      const icon = clamp(Math.min(rect.width * 0.20, rect.height * 0.42), 5, 34);
      const pad = clamp(Math.min(rect.width * 0.045, rect.height * 0.075), 1.5, 8);
      const gap = clamp(icon * 0.10, 1, 4);
      const dayFont = clamp(Math.min(rect.width * 0.085, rect.height * 0.17), 7, 12);
      const weekdayFont = clamp(icon * 0.62, 7, 11);
      const titleFont = clamp(icon * 0.82, 9, 15);
      const score = clamp(icon * 1.28, 8, 36);
      const markerCount = clamp(icon * 0.64, 5, 14);

      calGridEl.style.setProperty("--cal-r-icon", px(icon));
      calGridEl.style.setProperty("--cal-r-icon-font", px(icon * 0.90));
      calGridEl.style.setProperty("--cal-r-pad", px(pad));
      calGridEl.style.setProperty("--cal-r-gap", px(gap));
      calGridEl.style.setProperty("--cal-r-day-font", px(dayFont));
      calGridEl.style.setProperty("--cal-r-weekday-font", px(weekdayFont));
      calGridEl.style.setProperty("--cal-r-title-font", px(titleFont));
      calGridEl.style.setProperty("--cal-r-score", px(score));
      calGridEl.style.setProperty("--cal-r-count", px(markerCount));
      calGridEl.style.setProperty("--cal-r-edge", px(Math.max(1.5, pad * 0.55)));
    });
  }

  if (typeof ResizeObserver !== "undefined") {
    const calendarResizeObserver = new ResizeObserver(() => syncCalendarResponsiveMetrics());
    calendarResizeObserver.observe(calendarCard);
  }
  window.addEventListener("resize", syncCalendarResponsiveMetrics);

  // Every task on every node, anywhere in the tree — deliberately
  // ignores node.collapsed (unlike the render walks) so a task due
  // today still shows up on the calendar even if its node is tucked
  // inside a collapsed branch.
  function allTasksWithNodes() {
    const out = [];
    if (!state.current) return out;
    (function walk(n) {
      getNodeTasks(n).forEach(t => out.push({ task: t, node: n, r: null, c: null }));
      if (n.table && Array.isArray(n.table.attach)) {
        n.table.attach.forEach((row, r) => (row || []).forEach((a, c) => {
          getNodeTasks(a).forEach(t => out.push({ task: t, node: n, r, c }));
        }));
      }
      (n.children || []).forEach(walk);
    })(state.current.root);
    return out;
  }

  // v589: retention-safe top Calendar. Calendar Child cells stay unchanged,
  // while the summary keeps an additive snapshot per dated cell. Additions
  // and edits flow into Calendar; removals and whole-cell deletion do not
  // erase Calendar history.
  function calendarClone(v) {
    try { return structuredClone(v); } catch (_) {
      try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
    }
  }
  function calendarMergeAdditive(oldValue, liveValue) {
    if (liveValue == null) return calendarClone(oldValue);
    if (oldValue == null) return calendarClone(liveValue);
    if (Array.isArray(liveValue)) {
      const out = Array.isArray(oldValue) ? calendarClone(oldValue) : [];
      liveValue.forEach((item) => {
        if (item && typeof item === "object") {
          const id = item.id || item._id || item.photoId || null;
          const idx = id == null ? -1 : out.findIndex(x => x && typeof x === "object" && (x.id || x._id || x.photoId) === id);
          if (idx >= 0) out[idx] = calendarMergeAdditive(out[idx], item);
          else {
            const same = out.findIndex(x => {
              try { return JSON.stringify(x) === JSON.stringify(item); } catch (_) { return x === item; }
            });
            if (same < 0) out.push(calendarClone(item));
          }
        } else if (!out.includes(item)) out.push(item);
      });
      return out;
    }
    if (typeof liveValue === "object") {
      const out = (oldValue && typeof oldValue === "object" && !Array.isArray(oldValue)) ? calendarClone(oldValue) : {};
      Object.keys(liveValue).forEach(k => {
        const v = liveValue[k];
        if (v == null || v === "") return;
        out[k] = calendarMergeAdditive(out[k], v);
      });
      return out;
    }
    return calendarClone(liveValue);
  }
  function calendarRetainedStore() {
    if (!state.current) return {};
    if (!state.current.calendarRetained || typeof state.current.calendarRetained !== "object")
      state.current.calendarRetained = {};
    return state.current.calendarRetained;
  }

  // v591: snapshot Calendar Child data before any destructive cell/node edit
  // can make it disappear from the live tree. This makes deleting a whole
  // Calendar Child, a Task List, note, photo, etc. non-destructive to the
  // top Calendar. The snapshot is additive: deletions never flow upward.
  function syncCalendarRetainedFromLive() {
    if (!state.current || !state.current.root) return;
    const retained = calendarRetainedStore();
    (function walk(node) {
      const t = node && node.table;
      if (t && t.calendar && Array.isArray(t.cells) && Array.isArray(t.attach)) {
        const year = Number(t.calendarYear), month = Number(t.calendarMonth);
        const start = Number.isFinite(Number(t.calendarStart))
          ? Number(t.calendarStart)
          : (new Date(year, month - 1, 1).getDay() + 6) % 7;
        if (Number.isFinite(year) && Number.isFinite(month)) {
          for (let r = 2; r < t.cells.length; r++) for (let col = 0; col < 7; col++) {
            const offset = (r - 2) * 7 + col - start;
            const d = new Date(year, month - 1, 1 + offset);
            if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
            const host = getCellAttach(node, r, col);
            if (!cellAttachHasAny(host)) continue;
            const iso = toISODate(d);
            const sourceKey = node.id + ":" + r + ":" + col;
            if (!retained[iso] || typeof retained[iso] !== "object") retained[iso] = {};
            const oldHost = retained[iso][sourceKey] && retained[iso][sourceKey].host;
            retained[iso][sourceKey] = {
              sourceKey,
              host: calendarMergeAdditive(oldHost || {}, host)
            };
          }
        }
      }
      (node.children || []).forEach(walk);
    })(state.current.root);
  }

  function allCalendarDateHosts() {
    const liveByDate = {};
    if (!state.current) return liveByDate;
    (function walk(node) {
      const t = node.table;
      if (t && t.calendar && Array.isArray(t.cells) && Array.isArray(t.attach)) {
        const year = Number(t.calendarYear), month = Number(t.calendarMonth);
        const start = Number.isFinite(Number(t.calendarStart))
          ? Number(t.calendarStart)
          : (new Date(year, month - 1, 1).getDay() + 6) % 7;
        if (Number.isFinite(year) && Number.isFinite(month)) {
          for (let r = 2; r < t.cells.length; r++) for (let col = 0; col < 7; col++) {
            const offset = (r - 2) * 7 + col - start;
            const d = new Date(year, month - 1, 1 + offset);
            if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
            const iso = toISODate(d);
            const host = getCellAttach(node, r, col);
            const sourceKey = node.id + ":" + r + ":" + col;
            (liveByDate[iso] = liveByDate[iso] || []).push({ node, r, c: col, host, sourceKey, live: true });
          }
        }
      }
      (node.children || []).forEach(walk);
    })(state.current.root);

    const retained = calendarRetainedStore();
    Object.keys(liveByDate).forEach(iso => {
      if (!retained[iso] || typeof retained[iso] !== "object") retained[iso] = {};
      liveByDate[iso].forEach(ref => {
        const old = retained[iso][ref.sourceKey] && retained[iso][ref.sourceKey].host;
        retained[iso][ref.sourceKey] = {
          sourceKey: ref.sourceKey,
          host: calendarMergeAdditive(old || {}, ref.host || {})
        };
      });
    });

    const byDate = {};
    Object.keys(retained).forEach(iso => {
      const liveRefs = liveByDate[iso] || [];
      const liveMap = new Map(liveRefs.map(r => [r.sourceKey, r]));
      Object.keys(retained[iso] || {}).forEach(sourceKey => {
        const saved = retained[iso][sourceKey];
        if (!saved || !saved.host) return;
        const live = liveMap.get(sourceKey);
        (byDate[iso] = byDate[iso] || []).push(live
          ? { ...live, retainedHost: saved.host, host: saved.host }
          : { node: null, r: null, c: null, sourceKey, live: false, host: saved.host, retainedHost: saved.host });
      });
    });
    return byDate;
  }

  function appendRetainedOnlyIcons(strip, retainedHost, liveHost) {
    const retainedIcons = calendarHostIcons(retainedHost || {});
    const liveIcons = calendarHostIcons(liveHost || {});
    const remaining = new Map();
    liveIcons.forEach(i => remaining.set(i.text, (remaining.get(i.text) || 0) + 1));
    retainedIcons.forEach(i => {
      const n = remaining.get(i.text) || 0;
      if (n > 0) { remaining.set(i.text, n - 1); return; }
      const ghost = document.createElement("span");
      ghost.className = "node-table-cell-icon calendar-retained-icon";
      ghost.textContent = i.text;
      ghost.title = (i.title || "Retained Calendar item") + " — retained in Calendar";
      strip.appendChild(ghost);
    });
  }

  function calendarHostIcons(host) {
    const icons = [];
    const photos = getNodeImageIds(host).length;
    if (photos) icons.push({ text: "🖼", title: `${photos} photo${photos === 1 ? "" : "s"}` });
    const notes = getNodeNotes(host);
    notes.filter(n => !isBrainstormNote(n)).forEach(n =>
      icons.push({ text: isDRCNote(n) ? "📋" : (isPlanNote(n) ? "☑" : "📝"), title: n.title || notePreviewText(n) }));
    getNodeUrls(host).forEach(u => {
      const raw = typeof u === "string" ? u : ((u && (u.url || u.href)) || "");
      const isYoutube = /(?:youtube\.com|youtu\.be)/i.test(raw);
      icons.push({ text: isYoutube ? "▶" : "🔗", title: getLinkTitle(host, u) || raw });
    });
    if (hasBrainstormContent(host) || getNodeTasks(host).some(t => getTaskSubtasks(t).some(subtaskHasBrainstormMarker)))
      icons.push({ text: "🧠", title: "Brainstorm" });
    const played = getNodeTimePlayed(host);
    if (played) icons.push({ text: "⏱", title: formatTimePlayed(played) });
    const wins = nodeAffirmationWins(host);
    if (wins) icons.push({ text: "✓", title: `Affirmation ×${wins}` });
    return icons;
  }

  function calendarCombinedDateInfo(hostRefs, dueEntries) {
    const icons = [];
    let score = 0;
    (hostRefs || []).forEach(ref => {
      icons.push(...calendarHostIcons(ref.host));
      score += nodeTaskProgress(ref.host).points || 0;
    });
    // Keep ordinary due-dated tasks visible too; tasks already living in a
    // calendar cell are represented by that cell's score/icons.
    const dayItems = calendarDayItems(dueEntries || []);
    return { icons, score, dayItems };
  }

  function calendarBoxFontSize(count) {
    const base = 13, min = 6.5, step = 0.35, freeSlots = 8;
    const size = base - Math.max(0, count - freeSlots) * step;
    return Math.max(min, size).toFixed(2) + "px";
  }

  // A task with 2+ subtasks gets broken into one small box per subtask
  // (so each can be seen/ticked from the calendar); a task with 0-1
  // subtasks stays a single box for the whole task.
  function calendarDayItems(dayEntries) {
    const items = [];
    dayEntries.forEach(({ task: t, node }) => {
      const subs = getTaskSubtasks(t);
      if (subs.length >= 2) {
        subs.forEach((s) => {
          items.push({ kind: "subtask", task: t, subtask: s, node, done: !!s.done, failed: !!s.failed && !s.done, label: `${t.text || "Untitled task"} — ${s.text || "Untitled subtask"}` });
        });
      } else {
        items.push({ kind: "task", task: t, node, done: !!t.done, failed: !!t.failed && !t.done, label: t.text || "Untitled task" });
      }
    });
    return items;
  }

  function calendarSummaryStyle() {
    const v = state.current && state.current.calendarSummaryStyle;
    return ["modern", "classic", "warm", "sage", "glass", "paper", "minimal", "pastel"].includes(v) ? v : "modern";
  }
  function setCalendarSummaryStyle(mode) {
    if (!state.current || !["modern", "classic", "warm", "sage", "glass", "paper", "minimal", "pastel"].includes(mode)) return;
    pushUndo();
    state.current.calendarSummaryStyle = mode;
    renderCalendar();
    persist();
  }
  function applyCalendarSummaryOptions() {
    if (!calendarModal) return;
    ["modern", "classic", "warm", "sage", "glass", "paper", "minimal", "pastel"].forEach(mode =>
      calendarModal.classList.toggle("calendar-summary-style-" + mode, calendarSummaryStyle() === mode));
    calendarModal.classList.toggle("map-icons-mono", mapIconStyle() === "mono");
  }
  function renderCalendarOptionsMenu() {
    if (!calOptionsMenu) return;
    calOptionsMenu.innerHTML = "";
    const addSection = (title, options, current, setter) => {
      const head = document.createElement("div");
      head.className = "calendar-options-title";
      head.textContent = title;
      calOptionsMenu.appendChild(head);
      const row = document.createElement("div");
      row.className = "calendar-options-row";
      options.forEach(([value, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "calendar-option-choice" + (current === value ? " active" : "");
        btn.textContent = label;
        btn.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          setter(value);
          renderCalendarOptionsMenu();
        });
        row.appendChild(btn);
      });
      calOptionsMenu.appendChild(row);
    };
    addSection("Calendar style",
      [["modern","Modern"],["classic","Classic"],["warm","Warm"],["sage","Sage"],["glass","Glass"],["paper","Paper"],["minimal","Minimal"],["pastel","Pastel"]],
      calendarSummaryStyle(), setCalendarSummaryStyle);
    addSection("Task badge style",
      [["color","Color"],["size","Size"],["both","Both"]],
      taskBadgeStyle(), (v) => { setTaskBadgeStyle(v); renderCalendar(); });
    addSection("Icon style",
      [["mono","B&W"],["color","Color"]],
      mapIconStyle(), (v) => { setMapIconStyle(v); renderCalendar(); });
  }

  function openCalendarModal() {
    commitEditIfActive();
    closeContextMenu();
    calCursor = new Date();
    calCursor.setDate(1);
    restoreCalendarWindowSize();
    renderCalendar();
    zoomModalOpen(calendarModal);
  }
  function closeCalendarModal() {
    zoomModalClose(calendarModal);
  }

  function ensureCalendarWeekdays(container) {
    if (container.childElementCount) return;
    WEEKDAY_LABELS.forEach((w) => {
      const el = document.createElement("div");
      el.className = "calendar-weekday";
      el.textContent = w;
      container.appendChild(el);
    });
  }

  // v563: one reusable month renderer powers both the normal Month view and
  // each of the three month panels in the desktop Quarter view. All icon,
  // task badge, context-menu and marker drag/drop behavior stays identical.
  function renderCalendarMonthInto(gridEl, weekdaysEl, cursorDate, entriesByDate, calendarHostsByDate) {
    ensureCalendarWeekdays(weekdaysEl);
    gridEl.innerHTML = "";

    const year = cursorDate.getFullYear(), month = cursorDate.getMonth();
    const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - startWeekday);
    const today = new Date();

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = toISODate(cellDate);
      const cell = document.createElement("div");
      cell.className = "calendar-cell";
      if (cellDate.getMonth() !== month) cell.classList.add("other-month");
      if (isSameDate(cellDate, today)) cell.classList.add("today");

      const dayHead = document.createElement("div");
      dayHead.className = "calendar-day-head";

      const dayNum = document.createElement("span");
      dayNum.className = "calendar-day-num";
      dayNum.textContent = cellDate.getDate();
      dayHead.appendChild(dayNum);

      const inCurrentMonth = cellDate.getMonth() === month && cellDate.getFullYear() === year;
      const dayEntries = inCurrentMonth ? (entriesByDate[iso] || []) : [];
      const hostRefs = inCurrentMonth ? (calendarHostsByDate[iso] || []) : [];
      const dayItems = calendarDayItems(dayEntries);

      cell.classList.add("node-table-cell", "calendar-summary-node-cell");
      if (hostRefs.length) {
        const combinedPoints = hostRefs.reduce((sum, ref) => {
          const p = nodeTaskProgress(ref.host);
          return sum + Math.max(0, Number(p && p.done) || 0);
        }, 0);
        const hasAnyTasks = hostRefs.some(ref => getNodeTasks(ref.host).length > 0);
        if (hasAnyTasks) {
          const badge = document.createElement("span");
          badge.className = taskBadgeClass(combinedPoints, "node-table-cell-score-badge calendar-summary-score-badge");
          badge.textContent = String(combinedPoints);
          badge.title = `${combinedPoints} combined progress points for ${cellDate.getDate()}/${cellDate.getMonth() + 1}`;
          badge.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const taskRef = hostRefs.find(ref => ref.live && ref.node && getNodeTasks(getCellAttach(ref.node, ref.r, ref.c)).length > 0);
            if (taskRef) {
              state.selectedId = taskRef.node.id;
              state.selectedCell = { nodeId: taskRef.node.id, r: taskRef.r, c: taskRef.c };
              openTasksModal(taskRef.node.id, taskRef.r, taskRef.c);
            }
          });
          cell.appendChild(badge);
        }
      } else if (dayItems.length) {
        const doneCount = dayItems.filter(it => it.done).length;
        const counter = document.createElement("span");
        counter.className = "calendar-day-counter" + (doneCount === dayItems.length ? " all-done" : "");
        counter.textContent = `✓${doneCount}`;
        counter.title = `${doneCount} of ${dayItems.length} done`;
        dayHead.appendChild(counter);
      }

      cell.appendChild(dayHead);

      if (hostRefs.length) {
        const summaryStrip = document.createElement("div");
        summaryStrip.className = "node-table-cell-icons calendar-summary-icon-strip";
        hostRefs.forEach(ref => {
          if (ref.live && ref.node) {
            const liveHost = getCellAttach(ref.node, ref.r, ref.c);
            const realStrip = buildCellIconStrip(ref.node, ref.r, ref.c);
            Array.from(realStrip.children).forEach(icon => {
              if (!icon.classList.contains("node-table-cell-add")) summaryStrip.appendChild(icon);
            });
            appendRetainedOnlyIcons(summaryStrip, ref.retainedHost || ref.host, liveHost);
          } else {
            appendRetainedOnlyIcons(summaryStrip, ref.host, {});
          }
        });
        cell.appendChild(summaryStrip);

        const primary = hostRefs.find(ref => ref.live && ref.node) || hostRefs[0];
        if (primary && primary.live && primary.node) {
          cell.dataset.summaryNodeId = primary.node.id;
          cell.dataset.r = String(primary.r);
          cell.dataset.c = String(primary.c);
        }

        cell.addEventListener("contextmenu", (e) => {
          if (!primary || !primary.live || !primary.node) return;
          e.preventDefault();
          e.stopPropagation();
          state.selectedId = primary.node.id;
          state.selectedCell = { nodeId: primary.node.id, r: primary.r, c: primary.c };
          state.cellRangeAnchor = { nodeId: primary.node.id, r: primary.r, c: primary.c };
          openCellAddMenu(primary.node, primary.r, primary.c, e.clientX, e.clientY);
        });

        cell.addEventListener("dragover", (e) => {
          if (!markerDragAvailable(e)) return;
          const drag = markerDragState;
          if (drag && drag.sourceNodeId === primary.node.id &&
              drag.sourceR === primary.r && drag.sourceC === primary.c) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
          cell.classList.add("marker-drop-target");
        });
        cell.addEventListener("dragleave", (e) => {
          if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
          cell.classList.remove("marker-drop-target");
        });
        cell.addEventListener("drop", (e) => {
          const drag = readMarkerDragPayload(e);
          if (!drag) return;
          if (drag.sourceNodeId === primary.node.id &&
              drag.sourceR === primary.r && drag.sourceC === primary.c) return;
          e.preventDefault();
          e.stopPropagation();
          cell.classList.remove("marker-drop-target");
          completeMarkerDrop(primary.node.id, !!e.altKey, primary.r, primary.c);
        });
      }

      // v571: Task Lists in the summary Calendar are represented by the
      // modern score badge above. Do not also render the legacy per-task
      // checkbox glyphs (☐/☑/☒) below the cell icons.
      gridEl.appendChild(cell);
    }
  }

  function renderCalendar() {
    applyCalendarSummaryOptions();
    const viewMode = calendarDesktopViewMode();
    const quarter = viewMode === "quarter";
    const six = viewMode === "six";
    calendarModal.classList.toggle("calendar-quarter-view", quarter);
    calendarModal.classList.toggle("calendar-six-view", six);
    calMonthViewBtn.classList.toggle("active", viewMode === "month");
    calQuarterViewBtn.classList.toggle("active", quarter);
    calSixViewBtn.classList.toggle("active", six);
    calMonthViewBtn.setAttribute("aria-pressed", viewMode === "month" ? "true" : "false");
    calQuarterViewBtn.setAttribute("aria-pressed", quarter ? "true" : "false");
    calSixViewBtn.setAttribute("aria-pressed", six ? "true" : "false");
    calPrevBtn.title = quarter ? "Previous quarter" : "Previous month";
    calNextBtn.title = quarter ? "Next quarter" : "Next month";

    const entriesByDate = {};
    allTasksWithNodes().forEach((entry) => {
      if (entry.task.due) (entriesByDate[entry.task.due] = entriesByDate[entry.task.due] || []).push(entry);
    });
    const calendarHostsByDate = allCalendarDateHosts();

    if (viewMode === "month") {
      calMonthLabelEl.textContent = `${MONTH_LABELS[calCursor.getMonth()]} ${calCursor.getFullYear()}`;
      calWeekdaysEl.classList.remove("hidden");
      calGridEl.classList.remove("calendar-quarter-grid", "calendar-six-grid");
      renderCalendarMonthInto(calGridEl, calWeekdaysEl, calCursor, entriesByDate, calendarHostsByDate);
      syncCalendarResponsiveMetrics();
      return;
    }

    let firstMonthDate;
    let panelCount;
    if (quarter) {
      const year = calCursor.getFullYear();
      const quarterIndex = Math.floor(calCursor.getMonth() / 3);
      firstMonthDate = new Date(year, quarterIndex * 3, 1);
      panelCount = 3;
      calMonthLabelEl.textContent = `Q${quarterIndex + 1} ${year}`;
    } else {
      // v569: "recent 6 months" means the month at calCursor plus the five
      // immediately before it. Previous/Next shifts this rolling window by
      // one month at a time while calCursor remains the window's end month.
      firstMonthDate = new Date(calCursor.getFullYear(), calCursor.getMonth() - 5, 1);
      panelCount = 6;
      const lastMonthDate = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
      const firstLabel = `${MONTH_LABELS[firstMonthDate.getMonth()].slice(0,3)} ${firstMonthDate.getFullYear()}`;
      const lastLabel = `${MONTH_LABELS[lastMonthDate.getMonth()].slice(0,3)} ${lastMonthDate.getFullYear()}`;
      calMonthLabelEl.textContent = `${firstLabel} – ${lastLabel}`;
    }

    calWeekdaysEl.classList.add("hidden");
    calGridEl.innerHTML = "";
    calGridEl.classList.toggle("calendar-quarter-grid", quarter);
    calGridEl.classList.toggle("calendar-six-grid", six);

    for (let offset = 0; offset < panelCount; offset++) {
      const monthDate = new Date(firstMonthDate.getFullYear(), firstMonthDate.getMonth() + offset, 1);
      const panel = document.createElement("section");
      panel.className = "calendar-quarter-month calendar-multi-month-panel";

      const title = document.createElement("div");
      title.className = "calendar-quarter-month-title";
      title.textContent = `${MONTH_LABELS[monthDate.getMonth()]} ${monthDate.getFullYear()}`;

      const weekdays = document.createElement("div");
      weekdays.className = "calendar-quarter-weekdays";

      const grid = document.createElement("div");
      grid.className = "calendar-quarter-month-grid";

      panel.append(title, weekdays, grid);
      calGridEl.appendChild(panel);
      renderCalendarMonthInto(grid, weekdays, monthDate, entriesByDate, calendarHostsByDate);
    }
    syncCalendarResponsiveMetrics();
  }

  // v582: iPhone-like horizontal month transition on phones. Desktop/Q/6M
  // keep their immediate navigation behavior.
  let calMonthAnimating = false;
  function animateCalendarMonthChange(direction) {
    const phoneMonth = window.matchMedia("(max-width: 640px)").matches && calendarDesktopViewMode() === "month";
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!phoneMonth || reduceMotion) {
      calCursor.setMonth(calCursor.getMonth() + direction);
      renderCalendar();
      return;
    }
    if (calMonthAnimating) return;
    calMonthAnimating = true;
    const outX = direction > 0 ? "-22%" : "22%";
    calGridEl.style.setProperty("--cal-slide-x", outX);
    calGridEl.classList.add("calendar-month-slide-out");
    calMonthLabelEl.classList.add("calendar-month-label-fade");
    setTimeout(() => {
      calCursor.setMonth(calCursor.getMonth() + direction);
      renderCalendar();
      calGridEl.classList.remove("calendar-month-slide-out");
      calGridEl.style.setProperty("--cal-slide-enter-x", direction > 0 ? "28%" : "-28%");
      calGridEl.classList.add("calendar-month-slide-in");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        calGridEl.classList.add("calendar-month-slide-in-active");
        calMonthLabelEl.classList.remove("calendar-month-label-fade");
      }));
      setTimeout(() => {
        calGridEl.classList.remove("calendar-month-slide-in", "calendar-month-slide-in-active");
        calGridEl.style.removeProperty("--cal-slide-x");
        calGridEl.style.removeProperty("--cal-slide-enter-x");
        calMonthAnimating = false;
      }, 270);
    }, 145);
  }
  calPrevBtn.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 640px)").matches) return animateCalendarMonthChange(-1);
    const step = calendarQuarterActive() ? 3 : 1;
    calCursor.setMonth(calCursor.getMonth() - step);
    renderCalendar();
  });
  calNextBtn.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 640px)").matches) return animateCalendarMonthChange(1);
    const step = calendarQuarterActive() ? 3 : 1;
    calCursor.setMonth(calCursor.getMonth() + step);
    renderCalendar();
  });
  calMonthViewBtn.addEventListener("click", () => {
    calViewMode = "month";
    try { localStorage.setItem("branchline_calendar_view", calViewMode); } catch (e) {}
    renderCalendar();
  });
  calQuarterViewBtn.addEventListener("click", () => {
    calViewMode = "quarter";
    try { localStorage.setItem("branchline_calendar_view", calViewMode); } catch (e) {}
    renderCalendar();
  });
  calSixViewBtn.addEventListener("click", () => {
    calViewMode = "six";
    try { localStorage.setItem("branchline_calendar_view", calViewMode); } catch (e) {}
    renderCalendar();
  });
  if (calOptionsBtn && calOptionsMenu) {
    calOptionsBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const opening = calOptionsMenu.classList.contains("hidden");
      if (opening) renderCalendarOptionsMenu();
      calOptionsMenu.classList.toggle("hidden", !opening);
    });
    calendarCard.addEventListener("click", (e) => {
      if (!calOptionsMenu.classList.contains("hidden") && !calOptionsMenu.contains(e.target) && e.target !== calOptionsBtn)
        calOptionsMenu.classList.add("hidden");
    });
  }

  // v546: swipe the Calendar horizontally to change month. Horizontal
  // intent must clearly dominate vertical movement so normal phone scrolling,
  // icon taps and cell interactions are not hijacked.
  let calSwipeStartX = 0, calSwipeStartY = 0, calSwipeTracking = false, calSwipeDx = 0;
  calendarModal.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || calendarModal.classList.contains("hidden") || calMonthAnimating) return;
    const t = e.touches[0];
    calSwipeStartX = t.clientX;
    calSwipeStartY = t.clientY;
    calSwipeDx = 0;
    calSwipeTracking = true;
  }, { passive: true });
  calendarModal.addEventListener("touchmove", (e) => {
    if (!calSwipeTracking || !e.touches.length || calendarDesktopViewMode() !== "month") return;
    const t = e.touches[0];
    const dx = t.clientX - calSwipeStartX;
    const dy = t.clientY - calSwipeStartY;
    if (Math.abs(dx) < Math.abs(dy) * 1.15) return;
    calSwipeDx = dx;
    const limited = Math.max(-72, Math.min(72, dx * .34));
    calGridEl.style.transform = `translate3d(${limited}px,0,0)`;
    calGridEl.style.opacity = String(1 - Math.min(.14, Math.abs(limited) / 520));
  }, { passive: true });
  calendarModal.addEventListener("touchend", (e) => {
    if (!calSwipeTracking || !e.changedTouches.length) return;
    calSwipeTracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - calSwipeStartX;
    const dy = t.clientY - calSwipeStartY;
    calGridEl.style.transform = "";
    calGridEl.style.opacity = "";
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.35) {
      calGridEl.classList.add("calendar-month-snap-back");
      setTimeout(() => calGridEl.classList.remove("calendar-month-snap-back"), 220);
      return;
    }
    animateCalendarMonthChange(dx < 0 ? 1 : -1);
  }, { passive: true });
  $("#calendar-back").addEventListener("click", closeCalendarModal);
  $("#calendar-close").addEventListener("click", closeCalendarModal);
  let calendarBackdropMousedown = false;
  calendarModal.addEventListener("mousedown", (e) => {
    calendarBackdropMousedown = (e.target === calendarModal);
  });
  calendarModal.addEventListener("click", (e) => {
    if (!calendarIsResizing && e.target === calendarModal && calendarBackdropMousedown) closeCalendarModal();
  });
  $("#btn-calendar").addEventListener("click", openCalendarModal);

  /* ---- Day detail popup — now the same rich, hover-revealed row used
     by the standalone Tasks modal (drag handle, checkbox, "+" to add a
     subtask, ★ priority, delete) rather than the old read-only row, so
     a task can be triaged right from the calendar. The due date itself
     is left off each row — the whole popup is already scoped to one
     day, so repeating it would just be noise. Tasks here still live on
     whichever node owns them (this list is a filtered view across the
     whole tree), so each row keeps a small hover-reveal pill to jump
     to that node, and drag-reorder only takes effect between two tasks
     on the *same* node — a drop across nodes is a no-op. */
  let calDayTaskDragState = null; // { taskId, nodeId, r, c }
  let calDaySubtaskDragState = null; // { taskId, subtaskId } — reorder within one task's own list

  function openCalDayModal(iso) {
    calDayModalDate = iso;
    calDaySortMode = "off";
    renderCalDayModal();
    zoomModalOpen(calDayModalBackdrop, ".day-modal");
    requestAnimationFrame(() => autosizeTextarea(calDayNewInput));
  }
  function closeCalDayModal() {
    calDayModalDate = null;
    zoomModalClose(calDayModalBackdrop);
  }
  function renderCalDayModal() {
    if (!calDayModalDate) return;
    const d = fromISODate(calDayModalDate);
    const today = new Date();
    calDayModalTitle.textContent = isSameDate(d, today)
      ? `Today · ${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`
      : `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

    let dayEntries = allTasksWithNodes().filter(e => e.task.due === calDayModalDate);
    if (calDaySortMode === "star") {
      dayEntries = dayEntries.slice().sort((a, b) => compareTasksByStarAndColor(a.task, b.task));
    } else if (calDaySortMode === "color") {
      dayEntries = dayEntries.slice().sort((a, b) => taskColorSortIndex(a.task) - taskColorSortIndex(b.task));
    }
    calDayModalList.innerHTML = "";
    dayEntries.forEach(({ task: t, node, r, c }) => {
      calDayModalList.appendChild(buildCalDayTaskRow(t, node, r, c));
      const subProg = taskSubtaskProgress(t);
      const subExpanded = (subProg.total > 0 || subtaskAddOpenFor.has(t.id)) && !collapsedSubtaskIds.has(t.id);
      if (subExpanded) calDayModalList.appendChild(renderCalDaySubtaskPanel(node, t, r, c));
    });
    calDayModalEmpty.classList.toggle("hidden", dayEntries.length > 0);
    calDaySortBtn.disabled = dayEntries.length < 2;
    updateCalDaySortBtnLabel();
  }
  function updateCalDaySortBtnLabel() {
    calDaySortBtn.classList.toggle("active", calDaySortMode !== "off");
    calDaySortBtn.textContent = calDaySortMode === "color" ? "🎨 Sort" : "★ Sort";
    calDaySortBtn.title = calDaySortMode === "off"
      ? "Sort by star, then color"
      : calDaySortMode === "star"
        ? "Sorted by star, then color. Click to sort by color instead."
        : "Sorted by color, ignoring star. Click to turn off sorting.";
  }

  function buildCalDayTaskRow(t, node, r, c) {
    const li = document.createElement("li");
    const host = resolveHost(node.id, r, c);
    const subProg = taskSubtaskProgress(t);
    const subExpanded = (subProg.total > 0 || subtaskAddOpenFor.has(t.id)) && !collapsedSubtaskIds.has(t.id);
    li.className = "task-row" + (t.done ? " done" : "") + (t.failed ? " failed" : "") + (getTaskStars(t) > 0 ? " starred" : "") + (subExpanded ? " has-open-subtasks" : "");
    const rowColor = getTaskColor(t);
    li.style.background = taskColorTint(rowColor) || "";

    const sameList = (state) => state && state.nodeId === node.id && (state.r ?? null) === (r ?? null) && (state.c ?? null) === (c ?? null);

    li.addEventListener("dragover", (e) => {
      if (!calDayTaskDragState || calDayTaskDragState.taskId === t.id || !sameList(calDayTaskDragState)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = li.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      li.classList.toggle("drag-over-top", before);
      li.classList.toggle("drag-over-bottom", !before);
    });
    li.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && li.contains(e.relatedTarget)) return;
      li.classList.remove("drag-over-top", "drag-over-bottom");
    });
    li.addEventListener("drop", (e) => {
      if (!calDayTaskDragState || calDayTaskDragState.taskId === t.id || !sameList(calDayTaskDragState)) return;
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      li.classList.remove("drag-over-top", "drag-over-bottom");
      reorderCalDayTask(host, calDayTaskDragState.taskId, t.id, before);
    });

    const handle = document.createElement("span");
    handle.className = "task-drag-handle";
    handle.textContent = "⠿";
    handle.title = `Drag to reorder within "${node.text || "(untitled)"}"`;
    handle.draggable = true;
    handle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    handle.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      if (!requireSignIn()) { e.preventDefault(); return; }
      calDayTaskDragState = { taskId: t.id, nodeId: node.id, r: r ?? null, c: c ?? null };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
      li.classList.add("task-dragging");
    });
    handle.addEventListener("dragend", () => {
      li.classList.remove("task-dragging");
      calDayTaskDragState = null;
      calDayModalList.querySelectorAll(".task-row").forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
    });

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "task-checkbox";
    cb.checked = !!t.done;
    cb.addEventListener("change", () => {
      pushUndo();
      setTaskDone(t, cb.checked);
      persist();
      renderCalDayModal();
      renderCalendar();
    });

    // ✗ — mark this task failed (the opposite of the done checkbox).
    const failBtn = makeTaskFailButton(!!t.failed, () => {
      pushUndo();
      setTaskFailed(t, !t.failed);
      persist();
      renderCalDayModal();
      renderCalendar();
    });

    // Optional color label — same shared popover as the Tasks modal (see
    // getTaskColor/openTaskColorPopover), since both edit the same task
    // objects. Shown as a hollow ring in the current color; the light
    // fill on the whole row is the primary indicator.
    const colorBtn = document.createElement("button");
    colorBtn.type = "button";
    const calTaskColor = getTaskColor(t);
    colorBtn.className = "task-color-dot" + (calTaskColor ? "" : " task-color-dot-empty");
    if (calTaskColor) colorBtn.style.borderColor = calTaskColor;
    colorBtn.title = calTaskColor ? "Change color label" : "Add a color label";
    colorBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTaskColorPopover(colorBtn, t, renderCalDayModal);
    });

    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = t.text || "Untitled task";
    if (!t.done && !t.failed) text.style.color = taskFontColor(t);
    text.title = subProg.total ? `${subProg.done} of ${subProg.total} subtasks` : "";

    // ★ priority — same 0/1 star toggle as the Tasks modal.
    const stars = getTaskStars(t);
    const star = document.createElement("button");
    star.type = "button";
    star.className = "task-star" + (stars > 0 ? " starred" : "");
    star.textContent = stars > 0 ? "★" : "☆";
    star.title = stars > 0 ? "Starred — click to clear" : "Star this task for priority";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      if (blockedByStarCap(host, t)) return;
      if (stars === 0 && blockStarIfTooManySubtasks(t)) return;
      const next = stars > 0 ? 0 : 1;
      pushUndo();
      t.stars = next;
      t.starred = t.stars > 0;
      persist();
      renderCalDayModal();
    });

    // Add-subtask icon — same reachable-without-double-click affordance
    // as the Tasks modal row.
    const subtaskBtn = document.createElement("button");
    subtaskBtn.type = "button";
    subtaskBtn.className = "task-subtask-btn" + (subProg.total ? " has-subtasks" : "");
    subtaskBtn.title = subProg.total ? "Add another subtask" : "Add a subtask";
    subtaskBtn.textContent = "+";
    subtaskBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    subtaskBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsedSubtaskIds.delete(t.id);
      subtaskAddOpenFor.add(t.id);
      renderCalDayModal();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "task-delete";
    del.title = "Delete task";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!requireSignIn()) return;
      if (!confirm(`Delete the task "${t.text || "Untitled task"}"?`)) return;
      pushUndo();
      host.tasks = getNodeTasks(host).filter(x => x !== t);
      persist();
      renderCalDayModal();
      renderCalendar();
    });

    // Which node this task lives on — a small hover-reveal pill (rather
    // than always-on) so the row itself stays a clean, flat to-do line.
    const nodeBtn = document.createElement("button");
    nodeBtn.type = "button";
    nodeBtn.className = "task-source-node";
    nodeBtn.title = "Jump to this node on the canvas";
    nodeBtn.textContent = node.text || "(untitled)";
    nodeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeCalDayModal();
      closeCalendarModal();
      focusNodeInCanvas(node.id);
    });

    li.title = subExpanded
      ? "Double-click to hide subtasks"
      : (subProg.total ? `${subProg.done} of ${subProg.total} subtasks — double-click to view` : "Double-click to add subtasks");

    li.addEventListener("contextmenu", (e) => {
      if (e.target.closest("button,input,.task-checkbox,.task-fail-btn,.task-star,.task-color-dot,.task-delete,.task-drag-handle,.task-source-node,.task-subtask-btn")) return;
      e.preventDefault();
      e.stopPropagation();
      if (window.matchMedia("(max-width: 640px) and (any-pointer: coarse)").matches) return;
      openTaskContextMenu(e.clientX, e.clientY, host, t, () => {
        renderCalDayModal();
        renderCalendar();
      }, {
        openNotes: () => openNoteModal(node.id, undefined, null, t.id, r != null ? { r, c } : null),
        jumpToNode: () => {
          closeCalDayModal();
          closeCalendarModal();
          focusNodeInCanvas(node.id);
        }
      });
    });
    installTaskContextLongPress(li, (x, y) => {
      openTaskContextMenu(x, y, host, t, () => {
        renderCalDayModal();
        renderCalendar();
      }, {
        openNotes: () => openNoteModal(node.id, undefined, null, t.id, r != null ? { r, c } : null),
        jumpToNode: () => {
          closeCalDayModal();
          closeCalendarModal();
          focusNodeInCanvas(node.id);
        }
      });
    });

    li.addEventListener("dblclick", (e) => {
      if (e.target.closest(".task-checkbox, .task-fail-btn, .task-star, .task-color-dot, .task-delete, .task-drag-handle, .task-source-node")) return;
      if (subExpanded) {
        collapsedSubtaskIds.add(t.id);
      } else {
        collapsedSubtaskIds.delete(t.id);
        if (!subProg.total) subtaskAddOpenFor.add(t.id);
      }
      renderCalDayModal();
    });

    // Calendar uses the same minimal task row: handle, text, + subtask.
    // Status/star/color/delete/jump live in the task context menu.
    li.appendChild(handle);
    li.appendChild(text);
    li.appendChild(subtaskBtn);
    return li;
  }

  function reorderCalDayTask(host, sourceTaskId, targetTaskId, before) {
    if (sourceTaskId === targetTaskId) return;
    const tasks = getNodeTasks(host).slice();
    const fromIdx = tasks.findIndex(x => x.id === sourceTaskId);
    if (fromIdx === -1) return;
    const [moved] = tasks.splice(fromIdx, 1);
    const toIdx = tasks.findIndex(x => x.id === targetTaskId);
    pushUndo();
    if (toIdx === -1) tasks.push(moved);
    else tasks.splice(before ? toIdx : toIdx + 1, 0, moved);
    host.tasks = tasks;
    persist();
    renderCalDayModal();
  }

  // Builds the same expanded subtask checklist panel as the Tasks
  // modal (checkbox, drag handle, delete, add-subtask input), just
  // re-rendering into the day popup's own list instead.
  function renderCalDaySubtaskPanel(node, t, r, c) {
    const wrap = document.createElement("li");
    wrap.className = "subtask-panel";
    // Same sync as renderSubtaskPanel: match the task row's own color
    // tint instead of the flat default panel background.
    wrap.style.background = taskColorTint(getTaskColor(t)) || "";

    const list = document.createElement("ul");
    list.className = "subtask-list";

    getTaskSubtasks(t).forEach((s) => {
      const row = document.createElement("li");
      row.className = "subtask-row" + (s.done ? " done" : "") + (s.failed ? " failed" : "") + (s.emergencyGlow ? " emergency-glow" : "");
      row.dataset.taskId = t.id;
      row.dataset.subtaskId = s.id;

      row.addEventListener("dragover", (e) => {
        if (!calDaySubtaskDragState || calDaySubtaskDragState.taskId !== t.id || calDaySubtaskDragState.subtaskId === s.id) return;
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
        if (!calDaySubtaskDragState || calDaySubtaskDragState.taskId !== t.id || calDaySubtaskDragState.subtaskId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        row.classList.remove("drag-over-top", "drag-over-bottom");
        moveCalDaySubtask(t, calDaySubtaskDragState.subtaskId, s.id, before);
      });

      // The whole pill is the drag handle — grab it anywhere to reorder
      // (turned off while its text is being edited, so text can be selected).
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        if (!requireSignIn()) { e.preventDefault(); return; }
        calDaySubtaskDragState = { taskId: t.id, subtaskId: s.id };
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
        row.classList.add("task-dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("task-dragging");
        calDaySubtaskDragState = null;
        calDayModalList.querySelectorAll(".subtask-row").forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
      });

      const stext = document.createElement("span");
      stext.className = "subtask-text";
      stext.contentEditable = "false";
      stext.spellcheck = false;
      stext.textContent = s.text;
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
        if (window.matchMedia("(max-width: 640px)").matches) return;
        if (subtaskClickTimer) { clearTimeout(subtaskClickTimer); subtaskClickTimer = null; return; }
        subtaskClickTimer = setTimeout(() => {
          subtaskClickTimer = null;
          pushUndo();
          setSubtaskDone(t, s, !s.done);
          persist();
          renderCalDayModal();
          renderCalendar();
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
      stext.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); stext.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); stext.textContent = s.text; stext.blur(); }
      });
      stext.addEventListener("blur", () => {
        const v = stext.textContent.trim();
        let brainstormVisibilityChanged = false;
        let specialNoteVisibilityChanged = false;
        if (v && v !== s.text) {
          const beforeBrainstorm = isBrainstormPrefixText(s.text) || hasBrainstormContent(s);
          const beforeSpecialNote = specialSubtaskNoteTemplateName(s);
          pushUndo();
          s.text = v;
          syncSubtaskNoteTitles(s);
          brainstormVisibilityChanged = beforeBrainstorm !== (isBrainstormPrefixText(s.text) || hasBrainstormContent(s));
          specialNoteVisibilityChanged = beforeSpecialNote !== specialSubtaskNoteTemplateName(s);
          persist();
        } else {
          stext.textContent = s.text;
        }
        stext.title = s.text;
        stext.contentEditable = "false";
        row.draggable = true;
        if (brainstormVisibilityChanged || specialNoteVisibilityChanged) {
          renderCalDayModal();
          renderCalendar();
        }
      });

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (row.__subtaskLongPressConsumed) return;
        openSubtaskContextMenu(e.clientX, e.clientY, t, s, () => { renderCalDayModal(); renderCalendar(); });
      });
      installSubtaskLongPress(row, (x, y) => {
        openSubtaskContextMenu(x, y, t, s, () => { renderCalDayModal(); renderCalendar(); });
      });

      // Calendar mirrors Tasks for special subtask note affordances.
      const calSubtaskNotes = getTaskNotes(s);
      const calSubtaskIsDRC = isDRCNote(calSubtaskNotes[0]) || (s.text || "").trim().toUpperCase() === "DRC";
      const calSubtaskIsPlan = isPlanNoteFor(calSubtaskNotes[0], s);
      const calSubtaskSpecialName = specialSubtaskNoteTemplateName(s);
      const calSubtaskIsBrainstorm = subtaskHasBrainstormMarker(s);

      let calBrainstormIcon = null;
      if (calSubtaskIsBrainstorm) {
        calBrainstormIcon = document.createElement("span");
        calBrainstormIcon.className = "subtask-note-icon subtask-brainstorm-icon";
        calBrainstormIcon.textContent = "🧠";
        calBrainstormIcon.title = hasBrainstormContent(s) ? "Brainstorm — tap to keep writing" : "Brainstorm — tap to start";
        calBrainstormIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openBrainstormModal(node.id, r, c, t.id, s.id);
        });
      }

      let calNoteIcon = null;
      if (calSubtaskNotes.length || calSubtaskIsDRC || calSubtaskIsPlan || calSubtaskSpecialName) {
        calNoteIcon = document.createElement("span");
        calNoteIcon.className = "subtask-note-icon";
        if (calSubtaskIsDRC) calNoteIcon.appendChild(drcIconEl(13));
        else if (calSubtaskIsPlan) calNoteIcon.appendChild(planIconEl(13));
        else calNoteIcon.innerHTML = CELL_NOTE_ICON_SVG;
        calNoteIcon.title = calSubtaskNotes.length
          ? `Notes (${calSubtaskNotes.length})`
          : (calSubtaskSpecialName ? `${calSubtaskSpecialName} — tap to start` : "Add note");
        calNoteIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openNoteModal(node.id, undefined, null, t.id, { r, c }, false, s.id);
        });
      }

      // No inline ✗ button on subtask pills — "Mark failed" / "Clear failed"
      // lives only in the pill's right-click menu (openSubtaskContextMenu).
      row.appendChild(stext);
      if (calBrainstormIcon) row.appendChild(calBrainstormIcon);
      if (calNoteIcon) row.appendChild(calNoteIcon);
      list.appendChild(row);
    });

    // "+" trigger for adding another subtask now lives at the end of
    // this task's own subtask list (it used to sit on the main task
    // row) — hidden while the add-input below is already open.
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
        renderCalDayModal();
      });
      addTriggerLi.appendChild(addTriggerBtn);
      list.appendChild(addTriggerLi);
    }

    enhanceSubtaskList(list, t, () => renderCalDayModal());
    wrap.appendChild(list);

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
          t.done = false;
          t.failed = false;
          persist();
          renderCalDayModal();
          requestAnimationFrame(() => {
            const el = calDayModalList.querySelector(`.subtask-new-input[data-task-id="${t.id}"]`);
            if (el) el.focus();
          });
        } else if (e.key === "Escape") {
          e.preventDefault();
          addInput.blur();
        }
      });
      addInput.addEventListener("blur", () => {
        if (!addInput.value.trim()) {
          subtaskAddOpenFor.delete(t.id);
          renderCalDayModal();
        }
      });
      addRow.appendChild(addInput);
      wrap.appendChild(addRow);
      requestAnimationFrame(() => addInput.focus());
    }

    return wrap;
  }

  function moveCalDaySubtask(t, sourceSubtaskId, targetSubtaskId, before) {
    if (sourceSubtaskId === targetSubtaskId) return;
    const subs = getTaskSubtasks(t).slice();
    const fromIdx = subs.findIndex(x => x.id === sourceSubtaskId);
    if (fromIdx === -1) return;
    const [moved] = subs.splice(fromIdx, 1);
    const toIdx = targetSubtaskId ? subs.findIndex(x => x.id === targetSubtaskId) : -1;
    pushUndo();
    if (toIdx === -1) subs.push(moved);
    else subs.splice(before ? toIdx : toIdx + 1, 0, moved);
    t.subtasks = subs;
    persist();
    renderCalDayModal();
  }

  // "Add a task and press Enter…" — a quick-add for this day. New tasks
  // don't have a node to live on yet in this cross-node view, so they're
  // filed on the current map's root node (same place "drag markers onto
  // another node" can move them out of afterward) with their due date
  // stamped to the day the popup is open on.
  function addTaskFromCalDayModal() {
    if (!calDayModalDate || !state.current) return;
    if (!requireSignIn()) return;
    const val = calDayNewInput.value.trim();
    if (!val) return;
    const node = state.current.root;
    pushUndo();
    if (!Array.isArray(node.tasks)) node.tasks = [];
    node.tasks = node.tasks.concat([{ id: uid(), text: val, done: false, stars: 0, due: calDayModalDate }]);
    calDayNewInput.value = "";
    autosizeTextarea(calDayNewInput);
    persist();
    renderCalDayModal();
    renderCalendar();
  }
  calDayNewInput.addEventListener("input", () => autosizeTextarea(calDayNewInput));
  calDayNewInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addTaskFromCalDayModal(); }
    else if (e.key === "Escape") { e.preventDefault(); calDayNewInput.blur(); }
  });
  calDaySortBtn.addEventListener("click", () => {
    calDaySortMode = calDaySortMode === "off" ? "star" : calDaySortMode === "star" ? "color" : "off";
    renderCalDayModal();
  });

  $("#cal-day-modal-close-btn").addEventListener("click", closeCalDayModal);
  calDayModalBackdrop.addEventListener("click", (e) => { if (e.target === calDayModalBackdrop) closeCalDayModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && calDayModalDate && document.activeElement !== calDayNewInput) closeCalDayModal();
  });

  /* ---------------- affirmation typing game ---------------- */
  // A lightweight typing-practice task: pick a random line, and the task
  // is complete once it's been retyped (matching exactly) AFFIRMATION_TARGET
  // times. Progress (t.count) lives on the task itself, same as `done` on
  // a regular task, so it's saved with the map and survives reloads.

  const affirmationModal = $("#affirmation-modal");
  const affirmationQuoteEl = $("#affirmation-quote");
  const affirmationInput = $("#affirmation-input");
  const affirmationProgressBar = $("#affirmation-progress-bar");
  const affirmationProgressLabel = $("#affirmation-progress-label");
  const affirmationFeedback = $("#affirmation-feedback");
  let affirmationTarget = null; // {nodeId, r, c} — r/c omitted for a node-level game, both given for a table-cell game

  function getAffirmationHost() {
    return affirmationTarget ? resolveHost(affirmationTarget.nodeId, affirmationTarget.r, affirmationTarget.c) : null;
  }

  // Opens the game for a node (r/c omitted) or one of its table cells
  // (r/c given), from the right-click / "+" menu. Resumes an in-progress
  // round if one exists on the target already; otherwise picks a fresh
  // random line and starts a new one.
  function openAffirmationGame(nodeId, r, c) {
    const host = resolveHost(nodeId, r, c);
    if (!host) return;
    if (!affirmationQuotesList.length) {
      openAffirmationQuotesModal();
      return;
    }
    if (!host.affirmation) host.affirmation = { wins: 0, quote: null, count: 0, target: affirmationTargetForRound(0) };
    if (!host.affirmation.quote) {
      host.affirmation.quote = affirmationQuotesList[Math.floor(Math.random() * affirmationQuotesList.length)];
      host.affirmation.count = 0;
      host.affirmation.target = affirmationTargetForRound(host.affirmation.wins || 0);
      persist();
    }
    affirmationTarget = { nodeId, r, c };
    affirmationFeedback.textContent = "";
    affirmationFeedback.className = "affirmation-feedback";
    renderAffirmationModal();
    zoomModalOpen(affirmationModal);
    requestAnimationFrame(() => affirmationInput.focus());
  }

  function closeAffirmationGame() {
    affirmationInput.value = "";
    affirmationInput.classList.remove("shake");
    affirmationTarget = null;
    renderAll();
    zoomModalClose(affirmationModal);
  }

  function renderAffirmationModal() {
    const host = getAffirmationHost();
    const a = getNodeAffirmation(host);
    if (!a) { closeAffirmationGame(); return; }
    affirmationQuoteEl.textContent = a.quote || "";
    const target = a.target || AFFIRMATION_TARGET;
    const count = Math.min(a.count || 0, target);
    affirmationInput.value = "";
    affirmationInput.disabled = false;
    affirmationInput.placeholder = "Type the line above and press Enter…";
    renderAffirmationProgress(a, "");
  }

  // Single combined progress bar: each full rep fills 1/target of the
  // bar, and the rep currently being typed fills its own slice live,
  // letter by letter, as leading characters match — so the bar visibly
  // ticks up on every correct keystroke, not just on a full match.
  function renderAffirmationProgress(a, typedRaw) {
    const target = a.target || AFFIRMATION_TARGET;
    const count = Math.min(a.count || 0, target);
    const quote = a.quote || "";
    // v460: live progress is relaxed too. While the line is still being
    // typed, fill by typed length rather than marking the first typo red.
    // Once the typed line reaches the expected length, only <=80% similarity
    // is considered wrong.
    const expected = normalizeAffirmationText(quote);
    const typed = normalizeAffirmationText(typedRaw).replace(/^\s+/, "");
    const similarity = affirmationSimilarity(typed, expected);
    const lineFraction = expected.length
      ? Math.min(1, typed.length / expected.length) * Math.max(0.8, similarity)
      : 0;
    const hitMismatch = typed.length >= expected.length && similarity <= 0.8;
    const combined = count >= target ? 1 : (count + lineFraction) / target;
    affirmationProgressBar.style.width = Math.round(combined * 100) + "%";
    affirmationProgressBar.classList.toggle("done", count >= target);
    affirmationProgressBar.classList.toggle("wrong", hitMismatch && count < target);
    affirmationProgressLabel.textContent = `${count} / ${target}`;
  }

  function submitAffirmationAttempt() {
    const host = getAffirmationHost();
    const a = getNodeAffirmation(host);
    if (!a) return;
    const target = a.target || AFFIRMATION_TARGET;
    if ((a.count || 0) >= target) return;
    const typed = normalizeAffirmationText(affirmationInput.value);
    if (!typed) return;
    const expected = normalizeAffirmationText(a.quote);
    if (affirmationSimilarity(typed, expected) > 0.8) {
      pushUndo();
      a.count = (a.count || 0) + 1;
      const justWon = a.count >= target;
      if (justWon) {
        a.wins = (a.wins || 0) + 1;
        // Round complete — clear it so the next open starts a fresh line.
        a.quote = null;
        a.count = 0;
      }
      persist();
      affirmationFeedback.textContent = justWon ? "🎉 All done!" : "";
      affirmationFeedback.className = "affirmation-feedback" + (justWon ? " ok" : "");
      if (justWon) {
        renderAll();
        requestAnimationFrame(() => affirmationInput.blur());
        affirmationInput.disabled = true;
        affirmationInput.placeholder = "All done — great job!";
      } else {
        renderAffirmationModal();
      }
    } else {
      affirmationInput.classList.remove("shake");
      void affirmationInput.offsetWidth; // restart the CSS animation on repeat misses
      affirmationInput.classList.add("shake");
      affirmationFeedback.textContent = "Not quite — try again";
      affirmationFeedback.className = "affirmation-feedback bad";
    }
  }

  affirmationInput.addEventListener("input", () => {
    const a = getNodeAffirmation(getAffirmationHost());
    if (!a) return;
    renderAffirmationProgress(a, affirmationInput.value);
  });
  affirmationInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submitAffirmationAttempt(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAffirmationGame(); }
  });
  $("#affirmation-back").addEventListener("click", closeAffirmationGame);
  affirmationModal.addEventListener("click", (e) => { if (e.target === affirmationModal) closeAffirmationGame(); });

  /* ---------------- node timer ("time played") ---------------- */
  // A per-node countdown timer. Start it and it ticks down like a normal
  // countdown (pause/resume, "+1m" to stack on more time, chimes when it
  // hits zero) — but the number that actually matters is the *total*
  // stored on the node (node.timePlayedSec): every second the countdown
  // is genuinely running (not paused) adds one second to that total, so
  // it reflects time actually played/worked, not just time scheduled.
  // That total is shown live both here and as the small "⏱ 45m" badge on
  // the node itself (see renderNode), and is saved with the map like
  // everything else.
  const NODE_TIMER_DEFAULT_SEC = 1 * 60; // default countdown length when starting fresh
  const NODE_TIMER_EXTEND_SEC = 60; // added per "+1m" click while running

  const timerModal = $("#timer-modal");
  const timerNodeLabel = $("#timer-node-label");
  const timerTotalDisplay = $("#timer-total-display");
  const timerResetBtn = $("#timer-reset-btn");
  const timerStartRow = $("#timer-start-row");
  const timerStartBtn = $("#timer-start-btn");
  const timerCountdownRow = $("#timer-countdown-row");
  const timerCountdownDisplay = $("#timer-countdown-display");
  const timerPauseBtn = $("#timer-pause-btn");
  const timerStopBtn = $("#timer-stop-btn");
  const timerExtendBtn = $("#timer-extend-btn");
  const timerDoneLabel = $("#timer-done-label");
  let timerEditingId = null; // {nodeId, r, c} — r/c omitted for a node-level timer, both given for a table-cell timer

  // Only one countdown can run at a time (mirrors the per-task focus
  // timer) but, like that one, it keeps running via setInterval even if
  // this modal is closed or a different node/map is opened, so switching
  // away doesn't quietly cancel a session that's in progress.
  let nodeTimer = null; // { target: {nodeId, r, c}, remaining, duration, paused, intervalId }
  let nodeTimerJustCompleted = null; // {nodeId, r, c}, shown briefly in the modal after a session finishes

  function getNodeTimePlayed(node) {
    return (node && typeof node.timePlayedSec === "number" && node.timePlayedSec > 0) ? node.timePlayedSec : 0;
  }

  // "45m", "1h", "1h 20m" — always whole minutes, so no seconds ever show.
  function formatTimePlayed(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  function openTimerModal(nodeId, r, c) {
    const host = resolveHost(nodeId, r, c);
    if (!host) return;
    commitEditIfActive();
    closeContextMenu();
    timerEditingId = { nodeId, r, c };
    renderTimerModal();
    zoomModalOpen(timerModal);
  }

  function closeTimerModal() {
    timerEditingId = null;
    renderAll();
    zoomModalClose(timerModal);
  }

  function renderTimerModal() {
    const t = timerEditingId;
    const host = t ? resolveHost(t.nodeId, t.r, t.c) : null;
    if (!host) { closeTimerModal(); return; }
    const node = findNode(t.nodeId);
    const cellText = (t.r != null && node && node.table && node.table.cells[t.r]) ? node.table.cells[t.r][t.c] : null;
    timerNodeLabel.textContent = t.r == null ? ((node && node.text) || "(untitled)") : (cellText || `Cell (row ${t.r + 1}, col ${t.c + 1})`);
    const total = getNodeTimePlayed(host);
    timerTotalDisplay.textContent = formatTimePlayed(total);
    timerResetBtn.style.visibility = total ? "visible" : "hidden";

    const runningHere = nodeTimer && sameTarget(nodeTimer.target, t);
    timerCountdownRow.classList.toggle("hidden", !runningHere);
    const justCompletedHere = nodeTimerJustCompleted && sameTarget(nodeTimerJustCompleted, t);
    timerDoneLabel.classList.toggle("hidden", !justCompletedHere);
    timerStartRow.style.display = (runningHere || justCompletedHere) ? "none" : "flex";

    if (runningHere) {
      timerCountdownDisplay.textContent = formatFocusTime(nodeTimer.remaining);
      timerCountdownDisplay.classList.toggle("paused", nodeTimer.paused);
      timerPauseBtn.textContent = nodeTimer.paused ? "▶" : "⏸";
      timerPauseBtn.title = nodeTimer.paused ? "Resume" : "Pause";
    }
  }

  // Cheap live update used on every tick: pushes the new total straight
  // into the node's (or table cell's) badge on the canvas — and this
  // modal, if open for the same target — without a full renderAll() — a
  // per-second re-layout of the whole map would be wasteful, especially
  // on a large mind map.
  function updateNodeTimerLiveUI(target) {
    if (!target) return;
    const host = resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    const total = getNodeTimePlayed(host);
    const badgeLabel = target.r == null
      ? nodesLayer.querySelector(`.node[data-id="${target.nodeId}"] .node-timer-badge span`)
      : nodesLayer.querySelector(`.node[data-id="${target.nodeId}"] .node-table-cell[data-r="${target.r}"][data-c="${target.c}"] .node-table-cell-timer span`);
    if (badgeLabel) {
      badgeLabel.textContent = formatTimePlayed(total);
      badgeLabel.parentElement.title = `${formatTimePlayed(total)} logged — click to add more`;
    } else {
      const activeCounter =
        (nodeTimer && sameTarget(nodeTimer.target, target)) ? nodeTimer :
        (focusTimer && sameTarget(focusTimer.target, target)) ? focusTimer : null;
      if (total && target.nodeId !== state.editingId && activeCounter && !activeCounter.badgeRenderAttempted) {
        // The badge doesn't exist yet because this target previously had no
        // logged time. Create it once for either the node timer OR Task List
        // focus timer, never once per second.
        activeCounter.badgeRenderAttempted = true;
        renderAll();
      }
    }
    if (timerEditingId && sameTarget(timerEditingId, target) && !timerModal.classList.contains("hidden")) {
      timerTotalDisplay.textContent = formatTimePlayed(total);
      timerResetBtn.style.visibility = total ? "visible" : "hidden";
    }
  }

  function startNodeTimer(target, durationSec = NODE_TIMER_DEFAULT_SEC) {
    const host = resolveHost(target.nodeId, target.r, target.c);
    if (!host) return;
    stopNodeTimerInterval();
    stopFocusChime();
    nodeTimerJustCompleted = null;
    pushUndo();
    nodeTimer = {
      target,
      remaining: durationSec,
      duration: durationSec,
      paused: false,
      ticksSincePersist: 0,
      intervalId: setInterval(nodeTimerTick, 1000),
    };
    renderTimerModal();
  }

  // How often the countdown writes its running total to disk while it's
  // actually ticking. This is a *cheap* in-memory update every second
  // (host.timePlayedSec++), but persist() triggers this app's full save
  // path — which re-embeds every photo's bytes into JSON for the folder
  // mirror/Drive upload — so calling it every single second would re-run
  // that heavy work once a second for as long as the timer runs and can
  // exhaust memory on a photo-heavy map. Saving every 10s instead (plus
  // on pause/stop/complete, and the existing flushPersist safety net on
  // tab-hide/close) keeps at most ~10s of countdown time at risk of loss
  // without hammering the save path.
  const NODE_TIMER_PERSIST_EVERY_SEC = 10;

  function nodeTimerTick() {
    if (!nodeTimer || nodeTimer.paused) return;
    nodeTimer.remaining--;
    const host = resolveHost(nodeTimer.target.nodeId, nodeTimer.target.r, nodeTimer.target.c);
    if (host) {
      host.timePlayedSec = getNodeTimePlayed(host) + 1;
      unsavedEdits = true;
      nodeTimer.ticksSincePersist++;
      if (nodeTimer.ticksSincePersist >= NODE_TIMER_PERSIST_EVERY_SEC) {
        nodeTimer.ticksSincePersist = 0;
        persist();
      }
      updateNodeTimerLiveUI(nodeTimer.target);
    }
    if (nodeTimer.remaining <= 0) {
      nodeTimerComplete();
      return;
    }
    if (timerEditingId && sameTarget(timerEditingId, nodeTimer.target)) renderTimerModal();
  }

  function toggleNodeTimerPause() {
    if (!nodeTimer) return;
    nodeTimer.paused = !nodeTimer.paused;
    if (nodeTimer.paused) {
      nodeTimer.ticksSincePersist = 0;
      persist();
    }
    renderTimerModal();
  }

  function extendNodeTimer(seconds) {
    if (!nodeTimer) return;
    nodeTimer.remaining += seconds;
    nodeTimer.duration += seconds;
    renderTimerModal();
  }

  // Clears the interval only — used internally before starting a new
  // countdown, without touching the "just completed" flash state.
  function stopNodeTimerInterval() {
    if (nodeTimer && nodeTimer.intervalId) clearInterval(nodeTimer.intervalId);
    nodeTimer = null;
  }

  function stopNodeTimer() {
    const prev = nodeTimer;
    stopNodeTimerInterval();
    if (prev) {
      persist();
      updateNodeTimerLiveUI(prev.target);
      if (timerEditingId && sameTarget(timerEditingId, prev.target)) renderTimerModal();
    }
  }

  function nodeTimerComplete() {
    const finished = nodeTimer;
    stopNodeTimerInterval();
    if (!finished) return;
    persist();
    updateNodeTimerLiveUI(finished.target);
    startFocusChime();
    nodeTimerJustCompleted = finished.target;
    if (timerEditingId && sameTarget(timerEditingId, finished.target)) renderTimerModal();
    setTimeout(() => {
      if (nodeTimerJustCompleted && sameTarget(nodeTimerJustCompleted, finished.target)) {
        nodeTimerJustCompleted = null;
        if (timerEditingId && sameTarget(timerEditingId, finished.target)) renderTimerModal();
      }
    }, 4000);
  }

  timerStartBtn.addEventListener("click", () => {
    if (!timerEditingId) return;
    startNodeTimer(timerEditingId);
  });
  timerPauseBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleNodeTimerPause(); });
  timerStopBtn.addEventListener("click", (e) => { e.stopPropagation(); stopNodeTimer(); });
  timerExtendBtn.addEventListener("click", (e) => { e.stopPropagation(); extendNodeTimer(NODE_TIMER_EXTEND_SEC); });

  timerResetBtn.addEventListener("click", () => {
    const t = timerEditingId;
    if (!t) return;
    const host = resolveHost(t.nodeId, t.r, t.c);
    if (!host || !getNodeTimePlayed(host)) return;
    pushUndo();
    host.timePlayedSec = 0;
    persist();
    renderTimerModal();
    updateNodeTimerLiveUI(t);
  });

  $("#timer-back").addEventListener("click", closeTimerModal);
  timerModal.addEventListener("click", (e) => { if (e.target === timerModal) closeTimerModal(); });
  document.addEventListener("keydown", (e) => {
    if (timerModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeTimerModal();
  });

