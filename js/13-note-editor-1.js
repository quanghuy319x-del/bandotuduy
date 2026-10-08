/* Branchline — js/13-note-editor-1.js
   Part 13 of 19 of the former single-file app.js. Contents: note editor.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- note editor ---------------- */

  const noteModal = $("#note-modal");
  const noteTextarea = $("#note-textarea");

  const noteTitleInput = $("#note-title-input");
  const noteCard = $(".note-modal-card");
  const noteResizeHandle = $("#note-resize-handle");
  const noteLineCountEl = $("#note-line-count");
  let noteEditingId = null;
  // When set, the editor is scoped to one photo on noteEditingId's node
  // (its notes live in node.photoNotes[photoId] — see getPhotoNotes)
  // instead of the node's own `notes` array. Everything else about the
  // editor — the rich text, title, paging, add/delete — behaves
  // identically either way; only load/save need to know which.
  let noteEditingPhotoId = null;
  // Same idea, but scoped to one task on the node instead (its notes
  // live in that task's own `notes` array — see getTaskNotes). Mutually
  // exclusive with noteEditingPhotoId; at most one of the two is set.
  let noteEditingTaskId = null;
  // When set alongside noteEditingTaskId, the editor is scoped to one
  // *subtask* of that task instead (its notes live in the subtask's own
  // `notes` array, same shape as a task's — see getTaskNotes).
  let noteEditingSubtaskId = null;
  // Same idea again, but scoped to one table cell on the node instead
  // (its notes live in that cell's attach record — see getCellNotes).
  // {r, c}, or null. Mutually exclusive with the photo/task cases above —
  // at most one of the three is ever set.
  let noteEditingCellPos = null;
  let noteSaveTimer = null;
  let noteLinkifyTimer = null;
  // Phase-1 performance: editing a rich note is one logical map edit session.
  // While the editor stays open, autosave writes the changed note to the map/
  // IndexedDB but does NOT rebuild the entire canvas after every typing pause.
  // One map-level undo snapshot is captured before the first mutation, and one
  // full canvas refresh is deferred until the editor closes.
  let noteMapUndoCaptured = false;
  let noteMapVisualDirty = false;
  let noteIsResizing = false;
  // Android/phone contenteditable is particularly sensitive to full-DOM
  // serialization and command-state queries while the IME is composing.
  // Keep those operations off the keystroke hot path on narrow touch UIs.
  const notePhonePerfMode = () => window.matchMedia("(max-width: 640px) and (any-pointer: coarse)").matches;
  // A node can now hold several notes. While the modal is open,
  // noteWorkingList holds an editable in-memory copy of that node's notes
  // ({id, title, html} each) and noteActiveIndex is which one is in the
  // editor right now. Nothing here is written back to the node itself
  // until commitNotesToNode() runs (autosave, navigating away, or closing).
  let noteWorkingList = [];
  let noteActiveIndex = 0;
  const noteNavAdd = $("#note-nav-add");
  const noteNavBack = $("#note-nav-back");
  let noteReturn = null; // where ← Back goes — see withViewerReturn
  const noteNavFavorite = $("#note-nav-favorite");
  const noteNavFolder = $("#note-nav-folder");
  const noteNavInfo = $("#note-nav-info");
  const noteNavDelete = $("#note-nav-delete");
  const noteNavRow = noteModal.querySelector(".note-nav-row");
  const noteNavGap = noteNavRow && noteNavRow.querySelector(".note-nav-gap");

  // v444: immediate crash/F5 safety for Note/DRC typing. The canonical map
  // and Drive save remain debounced for phone performance, but every editor
  // mutation also writes one small local recovery record synchronously.
  // Only one Note editor can be open at a time, so a single rolling record is
  // enough. It is restored only when it is newer than the canonical note.
  const NOTE_CRASH_DRAFT_KEY = "branchline_note_crash_draft_v1";

  function noteCrashDraftContext() {
    return {
      mapId: state.current && state.current.id || null,
      nodeId: noteEditingId || null,
      photoId: noteEditingPhotoId || null,
      taskId: noteEditingTaskId || null,
      subtaskId: noteEditingSubtaskId || null,
      r: noteEditingCellPos && noteEditingCellPos.r != null ? noteEditingCellPos.r : null,
      c: noteEditingCellPos && noteEditingCellPos.c != null ? noteEditingCellPos.c : null
    };
  }

  function noteCrashDraftMatchesContext(draft) {
    if (!draft) return false;
    const ctx = noteCrashDraftContext();
    return draft.mapId === ctx.mapId &&
      draft.nodeId === ctx.nodeId &&
      (draft.photoId || null) === ctx.photoId &&
      (draft.taskId || null) === ctx.taskId &&
      (draft.subtaskId || null) === ctx.subtaskId &&
      (draft.r == null ? null : Number(draft.r)) === ctx.r &&
      (draft.c == null ? null : Number(draft.c)) === ctx.c;
  }

  function saveNoteCrashDraftNow() {
    if (!noteEditingId || noteModal.classList.contains("hidden")) return;
    const current = noteWorkingList[noteActiveIndex];
    if (!current) return;
    try {
      const node = findNode(noteEditingId);
      const taskHost = noteEditingCellPos && node
        ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c)
        : node;
      const subtaskOwner = noteEditingSubtaskId ? noteEditingNoteOwner(taskHost) : null;
      const title = noteEditingSubtaskId
        ? (((subtaskOwner && subtaskOwner.text) || "").trim())
        : noteTitleInput.value;
      const html = stripNotePhotoSrcForStorage(
        noteTextarea.classList.contains("drc-cards")
          ? drcStripCardMarkup(noteTextarea.innerHTML)
          : noteTextarea.innerHTML
      );
      const ctx = noteCrashDraftContext();
      localStorage.setItem(NOTE_CRASH_DRAFT_KEY, JSON.stringify({
        v: 1,
        ...ctx,
        noteId: current.id || null,
        title,
        html,
        createdAt: current.createdAt || Date.now(),
        savedAt: Date.now()
      }));
    } catch (e) {
      // Recovery journaling is best-effort; normal autosave still runs.
    }
  }

  function restoreNoteCrashDraftIfNewer() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(NOTE_CRASH_DRAFT_KEY) || "null"); }
    catch (e) { draft = null; }
    if (!noteCrashDraftMatchesContext(draft) || !draft.savedAt) return false;

    let idx = draft.noteId
      ? noteWorkingList.findIndex(n => n.id === draft.noteId)
      : -1;

    if (idx >= 0) {
      const current = noteWorkingList[idx];
      const canonicalTs = Math.max(Number(current.updatedAt) || 0, Number(current.createdAt) || 0);
      if (Number(draft.savedAt) <= canonicalTs) return false;
      current.title = draft.title || "";
      current.html = draft.html || "";
      current.updatedAt = Number(draft.savedAt) || Date.now();
      if (!current.createdAt) current.createdAt = Number(draft.createdAt) || current.updatedAt;
    } else {
      // Covers a crash immediately after starting a brand-new note, before
      // the 900ms canonical autosave had time to create its marker/list entry.
      if (!(draft.title && String(draft.title).trim()) && !(draft.html && String(draft.html).trim())) return false;
      noteWorkingList.push({
        id: draft.noteId || uid(),
        title: draft.title || "",
        html: draft.html || "",
        createdAt: Number(draft.createdAt) || Number(draft.savedAt) || Date.now(),
        updatedAt: Number(draft.savedAt) || Date.now()
      });
      idx = noteWorkingList.length - 1;
    }

    noteActiveIndex = idx;
    try { showToast("Recovered unsaved note typing"); } catch (e) {}
    return true;
  }

  // ---- Note editor undo/redo ----
  // Kept separate from the map-level undo/redo (pushUndo/undo, for
  // structural changes to nodes) since this is a much finer-grained,
  // nested kind of edit history that only applies while the note editor
  // is focused. It's custom rather than relying on the browser's native
  // contenteditable undo because several toolbar actions here (numbered
  // list, checklist, strikethrough, image insert) mutate the DOM directly
  // (el.textContent = ..., insertBefore, etc.) instead of going through
  // execCommand, which resets/breaks the native undo history — so without
  // this, undo would silently stop working the moment any toolbar button
  // was used. Snapshots are just the editor's full innerHTML; simple and
  // plenty robust for a field this size.
  const NOTE_UNDO_LIMIT = 100;
  let noteUndoStack = [];
  let noteRedoStack = [];
  let noteLastPushAt = 0;
  const noteUndoBtn = $("#note-tool-undo");
  const noteRedoBtn = $("#note-tool-redo");

  function updateNoteUndoButtons() {
    if (noteUndoBtn) noteUndoBtn.disabled = !noteUndoStack.length;
    if (noteRedoBtn) noteRedoBtn.disabled = !noteRedoStack.length;
  }

  // Records the editor's current state onto the undo stack. Call this
  // immediately BEFORE a mutation (toolbar click, image insert, paste,
  // Enter-to-continue-list), not after.
  //
  // Images pasted/dropped into a note are embedded as full-resolution,
  // un-downscaled base64 <img> tags directly in this same innerHTML (see
  // noteHandleImageFiles) — so once a note has even one screenshot in
  // it, EVERY subsequent edit anywhere in that note (not just to the
  // image) re-clones that image's full bytes into a new snapshot here.
  // At a 100-entry cap with no size limit, a note with a couple of
  // pasted screenshots could balloon into hundreds of MB of undo history
  // from perfectly ordinary typing — the same class of bug already fixed
  // for the map-level undo/redo stacks (see pushBoundedSnapshot), just
  // reused here since notes are the other place large embedded images
  // live.
  function notePushUndo() {
    pushBoundedSnapshot(noteUndoStack, noteTextarea.innerHTML, NOTE_UNDO_LIMIT);
    noteRedoStack = [];
    noteLastPushAt = Date.now();
    updateNoteUndoButtons();
  }

  // Clears the history — called whenever a different note (or a
  // different one of a node's several notes) is loaded into the shared
  // editor, so undo never reaches back into a note that's no longer open.
  function noteResetUndoHistory() {
    noteUndoStack = [];
    noteRedoStack = [];
    noteLastPushAt = 0;
    updateNoteUndoButtons();
    noteTextStyleMode = "n";
    noteUppercasePending = false;
    updateNoteToolActiveStates();
  }

  // --- Bold / AA "pressed while it applies to what you type next" state ---
  //
  // Bold piggybacks on the browser's own contenteditable behavior: calling
  // execCommand("bold") with a collapsed caret (no selection) doesn't touch
  // any existing text — it just flips the style that new text will be
  // typed in, same as Word/Docs. document.queryCommandState("bold") then
  // tells us whether that's currently "on", so the toolbar button can show
  // pressed exactly when it applies.
  //
  // AA (uppercase) has no native browser equivalent, so noteUppercasePending
  // recreates the same idea by hand: toggling it on with a collapsed caret
  // doesn't uppercase anything yet, it just arms a beforeinput hook (below)
  // that uppercases each character as it's typed, until toggled off or the
  // caret is moved by a click.
  let noteUppercasePending = false;
  let noteUppercaseInserting = false; // re-entrancy guard for the hook below
  // v633: authoritative format for the NEXT typed character. Browser
  // selectionchange/queryCommandState is not allowed to overwrite this just
  // because typing advanced the collapsed caret.
  let noteTextStyleMode = "n";

  // v635: N / F / B / BB are completely independent from text color.
  // F is stored as its own semantic wrapper and rendered with opacity only.
  // Never use foreColor to implement or clear these four text modes.
  const NOTE_FADE_SELECTOR = '[data-note-fade="1"], .note-fade-text';

  function noteFadeElementForNode(node, editor = noteTextarea) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el && el !== editor) {
      if (el.matches?.(NOTE_FADE_SELECTOR)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function noteCurrentFadeOn() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !noteTextarea.contains(sel.anchorNode)) return false;
    return !!noteFadeElementForNode(sel.anchorNode, noteTextarea);
  }

  function noteMigrateLegacyFadeMarkup(root = noteTextarea) {
    if (!root) return false;
    let changed = false;
    root.querySelectorAll('[data-note-fade="1"], .note-fade-text').forEach((el) => {
      if (!el.classList.contains("note-fade-text")) {
        el.classList.add("note-fade-text");
        changed = true;
      }
      if (el.getAttribute("data-note-fade") !== "1") {
        el.setAttribute("data-note-fade", "1");
        changed = true;
      }
      // v631-v634 stored F by forcing this gray text color. Remove only that
      // known legacy F color so F no longer owns color at all.
      const inlineColor = String(el.style?.color || "").replace(/\s+/g, "").toLowerCase();
      if (inlineColor === "rgb(154,150,140)" || inlineColor === "#9a968c") {
        el.style.removeProperty("color");
        if (!el.getAttribute("style")) el.removeAttribute("style");
        changed = true;
      }
    });
    return changed;
  }

  function noteDetectTextStyleAtCaret() {
    let boldOn = false;
    try { boldOn = document.queryCommandState("bold"); } catch (_) {}

    const sel = window.getSelection();
    let sample = sel && !sel.isCollapsed ? sel.toString() : "";
    if (!sample && sel && sel.anchorNode && sel.anchorNode.nodeType === Node.TEXT_NODE) {
      const text = sel.anchorNode.data || "";
      const at = Math.max(0, Math.min(sel.anchorOffset, text.length));
      const left = text.slice(0, at).match(/[\p{L}\p{N}]+$/u)?.[0] || "";
      const right = text.slice(at).match(/^[\p{L}\p{N}]+/u)?.[0] || "";
      sample = left + right;
    }
    const letters = sample.replace(/[^\p{L}]+/gu, "");
    const uppercaseHere = !!letters && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    if (boldOn && uppercaseHere) return "bb";
    if (boldOn) return "b";
    if (noteCurrentFadeOn()) return "f";
    return "n";
  }

  function syncNoteTextStyleFromCaret() {
    noteTextStyleMode = noteDetectTextStyleAtCaret();
    noteUppercasePending = noteTextStyleMode === "bb";
    updateNoteToolActiveStates();
  }
  window.__branchlineSyncNoteTextStyleFromCaret = syncNoteTextStyleFromCaret;

  function updateNoteToolActiveStates() {
    let boldOn = false;
    let strikeOn = false;
    try {
      boldOn = document.queryCommandState("bold");
      strikeOn = document.queryCommandState("strikeThrough");
    } catch (_) { /* ignore */ }

    const line = noteCurrentLine();
    const lineText = line ? (line.textContent || "") : "";
    const orderedOn = /^\d+\.\s/.test(lineText);
    const checklistOn = /^[☐☑]\s/.test(lineText);

    const mode = noteTextStyleMode;

    const normalBtn = $("#note-tool-normal");
    const fadeBtn = $("#note-tool-fade");
    const boldBtn = $("#note-tool-bold");
    const noteBoldUpperBtn = $("#note-tool-bold-upper");
    [[normalBtn, "n"], [fadeBtn, "f"], [boldBtn, "b"], [noteBoldUpperBtn, "bb"]].forEach(([btn, key]) => {
      if (!btn) return;
      const on = mode === key;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    $("#note-tool-strike").classList.toggle("active", !!strikeOn);
    $("#note-tool-ol").classList.toggle("active", orderedOn);
    $("#note-tool-check").classList.toggle("active", checklistOn);
  }

  function noteRestoreSnapshot(html) {
    noteTextarea.innerHTML = html;
    refreshDRCCards();
    noteSyncAllCheckedLines();
    noteSyncAllOrderedColors();
    noteAutoColorParagraphs();
    placeCaretAtEnd(noteTextarea);
    scheduleNoteAutosave();
    updateNoteUndoButtons();
  }

  function noteUndo() {
    if (!noteUndoStack.length) return;
    pushBoundedSnapshot(noteRedoStack, noteTextarea.innerHTML, NOTE_UNDO_LIMIT);
    noteRestoreSnapshot(noteUndoStack.pop());
  }

  function noteRedo() {
    if (!noteRedoStack.length) return;
    pushBoundedSnapshot(noteUndoStack, noteTextarea.innerHTML, NOTE_UNDO_LIMIT);
    noteRestoreSnapshot(noteRedoStack.pop());
  }

  // Custom resize grip: dragging it changes both the note card's width and
  // height (a plain CSS `resize` on the textarea only ever does one axis
  // for a contenteditable, so this drives it by hand instead).
  (function setupNoteResize() {
    let startX, startY, startW, startH;

    function onMove(e) {
      const dw = e.clientX - startX;
      const dh = e.clientY - startY;
      const maxW = window.innerWidth * 0.96;
      const maxH = window.innerHeight * 0.92;
      noteCard.style.width = clamp(startW + dw, 420, maxW) + "px";
      noteCard.style.height = clamp(startH + dh, 320, maxH) + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      // A drag that ends past the card's edge fires a "click" on the modal
      // backdrop right after this mouseup — defer clearing the flag so
      // that click (which runs synchronously, before this timeout) still
      // sees the drag as in progress and doesn't close the note.
      setTimeout(() => { noteIsResizing = false; }, 0);
    }
    function onResizeStart(e) {
      e.preventDefault();
      e.stopPropagation();
      noteIsResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = noteCard.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      document.body.style.userSelect = "none"; // avoid selecting page text while dragging
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
    noteResizeHandle.addEventListener("mousedown", onResizeStart);
    noteResizeHandle.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      onResizeStart(e);
    });
  })();


  function escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function looksLikeHtml(s) {
    return /<[a-z][\s\S]*>/i.test(s || "");
  }

  // Old notes were stored as plain text with real newlines. New notes are
  // stored as HTML (one <div> per line, matching how Chrome/Edge structure
  // contenteditable content). This converts old plain-text notes on first
  // load so they still display correctly in the rich editor.
  function noteHtmlFromRaw(raw) {
    if (!raw) return "";
    if (looksLikeHtml(raw)) return raw;
    return raw.split(/\n/).map(line => `<div>${escapeHtml(line) || "<br>"}</div>`).join("");
  }

  // ---- Clickable links inside notes -----------------------------------
  // Notes are rich contenteditable HTML, so URL recognition works on text
  // nodes only: existing formatting, checklist prefixes, cards and photos
  // stay untouched. We recognize http(s):// links, www.* links and normal
  // bare domains (example.com/path). Auto-created anchors are saved as part
  // of the note, so they stay clickable after reopening/exporting/syncing.
  const NOTE_URL_RE = /(^|[\s([{])((?:https?:\/\/|www\.)[^\s<>"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:[\/?#][^\s<>"']*)?)/gi;

  function trimNoteUrlPunctuation(raw) {
    let url = raw || "";
    let suffix = "";
    // Sentence punctuation is almost never part of the URL. Closing
    // brackets are kept only when they have a matching opener in the URL
    // (e.g. a Wikipedia title containing parentheses).
    while (/[.,!?;:]$/.test(url)) { suffix = url.slice(-1) + suffix; url = url.slice(0, -1); }
    const pairs = [[")", "("], ["]", "["], ["}", "{"]];
    let changed = true;
    while (changed && url) {
      changed = false;
      for (const [close, open] of pairs) {
        if (!url.endsWith(close)) continue;
        const opens = url.split(open).length - 1;
        const closes = url.split(close).length - 1;
        if (closes > opens) { suffix = close + suffix; url = url.slice(0, -1); changed = true; }
      }
    }
    return { url, suffix };
  }

  function noteHrefForText(text) {
    let candidate = (text || "").trim();
    if (!candidate || /\s/.test(candidate)) return null;
    if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  // For an <a> pasted from rich text, trust only ordinary web protocols.
  // Relative hrefs are allowed and resolve against this app's own page;
  // javascript:, data:, file:, etc. never open from a note click.
  function noteSafeAnchorHref(raw) {
    const candidate = (raw || "").trim();
    if (!candidate) return null;
    try {
      const parsed = new URL(candidate, window.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  function unwrapNoteLink(a) {
    const parent = a && a.parentNode;
    if (!parent) return;
    while (a.firstChild) parent.insertBefore(a.firstChild, a);
    a.remove();
    parent.normalize();
  }

  function refreshAutoNoteLinks(root) {
    let changed = false;
    root.querySelectorAll("a.note-auto-link").forEach((a) => {
      const text = a.textContent || "";
      const href = noteHrefForText(text);
      if (!href) { unwrapNoteLink(a); changed = true; return; }
      if (a.getAttribute("href") !== href) { a.setAttribute("href", href); changed = true; }
      if (a.getAttribute("target") !== "_blank") { a.setAttribute("target", "_blank"); changed = true; }
      if (a.getAttribute("rel") !== "noopener noreferrer") { a.setAttribute("rel", "noopener noreferrer"); changed = true; }
      a.title = "Open link";
    });
    return changed;
  }

  function noteLinkifyUrls(root, preserveCaret) {
    if (!root) return false;
    let marker = null;
    const sel = window.getSelection();
    // Do not rewrite DOM under an active text selection — that would throw
    // the selection away. A later input/paste/open will retry linkifying.
    if (preserveCaret && sel && sel.rangeCount && root.contains(sel.anchorNode) && !sel.isCollapsed) return false;
    if (preserveCaret && sel && sel.rangeCount && sel.isCollapsed && root.contains(sel.anchorNode)) {
      marker = document.createComment("note-caret");
      const caret = sel.getRangeAt(0).cloneRange();
      caret.insertNode(marker);
    }

    let changed = refreshAutoNoteLinks(root);
    const textNodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest("a") || parent.closest('[contenteditable="false"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach((node) => {
      const text = node.nodeValue || "";
      NOTE_URL_RE.lastIndex = 0;
      let match;
      let last = 0;
      let frag = null;
      while ((match = NOTE_URL_RE.exec(text))) {
        const prefix = match[1] || "";
        const raw = match[2] || "";
        const start = match.index + prefix.length;
        const trimmed = trimNoteUrlPunctuation(raw);
        const href = noteHrefForText(trimmed.url);
        if (!href || !trimmed.url) continue;
        if (!frag) frag = document.createDocumentFragment();
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const a = document.createElement("a");
        a.className = "note-auto-link";
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = "Open link";
        a.textContent = trimmed.url;
        frag.appendChild(a);
        if (trimmed.suffix) frag.appendChild(document.createTextNode(trimmed.suffix));
        last = start + raw.length;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.replaceWith(frag);
        changed = true;
      }
    });

    if (marker && marker.parentNode) {
      const range = document.createRange();
      range.setStartBefore(marker);
      range.collapse(true);
      marker.remove();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return changed;
  }

  // A note's stored HTML never carries an inline photo's actual src — an
  // <img data-photo-id="…"> with no src (see stripNotePhotoSrcForStorage
  // below) — so the moment it's loaded into the live, editable DOM, every
  // such tag needs its src filled back in from PhotoDB (see photoUrl).
  // Also self-heals notes saved by an older build, or just brought in
  // from Drive/a folder/import (see ensurePhotosMigrated/
  // inlinePhotosForPortableCopy), which can still have a raw `data:` src
  // and no data-photo-id yet: those get moved into PhotoDB right here too
  // — via the exact same dedup'd addPhotoRecord every fresh paste already
  // goes through — so an old note full of repeated screenshots shrinks
  // the moment it's opened, same spirit as noteDownscaleOversizedImagesInEditor
  // below. Returns whether anything changed, so the caller knows whether
  // the now-smaller HTML needs to be autosaved back onto the node.
  function hydrateNotePhotoImages(container = noteTextarea) {
    let migrated = false;
    Array.from(container.querySelectorAll("img")).forEach((img) => {
      const id = img.dataset.photoId;
      if (id) {
        img.src = photoUrl(id);
        return;
      }
      const src = img.getAttribute("src") || "";
      if (src.startsWith("data:")) {
        const newId = addPhotoRecord(src);
        img.dataset.photoId = newId;
        img.src = photoUrl(newId);
        migrated = true;
      }
    });
    return migrated;
  }

  // The inverse, run just before a note's live DOM is read back into
  // storage (see captureActiveNote) — strips every inline photo's src
  // (a tab-local blob: object URL, meaningless the moment this tab
  // closes — see loadPhotoCacheForMap) back down to just its
  // data-photo-id reference, so the note's stored HTML stays a small
  // string no matter how many/how large its photos are.
  function stripNotePhotoSrcForStorage(html) {
    if (!html || html.indexOf("data-photo-id") === -1) return html;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("img[data-photo-id]").forEach((img) => img.removeAttribute("src"));
    return tmp.innerHTML;
  }

  // Same conversion as noteHtmlFromRaw, but bolds each non-blank line —
  // used only for a fresh DRC note's starting content, so the template's
  // section headers (📊 OVERVIEW, ✅ GOOD, ❌ BAD, 🔄 CHANGE FROM TOMORROW,
  // 📈 TRADES IN DETAILS — the only non-blank lines the template has by
  // convention) land bold from the start instead of plain text. Blank
  // separator lines between them are left alone.
  function noteHtmlFromDRCTemplate(raw) {
    if (!raw) return "";
    if (looksLikeHtml(raw)) return raw;
    return raw.split(/\n/).map(line => {
      const escaped = escapeHtml(line);
      if (!escaped) return "<div><br></div>";
      return `<div><b>${escaped}</b></div>`;
    }).join("");
  }

  // Keeps a line's strikethrough in sync with its checklist glyph: struck
  // when it starts with the checked box (☑), plain otherwise. `el` is
  // whatever noteToggleLinePrefix / the glyph-click handler already treated
  // as "the line" — normally a line <div>, but occasionally noteTextarea
  // itself for the very first line of a brand-new note (see
  // noteCurrentLine/noteToggleLinePrefix).
  function noteSyncLineChecked(el) {
    if (!el) return;
    el.classList.toggle("note-line-checked", /^☑(\s|$)/.test(el.textContent || ""));
  }

  // Re-applies that per-line strikethrough across every line, for notes
  // loaded from storage that may already contain checked items.
  function noteSyncAllCheckedLines() {
    noteSyncLineChecked(noteTextarea);
    Array.from(noteTextarea.children).forEach(noteSyncLineChecked);
  }

  // Standing template for a "DRC" (Daily Report Card) note — see
  // openNoteModal below, which drops this into a fresh DRC note (and into
  // the first note of a task/subtask named "DRC") instead of a blank
  // editor.
  //
  // It is simply the saved *note template* named "DRC" (the 📋 button in
  // the note editor — see saveNoteAsTemplate/findNoteTemplateByName): write
  // a DRC note the way you want new ones to start (section headings, and
  // recolor each card from the ring at its right edge), save it as a
  // template called "DRC", and every new DRC note starts from it. Each
  // non-blank line of that template is a section heading. Until a "DRC"
  // template has been saved, notes start from the older standalone
  // template (if this browser had customized one) or the built-in default.
  const DRC_TEMPLATE_KEY = "branchlineDRCTemplateSections_v1"; // legacy: read-only fallback
  const DEFAULT_DRC_TEMPLATE_TEXT =
    "📊 OVERVIEW\n\n✅ GOOD\n\n❌ BAD\n\n🔄 CHANGE FROM TOMORROW\n\n📈 TRADES IN DETAILS\n";

  function getDRCTemplateText() {
    const tpl = findNoteTemplateByName("DRC");
    if (tpl && (tpl.html || "").trim()) return tpl.html;
    const raw = localStorage.getItem(DRC_TEMPLATE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // Oldest format: a JSON array of section labels.
        if (Array.isArray(parsed) && parsed.length) return parsed.join("\n\n") + "\n";
      } catch (e) {}
      return raw;
    }
    return DEFAULT_DRC_TEMPLATE_TEXT;
  }

  // The template's own lines — excluded when checking how much the person
  // has actually typed into a DRC note (see drcNoteIsFilled below), so an
  // untouched template doesn't itself count as "filled".
  function drcTemplateLines() {
    const raw = getDRCTemplateText();
    if (looksLikeHtml(raw)) return noteLinesFromHtml(raw).map(l => l.trim()).filter(Boolean);
    return raw.split("\n").map(l => l.trim()).filter(Boolean);
  }

  // The task — or, when noteEditingSubtaskId is set, the subtask of that
  // task — whose `notes` the editor is currently reading/writing.
  function noteEditingNoteOwner(taskHost) {
    const t = taskHost && getNodeTasks(taskHost).find(x => x.id === noteEditingTaskId);
    if (t && noteEditingSubtaskId) return getTaskSubtasks(t).find(x => x.id === noteEditingSubtaskId) || null;
    return t || null;
  }

  // Opens the note editor for a node, or (with `photoId`) for one photo
  // on that node, or (with `taskId`) for one task on that node, or (with
  // `cellPos`, {r, c}) for one table cell on that node instead — same
  // editor in all four cases, just a different backing list (see
  // noteEditingPhotoId/noteEditingTaskId/noteEditingCellPos above).
  // `index` picks which existing note to show: omit it to land on the
  // last (most recently added) one, or pass notes.length (or any
  // out-of-range index) to start a brand-new blank note instead of an
  // existing one.
  function openNoteModal(nodeId, index, photoId, taskId, cellPos, forceDRCTemplate, subtaskId) {
    const node = findNode(nodeId);
    if (!node) return;
    const freshNoteSession = noteModal.classList.contains("hidden");
    if (freshNoteSession) {
      noteMapUndoCaptured = false;
      noteMapVisualDirty = false;
    }
    commitEditIfActive();
    // Where ← Back should go. A return point handed over by a browser wins;
    // otherwise, if this is a fresh open (not a jump between notes while the
    // editor is already up), fall back to whichever modal is sitting
    // underneath (Tasks/Calendar) or to the map.
    const pendingRet = takeViewerReturn();
    if (pendingRet) noteReturn = pendingRet;
    else if (noteModal.classList.contains("hidden")) noteReturn = underlyingModalReturn();
    noteNavBack.title = viewerBackTitle(noteReturn);
    noteNavBack.setAttribute("aria-label", noteNavBack.title);
    // A task — or now a subtask — literally named "DRC" shares the exact
    // same single per-node DRC note as the right-click "📋 DRC…" shortcut
    // below, instead of owning a separate note of its own — otherwise a
    // node could end up showing multiple DRC clipboard icons at once (one
    // from the node's own notes, one from this task/subtask). Only
    // redirect on a genuinely fresh click (this task/subtask doesn't have
    // a note of its own yet); one that already has previously-written
    // note content of its own keeps opening that note untouched, so
    // nothing existing gets silently orphaned.
    if (taskId) {
      const taskHostForRedirect = cellPos ? getCellAttach(node, cellPos.r, cellPos.c) : node;
      const parentTaskForRedirect = getNodeTasks(taskHostForRedirect).find(x => x.id === taskId);
      const drcOwner = subtaskId
        ? (parentTaskForRedirect ? getTaskSubtasks(parentTaskForRedirect).find(x => x.id === subtaskId) : null)
        : parentTaskForRedirect;
      if (drcOwner && (drcOwner.text || "").trim().toUpperCase() === "DRC" && !getTaskNotes(drcOwner).length) {
        taskId = null;
        subtaskId = null;
        // v417: A task/subtask named DRC inside a table/calendar cell
        // redirects to that cell's own DRC. Keep cellPos so it does not
        // accidentally jump to the parent node's DRC.
        photoId = null;
        forceDRCTemplate = true;
      }
    }
    noteEditingId = nodeId;
    noteEditingPhotoId = photoId || null;
    noteEditingTaskId = taskId || null;
    noteEditingSubtaskId = (taskId && subtaskId) || null;
    noteEditingCellPos = cellPos || null;
    // A task's own notes take priority over the cellPos check below even
    // when both are set — that combination means "a task living inside
    // this cell's task list" (see the Tasks modal's note button, opened
    // with both a taskId and this cell's {r, c}), not a plain cell note.
    // cellPos still gets used to resolve which task list to search.
    const taskHost = noteEditingCellPos ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c) : node;
    const existing = noteEditingTaskId
      ? getTaskNotes(noteEditingNoteOwner(taskHost))
      : noteEditingCellPos
      ? getCellNotes(getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c))
      : (noteEditingPhotoId ? getPhotoNotes(node, noteEditingPhotoId) : getNodeNotes(node));
    noteWorkingList = existing.map(n => ({ id: n.id || uid(), title: n.title || "", html: n.html, kind: n.kind || null, favorite: !!n.favorite, createdAt: n.createdAt, updatedAt: n.updatedAt }));
    // Subtask-owned notes always use the subtask name as their title.
    // This also self-heals older notes that had a blank/custom title.
    if (noteEditingSubtaskId) {
      const subtaskOwner = noteEditingNoteOwner(taskHost);
      const subtaskTitle = (subtaskOwner && subtaskOwner.text || "").trim();
      noteWorkingList.forEach((n) => { n.title = subtaskTitle; });
    }
    // The "DRC" context-menu shortcut (see the Tasks/Timer/Brainstorm
    // group below). Only one DRC note is allowed per node: if one
    // already exists among this node's notes (title "DRC" — see
    // isDRCNote), just jump to it instead of starting another; only when
    // there isn't one yet does this start a brand-new note pre-filled
    // with the template. Titling it "DRC" is what makes isDRCNote/
    // drcPoints/the node-strip icon recognize it — not a separate
    // internal flag — so a note gets the same treatment if the title is
    // set to "DRC" any other way too.
    if (forceDRCTemplate) {
      const existingDRCIndex = noteWorkingList.findIndex(n => isDRCNote(n));
      if (existingDRCIndex >= 0) {
        noteActiveIndex = existingDRCIndex;
      } else {
        noteWorkingList.push({ id: uid(), title: specialNoteAutoTitle(node, noteEditingCellPos, "DRC"), html: noteHtmlFromDRCTemplate(getDRCTemplateText()), kind: "drc", createdAt: Date.now(), updatedAt: Date.now() });
        noteActiveIndex = noteWorkingList.length - 1;
      }
    } else {
      const wantsNew = index != null && index >= noteWorkingList.length;
      if (!noteWorkingList.length || wantsNew) {
        // A task/subtask named "plan" with no note yet starts from the
        // "Plan" note template (if one is saved) instead of a blank note.
        // v615: Review Backtest / Take 1 trade subtasks use the same first-note
        // template behavior, but each keeps its own per-subtask note.
        const noteOwner = noteEditingNoteOwner(taskHost);
        const planSeed = (noteEditingTaskId && !noteWorkingList.length)
          ? planTemplateSeedFor(noteOwner) : null;
        const specialSubtaskSeed = (noteEditingSubtaskId && !noteWorkingList.length)
          ? specialSubtaskTemplateSeedFor(noteOwner) : null;
        const templateSeed = planSeed || specialSubtaskSeed;
        const isCalendarCellNote = !!(noteEditingCellPos && !noteEditingTaskId &&
          node.table && node.table.calendar);
        const ownerTitle = noteEditingSubtaskId
          ? ((noteOwner && noteOwner.text) || "").trim()
          : (planSeed ? planSeed.title
            : (isCalendarCellNote ? contentHostAutoTitleBase(node, noteEditingCellPos) : ""));
        // v549: a normal Note created from a Calendar date keeps the same
        // date-based auto-name logic already used by Calendar Brainstorm/DRC
        // (e.g. "6/10"). Existing/custom titles remain untouched.
        noteWorkingList.push({ id: uid(), title: ownerTitle, html: templateSeed ? templateSeed.html : "", createdAt: Date.now(), updatedAt: Date.now() });
      }
      noteActiveIndex = wantsNew ? noteWorkingList.length - 1
        : clamp(index == null ? noteWorkingList.length - 1 : index, 0, noteWorkingList.length - 1);
    }
    restoreNoteCrashDraftIfNewer();
    loadNoteIntoEditor();
    // A photo's note is really a caption/comment on that photo, viewed
    // right after (or over) the photo itself, so it benefits from more
    // horizontal room than a regular node/task/cell note — give it 2x the
    // default width. Reset back to the normal width for every other note
    // type so a previous photo-note session doesn't leak into them.
    noteCard.style.width = noteEditingPhotoId ? "1520px" : "";
    // v457: opening state is owned by the single shared top-row controller.
    zoomModalOpen(noteModal);
    const current = noteWorkingList[noteActiveIndex];
    const isBlank = !(current.title && current.title.trim()) && !(current.html && current.html.trim());
    // Phone: open Note/DRC without focusing an editor field so the
    // on-screen keyboard stays closed until the user taps where to type.
    if (!window.matchMedia("(max-width: 640px)").matches) {
      requestAnimationFrame(() => { (isBlank ? noteTitleInput : noteTextarea).focus(); });
    }
  }

  // Simple "Lines: N" readout in the editor's corner — counts actual
  // line breaks (one per paragraph/checklist/list line, same unit as
  // pressing Enter), not wrapped display lines, same as a plain text
  // editor's line count. innerText (not textContent) so block-level
  // line breaks between the editor's line <div>s are included. Shared
  // by both a node's own notes and a task's notes, since they're the
  // exact same editor element (see loadNoteIntoEditor).
  function updateNoteLineCount() {
    if (!noteLineCountEl) return;
    noteLineCountEl.textContent = "Lines: " + noteTextarea.innerText.split("\n").length;
  }

  // Loads noteWorkingList[noteActiveIndex] into the visible editor and
  // refreshes the nav row (‹ 2 / 3 › + 🗑) to match.
  function loadNoteIntoEditor() {
    const node = findNode(noteEditingId);
    const current = noteWorkingList[noteActiveIndex];
    if (noteEditingSubtaskId && noteEditingTaskId) {
      const taskHost = noteEditingCellPos ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c) : node;
      const subtaskOwner = noteEditingNoteOwner(taskHost);
      current.title = ((subtaskOwner && subtaskOwner.text) || "").trim();
    }
    noteTitleInput.value = current.title || "";
    noteTitleInput.readOnly = !!noteEditingSubtaskId || !isEditingAllowed();
    if (noteEditingTaskId) {
      const taskHost = noteEditingCellPos ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c) : node;
      const t = noteEditingNoteOwner(taskHost);
      const kind = noteEditingSubtaskId ? "subtask" : "task";
      noteTextarea.dataset.placeholder = `Note for ${kind} "${t ? (t.text || `(untitled ${kind})`) : ""}"…`;
      noteNavAdd.title = `Start a new note on this ${kind}`;
    } else if (noteEditingCellPos) {
      noteTextarea.dataset.placeholder = "Note for this cell…";
      noteNavAdd.title = "Start a new note on this cell";
    } else if (noteEditingPhotoId) {
      noteTextarea.dataset.placeholder = "Note on this photo…";
      noteNavAdd.title = "Start a new note on this photo";
    } else {
      noteTextarea.dataset.placeholder = `Note for "${node ? (node.text || "(untitled)") : ""}"…`;
      noteNavAdd.title = "Start a new note on this node";
    }
    noteTextarea.innerHTML = noteHtmlFromRaw(current.html);
    // Retire old widgets/markup and migrate v631-v634 F spans away from
    // foreColor. Fade is now opacity-only and must preserve whatever text
    // color the note already has.
    const migratedFade = noteMigrateLegacyFadeMarkup(noteTextarea);
    const migratedMood = noteMigrateLegacyMoodBlocks();
    const migratedPhotos = hydrateNotePhotoImages();
    const linkedUrls = noteLinkifyUrls(noteTextarea, false);
    if (migratedFade || migratedMood || migratedPhotos || linkedUrls) scheduleNoteAutosave();
    // v359: DRC and Brainstorm use Note's exact editor behavior.
    setNoteAutoColorEnabled(true);
    refreshDRCCards();
    noteSyncAllCheckedLines();
    noteSyncAllOrderedColors();
    noteAutoColorParagraphs();
    noteResetUndoHistory();
    updateNoteNavUI();
    updateNoteLineCount();
    updateNoteFavoriteUI();
    updateNoteFolderUI();
    updateNoteInfoUI();
    updateNoteColorToolAvailability();
    noteDownscaleOversizedImagesInEditor();
  }

  // One-time self-heal for notes that already had an oversized image
  // embedded before downscaleNoteImageDataUrl existed (see
  // noteHandleImageFiles) — shrinks any still-oversized <img> already
  // sitting in this note the moment it's opened, then lets the normal
  // autosave commit the smaller version. Without this, an old bloated
  // note keeps re-triggering the same full-map-tree stringify (see
  // pushUndo/persist) on every edit, forever, even after new pastes stop
  // adding to the problem.
  function noteDownscaleOversizedImagesInEditor() {
    if (!NOTE_IMAGE_DOWNSCALE) return; // photos are kept at full quality — see NOTE_IMAGE_DOWNSCALE
    const oversized = Array.from(noteTextarea.querySelectorAll("img[src^='data:']"))
      .filter(img => img.src.length > NOTE_IMAGE_SKIP_BYTES);
    if (!oversized.length) return;
    Promise.all(oversized.map((img) => downscaleNoteImageDataUrl(img.src).then((smaller) => {
      if (smaller && smaller !== img.src) img.src = smaller;
    }))).then(() => {
      // commitNotesToNode only actually writes/pushUndo's if the note's
      // serialized content changed, so this is a no-op when nothing here
      // needed shrinking after all.
      scheduleNoteAutosave();
    });
  }

  // v440: top-row "i" button exposes the immutable creation timestamp of
  // whichever note is currently open. Imported/very old notes may predate
  // createdAt; in that case report that honestly rather than inventing a date.
  function noteCreatedAtLabel(note) {
    const raw = note && note.createdAt;
    if (raw == null || raw === "") return null;
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return null;
    try {
      return d.toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });
    } catch (_) {
      return d.toLocaleString();
    }
  }

  function updateNoteInfoUI() {
    if (!noteNavInfo) return;
    const current = noteWorkingList[noteActiveIndex];
    const created = noteCreatedAtLabel(current);
    const label = created ? `Ngày tạo: ${created}` : "Ngày tạo: không có dữ liệu (note cũ)";
    noteNavInfo.title = label;
    noteNavInfo.setAttribute("aria-label", label);
  }

  function showCurrentNoteInfo() {
    const current = noteWorkingList[noteActiveIndex];
    const created = noteCreatedAtLabel(current);
    showToast(created ? `Ngày tạo: ${created}` : "Ngày tạo: không có dữ liệu (note cũ)");
  }

  // Syncs the ☆/★ favorite button in the note editor's nav row to match
  // whichever note is currently loaded (see loadNoteIntoEditor) — same
  // idea as toggleNoteFavorite below, just the read side.
  function updateNoteFavoriteUI() {
    const current = noteWorkingList[noteActiveIndex];
    const fav = !!(current && current.favorite);
    noteNavFavorite.textContent = fav ? "★" : "☆";
    noteNavFavorite.classList.toggle("favorited", fav);
    noteNavFavorite.title = fav ? "Remove from favorites" : "Add to favorites";
    noteNavFavorite.setAttribute("aria-label", noteNavFavorite.title);
  }

  // Toggles the favorite star on whichever note is currently loaded in the
  // editor and saves immediately — same commit-on-change behavior as
  // adding/deleting a note (see addAnotherNote/deleteActiveNote), so the
  // star shows up in the "Favorites" sidebar browser right away.
  function toggleNoteFavorite() {
    const current = noteWorkingList[noteActiveIndex];
    if (!current) return;
    captureActiveNote();
    current.favorite = !current.favorite;
    updateNoteFavoriteUI();
    updateNoteFolderUI();
    commitNotesToNode();
  }

  function updateNoteNavUI() {
    // No more pager buttons/label to sync — paging between notes is now
    // keyboard-only (Alt+←/→), see the keydown handlers below.
  }

  // Syncs the 📁 button in the note editor's nav row to whichever note is
  // currently loaded — hidden for a DRC note or a starred one, same
  // reasoning as the Notes browser rows (see the isDRC/favorite branch
  // in buildNoteBrowserRow): either one's folder isn't a choice —
  // syncDRCFolderAssignments/syncFavoriteFolderAssignments would just
  // put it straight back — so a button here would silently undo itself.
  function updateNoteFolderUI() {
    if (!noteNavFolder) return;
    const current = noteWorkingList[noteActiveIndex];
    const forced = !!(current && (isDRCNote(current) || current.favorite));
    noteNavFolder.classList.toggle("hidden", forced);
    if (forced) return;
    const folder = current ? notesFolderMgr.folderOf(current.id) : null;
    noteNavFolder.title = folder ? `In folder: ${folder}` : "Move to folder";
    noteNavFolder.classList.toggle("has-folder", !!folder);
  }

  // Shared QUEUE TASKS task. It is rendered as the first task in every
  // Tasks modal, but its subtasks are stored globally rather than on that
  // node. This makes it a true inbox/queue that is the same on phone, PC,
  // and every task list. Completed queue subtasks are always sorted last.
  let sharedQueueAddOpen = false;

  function openSharedQueueSubtaskMenu(x, y, s) {
    resetContextMenu();
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
    addItem("Rename", "", () => {
      if (!requireSignIn()) return;
      const next = prompt("Rename subtask", s.text || "");
      if (next === null) return;
      const clean = next.trim();
      if (!clean || clean === (s.text || "")) return;
      updateDRCQueueSubtask(s.id, (live) => { live.text = clean; syncSubtaskNoteTitles(live); });
    });
    addItem(s.done ? "↩ Mark undone" : "✓ Mark done", "", () => {
      updateDRCQueueSubtask(s.id, (live) => {
        live.done = !live.done;
        if (live.done) live.failed = false;
      });
    });
    addItem(s.failed ? "\u21a9 Clear failed" : "Mark failed", "", () => {
      updateDRCQueueSubtask(s.id, (live) => {
        live.failed = !live.failed;
        if (live.failed) live.done = false;
      });
    });
    addItem(s.emergencyGlow ? "🚨 Turn off emergency glow" : "🚨 Emergency glow", "", () => {
      if (!requireSignIn()) return;
      updateDRCQueueSubtask(s.id, (live) => { live.emergencyGlow = !live.emergencyGlow; });
    });
    addItem("Copy text", "", () => copySubtaskText(s.text || ""));
    addItem("↔ Move", "", () => {
      if (!requireSignIn()) return;
      subtaskTouchMoveMode = { taskId: SHARED_QUEUE_TASK_ID, subtaskId: s.id };
      document.querySelectorAll(".subtask-row.subtask-move-ready").forEach(el => el.classList.remove("subtask-move-ready"));
      const armed = tasksListEl && tasksListEl.querySelector(`.subtask-row[data-task-id="${CSS.escape(SHARED_QUEUE_TASK_ID)}"][data-subtask-id="${CSS.escape(s.id)}"]`);
      if (armed) armed.classList.add("subtask-move-ready");
      showToast("Move ready — drag this queue subtask");
    });

    // A line break lives on the subtask that follows the selected one
    // (brBefore), so the break is genuinely BETWEEN two pills rather
    // than a newline inside either pill text.
    const queueDisplay = drcQueueDisplayItems();
    const queueIndex = queueDisplay.findIndex(x => x.id === s.id);
    const queueNext = queueIndex >= 0 && queueIndex < queueDisplay.length - 1
      ? queueDisplay[queueIndex + 1]
      : null;
    if (queueNext) {
      addItem(queueNext.brBefore ? "Remove line break" : "Add line break", "", () => {
        updateDRCQueueSubtask(queueNext.id, (live) => {
          if (live.brBefore) delete live.brBefore;
          else live.brBefore = 1;
        });
      });
    }

    addItem("Delete subtask", "danger", () => {
      if (!confirm(`Delete the subtask "${s.text || "Untitled subtask"}"?`)) return;
      deleteDRCQueueSubtask(s.id);
    });
    positionContextMenu(x, y);
  }

  function setAllSharedQueueDone(done) {
    if (!requireSignIn()) return;
    const items = getDRCQueueItems();
    const now = Date.now();
    let changed = false;
    items.forEach((s, i) => {
      if (!!s.done === !!done && (!done || !s.failed)) return;
      s.done = !!done;
      if (done) s.failed = false;
      s.updatedAt = now + i;
      changed = true;
    });
    if (changed) saveDRCQueueMutation(items);
  }

  function renderSharedQueueTask() {
    if (!tasksListEl) return;
    const items = drcQueueDisplayItems();
    const doneCount = items.filter(x => x.done).length;
    const allDone = items.length > 0 && doneCount === items.length;

    const taskRow = document.createElement("li");
    taskRow.className = "task-row shared-queue-task-row has-open-subtasks" + (allDone ? " done" : "");
    taskRow.dataset.sharedQueue = "1";
    taskRow.dataset.taskId = SHARED_QUEUE_TASK_ID;
    taskRow.addEventListener("dragover", (e) => {
      if (!subtaskDragState) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      taskRow.classList.add("subtask-drop-target");
    });
    taskRow.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && taskRow.contains(e.relatedTarget)) return;
      taskRow.classList.remove("subtask-drop-target");
    });
    taskRow.addEventListener("drop", (e) => {
      if (!subtaskDragState) return;
      e.preventDefault();
      e.stopPropagation();
      taskRow.classList.remove("subtask-drop-target");
      moveSubtask(
        subtaskDragState.taskId,
        subtaskDragState.subtaskId,
        SHARED_QUEUE_TASK_ID,
        null,
        false
      );
    });

    const title = document.createElement("span");
    title.className = "task-text";
    title.textContent = "QUEUE TASKS";
    title.contentEditable = "false";
    title.title = "Shared queue — synced across every task list and device";

    const count = document.createElement("span");
    count.className = "shared-queue-count";
    count.textContent = items.length ? `${doneCount}/${items.length}` : "0";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-subtask-btn shared-queue-add-btn";
    addBtn.textContent = "+";
    addBtn.title = "Add a queue subtask";
    addBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!requireSignIn()) return;
      sharedQueueAddOpen = true;
      renderTasksModal();
    });

    taskRow.append(title, count, addBtn);
    tasksListEl.appendChild(taskRow);

    const wrap = document.createElement("li");
    wrap.className = "subtask-panel shared-queue-subtask-panel";
    wrap.dataset.taskId = SHARED_QUEUE_TASK_ID;

    const setQueueDropHighlight = (on) => {
      wrap.classList.toggle("subtask-drop-target", !!on);
      taskRow.classList.toggle("subtask-drop-target", !!on);
    };
    wrap.addEventListener("dragover", (e) => {
      if (!subtaskDragState || subtaskDragState.taskId === SHARED_QUEUE_TASK_ID) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setQueueDropHighlight(true);
    });
    wrap.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
      setQueueDropHighlight(false);
    });
    wrap.addEventListener("drop", (e) => {
      if (!subtaskDragState || subtaskDragState.taskId === SHARED_QUEUE_TASK_ID) return;
      e.preventDefault();
      e.stopPropagation();
      setQueueDropHighlight(false);
      moveSubtask(
        subtaskDragState.taskId,
        subtaskDragState.subtaskId,
        SHARED_QUEUE_TASK_ID,
        null,
        false
      );
    });

    const list = document.createElement("ul");
    list.className = "subtask-list";

    items.forEach((s) => {
      // Queue subtasks use the same between-pill line-break format as
      // ordinary subtasks. A spacer before this pill forces a new row.
      const breakCount = Math.max(0, Math.min(5, s.brBefore | 0));
      for (let k = 0; k < breakCount; k++) {
        const br = document.createElement("li");
        br.className = "subtask-break" + (k > 0 ? " subtask-break-extra" : "");
        list.appendChild(br);
      }

      const row = document.createElement("li");
      row.className = "subtask-row" + (s.done ? " done" : "") + (s.failed ? " failed" : "") + (s.emergencyGlow ? " emergency-glow" : "");
      row.dataset.taskId = SHARED_QUEUE_TASK_ID;
      row.dataset.subtaskId = s.id;

      const queuePhoneMode = window.matchMedia("(max-width: 640px)").matches;
      row.draggable = !queuePhoneMode;
      row.addEventListener("dragstart", (e) => startSubtaskDrag(e, row, SHARED_QUEUE_TASK_ID, s.id));
      row.addEventListener("dragend", () => endSubtaskDrag(row));
      row.addEventListener("dragover", (e) => {
        if (!subtaskDragState) return;
        if (subtaskDragState.taskId !== SHARED_QUEUE_TASK_ID) return; // whole Queue card handles cross-task moves
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
        if (subtaskDragState.taskId !== SHARED_QUEUE_TASK_ID) return; // whole Queue card handles it
        if (subtaskDragState.subtaskId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        row.classList.remove("drag-over-top", "drag-over-bottom");
        moveSubtask(
          subtaskDragState.taskId,
          subtaskDragState.subtaskId,
          SHARED_QUEUE_TASK_ID,
          s.id,
          before
        );
      });

      const stext = document.createElement("span");
      stext.className = "subtask-text";
      stext.contentEditable = "false";
      stext.spellcheck = false;
      stext.textContent = s.text || "";
      stext.title = s.text || "";

      let clickTimer = null;
      row.addEventListener("click", (e) => {
        if (row.__subtaskLongPressConsumed) {
          e.preventDefault();
          e.stopPropagation();
          row.__subtaskLongPressConsumed = false;
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          return;
        }
        if (stext.contentEditable === "true") return;
        // Phone: status changes live only in the long-press/right-click menu.
        // This avoids accidental done/undone toggles while scrolling or tapping.
        if (queuePhoneMode) return;
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          updateDRCQueueSubtask(s.id, (live) => {
            live.done = !live.done;
            if (live.done) live.failed = false;
          });
        }, 220);
      });

      stext.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!requireSignIn()) return;
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
        else if (e.key === "Escape") { e.preventDefault(); stext.textContent = s.text || ""; stext.blur(); }
      });
      stext.addEventListener("blur", () => {
        const v = stext.textContent.trim();
        stext.contentEditable = "false";
        row.draggable = !window.matchMedia("(max-width: 640px)").matches;
        if (v && v !== (s.text || "")) updateDRCQueueSubtask(s.id, (live) => { live.text = v; });
        else stext.textContent = s.text || "";
      });

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (row.__subtaskLongPressConsumed) return;
        openSharedQueueSubtaskMenu(e.clientX, e.clientY, s);
      });
      installSubtaskLongPress(row, (x, y) => openSharedQueueSubtaskMenu(x, y, s));

      row.appendChild(stext);
      list.appendChild(row);
    });

    if (!sharedQueueAddOpen) {
      const addTriggerLi = document.createElement("li");
      addTriggerLi.className = "subtask-add-trigger shared-queue-add-trigger";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "subtask-add-btn";
      trigger.textContent = "+";
      trigger.title = "Add a queue subtask";
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!requireSignIn()) return;
        sharedQueueAddOpen = true;
        renderTasksModal();
      });
      addTriggerLi.appendChild(trigger);
      list.appendChild(addTriggerLi);
    }

    wrap.appendChild(list);

    if (sharedQueueAddOpen) {
      const addRow = document.createElement("div");
      addRow.className = "subtask-add-row";
      const input = document.createElement("textarea");
      input.rows = 1;
      input.className = "subtask-new-input autosize-input shared-queue-new-input";
      input.placeholder = "Add a queue subtask and press Enter…";
      input.spellcheck = false;
      input.addEventListener("input", () => autosizeTextarea(input));
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          if (addDRCQueueSubtask(v)) {
            sharedQueueAddOpen = true;
            requestAnimationFrame(() => {
              const el = tasksListEl.querySelector(".shared-queue-new-input");
              if (el) el.focus();
            });
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          sharedQueueAddOpen = false;
          renderTasksModal();
        }
      });
      input.addEventListener("blur", () => {
        if (!input.value.trim()) {
          sharedQueueAddOpen = false;
          renderTasksModal();
        }
      });
      addRow.appendChild(input);
      wrap.appendChild(addRow);
      requestAnimationFrame(() => {
        const el = tasksListEl.querySelector(".shared-queue-new-input");
        if (el) el.focus();
      });
    }

    tasksListEl.appendChild(wrap);
  }

  // v334: the old multi-line Card presentation is retired. Existing notes
  // keep all of their text/HTML, but any runtime card decoration is removed
  // so DRC/Note content renders as normal lines unless the user inserts a
  // new 1-cell table.
  function refreshDRCCards() {
    noteTextarea.classList.remove("drc-cards");
    Array.from(noteTextarea.children).forEach((el) => drcSetCardState(el, null));
  }
  let drcNoteCardsRaf = 0;
  function refreshDRCCardsSoon() {
    if (drcNoteCardsRaf) return;
    drcNoteCardsRaf = requestAnimationFrame(() => { drcNoteCardsRaf = 0; refreshDRCCards(); });
  }

  // Reads whatever's currently in the editor (title + body) back into the
  // working list, without touching the node yet — called before
  // navigating away from the note currently on screen so nothing typed
  // is lost.
  function captureActiveNote() {
    const current = noteWorkingList[noteActiveIndex];
    if (!current) return;
    const node = findNode(noteEditingId);
    const taskHost = noteEditingCellPos && node ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c) : node;
    const subtaskOwner = noteEditingSubtaskId ? noteEditingNoteOwner(taskHost) : null;
    const newTitle = noteEditingSubtaskId
      ? (((subtaskOwner && subtaskOwner.text) || "").trim())
      : noteTitleInput.value;
    // The card decoration (classes + CSS variables) lives only in the open
    // editor — never in what's saved — so merely opening a DRC note isn't
    // counted as changing it.
    const newHtml = stripNotePhotoSrcForStorage(
      noteTextarea.classList.contains("drc-cards")
        ? drcStripCardMarkup(noteTextarea.innerHTML)
        : noteTextarea.innerHTML
    );
    if (current.title !== newTitle || current.html !== newHtml) {
      current.updatedAt = Date.now();
      // Backfills a timestamp for notes written before this field existed,
      // the first time one of them actually gets touched again — rather
      // than leaving createdAt permanently blank for every pre-existing
      // note (see the Notes browser's date sort, which falls back to "no
      // date" only when neither field is set).
      if (!current.createdAt) current.createdAt = current.updatedAt;
    }
    current.title = newTitle;
    current.html = newHtml;
  }

  function goToNote(delta) {
    captureActiveNote();
    noteActiveIndex = clamp(noteActiveIndex + delta, 0, noteWorkingList.length - 1);
    loadNoteIntoEditor();
    commitNotesToNode();
  }

  function addAnotherNote() {
    captureActiveNote();
    const node = findNode(noteEditingId);
    const taskHost = noteEditingCellPos && node ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c) : node;
    const subtaskOwner = noteEditingSubtaskId ? noteEditingNoteOwner(taskHost) : null;
    noteWorkingList.push({ id: uid(), title: noteEditingSubtaskId ? (((subtaskOwner && subtaskOwner.text) || "").trim()) : "", html: "", createdAt: Date.now(), updatedAt: Date.now() });
    noteActiveIndex = noteWorkingList.length - 1;
    loadNoteIntoEditor();
    commitNotesToNode();
    requestAnimationFrame(() => { noteTitleInput.focus(); });
  }

  // Deletes the note currently in the editor. If it's the only one left,
  // just clears it instead — closing the marker down to zero without
  // leaving the editor in a no-notes-open state.
  function deleteActiveNote() {
    // v456: destructive top-row action always requires explicit confirmation.
    // This is the one shared Note editor, so the same guard covers Note, DRC
    // and Brainstorm on both mouse and touch devices.
    const active = noteWorkingList[noteActiveIndex];
    const kind = active && active.kind === "brainstorm"
      ? "Brainstorm"
      : ((active && String(active.title || "").trim().toUpperCase() === "DRC") ? "DRC" : "Note");
    if (!window.confirm(`Delete this ${kind}? This cannot be undone.`)) return;
    captureActiveNote();
    if (noteWorkingList.length <= 1) {
      noteWorkingList[0].title = "";
      noteWorkingList[0].html = "";
      // v572: DRC/Brainstorm notes carry a `kind` marker. If the last note
      // is "deleted" by only clearing title/html, that marker makes
      // commitNotesToNode() keep the otherwise-empty note forever, so its
      // calendar/node icon cannot disappear. Clear the variant marker too;
      // the blank placeholder is then filtered out exactly like a normal Note.
      delete noteWorkingList[0].kind;
    } else {
      noteWorkingList.splice(noteActiveIndex, 1);
      noteActiveIndex = clamp(noteActiveIndex, 0, noteWorkingList.length - 1);
    }
    loadNoteIntoEditor();
    commitNotesToNode();
  }

  function closeNoteModal() {
    closeNoteTemplatesPopover();
    clearTimeout(noteLinkifyTimer);
    noteLinkifyTimer = null;
    // Catch a URL typed at the very end of a note even if the idle
    // recognizer has not fired yet, then flush that final HTML to storage.
    noteLinkifyUrls(noteTextarea, false);
    flushNoteAutosave();
    const redrawMap = noteMapVisualDirty;
    const redrawNodeId = noteEditingId;
    noteEditingId = null;
    noteEditingPhotoId = null;
    noteEditingTaskId = null;
    noteEditingSubtaskId = null;
    noteEditingCellPos = null;
    noteWorkingList = [];
    noteActiveIndex = 0;
    noteReturn = null;
    noteMapUndoCaptured = false;
    noteMapVisualDirty = false;
    $("#note-color-popover").classList.add("hidden");
    $("#note-emoji-popover").classList.add("hidden");
    zoomModalClose(noteModal);
    // The node strip/progress may have changed, but while the note editor was
    // open there was no reason to tear down and recreate every map node on
    // each autosave. Refresh exactly once now that the user can see the map.
    if (redrawMap) refreshNodeOrRenderAll(redrawNodeId);
  }

  // Phone-friendly note typing pipeline. None of the expensive full-note
  // work runs synchronously on an ordinary keystroke anymore:
  //   - editor maintenance waits until typing has been idle for a moment;
  //   - persistence waits a little longer;
  //   - close/lock/navigation paths still call commit/capture directly, so
  //     delaying the background work never risks losing the last characters.
  const NOTE_EDITOR_IDLE_MS = 650;
  const NOTE_AUTOSAVE_IDLE_MS = 900;

  function scheduleNoteIdleMaintenance() {
    clearTimeout(noteLinkifyTimer);
    noteLinkifyTimer = setTimeout(() => {
      noteLinkifyTimer = null;
      if (!noteEditingId || noteModal.classList.contains("hidden")) return;

      // These all walk a meaningful part (or all) of the editor DOM, so doing
      // them once after a typing burst is dramatically cheaper on mobile than
      // doing them once per character.
      refreshAutoNoteLinks(noteTextarea);
      noteLinkifyUrls(noteTextarea, true);
      noteAutoColorParagraphs();
      refreshDRCCards();
      updateNoteLineCount();
    }, NOTE_EDITOR_IDLE_MS);
  }

  // Debounced autosave: commit only after the typing burst has settled.
  // commitNotesToNode() captures the full HTML at that point, rather than
  // scheduleNoteAutosave() serializing the entire note on every keypress.
  function scheduleNoteAutosave() {
    // Crash/F5 protection happens immediately on every mutation; the heavier
    // canonical map/Drive save below stays debounced for smooth phone typing.
    saveNoteCrashDraftNow();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      noteSaveTimer = null;
      commitNotesToNode();
    }, NOTE_AUTOSAVE_IDLE_MS);
  }

  function flushNoteAutosave() {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
    commitNotesToNode();
  }

  // Writes noteWorkingList onto the node's `notes` array, or (when
  // noteEditingPhotoId is set) onto that one photo's own note list
  // instead — see getPhotoNotes/setPhotoNotes. Entries that are still
  // genuinely blank (no title and never typed into) are dropped so an
  // idle "+ New note" click doesn't leave a phantom entry inflating the
  // marker's count — matches the old single-note behavior, where an
  // empty note never made the marker appear in the first place.
  function captureNoteMapUndoOnce() {
    if (noteMapUndoCaptured) return;
    pushUndo();
    noteMapUndoCaptured = true;
  }

  function commitNotesToNode() {
    const node = findNode(noteEditingId);
    if (!node) return;
    captureActiveNote();
    const cleaned = noteWorkingList.filter(n => n.kind || (n.title && n.title.trim()) || (n.html && n.html.trim()));

    // Rich-note editing already has its own fine-grained undo stack. At map
    // level, treat the whole open-editor session as one edit: capture the map
    // once before the first mutation, persist every settled burst, and defer
    // the expensive renderAll() until closeNoteModal().
    const beginMutation = () => {
      captureNoteMapUndoOnce();
      noteMapVisualDirty = true;
    };

    if (noteEditingTaskId) {
      const taskHost = noteEditingCellPos ? getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c) : node;
      const t = noteEditingNoteOwner(taskHost);
      if (!t) return;
      const before = JSON.stringify(getTaskNotes(t));
      const after = JSON.stringify(cleaned);
      if (before !== after) {
        beginMutation();
        t.notes = cleaned;
        t.note = "";
        persist();
        // The Tasks modal is a small focused surface and may be visible under
        // the note editor; keep it current without rebuilding the mindmap.
        if (!tasksModal.classList.contains("hidden")) renderTasksModal();
      }
      return;
    }
    if (noteEditingCellPos) {
      const a = getCellAttach(node, noteEditingCellPos.r, noteEditingCellPos.c);
      const before = JSON.stringify(getCellNotes(a));
      const after = JSON.stringify(cleaned);
      if (before !== after) {
        beginMutation();
        a.notes = cleaned.length ? cleaned : null;
        a.note = null;
        // Calendar-cell Brainstorms use the same lightweight mirror as the
        // node-level Brainstorm marker, but the mirror lives on this cell.
        syncBrainstormMirrorFromNotes(a);

        // v542: a Calendar cell is the same canonical mini-node whether the
        // edit was launched from the map or from the top Calendar. Paint the
        // owning mindmap node and the open Calendar immediately; persistence
        // still uses the normal crash-safe local write + debounced Drive path.
        refreshNodeOrRenderAll(node.id);
        if (calendarModal && !calendarModal.classList.contains("hidden")) {
          renderCalendar();
        }
        persist();
      }
      return;
    }
    if (noteEditingPhotoId) {
      const before = JSON.stringify(getPhotoNotes(node, noteEditingPhotoId));
      const after = JSON.stringify(cleaned);
      if (before !== after) {
        beginMutation();
        setPhotoNotes(node, noteEditingPhotoId, cleaned);
        persist();
      }
      return;
    }
    const before = JSON.stringify(getNodeNotes(node));
    const after = JSON.stringify(cleaned);
    if (before !== after) {
      beginMutation();
      node.notes = cleaned;
      node.note = "";
      syncBrainstormMirrorFromNotes(node);

      // v547: note/DRC/brainstorm icon appearance AND disappearance must be
      // reflected immediately while the editor is still open. Persistence is
      // deliberately after the repaint so deleting a note never leaves a
      // stale icon waiting for editor close or storage work.
      refreshNodeOrRenderAll(node.id);
      if (calendarModal && !calendarModal.classList.contains("hidden")) renderCalendar();
      persist();
    }
  }

  // Finds the block-level "line" element containing the caret, so toolbar
  // actions and Enter-to-continue behave per line rather than globally.
  // Takes the editable container so this also serves the per-task note
  // editor (a second, simpler contenteditable) below, not just the
  // per-node rich note editor.
  function noteCurrentLine(container = noteTextarea) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType === 3) {
      node = node.parentNode;
    } else if (node.childNodes.length) {
      // The caret's container can itself be an *element* rather than a
      // text node — most commonly right at the very end of the whole
      // editor (after the last character of the last line), where the
      // browser reports the selection as sitting inside `container`
      // itself, past its last child, instead of inside a leaf text node.
      // Left unhandled, the walk below would immediately see node ===
      // container and bail out to null — which then made every caller
      // (notably noteHandleEnter) fall back to treating the *entire*
      // editor as "the current line," splitting/overwriting all lines
      // at once instead of just the one the caret is actually on.
      // Resolving to the adjacent child first fixes that: offset 0 means
      // "before the first child" (use it), any other offset means "after
      // the child before it" (use that one, clamped to the last child).
      const idx = Math.min(Math.max(range.startOffset - 1, 0), node.childNodes.length - 1);
      node = node.childNodes[idx];
    }
    while (node && node !== container && node.parentNode !== container) {
      node = node.parentNode;
    }
    return node === container ? null : node;
  }

  // True when the caret sits at the very start of lineDiv's text (nothing
  // typed before it on that line) — used so an inserted photo lands above
  // the line instead of below it when the cursor is at position zero.
  function noteCaretIsAtLineStart(lineDiv) {
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
      return false; // caret isn't actually inside lineDiv
    }
    return preRange.toString().length === 0;
  }

  function noteSelectLine(lineDiv) {
    const target = lineDiv || noteTextarea;
    const r = document.createRange();
    r.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Toggles a line-start prefix like "☐ " on the current line — powers the
  // checklist toolbar button. (The numbered-list button has its own
  // function below, since it also needs to manage per-number colors.)
  function noteToggleLinePrefix(prefixRegex, makePrefix) {
    noteTextarea.focus();
    notePushUndo();
    const lineDiv = noteCurrentLine();
    const el = lineDiv || noteTextarea;
    const text = el.textContent;
    const match = text.match(prefixRegex);
    el.textContent = match ? text.slice(match[0].length) : makePrefix() + text;
    noteSyncLineChecked(el);
    placeCaretAtEnd(el);
    scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  // Each numbered line gets its own color, cycling through this palette by
  // its number (1, 2, 3, ... wrapping back to the start), so consecutive
  // list items are easy to tell apart at a glance.
  const NOTE_OL_COLORS = [
    "#b5504a", // red
    "#c98a3a", // orange
    "#5a8f5a", // green
    "#4a72b5", // blue
    "#8a5fb0", // purple
    "#3a8f8a", // teal
    "#a5723a", // brown
    "#6a6a2b", // olive
  ];
  function noteColorForOrdinal(n) {
    return NOTE_OL_COLORS[(n - 1) % NOTE_OL_COLORS.length];
  }

  // Gives every plain paragraph (a line broken off by pressing Enter) its
  // own color, cycling through the same palette as numbered-list lines, so
  // separate paragraphs in a note are easy to tell apart at a glance even
  // without numbering them. Only touches lines that don't have a color of
  // their own yet, so it never overwrites a numbered/checklist line's own
  // ordinal color, or a color someone already picked by hand for a whole
  // line. A manual foreColor selection over just *part* of a line (via the
  // toolbar) is a separate <font>/span wrapper inside the line, not this
  // div-level style, so the two never fight over the same text either.
  // `container` defaults to the per-node rich note editor but also serves
  // the per-task note editor.
  let noteAutoColorEnabled = true;
  // v368: one shared Auto Color state for the single Note editor.
  // Note, DRC and Brainstorm use this exact same path; no type-specific default.
  function setNoteAutoColorEnabled(enabled) {
    noteAutoColorEnabled = enabled;
    const autoChoice = $("#note-color-auto");
    if (autoChoice) {
      autoChoice.classList.toggle("active", enabled);
      autoChoice.setAttribute("aria-pressed", String(enabled));
    }
    const trigger = $("#note-tool-color");
    const label = $("#note-color-trigger-label");
    const swatch = $("#note-color-trigger-swatch");
    if (enabled) {
      if (trigger) { trigger.classList.add("active"); trigger.title = "Color: Auto"; trigger.setAttribute("aria-label", "Color: Auto"); }
      if (label) label.textContent = "🎨";
      if (swatch) { swatch.style.background = ""; swatch.classList.add("note-color-trigger-swatch-auto"); }
    }
  }
  function noteAutoColorParagraphs(container = noteTextarea) {
    if (!noteAutoColorEnabled) return;
    let idx = 0;
    Array.from(container.children).forEach(el => {
      if (el.classList && el.classList.contains("note-mood")) return; // the Mood To Day block has its own colors
      const text = el.textContent || "";
      // Numbered/checklist lines keep their own ordinal-based color, and an
      // image line has no text to color — skip both instead of assigning
      // them a paragraph color too.
      if (/^(\d+\.\s|[☐☑])\s?/.test(text)) return;
      if (el.querySelector && el.querySelector("img")) return;
      if (!el.style.color) el.style.color = noteColorForOrdinal(idx + 1);
      idx++;
    });
  }

  // Colors a line based on the number in its own "N. " prefix, or clears
  // the color if the line isn't numbered. Applied at the div level (not
  // wrapped in a span), so it never collides with a manual foreColor
  // selection made via the color picker inside the line's text.
  // One shared 🎨 Auto Color gate for Note, DRC and Brainstorm.
  function noteSetOrderedLineColor(el) {
    if (!el || !noteAutoColorEnabled) return;
    const match = (el.textContent || "").match(/^(\d+)\.\s/);
    el.style.color = match ? noteColorForOrdinal(parseInt(match[1], 10)) : "";
  }

