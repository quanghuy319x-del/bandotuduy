/* Branchline — js/12-photos-viewer-2.js
   Part 12 of 19 of the former single-file app.js. Contents: node photo attachments (part 2).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  // Cursor-anchored zoom step, shared by the image's own wheel handler and
  // by the add-text overlay's (which sits on top of the image and would
  // otherwise swallow the wheel events before they ever reached it).
  function zoomPhotoAtPoint(clientX, clientY, deltaY) {
    const rect = photoModalImg.getBoundingClientRect();
    // Cursor's offset from the image's current (already zoomed/panned)
    // on-screen center — used to keep the point under the cursor fixed
    // as the scale changes, so zooming feels anchored to the mouse
    // rather than always zooming toward the photo's center.
    const offX = clientX - (rect.left + rect.width / 2);
    const offY = clientY - (rect.top + rect.height / 2);
    const prevScale = photoZoom.scale;
    const delta = -deltaY * 0.0018;
    const newScale = clamp(prevScale * (1 + delta), PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
    if (newScale === prevScale) return;
    const factor = newScale / prevScale;
    photoZoom.tx += offX * (1 - factor);
    photoZoom.ty += offY * (1 - factor);
    photoZoom.scale = newScale;
    if (photoZoom.scale === PHOTO_ZOOM_MIN) { photoZoom.tx = 0; photoZoom.ty = 0; }
    applyPhotoZoom();
  }
  function resetPhotoZoom() {
    photoZoom = { scale: 1, tx: 0, ty: 0 };
    applyPhotoZoom();
  }

  photoModalImg.draggable = false; // don't fight our own pan drag with the browser's native image-drag
  photoModalImg.addEventListener("wheel", (e) => {
    if (!photoModalState || cropping || addingText) return;
    e.preventDefault();
    e.stopPropagation();
    zoomPhotoAtPoint(e.clientX, e.clientY, e.deltaY);
  }, { passive: false });

  // Drag to pan once zoomed in — only kicks in above 1x so a plain click
  // still behaves normally (e.g. not stealing the click-outside-to-close).
  let photoPanState = null;
  photoModalImg.addEventListener("mousedown", (e) => {
    if (!photoModalState || cropping || addingText || photoZoom.scale <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    photoPanState = { startX: e.clientX, startY: e.clientY, tx: photoZoom.tx, ty: photoZoom.ty };
    photoModalImg.classList.add("panning");
  });
  window.addEventListener("mousemove", (e) => {
    if (!photoPanState) return;
    photoZoom.tx = photoPanState.tx + (e.clientX - photoPanState.startX);
    photoZoom.ty = photoPanState.ty + (e.clientY - photoPanState.startY);
    applyPhotoZoom();
  });
  window.addEventListener("mouseup", () => {
    if (!photoPanState) return;
    photoPanState = null;
    photoModalImg.classList.remove("panning");
  });
  // Double-click to jump back to 1x, since there's no on-screen zoom
  // control otherwise (scroll is the only way in).
  photoModalImg.addEventListener("dblclick", (e) => {
    if (!photoModalState || cropping || addingText) return;
    e.stopPropagation();
    resetPhotoZoom();
  });

  // Cells use this exact same viewer through openCellPhotoModal(), including
  // prev/next, zoom, crop, text/combine, tags, comments, favorite and delete.
  // `tagGroup` (optional): { label, items: [{nodeId, id}, ...] }. When
  // present, the modal's prev/next step through every photo sharing that
  // tag across the whole map instead of just this node's own photos —
  // used when opening a photo from the tag browser's "Go to node".
  function openCellPhotoModal(nodeId, r, c, index, tagGroup) {
    const node = findNode(nodeId);
    if (!node || !node.table) return;
    const host = getCellAttach(node, r, c);
    const images = getNodeImages(host);
    if (!images.length) return;
    const clampedIndex = clamp(index || 0, 0, images.length - 1);
    let tagIndex = 0;
    if (tagGroup && tagGroup.items && tagGroup.items.length) {
      const id = getNodeImageIds(host)[clampedIndex];
      const found = tagGroup.items.findIndex(it =>
        it.nodeId === nodeId && (it.r ?? null) === r && (it.c ?? null) === c && it.id === id);
      tagIndex = found >= 0 ? found : 0;
    }
    photoModalState = {
      nodeId,
      cellPos: { r, c },
      index: clampedIndex,
      tagGroup: (tagGroup && tagGroup.items && tagGroup.items.length) ? tagGroup : null,
      tagIndex,
      ret: takeViewerReturn() || underlyingModalReturn(),
    };
    resetPhotoZoom();
    renderPhotoModal();
    zoomModalOpen(photoModal);
  }

  function openPhotoModal(nodeId, index, tagGroup) {
    const node = findNode(nodeId);
    const images = getNodeImages(node);
    if (!images.length) return;
    const clampedIndex = clamp(index || 0, 0, images.length - 1);
    let tagIndex = 0;
    if (tagGroup && tagGroup.items && tagGroup.items.length) {
      const id = getNodeImageIds(node)[clampedIndex];
      const found = tagGroup.items.findIndex(it =>
        it.nodeId === nodeId && it.r == null && it.c == null && it.id === id);
      tagIndex = found >= 0 ? found : 0;
    }
    photoModalState = {
      nodeId,
      index: clampedIndex,
      tagGroup: (tagGroup && tagGroup.items && tagGroup.items.length) ? tagGroup : null,
      tagIndex,
      // Where ← Back goes — see withViewerReturn. Kept on the state so it
      // survives stepping through the group with prev/next.
      ret: takeViewerReturn() || underlyingModalReturn(),
    };
    resetPhotoZoom();
    renderPhotoModal();
    zoomModalOpen(photoModal);
  }
  function renderPhotoModal() {
    if (!photoModalState) return;
    photoModalBack.title = viewerBackTitle(photoModalState.ret);
    photoModalBack.setAttribute("aria-label", photoModalBack.title);
    const liveNode = photoModalState.noteMode ? null : photoModalHost();
    const images = photoModalState.noteMode
      ? photoModalState.images
      : photoModalImages();
    if (!images.length) { closePhotoModal(); return; }
    if (photoModalState.index >= images.length) photoModalState.index = images.length - 1;

    const visibleSrc = images[photoModalState.index] || "";
    photoModalImg.src = visibleSrc;

    // If the map knows the photo id but this device has no bytes yet, fetch
    // just that one Drive photo now. This also fixes a stale photo-index cache
    // by forcing one fresh Drive listing before declaring the photo absent.
    if (!visibleSrc && !photoModalState.noteMode && liveNode && state.current && DriveDB.signedIn) {
      const visibleId = getNodeImageIds(liveNode)[photoModalState.index];
      const expectedNodeId = photoModalState.nodeId;
      const expectedCellPos = photoModalState.cellPos
        ? { r: photoModalState.cellPos.r, c: photoModalState.cellPos.c }
        : null;
      const expectedIndex = photoModalState.index;
      if (visibleId) {
        DriveDB.hydratePhotoById(state.current, visibleId, { forceIndex: true })
          .then((ok) => {
            if (!ok || !photoModalState || photoModalState.noteMode) return;
            const livePos = photoModalState.cellPos || null;
            if (photoModalState.nodeId !== expectedNodeId ||
                photoModalState.index !== expectedIndex ||
                (!!livePos !== !!expectedCellPos) ||
                (livePos && expectedCellPos && (livePos.r !== expectedCellPos.r || livePos.c !== expectedCellPos.c))) return;
            renderPhotoModal();
            try { renderAll(); } catch (e) {}
          })
          .catch((e) => console.warn("On-demand Drive photo load failed", e));
      }
    }
    const group = photoModalState.tagGroup;
    photoModalGoto.classList.toggle("hidden", !group && !photoModalState.cellPos);
    if (group) {
      const n = group.items.length;
      const multi = n > 1;
      photoModalPrev.classList.toggle("hidden", !multi);
      photoModalNext.classList.toggle("hidden", !multi);
      photoModalCount.classList.toggle("hidden", !multi);
      photoModalCount.textContent = multi ? `${photoModalState.tagIndex + 1} / ${n} · ${group.label}` : "";
    } else {
      const multi = images.length > 1;
      photoModalPrev.classList.toggle("hidden", !multi);
      photoModalNext.classList.toggle("hidden", !multi);
      photoModalCount.classList.toggle("hidden", !multi);
      photoModalCount.textContent = multi ? `${photoModalState.index + 1} / ${images.length}` : "";
    }
    // Tags, comments, crop, and favoriting all read/write a per-photo
    // record keyed by an id that only exists for photos actually
    // attached to a node (see getPhotoTags/getPhotoComment etc.) — an
    // image just pasted inline into a note has no such record, so those
    // controls are hidden rather than rendered against a missing node.
    // The text-label tool (and its number-symbol shortcut) is the
    // exception: it bakes the label straight into the photo's pixels and
    // writes the result back into the note's own HTML (see startAddText
    // and its noteMode branch below), so it works here too.
    const notePhoto = !!photoModalState.noteMode;
    photoModalTags.style.display = notePhoto ? "none" : "";
    photoModalCommentRow.style.display = notePhoto ? "none" : "";
    photoModalDelete.style.display = notePhoto ? "none" : "";
    if (photoModalFolder) photoModalFolder.style.display = notePhoto ? "none" : "";
    photoModalCrop.style.display = notePhoto ? "none" : "";
    photoModalText.style.display = "";
    photoModalSymbol.style.display = "";
    // Combine works in note mode too: like the text tool, it bakes a new
    // image and writes it straight back (see replacePhotoModalImage).
    photoModalCombine.style.display = "";
    photoModalFavorite.style.display = notePhoto ? "none" : "";
    closePhotoSymbolPopover();
    closePhotoCombinePopover();
    if (notePhoto) return;
    renderPhotoModalTags();
    renderPhotoModalComment();
    renderPhotoModalFavorite();
    updatePhotoModalFolderUI();
  }

  // Same 📁-with-a-dot idea as the note editor's folder button — see
  // updateNoteFolderUI — keyed by the photo's own id (getNodeImageIds),
  // the same id the Photos browser files it under.
  function updatePhotoModalFolderUI() {
    if (!photoModalFolder || !photoModalState || photoModalState.noteMode) return;
    const node = photoModalHost();
    const id = node && getNodeImageIds(node)[photoModalState.index];
    // Hidden once starred — same reasoning as the Photos browser's own
    // rows: syncPhotosFavoriteFolderAssignments (which runs the next
    // time the Photos browser itself renders) will claim this photo for
    // Favorite regardless, so offering a manual choice here would just
    // be undone.
    const fav = id && getPhotoFavorite(node, id);
    photoModalFolder.classList.toggle("hidden", !!fav);
    if (fav) return;
    const folder = id ? photosFolderMgr.folderOf(id) : null;
    photoModalFolder.title = folder ? `In folder: ${folder}` : "Move to folder";
    photoModalFolder.classList.toggle("has-folder", !!folder);
  }

  // Syncs the ☆/★ favorite button to match whichever photo is currently
  // shown — called whenever the visible photo changes (see
  // renderPhotoModal) so stepping through the gallery doesn't leave one
  // photo's star showing on a different photo.
  function renderPhotoModalFavorite() {
    if (!photoModalState || photoModalState.noteMode) return;
    const node = photoModalHost();
    const id = node && getNodeImageIds(node)[photoModalState.index];
    const fav = getPhotoFavorite(node, id);
    photoModalFavorite.textContent = fav ? "★" : "☆";
    photoModalFavorite.classList.toggle("favorited", fav);
    photoModalFavorite.title = fav ? "Remove from favorites" : "Add to favorites";
    photoModalFavorite.setAttribute("aria-label", photoModalFavorite.title);
  }

  // Opens the same lightbox used for a node's attached photos, but for an
  // image pasted/inserted directly inline into the note editor instead —
  // clicking any photo in a note shows it full-size here, with prev/next
  // stepping through the other images in that same note if there are
  // more than one. Tags/comments/crop/delete don't apply (see the
  // notePhoto branch in renderPhotoModal above) since there's no
  // per-node attach record backing an inline note image.
  function openNotePhotoViewer(imgEl, container = noteTextarea) {
    const imgs = Array.from(container.querySelectorAll("img"));
    const index = imgs.indexOf(imgEl);
    if (index < 0) return;
    photoModalState = {
      noteMode: true,
      images: imgs.map(im => im.src),
      index,
      ret: { label: "note", restore: null }, // the note editor is still open underneath
    };
    // The note editor's modal is deliberately raised above the shared
    // modal z-index (see #note-modal in style.css) so it can be opened
    // on top of the tasks/calendar modals — which otherwise leaves it
    // sitting on top of the photo viewer too, covering up the very photo
    // just clicked. This class bumps the photo modal one level above
    // that for just this flow; removed again on close.
    photoModal.classList.add("photo-modal-above-note");
    resetPhotoZoom();
    renderPhotoModal();
    zoomModalOpen(photoModal);
  }
  // Fills the comment box with whichever photo is currently shown, same
  // auto-growing paragraph textarea as the video modal's inline comment
  // box (see autoGrowTextarea) — called whenever the visible photo
  // changes so stepping through the gallery doesn't leave one photo's
  // comment showing under a different photo.
  function renderPhotoModalComment() {
    if (!photoModalState || photoModalState.noteMode) return;
    const node = photoModalHost();
    const id = node && getNodeImageIds(node)[photoModalState.index];
    const comment = getPhotoComment(node, id);
    photoModalCommentInput.value = comment;
    // The comment box stays collapsed by default (see .photo-modal-
    // comment-row.hidden) — only auto-opened here when the photo being
    // shown already has a saved comment, so existing comments are never
    // hidden from view; an empty photo starts collapsed until the 💬
    // toggle button is clicked. Re-evaluated every time the visible
    // photo changes so stepping through the gallery doesn't leave one
    // photo's open/closed state stuck on the next one.
    photoModalCommentRow.classList.toggle("hidden", !comment);
    photoModalCommentToggle.classList.toggle("has-comment", !!comment);
    requestAnimationFrame(() => autoGrowTextarea(photoModalCommentInput));
  }
  // Saves on blur (clicking/tabbing away, including stepping to the next/
  // prev photo) and on Ctrl/Cmd+Enter — same "commit when you're done
  // typing" behavior as the video modal's comment box.
  function savePhotoModalComment() {
    if (!photoModalState || photoModalState.noteMode) return;
    const node = photoModalHost();
    const id = node && getNodeImageIds(node)[photoModalState.index];
    if (!node || !id) return;
    if (getPhotoComment(node, id) === photoModalCommentInput.value.trim()) return;
    pushUndo();
    setPhotoComment(node, id, photoModalCommentInput.value);
    photoModalCommentToggle.classList.toggle("has-comment", !!getPhotoComment(node, id));
    persist();
  }
  // 💬 toggle button — the comment box is collapsed by default (see
  // renderPhotoModalComment), so this is the only way to open it for a
  // photo that doesn't have a comment yet. Clicking again while open
  // collapses it back (but only if there's nothing typed, so an in-
  // progress comment can't be accidentally hidden without saving —
  // blur/Ctrl+Enter still commit it first either way).
  photoModalCommentToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const willShow = photoModalCommentRow.classList.contains("hidden");
    if (willShow) {
      photoModalCommentRow.classList.remove("hidden");
      requestAnimationFrame(() => { photoModalCommentInput.focus(); autoGrowTextarea(photoModalCommentInput); });
    } else if (!photoModalCommentInput.value.trim()) {
      photoModalCommentRow.classList.add("hidden");
    }
  });
  photoModalCommentInput.addEventListener("blur", savePhotoModalComment);
  photoModalCommentInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); photoModalCommentInput.blur(); }
  });
  photoModalCommentInput.addEventListener("input", () => autoGrowTextarea(photoModalCommentInput));
  // Renders the tag chips for whichever photo is currently shown, plus
  // clears the "add a tag" input so it doesn't carry text over between
  // photos as you step through the gallery.
  function renderPhotoModalTags() {
    if (!photoModalState) return;
    const node = photoModalHost();
    const id = node && getNodeImageIds(node)[photoModalState.index];
    photoModalTagChips.innerHTML = "";
    getPhotoTags(node, id).forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "photo-modal-tag-chip";
      const label = document.createElement("span");
      label.textContent = tag;
      chip.appendChild(label);
      const remove = document.createElement("button");
      remove.className = "photo-modal-tag-chip-remove";
      remove.type = "button";
      remove.textContent = "✕";
      remove.title = `Remove tag "${tag}"`;
      remove.setAttribute("aria-label", `Remove tag ${tag}`);
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        removePhotoTag(node, id, tag);
        persist();
        renderPhotoModalTags();
      });
      chip.appendChild(remove);
      photoModalTagChips.appendChild(chip);
    });
    photoModalTagInput.value = "";
    hideTagSuggestions();
  }
  function closePhotoModal() {
    savePhotoModalComment();
    closePhotoSymbolPopover();
    closePhotoCombinePopover();
    cancelCombinePaste();
    photoModalState = null;
    photoModal.classList.remove("photo-modal-above-note");
    zoomModalClose(photoModal, () => {
      photoModalImg.src = "";
      resetPhotoZoom();
    });
  }
  function stepPhotoModal(delta) {
    if (!photoModalState) return;
    if (photoModalState.noteMode) {
      const images = photoModalState.images;
      if (!images.length) return;
      photoModalState.index = (photoModalState.index + delta + images.length) % images.length;
      resetPhotoZoom();
      renderPhotoModal();
      return;
    }
    savePhotoModalComment();
    const group = photoModalState.tagGroup;
    if (group) {
      const n = group.items.length;
      if (!n) return;
      const prevNodeId = photoModalState.nodeId;
      for (let tries = 0; tries < n; tries++) {
        photoModalState.tagIndex = (photoModalState.tagIndex + delta + n) % n;
        const it = group.items[photoModalState.tagIndex];
        const node = findNode(it.nodeId);
        if (!node) continue;
        const host = (it.r != null && it.c != null && node.table)
          ? getCellAttach(node, it.r, it.c)
          : node;
        const idx = getNodeImageIds(host).indexOf(it.id);
        if (idx < 0) continue;
        photoModalState.nodeId = it.nodeId;
        photoModalState.cellPos = it.r != null && it.c != null ? { r: it.r, c: it.c } : null;
        photoModalState.index = idx;
        break;
      }
      resetPhotoZoom();
      renderPhotoModal();
      if (photoModalState.nodeId !== prevNodeId) focusNodeInCanvas(photoModalState.nodeId);
      return;
    }
    const images = photoModalImages();
    if (!images.length) return;
    photoModalState.index = (photoModalState.index + delta + images.length) % images.length;
    resetPhotoZoom();
    renderPhotoModal();
  }
  photoModalClose.addEventListener("click", closePhotoModal);
  photoModalBack.addEventListener("click", (e) => {
    e.stopPropagation();
    const ret = photoModalState && photoModalState.ret;
    closePhotoModal();
    runViewerReturn(ret);
  });
  photoModalPrev.addEventListener("click", (e) => { e.stopPropagation(); stepPhotoModal(-1); });
  photoModalNext.addEventListener("click", (e) => { e.stopPropagation(); stepPhotoModal(1); });
  photoModalGoto.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!photoModalState) return;
    const nodeId = photoModalState.nodeId;
    const cellPos = photoModalState.cellPos
      ? { nodeId, r: photoModalState.cellPos.r, c: photoModalState.cellPos.c }
      : null;
    closePhotoModal();
    if (cellPos) {
      state.selectedCell = cellPos;
      state.cellRangeAnchor = cellPos;
      state.cellRange = null;
    }
    focusNodeInCanvas(nodeId);
  });
  photoModalFavorite.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!photoModalState || photoModalState.noteMode) return;
    const node = photoModalHost();
    const id = node && getNodeImageIds(node)[photoModalState.index];
    if (!node || !id) return;
    pushUndo();
    togglePhotoFavorite(node, id);
    persist();
    renderPhotoModalFavorite();
    updatePhotoModalFolderUI();
  });
  // Zoom buttons — same centered zoom math as the scroll-wheel handler
  // below, just anchored to the image's center instead of the cursor.
  function zoomPhotoBy(factor) {
    if (!photoModalState) return;
    const prevScale = photoZoom.scale;
    const newScale = clamp(prevScale * factor, PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
    if (newScale === prevScale) return;
    const scaleFactor = newScale / prevScale;
    photoZoom.tx *= scaleFactor;
    photoZoom.ty *= scaleFactor;
    photoZoom.scale = newScale;
    if (photoZoom.scale === PHOTO_ZOOM_MIN) { photoZoom.tx = 0; photoZoom.ty = 0; }
    applyPhotoZoom();
  }
  photoModalZoomIn.addEventListener("click", (e) => { e.stopPropagation(); zoomPhotoBy(1.4); });
  photoModalZoomOut.addEventListener("click", (e) => { e.stopPropagation(); zoomPhotoBy(1 / 1.4); });
  if (photoModalFolder) {
    photoModalFolder.addEventListener("mousedown", (e) => e.preventDefault());
    photoModalFolder.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!photoModalState || photoModalState.noteMode) return;
      const node = photoModalHost();
      const id = node && getNodeImageIds(node)[photoModalState.index];
      if (!id) return;
      openFolderMovePopover(photoModalFolder, photosFolderMgr, id, updatePhotoModalFolderUI);
    });
  }
  photoModalDelete.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!photoModalState || photoModalState.noteMode) return;
    const node = photoModalHost();
    if (!node) return;
    const ids = getNodeImageIds(node);
    if (!ids.length) return;
    const deletedId = ids[photoModalState.index];
    pushUndo();
    ids.splice(photoModalState.index, 1);
    node.images = ids;
    node.image = null;
    setPhotoTags(node, deletedId, null);
    setPhotoNotes(node, deletedId, null);
    setPhotoComment(node, deletedId, null);
    setPhotoFavorite(node, deletedId, false);
    setPhotoTimestamp(node, deletedId, null);
    deletePhotoRecord(deletedId);
    // Keep the tag group's item list in sync so prev/next doesn't try to
    // step onto the photo we just deleted.
    if (photoModalState.tagGroup) {
      const gi = photoModalState.tagGroup.items.findIndex(
        it => photoGroupItemMatches(it, photoModalState.nodeId, photoModalState.cellPos, deletedId)
      );
      if (gi >= 0) {
        photoModalState.tagGroup.items.splice(gi, 1);
        if (photoModalState.tagIndex > gi) photoModalState.tagIndex--;
      }
    }
    renderAll();
    persist();
    if (!ids.length) {
      if (photoModalState.tagGroup && photoModalState.tagGroup.items.length) {
        // This node's photos are gone but the tag group still has others —
        // step to the next one instead of closing.
        photoModalState.tagIndex = clamp(photoModalState.tagIndex - 1, 0, photoModalState.tagGroup.items.length - 1);
        stepPhotoModal(1);
      } else {
        closePhotoModal();
      }
    } else {
      renderPhotoModal();
    }
  });
  photoModal.addEventListener("click", (e) => {
    if (e.target !== photoModal || cropping || addingText) return;
    closePhotoModal();
  });
  document.addEventListener("keydown", (e) => {
    if (photoModal.classList.contains("hidden")) return;
    // Let the tag input handle its own keys (its own listener below adds
    // the tag on Enter and blurs on Escape) — don't let this steal
    // Escape to close the whole modal or the arrow keys while typing a
    // tag. (The note editor, opened via the 📝 button, is a separate
    // top-level modal with its own Escape/keydown handling — see
    // noteTextarea/noteTitleInput below — so it doesn't need handling
    // here.)
    if (e.target === photoModalTagInput) return;
    if (e.key === "Escape") { if (cropping) cropCleanup(); else if (addingText) textCleanup(); else closePhotoModal(); }
    else if (cropping || addingText) return;
    else if (e.key === "ArrowLeft") stepPhotoModal(-1);
    else if (e.key === "ArrowRight") stepPhotoModal(1);
  });

  // ---- Tagging ----
  // Enter adds the typed tag to the currently displayed photo (or, if a
  // suggestion is highlighted, adds that suggestion instead); Escape
  // closes the suggestion list first, then just clears/blurs the field
  // rather than closing the whole modal.
  let tagSuggestActiveIndex = -1;

  function getAllPhotoTagLabels() {
    return collectPhotoTagGroups().map(g => g.label);
  }
  function hideTagSuggestions() {
    photoModalTagSuggest.classList.add("hidden");
    photoModalTagSuggest.innerHTML = "";
    tagSuggestActiveIndex = -1;
  }
  function setTagSuggestActive(index) {
    const items = photoModalTagSuggest.children;
    tagSuggestActiveIndex = index;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle("active", i === index);
  }
  function applyTagSuggestion(tag) {
    if (!photoModalState) return;
    const node = findNode(photoModalState.nodeId);
    const id = node ? getNodeImageIds(node)[photoModalState.index] : null;
    if (!node || !id) return;
    const existing = getPhotoTags(node, id);
    if (existing.some(t => t.toLowerCase() === tag.toLowerCase())) { hideTagSuggestions(); return; }
    pushUndo();
    addPhotoTag(node, id, tag);
    persist();
    renderPhotoModalTags();
    photoModalTagInput.focus();
  }
  // Suggests tags already used elsewhere in the map — filtered by what's
  // typed so far, and never a tag already on this photo — so repeat tags
  // (e.g. #receipt, #before/#after) can be added with one click instead
  // of retyping them each time.
  function renderTagSuggestions() {
    if (!photoModalState) { hideTagSuggestions(); return; }
    const node = findNode(photoModalState.nodeId);
    const id = node ? getNodeImageIds(node)[photoModalState.index] : null;
    if (!node || !id) { hideTagSuggestions(); return; }
    const q = (photoModalTagInput.value || "").trim().toLowerCase();
    const existing = new Set(getPhotoTags(node, id).map(t => t.toLowerCase()));
    let matches = getAllPhotoTagLabels().filter(t => !existing.has(t.toLowerCase()));
    if (q) matches = matches.filter(t => t.toLowerCase().includes(q));
    matches = matches.slice(0, 6);
    if (!matches.length) { hideTagSuggestions(); return; }
    photoModalTagSuggest.innerHTML = "";
    matches.forEach((tag) => {
      const li = document.createElement("li");
      li.textContent = tag;
      // mousedown + preventDefault (not click) so this fires before the
      // input blurs — otherwise the blur handler below would hide the
      // list right out from under the click.
      li.addEventListener("mousedown", (e) => { e.preventDefault(); applyTagSuggestion(tag); });
      photoModalTagSuggest.appendChild(li);
    });
    tagSuggestActiveIndex = -1;
    photoModalTagSuggest.classList.remove("hidden");
  }
  photoModalTagInput.addEventListener("input", renderTagSuggestions);
  photoModalTagInput.addEventListener("focus", renderTagSuggestions);
  photoModalTagInput.addEventListener("blur", () => setTimeout(hideTagSuggestions, 120));
  photoModalTagInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    const suggestVisible = !photoModalTagSuggest.classList.contains("hidden");
    if (suggestVisible && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = photoModalTagSuggest.children.length;
      if (!n) return;
      const next = e.key === "ArrowDown"
        ? (tagSuggestActiveIndex + 1) % n
        : (tagSuggestActiveIndex - 1 + n) % n;
      setTagSuggestActive(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestVisible && tagSuggestActiveIndex >= 0) {
        const active = photoModalTagSuggest.children[tagSuggestActiveIndex];
        if (active) { applyTagSuggestion(active.textContent); return; }
      }
      if (!photoModalState) return;
      const node = photoModalHost();
      const id = node ? getNodeImageIds(node)[photoModalState.index] : null;
      if (!node || !id) return;
      const clean = (photoModalTagInput.value || "").trim();
      if (!clean) return;
      const existing = getPhotoTags(node, id);
      if (existing.some(t => t.toLowerCase() === clean.toLowerCase())) {
        photoModalTagInput.value = "";
        hideTagSuggestions();
        return;
      }
      pushUndo();
      addPhotoTag(node, id, clean);
      persist();
      renderPhotoModalTags();
      photoModalTagInput.focus();
    } else if (e.key === "Escape") {
      if (suggestVisible) { hideTagSuggestions(); return; }
      photoModalTagInput.value = "";
      photoModalTagInput.blur();
    }
  });
  // Clicks/drags inside the tag bar shouldn't fall through to the
  // image's own zoom/pan handling or close the modal.
  photoModalTags.addEventListener("mousedown", (e) => e.stopPropagation());
  photoModalTags.addEventListener("click", (e) => e.stopPropagation());

  // ---- Crop ----
  // Lets the user drag out a rectangle over the currently displayed photo
  // and replace it with just that region. Built with plain absolutely-
  // positioned elements over the image rather than a canvas overlay, so
  // it stays crisp at any zoom and needs no extra markup in index.html.
  photoModalCrop.addEventListener("click", (e) => {
    e.stopPropagation();
    if (addingText || (photoModalState && photoModalState.noteMode)) return;
    startCrop();
  });
  photoModalText.addEventListener("click", (e) => {
    e.stopPropagation();
    if (cropping) return;
    if (addingText) { if (rearmTextPlacement) rearmTextPlacement(); return; }
    startAddText();
  });

  function startCrop() {
    if (cropping || !photoModalState) return;
    resetPhotoZoom();
    const node = photoModalHost();
    const images = getNodeImages(node);
    const src = images[photoModalState.index];
    if (!src) return;

    cropping = true;
    const card = photoModal.querySelector(".photo-modal-card");
    const img = photoModalImg;
    const iw = img.offsetWidth, ih = img.offsetHeight;

    // Hide everything except the image and the crop controls while
    // cropping — the whole top/bottom toolbars (not just a few individual
    // buttons), so nothing from either one is left dangling on screen
    // mid-crop.
    const hiddenWhileCropping = [photoModalPrev, photoModalNext, photoModalToolbarTop, photoModalToolbarBottom];
    hiddenWhileCropping.forEach(el => { el.dataset.prevDisplay = el.style.display; el.style.display = "none"; });

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute", left: img.offsetLeft + "px", top: img.offsetTop + "px",
      width: iw + "px", height: ih + "px",
      overflow: "hidden", borderRadius: "10px", zIndex: "5", touchAction: "none"
    });

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute", boxSizing: "border-box",
      border: "2px solid #fff",
      boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)",
      cursor: "move", touchAction: "none"
    });
    overlay.appendChild(box);

    let rect = { x: iw * 0.1, y: ih * 0.1, w: iw * 0.8, h: ih * 0.8 };
    const minSize = 24;

    const handles = {};
    ["nw", "ne", "sw", "se"].forEach(pos => {
      const h = document.createElement("div");
      Object.assign(h.style, {
        position: "absolute", width: "14px", height: "14px", background: "#fff",
        border: "2px solid var(--accent, #7c9eff)", borderRadius: "50%",
        touchAction: "none",
        cursor: (pos === "nw" || pos === "se") ? "nwse-resize" : "nesw-resize"
      });
      if (pos.includes("n")) h.style.top = "-8px"; else h.style.bottom = "-8px";
      if (pos.includes("w")) h.style.left = "-8px"; else h.style.right = "-8px";
      box.appendChild(h);
      handles[pos] = h;
    });

    function applyRect() {
      box.style.left = rect.x + "px";
      box.style.top = rect.y + "px";
      box.style.width = rect.w + "px";
      box.style.height = rect.h + "px";
    }
    applyRect();

    let dragMode = null, dragStart = null;
    function onPointerDown(e, mode) {
      e.preventDefault(); e.stopPropagation();
      dragMode = mode;
      dragStart = { x: e.clientX, y: e.clientY, rect: { ...rect } };
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    }
    function onPointerMove(e) {
      if (!dragMode) return;
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      const s = dragStart.rect;
      if (dragMode === "move") {
        rect = { ...s, x: clamp(s.x + dx, 0, iw - s.w), y: clamp(s.y + dy, 0, ih - s.h) };
      } else {
        let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
        if (dragMode.includes("w")) left = clamp(s.x + dx, 0, right - minSize);
        if (dragMode.includes("e")) right = clamp(s.x + s.w + dx, left + minSize, iw);
        if (dragMode.includes("n")) top = clamp(s.y + dy, 0, bottom - minSize);
        if (dragMode.includes("s")) bottom = clamp(s.y + s.h + dy, top + minSize, ih);
        rect = { x: left, y: top, w: right - left, h: bottom - top };
      }
      applyRect();
    }
    function onPointerUp() {
      dragMode = null;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    }
    box.addEventListener("pointerdown", (e) => { if (e.target === box) onPointerDown(e, "move"); });
    Object.entries(handles).forEach(([pos, h]) => h.addEventListener("pointerdown", (e) => onPointerDown(e, pos)));

    const toolbar = document.createElement("div");
    Object.assign(toolbar.style, {
      position: "absolute", left: "50%", bottom: "-52px", transform: "translateX(-50%)",
      display: "flex", gap: "10px", zIndex: "6", whiteSpace: "nowrap"
    });
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "btn-ghost"; cancelBtn.textContent = "Cancel";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button"; applyBtn.className = "btn-primary"; applyBtn.textContent = "Apply crop";
    toolbar.appendChild(cancelBtn);
    toolbar.appendChild(applyBtn);

    card.appendChild(overlay);
    card.appendChild(toolbar);

    function cleanup() {
      onPointerUp();
      overlay.remove();
      toolbar.remove();
      hiddenWhileCropping.forEach(el => { el.style.display = el.dataset.prevDisplay || ""; delete el.dataset.prevDisplay; });
      cropping = false;
      cropCleanup = null;
      renderPhotoModal();
    }
    cropCleanup = cleanup;
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); cleanup(); });

    applyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const scaleX = img.naturalWidth / iw, scaleY = img.naturalHeight / ih;
      const sx = Math.round(rect.x * scaleX), sy = Math.round(rect.y * scaleY);
      const sw = Math.round(rect.w * scaleX), sh = Math.round(rect.h * scaleY);
      if (sw < 2 || sh < 2) { cleanup(); return; }

      const canvas = document.createElement("canvas");
      canvas.width = sw; canvas.height = sh;
      canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const isPng = src.startsWith("data:image/png");
      const croppedUrl = encodePhotoCanvas(canvas, isPng ? "image/png" : "image/jpeg", sw * sh, 1.0);

      const liveNode = photoModalHost();
      const liveIds = getNodeImageIds(liveNode);
      if (liveNode && liveIds.length) {
        pushUndo();
        // A crop replaces the photo's actual bytes, so it gets a new id
        // (the old id/record is retired) — its tags carry over onto the
        // new id since it's still conceptually "the same" photo.
        const newId = addPhotoRecord(croppedUrl, { noDedupe: true });
        const oldId = liveIds[photoModalState.index];
        carryPhotoTags(liveNode, liveNode, [[oldId, newId]]);
        carryPhotoNotes(liveNode, liveNode, [[oldId, newId]]);
        carryPhotoComments(liveNode, liveNode, [[oldId, newId]]);
        carryPhotoFavorites(liveNode, liveNode, [[oldId, newId]]);
        carryPhotoTimestamps(liveNode, liveNode, [[oldId, newId]]);
        setPhotoTags(liveNode, oldId, null);
        setPhotoNotes(liveNode, oldId, null);
        setPhotoComment(liveNode, oldId, null);
        setPhotoTimestamp(liveNode, oldId, null);
        liveIds[photoModalState.index] = newId;
        liveNode.images = liveIds;
        liveNode.image = null;
        deletePhotoRecord(oldId); // after the old reference is gone, so a shared id is kept if another node still uses it
        renderAll();
        persist();
      }
      cleanup();
    });
  }

  // ---- Add text ----
  // Click anywhere on the photo to drop a short editable label, drag it
  // into place, pick a color/size, add as many as you like, then Apply
  // bakes every label into the photo as real pixels (so it travels with
  // exports/screenshots like any other part of the image).
  function isLightColor(hex) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), b = parseInt(c.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
  }

  function startAddText(initialSymbol) {
    if (addingText || cropping || !photoModalState) return;
    // Deliberately does NOT reset the zoom (crop still does): zooming in
    // and then labelling a fine detail is exactly the case this tool is
    // most useful for, so the overlay below just mirrors whatever
    // pan/zoom is currently applied to the image instead.
    // A note-photo session (see openNotePhotoViewer) has no backing node —
    // its images live only in photoModalState.images, taken straight from
    // the note's own <img> elements — so read from there instead of the
    // node's attached-photo list.
    const node = photoModalState.noteMode ? null : photoModalHost();
    const images = photoModalState.noteMode ? photoModalState.images : getNodeImages(node);
    const src = images[photoModalState.index];
    if (!src) return;

    addingText = true;
    const card = photoModal.querySelector(".photo-modal-card");
    const img = photoModalImg;
    const iw = img.offsetWidth, ih = img.offsetHeight;

    // Same full-toolbar hide as startCrop above, so the add-text overlay
    // doesn't leave the favorite/comment/zoom/goto buttons floating on
    // top of it either.
    const hiddenWhileAddingText = [photoModalPrev, photoModalNext, photoModalToolbarTop, photoModalToolbarBottom];
    hiddenWhileAddingText.forEach(el => { el.dataset.prevDisplay = el.style.display; el.style.display = "none"; });

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute", left: img.offsetLeft + "px", top: img.offsetTop + "px",
      width: iw + "px", height: ih + "px",
      overflow: "hidden", borderRadius: "10px", zIndex: "5", cursor: "text", touchAction: "none",
      // Same box and same origin as the image, so copying the image's
      // transform verbatim (see syncOverlayZoom) lands the overlay exactly
      // on top of it at any zoom/pan.
      transformOrigin: "50% 50%"
    });

    // Everything inside the overlay — box.x/box.y, font sizes, the baked
    // canvas math in Apply — stays in the image's *unzoomed* display
    // coordinates. The zoom is purely a transform on the overlay itself,
    // so nothing downstream has to care about it; only the handful of
    // places that read raw screen pixels (click placement, drag deltas,
    // resize deltas) divide by the scale to convert back.
    function syncOverlayZoom() {
      overlay.style.transform = photoZoom.scale === 1
        ? ""
        : `translate(${photoZoom.tx}px, ${photoZoom.ty}px) scale(${photoZoom.scale})`;
      boxes.forEach(sizeHandles);
    }

    // The overlay's transform scales its children too, which would blow
    // the little ✕/grab/resize dots up to thumb-sized blobs at 6x — so
    // their sizes and corner offsets are divided back down by the scale,
    // keeping them the same physical size on screen at every zoom level.
    function sizeHandles(box) {
      const inv = 1 / photoZoom.scale;
      const d = 18 * inv, off = -10 * inv, bw = 1.5 * inv;
      Object.assign(box.del.style, {
        width: d + "px", height: d + "px", top: off + "px", right: off + "px",
        fontSize: (10 * inv) + "px", borderWidth: bw + "px"
      });
      Object.assign(box.grab.style, {
        width: d + "px", height: d + "px", top: off + "px", left: off + "px",
        fontSize: (11 * inv) + "px", borderWidth: bw + "px"
      });
      Object.assign(box.resize.style, {
        width: (14 * inv) + "px", height: (14 * inv) + "px",
        bottom: (-8 * inv) + "px", right: (-8 * inv) + "px", borderWidth: (2 * inv) + "px"
      });
      // The selected-box dashes come from .bl-text-box-active in the
      // stylesheet; these inline widths override them so the dashes don't
      // thicken into a solid band at high zoom.
      box.wrap.style.outlineWidth = (1.5 * inv) + "px";
      box.wrap.style.outlineOffset = (3 * inv) + "px";
    }

    // Where the centre of the *visible* (zoomed) region falls in overlay-
    // local coordinates — so a dropped symbol lands in view rather than
    // at the photo's true centre, which may be far off-screen at 4x.
    function visibleCenter() {
      const s = photoZoom.scale;
      return { x: iw / 2 - photoZoom.tx / s, y: ih / 2 - photoZoom.ty / s };
    }

    const TEXT_COLORS = ["#e0433a", "#ffffff", "#2b2a25", "#f5b301", "#4a9e4a", "#4a72d6"];
    let currentColor = TEXT_COLORS[0];
    let currentSize = 28; // px, at the displayed (not natural) scale
    const boxes = [];
    let activeBox = null;
    // Each click on the photo places exactly one box, then arms itself
    // off — click the "Aa" button again to place another.
    let placementArmed = true;
    photoModalText.classList.add("bl-text-armed");

    rearmTextPlacement = () => {
      placementArmed = true;
      photoModalText.classList.add("bl-text-armed");
    };

    // Declared here (rather than down by the toolbar it actually belongs
    // to) because selectBox — called below by dropSymbol as soon as a
    // number-symbol is placed — needs it immediately. A number-symbol
    // click supplies startAddText's initialSymbol and drops+selects a box
    // before the toolbar further down ever gets built, so defining
    // swatchEls there instead left it in the temporal dead zone at the
    // moment selectBox's syncSwatches() call ran — a ReferenceError that
    // aborted startAddText mid-setup, after it had already hidden the
    // modal's nav/close buttons and flipped addingText on, but before it
    // ever appended the overlay/toolbar (with the Cancel button) that
    // would have undone that. That's what left the photo viewer with
    // nothing left to click and no way to close it.
    const swatchEls = [];
    function syncSwatches() {
      swatchEls.forEach((sw, i) => {
        sw.style.border = TEXT_COLORS[i] === currentColor ? "2px solid var(--accent, #7c9eff)" : "1.5px solid rgba(255,255,255,0.4)";
      });
    }

    function deselectAll() {
      boxes.forEach(b => { b.wrap.classList.remove("bl-text-box-active"); if (b.del) b.del.style.display = "none"; if (b.resize) b.resize.style.display = "none"; if (b.grab) b.grab.style.display = "none"; });
      activeBox = null;
    }

    function selectBox(box) {
      deselectAll();
      activeBox = box;
      box.wrap.classList.add("bl-text-box-active");
      if (box.del) box.del.style.display = "flex";
      if (box.resize) box.resize.style.display = "block";
      if (box.grab) box.grab.style.display = "flex";
      currentColor = box.color;
      currentSize = box.size;
      syncSwatches();
    }

    function makeBox(x, y) {
      // Wrapper is NOT contenteditable and holds the text plus the del/
      // resize controls as siblings — keeping them out of the editable
      // node is what stops "select all + type" from wiping them out.
      const wrap = document.createElement("div");
      wrap.className = "bl-text-box";
      Object.assign(wrap.style, {
        position: "absolute", left: x + "px", top: y + "px",
        cursor: "move", touchAction: "none"
      });

      const el = document.createElement("div");
      el.contentEditable = "true";
      el.spellcheck = false;
      Object.assign(el.style, {
        color: currentColor, fontSize: currentSize + "px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontWeight: "700", lineHeight: "1.15", whiteSpace: "pre-wrap",
        padding: "4px 6px", minWidth: "16px", maxWidth: Math.max(40, iw - x) + "px",
        outline: "none", userSelect: "text",
        textShadow: "0 1px 3px rgba(0,0,0,0.65), 0 0 8px rgba(0,0,0,0.35)"
      });
      el.textContent = "Text";
      // Contenteditable's default Enter behavior inserts a wrapping <div>
      // or a <br> element rather than an actual newline character — so
      // el.textContent (what Apply reads, see the bake loop below) loses
      // every line break the browser drew, collapsing multi-line labels
      // back to one line. Inserting a literal "\n" text node ourselves
      // keeps textContent's line breaks in sync with what's on screen
      // (white-space: pre-wrap above is what renders that character as
      // a visible break).
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createTextNode("\n");
        range.insertNode(br);
        range.setStartAfter(br);
        range.setEndAfter(br);
        sel.removeAllRanges();
        sel.addRange(range);
      });
      wrap.appendChild(el);

      const del = document.createElement("button");
      del.type = "button"; del.textContent = "✕";
      Object.assign(del.style, {
        position: "absolute", top: "-10px", right: "-10px", width: "18px", height: "18px",
        borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.5)", background: "rgba(8,9,13,0.85)",
        color: "#fff", fontSize: "10px", lineHeight: "1", display: "none",
        alignItems: "center", justifyContent: "center", cursor: "pointer", padding: "0"
      });
      wrap.appendChild(del);

      // Corner handle — drag to scale the font size up/down, same idea as
      // the crop tool's resize handles.
      const resize = document.createElement("div");
      Object.assign(resize.style, {
        position: "absolute", bottom: "-8px", right: "-8px", width: "14px", height: "14px",
        borderRadius: "50%", background: "#fff", border: "2px solid var(--accent, #7c9eff)",
        display: "none", cursor: "nwse-resize", touchAction: "none"
      });
      wrap.appendChild(resize);

      // Grab handle — top-left corner, always moves the box no matter
      // where the text caret is. Without this, moving a label you're
      // actively editing means fighting the wrap's own pointerdown
      // handler (which lets a click land as a caret placement once the
      // box is already selected) — this handle sidesteps that entirely
      // by unconditionally starting a drag.
      const grab = document.createElement("div");
      grab.title = "Drag to move";
      grab.textContent = "⠿";
      Object.assign(grab.style, {
        position: "absolute", top: "-10px", left: "-10px", width: "18px", height: "18px",
        borderRadius: "50%", background: "rgba(8,9,13,0.85)", border: "1.5px solid rgba(255,255,255,0.5)",
        color: "#fff", fontSize: "11px", lineHeight: "1",
        display: "none", alignItems: "center", justifyContent: "center",
        cursor: "grab", touchAction: "none", userSelect: "none"
      });
      wrap.appendChild(grab);

      const box = { wrap, el, del, resize, grab, x, y, color: currentColor, size: currentSize };
      sizeHandles(box); // counter-scale the controls for the current zoom
      del.addEventListener("pointerdown", (e) => e.stopPropagation());
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = boxes.indexOf(box);
        if (idx >= 0) boxes.splice(idx, 1);
        wrap.remove();
        if (activeBox === box) activeBox = null;
      });

      let resizing = false, resizeStart = null, pendingResizeSize = null, resizeRafId = null;
      resize.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        selectBox(box);
        resizing = true;
        resizeStart = { x: e.clientX, y: e.clientY, size: box.size };
        document.addEventListener("pointermove", onResizeMove);
        document.addEventListener("pointerup", onResizeEnd);
      });
      function onResizeMove(e) {
        if (!resizing) return;
        // Divided by the zoom so a given hand movement changes the font by
        // the same *visual* amount at 1x and at 6x — at high zoom that
        // also makes fine adjustment of a small label possible, which is
        // the point of being able to label while zoomed in.
        const s = photoZoom.scale;
        const dx = (e.clientX - resizeStart.x) / s, dy = (e.clientY - resizeStart.y) / s;
        const delta = (dx + dy) / 2;
        pendingResizeSize = clamp(Math.round(resizeStart.size + delta), 6, 140);
        // Pointermove can fire far faster than the screen repaints (well
        // over 60/sec on a trackpad or high-poll-rate mouse). Writing
        // fontSize straight from every event forces the browser to
        // reflow this contentEditable box that often, which is what
        // made the resize feel laggy — so instead we just record the
        // latest target size and let one rAF apply it right before the
        // next paint, coalescing any events that arrived in between.
        if (resizeRafId == null) {
          resizeRafId = requestAnimationFrame(() => {
            resizeRafId = null;
            if (pendingResizeSize == null) return;
            box.size = pendingResizeSize;
            el.style.fontSize = box.size + "px";
            if (activeBox === box) { currentSize = box.size; }
          });
        }
      }
      function onResizeEnd() {
        resizing = false;
        if (resizeRafId != null) { cancelAnimationFrame(resizeRafId); resizeRafId = null; }
        // Apply whatever the final pointer position computed, even if it
        // hadn't been painted yet, so releasing mid-frame doesn't leave
        // the box one step behind where the pointer actually ended up.
        if (pendingResizeSize != null) {
          box.size = pendingResizeSize;
          el.style.fontSize = box.size + "px";
          if (activeBox === box) { currentSize = box.size; }
          pendingResizeSize = null;
        }
        document.removeEventListener("pointermove", onResizeMove);
        document.removeEventListener("pointerup", onResizeEnd);
      }

      let dragging = false, dragStart = null;
      // Whenever the text itself gains focus — whether from the native
      // click below, Tab, or a programmatic .focus() elsewhere — show it
      // as selected. Previously selectBox() only ran from inside
      // beginDrag()/dblclick, so a plain click that the browser handled
      // natively (see DRAG_CLICK_PX below) never lit up the handles.
      el.addEventListener("focus", () => selectBox(box));
      function beginDrag(e) {
        e.preventDefault(); e.stopPropagation();
        selectBox(box);
        dragging = true;
        dragStart = { x: e.clientX, y: e.clientY, bx: box.x, by: box.y };
        document.addEventListener("pointermove", onDrag);
        document.addEventListener("pointerup", onDragEnd);
      }
      // A plain mouse click on the label text is ambiguous: it might mean
      // "put the caret here" or "start dragging this box". We used to
      // resolve that by always dragging unless the box was already
      // focused — which meant a click on any box you weren't mid-edit in
      // could never just move the caret with the mouse. Now we let the
      // browser handle the click natively (so it focuses the box and
      // places the caret exactly where you clicked) and only hijack it
      // into a drag once the pointer actually travels past a small
      // threshold — the same click-vs-drag distinction most editors use.
      const DRAG_CLICK_PX = 4;
      wrap.addEventListener("pointerdown", (e) => {
        if (e.target !== el) { beginDrag(e); return; } // clicked the box's own frame, not its text — always drag
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const bx = box.x, by = box.y;
        let candidate = true;
        function onCandidateMove(ev) {
          if (!candidate) return;
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_CLICK_PX) return;
          candidate = false;
          document.removeEventListener("pointermove", onCandidateMove);
          document.removeEventListener("pointerup", onCandidateUp);
          // The browser may have started selecting text during the moved
          // mousedown; a real drag shouldn't leave a text selection behind.
          const sel = window.getSelection();
          if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
          selectBox(box);
          dragging = true;
          dragStart = { x: startX, y: startY, bx, by };
          document.addEventListener("pointermove", onDrag);
          document.addEventListener("pointerup", onDragEnd);
          onDrag(ev); // apply this move immediately so the box doesn't jump on the next event
        }
        function onCandidateUp() {
          candidate = false;
          document.removeEventListener("pointermove", onCandidateMove);
          document.removeEventListener("pointerup", onCandidateUp);
        }
        document.addEventListener("pointermove", onCandidateMove);
        document.addEventListener("pointerup", onCandidateUp);
      });
      // The grab handle always starts a drag immediately, even while the
      // box is selected and focused for editing — a guaranteed way to
      // move a label without needing to clear the caret first.
      grab.addEventListener("pointerdown", beginDrag);
      function onDrag(e) {
        if (!dragging) return;
        const s = photoZoom.scale;
        const dx = (e.clientX - dragStart.x) / s, dy = (e.clientY - dragStart.y) / s;
        box.x = clamp(dragStart.bx + dx, 0, Math.max(0, iw - wrap.offsetWidth));
        box.y = clamp(dragStart.by + dy, 0, Math.max(0, ih - wrap.offsetHeight));
        wrap.style.left = box.x + "px";
        wrap.style.top = box.y + "px";
      }
      function onDragEnd() {
        dragging = false;
        document.removeEventListener("pointermove", onDrag);
        document.removeEventListener("pointerup", onDragEnd);
      }
      wrap.addEventListener("dblclick", (e) => { e.stopPropagation(); selectBox(box); el.focus(); });

      overlay.appendChild(wrap);
      boxes.push(box);
      return box;
    }

    // Drops a number-symbol label onto the photo, already sized up and
    // centered/selected so it's immediately visible and ready to drag
    // into place — used both for the very first symbol (via
    // initialSymbol below) and for any further ones added while this
    // overlay session is still open (see addSymbolToActiveSession).
    function dropSymbol(ch) {
      // Scaled down by the zoom so the symbol looks the same size on
      // screen wherever you drop it, and lands in whatever part of the
      // photo you're actually looking at.
      const size = clamp(Math.round(56 / photoZoom.scale), 6, 140);
      const c = visibleCenter();
      const x = clamp(c.x - size / 2, 0, Math.max(0, iw - size));
      const y = clamp(c.y - size / 2, 0, Math.max(0, ih - size));
      currentSize = size;
      const box = makeBox(x, y);
      box.el.textContent = ch;
      box.size = size;
      box.el.style.fontSize = size + "px";
      selectBox(box);
    }
    addSymbolToActiveSession = dropSymbol;
    if (initialSymbol) {
      // A symbol is already placed, so an incidental click elsewhere on
      // the photo shouldn't drop an unrelated blank "Text" box — the Aa
      // button still re-arms plain text placement on demand.
      placementArmed = false;
      photoModalText.classList.remove("bl-text-armed");
      dropSymbol(initialSymbol);
    }

    // The overlay covers the image, so the image's own wheel/drag pan-zoom
    // handlers never see these events — re-implement them here so you can
    // keep zooming and panning around the photo mid-session, e.g. zoom
    // further in after placing one label to position the next.
    overlay.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      zoomPhotoAtPoint(e.clientX, e.clientY, e.deltaY);
    }, { passive: false });

    overlay.addEventListener("dblclick", (e) => {
      if (e.target !== overlay) return;
      e.stopPropagation();
      resetPhotoZoom();
    });

    let overlayPan = null;
    function onOverlayPanMove(e) {
      if (!overlayPan) return;
      photoZoom.tx = overlayPan.tx + (e.clientX - overlayPan.x);
      photoZoom.ty = overlayPan.ty + (e.clientY - overlayPan.y);
      applyPhotoZoom();
    }
    function onOverlayPanEnd() {
      overlayPan = null;
      overlay.style.cursor = "text";
      document.removeEventListener("pointermove", onOverlayPanMove);
      document.removeEventListener("pointerup", onOverlayPanEnd);
    }

    overlay.addEventListener("pointerdown", (e) => {
      if (e.target !== overlay) return; // a click landed on an existing box, not empty space
      if (!placementArmed) {
        // Click away just finishes the current label — and, while zoomed,
        // doubles as the drag-to-pan gesture, since the image underneath
        // can't receive it any more.
        deselectAll();
        if (photoZoom.scale > 1) {
          e.preventDefault();
          overlayPan = { x: e.clientX, y: e.clientY, tx: photoZoom.tx, ty: photoZoom.ty };
          overlay.style.cursor = "grabbing";
          document.addEventListener("pointermove", onOverlayPanMove);
          document.addEventListener("pointerup", onOverlayPanEnd);
        }
        return;
      }
      placementArmed = false;
      photoModalText.classList.remove("bl-text-armed");
      const rect = overlay.getBoundingClientRect();
      // rect is the *transformed* box, so divide the click's offset back
      // down into the image's own unzoomed coordinates.
      const s = photoZoom.scale;
      const x = clamp((e.clientX - rect.left) / s, 0, Math.max(0, iw - 20));
      const y = clamp((e.clientY - rect.top) / s, 0, Math.max(0, ih - 20));
      const box = makeBox(x, y);
      selectBox(box);
      requestAnimationFrame(() => {
        box.el.focus();
        const range = document.createRange();
        range.selectNodeContents(box.el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });

    // Bottom toolbar: color swatches + size picker apply to whichever box
    // is currently selected (or set the default for the next one placed).
    const toolbar = document.createElement("div");
    Object.assign(toolbar.style, {
      position: "absolute", left: "50%", bottom: "-56px", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "8px", zIndex: "6", whiteSpace: "nowrap"
    });

    // (swatchEls/syncSwatches now declared earlier, alongside the rest of
    // this session's state — see the comment there for why.)
    TEXT_COLORS.forEach(c => {
      const sw = document.createElement("button");
      sw.type = "button"; sw.title = c;
      Object.assign(sw.style, {
        width: "20px", height: "20px", borderRadius: "50%", background: c,
        border: "1.5px solid rgba(255,255,255,0.4)", cursor: "pointer", padding: "0"
      });
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        currentColor = c;
        if (activeBox) { activeBox.color = c; activeBox.el.style.color = c; }
        syncSwatches();
      });
      toolbar.appendChild(sw);
      swatchEls.push(sw);
    });
    syncSwatches();

    // The modal's own zoom buttons are hidden for the duration of this
    // session (see hiddenWhileAddingText), so mirror them here — scroll
    // still works, but a trackpad-less/touch user needs a button.
    [["−", 1 / 1.4], ["+", 1.4], ["1:1", 0]].forEach(([label, factor]) => {
      const zb = document.createElement("button");
      zb.type = "button"; zb.className = "btn-ghost";
      zb.textContent = label;
      zb.title = factor ? (factor > 1 ? "Zoom in" : "Zoom out") : "Reset zoom";
      Object.assign(zb.style, { padding: "2px 8px", fontSize: "12px", lineHeight: "1.4" });
      zb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (factor) zoomPhotoBy(factor); else resetPhotoZoom();
      });
      toolbar.appendChild(zb);
    });

    const sizeHint = document.createElement("span");
    sizeHint.textContent = "Drag a label's corner dot to resize";
    Object.assign(sizeHint.style, {
      color: "rgba(255,255,255,0.75)", fontSize: "12px", padding: "0 2px"
    });
    toolbar.appendChild(sizeHint);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "btn-ghost"; cancelBtn.textContent = "Cancel";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button"; applyBtn.className = "btn-primary"; applyBtn.textContent = "Apply text";
    toolbar.appendChild(cancelBtn);
    toolbar.appendChild(applyBtn);

    card.appendChild(overlay);
    card.appendChild(toolbar);
    // Follow every later zoom/pan (wheel, buttons, drag) for as long as
    // this session is open, and adopt the current one right now.
    onPhotoZoomChange = syncOverlayZoom;
    syncOverlayZoom();

    function cleanup() {
      onPhotoZoomChange = null;
      if (overlayPan) onOverlayPanEnd();
      overlay.remove();
      toolbar.remove();
      hiddenWhileAddingText.forEach(el => { el.style.display = el.dataset.prevDisplay || ""; delete el.dataset.prevDisplay; });
      photoModalText.classList.remove("bl-text-armed");
      addingText = false;
      textCleanup = null;
      rearmTextPlacement = null;
      addSymbolToActiveSession = null;
      renderPhotoModal();
    }
    textCleanup = cleanup;
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); cleanup(); });

    applyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const withText = boxes.filter(b => b.el.textContent.trim().length > 0);
      if (!withText.length) { cleanup(); return; }

      const scaleX = img.naturalWidth / iw, scaleY = img.naturalHeight / ih;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      withText.forEach(b => {
        const fontPx = Math.round(b.size * scaleY);
        ctx.font = `700 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.fillStyle = b.color;
        // Outline every glyph so the label stays readable no matter what
        // it's sitting on top of in the photo.
        ctx.strokeStyle = isLightColor(b.color) ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.75)";
        ctx.lineWidth = Math.max(2, fontPx * 0.06);
        const lines = b.el.textContent.split("\n");
        const lineHeight = fontPx * 1.15;
        lines.forEach((line, i) => {
          if (!line) return;
          const lx = b.x * scaleX + 6 * scaleX;
          const ly = b.y * scaleY + 4 * scaleY + i * lineHeight;
          ctx.strokeText(line, lx, ly);
          ctx.fillText(line, lx, ly);
        });
      });

      const isPng = src.startsWith("data:image/png");
      const outUrl = encodePhotoCanvas(canvas, isPng ? "image/png" : "image/jpeg", canvas.width * canvas.height, 1.0);

      if (photoModalState.noteMode) {
        // The baked-in image (with the label now part of its pixels) is a
        // fresh picture — gets its own PhotoDB record via addPhotoRecord
        // (same noDedupe rule the non-note branch below uses for crop/
        // text/combine edits), swapped onto the actual <img> element
        // sitting in the note editor's live DOM. commitNotesToNode() then
        // reads that updated innerHTML back into the note (see
        // captureActiveNote), same as any other in-note edit, and handles
        // its own pushUndo/persist; only once that's landed is the old
        // id's reference actually gone, so the old copy is freed after,
        // not before.
        const noteImgs = Array.from(noteTextarea.querySelectorAll("img"));
        const targetImg = noteImgs[photoModalState.index];
        let oldId = null;
        if (targetImg) {
          const newId = addPhotoRecord(outUrl, { noDedupe: true });
          oldId = targetImg.dataset.photoId;
          targetImg.dataset.photoId = newId;
          targetImg.src = photoUrl(newId);
        }
        photoModalState.images[photoModalState.index] = outUrl;
        commitNotesToNode();
        if (oldId) deletePhotoRecord(oldId);
      } else {
        const liveNode = photoModalHost();
        const liveIds = getNodeImageIds(liveNode);
        if (liveNode && liveIds.length) {
          pushUndo();
          const newId = addPhotoRecord(outUrl, { noDedupe: true });
          const oldId = liveIds[photoModalState.index];
          carryPhotoTags(liveNode, liveNode, [[oldId, newId]]);
          carryPhotoNotes(liveNode, liveNode, [[oldId, newId]]);
          carryPhotoComments(liveNode, liveNode, [[oldId, newId]]);
          carryPhotoFavorites(liveNode, liveNode, [[oldId, newId]]);
          carryPhotoTimestamps(liveNode, liveNode, [[oldId, newId]]);
          setPhotoTags(liveNode, oldId, null);
          setPhotoNotes(liveNode, oldId, null);
          setPhotoComment(liveNode, oldId, null);
          setPhotoTimestamp(liveNode, oldId, null);
          liveIds[photoModalState.index] = newId;
          liveNode.images = liveIds;
          liveNode.image = null;
          deletePhotoRecord(oldId); // after the old reference is gone, so a shared id is kept if another node still uses it
          renderAll();
          persist();
        }
      }
      cleanup();
    });
  }

