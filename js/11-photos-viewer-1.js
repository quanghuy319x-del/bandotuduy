/* Branchline — js/11-photos-viewer-1.js
   Part 11 of 19 of the former single-file app.js. Contents: node photo attachments.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- node photo attachments ---------------- */

  // WebP typically renders the same visual quality as JPEG at roughly
  // 25–35% of the file size, so we prefer it wherever the browser can
  // produce it. Feature-detected once (canvas.toDataURL silently falls
  // back to PNG in browsers that don't support the "image/webp" argument,
  // so we check the returned data: URL prefix rather than trusting the
  // call to throw).
  const WEBP_SUPPORTED = (() => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      return c.toDataURL("image/webp", 0.8).startsWith("data:image/webp");
    } catch (e) { return false; }
  })();

  // Central place that decides how a photo canvas gets encoded to a data
  // URL: PNG stays PNG (lossless, whatever the size), everything else
  // goes to WebP (lossless-ish at max quality) if the browser supports
  // it, or JPEG otherwise. `quality` is only used for the lossy formats —
  // callers pass 1.0 so cropping/annotating a photo doesn't add any
  // further compression loss on top of the edit itself.
  function encodePhotoCanvas(canvas, sourceType, pixelCount, quality) {
    if (sourceType === "image/png") return canvas.toDataURL("image/png");
    if (WEBP_SUPPORTED) return canvas.toDataURL("image/webp", quality);
    return canvas.toDataURL("image/jpeg", quality);
  }

  // ---- Zoom-from-icon open/close animation --------------------------
  // Shared by the photo, note, video and link-comment modals: instead of
  // just popping into view, each one grows out of whatever icon/button
  // was clicked to open it, and shrinks back into that same spot on
  // close — like an app icon expanding into its window. Every one of
  // these modals already funnels through a single open*/close* function
  // (openPhotoModal/closePhotoModal, openNoteModal/closeNoteModal, etc.),
  // so the animation lives entirely in those two helpers below rather
  // than needing to touch the many call sites scattered around the file.
  //
  // The origin point comes from the most recent pointerdown anywhere on
  // the page (tracked globally here), since that's whatever icon/marker
  // the user just clicked — no need to thread click coordinates through
  // every caller. Keyboard-triggered opens (no recent click) just fall
  // back to zooming in from the center of the screen.
  let zoomOriginX = null, zoomOriginY = null;
  document.addEventListener("pointerdown", (e) => {
    zoomOriginX = e.clientX;
    zoomOriginY = e.clientY;
  }, true);

  // Skips the animation (and the artificial close delay it needs) for
  // anyone with reduced-motion turned on at the OS level — the CSS above
  // already disables the visual transition for them; this just keeps
  // closing instant to match.
  const MODAL_ZOOM_MS = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : 260; // keep roughly in sync with the CSS transition durations above

  // Shows `modalEl` (a ".modal" backdrop containing one ".modal-card",
  // or another backdrop/card pair — pass `cardSelector` for those, e.g.
  // the calendar day popup's ".day-modal"), animating the card outward
  // from the last click position — the classic iOS "grow from the thing
  // you tapped" pop. With no recent click (keyboard-triggered opens) it
  // falls back to growing from the card's own center, which reads as a
  // plain centered pop/fade — still the same iPhone-style motion, just
  // without a specific origin to grow from.
  /* ---------------- viewer "← Back" navigation ---------------- */
  // The note editor, photo viewer and YouTube player each get a ← Back
  // button. Where it goes depends on where the viewer was opened from:
  //  - a browser (Notes / Photos / Videos / Favorites / Comments / a tag
  //    gallery): the browser is closed to make room for the viewer, so
  //    Back re-opens it with the same folder, search text, tag gallery and
  //    scroll position it had;
  //  - a modal that is still open underneath (Tasks, Calendar, or the note
  //    a photo was clicked in): Back just closes the viewer and that modal
  //    is right there again;
  //  - the map itself (node marker, right-click menu): Back closes the
  //    viewer, which is exactly "back to the node".
  // A caller describes where it came from with a "return point"
  // { label, restore } and hands it over with withViewerReturn(); the
  // viewer's open function picks it up via takeViewerReturn().
  let pendingViewerReturn = null;
  function withViewerReturn(ret, openFn) {
    pendingViewerReturn = ret || null;
    try { openFn(); } finally { pendingViewerReturn = null; }
  }
  function takeViewerReturn() {
    const r = pendingViewerReturn;
    pendingViewerReturn = null;
    return r;
  }
  function runViewerReturn(ret) {
    if (!ret || typeof ret.restore !== "function") return;
    try { ret.restore(); } catch (err) { console.warn("Branchline: couldn't go back to", ret.label, err); }
  }
  function viewerBackTitle(ret) {
    return ret && ret.label ? `Back to ${ret.label}` : "Back to map";
  }
  // "Notes", or "Notes › Work" when a folder is selected in that browser.
  function browserReturnLabel(base, mgr) {
    const sel = mgr && mgr.getSelected();
    if (!sel) return base;
    return `${base} › ${sel === "__unfiled__" ? "Unfiled" : sel}`;
  }
  // Builds the return point for a browser modal. Call it BEFORE closing the
  // browser so the scroll position can still be read. `reopen(true)` must
  // re-open the browser without resetting its search box.
  function makeBrowserReturn(label, listEl, reopen, mgr) {
    const sel = mgr ? mgr.getSelected() : null;
    const top = listEl ? listEl.scrollTop : 0;
    return {
      label: mgr ? browserReturnLabel(label, mgr) : label,
      restore: () => {
        if (mgr) mgr.select(sel);
        reopen(true);
        const apply = () => { if (listEl) listEl.scrollTop = top; };
        apply();
        requestAnimationFrame(apply);
      },
    };
  }
  // A modal that stays open underneath a viewer: Back = just close the
  // viewer, so there's nothing to restore — only a label for the tooltip.
  function underlyingModalReturn() {
    const under = [["#tasks-modal", "Tasks"], ["#calendar-modal", "Calendar"]];
    for (const [sel, label] of under) {
      const el = document.querySelector(sel);
      if (el && !el.classList.contains("hidden")) return { label, restore: null };
    }
    return null;
  }

  function zoomModalOpen(modalEl, cardSelector) {
    if (!modalEl) return;
    clearTimeout(modalEl.__zoomTimer);
    const card = modalEl.querySelector(cardSelector || ".modal-card");
    modalEl.classList.remove("hidden");
    if (card) {
      // Measure the card BEFORE modal-zoom-init's shrink is applied, at
      // its natural full-size position — not after, like this used to.
      // Scaling alone is centered so it wouldn't matter, but the shrink
      // also carries a translate(--zoom-dx, --zoom-dy) offset left over
      // from whatever point this modal last grew from, and that stale
      // offset was still in effect at measurement time — corrupting the
      // very calculation meant to replace it, so every open after the
      // first grew from a progressively wrong spot instead of the click.
      // Measuring here, before that shrink exists at all, sidesteps it.
      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const ox = zoomOriginX != null ? zoomOriginX : cx;
      const oy = zoomOriginY != null ? zoomOriginY : cy;
      modalEl.style.setProperty("--zoom-dx", (ox - cx) + "px");
      modalEl.style.setProperty("--zoom-dy", (oy - cy) + "px");
    }
    modalEl.classList.add("modal-zoom-init");
    // Force a reflow so the browser paints the shrunk-near-the-icon state
    // from modal-zoom-init before it's removed on the next frame — doing
    // both in the same tick would collapse into one frame and skip the
    // transition entirely.
    void modalEl.offsetWidth;
    requestAnimationFrame(() => modalEl.classList.remove("modal-zoom-init"));
  }

  // Hides `modalEl` the same way in reverse, shrinking back toward
  // whichever point it grew from, then calls `afterHide` (for whatever
  // state cleanup the caller used to do immediately) once it's actually
  // gone. Cleanup is deferred so things like an image's `src` don't
  // disappear mid-animation, leaving nothing left to shrink away.
  function zoomModalClose(modalEl, afterHide) {
    if (!modalEl) { if (afterHide) afterHide(); return; }
    modalEl.classList.add("modal-zoom-init");
    clearTimeout(modalEl.__zoomTimer);
    modalEl.__zoomTimer = setTimeout(() => {
      modalEl.classList.add("hidden");
      modalEl.classList.remove("modal-zoom-init");
      if (afterHide) afterHide();
    }, MODAL_ZOOM_MS);
  }

  // Photos are stored exactly as provided — no downscaling, no lossy
  // re-encoding — so what you attach is byte-for-byte what you get back.
  // Accepts one or more files and appends each as a new photo on the
  // node, rather than replacing whatever is already attached.
  const nodeImageInput = $("#node-image-input");
  const photoModal = $("#photo-modal");
  const photoModalImg = $("#photo-modal-img");
  let pendingPhotoNodeId = null;

  // Generic "grow to fit a paragraph" behavior shared by every comment
  // textarea in the app (video modal's inline box, and the standalone
  // link-comment modal below) — Enter just inserts a newline like any
  // textarea; this only keeps the whole thing visible without an inner
  // scrollbar kicking in early.
  function autoGrowTextarea(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  // Embedded YouTube player modal — opened in place of a new tab when a
  // link icon whose URL is a YouTube video/short is clicked (see
  // youtubeVideoId and the urlIcon/linkIcon click handlers). Any other
  // link still opens normally with window.open.
  const videoModal = $("#video-modal");
  const videoModalCard = $(".video-modal-card");
  const videoModalIframe = $("#video-modal-iframe");
  const videoModalOpenLink = $("#video-modal-open-link");
  const videoModalFavoriteBtn = $("#video-modal-favorite");
  const videoModalFolderBtn = $("#video-modal-folder");
  const videoModalMinimizeBtn = $("#video-modal-minimize");
  const videoModalSizeBtn = $("#video-modal-size");
  const videoModalCloseBtn = $("#video-modal-close");
  const videoModalBackBtn = $("#video-modal-back");
  let videoModalReturn = null;
  const videoModalCommentRow = $("#video-modal-comment-row");
  const videoModalCommentInput = $("#video-modal-comment-input");
  const videoModalPhotoStrip = $("#video-modal-photo-strip");
  const videoModalPhotoAddBtn = $("#video-modal-photo-add");
  const videoModalPhotoInput = $("#video-modal-photo-input");
  let videoModalCommentCtx = null;

  // Remembers where each video was last playing, keyed by YouTube video
  // id, so reopening the same video resumes instead of starting over.
  // This lives in localStorage rather than the map's own data (persist())
  // since it's a per-browser playback preference, not part of the map
  // itself — no reason to sync it via Google Drive or undo/redo.
  const YT_POSITIONS_KEY = "branchline:yt-positions";
  function loadYtPositions() {
    try { return JSON.parse(localStorage.getItem(YT_POSITIONS_KEY)) || {}; }
    catch { return {}; }
  }
  function getYtPosition(ytId) {
    return loadYtPositions()[ytId] || 0;
  }
  function saveYtPosition(ytId, seconds) {
    if (!ytId || !Number.isFinite(seconds)) return;
    const positions = loadYtPositions();
    positions[ytId] = Math.max(0, Math.floor(seconds));
    try { localStorage.setItem(YT_POSITIONS_KEY, JSON.stringify(positions)); } catch {}
  }

  // Player size is a per-browser display preference (like the playback
  // position above), not part of the map itself, so it lives in
  // localStorage too and carries over between videos and sessions. The
  // button cycles normal → large → full each click; the CSS for each is
  // on .video-modal-card.size-large / .size-full (see style.css).
  const VIDEO_MODAL_SIZES = ["normal", "large", "full"];
  const VIDEO_MODAL_SIZE_KEY = "branchline:video-modal-size";
  function loadVideoModalSize() {
    const saved = localStorage.getItem(VIDEO_MODAL_SIZE_KEY);
    return VIDEO_MODAL_SIZES.includes(saved) ? saved : "normal";
  }
  function applyVideoModalSize(size) {
    VIDEO_MODAL_SIZES.forEach(s => videoModalCard.classList.remove("size-" + s));
    if (size !== "normal") videoModalCard.classList.add("size-" + size);
    const next = VIDEO_MODAL_SIZES[(VIDEO_MODAL_SIZES.indexOf(size) + 1) % VIDEO_MODAL_SIZES.length];
    const label = size === "normal" ? "Make player bigger" : size === "large" ? "Make player even bigger" : "Back to normal size";
    videoModalSizeBtn.title = label;
    videoModalSizeBtn.setAttribute("aria-label", label);
    videoModalSizeBtn.textContent = size === "full" ? "⤡" : "⤢";
    videoModalSizeBtn.dataset.next = next;
  }
  videoModalSizeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = videoModalSizeBtn.dataset.next || "large";
    try { localStorage.setItem(VIDEO_MODAL_SIZE_KEY, next); } catch {}
    applyVideoModalSize(next);
  });
  applyVideoModalSize(loadVideoModalSize());

  // "Mini" mode: instead of the normal/large/full sizes above (a centered,
  // backdropped modal), the player shrinks into a small frame docked at
  // the top-right of the window with no backdrop, so the mindmap stays
  // usable underneath while the video keeps playing (see the .video-modal
  // .mini rules in style.css for how clicks pass through everywhere except
  // the little card itself). The size the player was at before minimizing
  // is remembered so un-minimizing restores it exactly.
  let videoModalPreMiniSize = "normal";
  function setVideoModalMini(mini) {
    if (mini === videoModal.classList.contains("mini")) return;
    if (mini) {
      videoModalPreMiniSize = VIDEO_MODAL_SIZES.find(s => videoModalCard.classList.contains("size-" + s)) || "normal";
      VIDEO_MODAL_SIZES.forEach(s => videoModalCard.classList.remove("size-" + s));
    } else {
      applyVideoModalSize(videoModalPreMiniSize);
    }
    videoModal.classList.toggle("mini", mini);
    const label = mini ? "Restore player" : "Minimize player";
    videoModalMinimizeBtn.textContent = mini ? "⤢" : "─";
    videoModalMinimizeBtn.title = label;
    videoModalMinimizeBtn.setAttribute("aria-label", label);
  }
  videoModalMinimizeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setVideoModalMini(!videoModal.classList.contains("mini"));
  });

  // Lazily loads the YouTube IFrame Player API — only needed the first
  // time a video is actually opened. A plain <iframe src="...embed/...">
  // (the old approach) has no way to report back the current playback
  // time, so tracking position requires the real player object.
  let ytApiReadyPromise = null;
  function ensureYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytApiReadyPromise) return ytApiReadyPromise;
    ytApiReadyPromise = new Promise((resolve) => {
      const prevReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prevReady) prevReady(); resolve(); };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
    return ytApiReadyPromise;
  }

  // One player instance is created and reused across opens (loadVideoById
  // swaps the video in place) rather than tearing it down each time.
  let ytPlayer = null;
  let ytPlayerCurrentId = null;
  let ytSaveTimer = null;
  function startYtSaveTimer() {
    stopYtSaveTimer();
    ytSaveTimer = setInterval(() => {
      if (ytPlayer && ytPlayerCurrentId && typeof ytPlayer.getCurrentTime === "function") {
        try { saveYtPosition(ytPlayerCurrentId, ytPlayer.getCurrentTime()); } catch {}
      }
    }, 4000);
  }
  function stopYtSaveTimer() {
    if (ytSaveTimer) { clearInterval(ytSaveTimer); ytSaveTimer = null; }
  }
  function handleYtStateChange(e) {
    if (!ytPlayerCurrentId) return;
    if (e.data === YT.PlayerState.PAUSED) {
      try { saveYtPosition(ytPlayerCurrentId, ytPlayer.getCurrentTime()); } catch {}
    } else if (e.data === YT.PlayerState.ENDED) {
      // Finished videos resume from the start next time, not the last frame.
      saveYtPosition(ytPlayerCurrentId, 0);
    }
  }

  // Opens the resumable YouTube player modal for a video/short link.
  // (Non-YouTube links no longer use this modal — see openLinkSmart,
  // which now just opens them directly in a new tab.) Kept as its own
  // <iframe> element (video-modal-iframe) so the YouTube player object,
  // once created, can stay attached to its own iframe permanently — swapping that same
  // element's .src to an arbitrary site would leave the player object
  // pointed at a page that no longer understands its postMessage calls.
  async function openVideoModal(url, ytId, commentCtx) {
    // Must be read before the first await — see withViewerReturn.
    const pendingRet = takeViewerReturn();
    if (pendingRet) videoModalReturn = pendingRet;
    else if (videoModal.classList.contains("hidden")) videoModalReturn = null;
    videoModalBackBtn.title = viewerBackTitle(videoModalReturn);
    videoModalBackBtn.setAttribute("aria-label", videoModalBackBtn.title);
    setVideoModalMini(false);
    videoModalOpenLink.href = url;
    videoModalOpenLink.textContent = "Open on YouTube ↗";
    videoModalCommentCtx = commentCtx || null;
    videoModalCommentInput.value = commentCtx ? commentCtx.get() : "";
    videoModalCommentRow.classList.toggle("hidden", !commentCtx);
    renderVideoModalFavorite();
    renderVideoModalFolder();
    renderVideoModalPhotos();
    zoomModalOpen(videoModal);

    videoModalIframe.classList.remove("hidden");

    ytPlayerCurrentId = ytId;
    const startSeconds = getYtPosition(ytId);
    await ensureYtApi();
    // Bail if the modal was closed or switched to a different video while
    // the API script was still loading.
    if (ytPlayerCurrentId !== ytId || videoModal.classList.contains("hidden")) return;

    if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
      ytPlayer.loadVideoById({ videoId: ytId, startSeconds });
      startYtSaveTimer();
    } else {
      ytPlayer = new YT.Player("video-modal-iframe", {
        videoId: ytId,
        host: "https://www.youtube-nocookie.com",
        playerVars: { autoplay: 1, start: Math.floor(startSeconds), playsinline: 1 },
        events: {
          onReady: () => startYtSaveTimer(),
          onStateChange: handleYtStateChange,
        },
      });
    }
  }
  // Syncs the ☆/★ favorite button to whichever video is currently loaded
  // (see openVideoModal) — hidden when this video's commentCtx doesn't
  // carry favorite accessors (shouldn't normally happen, since every
  // caller of openLinkSmart for a stored node/cell URL supplies them;
  // this stays defensive for ad-hoc callers without favorite accessors).
  function renderVideoModalFavorite() {
    if (!videoModalCommentCtx || !videoModalCommentCtx.getFavorite) {
      videoModalFavoriteBtn.style.display = "none";
      return;
    }
    videoModalFavoriteBtn.style.display = "";
    const fav = !!videoModalCommentCtx.getFavorite();
    videoModalFavoriteBtn.textContent = fav ? "★" : "☆";
    videoModalFavoriteBtn.classList.toggle("favorited", fav);
    videoModalFavoriteBtn.title = fav ? "Remove from favorites" : "Add to favorites";
    videoModalFavoriteBtn.setAttribute("aria-label", videoModalFavoriteBtn.title);
  }
  videoModalFavoriteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!videoModalCommentCtx || !videoModalCommentCtx.getFavorite || !videoModalCommentCtx.setFavorite) return;
    pushUndo();
    videoModalCommentCtx.setFavorite(!videoModalCommentCtx.getFavorite());
    persist();
    renderVideoModalFavorite();
    renderVideoModalFolder();
  });
  // Same "📁, dotted when filed" idea as the note/photo viewers — keyed
  // by videoKey (nodeId|url for a node, nodeId|cell:r,c|url for a cell),
  // the same stable key collectAllVideos uses for both host types.
  function renderVideoModalFolder() {
    if (!videoModalFolderBtn) return;
    const key = videoModalCommentCtx && videoModalCommentCtx.videoKey;
    videoModalFolderBtn.style.display = key ? "" : "none";
    if (!key) return;
    // Hidden once starred — same reasoning as Notes/Photos:
    // syncVideosFavoriteFolderAssignments (next Videos-browser render)
    // will claim it for Favorite regardless.
    const fav = videoModalCommentCtx.getFavorite && videoModalCommentCtx.getFavorite();
    videoModalFolderBtn.classList.toggle("hidden", !!fav);
    if (fav) return;
    const folder = videosFolderMgr.folderOf(key);
    videoModalFolderBtn.title = folder ? `In folder: ${folder}` : "Move to folder";
    videoModalFolderBtn.classList.toggle("has-folder", !!folder);
  }
  if (videoModalFolderBtn) {
    videoModalFolderBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = videoModalCommentCtx && videoModalCommentCtx.videoKey;
      if (!key) return;
      openFolderMovePopover(videoModalFolderBtn, videosFolderMgr, key, renderVideoModalFolder);
    });
  }
  function closeVideoModal() {
    if (ytPlayer && ytPlayerCurrentId && typeof ytPlayer.getCurrentTime === "function") {
      try { saveYtPosition(ytPlayerCurrentId, ytPlayer.getCurrentTime()); } catch {}
    }
    stopYtSaveTimer();
    if (ytPlayer && typeof ytPlayer.stopVideo === "function") {
      try { ytPlayer.stopVideo(); } catch {} // stop playback
    }
    videoModalCommentCtx = null;
    ytPlayerCurrentId = null;
    videoModalReturn = null;
    zoomModalClose(videoModal);
  }
  videoModalCloseBtn.addEventListener("click", closeVideoModal);
  videoModalBackBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const ret = videoModalReturn;
    closeVideoModal();
    runViewerReturn(ret);
  });
  videoModal.addEventListener("click", (e) => { if (e.target === videoModal) closeVideoModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !videoModal.classList.contains("hidden")) closeVideoModal();
  });
  // Saves on blur (clicking/tabbing away) and on Ctrl/Cmd+Enter, same
  // "commit when you're done typing" feel as the rest of the app's plain
  // text inputs — no explicit Save button needed for a single field.
  function saveVideoModalComment() {
    if (!videoModalCommentCtx) return;
    pushUndo();
    videoModalCommentCtx.set(videoModalCommentInput.value);
    persist();
  }
  videoModalCommentInput.addEventListener("blur", saveVideoModalComment);
  videoModalCommentInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); videoModalCommentInput.blur(); }
  });

  // Photos attached to the video's comment (see getLinkPhotos/addLinkPhoto/
  // removeLinkPhoto and their table-cell equivalents) — a simple thumbnail
  // strip below the comment box. Paste a screenshot straight into the
  // textarea, or use the "+ 📷" button, to attach one; click a thumbnail
  // to open it full-size in a new tab; click its "×" to remove it.
  function renderVideoModalPhotos() {
    videoModalPhotoStrip.querySelectorAll(".video-modal-photo-thumb").forEach((el) => el.remove());
    videoModalPhotoAddBtn.style.display = videoModalCommentCtx && videoModalCommentCtx.addPhoto ? "" : "none";
    if (!videoModalCommentCtx || !videoModalCommentCtx.getPhotos) return;
    const ids = videoModalCommentCtx.getPhotos();
    ids.forEach((id) => {
      const thumb = document.createElement("div");
      thumb.className = "video-modal-photo-thumb";
      thumb.title = "Open full size";
      const img = document.createElement("img");
      img.src = photoUrl(id);
      img.alt = "Attached photo";
      thumb.appendChild(img);
      thumb.addEventListener("click", () => window.open(photoUrl(id), "_blank"));
      if (videoModalCommentCtx.removePhoto) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "video-modal-photo-thumb-remove";
        rm.textContent = "×";
        rm.title = "Remove photo";
        rm.setAttribute("aria-label", "Remove photo");
        rm.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!videoModalCommentCtx) return;
          pushUndo();
          videoModalCommentCtx.removePhoto(id);
          persist();
          renderVideoModalPhotos();
        });
        thumb.appendChild(rm);
      }
      videoModalPhotoStrip.insertBefore(thumb, videoModalPhotoAddBtn);
    });
  }

  // Reads and attaches one or more image files (from a file picker or a
  // clipboard paste) to the video's comment — downscaling large screenshots
  // first via the same helper the note editor's image paste already uses,
  // so a full-resolution screenshot doesn't bloat the map's saved size.
  function videoModalHandleImageFiles(fileList) {
    if (!videoModalCommentCtx || !videoModalCommentCtx.addPhoto) return;
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (!files.length) return;
    Promise.all(files.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    })))
      .then((dataUrls) => Promise.all(dataUrls.filter(Boolean).map(downscaleNoteImageDataUrl)))
      .then((dataUrls) => {
        if (!dataUrls.length || !videoModalCommentCtx) return;
        pushUndo();
        dataUrls.forEach((dataUrl) => videoModalCommentCtx.addPhoto(dataUrl));
        persist();
        renderVideoModalPhotos();
      });
  }
  videoModalCommentInput.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageItems = Array.from(items).filter((item) => item.type && item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    videoModalHandleImageFiles(imageItems.map((item) => item.getAsFile()));
  });
  videoModalPhotoAddBtn.addEventListener("click", () => videoModalPhotoInput.click());
  videoModalPhotoInput.addEventListener("change", () => {
    if (videoModalPhotoInput.files && videoModalPhotoInput.files.length) {
      videoModalHandleImageFiles(videoModalPhotoInput.files);
    }
    videoModalPhotoInput.value = "";
  });

  // Standalone comment editor — opened by the right-click "💬" button on
  // any link icon (see openUrlSingleManageMenu/openCellUrlManageMenu),
  // including non-YouTube links that never touch the video modal above.
  // Same auto-growing paragraph textarea and save-on-blur/Ctrl+Enter
  // behavior as the video modal's inline comment box, just in its own
  // small modal.
  const linkCommentModal = $("#link-comment-modal");
  const linkCommentModalUrl = $("#link-comment-modal-url");
  const linkCommentModalInput = $("#link-comment-modal-input");
  const linkCommentModalCloseBtn = $("#link-comment-modal-close");
  const linkCommentModalFavorite = $("#link-comment-modal-favorite");
  let linkCommentModalCtx = null;
  function renderLinkCommentModalFavorite() {
    if (!linkCommentModalCtx || !linkCommentModalCtx.getFavorite) {
      linkCommentModalFavorite.style.display = "none";
      return;
    }
    linkCommentModalFavorite.style.display = "";
    const fav = !!linkCommentModalCtx.getFavorite();
    linkCommentModalFavorite.textContent = fav ? "★" : "☆";
    linkCommentModalFavorite.classList.toggle("favorited", fav);
    linkCommentModalFavorite.title = fav ? "Remove from favorites" : "Add to favorites";
    linkCommentModalFavorite.setAttribute("aria-label", linkCommentModalFavorite.title);
  }
  function openLinkCommentModal(url, commentCtx) {
    linkCommentModalCtx = commentCtx;
    linkCommentModalUrl.textContent = url;
    linkCommentModalInput.value = commentCtx.get();
    renderLinkCommentModalFavorite();
    zoomModalOpen(linkCommentModal);
    requestAnimationFrame(() => { autoGrowTextarea(linkCommentModalInput); linkCommentModalInput.focus(); });
  }
  function saveLinkCommentModal() {
    if (!linkCommentModalCtx) return;
    pushUndo();
    linkCommentModalCtx.set(linkCommentModalInput.value);
    persist();
  }
  function closeLinkCommentModal() {
    saveLinkCommentModal();
    linkCommentModalCtx = null;
    zoomModalClose(linkCommentModal);
  }
  linkCommentModalFavorite.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!linkCommentModalCtx || !linkCommentModalCtx.setFavorite || !linkCommentModalCtx.getFavorite) return;
    pushUndo();
    linkCommentModalCtx.setFavorite(!linkCommentModalCtx.getFavorite());
    persist();
    renderLinkCommentModalFavorite();
  });
  linkCommentModalCloseBtn.addEventListener("click", closeLinkCommentModal);
  linkCommentModal.addEventListener("click", (e) => { if (e.target === linkCommentModal) closeLinkCommentModal(); });
  linkCommentModalInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); closeLinkCommentModal(); }
    if (e.key === "Escape") { e.preventDefault(); closeLinkCommentModal(); }
  });
  linkCommentModalInput.addEventListener("input", () => autoGrowTextarea(linkCommentModalInput));

  // Shared by every link click handler (node links, table-cell links):
  // YouTube videos/shorts open in the resumable in-app player modal;
  // every other link opens in its own sized, centered popup window (see
  // openUrlAsPopup below) rather than a plain new tab — so following a
  // link never navigates away from/covers up the mindmap tab itself,
  // letting you browse alongside the map instead of losing your place.
  // `commentCtx` (optional) is a { get, set } pair scoped to that one
  // link's comment (see getLinkComment/setLinkComment and their cell
  // equivalents), letting the modal's comment box read and save without
  // knowing whether the link lives on a node or inside a table cell.
  function openLinkSmart(url, commentCtx) {
    const ytId = youtubeVideoId(url);
    if (!ytId) {
      openUrlAsPopup(url);
      return;
    }
    openVideoModal(url, ytId, commentCtx);
  }

  // Opens a URL in its own sized, centered browser window rather than a
  // plain new tab. Used to open as a chromeless "popup" style window (no
  // address bar/tabs, via the `popup=1` window feature) — now opens as a
  // regular browser window instead (full address bar/back-forward/tabs),
  // just sized and centered smaller than the mindmap's own window so it
  // reads as a companion window rather than covering it up. Ported in-app
  // as a right-click "🪟" action on any node/cell link (see
  // openUrlSingleManageMenu/openCellUrlManageMenu) and as the standalone
  // "🪟 Popup" toolbar button/modal for a URL that isn't attached to any
  // node.
  //
  // Sized as a fraction of the CURRENT browser window (screenX/Y +
  // outerWidth/Height) rather than a fixed 1368×720 — that fixed size
  // used to end up BIGGER than the mindmap window on a smaller screen,
  // which defeated the "keep it smaller than the mindmap" idea. Clamped
  // between a sane minimum (still usable) and a sane maximum (doesn't
  // balloon on a huge monitor).
  function openUrlAsPopup(url) {
    if (!url) return;
    const mmW = window.outerWidth || screen.width;
    const mmH = window.outerHeight || screen.height;
    const w = Math.round(clamp(mmW * 0.5, 480, Math.max(480, mmW - 80)));
    const h = Math.round(clamp(mmH * 0.5, 360, Math.max(360, mmH - 80)));
    const left = Math.max(0, Math.round((window.screenX || 0) + (mmW - w) / 2));
    const top = Math.max(0, Math.round((window.screenY || 0) + (mmH - h) / 2));
    // toolbar=yes/location=yes ask the browser to show its normal
    // navigation bar (back/forward/reload) and address bar on the popup.
    // Any yes/no feature left out of this string is treated as "no" by
    // the window.open spec, which is why the popup used to come up with
    // no way to go back after following a link inside it.
    const features = `width=${w},height=${h},left=${left},top=${top},toolbar=yes,location=yes,noopener`;
    window.open(url, "_blank", features);
  }

  // Standalone "🪟 Popup" toolbar button + modal — a URL box you can type
  // or paste into (auto-filled from the clipboard when available, same
  // as the Popup Link Opener extension it's modeled on) to send any link
  // through openUrlAsPopup() above, even one that isn't attached to any
  // node yet.
  //
  // Everything below is guarded on all the required elements actually
  // existing (see popupOpenerReady) — if index.html/style.css ever lag
  // behind a newer app.js (e.g. only one file got redeployed), this
  // feature just quietly no-ops instead of throwing and taking the rest
  // of boot() down with it, which is a much worse failure mode (missing
  // photos, dead sidebar, etc. that have nothing to do with this feature).
  const popupOpenerBtn = $("#btn-popup-opener");
  const popupOpenerModal = $("#popup-opener-modal");
  const popupOpenerInput = $("#popup-opener-input");
  const popupOpenerOpenBtn = $("#popup-opener-open");
  const popupOpenerBlankBtn = $("#popup-opener-blank");
  const popupOpenerCloseBtn = $("#popup-opener-close");
  const popupOpenerBackBtn = $("#popup-opener-back");
  const popupOpenerClipTag = $("#popup-opener-clip-tag");
  const popupOpenerErrorEl = $("#popup-opener-error");
  const popupOpenerReady = !!(popupOpenerBtn && popupOpenerModal && popupOpenerInput &&
    popupOpenerOpenBtn && popupOpenerBlankBtn && popupOpenerCloseBtn && popupOpenerBackBtn && popupOpenerClipTag && popupOpenerErrorEl);
  if (!popupOpenerReady) {
    console.warn("[Branchline] Popup-opener UI elements missing from index.html — skipping that feature's wiring (app.js/index.html may be out of sync).");
  }

  function normaliseForPopupOpener(s) {
    const trimmed = (s || "").trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^localhost(:\d+)?$|^\d{1,3}(\.\d{1,3}){3}/i.test(trimmed)) return "http://" + trimmed;
    return "https://" + trimmed;
  }
  function isValidPopupOpenerUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) { return false; }
  }
  function showPopupOpenerError(msg) {
    popupOpenerErrorEl.textContent = "⚠ " + msg;
    popupOpenerErrorEl.classList.remove("hidden");
    popupOpenerClipTag.classList.add("hidden");
  }
  function hidePopupOpenerStatus() {
    popupOpenerErrorEl.classList.add("hidden");
    popupOpenerClipTag.classList.add("hidden");
  }

  async function openPopupOpenerModal() {
    hidePopupOpenerStatus();
    popupOpenerInput.value = "";
    zoomModalOpen(popupOpenerModal);
    // Best-effort clipboard auto-fill, same as the extension this is
    // modeled on — quietly does nothing if the browser denies clipboard
    // read (e.g. no permission prompt shown yet, or an insecure origin).
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text && isValidPopupOpenerUrl(normaliseForPopupOpener(text))) {
        popupOpenerInput.value = text;
        popupOpenerClipTag.classList.remove("hidden");
      }
    } catch (e) { /* clipboard denied/unavailable — fall through silently */ }
    requestAnimationFrame(() => { popupOpenerInput.focus(); popupOpenerInput.select(); });
  }
  function closePopupOpenerModal() {
    zoomModalClose(popupOpenerModal);
  }
  function openFromPopupOpenerInput() {
    const raw = popupOpenerInput.value.trim();
    if (!raw) { showPopupOpenerError("Please enter a URL"); return; }
    const url = normaliseForPopupOpener(raw);
    if (!isValidPopupOpenerUrl(url)) { showPopupOpenerError("Enter a valid URL (http / https)"); return; }
    hidePopupOpenerStatus();
    openUrlAsPopup(url);
    closePopupOpenerModal();
  }

  if (popupOpenerReady) {
    popupOpenerBtn.addEventListener("click", openPopupOpenerModal);
    popupOpenerOpenBtn.addEventListener("click", openFromPopupOpenerInput);
    popupOpenerInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") openFromPopupOpenerInput(); });
    popupOpenerInput.addEventListener("input", hidePopupOpenerStatus);
    popupOpenerBlankBtn.addEventListener("click", () => { openUrlAsPopup("about:blank"); closePopupOpenerModal(); });
    popupOpenerCloseBtn.addEventListener("click", closePopupOpenerModal);
    popupOpenerBackBtn.addEventListener("click", closePopupOpenerModal);
    popupOpenerModal.addEventListener("click", (e) => { if (e.target === popupOpenerModal) closePopupOpenerModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !popupOpenerModal.classList.contains("hidden")) { closePopupOpenerModal(); return; }
      // Ctrl/Cmd+Shift+O — same hotkey as the Popup Link Opener extension.
      // Skipped while typing anywhere (contenteditable/input/textarea) so
      // it can't hijack an "O" typed into a node or field.
      const activeIsTyping = document.activeElement && (
        document.activeElement.isContentEditable ||
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "TEXTAREA"
      );
      if (!activeIsTyping && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openPopupOpenerModal();
      }
    });
  }

  // Quick-launch toolbar buttons — one-click shortcuts straight to
  // YouTube / Google Docs / Sheets / Photos, each opened via the same
  // openUrlAsPopup() sized/centered popup window as any other link's 🪟
  // action, rather than a plain new tab. Wired defensively (each button
  // is optional) so an index.html that hasn't picked up these buttons
  // yet doesn't break anything else in boot().
  [
    ["#btn-quick-youtube", "https://www.youtube.com/"],
    ["#btn-quick-gdocs", "https://docs.google.com/document/u/0/"],
    ["#btn-quick-gsheets", "https://sheets.google.com/u/0/"],
    ["#btn-quick-gphotos", "https://photos.google.com/"],
  ].forEach(([selector, url]) => {
    const btn = $(selector);
    if (btn) btn.addEventListener("click", () => openUrlAsPopup(url));
  });

  function openNodePhotoPicker(nodeId) {
    if (!requireSignIn()) return;
    pendingPhotoNodeId = nodeId;
    nodeImageInput.click();
  }

  function handleNodePhotoFiles(nodeId, fileList) {
    const node = findNode(nodeId);
    const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith("image/"));
    if (!node || !files.length) return;
    if (!Array.isArray(node.images)) node.images = getNodeImageIds(node);
    pushUndo();
    let remaining = files.length;
    let hadError = false;
    const done = () => {
      remaining--;
      if (remaining === 0) {
        node.image = null; // fully migrated onto the images array
        renderAll();
        persist();
        if (hadError) alert("Some images couldn't be read.");
      }
    };
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const id = addPhotoRecord(reader.result, { avoid: getNodeImageIds(node) });
        node.images.push(id);
        setPhotoTimestamp(node, id, Date.now());
        done();
      };
      reader.onerror = () => { hadError = true; done(); };
      reader.readAsDataURL(file);
    });
  }

  nodeImageInput.addEventListener("change", () => {
    if (nodeImageInput.files && nodeImageInput.files.length && pendingPhotoNodeId) {
      handleNodePhotoFiles(pendingPhotoNodeId, nodeImageInput.files);
    }
    nodeImageInput.value = ""; // reset so picking the same file again still fires change
    pendingPhotoNodeId = null;
  });

  // Shared validity check behind all three clipboard-URL detectors below:
  // normalizes a bare host ("youtu.be/xyz" -> "https://youtu.be/xyz"), then
  // requires an http(s) scheme (no javascript:, data:, etc.) and an actual
  // dot in the hostname (skips "https://localhost"-style false positives).
  function validatePasteableUrl(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return null;
    const url = normalizeUrl(trimmed);
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      if (!parsed.hostname.includes(".")) return null;
      return url;
    } catch (e) {
      return null; // not a URL at all
    }
  }

  // Recognizes clipboard text that's nothing BUT a URL — e.g. a YouTube
  // link typed or copied as plain text — so it can be pasted straight onto
  // a node/cell as a new link, the same "just paste it" shortcut the image
  // branch below gives screenshots. Deliberately conservative: the entire
  // trimmed text must be that one URL — a sentence that merely contains a
  // link, or anything with a second line/word, falls through to ordinary
  // text-paste behavior instead of silently swallowing it as a link.
  function pasteableUrlFromClipboardText(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || /\s/.test(trimmed)) return null;
    return validatePasteableUrl(trimmed);
  }

  // Copying a hyperlinked run of text — e.g. selecting "Watch here" on a
  // page and hitting Ctrl/Cmd+C, or a rich "share" card from another app —
  // puts an <a href> in text/html even though text/plain only carries the
  // link's display text, not its address. Only trusted when the pasted
  // HTML contains exactly one link, so pasting a paragraph with several
  // links in it doesn't guess which one was meant.
  function pasteableUrlFromClipboardHtml(html) {
    if (!html) return null;
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const anchors = doc.querySelectorAll("a[href]");
      if (anchors.length !== 1) return null;
      return validatePasteableUrl(anchors[0].getAttribute("href"));
    } catch (e) {
      return null;
    }
  }

  // Tries every clipboard format a copied link might arrive in, in order
  // of how literally it signals "a link was copied": text/uri-list (what
  // a browser's own "Copy link address" writes), then plain text that's
  // just a bare URL, then a lone <a href> inside pasted HTML. Returns the
  // first one that checks out, or null if the clipboard isn't a link at
  // all — in which case the paste falls through to normal behavior.
  function pasteableUrlFromClipboard(cd) {
    if (!cd) return null;
    const uriList = cd.getData("text/uri-list");
    if (uriList) {
      const line = uriList.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith("#"));
      const fromUriList = validatePasteableUrl(line);
      if (fromUriList) return fromUriList;
    }
    const fromText = pasteableUrlFromClipboardText(cd.getData("text/plain"));
    if (fromText) return fromText;
    return pasteableUrlFromClipboardHtml(cd.getData("text/html"));
  }

  // Adds a URL straight onto a node with no prompts — the paste-shortcut
  // counterpart to addNodeUrl. Skips both of addNodeUrl's window.prompt
  // calls (there's nothing to prompt for: the URL is already known, and a
  // paste shouldn't stop to ask for a display name) — the link just shows
  // its shortened URL until "Rename link…" is used, same fallback as any
  // link whose title fetch fails.
  function pasteUrlOntoNode(nodeId, url) {
    const node = findNode(nodeId);
    if (!node) return;
    pushUndo();
    const urls = getNodeUrls(node).slice();
    urls.push(url);
    node.urls = urls;
    node.url = null; // fully migrated onto the array field
    setLinkTimestamp(node, url, Date.now());
    renderAll();
    persist();
    fetchLinkTitle(node, url);
  }

  // Same as pasteUrlOntoNode, scoped to a table cell — the paste-shortcut
  // counterpart to addCellUrl.
  function pasteUrlOntoCell(nodeId, r, c, url) {
    const node = findNode(nodeId);
    if (!node) return;
    pushUndo();
    const a = getCellAttach(node, r, c);
    const urls = getCellUrls(a).slice();
    urls.push(url);
    a.urls = urls;
    a.url = null;
    // v415: a pasted cell link should carry the same "date added"
    // metadata as a link pasted onto a normal node.
    setLinkTimestamp(a, url, Date.now());
    renderAll();
    persist();
    fetchCellLinkTitle(nodeId, r, c, url);
  }

  // Paste a screenshot (or any copied image) straight onto the selected
  // node — or, if a table cell was last clicked (see state.selectedCell/
  // handleCellPhotoFiles), onto that cell instead — as a new photo, no
  // need to save it to disk first and go through "Add photo…". A copied
  // link (a YouTube video, say) gets the same one-step treatment as a new
  // link instead, via pasteableUrlFromClipboard/pasteUrlOntoNode above —
  // covers a raw pasted URL, a browser's "Copy link address", and a
  // hyperlinked run of text copied from a page or another app.
  // Only kicks in when the paste isn't headed for a text field (typing
  // into a node, a cell, a modal, the title bar, etc. — those get to
  // handle their own paste, e.g. the note editor's own image-paste
  // support) and no modal is currently open, so it can't hijack a paste
  // the person meant for something else.
  document.addEventListener("paste", (e) => {
    if (!state.current) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (document.querySelector(".modal:not(.hidden)")) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageItem = Array.from(items).find(i => i.type && i.type.startsWith("image/"));
    const file = imageItem && imageItem.getAsFile();
    const url = !file ? pasteableUrlFromClipboard(e.clipboardData) : null;
    if (!file && !url) return;
    if (state.selectedCell) {
      e.preventDefault();
      if (file) handleCellPhotoFiles(state.selectedCell.nodeId, state.selectedCell.r, state.selectedCell.c, [file]);
      else pasteUrlOntoCell(state.selectedCell.nodeId, state.selectedCell.r, state.selectedCell.c, url);
      return;
    }
    if (!state.selectedId || state.editingId) return;
    e.preventDefault();
    if (file) handleNodePhotoFiles(state.selectedId, [file]);
    else pasteUrlOntoNode(state.selectedId, url);
  });

  // Gallery state for the lightbox — which node/cell's photos, and which index.
  let photoModalState = null;

  // v416: the shared photo viewer can now point at either a normal node or
  // one table/calendar cell. Both store photos and per-photo metadata in
  // the same fields, so all viewer tools can operate on this generic host.
  function photoModalHost() {
    if (!photoModalState || photoModalState.noteMode) return null;
    const node = findNode(photoModalState.nodeId);
    if (!node) return null;
    const pos = photoModalState.cellPos;
    return pos ? getCellAttach(node, pos.r, pos.c) : node;
  }
  function photoModalIds() {
    const host = photoModalHost();
    return host ? getNodeImageIds(host) : [];
  }
  function photoModalImages() {
    const host = photoModalHost();
    return host ? getNodeImages(host) : [];
  }
  const photoModalPrev = $("#photo-modal-prev");
  const photoModalNext = $("#photo-modal-next");
  const photoModalCount = $("#photo-modal-count");
  const photoModalDelete = $("#photo-modal-delete");
  const photoModalFolder = $("#photo-modal-folder");
  const photoModalTags = $("#photo-modal-tags");
  const photoModalTagChips = $("#photo-modal-tag-chips");
  const photoModalTagInput = $("#photo-modal-tag-input");
  const photoModalTagSuggest = $("#photo-modal-tag-suggest");
  const photoModalClose = $("#photo-modal-close");
  const photoModalBack = $("#photo-modal-back");
  const photoModalCommentInput = $("#photo-modal-comment-input");
  const photoModalCommentRow = $("#photo-modal-comment-row");
  const photoModalCommentToggle = $("#photo-modal-comment-toggle");
  const photoModalGoto = $("#photo-modal-goto");
  const photoModalZoomIn = $("#photo-modal-zoom-in");
  const photoModalZoomOut = $("#photo-modal-zoom-out");

  // All per-photo action buttons now live in one fixed top-right toolbar
  // (see #photo-modal-toolbar-top in index.html) instead of each being
  // pinned to its own viewport corner or recomputed off the rendered
  // <img> box — so there's nothing here to reposition on load/resize
  // anymore, just a fixed order to insert into.
  const photoModalToolbarTop = $("#photo-modal-toolbar-top");
  const photoModalToolbarBottom = $("#photo-modal-toolbar-bottom");

  // Crop button — built here rather than in index.html so the whole
  // feature lives in this one file. Sits in the shared top-right toolbar
  // alongside close/delete/Aa/🔢/☆.
  const photoModalCrop = document.createElement("button");
  photoModalCrop.id = "photo-modal-crop";
  photoModalCrop.className = "photo-modal-toolbar-btn";
  photoModalCrop.title = "Crop this photo";
  photoModalCrop.setAttribute("aria-label", "Crop this photo");
  photoModalCrop.textContent = "⛶";

  // Text button — Lets the user drop editable labels onto the photo and
  // bake them in.
  const photoModalText = document.createElement("button");
  photoModalText.id = "photo-modal-text";
  photoModalText.className = "photo-modal-toolbar-btn";
  photoModalText.title = "Add text to this photo";
  photoModalText.setAttribute("aria-label", "Add text to this photo");
  photoModalText.textContent = "Aa";
  photoModalText.style.fontSize = "12px";
  photoModalText.style.fontWeight = "700";

  // Symbol button — sits right next to the text button, same styling.
  // Opens a small popover of number-in-circle emoji (1️⃣–9️⃣) that get
  // dropped onto the photo as draggable labels (see startAddText/
  // dropSymbol below), for numbering points directly on the photo.
  const photoModalSymbol = document.createElement("button");
  photoModalSymbol.id = "photo-modal-symbol";
  photoModalSymbol.className = "photo-modal-toolbar-btn";
  photoModalSymbol.title = "Insert a number symbol into the photo";
  photoModalSymbol.setAttribute("aria-label", "Insert a number symbol into the photo");
  photoModalSymbol.textContent = "🔢";

  // Combine button — pastes an image from the clipboard and stitches it
  // onto the top or bottom of the current photo, replacing it with the
  // taller combined result (see combinePhotoFromClipboard below).
  const photoModalCombine = document.createElement("button");
  photoModalCombine.id = "photo-modal-combine";
  photoModalCombine.className = "photo-modal-toolbar-btn";
  photoModalCombine.title = "Paste a photo above, below, left, or right of this one";
  photoModalCombine.setAttribute("aria-label", "Paste a photo above, below, left, or right of this one");
  photoModalCombine.textContent = "⬍";

  // Favorite star — same ☆/★ toggle as the note editor and link/video
  // modals (see toggleNoteFavorite/getPhotoFavorite), sat in the same
  // top-right toolbar as crop/text/symbol. Hidden for an inline note photo
  // (see notePhoto branch in renderPhotoModal below) since there's no
  // per-node attach record backing one of those to star.
  const photoModalFavorite = document.createElement("button");
  photoModalFavorite.id = "photo-modal-favorite";
  photoModalFavorite.className = "photo-modal-toolbar-btn item-star-btn";
  photoModalFavorite.title = "Add to favorites";
  photoModalFavorite.setAttribute("aria-label", "Add to favorites");
  photoModalFavorite.textContent = "☆";

  // Inserted right before the comment toggle (which, along with
  // delete/close, is already in the toolbar in index.html), giving a
  // final left-to-right order of: 🔢, Aa, ⛶, ⬍, ☆, 💬, 🗑, ✕.
  [photoModalSymbol, photoModalText, photoModalCrop, photoModalCombine, photoModalFavorite].forEach(btn => {
    photoModalToolbarTop.insertBefore(btn, photoModalCommentToggle);
  });

  const PHOTO_SYMBOL_CHARS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
  const photoModalSymbolPopover = document.createElement("div");
  photoModalSymbolPopover.id = "photo-modal-symbol-popover";
  photoModalSymbolPopover.className = "photo-modal-symbol-popover hidden";
  PHOTO_SYMBOL_CHARS.forEach(ch => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "photo-modal-symbol-swatch";
    swatch.textContent = ch;
    swatch.addEventListener("mousedown", (e) => e.preventDefault());
    swatch.addEventListener("click", (e) => {
      e.stopPropagation();
      closePhotoSymbolPopover();
      // If the "add text" overlay is already open (from a previous symbol
      // or from the Aa button), just drop another label into that same
      // session instead of restarting the whole placement flow.
      if (addingText && addSymbolToActiveSession) addSymbolToActiveSession(ch);
      else startAddText(ch);
    });
    photoModalSymbolPopover.appendChild(swatch);
  });
  document.body.appendChild(photoModalSymbolPopover);

  function openPhotoSymbolPopover() {
    photoModalSymbolPopover.classList.remove("hidden");
    positionPhotoSymbolPopover();
  }
  function closePhotoSymbolPopover() {
    photoModalSymbolPopover.classList.add("hidden");
  }
  // Same fixed-viewport-coordinates + clamp approach as the note editor's
  // color popover (positionNoteColorPopover) — lives outside the modal
  // card so it's never clipped, and flips above the button if there's
  // not enough room below.
  function positionPhotoSymbolPopover() {
    const margin = 8;
    const btnRect = photoModalSymbol.getBoundingClientRect();
    const popRect = photoModalSymbolPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6;
    }
    photoModalSymbolPopover.style.left = `${left}px`;
    photoModalSymbolPopover.style.top = `${top}px`;
  }
  photoModalSymbol.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (photoModalSymbolPopover.classList.contains("hidden")) openPhotoSymbolPopover();
    else closePhotoSymbolPopover();
  });
  photoModalSymbolPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!photoModalSymbolPopover.classList.contains("hidden") &&
        !photoModalSymbolPopover.contains(e.target) && e.target !== photoModalSymbol) {
      closePhotoSymbolPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!photoModalSymbolPopover.classList.contains("hidden")) positionPhotoSymbolPopover();
  });

  // ---- Combine (paste a photo above/below/left/right) ----
  // Pick a side, paste an image, and the two are stitched into one larger
  // photo that replaces the current one. Deliberately no other options:
  // above/below stitch vertically, left/right stitch horizontally, always
  // at each image's own native pixel size (nothing is rescaled, so
  // neither half loses detail), and encoded at quality 1.0 through the
  // same encodePhotoCanvas the crop/text tools use.
  //
  // Laid out as a directional pad (a plus sign) rather than a stacked
  // list, so each button's position matches the side it pastes onto —
  // above sits on top, left/right flank the middle, below sits on the
  // bottom — which reads at a glance instead of needing the arrow +
  // label text to spell it out.
  const photoCombinePopover = document.createElement("div");
  photoCombinePopover.id = "photo-modal-combine-popover";
  photoCombinePopover.className = "photo-modal-symbol-popover hidden photo-modal-combine-dpad";
  photoCombinePopover.style.maxWidth = "none";
  photoCombinePopover.style.gridTemplateAreas = '". above ." "left . right" ". below ."';
  photoCombinePopover.style.gridTemplateColumns = "repeat(3, 30px)";
  photoCombinePopover.style.gridTemplateRows = "repeat(3, 30px)";
  photoCombinePopover.style.gap = "4px";
  [["above", "⬆", "Paste above"], ["below", "⬇", "Paste below"], ["left", "⬅", "Paste left"], ["right", "➡", "Paste right"]].forEach(([where, arrow, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "photo-modal-symbol-swatch";
    btn.textContent = arrow;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.style.gridArea = where;
    btn.style.width = "100%";
    btn.style.height = "100%";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePhotoCombinePopover();
      combinePhotoFromClipboard(where);
    });
    photoCombinePopover.appendChild(btn);
  });
  document.body.appendChild(photoCombinePopover);

  function openPhotoCombinePopover() {
    photoCombinePopover.classList.remove("hidden");
    photoCombinePopover.style.display = "grid";
    positionPhotoCombinePopover();
  }
  function closePhotoCombinePopover() {
    photoCombinePopover.classList.add("hidden");
    photoCombinePopover.style.display = "";
  }
  function positionPhotoCombinePopover() {
    const margin = 8;
    const btnRect = photoModalCombine.getBoundingClientRect();
    const popRect = photoCombinePopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) top = btnRect.top - popRect.height - 6;
    photoCombinePopover.style.left = `${left}px`;
    photoCombinePopover.style.top = `${top}px`;
  }
  photoModalCombine.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (cropping || addingText) return;
    if (photoCombinePopover.classList.contains("hidden")) openPhotoCombinePopover();
    else closePhotoCombinePopover();
  });
  photoModalCombine.addEventListener("click", (e) => e.stopPropagation());
  photoCombinePopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!photoCombinePopover.classList.contains("hidden") &&
        !photoCombinePopover.contains(e.target) && e.target !== photoModalCombine) {
      closePhotoCombinePopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!photoCombinePopover.classList.contains("hidden")) positionPhotoCombinePopover();
  });

  // Whichever photo the viewer is showing right now, note-mode or not —
  // the same two places renderPhotoModal itself reads from.
  function currentPhotoModalSrc() {
    if (!photoModalState) return null;
    const images = photoModalState.noteMode
      ? photoModalState.images
      : photoModalImages();
    return images[photoModalState.index] || null;
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("could not decode image"));
      im.src = src;
    });
  }
  // (blobToDataUrl — the clipboard/file → data: URL step — already exists
  // up near the photo store; reused here rather than redeclared.)
  // navigator.clipboard.read() is the direct path, but it needs the
  // clipboard-read permission and isn't available at all in some
  // browsers, so a failure here isn't an error — it just means falling
  // back to waiting for a real Ctrl+V (see armCombinePaste).
  async function readClipboardImageDataUrl() {
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => t.startsWith("image/"));
      if (type) return await blobToDataUrl(await item.getType(type));
    }
    return null;
  }

  // Browsers cap canvas dimensions (~32,767px in Chrome/Firefox, lower on
  // some mobiles); past that the canvas silently comes back blank, so
  // refuse rather than replacing a good photo with an empty one.
  const PHOTO_COMBINE_MAX_PX = 32000;

  async function combineTwo(baseSrc, addSrc, where) {
    const [baseImg, addImg] = await Promise.all([loadImageElement(baseSrc), loadImageElement(addSrc)]);
    const vertical = where === "above" || where === "below";
    // For above/below the added image goes first (top) or second (bottom);
    // for left/right the same slot logic applies along the horizontal axis.
    const first = (where === "above" || where === "left") ? addImg : baseImg;
    const second = (where === "above" || where === "left") ? baseImg : addImg;
    const width = vertical
      ? Math.max(first.naturalWidth, second.naturalWidth)
      : first.naturalWidth + second.naturalWidth;
    const height = vertical
      ? first.naturalHeight + second.naturalHeight
      : Math.max(first.naturalHeight, second.naturalHeight);
    if (height > PHOTO_COMBINE_MAX_PX || width > PHOTO_COMBINE_MAX_PX) {
      throw new Error(`The combined photo would be too ${vertical ? "tall" : "wide"} for the browser to render.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    // Only stays lossless/transparent when BOTH halves are PNG; otherwise
    // the result goes out as WebP/JPEG, where transparency wouldn't
    // survive anyway, so any size difference is padded white instead of
    // left as black.
    const isPng = baseSrc.startsWith("data:image/png") && addSrc.startsWith("data:image/png");
    if (!isPng) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }
    // Each half is drawn at 1:1 and centered on the cross-axis, so the
    // smaller one gets padding rather than being stretched to match.
    if (vertical) {
      ctx.drawImage(first, Math.round((width - first.naturalWidth) / 2), 0);
      ctx.drawImage(second, Math.round((width - second.naturalWidth) / 2), first.naturalHeight);
    } else {
      ctx.drawImage(first, 0, Math.round((height - first.naturalHeight) / 2));
      ctx.drawImage(second, first.naturalWidth, Math.round((height - second.naturalHeight) / 2));
    }
    return encodePhotoCanvas(canvas, isPng ? "image/png" : "image/jpeg", width * height, 1.0);
  }

  // Swaps the photo the viewer is currently showing for `outUrl`, keeping
  // its tags/notes/comment/star/timestamp attached — the same hand-off
  // the crop and add-text tools do when they bake their edit in.
  function replacePhotoModalImage(outUrl) {
    if (!photoModalState) return;
    if (photoModalState.noteMode) {
      const noteImgs = Array.from(noteTextarea.querySelectorAll("img"));
      const targetImg = noteImgs[photoModalState.index];
      let oldId = null;
      if (targetImg) {
        // A combined image is a fresh picture, not the original one with a
        // few pixels changed — same "always a new id" rule crop/text/
        // combine use for a node's own photos (see the noDedupe below and
        // its counterpart in the non-note branch), so it gets its own
        // PhotoDB record rather than dedup'ing against the original.
        const newId = addPhotoRecord(outUrl, { noDedupe: true });
        oldId = targetImg.dataset.photoId;
        targetImg.dataset.photoId = newId;
        targetImg.src = photoUrl(newId);
      }
      photoModalState.images[photoModalState.index] = outUrl;
      // Commit first, so the node's own stored notes drop the old id
      // before deletePhotoRecord checks whether anything still
      // references it — otherwise the still-unsaved old reference would
      // make it look referenced and the swap would leak that copy.
      commitNotesToNode();
      if (oldId) deletePhotoRecord(oldId);
    } else {
      const liveNode = photoModalHost();
      const liveIds = getNodeImageIds(liveNode);
      if (!liveNode || !liveIds.length) return;
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
    resetPhotoZoom();
    renderPhotoModal();
  }

  let combiningPhoto = false;
  // Set while waiting for a manual Ctrl+V: which side the pasted image
  // should land on. Cleared by the paste itself, by Escape, or by the
  // photo viewer closing.
  let pendingCombineSide = null;

  function armCombinePaste(where) {
    pendingCombineSide = where;
    showToast(`Press Ctrl+V (⌘V) to paste the photo to add ${where}`);
  }
  function cancelCombinePaste() {
    pendingCombineSide = null;
  }

  async function applyCombine(addSrc, where) {
    const baseSrc = currentPhotoModalSrc();
    if (!baseSrc) return;
    combiningPhoto = true;
    photoModalCombine.disabled = true;
    try {
      replacePhotoModalImage(await combineTwo(baseSrc, addSrc, where));
      showToast(`Photo added ${where}`);
    } catch (err) {
      showToast(err && err.message ? err.message : "Couldn't combine those photos.");
    } finally {
      combiningPhoto = false;
      photoModalCombine.disabled = false;
    }
  }

  async function combinePhotoFromClipboard(where) {
    if (combiningPhoto || cropping || addingText || !photoModalState) return;
    if (!currentPhotoModalSrc()) return;
    let addSrc = null;
    try {
      addSrc = await readClipboardImageDataUrl();
    } catch (err) {
      addSrc = null; // permission denied or unsupported — fall through to Ctrl+V
    }
    if (!addSrc) { armCombinePaste(where); return; }
    await applyCombine(addSrc, where);
  }

  // The manual Ctrl+V path. Only ever does anything while a side is armed
  // and the photo viewer is open, so it can't hijack pasting elsewhere.
  document.addEventListener("paste", (e) => {
    if (!pendingCombineSide || !photoModalState || combiningPhoto) return;
    const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
    const imageItem = items.find(it => it.type && it.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    const where = pendingCombineSide;
    cancelCombinePaste();
    blobToDataUrl(file).then(src => applyCombine(src, where))
      .catch(() => showToast("Couldn't read the pasted image."));
  }, true);

  let cropping = false;
  let cropCleanup = null;
  let addingText = false;
  let textCleanup = null;
  let rearmTextPlacement = null;
  // Set while the "add text" overlay is open, to a function that drops a
  // new symbol label onto the photo (see photoModalSymbol below) without
  // having to re-enter the whole placement flow.
  let addSymbolToActiveSession = null;

  // ---- Scroll-to-zoom on the photo preview ----
  // A separate pan/zoom of just the currently displayed photo (independent
  // of the mindmap canvas's own zoom) — scroll to zoom in/out toward the
  // cursor, drag to pan around once zoomed in. Resets whenever a different
  // photo is shown, or the modal is closed.
  let photoZoom = { scale: 1, tx: 0, ty: 0 };
  const PHOTO_ZOOM_MIN = 1, PHOTO_ZOOM_MAX = 6;

  // Set while the add-text overlay is open, so that overlay can re-apply
  // the exact same transform to itself and stay glued to the photo — the
  // whole point being that you can zoom right into a detail and drop a
  // small label precisely on it, instead of the tool snapping back to 1x.
  let onPhotoZoomChange = null;

  function applyPhotoZoom() {
    photoModalImg.style.transform = photoZoom.scale === 1
      ? ""
      : `translate(${photoZoom.tx}px, ${photoZoom.ty}px) scale(${photoZoom.scale})`;
    photoModalImg.classList.toggle("zoomed", photoZoom.scale > 1);
    if (onPhotoZoomChange) onPhotoZoomChange();
  }

