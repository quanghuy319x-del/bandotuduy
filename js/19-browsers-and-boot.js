/* Branchline — js/19-browsers-and-boot.js
   Part 19 of 19 of the former single-file app.js. Contents: favorites browser, shared sort-toggle helper, notes browser, simple per-browser folder system, photos browser, videos browser, boot.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- layout / geometry module (phase 2) ---------------- */
  if (!window.BranchlineLayout || typeof window.BranchlineLayout.create !== "function") {
    throw new Error("phase2-layout.js failed to load — make sure phase2-layout.js is uploaded next to index.html");
  }
  const {
    layout,
    computeNodeBox,
    nodeLeftX,
    nodeRightX,
    nodeCenterX,
    branchColorFor,
    assignBranchColors
  } = window.BranchlineLayout.create({
    NODE_H,
    ROOT_H,
    SLOT_GAP,
    PALETTE,
    STRIP_OVERFLOW_CAP,
    state,
    clamp,
    gapFor,
    nodeIsTable,
    getNodeImages,
    getNodeNotes,
    getNodeUrls,
    nodeTaskNoteMarkerCount,
    nodeSubtaskBrainstormMarkerCount,
    nodeAffirmationWins,
    getNodeTimePlayed,
    brainstormPoints,
    stripBucketCount,
    nodeTaskProgress,
    isClockHidden
  });

  /* ---------------- favorites browser ---------------- */

  // Same idea as the tag/comment browsers above (collect a starred
  // attribute from across the whole map, click to jump straight to it),
  // but spanning three different kinds of thing at once — a favorited
  // note, photo, or link/video — since that's what "favorite" means here
  // (see getPhotoFavorite/getLinkFavorite and the note editor's own
  // .favorite field, toggled from the ☆ buttons added alongside each).
  const favoritesBrowserModal = $("#favoritesbrowser-modal");
  const favoritesBrowserList = $("#favoritesbrowser-list");
  const favoritesBrowserSearch = $("#favoritesbrowser-search");
  let favoritesBrowserItems = [];

  function collectFavoriteItems() {
    const items = [];
    let cleaned = false;
    collectContentHosts().forEach(({ node, host, r, c, hostLabel }) => {
      getNodeNotes(host).forEach((n) => {
        if (!n.favorite) return;
        items.push({ type: "note", nodeId: node.id, r, c, noteId: n.id, nodeLabel: hostLabel, preview: notePreviewText(n), isDRC: isDRCNote(n), isPlan: isPlanNote(n) });
      });
      getNodeTasks(host).forEach((t) => {
        getTaskNotes(t).forEach((n) => {
          if (!n.favorite) return;
          items.push({
            type: "note", nodeId: node.id, r, c, taskId: t.id, noteId: n.id,
            nodeLabel: `${hostLabel} → ${t.text || "Untitled task"}`,
            preview: notePreviewText(n), isDRC: isDRCNote(n), isPlan: isPlanNoteFor(n, t),
          });
        });
        getTaskSubtasks(t).forEach((s) => getTaskNotes(s).forEach((n) => {
          if (!n.favorite) return;
          items.push({
            type: "note", nodeId: node.id, r, c, taskId: t.id, subtaskId: s.id, noteId: n.id,
            nodeLabel: `${hostLabel} → ${t.text || "Untitled task"} → ${s.text || "Untitled subtask"}`,
            preview: notePreviewText(n), isDRC: isDRCNote(n), isPlan: isPlanNoteFor(n, s),
          });
        }));
      });
      if (host.photoFavorites) {
        const liveIds = new Set(getNodeImageIds(host));
        Object.keys(host.photoFavorites).forEach((id) => {
          if (!liveIds.has(id)) { delete host.photoFavorites[id]; cleaned = true; return; }
          if (host.photoFavorites[id]) items.push({ type: "photo", nodeId: node.id, r, c, photoId: id, nodeLabel: hostLabel, preview: "Photo" });
        });
      }
      if (host.linkFavorites) {
        const liveUrls = new Set(getNodeUrls(host));
        Object.keys(host.linkFavorites).forEach((url) => {
          if (!liveUrls.has(url)) { delete host.linkFavorites[url]; cleaned = true; return; }
          if (!host.linkFavorites[url]) return;
          const isVideo = !!youtubeVideoId(url);
          items.push({
            type: isVideo ? "video" : "link", nodeId: node.id, r, c, url,
            nodeLabel: hostLabel, preview: getLinkTitle(host, url) || url,
          });
        });
      }
    });
    if (cleaned) persist();
    return items.sort((a, b) => a.nodeLabel.localeCompare(b.nodeLabel));
  }

  const FAVORITE_TYPE_ICON = { note: "📝", photo: "🖼", link: "🌐" };

  // Puts the red YouTube logo (the same LINK_ICON_SVGS.youtube used on a
  // node's link markers and the sidebar Videos button) into `el`, at a
  // fixed pixel size — used anywhere a row/heading stands for a video, so
  // every video reads with one consistent icon instead of an emoji.
  function setYoutubeIcon(el, size) {
    el.innerHTML = LINK_ICON_SVGS.youtube;
    const svg = el.firstElementChild;
    if (svg && size) {
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
    }
  }

  // Section-heading icon for the Favorites browser groups — reuses the
  // same true note/link icons as the rows below each heading (and as
  // the rest of the app) rather than the FAVORITE_TYPE_ICON emoji, so a
  // heading never shows a different "note" or "link" glyph than the
  // items filed under it. Videos use the red YouTube logo; photos keep
  // their emoji since there's no single app-wide icon to match against.
  function favoriteTypeIconEl(type) {
    const el = document.createElement("span");
    el.className = "favoritesbrowser-heading-icon";
    if (type === "note") el.innerHTML = CELL_NOTE_ICON_SVG;
    else if (type === "link") el.innerHTML = LINK_ICON_SVGS.link;
    else if (type === "video") el.innerHTML = LINK_ICON_SVGS.youtube;
    else el.textContent = FAVORITE_TYPE_ICON[type];
    return el;
  }

  function openFavoritesBrowserModal(keep) {
    favoritesBrowserItems = collectFavoriteItems();
    if (keep !== true) favoritesBrowserSearch.value = "";
    renderFavoritesBrowserList();
    zoomModalOpen(favoritesBrowserModal);
    if (keep !== true) requestAnimationFrame(() => favoritesBrowserSearch.focus());
  }
  function closeFavoritesBrowserModal() {
    zoomModalClose(favoritesBrowserModal);
  }

  // Resolves a favorited/browsed note item back to its live `notes` array
  // — the node's own, or (when the item carries a taskId — see
  // collectFavoriteItems/collectAllNotes) that task's own separate notes
  // list instead.
  function resolveNoteListForItem(node, item) {
    const host = browserItemHost(node, item);
    if (!host) return [];
    if (item.taskId) {
      const t = getNodeTasks(host).find(x => x.id === item.taskId);
      if (!t) return [];
      if (item.subtaskId) {
        const s = getTaskSubtasks(t).find(x => x.id === item.subtaskId);
        return s ? getTaskNotes(s) : [];
      }
      return getTaskNotes(t);
    }
    return getNodeNotes(host);
  }

  // Unstars one item directly from the list (the row's own ☆) without
  // opening it — same underlying toggle each item's own star button uses
  // (toggleNoteFavorite's field write / togglePhotoFavorite/
  // toggleLinkFavorite), just entered from here instead.
  function unfavoriteItem(item) {
    const node = findNode(item.nodeId);
    if (!node) return;
    const host = browserItemHost(node, item);
    if (!host) return;
    pushUndo();
    if (item.type === "note") {
      const n = resolveNoteListForItem(node, item).find(x => x.id === item.noteId);
      if (n) n.favorite = false;
    } else if (item.type === "photo") {
      setPhotoFavorite(host, item.photoId, false);
    } else {
      setLinkFavorite(host, item.url, false);
    }
    persist();
    renderAll();
  }

  function jumpToFavoriteItem(item) {
    const node = findNode(item.nodeId);
    if (!node) return;
    const host = browserItemHost(node, item);
    if (!host) return;
    const ret = makeBrowserReturn("Favorites", favoritesBrowserList, openFavoritesBrowserModal, null);
    closeFavoritesBrowserModal();
    withViewerReturn(ret, () => {
      if (item.type === "note") {
        const idx = resolveNoteListForItem(node, item).findIndex(n => n.id === item.noteId);
        openNoteModal(item.nodeId, idx >= 0 ? idx : undefined, null, item.taskId || null,
          browserItemCellPos(item), false, item.subtaskId || null);
      } else if (item.type === "photo") {
        const idx = getNodeImageIds(host).indexOf(item.photoId);
        if (idx < 0) return;
        const group = {
          label: "Favorites",
          items: favoritesBrowserItems.filter(it => it.type === "photo")
            .map(it => ({ nodeId: it.nodeId, r: it.r, c: it.c, id: it.photoId })),
        };
        openBrowserPhotoItem(item, idx, group);
      } else {
        const liveHost = () => browserItemHost(findNode(item.nodeId) || node, item);
        openLinkSmart(item.url, {
          videoKey: videoItemKey(item.nodeId, item.r, item.c, item.url),
          get: () => getLinkComment(liveHost(), item.url),
          set: (v) => setLinkComment(liveHost(), item.url, v),
          getFavorite: () => getLinkFavorite(liveHost(), item.url),
          setFavorite: (v) => setLinkFavorite(liveHost(), item.url, v),
          getPhotos: () => getLinkPhotos(liveHost(), item.url),
          addPhoto: (dataUrl) => addLinkPhoto(liveHost(), item.url, dataUrl),
          removePhoto: (id) => removeLinkPhoto(liveHost(), item.url, id),
        });
      }
    });
  }

  const FAVORITE_TYPE_LABEL = { note: "Notes", photo: "Photos", link: "Links", video: "Videos" };
  const FAVORITE_TYPE_ORDER = ["note", "photo", "link", "video"];

  function buildFavoritesBrowserRow(it) {
    const li = document.createElement("li");
    li.className = "favoritesbrowser-row";

    const icon = document.createElement("span");
    icon.className = "favoritesbrowser-row-icon";
    if (it.type === "photo") {
      const thumbUrl = photoUrl(it.photoId);
      if (thumbUrl) {
        const thumb = document.createElement("img");
        thumb.className = "tagbrowser-tag-thumb";
        thumb.alt = "";
        thumb.src = thumbUrl;
        thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });
        icon.appendChild(thumb);
      } else {
        icon.textContent = FAVORITE_TYPE_ICON.photo;
      }
    } else if (it.type === "note") {
      // Same yellow sticky-note / DRC notebook icons as everywhere else
      // in the app (see noteIconEl/drcIconEl), instead of a generic emoji.
      icon.appendChild(it.isDRC ? drcIconEl(22) : (it.isPlan ? planIconEl(22) : noteIconEl(22)));
    } else if (it.type === "link") {
      // Same recognizable per-destination icon as the link menus/markers
      // elsewhere (see linkIconFor), instead of a generic 🔗 emoji.
      icon.innerHTML = linkIconFor(it.url);
    } else if (it.type === "video") {
      setYoutubeIcon(icon, 22);
    } else {
      icon.textContent = FAVORITE_TYPE_ICON[it.type];
    }

    const text = document.createElement("span");
    text.className = "favoritesbrowser-row-text";
    const name = document.createElement("span");
    name.className = "favoritesbrowser-row-name";
    name.textContent = it.nodeLabel;
      name.title = it.nodeLabel;
    const preview = document.createElement("span");
    preview.className = "favoritesbrowser-row-preview";
    preview.textContent = it.preview;
    text.append(name, preview);

    const star = document.createElement("span");
    star.className = "item-star favorited";
    star.textContent = "★";
    star.title = "Remove from favorites";
    star.addEventListener("click", (e) => { e.stopPropagation(); unfavoriteItem(it); renderFavoritesBrowserList(); });

    li.append(icon, text, star);
    li.addEventListener("click", () => jumpToFavoriteItem(it));
    return li;
  }

  function renderFavoritesBrowserList() {
    const q = favoritesBrowserSearch.value.trim().toLowerCase();
    const filtered = !q ? favoritesBrowserItems : favoritesBrowserItems.filter(it =>
      it.preview.toLowerCase().includes(q) || it.nodeLabel.toLowerCase().includes(q));
    favoritesBrowserList.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("li");
      empty.className = "tagbrowser-empty";
      empty.textContent = favoritesBrowserItems.length
        ? "No favorites match that search."
        : "No favorites yet — tap the ☆ on a note, photo, link, or video to start collecting them here.";
      favoritesBrowserList.appendChild(empty);
      return;
    }
    // Grouped by kind (Notes / Photos / Links / Videos), each its own
    // section with a heading and count — only sections that actually
    // have a match are shown, in the fixed order above rather than
    // whatever order items happen to appear in.
    FAVORITE_TYPE_ORDER.forEach((type) => {
      const group = filtered.filter(it => it.type === type);
      if (!group.length) return;
      const heading = document.createElement("li");
      heading.className = "favoritesbrowser-heading";
      heading.appendChild(favoriteTypeIconEl(type));
      heading.appendChild(document.createTextNode(`${FAVORITE_TYPE_LABEL[type]} (${group.length})`));
      favoritesBrowserList.appendChild(heading);
      group.forEach((it) => {
        const node = findNode(it.nodeId);
        if (!node) return; // stale entry (shouldn't normally happen)
        favoritesBrowserList.appendChild(buildFavoritesBrowserRow(it));
      });
    });
  }

  // The sidebar ⭐ Favorites button was removed — each browser (Notes / Photos /
  // Videos) has its own "Favorite" folder now. The modal below is kept but is no
  // longer opened from anywhere.
  $("#favoritesbrowser-close").addEventListener("click", closeFavoritesBrowserModal);
  favoritesBrowserModal.addEventListener("click", (e) => { if (e.target === favoritesBrowserModal) closeFavoritesBrowserModal(); });
  favoritesBrowserSearch.addEventListener("input", renderFavoritesBrowserList);
  document.addEventListener("keydown", (e) => {
    if (favoritesBrowserModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeFavoritesBrowserModal();
  });

  /* ---------------- shared sort-toggle helper ---------------- */

  // Wires up a row of "Sort by" buttons (Notes/Photos/Videos browsers
  // below all use the same markup: a few buttons with a data-sort
  // attribute and a nested .notesbrowser-sort-arrow span) so that
  // clicking a button switches to that sort, and clicking the
  // already-active button reverses its direction instead — same click
  // toggles ascending/descending, rather than needing separate buttons
  // for "newest first" vs "oldest first". Returns a live { sort, dir }
  // object the caller's own sort function reads on every render.
  const SORT_TOGGLE_DEFAULT_DIR = { date: "desc", favorite: "desc", alpha: "asc" };
  function setupSortToggle(buttons, initialSort, onChange) {
    const state = { sort: initialSort, dir: SORT_TOGGLE_DEFAULT_DIR[initialSort] || "desc" };
    function updateArrows() {
      buttons.forEach((btn) => {
        const isActive = btn.dataset.sort === state.sort;
        btn.classList.toggle("active", isActive);
        const arrow = btn.querySelector(".notesbrowser-sort-arrow");
        if (arrow) arrow.textContent = isActive ? (state.dir === "asc" ? " ▲" : " ▼") : "";
      });
    }
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const sort = btn.dataset.sort;
        if (sort === state.sort) {
          state.dir = state.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort = sort;
          state.dir = SORT_TOGGLE_DEFAULT_DIR[sort] || "desc";
        }
        updateArrows();
        onChange();
      });
    });
    updateArrows();
    return state;
  }

  /* ---------------- notes browser ---------------- */

  /* ---------------- simple per-browser folder system ---------------- */
  // A lightweight, file-manager-style way to sort items in the Notes,
  // Photos, and Videos browsers into folders. Kept deliberately simple:
  // both the folder names and which item belongs to which folder are
  // stored in localStorage, keyed by the item's own id — entirely
  // separate from the map's own data, so this works the same way across
  // every map without touching how notes/photos/videos are themselves
  // saved, exported, or synced. Each browser gets its own independent
  // set of folders (its own storage prefix).
  //
  // Which folders a browser starts with is now the caller's decision
  // (`opts.defaults`) instead of being hardcoded to ["DRC"] for all
  // three. DRC is a notes-only idea — it's a note title (see isDRCNote),
  // and there is no such thing as a DRC photo or a DRC video — so the
  // Photos and Videos browsers were starting life with a folder that
  // could never have anything in it. `opts.retired` cleans up after
  // that: any folder named there is dropped (along with anything filed
  // into it) the first time this runs on a browser that still has it
  // stored from an older version.
  function createFolderManager(storagePrefix, opts) {
    const defaults = (opts && opts.defaults) || [];
    const retired = (opts && opts.retired) || [];
    const foldersKey = `branchline-folders-${storagePrefix}`;
    const assignKey = `branchline-folder-assign-${storagePrefix}`;

    function loadFolders() {
      try {
        const raw = localStorage.getItem(foldersKey);
        const list = raw ? JSON.parse(raw) : null;
        if (Array.isArray(list)) return list;
      } catch (e) {}
      return defaults.slice();
    }
    function saveFolders(list) {
      try { localStorage.setItem(foldersKey, JSON.stringify(list)); } catch (e) {}
    }
    function loadAssign() {
      try {
        const raw = localStorage.getItem(assignKey);
        const obj = raw ? JSON.parse(raw) : null;
        if (obj && typeof obj === "object") return obj;
      } catch (e) {}
      return {};
    }
    function saveAssign(obj) {
      try { localStorage.setItem(assignKey, JSON.stringify(obj)); } catch (e) {}
    }

    let folders = loadFolders();
    let assign = loadAssign();
    let selected = null; // null = "All"; "__unfiled__" = the Unfiled bucket

    // One-time cleanup of folders this browser no longer has any use for
    // (see `opts.retired` above). Anything that was filed into one goes
    // back to Unfiled rather than disappearing — same as deleting a
    // folder by hand.
    if (retired.length) {
      const doomed = folders.filter(f => retired.includes(f));
      if (doomed.length) {
        folders = folders.filter(f => !doomed.includes(f));
        saveFolders(folders);
        Object.keys(assign).forEach((id) => { if (doomed.includes(assign[id])) delete assign[id]; });
        saveAssign(assign);
      }
    }

    return {
      list() { return folders.slice(); },
      getSelected() { return selected; },
      select(name) { selected = name; },
      folderOf(id) { return assign[id] || null; },
      countIn(name, allIds) {
        return allIds.filter(id => assign[id] === name).length;
      },
      countUnfiled(allIds) {
        return allIds.filter(id => !assign[id]).length;
      },
      moveTo(id, name) {
        if (name) assign[id] = name; else delete assign[id];
        saveAssign(assign);
      },
      create(name) {
        name = (name || "").trim();
        if (!name || folders.includes(name)) return false;
        folders.push(name);
        saveFolders(folders);
        return true;
      },
      remove(name) {
        folders = folders.filter(f => f !== name);
        saveFolders(folders);
        Object.keys(assign).forEach((id) => { if (assign[id] === name) delete assign[id]; });
        saveAssign(assign);
        if (selected === name) selected = null;
      },
      // Whether an item (by id) should show under whichever folder is
      // currently selected — "All" shows everything, "Unfiled" shows only
      // items with no folder, anything else shows only that folder's own.
      matches(id) {
        if (selected === null) return true;
        if (selected === "__unfiled__") return !assign[id];
        return assign[id] === selected;
      },
      // Drops stale assignments for ids no longer present (e.g. a note or
      // photo that's since been deleted) so storage doesn't grow forever.
      prune(liveIds) {
        const liveSet = new Set(liveIds);
        let changed = false;
        Object.keys(assign).forEach((id) => {
          if (!liveSet.has(id)) { delete assign[id]; changed = true; }
        });
        if (changed) saveAssign(assign);
      },
    };
  }

  // Builds the "All / <folders> / Unfiled" column shown to the left of a
  // browser's list, plus the "+ new folder" row at the bottom. `onChange`
  // re-renders the whole browser (folder column and list both) whenever a
  // folder is picked, created, or deleted.
  // `protectedNames` lists folders this browser maintains itself, so they
  // get no delete button — deleting one would only have it reappear on
  // the next render (see syncDRCFolderAssignments), which reads as a bug.
  function renderFolderSidebar(container, mgr, allIds, onChange, protectedNames) {
    const protectedSet = new Set(protectedNames || []);
    container.innerHTML = "";
    function makeRow(name, label, icon, count, deletable) {
      const row = document.createElement("div");
      row.className = "browser-folder-row" + (mgr.getSelected() === name ? " active" : "");
      const iconEl = document.createElement("span");
      iconEl.className = "browser-folder-row-icon";
      iconEl.textContent = icon;
      const text = document.createElement("span");
      text.className = "browser-folder-row-label";
      text.textContent = label;
      // Belt-and-braces for a name long enough to still be clipped after
      // wrapping — hovering the row spells it out in full.
      row.title = label;
      const badge = document.createElement("span");
      badge.className = "browser-folder-row-count";
      badge.textContent = String(count);
      row.append(iconEl, text, badge);
      if (deletable) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "browser-folder-row-del";
        del.textContent = "×";
        del.title = `Delete "${name}" folder`;
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`Delete the "${name}" folder? Its items go back to Unfiled.`)) return;
          mgr.remove(name);
          onChange();
        });
        row.appendChild(del);
      }
      row.addEventListener("click", () => { mgr.select(name); onChange(); });
      container.appendChild(row);
    }
    makeRow(null, "All", "🗂", allIds.length, false);
    mgr.list().forEach((name) => makeRow(name, name, "📁", mgr.countIn(name, allIds), !protectedSet.has(name)));
    makeRow("__unfiled__", "Unfiled", "📄", mgr.countUnfiled(allIds), false);

    const addRow = document.createElement("div");
    addRow.className = "browser-folder-add-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "New folder…";
    input.className = "browser-folder-add-input";
    input.spellcheck = false;
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "browser-folder-add-btn";
    addBtn.textContent = "+";
    addBtn.title = "Create folder";
    function submit() {
      if (mgr.create(input.value)) { input.value = ""; onChange(); }
    }
    addBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    addRow.append(input, addBtn);
    container.appendChild(addRow);
  }

  // Small "📁" button (added to each browser row) that opens a popover
  // listing every folder plus "Unfiled" — clicking one files that item
  // straight away, no dragging required.
  let folderMovePopoverEl = null;
  let folderMovePopoverOutsideHandler = null;
  function closeFolderMovePopover() {
    if (folderMovePopoverEl) { folderMovePopoverEl.remove(); folderMovePopoverEl = null; }
    if (folderMovePopoverOutsideHandler) {
      document.removeEventListener("mousedown", folderMovePopoverOutsideHandler);
      folderMovePopoverOutsideHandler = null;
    }
  }
  function openFolderMovePopover(anchorBtn, mgr, id, onChange) {
    closeFolderMovePopover();
    const pop = document.createElement("div");
    pop.className = "folder-move-popover";
    const current = mgr.folderOf(id);
    function addOption(name, label) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "folder-move-option" + (current === name ? " active" : "");
      opt.textContent = label;
      opt.addEventListener("mousedown", (e) => e.preventDefault());
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        mgr.moveTo(id, name);
        closeFolderMovePopover();
        onChange();
      });
      pop.appendChild(opt);
    }
    addOption(null, "Unfiled");
    mgr.list().forEach((name) => addOption(name, name));

    // "New folder…" row at the bottom — creates the folder and files this
    // item into it in one step, so there's no need to close the popover,
    // go make the folder in the browser's own sidebar, then come back.
    // Typing an existing folder's name just files the item there.
    const addRow = document.createElement("div");
    addRow.className = "folder-move-add-row";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.className = "folder-move-add-input";
    addInput.placeholder = "New folder…";
    addInput.spellcheck = false;
    addInput.autocomplete = "off";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "folder-move-add-btn";
    addBtn.textContent = "+";
    addBtn.title = "Create folder and move here";
    function submitNewFolder() {
      const name = addInput.value.trim();
      if (!name) { addInput.focus(); return; }
      mgr.create(name); // no-op (false) if it already exists — moveTo below still applies
      if (!mgr.list().includes(name)) return;
      mgr.moveTo(id, name);
      closeFolderMovePopover();
      onChange();
    }
    addBtn.addEventListener("mousedown", (e) => e.preventDefault());
    addBtn.addEventListener("click", (e) => { e.stopPropagation(); submitNewFolder(); });
    addInput.addEventListener("click", (e) => e.stopPropagation());
    addInput.addEventListener("keydown", (e) => {
      // Keep typing here from triggering the host modal's own keyboard
      // shortcuts (photo arrows, note editor keys, Esc-to-close, …).
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submitNewFolder(); }
      else if (e.key === "Escape") { e.preventDefault(); closeFolderMovePopover(); }
    });
    addRow.append(addInput, addBtn);
    pop.appendChild(addRow);
    document.body.appendChild(pop);
    const margin = 8;
    const rect = anchorBtn.getBoundingClientRect();
    let left = rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - pop.offsetWidth - margin));
    let top = rect.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - margin) top = rect.top - pop.offsetHeight - 6;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    folderMovePopoverEl = pop;
    folderMovePopoverOutsideHandler = (e) => {
      if (!pop.contains(e.target) && e.target !== anchorBtn) closeFolderMovePopover();
    };
    setTimeout(() => document.addEventListener("mousedown", folderMovePopoverOutsideHandler), 0);
  }
  function buildFolderMoveBtn(mgr, id, onChange) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "browser-row-folder-btn";
    const current = mgr.folderOf(id);
    btn.textContent = "📁";
    btn.title = current ? `In "${current}" — click to move` : "Move to folder";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderMovePopover(btn, mgr, id, onChange);
    });
    return btn;
  }

  // Lists every note across node and cell content hosts in one place —
  // versus the Favorites browser above, which only shows
  // the subset you've starred. Sortable by date (most recently touched
  // first — see captureActiveNote for where updatedAt/createdAt get
  // set), favorite status, or alphabetically by the note's own preview
  // text (see notePreviewText: its title, or else its first line). Click
  // the active sort button again to reverse its direction (see
  // setupSortToggle above).
  const notesBrowserModal = $("#notesbrowser-modal");
  const notesBrowserList = $("#notesbrowser-list");
  const notesBrowserSearch = $("#notesbrowser-search");
  const notesBrowserFoldersEl = $("#notesbrowser-folders");
  const notesBrowserSortBtns = [$("#notesbrowser-sort-date"), $("#notesbrowser-sort-alpha")];
  // The one browser where DRC means something — see
  // syncDRCFolderAssignments below, which keeps it filled automatically.
  const DRC_FOLDER = "DRC";
  // Shared with the Photos and Videos browsers below — a folder every
  // browser maintains the same way (auto-filled, protected from manual
  // move/delete), for the same reason DRC is: the sort-by-favorite
  // button it replaces only ever gave you "favorites first in this one
  // list, until you close it" — the star ended up cleared when you
  // reopened the browser tomorrow and it had already sorted by date
  // again. A real folder persists and is one click away from any
  // browser's "All" view.
  const FAVORITE_FOLDER = "Favorite";
  const notesFolderMgr = createFolderManager("notes", { defaults: [DRC_FOLDER, FAVORITE_FOLDER] });
  let notesBrowserItems = [];


  function collectAllNotes() {
    const items = [];
    collectContentHosts().forEach(({ node, host, r, c, hostLabel }) => {
      getNodeNotes(host).forEach((n) => items.push({
        nodeId: node.id, r, c, noteId: n.id, nodeLabel: hostLabel, taskLabel: "",
        title: (n.title || "").trim(), preview: notePreviewText(n), favorite: !!n.favorite,
        ts: n.updatedAt || n.createdAt || 0, isDRC: isDRCNote(n), isPlan: isPlanNote(n),
      }));
      getNodeTasks(host).forEach((t) => {
        getTaskNotes(t).forEach((n) => items.push({
          nodeId: node.id, r, c, taskId: t.id, noteId: n.id, nodeLabel: hostLabel,
          taskLabel: t.text || "Untitled task", title: (n.title || "").trim(),
          preview: notePreviewText(n), favorite: !!n.favorite, ts: n.updatedAt || n.createdAt || 0,
          isDRC: isDRCNote(n), isPlan: isPlanNoteFor(n, t),
        }));
        getTaskSubtasks(t).forEach((s) => getTaskNotes(s).forEach((n) => items.push({
          nodeId: node.id, r, c, taskId: t.id, subtaskId: s.id, noteId: n.id,
          nodeLabel: hostLabel,
          taskLabel: `${t.text || "Untitled task"} → ${s.text || "Untitled subtask"}`,
          title: (n.title || "").trim(), preview: notePreviewText(n), favorite: !!n.favorite,
          ts: n.updatedAt || n.createdAt || 0, isDRC: isDRCNote(n), isPlan: isPlanNoteFor(n, s),
        })));
      });
    });
    return items;
  }

  // Builds the single display/sort/search line for a Notes browser row —
  // "node.text → task name → note title", dropping any segment that's
  // empty (a plain node note has no task, and plenty of notes have no
  // title at all) rather than leaving a dangling arrow or blank segment.
  // A DRC note's title is always literally "DRC" (see isDRCNote) — that's
  // already said by the group heading it sits under (see
  // renderNotesBrowserList), so it's dropped here to avoid every DRC row
  // ending in a redundant "→ DRC".
  function noteBrowserRowLabel(it) {
    return [it.nodeLabel, it.taskLabel, it.isDRC ? "" : it.title].filter(Boolean).join(" → ");
  }

  function sortNotesBrowserItems(items) {
    const sorted = items.slice();
    const dir = notesBrowserSortState.dir === "asc" ? 1 : -1;
    if (notesBrowserSortState.sort === "alpha") {
      sorted.sort((a, b) => noteBrowserRowLabel(a).localeCompare(noteBrowserRowLabel(b)) * dir);
    } else {
      sorted.sort((a, b) => (b.ts - a.ts) * dir);
    }
    return sorted;
  }

  // `keep === true` re-opens with the search text left as it was (used by
  // the viewers' ← Back button) instead of starting fresh. Strictly `true`
  // because this is also bound directly as a click handler.
  function openNotesBrowserModal(keep) {
    notesBrowserItems = collectAllNotes();
    if (keep !== true) notesBrowserSearch.value = "";
    renderNotesBrowserList();
    zoomModalOpen(notesBrowserModal);
    if (keep !== true) requestAnimationFrame(() => notesBrowserSearch.focus());
  }
  function closeNotesBrowserModal() {
    closeFolderMovePopover();
    zoomModalClose(notesBrowserModal);
  }

  function jumpToNoteBrowserItem(it) {
    const node = findNode(it.nodeId);
    if (!node) return;
    const idx = resolveNoteListForItem(node, it).findIndex(n => n.id === it.noteId);
    const ret = makeBrowserReturn("Notes", notesBrowserList, openNotesBrowserModal, notesFolderMgr);
    closeNotesBrowserModal();
    withViewerReturn(ret, () => openNoteModal(it.nodeId, idx >= 0 ? idx : undefined, null,
      it.taskId || null, browserItemCellPos(it), false, it.subtaskId || null));
  }

  // Same direct toggle as unfavoriteItem in the Favorites browser above —
  // lets you star/unstar right from the list without opening the note.
  function toggleNoteBrowserFavorite(it) {
    const node = findNode(it.nodeId);
    if (!node) return;
    const n = resolveNoteListForItem(node, it).find(x => x.id === it.noteId);
    if (!n) return;
    pushUndo();
    n.favorite = !n.favorite;
    it.favorite = n.favorite;
    persist();
  }

  // Builds one row for the Notes browser list — shared by both the DRC
  // and regular-notes groups below (see renderNotesBrowserList), so the
  // only difference between the two groups is which heading they sit
  // under, not how their rows look or behave.
  function buildNoteBrowserRow(it) {
    const li = document.createElement("li");
    li.className = "favoritesbrowser-row";

    const icon = document.createElement("span");
    icon.className = "favoritesbrowser-row-icon";
    if (it.isDRC) icon.appendChild(drcIconEl(22));
    else if (it.isPlan) icon.appendChild(planIconEl(22));
    else icon.appendChild(noteIconEl(22));

    // A single combined line — "node → task → title", each segment
    // skipped when empty (see noteBrowserRowLabel) — rather than the
    // separate name/preview lines the Favorites browser's rows use.
    const text = document.createElement("span");
    text.className = "favoritesbrowser-row-text";
    const name = document.createElement("span");
    name.className = "favoritesbrowser-row-name";
    const label = noteBrowserRowLabel(it);
    name.textContent = label;
    name.title = label; // full text on hover too, in case a very long label still clips at the row's max height
    text.append(name);

    const meta = document.createElement("span");
    meta.className = "notesbrowser-row-date";
    meta.textContent = it.ts ? relTime(it.ts) : "—";
    meta.title = it.ts ? new Date(it.ts).toLocaleString() : "No date recorded";

    const star = document.createElement("span");
    star.className = "item-star" + (it.favorite ? " favorited" : "");
    star.textContent = it.favorite ? "★" : "☆";
    star.title = it.favorite ? "Remove from favorites" : "Add to favorites";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleNoteBrowserFavorite(it);
      star.textContent = it.favorite ? "★" : "☆";
      star.classList.toggle("favorited", it.favorite);
      star.title = it.favorite ? "Remove from favorites" : "Add to favorites";
      renderNotesBrowserList();
    });

    // No "move to folder" button on a DRC or a starred row: both have
    // their folder decided for them (syncDRCFolderAssignments /
    // syncFavoriteFolderAssignments would just put it straight back), so
    // offering one would be a button that silently undoes itself.
    if (it.isDRC || it.favorite) {
      li.append(icon, text, meta, star);
    } else {
      li.append(icon, text, meta, buildFolderMoveBtn(notesFolderMgr, it.noteId, renderNotesBrowserList), star);
    }
    li.addEventListener("click", () => jumpToNoteBrowserItem(it));
    return li;
  }

  // Files every DRC note into the "DRC" folder, without anyone having to
  // move it there. "DRC note" is decided the one way it's decided
  // everywhere else in the app — the title, see isDRCNote — so this
  // covers both notes started from the 📋 DRC… shortcut (which titles
  // them "DRC") and notes simply titled DRC by hand, and it keeps
  // covering them if a title is edited either way later on. Runs on
  // every render rather than at note-creation time so nothing can drift:
  // notes made on another device and pulled in by Drive sync land in the
  // right folder here too, even though the folder assignments themselves
  // are local to this browser.
  function syncDRCFolderAssignments() {
    const drcIds = notesBrowserItems.filter((it) => it.isDRC).map((it) => it.noteId);
    if (!drcIds.length) return;
    notesFolderMgr.create(DRC_FOLDER); // no-op if it's already there
    drcIds.forEach((id) => {
      if (notesFolderMgr.folderOf(id) !== DRC_FOLDER) notesFolderMgr.moveTo(id, DRC_FOLDER);
    });
  }

  // Same idea, for starred notes — except a note titled DRC keeps its
  // DRC folder even if it's also starred: DRC is the stronger,
  // title-based category, and letting a star quietly move it out of DRC
  // (or bounce it back and forth depending on which sync ran last)
  // would be more confusing than one note simply not living in two
  // folders at once.
  function syncFavoriteFolderAssignments() {
    const favIds = notesBrowserItems.filter((it) => it.favorite && !it.isDRC).map((it) => it.noteId);
    if (!favIds.length) return;
    notesFolderMgr.create(FAVORITE_FOLDER);
    favIds.forEach((id) => {
      if (notesFolderMgr.folderOf(id) !== FAVORITE_FOLDER) notesFolderMgr.moveTo(id, FAVORITE_FOLDER);
    });
  }

  function renderNotesBrowserList() {
    const allIds = notesBrowserItems.map((it) => it.noteId);
    notesFolderMgr.prune(allIds);
    syncDRCFolderAssignments();
    syncFavoriteFolderAssignments();
    renderFolderSidebar(notesBrowserFoldersEl, notesFolderMgr, allIds, renderNotesBrowserList, [DRC_FOLDER, FAVORITE_FOLDER]);
    const q = notesBrowserSearch.value.trim().toLowerCase();
    const filtered = notesBrowserItems.filter((it) =>
      notesFolderMgr.matches(it.noteId) &&
      (!q || it.preview.toLowerCase().includes(q) || noteBrowserRowLabel(it).toLowerCase().includes(q)));
    const sorted = sortNotesBrowserItems(filtered);
    notesBrowserList.innerHTML = "";
    if (!sorted.length) {
      const empty = document.createElement("li");
      empty.className = "tagbrowser-empty";
      empty.textContent = notesBrowserItems.length
        ? "No notes match that search."
        : "No notes yet — add one from any node to see it here.";
      notesBrowserList.appendChild(empty);
      return;
    }
    // Used to split into a "📋 DRC" heading ahead of everything else,
    // even under "All". Removed now that DRC notes are already sorted
    // into their own real folder (see syncDRCFolderAssignments/DRC_FOLDER
    // above) — with that folder already doing the separating, the extra
    // heading here was the same grouping shown twice.
    sorted.forEach((it) => {
      const node = findNode(it.nodeId);
      if (!node) return; // stale entry (shouldn't normally happen)
      notesBrowserList.appendChild(buildNoteBrowserRow(it));
    });
  }

  $("#btn-notesbrowser").addEventListener("click", openNotesBrowserModal);
  $("#notesbrowser-close").addEventListener("click", closeNotesBrowserModal);
  notesBrowserModal.addEventListener("click", (e) => { if (e.target === notesBrowserModal) closeNotesBrowserModal(); });
  notesBrowserSearch.addEventListener("input", renderNotesBrowserList);
  const notesBrowserSortState = setupSortToggle(notesBrowserSortBtns, "date", renderNotesBrowserList);
  document.addEventListener("keydown", (e) => {
    if (notesBrowserModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeNotesBrowserModal();
  });

  /* ---------------- photos browser ---------------- */

  // Lists every photo attached to any node across the whole map (not just
  // starred ones — contrast the Favorites browser above) in one place,
  // same idea as the Notes browser but for photos. Sortable by date
  // added (see getPhotoTimestamp/collectAllPhotos below), favorite status
  // (reusing the same photoFavorites star as the photo viewer and the
  // Favorites browser), or alphabetically — by the photo's own first tag
  // when it has one (a tag reads as more "the photo's name" than the node
  // it happens to sit on), falling back to the node's name otherwise.
  const photosBrowserModal = $("#photosbrowser-modal");
  const photosBrowserList = $("#photosbrowser-list");
  const photosBrowserSearch = $("#photosbrowser-search");
  const photosBrowserFoldersEl = $("#photosbrowser-folders");
  const photosBrowserSortBtns = [$("#photosbrowser-sort-date"), $("#photosbrowser-sort-alpha")];
  const photosFolderMgr = createFolderManager("photos", { retired: ["DRC"], defaults: [FAVORITE_FOLDER] });
  let photosBrowserItems = [];

  function collectAllPhotos() {
    const items = [];
    let backfilled = false;
    collectContentHosts().forEach(({ node, host, r, c, hostLabel }) => {
      getNodeImageIds(host).forEach((id) => {
        let ts = getPhotoTimestamp(host, id);
        if (!ts) { ts = Date.now(); setPhotoTimestamp(host, id, ts); backfilled = true; }
        const tag = getPhotoTags(host, id)[0] || "";
        items.push({
          nodeId: node.id, r, c, photoId: id, nodeLabel: hostLabel,
          tag, alphaKey: tag || hostLabel, favorite: getPhotoFavorite(host, id), ts,
        });
      });
    });
    if (backfilled) persist();
    return items;
  }

  function sortPhotosBrowserItems(items) {
    const sorted = items.slice();
    const dir = photosBrowserSortState.dir === "asc" ? 1 : -1;
    if (photosBrowserSortState.sort === "alpha") {
      sorted.sort((a, b) => a.alphaKey.localeCompare(b.alphaKey) * dir);
    } else {
      sorted.sort((a, b) => (b.ts - a.ts) * dir);
    }
    return sorted;
  }

  function openPhotosBrowserModal(keep) {
    photosBrowserItems = collectAllPhotos();
    if (keep !== true) photosBrowserSearch.value = "";
    renderPhotosBrowserList();
    zoomModalOpen(photosBrowserModal);
    if (keep !== true) requestAnimationFrame(() => photosBrowserSearch.focus());
  }
  function closePhotosBrowserModal() {
    closeFolderMovePopover();
    zoomModalClose(photosBrowserModal);
  }

  function jumpToPhotoBrowserItem(it) {
    const node = findNode(it.nodeId);
    if (!node) return;
    const host = browserItemHost(node, it);
    const idx = host ? getNodeImageIds(host).indexOf(it.photoId) : -1;
    if (idx < 0) return;
    const ret = makeBrowserReturn("Photos", photosBrowserList, openPhotosBrowserModal, photosFolderMgr);
    closePhotosBrowserModal();
    const group = {
      label: "Photos",
      items: photosBrowserItems.map(x => ({ nodeId: x.nodeId, r: x.r, c: x.c, id: x.photoId })),
    };
    withViewerReturn(ret, () => openBrowserPhotoItem(it, idx, group));
  }

  // Same direct toggle as unfavoriteItem in the Favorites browser above —
  // lets you star/unstar right from the list without opening the photo.
  function togglePhotoBrowserFavorite(it) {
    const node = findNode(it.nodeId);
    if (!node) return;
    const host = browserItemHost(node, it);
    if (!host) return;
    pushUndo();
    setPhotoFavorite(host, it.photoId, !getPhotoFavorite(host, it.photoId));
    it.favorite = getPhotoFavorite(host, it.photoId);
    persist();
  }

  // Same rule as the Notes browser's syncFavoriteFolderAssignments —
  // photos have no DRC-equivalent concept, so this is the only folder
  // rule they need.
  function syncPhotosFavoriteFolderAssignments() {
    const favIds = photosBrowserItems.filter((it) => it.favorite).map((it) => it.photoId);
    if (!favIds.length) return;
    photosFolderMgr.create(FAVORITE_FOLDER);
    favIds.forEach((id) => {
      if (photosFolderMgr.folderOf(id) !== FAVORITE_FOLDER) photosFolderMgr.moveTo(id, FAVORITE_FOLDER);
    });
  }

  function renderPhotosBrowserList() {
    const allIds = photosBrowserItems.map((it) => it.photoId);
    photosFolderMgr.prune(allIds);
    syncPhotosFavoriteFolderAssignments();
    renderFolderSidebar(photosBrowserFoldersEl, photosFolderMgr, allIds, renderPhotosBrowserList, [FAVORITE_FOLDER]);
    const q = photosBrowserSearch.value.trim().toLowerCase();
    // A photo shared by two nodes has one id, so a folder assignment (and
    // "Favorite", synced from ONE node's star) is keyed by that id — only
    // list a node's copy under Favorite if that node really starred it.
    const filtered = photosBrowserItems.filter((it) =>
      photosFolderMgr.matches(it.photoId) &&
      (photosFolderMgr.getSelected() !== FAVORITE_FOLDER || it.favorite) &&
      (!q || it.nodeLabel.toLowerCase().includes(q) || it.tag.toLowerCase().includes(q)));
    const sorted = sortPhotosBrowserItems(filtered);
    photosBrowserList.innerHTML = "";
    if (!sorted.length) {
      const empty = document.createElement("li");
      empty.className = "tagbrowser-empty";
      empty.textContent = photosBrowserItems.length
        ? "No photos match that search."
        : "No photos yet — add one to any node to see it here.";
      photosBrowserList.appendChild(empty);
      return;
    }
    sorted.forEach((it) => {
      const node = findNode(it.nodeId);
      if (!node) return; // stale entry (shouldn't normally happen)
      const li = document.createElement("li");
      li.className = "favoritesbrowser-row";

      const icon = document.createElement("span");
      icon.className = "favoritesbrowser-row-icon";
      const thumbUrl = photoUrl(it.photoId);
      if (thumbUrl) {
        const thumb = document.createElement("img");
        thumb.className = "tagbrowser-tag-thumb";
        thumb.alt = "";
        thumb.src = thumbUrl;
        thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });
        icon.appendChild(thumb);
      } else {
        icon.textContent = "🖼";
      }

      const text = document.createElement("span");
      text.className = "favoritesbrowser-row-text";
      const name = document.createElement("span");
      name.className = "favoritesbrowser-row-name";
      name.textContent = it.nodeLabel;
      name.title = it.nodeLabel;
      const preview = document.createElement("span");
      preview.className = "favoritesbrowser-row-preview";
      preview.textContent = it.tag ? `Tagged “${it.tag}”` : "Photo";
      text.append(name, preview);

      const meta = document.createElement("span");
      meta.className = "notesbrowser-row-date";
      meta.textContent = it.ts ? relTime(it.ts) : "—";
      meta.title = it.ts ? new Date(it.ts).toLocaleString() : "No date recorded";

      const star = document.createElement("span");
      star.className = "item-star" + (it.favorite ? " favorited" : "");
      star.textContent = it.favorite ? "★" : "☆";
      star.title = it.favorite ? "Remove from favorites" : "Add to favorites";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePhotoBrowserFavorite(it);
        renderPhotosBrowserList();
      });

      // No folder button on a starred row — same reasoning as the Notes
      // browser's DRC/starred rows: syncPhotosFavoriteFolderAssignments
      // would just put it straight back into Favorite.
      if (it.favorite) {
        li.append(icon, text, meta, star);
      } else {
        li.append(icon, text, meta, buildFolderMoveBtn(photosFolderMgr, it.photoId, renderPhotosBrowserList), star);
      }
      li.addEventListener("click", () => jumpToPhotoBrowserItem(it));
      photosBrowserList.appendChild(li);
    });
  }

  $("#btn-photosbrowser").addEventListener("click", openPhotosBrowserModal);
  $("#photosbrowser-tags-btn").addEventListener("click", () => {
    closePhotosBrowserModal();
    openTagBrowserModal(true);
  });
  $("#photosbrowser-close").addEventListener("click", closePhotosBrowserModal);
  photosBrowserModal.addEventListener("click", (e) => { if (e.target === photosBrowserModal) closePhotosBrowserModal(); });
  photosBrowserSearch.addEventListener("input", renderPhotosBrowserList);
  const photosBrowserSortState = setupSortToggle(photosBrowserSortBtns, "date", renderPhotosBrowserList);
  document.addEventListener("keydown", (e) => {
    if (photosBrowserModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closePhotosBrowserModal();
  });

  /* ---------------- videos browser ---------------- */

  // Same idea as the Photos browser above, but for links that actually
  // open in the in-app video player — a URL where youtubeVideoId(url) is
  // truthy (see openLinkSmart). A plain (non-video) link is skipped
  // entirely here; that's what the Links entries in the Favorites browser
  // are for. Sortable by date added, favorite status (reusing the same
  // linkFavorites star as the video modal and the Favorites browser), or
  // alphabetically by the video's own title (falling back to its URL when
  // it has no title — see getLinkTitle).
  const videosBrowserModal = $("#videosbrowser-modal");
  const videosBrowserList = $("#videosbrowser-list");
  const videosBrowserSearch = $("#videosbrowser-search");
  const videosBrowserFoldersEl = $("#videosbrowser-folders");
  const videosBrowserSortBtns = [$("#videosbrowser-sort-date"), $("#videosbrowser-sort-alpha")];
  const videosFolderMgr = createFolderManager("videos", { retired: ["DRC"], defaults: [FAVORITE_FOLDER] });
  let videosBrowserItems = [];

  function collectAllVideos() {
    const items = [];
    let backfilled = false;
    collectContentHosts().forEach(({ node, host, r, c, hostLabel }) => {
      getNodeUrls(host).forEach((url) => {
        if (!youtubeVideoId(url)) return;
        let ts = getLinkTimestamp(host, url);
        if (!ts) { ts = Date.now(); setLinkTimestamp(host, url, ts); backfilled = true; }
        items.push({
          nodeId: node.id, r, c, url, id: videoItemKey(node.id, r, c, url),
          nodeLabel: hostLabel, title: getLinkTitle(host, url) || url,
          favorite: getLinkFavorite(host, url), ts,
        });
      });
    });
    if (backfilled) persist();
    return items;
  }

  function sortVideosBrowserItems(items) {
    const sorted = items.slice();
    const dir = videosBrowserSortState.dir === "asc" ? 1 : -1;
    if (videosBrowserSortState.sort === "alpha") {
      sorted.sort((a, b) => a.title.localeCompare(b.title) * dir);
    } else {
      sorted.sort((a, b) => (b.ts - a.ts) * dir);
    }
    return sorted;
  }

  function openVideosBrowserModal(keep) {
    videosBrowserItems = collectAllVideos();
    if (keep !== true) videosBrowserSearch.value = "";
    renderVideosBrowserList();
    zoomModalOpen(videosBrowserModal);
    if (keep !== true) requestAnimationFrame(() => videosBrowserSearch.focus());
  }
  function closeVideosBrowserModal() {
    closeFolderMovePopover();
    zoomModalClose(videosBrowserModal);
  }

  // Opens the video the same way clicking its link icon on the canvas
  // does — the in-app player, wired to the same comment/favorite fields
  // (see openLinkSmart/openVideoModal) — rather than anything bespoke to
  // this browser.
  function jumpToVideoBrowserItem(it) {
    const node = findNode(it.nodeId);
    if (!node) return;
    const host = browserItemHost(node, it);
    if (!host) return;
    const ret = makeBrowserReturn("Videos", videosBrowserList, openVideosBrowserModal, videosFolderMgr);
    closeVideosBrowserModal();
    const liveHost = () => browserItemHost(findNode(it.nodeId) || node, it);
    withViewerReturn(ret, () => openLinkSmart(it.url, {
      videoKey: it.id,
      get: () => getLinkComment(liveHost(), it.url),
      set: (v) => setLinkComment(liveHost(), it.url, v),
      getFavorite: () => getLinkFavorite(liveHost(), it.url),
      setFavorite: (v) => setLinkFavorite(liveHost(), it.url, v),
      getPhotos: () => getLinkPhotos(liveHost(), it.url),
      addPhoto: (dataUrl) => addLinkPhoto(liveHost(), it.url, dataUrl),
      removePhoto: (id) => removeLinkPhoto(liveHost(), it.url, id),
    }));
  }

  function toggleVideoBrowserFavorite(it) {
    const node = findNode(it.nodeId);
    if (!node) return;
    const host = browserItemHost(node, it);
    if (!host) return;
    pushUndo();
    setLinkFavorite(host, it.url, !getLinkFavorite(host, it.url));
    it.favorite = getLinkFavorite(host, it.url);
    persist();
  }

  // Same rule as Photos — videos have no DRC-equivalent either.
  function syncVideosFavoriteFolderAssignments() {
    const favIds = videosBrowserItems.filter((it) => it.favorite).map((it) => it.id);
    if (!favIds.length) return;
    videosFolderMgr.create(FAVORITE_FOLDER);
    favIds.forEach((id) => {
      if (videosFolderMgr.folderOf(id) !== FAVORITE_FOLDER) videosFolderMgr.moveTo(id, FAVORITE_FOLDER);
    });
  }

  function renderVideosBrowserList() {
    const allIds = videosBrowserItems.map((it) => it.id);
    videosFolderMgr.prune(allIds);
    syncVideosFavoriteFolderAssignments();
    renderFolderSidebar(videosBrowserFoldersEl, videosFolderMgr, allIds, renderVideosBrowserList, [FAVORITE_FOLDER]);
    const q = videosBrowserSearch.value.trim().toLowerCase();
    const filtered = videosBrowserItems.filter((it) =>
      videosFolderMgr.matches(it.id) &&
      (!q || it.title.toLowerCase().includes(q) || it.nodeLabel.toLowerCase().includes(q)));
    const sorted = sortVideosBrowserItems(filtered);
    videosBrowserList.innerHTML = "";
    if (!sorted.length) {
      const empty = document.createElement("li");
      empty.className = "tagbrowser-empty";
      empty.textContent = videosBrowserItems.length
        ? "No videos match that search."
        : "No videos yet — add a YouTube link to any node to see it here.";
      videosBrowserList.appendChild(empty);
      return;
    }
    sorted.forEach((it) => {
      const node = findNode(it.nodeId);
      if (!node) return; // stale entry (shouldn't normally happen)
      const li = document.createElement("li");
      li.className = "favoritesbrowser-row";

      const icon = document.createElement("span");
      icon.className = "favoritesbrowser-row-icon";
      setYoutubeIcon(icon, 22);

      const text = document.createElement("span");
      text.className = "favoritesbrowser-row-text";
      const name = document.createElement("span");
      name.className = "favoritesbrowser-row-name";
      name.textContent = it.nodeLabel;
      name.title = it.nodeLabel;
      const preview = document.createElement("span");
      preview.className = "favoritesbrowser-row-preview";
      preview.textContent = it.title;
      preview.title = it.title;
      text.append(name, preview);

      const meta = document.createElement("span");
      meta.className = "notesbrowser-row-date";
      meta.textContent = it.ts ? relTime(it.ts) : "—";
      meta.title = it.ts ? new Date(it.ts).toLocaleString() : "No date recorded";

      const star = document.createElement("span");
      star.className = "item-star" + (it.favorite ? " favorited" : "");
      star.textContent = it.favorite ? "★" : "☆";
      star.title = it.favorite ? "Remove from favorites" : "Add to favorites";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleVideoBrowserFavorite(it);
        renderVideosBrowserList();
      });

      // No folder button on a starred row — same reasoning as Notes/
      // Photos: syncVideosFavoriteFolderAssignments would just put it
      // straight back into Favorite.
      if (it.favorite) {
        li.append(icon, text, meta, star);
      } else {
        li.append(icon, text, meta, buildFolderMoveBtn(videosFolderMgr, it.id, renderVideosBrowserList), star);
      }
      li.addEventListener("click", () => jumpToVideoBrowserItem(it));
      videosBrowserList.appendChild(li);
    });
  }

  $("#btn-videosbrowser").addEventListener("click", openVideosBrowserModal);
  $("#videosbrowser-close").addEventListener("click", closeVideosBrowserModal);
  videosBrowserModal.addEventListener("click", (e) => { if (e.target === videosBrowserModal) closeVideosBrowserModal(); });
  videosBrowserSearch.addEventListener("input", renderVideosBrowserList);
  const videosBrowserSortState = setupSortToggle(videosBrowserSortBtns, "date", renderVideosBrowserList);
  document.addEventListener("keydown", (e) => {
    if (videosBrowserModal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeVideosBrowserModal();
  });

  /* ---------------- boot ---------------- */

  async function boot() {
    // If web/custom fonts (e.g. "Inter") are still loading, the very first
    // layout pass may measure text with fallback font metrics, sizing boxes
    // slightly too narrow and forcing a mid-word wrap. Re-run layout once
    // the real fonts are ready so box widths match what's actually painted.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => renderAll());
    }

    // Fast path: IndexedDB is local and normally available in milliseconds.
    // Load it first and put the last-opened map on screen BEFORE any folder
    // or Google Drive network work. A known previous Drive session gets a
    // read-only local preview while verification/upload continues.
    await loadAllMaps();
    await loadAffirmationQuotes();
    await FolderDB.restore();

    let hadDriveSession = !!loadCachedDriveToken();
    if (!hadDriveSession) {
      try { hadDriveSession = !!(await DB.getHandle(DRIVE_SIGNED_IN_KEY)); } catch (e) {}
    }

    const localActive = activeMaps();
    if (hadDriveSession && localActive.length) {
      startupLocalPreview = true;
      // Make the UI say "syncing" (and keep editing locked) immediately
      // instead of briefly looking signed-out before DriveDB.restore runs.
      DriveDB.status = "connecting";
      DriveDB.setSyncProgress("Opening local copy…", 0, 0, 1);

      let lastId = null;
      try { lastId = localStorage.getItem(LAST_OPENED_MAP_KEY); } catch (e) {}
      const lastStillActive = lastId && localActive.find(m => m.id === lastId);
      const toOpen = lastStillActive ? lastId : localActive[0].id;

      updateFolderUI();
      updateDriveUI("Syncing…");
      renderSidebar();
      await openMap(toOpen);
    } else {
      updateFolderUI();
      updateDriveUI();
      renderSidebar();
    }

    // Yield a frame so the cached map is actually painted before starting
    // slow Drive/folder I/O. This is the key difference from the old boot:
    // sync can take minutes for photo-heavy maps, but reopen no longer does.
    requestAnimationFrame(() => {
      setTimeout(async () => {
        try {
          if (FolderDB.dir && !FolderDB.needsPermission) {
            await FolderDB.syncFromFolder();
            if (state.current && !state.editingId && !unsavedEdits) {
              renderSidebar();
              renderAll();
            }
          }

          await DriveDB.restore(); // may download/upload large maps; now background work
          startupLocalPreview = false;

          // Convert old heavyweight conflict copies to shared-photo recovery
          // maps after Drive metadata is known. This runs in the background,
          // never delaying the cached map's first paint.
          try { await migrateLegacyRecoveryPhotoSharing(); } catch (e) {
            console.warn("Legacy recovery photo sharing migration skipped", e);
          }

          const dupesTrashed = await autoRemoveDuplicateMaps();
          if (dupesTrashed) console.log(`Auto-removed ${dupesTrashed} duplicate map(s) to trash`);

          // Older conflict backups duplicated every photo. Convert them in
          // the background after Drive reconciliation, so startup rendering
          // stays fast and the user's existing 60 MB recovery copies shrink
          // automatically after upgrading.
          try {
            const sharedMigration = await migrateLegacyConflictPhotoCopies();
            if (sharedMigration.convertedMaps) renderSidebar();
          } catch (e) {
            console.warn("Recovery photo sharing migration skipped", e);
          }

          // v458: an empty account stays empty. Never auto-create or upload
          // the old "Welcome to Branchline" sample map.
          updateFolderUI();
          updateDriveUI();
          renderSidebar();

          // If there was no local map to preview (fresh browser / maps only
          // existed on Drive), open one as soon as background sync supplies it.
          if (!state.current) {
            let lastId = null;
            try { lastId = localStorage.getItem(LAST_OPENED_MAP_KEY); } catch (e) {}
            const activeList = activeMaps();
            if (activeList.length) {
              const lastStillActive = lastId && activeList.find(m => m.id === lastId);
              await openMap(lastStillActive ? lastId : activeList[0].id);
            }
          } else if (!state.editingId && !unsavedEdits) {
            // DriveDB.restore may have replaced the currently-open map with a
            // newer remote copy. Repaint after the reconciliation is complete.
            renderAll();
          }
        } catch (e) {
          startupLocalPreview = false;
          console.error("Background startup sync failed", e);
          updateDriveUI();
          renderSidebar();
        }
      }, 0);
    });
  }

  $("#btn-connect-folder").addEventListener("click", () => FolderDB.pick());

  // One recovery runner for every Retry/Reconnect button. Disable the tapped
  // button until the attempt settles so a double-tap cannot launch two Drive
  // reads/uploads or two OAuth requests at the same time.
  let driveReconnectClickRunning = false;
  async function runDriveReconnectClick(button) {
    if (driveReconnectClickRunning) return;
    driveReconnectClickRunning = true;
    if (button) button.disabled = true;
    try {
      await DriveDB.reconnectAndResume();
      showToast("✅ Google Drive reconnected");
    } catch (err) {
      console.error("Google Drive reconnect failed", err);
      alert((err && err.message) || "Google Drive reconnect failed.");
    } finally {
      driveReconnectClickRunning = false;
      if (button) button.disabled = false;
      try { updateDriveUI(); } catch (e) {}
    }
  }

  const googleSigninBtn = $("#btn-google-signin");
  googleSigninBtn.addEventListener("click", () => {
    if (DriveDB.needsReauth || DriveDB.driveBroken()) {
      // Auth expiry opens Google; a plain upload failure with a valid token
      // resumes the existing Drive session and already-uploaded photos.
      runDriveReconnectClick(googleSigninBtn);
    } else if (DriveDB.signedIn) {
      DriveDB.signOut();
    } else {
      DriveDB.signIn(false).catch(err => alert(err.message || "Google sign-in failed."));
    }
  });
  const btnDriveLostReconnect = $("#drive-lost-reconnect");
  if (btnDriveLostReconnect) {
    btnDriveLostReconnect.addEventListener("click", () => {
      runDriveReconnectClick(btnDriveLostReconnect);
    });
  }

  const btnSignedOutSignin = $("#btn-signed-out-signin");
  if (btnSignedOutSignin) {
    btnSignedOutSignin.addEventListener("click", () => {
      showToast("Opening Google sign-in…");
      DriveDB.signIn(false).catch(err => {
        const msg = err.message || "Google sign-in failed.";
        showToast(msg);
        const p = signedOutState.querySelector("p");
        if (p) p.textContent = msg;
        alert(msg);
      });
    });
  }
  const btnLocalOnly = $("#btn-local-only");
  if (btnLocalOnly) {
    btnLocalOnly.addEventListener("click", async () => {
      try { localStorage.setItem("branchline_local_only", "1"); } catch (e) {}
      applySignedOutGate();
      renderSidebar();
      const list = activeMaps();
      if (list.length && !state.current) { try { await openMap(list[0].id); } catch (e) {} }
      renderAll();
    });
  }

  // Hide clock/calendar — a one-tap way to get rid of the root node's
  // live clock block and the toolbar's 📅 Calendar button, for anyone who
  // doesn't want them cluttering the map. Saved on the map itself
  // (map.clockHidden — see ensureClockHidden) so the toggle only affects
  // whichever mindmap it was set on; other maps are unaffected. Defaults
  // to hidden for maps that have never had it touched.
  function isClockHidden() {
    return !state.current || state.current.clockHidden !== false;
  }
  function setClockHidden(hidden) {
    if (!state.current) return;
    state.current.clockHidden = hidden;
    persist();
    document.getElementById("app").classList.toggle("hide-clock-widgets", hidden);
    // Rebuilds every node so the root node picks up (or drops) the extra
    // width/height it reserves for the clock block — see computeNodeBox.
    renderAll();
  }

  // Sidebar hide/show — a fixed 260px sidebar eats a lot of screen and
  // isn't resizable, so this gives a one-tap way to get it out of the
  // way (rather than something to drag, which doesn't work well with
  // touch scrolling gestures anyway). Remembered across reloads; hidden
  // by default the very first time, on any screen size, so the map gets
  // full width until you actually ask for the sidebar.
  const SIDEBAR_HIDDEN_KEY = "branchline_sidebar_hidden";
  function setSidebarHidden(hidden) {
    document.getElementById("app").classList.toggle("sidebar-hidden", hidden);
    try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? "1" : "0"); } catch (e) {}
    // Sidebar width changes the map viewport without necessarily firing a
    // window resize event. Reconcile after CSS layout settles so newly exposed
    // canvas space is populated immediately.
    requestAnimationFrame(() => scheduleVirtualViewportRefresh(true));
  }
  (function initSidebarToggle() {
    let hidden;
    try {
      const saved = localStorage.getItem(SIDEBAR_HIDDEN_KEY);
      hidden = saved === null ? true : saved === "1";
    } catch (e) { hidden = true; }
    setSidebarHidden(hidden);
    $("#btn-toggle-sidebar").addEventListener("click", () => {
      setSidebarHidden(!document.getElementById("app").classList.contains("sidebar-hidden"));
    });
  })();

  // Keeps the floating add-child/add-sibling buttons above the on-screen
  // keyboard on touch devices. Opening the keyboard shrinks the visual
  // viewport without necessarily resizing the page layout, so anything
  // pinned to the bottom of the screen (like #node-fabs) would otherwise
  // end up hidden underneath it while you're mid-edit on a node — right
  // when you're most likely to want to tap "add branch". The formula
  // works whether or not the browser also resizes the layout viewport:
  // if it does, vv.height already accounts for the keyboard and the
  // inset comes out ~0, so this is a no-op there.
  (function initKeyboardInset() {
    const vv = window.visualViewport;
    if (!vv) return;
    function update() {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--keyboard-inset", inset + "px");
    }
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
  })();

  boot();

