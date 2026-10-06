/* Branchline — js/06-state-sidebar-layout.js
   Part 6 of 19 of the former single-file app.js. Contents: app state, DOM refs, persistence flow, root node live clock, sidebar, layout / geometry module (phase 2).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- app state ---------------- */

  const state = {
    maps: [],
    current: null,       // full mindmap object
    selectedId: null,
    editingId: null,
    linkFromId: null,    // when set, we're in "pick the other end of a link" mode
    moveSourceId: null,  // when set, we're in "pick where to move this node" mode
                          // (started from a node's right-click menu, as an
                          // alternative to drag-and-drop reparenting)
    highlightId: null,   // when set, this node + its branch stay sharp and
                          // every other node/connector is blurred — a
                          // transient view setting, never persisted (see
                          // the `persist` function below, which only
                          // saves `state.current`)
    selectedCell: null,   // {nodeId, r, c} of the last-clicked table cell,
                          // or null — lets a paste anywhere on the page
                          // land on that cell's photos instead of the
                          // selected node's own (see the paste handler
                          // below and handleCellPhotoFiles).
    cellRangeAnchor: null, // {nodeId, r, c} of the last *non*-shift cell
                          // click — the fixed corner a shift-click range
                          // is measured from (see handleTableCellClick).
    cellRange: null,      // {nodeId, r0, c0, r1, c1} rectangle of table
                          // cells currently selected via shift-click, or
                          // null — drives the range highlight and is what
                          // "Merge cells" (see mergeCellRange) acts on.
    scale: 1, tx: 60, ty: 60,
    undoStack: [],
    redoStack: []
  };

  /* ---------------- DOM refs ---------------- */

  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#mindmap-list");
  const worldEl = $("#world");
  const svgEl = $("#lines-svg");
  const nodesLayer = $("#nodes-layer");
  const viewportEl = $("#viewport");
  const titleInput = $("#title-input");
  const layoutSelect = $("#layout-select");
  const saveStatus = $("#save-status");
  const emptyState = $("#empty-state");
  const nodeFabs = $("#node-fabs");
  const ctxMenu = $("#ctx-menu");

  // Every open*ContextMenu function below starts by wiping and rebuilding
  // the menu's contents (it's one reused element for every kind of
  // right-click/long-press menu in the app).
  function resetContextMenu() {
    ctxMenu.innerHTML = "";
    // The popup is shared by node/task/link/cell menus. Clear specialized
    // sizing/skin markers before building the next menu.
    ctxMenu.classList.remove("node-context-menu");
    ctxMenu.classList.remove("subtask-context-menu");
    ctxMenu.classList.remove("cell-context-menu");
    ctxMenu.scrollTop = 0;
    ctxMenu.classList.remove("hidden");
  }

  // Shared positioning for every ctx-menu popup (the node right-click menu,
  // and the smaller link/note picker popups). Reads the menu's *real*
  // rendered width/height instead of assuming a fixed size — the node menu
  // especially varies a lot (a node with photos, notes, tasks, links, and
  // the branch-color swatch grid can run much taller than a guessed 300px),
  // which is what was letting the bottom of the menu run off a phone
  // screen with no way to reach it. Clamped on every side (not just
  // bottom/right) with the same margin the drag handler uses, so the menu
  // never opens partly off the top/left edge either. Call this only after
  // the menu's contents are fully built and appended — it needs the real
  // getBoundingClientRect().
  function positionContextMenu(x, y) {
    const margin = 8;
    const rect = ctxMenu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = clamp(x, margin, Math.max(margin, vw - rect.width - margin));
    const top = clamp(y, margin, Math.max(margin, vh - rect.height - margin));
    ctxMenu.style.left = left + "px";
    ctxMenu.style.top = top + "px";
  }
  const hintBar = $("#hint-bar");

  // Floating tooltip for a link's comment (see getLinkComment/
  // getCellLinkComment) — a single shared element reused for every link
  // icon rather than one per icon, shown on mouseenter and hidden on
  // mouseleave. Deliberately not the native `title` attribute: that's
  // already used for the link's own title/URL, and the native tooltip
  // can't be styled or hold multi-line text comfortably.
  let linkCommentTooltipEl = null;
  function getLinkCommentTooltipEl() {
    if (!linkCommentTooltipEl) {
      linkCommentTooltipEl = document.createElement("div");
      linkCommentTooltipEl.className = "link-comment-tooltip";
      document.body.appendChild(linkCommentTooltipEl);
    }
    return linkCommentTooltipEl;
  }
  function hideLinkCommentTooltip() {
    if (linkCommentTooltipEl) linkCommentTooltipEl.classList.remove("visible");
  }
  function showLinkCommentTooltip(anchorEl, title, comment) {
    const tip = getLinkCommentTooltipEl();
    tip.innerHTML = "";
    if (title) {
      const titleEl = document.createElement("div");
      titleEl.className = "link-comment-tooltip-title";
      titleEl.textContent = title;
      tip.appendChild(titleEl);
    }
    if (comment) {
      const commentEl = document.createElement("div");
      commentEl.className = "link-comment-tooltip-comment";
      commentEl.textContent = comment;
      tip.appendChild(commentEl);
    }
    tip.classList.add("visible");
    const margin = 8;
    const rect = anchorEl.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = clamp(left, margin, Math.max(margin, window.innerWidth - tipRect.width - margin));
    let top = rect.top - tipRect.height - 8;
    if (top < margin) top = rect.bottom + 8; // flip below if no room above
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  // Wires up the hover-to-show behavior on one link icon element.
  // `getComment` and `getTitle` are called fresh on every hover (rather
  // than being baked in once) so an edit made through the right-click
  // menu is reflected the next time the same icon is hovered, without
  // needing a full re-render. `getTitle` is only ever consulted for a
  // YouTube video/short (see youtubeVideoId) — that's the one case where
  // the link's title is a genuinely useful thing to surface here (the
  // video's real name, not just the URL), stacked above the comment in
  // this one styled tooltip. Every other link's title stays exactly
  // where it already was: the native `title` attribute.
  function attachLinkCommentTooltip(el, url, getComment, getTitle) {
    el.addEventListener("mouseenter", () => {
      const title = (youtubeVideoId(url) && getTitle) ? getTitle() : null;
      const comment = getComment();
      if (title || comment) showLinkCommentTooltip(el, title, comment);
    });
    el.addEventListener("mouseleave", hideLinkCommentTooltip);
  }

  /* ---------------- persistence flow ---------------- */

  async function loadAllMaps() {
    state.maps = await DB.getAll();
    state.maps.forEach(ensureFavorite);
    // Catches maps saved by an earlier version of the app, before photos
    // moved into their own store — anything still holding inline base64
    // gets migrated in place (writes are also persisted back to DB.put
    // so this only ever has to happen once per map).
    for (const m of state.maps) {
      if (!m._photosMigrated) {
        await ensurePhotosMigrated(m);
        await DB.put(m);
      }
    }
    sortMaps(state.maps);
  }

  // Drives the "Synced Xs/Xm ago" label. Kept separate from `persist()`
  // itself so the label keeps counting up on its own tick (see the
  // interval below) instead of only updating at the moment a save
  // happens and then sitting frozen on a stale value.
  let lastSavedAt = 0;

  // Same idea as relTime() below but with second-level granularity for
  // the first minute, since jumping straight from "Saved" to "1m ago"
  // reads as much less immediate/trustworthy than "20s ago".
  function relTimeShort(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    return relTime(ts) + " ago";
  }

  function updateSaveStatusLabel() {
    if (!lastSavedAt || saveStatus.classList.contains("saving")) return;
    saveStatus.textContent = "Local saved " + relTimeShort(lastSavedAt);
  }

  // Ticks once a second while the tab is visible so the label keeps
  // advancing (20s ago -> 21s ago -> ... -> 1m ago) without needing a
  // new save. Paused in background tabs, matching the Drive poll's
  // battery/quota-saving behavior elsewhere in this file.
  setInterval(() => {
    if (document.visibilityState === "visible") updateSaveStatusLabel();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateSaveStatusLabel();
  });

  /* ---------------- root node live clock ---------------- */
  // The central/root node doubles as a small live clock: current local
  // time, UTC/US(NY)/UK world clocks, the Vietnamese weekday+date, and
  // the lunar date — ported from the standalone clock.html widget this
  // app started life alongside. The block itself is built once per
  // render (see renderNode), then this ticker just walks back in and
  // refreshes its text every second — cheap DOM writes, no renderAll —
  // so nothing about the map's actual data (or undo history) is touched
  // just because a second went by.

  const ROOT_CLOCK_CAN = ["Giáp","Ất","Bính","Đinh","Mậu","Kỷ","Canh","Tân","Nhâm","Quý"];
  const ROOT_CLOCK_CHI = ["Tý","Sửu","Dần","Mão","Thìn","Tỵ","Ngọ","Mùi","Thân","Dậu","Tuất","Hợi"];

  function rcINT(d) { return Math.floor(d); }

  function rcJdFromDate(dd, mm, yy) {
    const a = rcINT((14 - mm) / 12);
    const y = yy + 4800 - a;
    const m = mm + 12 * a - 3;
    let jd = dd + rcINT((153 * m + 2) / 5) + 365 * y + rcINT(y / 4) - rcINT(y / 100) + rcINT(y / 400) - 32045;
    if (jd < 2299161) jd = dd + rcINT((153 * m + 2) / 5) + 365 * y + rcINT(y / 4) - 32083;
    return jd;
  }

  function rcGetNewMoonDay(k, timeZone) {
    const T = k / 1236.85;
    const T2 = T * T;
    const T3 = T2 * T;
    const dr = Math.PI / 180;
    let Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
    Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
    const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
    const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
    const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
    let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
    C1 -= 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(2 * dr * Mpr);
    C1 -= 0.0004 * Math.sin(3 * dr * Mpr);
    C1 += 0.0104 * Math.sin(2 * dr * F) - 0.0051 * Math.sin((M + Mpr) * dr);
    C1 -= 0.0074 * Math.sin((M - Mpr) * dr) + 0.0004 * Math.sin((2 * F + M) * dr);
    C1 -= 0.0004 * Math.sin((2 * F - M) * dr) - 0.0006 * Math.sin((2 * F + Mpr) * dr);
    C1 += 0.0010 * Math.sin((2 * F - Mpr) * dr) + 0.0005 * Math.sin((2 * Mpr + M) * dr);
    let deltaT;
    if (T < -11) {
      deltaT = 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3;
    } else {
      deltaT = -0.000278 + 0.000265 * T + 0.000262 * T2;
    }
    return rcINT(Jd1 + C1 - deltaT + 0.5 + timeZone / 24);
  }

  function rcGetSunLongitude(jdn, timeZone) {
    const T = (jdn - 2451545.5 - timeZone / 24) / 36525;
    const T2 = T * T;
    const dr = Math.PI / 180;
    const M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
    const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
    let DL = (1.914600 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
    DL += (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.000290 * Math.sin(dr * 3 * M);
    let L = L0 + DL;
    L = L * dr;
    L = L - Math.PI * 2 * rcINT(L / (Math.PI * 2));
    return rcINT(L / Math.PI * 6);
  }

  function rcGetLunarMonth11(yy, timeZone) {
    const off = rcJdFromDate(31, 12, yy) - 2415021;
    const k = rcINT(off / 29.530588853);
    let nm = rcGetNewMoonDay(k, timeZone);
    const sunLong = rcGetSunLongitude(nm, timeZone);
    if (sunLong >= 9) nm = rcGetNewMoonDay(k - 1, timeZone);
    return nm;
  }

  function rcGetLeapMonthOffset(a11, timeZone) {
    const k = rcINT((a11 - 2415021.076998695) / 29.530588853 + 0.5);
    let last = 0;
    let i = 1;
    let arc = rcGetSunLongitude(rcGetNewMoonDay(k + i, timeZone), timeZone);
    do {
      last = arc;
      i++;
      arc = rcGetSunLongitude(rcGetNewMoonDay(k + i, timeZone), timeZone);
    } while (arc !== last && i < 14);
    return i - 1;
  }

  function convertSolar2Lunar(dd, mm, yy, timeZone) {
    const dayNumber = rcJdFromDate(dd, mm, yy);
    const k = rcINT((dayNumber - 2415021.076998695) / 29.530588853);
    let monthStart = rcGetNewMoonDay(k + 1, timeZone);
    if (monthStart > dayNumber) monthStart = rcGetNewMoonDay(k, timeZone);
    let a11 = rcGetLunarMonth11(yy, timeZone);
    let b11 = a11;
    let lunarYear;
    if (a11 >= monthStart) {
      lunarYear = yy;
      a11 = rcGetLunarMonth11(yy - 1, timeZone);
    } else {
      lunarYear = yy + 1;
      b11 = rcGetLunarMonth11(yy + 1, timeZone);
    }
    const lunarDay = dayNumber - monthStart + 1;
    const diff = rcINT((monthStart - a11) / 29);
    let lunarLeap = 0;
    let lunarMonth = diff + 11;
    if (b11 - a11 > 365) {
      const leapMonthDiff = rcGetLeapMonthOffset(a11, timeZone);
      if (diff >= leapMonthDiff) {
        lunarMonth = diff + 10;
        if (diff === leapMonthDiff) lunarLeap = 1;
      }
    }
    if (lunarMonth > 12) lunarMonth -= 12;
    if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;
    return [lunarDay, lunarMonth, lunarYear, lunarLeap];
  }

  function getVietnameseWeekday(date) {
    return ["Chủ nhật","Thứ hai","Thứ ba","Thứ tư","Thứ năm","Thứ sáu","Thứ bảy"][date.getDay()];
  }

  function getCanChiYear(year) {
    return ROOT_CLOCK_CAN[(year + 6) % 10] + " " + ROOT_CLOCK_CHI[(year + 8) % 12];
  }

  function formatTimeInZone(date, timeZone) {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      }).format(date);
    } catch (e) {
      return "--:--:--";
    }
  }

  // Every value the clock block shows, computed fresh from `now` — used
  // both to fill the block in the moment it's created (renderNode) and
  // to refresh it in place every second (rootClockTick) below.
  function rootClockValues(now) {
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    const uh = String(now.getUTCHours()).padStart(2, "0");
    const um = String(now.getUTCMinutes()).padStart(2, "0");
    const us_ = String(now.getUTCSeconds()).padStart(2, "0");
    const dd = now.getDate(), mm = now.getMonth() + 1, yy = now.getFullYear();
    const lunar = convertSolar2Lunar(dd, mm, yy, 7);
    const leapText = lunar[3] ? " nhuận" : "";
    return {
      time: `${h}:${m}:${s}`,
      utc: `${uh}:${um}:${us_}`,
      us: formatTimeInZone(now, "America/New_York"),
      uk: formatTimeInZone(now, "Europe/London"),
      solar: `${getVietnameseWeekday(now)}, ngày ${dd} tháng ${mm} năm ${yy}`,
      lunar: `Âm lịch: ngày ${lunar[0]} tháng ${lunar[1]}${leapText} năm ${getCanChiYear(lunar[2])}`,
    };
  }

  // Only one root node is ever on screen at a time (one map open at
  // once), so a plain class query is enough — no need to track an id.
  function rootClockTick() {
    const block = nodesLayer.querySelector(".node.depth-0 .node-clock-block");
    if (!block) return;
    const v = rootClockValues(new Date());
    const timeEl = block.querySelector(".node-clock-time");
    if (timeEl) timeEl.textContent = v.time;
    const utcEl = block.querySelector('[data-tz="utc"]');
    if (utcEl) utcEl.textContent = v.utc;
    const usEl = block.querySelector('[data-tz="us"]');
    if (usEl) usEl.textContent = v.us;
    const ukEl = block.querySelector('[data-tz="uk"]');
    if (ukEl) ukEl.textContent = v.uk;
    const solarEl = block.querySelector(".node-clock-solar");
    if (solarEl) solarEl.textContent = v.solar;
    const lunarEl = block.querySelector(".node-clock-lunar");
    if (lunarEl) lunarEl.textContent = v.lunar;
  }
  setInterval(() => {
    if (document.visibilityState === "visible") rootClockTick();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") rootClockTick();
  });

  // True from the moment an edit schedules a save until that save has
  // actually finished writing everywhere (local DB, folder, Drive) —
  // covers both persist()'s own 500ms debounce delay and the awaits
  // inside it. DriveDB.syncFromDrive() callers (pollDriveUpdates, plus
  // the sign-in/restore sync) check this the same way they check
  // state.editingId, so an incoming sync can't overwrite a change that
  // hasn't finished saving yet, even after you've clicked away from the
  // node itself.
  let unsavedEdits = false;
  let persistTimer = null;

  // Reconciles PhotoDB against whatever photo ids the map's node tree
  // actually references right now, deleting any leftover rows (from a
  // deleted node, a crop/text-edit replacing an id, "Remove all photos"
  // racing an in-flight write, etc.).
  //
  // Called two ways: manually, from the Storage panel's "Clean up
  // current map" button; and automatically, but only via
  // scheduleAutoPhotoCleanup/runAutoPhotoCleanup below, which delay this
  // until 60s after the map's last save with no further edits in
  // between. That restriction is the fix for a real bug this used to
  // have: this function used to run after every single autosave, so ANY
  // moment where the in-memory node tree was transiently incomplete/
  // stale right when a save fired (a race during map load/sync, a bug
  // elsewhere, an interrupted operation, etc.) could make it look like
  // photos were "orphaned" and permanently delete their bytes from
  // PhotoDB — with no undo. Running it only after a full minute of
  // settled quiet (and re-checking the map hasn't changed, nothing's
  // syncing, etc. — see runAutoPhotoCleanup) avoids that same trap while
  // still cleaning things up without a manual click every time.
  async function gcOrphanedPhotos(map) {
    if (!map) return;
    try {
      // Includes photos attached to link comments (video/link screenshots),
      // which the sweep used to overlook.
      const referenced = collectReferencedPhotoIds(map.root);
      // A source map can own bytes still used by one or more lightweight
      // recovery maps. Count those references as live too.
      sharedPhotoDependentMaps(map.id).forEach((dep) => {
        collectReferencedPhotoIds(dep.root).forEach((id) => referenced.add(id));
      });
      const rows = await PhotoDB.getAllForMap(map.id);
      for (const r of rows) {
        if (!referenced.has(r.id)) {
          await PhotoDB.delete(r.id);
          forgetPhotoFingerprint(r.id);
          const url = photoCache.get(r.id);
          if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ } }
          photoCache.delete(r.id);
          photoBlobCache.delete(r.id);
        }
      }
    } catch (e) { /* best-effort cleanup, safe to skip on failure */ }
  }

  // Photo rows only ever get orphaned by rare edge cases (an interrupted
  // operation, a bug elsewhere) — the ordinary paths (deleting a node,
  // replacing a photo via crop/text/combine) already delete the old
  // photo id directly, right when it happens. So this doesn't need to
  // run often; it just needs to run at a moment when the in-memory tree
  // is guaranteed to be complete and settled, which the comment above
  // used to rule out for every automatic call site. Idle-after-save is
  // the one moment that's actually safe: scheduleAutoPhotoCleanup below
  // is called every time a save finishes, and (re)starts a fresh 60s
  // timer — so it only ever fires a full minute after the LAST edit,
  // never mid-edit, never mid-sync, and never for a map that isn't the
  // one still open (all checked again in runAutoPhotoCleanup itself,
  // since 60s is long enough for any of that to have changed).
  let autoCleanupTimer = null;
  function scheduleAutoPhotoCleanup(mapId) {
    if (autoCleanupTimer) clearTimeout(autoCleanupTimer);
    autoCleanupTimer = setTimeout(() => runAutoPhotoCleanup(mapId), 60000);
  }
  function cancelAutoPhotoCleanup() {
    if (autoCleanupTimer) { clearTimeout(autoCleanupTimer); autoCleanupTimer = null; }
  }
  async function runAutoPhotoCleanup(mapId) {
    autoCleanupTimer = null;
    // Re-check everything now, not just at schedule time: a full minute
    // has passed, plenty of time for the user to have switched maps,
    // started typing again, backgrounded the tab mid-sync, etc.
    if (!state.current || state.current.id !== mapId) return;
    if (unsavedEdits || persistTimer) return; // another edit landed since scheduling — wait for the next idle window instead
    if (document.visibilityState !== "visible") return;
    if (DriveDB.busy) return;
    try {
      await gcOrphanedPhotos(state.current);
    } catch (e) { /* best-effort — a normal manual cleanup can always catch anything missed */ }
  }

  async function runPersistNow() {
    persistTimer = null;
    if (!state.current) { unsavedEdits = false; return; }
    saveStatus.textContent = "Saving…";
    saveStatus.className = "save-status saving";
    recordPendingEditLog(state.current);
    state.current.updatedAt = nextUpdatedAt(state.current);
    state.current.view = { scale: state.scale, tx: state.tx, ty: state.ty };
    const mapToSave = state.current;
    try {
      const deferredPhotoDeletes = takePendingPhotoDeletes();
      try {
        await DB.put(mapToSave);
      } catch (putErr) {
        requeuePhotoDeletes(deferredPhotoDeletes);
        throw putErr;
      }
      // The stored map no longer references those photos — safe to drop them.
      await releasePhotoDeletes(deferredPhotoDeletes, mapToSave);
      await FolderDB.save(mapToSave);
      // Local save (IndexedDB + connected folder) is the fast part and
      // is what this toolbar status is meant to reflect — flip it to
      // "Saved" here instead of waiting on Drive's network PUT below
      // too. The local IndexedDB write itself is now cheap no matter how

      // many photos are attached (they live in their own store — see
      // PhotoDB — not inlined into this JSON), but the folder mirror and
      // Drive upload below still re-embed photo bytes so those files stay
      // self-contained/portable, so on a photo-heavy map the Drive PUT in
      // particular can still take a few seconds over the network; without
      // this split, the toolbar would sit on "Saving…" that whole time
      // even though the actual local save finished instantly. Drive's own
      // progress is tracked separately by the sidebar's "Synced Xs ago"
      // status (see updateDriveUI/driveSyncStatusText), which only
      // updates once the Drive upload genuinely completes.
      const idx = state.maps.findIndex(m => m.id === mapToSave.id);
      if (idx >= 0) state.maps[idx] = mapToSave; else state.maps.unshift(mapToSave);
      sortMaps(state.maps);
      renderSidebar();
      lastSavedAt = Date.now();
      saveStatus.className = "save-status saved";
      updateSaveStatusLabel();
      // Local save landed clean, so the tree this save() call captured is
      // complete and consistent — (re)start the 60s idle window that lets
      // the automatic orphan-photo sweep run (see scheduleAutoPhotoCleanup
      // above). Every subsequent save just pushes this back out, so it
      // only actually fires once a full minute of quiet has passed.
      scheduleAutoPhotoCleanup(mapToSave.id);
    } catch (e) {
      unsavedEdits = false;
      throw e;
    }
    try {
      // Not awaited by the toolbar status above, but still tracked via
      // unsavedEdits until it finishes — an incoming Drive sync must
      // still wait for this device's own pending upload to land first,
      // or it could overwrite this edit with the older remote copy.
      await DriveDB.save(mapToSave);
    } finally {
      unsavedEdits = false;
    }
  }

  // Guards against overlapping saves: on a photo-heavy map, FolderDB/
  // DriveDB.save() re-embeds every photo as base64 and re-uploads the
  // whole map, which can take several real seconds over the network.
  // Without this, persist()'s 500ms debounce only ever cancelled a
  // pending *timer* — if a save was already mid-upload when the next
  // edit's timer fired, runPersistNow() would start a second full
  // upload of the same (large) file right on top of the first, and the
  // two could land out of order. kickPersist() below makes sure only
  // one runPersistNow() is ever in flight at a time, queuing at most one
  // more pass for right after the current one finishes.
  let persistInFlight = false;
  let persistAgainAfter = false;
  // runPersistNow() ends with the Drive upload, which on a photo-heavy map
  // can take many seconds. While one is running, the next save used to just
  // wait its turn — so an edit made in that window was not in IndexedDB at
  // all until the upload finished, and a refresh threw it away. This writes
  // the current state to IndexedDB straight away; the queued full pass still
  // runs afterwards and does the folder mirror + Drive upload as before.
  function saveLocalWhileBusy() {
    const m = state.current;
    if (!m) return;
    m.updatedAt = nextUpdatedAt(m);
    m.view = { scale: state.scale, tx: state.tx, ty: state.ty };
    const deferredPhotoDeletes = takePendingPhotoDeletes();
    DB.put(m)
      .then(() => releasePhotoDeletes(deferredPhotoDeletes, m))
      .catch((e) => { requeuePhotoDeletes(deferredPhotoDeletes); console.error("Local save failed", e); });
  }
  function kickPersist() {
    if (persistInFlight) { persistAgainAfter = true; saveLocalWhileBusy(); return; }
    persistInFlight = true;
    runPersistNow()
      .catch((e) => console.error("Persist failed", e))
      .finally(() => {
        persistInFlight = false;
        if (persistAgainAfter) { persistAgainAfter = false; kickPersist(); }
      });
  }

  function persist() {
    // Capture Calendar Child contents before the edited live tree is persisted.
    // If an edit removed a task/list/icon/cell, the previously captured copy
    // remains in calendarRetained and therefore stays visible in Calendar.
    syncCalendarRetainedFromLive();
    unsavedEdits = true;
    try { updateCloudSyncPill(); } catch (e) {}

    // v508: crash/F5 safety. Write the current map to IndexedDB immediately
    // on every edit. The heavier folder mirror + Google Drive upload stays
    // debounced below, so typing does not start a network upload per key.
    // DB.put() structured-clones the map when called, giving sudden reloads
    // and power loss the smallest practical data-loss window.
    if (state.current) {
      state.current.updatedAt = nextUpdatedAt(state.current);
      state.current.view = { scale: state.scale, tx: state.tx, ty: state.ty };
      DB.put(state.current).catch((e) => console.error("Immediate local save failed", e));
    }

    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(kickPersist, 500);
  }

  /* v339: Note / DRC / Brainstorm font size is still stored in the
     mindmap/Drive, but phone and desktop now have independent values.
     A v337 map with the old shared fields is treated as the starting value
     for both device classes until each side is changed. */
  const NOTE_EDITOR_FONT_MIN = 10;
  const NOTE_EDITOR_FONT_MAX = 30;
  const NOTE_EDITOR_PHONE_DEFAULT = 13;
  const NOTE_EDITOR_DESKTOP_DEFAULT = 15;
  const NOTE_EDITOR_OLD_SHARED_DEFAULT = 13;

  function editorFontDefault(device) {
    return device === "desktop" ? NOTE_EDITOR_DESKTOP_DEFAULT : NOTE_EDITOR_PHONE_DEFAULT;
  }

  function clampNoteEditorFontSize(value, fallback = NOTE_EDITOR_PHONE_DEFAULT) {
    const n = Number(value);
    return Number.isFinite(n)
      ? Math.max(NOTE_EDITOR_FONT_MIN, Math.min(NOTE_EDITOR_FONT_MAX, n))
      : fallback;
  }

  function editorFontDeviceKey() {
    const sw = Number(window.screen && window.screen.width) || window.innerWidth || 1024;
    const sh = Number(window.screen && window.screen.height) || window.innerHeight || 768;
    return Math.min(sw, sh) <= 640 ? "phone" : "desktop";
  }

  function legacyEditorFontPrefs(map, device) {
    const p = map && map.editorPrefs && typeof map.editorPrefs === "object"
      ? map.editorPrefs
      : null;
    const hasNote = p && Number.isFinite(Number(p.noteFontSize));
    const hasBrainstorm = p && Number.isFinite(Number(p.brainstormFontSize));
    const oldPairIsDefault = hasNote && hasBrainstorm
      && Number(p.noteFontSize) === NOTE_EDITOR_OLD_SHARED_DEFAULT
      && Number(p.brainstormFontSize) === NOTE_EDITOR_OLD_SHARED_DEFAULT;
    const fallback = editorFontDefault(device);
    if (device === "desktop" && oldPairIsDefault) {
      return {
        noteFontSize: NOTE_EDITOR_DESKTOP_DEFAULT,
        brainstormFontSize: NOTE_EDITOR_DESKTOP_DEFAULT
      };
    }
    return {
      noteFontSize: hasNote ? clampNoteEditorFontSize(p.noteFontSize, fallback) : fallback,
      brainstormFontSize: hasBrainstorm ? clampNoteEditorFontSize(p.brainstormFontSize, fallback) : fallback
    };
  }

  function readEditorFontPrefs(map = state.current, device = editorFontDeviceKey()) {
    const legacy = legacyEditorFontPrefs(map, device);
    const root = map && map.editorPrefs && typeof map.editorPrefs === "object"
      ? map.editorPrefs
      : null;
    const p = root && root[device] && typeof root[device] === "object"
      ? root[device]
      : null;
    const nestedHasNote = p && Number.isFinite(Number(p.noteFontSize));
    const nestedHasBrainstorm = p && Number.isFinite(Number(p.brainstormFontSize));
    const nestedPairIsOldDefault = device === "desktop"
      && nestedHasNote && nestedHasBrainstorm
      && Number(p.noteFontSize) === NOTE_EDITOR_OLD_SHARED_DEFAULT
      && Number(p.brainstormFontSize) === NOTE_EDITOR_OLD_SHARED_DEFAULT;

    // v338 wrote desktop 13/13 as its default. Treat exactly that untouched
    // pair as the old default and raise it to the new PC default. If either
    // value differs, assume the user customized it and preserve both values.
    if (nestedPairIsOldDefault) {
      return {
        noteFontSize: NOTE_EDITOR_DESKTOP_DEFAULT,
        brainstormFontSize: NOTE_EDITOR_DESKTOP_DEFAULT
      };
    }

    const fallback = editorFontDefault(device);
    return {
      noteFontSize: nestedHasNote
        ? clampNoteEditorFontSize(p.noteFontSize, fallback)
        : legacy.noteFontSize,
      brainstormFontSize: nestedHasBrainstorm
        ? clampNoteEditorFontSize(p.brainstormFontSize, fallback)
        : legacy.brainstormFontSize
    };
  }

  function readAllEditorFontPrefs(map = state.current) {
    return {
      phone: readEditorFontPrefs(map, "phone"),
      desktop: readEditorFontPrefs(map, "desktop")
    };
  }

  function updateEditorFontButtons(kind, px) {
    const isBrainstorm = kind === "brainstorm";
    const smaller = document.getElementById(isBrainstorm ? "brainstorm-font-minus" : "note-font-minus");
    const bigger = document.getElementById(isBrainstorm ? "brainstorm-font-plus" : "note-font-plus");
    if (smaller) {
      smaller.disabled = px <= NOTE_EDITOR_FONT_MIN;
      smaller.title = `Smaller text (current ${px}px · ${editorFontDeviceKey()})`;
    }
    if (bigger) {
      bigger.disabled = px >= NOTE_EDITOR_FONT_MAX;
      bigger.title = `Bigger text (current ${px}px · ${editorFontDeviceKey()})`;
    }
  }

  function applyEditorFontPrefs(map = state.current) {
    const prefs = readEditorFontPrefs(map);
    const noteEditor = document.getElementById("note-textarea");
    const brainstormEditor = document.getElementById("brainstorm-textarea");
    if (noteEditor) noteEditor.style.fontSize = prefs.noteFontSize + "px";
    if (brainstormEditor) brainstormEditor.style.fontSize = prefs.brainstormFontSize + "px";
    updateEditorFontButtons("note", prefs.noteFontSize);
    updateEditorFontButtons("brainstorm", prefs.brainstormFontSize);
  }

  function changeEditorFontPref(kind, delta) {
    const map = state.current;
    if (!map) return;
    const device = editorFontDeviceKey();
    const key = kind === "brainstorm" ? "brainstormFontSize" : "noteFontSize";
    const current = readEditorFontPrefs(map, device)[key];
    const next = clampNoteEditorFontSize(current + delta);
    if (next === current) return;

    const inherited = readEditorFontPrefs(map, device);
    if (!map.editorPrefs || typeof map.editorPrefs !== "object") map.editorPrefs = {};
    if (!map.editorPrefs[device] || typeof map.editorPrefs[device] !== "object") {
      map.editorPrefs[device] = {
        noteFontSize: inherited.noteFontSize,
        brainstormFontSize: inherited.brainstormFontSize
      };
    }
    map.editorPrefs[device][key] = next;
    applyEditorFontPrefs(map);
    persist();
  }

  [
    ["note-font-minus", "note", -1],
    ["note-font-plus", "note", 1],
    ["brainstorm-font-minus", "brainstorm", -1],
    ["brainstorm-font-plus", "brainstorm", 1]
  ].forEach(([id, kind, delta]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => changeEditorFontPref(kind, delta));
  });

  // Forces a pending save through right away instead of waiting out the
  // rest of the 500ms debounce — used when the tab is about to be
  // backgrounded or closed (see the visibilitychange/pagehide listeners
  // below), since a mobile OS can suspend a background tab mid-timer,
  // silently dropping whatever edit was still waiting to be written to
  // disk/Drive.
  function flushPersist() {
    // Also catches the case where something (like the node countdown
    // timer, which only calls persist() every ~10s to avoid re-saving
    // photo-heavy maps every second) has updated state and flagged
    // unsavedEdits without a pending debounce timer in flight — without
    // this, up to that many seconds of progress could be lost if the
    // tab is closed in between.
    if (!persistTimer && !unsavedEdits) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    kickPersist();
  }
  // A note's own text lives only in noteWorkingList/the DOM until its
  // separate 500ms autosave timer (see scheduleNoteAutosave/
  // flushNoteAutosave below) copies it onto the node — flushPersist()
  // above only flushes what's *already* been committed. Without also
  // flushing that inner timer here, typing into a note and backgrounding
  // the tab within that 500ms window (switching apps, locking the
  // screen) drops the just-typed text before it ever reaches persist(),
  // so it's lost locally too — not just unsynced.
  function flushAllPendingSaves() {
    if (typeof noteEditingId !== "undefined" && noteEditingId) flushNoteAutosave();
    flushPersist();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllPendingSaves();
  });
  window.addEventListener("pagehide", flushAllPendingSaves);

  // Anything typed but not yet safely on Drive. Covers three separate
  // stages of "not saved yet", because a refresh can land in any of
  // them: still in the note editor's 500ms debounce, still in persist()'s
  // own debounce or mid-write, or written locally but never accepted by
  // Drive (the case a dead Google session produces).
  function hasUnsyncedWork() {
    try {
      if (unsavedEdits || persistTimer || persistInFlight) return true;
      if (noteEditingId && noteSaveTimer) return true;
      if (!DriveDB.signedIn) return false;
      for (const m of state.maps) {
        const known = DriveDB.fileIndex[m.id];
        if (!known || (m.updatedAt || 0) > (known.updatedAt || 0)) return true;
      }
    } catch (e) { return false; }
    return false;
  }

  // pagehide's flush above kicks off async IndexedDB and Drive writes,
  // and a page being torn down is under no obligation to wait for them —
  // a refresh at the wrong moment can abort the transaction mid-write,
  // which is how a session's work can vanish on F5 even though the app
  // had "saved" it. This is the only mechanism a browser gives a page to
  // buy that time: ask the person first. The prompt only appears when
  // there is genuinely something unwritten, so a normal refresh on a
  // fully-synced map is untouched.
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsyncedWork()) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  // Panning/zooming the canvas only changes where you're *looking* — not
  // the map's actual content — so it must never bump `updatedAt` the way
  // persist() does. `updatedAt` is what Drive/folder sync uses to decide
  // whose copy is newer; if a pure view change bumped it, simply opening
  // a map on another device and glancing around (nudging the scroll a
  // pixel, say) would make that device's copy look like the "latest"
  // edit even though its actual content is stale — and that stale
  // content would then overwrite a genuine edit made elsewhere. This
  // still saves the view locally (so your pan/zoom position is
  // remembered next time you open this map) but never touches
  // `updatedAt` and never pushes to Folder/Drive sync — view position
  // is treated as a per-device thing, not something worth syncing.
  const persistViewOnly = debounce(async () => {
    if (!state.current) return;
    state.current.view = { scale: state.scale, tx: state.tx, ty: state.ty };
    await DB.put(state.current);
  }, 500);

  // Every snapshot here is a full JSON.stringify of the map's whole node
  // tree — and that tree carries each node's attached photos inline as
  // base64 data URLs. Capping the stacks at 60 *entries* (below) bounds
  // how many edits back you can go, but says nothing about how much
  // memory those 60 entries actually take: a photo-heavy map re-clones
  // every one of its embedded images into a brand-new string on every
  // single edit (even a one-character text change), so 60 of those
  // snapshots can add up to hundreds of MB sitting in the JS heap for
  // one open map — the actual cause of the "Out of Memory" crashes some
  // photo-heavy maps were hitting after a while. This keeps the same
  // 60-entry depth for ordinary (photo-light) maps, where it costs
  // nothing, but for anything bigger it also evicts the oldest entries
  // once the stack's total size passes a fixed budget, so memory use
  // stays bounded regardless of how many photos a map carries.
  const UNDO_STACK_MAX_BYTES = 25 * 1024 * 1024; // ~25MB per stack
  function pushBoundedSnapshot(stack, json, maxCount) {
    stack.push(json);
    if (stack.length > (maxCount || 60)) stack.shift();
    let total = 0;
    for (const s of stack) total += s.length;
    while (total > UNDO_STACK_MAX_BYTES && stack.length > 1) {
      total -= stack.shift().length;
    }
  }

  function pushUndo() {
    if (!state.current) return;
    if (!requireSignIn()) throw new EditBlockedError();
    const undoJson = JSON.stringify({ root: state.current.root, links: state.current.links || [] });
    captureEditLogBefore(undoJson, state.current);
    pushBoundedSnapshot(state.undoStack, undoJson);
    state.redoStack = [];
  }

  function undo() {
    if (!requireSignIn()) return;
    if (!state.current || state.undoStack.length === 0) return;
    pushBoundedSnapshot(state.redoStack, JSON.stringify({ root: state.current.root, links: state.current.links || [] }));
    const snap = JSON.parse(state.undoStack.pop());
    state.current.root = snap.root;
    state.current.links = snap.links || [];
    state.selectedId = null;
    state.selectedCell = null;
    state.cellRangeAnchor = null;
    state.cellRange = null;
    renderAll();
    persist();
  }

  function redo() {
    if (!requireSignIn()) return;
    if (!state.current || state.redoStack.length === 0) return;
    pushBoundedSnapshot(state.undoStack, JSON.stringify({ root: state.current.root, links: state.current.links || [] }));
    const snap = JSON.parse(state.redoStack.pop());
    state.current.root = snap.root;
    state.current.links = snap.links || [];
    state.selectedId = null;
    state.selectedCell = null;
    state.cellRangeAnchor = null;
    state.cellRange = null;
    renderAll();
    persist();
  }

  // Keeps the toolbar undo/redo buttons' enabled state in sync with the
  // stacks. Called from renderAll() (covers pushUndo/undo/redo, map loads,
  // and clearCanvas) rather than threaded through every call site.
  function updateUndoRedoButtons() {
    const undoBtn = $("#btn-undo");
    const redoBtn = $("#btn-redo");
    if (!undoBtn || !redoBtn) return;
    const locked = !isEditingAllowed();
    undoBtn.disabled = locked || !state.current || state.undoStack.length === 0;
    redoBtn.disabled = locked || !state.current || state.redoStack.length === 0;
  }

  /* ---------------- sidebar ---------------- */

  const signedOutState = $("#signed-out-state");
  const sidebarSignedOutNote = $("#mindmap-list-signed-out");

  // Nothing map-related is shown until a Google session is BOTH confirmed
  // AND actually synced — signedIn flips true the instant we have a fresh
  // token, which is *before* syncFromDrive() has pulled this device's
  // latest copy down (see DriveDB.signIn/.restore). Gating on signedIn
  // alone let updateDriveUI()'s "Syncing…" call (which also calls this)
  // un-hide #world early, while renderSidebar() (the only thing that
  // hides the "Sign in with Google" panel) hadn't run yet — so for that
  // whole sync window you'd see stale/cached map content AND the sign-in
  // panel on screen at once. Requiring dataSynced too closes that gap.
  // During startup, a previously connected device can show its IndexedDB
  // copy immediately while Drive verification runs in the background.
  // Editing remains locked by isEditingAllowed() until DriveDB reaches a
  // synced state, so this improves reopen speed without allowing a stale
  // local copy to overwrite a newer remote one.
  let startupLocalPreview = false;
  function localOnlyMode() {
    try { return localStorage.getItem("branchline_local_only") === "1"; } catch (e) { return false; }
  }
  function mapsReadyToShow() {
    return startupLocalPreview || localOnlyMode() || (!!DriveDB.signedIn && !!DriveDB.dataSynced);
  }

  // Toggles the body-level CSS gate (canvas/FABs, see style.css) and
  // keeps the signed-out/syncing panel's own text in sync with *why*
  // it's showing, so a signed-in-but-still-syncing tab says "Syncing…"
  // rather than the misleading "Sign in with Google" (which also
  // shouldn't invite a redundant second sign-in tap mid-sync).
  function applySignedOutGate() {
    const ready = mapsReadyToShow();
    document.body.classList.toggle("signed-out", !ready);
    if (ready) return;
    const stillSyncing = DriveDB.signedIn && !DriveDB.dataSynced;
    const heading = signedOutState.querySelector("p");
    const btn = $("#btn-signed-out-signin");
    if (heading) heading.textContent = stillSyncing ? "Syncing your maps…" : "Sign in with Google to see your mind maps.";
    if (btn) btn.classList.toggle("hidden", stillSyncing);
    if (sidebarSignedOutNote) sidebarSignedOutNote.textContent = stillSyncing ? "Syncing your maps…" : "Sign in with Google to see your maps.";
  }

  function renderSidebar() {
    sortMaps(state.maps);
    listEl.innerHTML = "";
    applySignedOutGate();
    if (!mapsReadyToShow()) {
      emptyState.classList.add("hidden");
      nodeFabs.classList.add("hidden");
      signedOutState.classList.remove("hidden");
      if (sidebarSignedOutNote) sidebarSignedOutNote.classList.remove("hidden");
      return; // don't build any map list items until signed in AND synced
    }
    signedOutState.classList.add("hidden");
    if (sidebarSignedOutNote) sidebarSignedOutNote.classList.add("hidden");
    const visibleMaps = activeMaps();
    if (visibleMaps.length === 0) {
      emptyState.classList.remove("hidden");
      nodeFabs.classList.add("hidden");
    } else {
      emptyState.classList.add("hidden");
      nodeFabs.classList.remove("hidden");
    }
    updateTrashBadge();
    for (const m of visibleMaps) {
      const li = document.createElement("li");
      const isMoveTarget = !!state.moveSourceId && (!state.current || m.id !== state.current.id);
      li.className = "map-item"
        + (state.current && m.id === state.current.id ? " active" : "")
        + (isMoveTarget ? " move-target" : "");
      const star = document.createElement("span");
      star.className = "item-star" + (m.favorite ? " favorited" : "");
      star.textContent = m.favorite ? "★" : "☆";
      star.title = m.favorite ? "Remove from favorites" : "Add to favorites";
      star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(m.id); });
      const dot = document.createElement("span"); dot.className = "dot";
      const name = document.createElement("span"); name.className = "name"; name.textContent = m.title || "Untitled map";
      const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = relTime(m.updatedAt);
      const del = document.createElement("span"); del.className = "item-del"; del.textContent = "✕";
      del.title = "Move to trash";
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteMap(m.id); });
      li.append(star, dot, name, meta, del);
      if (isMoveTarget) {
        li.title = "Move here";
        li.addEventListener("click", () => completeMoveToMap(m.id));
      } else {
        li.addEventListener("click", () => openMap(m.id));
      }
      listEl.appendChild(li);
    }
  }

  // Favoriting doesn't go through the debounced `persist()` (that only ever
  // saves state.current) since you can star any map in the list, including
  // ones that aren't currently open — so it saves directly instead.
  async function toggleFavorite(id) {
    if (!requireSignIn()) return;
    const m = state.maps.find(x => x.id === id);
    if (!m) return;
    m.favorite = !m.favorite;
    await DB.put(m);
    await FolderDB.save(m);
    await DriveDB.save(m);
    renderSidebar();
  }

  function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  const LAST_OPENED_MAP_KEY = "branchline_last_opened_map";
  async function openMap(id) {
    const m = state.maps.find(x => x.id === id);
    if (!m) return;
    commitEditIfActive();
    cancelAutoPhotoCleanup(); // leaving the map it was scheduled for — never let it fire against the next one
    state.current = m;
    ensureTheme(state.current);
    ensureLinks(state.current);
    ensureLayout(state.current);
    ensureFavorite(state.current);
    ensureTrash(state.current);
    ensureClockHidden(state.current);
    document.getElementById("app").classList.toggle("hide-clock-widgets", isClockHidden());
    ensureSidesRepaired(state.current);
    ensureAffirmationMigrated(state.current);
    primeEditLogShadow(state.current);
    applyEditorFontPrefs(state.current);
    if (!state.current._photosMigrated) await ensurePhotosMigrated(state.current);
    await loadPhotoCacheForMap(state.current.id);
    state.selectedId = null;
    state.selectedCell = null;
    state.cellRangeAnchor = null;
    state.cellRange = null;
    state.editingId = null;
    state.linkFromId = null;
    state.moveSourceId = null;
    state.highlightId = null;
    state.undoStack = [];
    state.redoStack = [];
    const v = m.view || { scale: 1, tx: 60, ty: 60 };
    state.scale = v.scale || 1; state.tx = v.tx || 60; state.ty = v.ty || 60;
    // Belongs to whichever map was open before — without clearing it, the
    // first render of the newly-opened map would "compensate" tx/ty against
    // a stale bounding box from a completely different tree.
    state.originX = undefined;
    state.originY = undefined;
    titleInput.value = m.title || "";
    layoutSelect.value = state.current.layout || "mindmap";
    renderSidebar();
    renderAll();
    applyTransform();

    // Drive v2: the structure is already usable here. Missing photo Blobs
    // arrive afterward, so a photo-heavy map shows its text immediately.
    const driveKnown = DriveDB.fileIndex && DriveDB.fileIndex[id];
    if (DriveDB.signedIn && driveKnown && driveKnown.format === "2") {
      DriveDB.hydratePhotosForMap(m).catch((e) => {
        console.warn("Couldn't lazy-load this map's Drive photos", e);
        try { showToast("Map opened; some photos are still waiting for Drive"); } catch (e2) {}
      });
    }
    // Remembered across reloads so boot() can reopen whichever map you
    // were last looking at, rather than always the top of the sidebar
    // list (most recently *edited*, which isn't necessarily the same map).
    try { localStorage.setItem(LAST_OPENED_MAP_KEY, id); } catch (e) {}
  }

  async function createMap() {
    if (!requireSignIn()) return;
    const m = newMindMap("Untitled map");
    state.maps.unshift(m);
    await DB.put(m);
    await openMap(m.id);
    titleInput.focus();
    titleInput.select();
  }

  // Soft delete: moves the map to the trash (see #trash-modal) instead of
  // removing it outright. It stays in state.maps (and keeps syncing to the
  // folder/Drive like any other edit) but is filtered out of the regular
  // sidebar list by activeMaps(). Only permanentlyDeleteMap actually
  // removes it from storage.
  async function deleteMap(id) {
    if (!requireSignIn()) return;
    const m = state.maps.find(x => x.id === id);
    if (!m) return;
    if (!confirm(`Move "${m.title || 'Untitled map'}" to trash?`)) return;

    // Optimistic UI: mark the map trashed and remove it from the visible
    // sidebar immediately. Previously we waited for IndexedDB/folder/Drive
    // saves first, so on a slow Drive connection the row (and, for the open
    // map, its canvas) could sit there for a noticeable moment even though
    // the delete had already been accepted.
    m.trashedAt = Date.now();
    const deletingCurrent = !!(state.current && state.current.id === id);
    let nextOpenPromise = null;

    if (deletingCurrent) {
      state.current = null;
      const next = activeMaps();

      // Remove the trashed row right now and clear the old canvas so there
      // is no visual ghost while the next map's photos/data are loading.
      renderSidebar();
      clearCanvas();

      if (next.length) {
        nextOpenPromise = openMap(next[0].id);
      } else {
        // No map left open — release the trashed map's photos instead of
        // leaving their object URLs (and the Blobs they keep alive)
        // resident in memory with nothing on screen to show for them.
        revokePhotoCache();
        photoCache = new Map();
        photoBlobCache = new Map();
      }
    } else {
      // For a non-open map this is all that's needed to make the sidebar
      // update instantly; persistence can finish afterwards.
      renderSidebar();
    }

    // Persist after the visual update. Run the independent saves together so
    // a slow network sync never blocks the UI. Keep awaiting them here so the
    // caller still observes completion, but the user already sees the result.
    const persistPromise = Promise.all([
      DB.put(m),
      FolderDB.save(m),
      DriveDB.save(m)
    ]);

    if (nextOpenPromise) {
      await Promise.all([persistPromise, nextOpenPromise]);
    } else {
      await persistPromise;
    }
  }

  async function restoreMap(id) {
    if (!requireSignIn()) return;
    const m = state.maps.find(x => x.id === id);
    if (!m) return;
    m.trashedAt = null;
    await DB.put(m);
    await FolderDB.save(m);
    await DriveDB.save(m);
    renderSidebar();
    renderTrashModal();
  }

  // Strips fields that only ever exist to make one specific instance of a
  // node/map unique (its id, and the createdAt/updatedAt stamps on it) so
  // two independently-created copies of otherwise-identical content
  // compare equal below. Recurses into every nested object/array (notes,
  // tasks, photos, links, table cells, etc.) — not just top-level nodes —
  // since a duplicate map is a full deep copy, ids and all, all the way
  // down.
  function stripIdentifiersForDupeCheck(value) {
    if (Array.isArray(value)) return value.map(stripIdentifiersForDupeCheck);
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) {
        if (k === "id" || k === "createdAt" || k === "updatedAt") continue;
        out[k] = stripIdentifiersForDupeCheck(value[k]);
      }
      return out;
    }
    return value;
  }

  // A content "fingerprint" for a map: its whole tree of nodes plus
  // cross-links, with every id/timestamp stripped out (see above) so two
  // maps that are otherwise word-for-word identical fingerprint the same
  // even though every node under them got its own fresh id when each copy
  // was created.
  function mapContentFingerprint(map) {
    return JSON.stringify(stripIdentifiersForDupeCheck({ root: map.root, links: map.links || [] }));
  }

  // Auto-cleanup run once at boot (see boot() below): finds active,
  // non-trashed maps in the sidebar that share both the exact same title
  // and the exact same content fingerprint, and trashes every copy but
  // the most recently updated one. Soft-deletes (same as deleteMap) so a
  // false match is always recoverable from the trash modal, and skips any
  // map already in the trash — this only ever tidies the regular sidebar
  // list. Returns how many duplicates were trashed, for the console.
  async function autoRemoveDuplicateMaps() {
    const bestForSignature = new Map(); // signature -> map currently being kept
    const toTrash = [];
    for (const m of activeMaps()) {
      const signature = (m.title || "").trim() + "\u0000" + mapContentFingerprint(m);
      const kept = bestForSignature.get(signature);
      if (!kept) {
        bestForSignature.set(signature, m);
        continue;
      }
      if ((m.updatedAt || 0) > (kept.updatedAt || 0)) {
        bestForSignature.set(signature, m);
        toTrash.push(kept);
      } else {
        toTrash.push(m);
      }
    }
    for (const dup of toTrash) {
      dup.trashedAt = Date.now();
      await DB.put(dup);
      await FolderDB.save(dup);
      await DriveDB.save(dup);
    }
    return toTrash.length;
  }

  async function permanentlyDeleteMap(id) {
    if (!requireSignIn()) return;
    const m = state.maps.find(x => x.id === id);
    if (!m) return;
    const dependents = state.maps.filter((x) => x.id !== id && sharedPhotoSourceMapId(x) === id);
    if (dependents.length) {
      alert(`This map still supplies shared photos to ${dependents.length} recovery cop${dependents.length === 1 ? "y" : "ies"}. Delete those recovery copies first so their photos cannot break.`);
      return;
    }
    if (!confirm(`Permanently delete "${m.title || 'Untitled map'}"? This cannot be undone.`)) return;
    await DB.delete(id);
    await PhotoDB.deleteAllForMap(id);
    await FolderDB.remove(m);
    await DriveDB.remove(m);
    state.maps = state.maps.filter(x => x.id !== id);
    renderTrashModal();
    renderSidebar();
  }

  async function emptyTrash() {
    if (!requireSignIn()) return;
    const trashed = trashedMapsList().slice().sort((a, b) =>
      Number(!!sharedPhotoSourceMapId(b)) - Number(!!sharedPhotoSourceMapId(a))
    );
    if (!trashed.length) return;
    if (!confirm(`Permanently delete all ${trashed.length} map${trashed.length === 1 ? "" : "s"} in the trash? This cannot be undone.`)) return;
    // Each step below can fail independently (a blocked IndexedDB
    // transaction, a Drive API hiccup, etc.). Previously an error from
    // any single one aborted this whole loop — since state.maps/the UI
    // only updated *after* the loop finished, one bad map meant nothing
    // visibly happened at all, even for maps that deleted fine before
    // it. Isolating each map's cleanup, and updating state/UI as each
    // one actually succeeds, means one failure no longer silently blocks
    // every other deletion.
    const failed = [];
    for (const m of trashed) {
      try {
        const dependents = state.maps.filter((x) => x.id !== m.id && sharedPhotoSourceMapId(x) === m.id);
        if (dependents.length) {
          throw new Error("Map still supplies shared photos to another recovery copy");
        }
        await DB.delete(m.id);
        await PhotoDB.deleteAllForMap(m.id);
        await FolderDB.remove(m);
        await DriveDB.remove(m);
        state.maps = state.maps.filter(x => x.id !== m.id);
      } catch (e) {
        console.error("Failed to permanently delete map from trash", m.id, e);
        failed.push(m);
      }
    }
    renderTrashModal();
    renderSidebar();
    if (failed.length) {
      alert(`${failed.length} of ${trashed.length} map${trashed.length === 1 ? "" : "s"} couldn't be deleted (still in the trash) — check the console for details, or try again.`);
    }
  }

  function updateTrashBadge() {
    const badge = $("#trash-count-badge");
    if (!badge) return;
    const n = trashedMapsList().length;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", n === 0);
  }

  function clearCanvas() {
    nodesLayer.innerHTML = "";
    svgEl.innerHTML = "";
    titleInput.value = "";
    layoutSelect.value = "mindmap";
    emptyState.classList.remove("hidden");
    nodeFabs.classList.add("hidden");
    updateUndoRedoButtons();
  }


