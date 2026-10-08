/* Branchline — js/14-note-editor-2.js
   Part 14 of 19 of the former single-file app.js. Contents: note editor (part 2).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  // Re-applies auto ordinal colors across every line, for notes loaded
  // from storage (or imported/exported) that have numbered prefixes but no
  // inline color saved yet. `container` defaults to the per-node rich note
  // editor but is also passed the per-task note editor.
  function noteSyncAllOrderedColors(container = noteTextarea) {
    if (!noteAutoColorEnabled) return;
    Array.from(container.children).forEach(el => {
      if (/^\d+\.\s/.test(el.textContent || "") && !el.style.color) {
        noteSetOrderedLineColor(el);
      }
    });
  }

  // Toggles the "N. " prefix on the current line, auto-coloring the line
  // by its number when turning numbering on, and clearing that auto-color
  // when turning it off.
  function noteToggleOrderedList() {
    noteTextarea.focus();
    notePushUndo();
    const lineDiv = noteCurrentLine();
    const el = lineDiv || noteTextarea;
    const text = el.textContent;
    const match = text.match(/^\d+\.\s+/);
    if (match) {
      el.textContent = text.slice(match[0].length);
      el.style.color = "";
    } else {
      el.textContent = "1. " + text;
      noteSetOrderedLineColor(el);
    }
    noteSyncLineChecked(el);
    placeCaretAtEnd(el);
    scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  function noteApplyForeColor(color) {
    noteTextarea.focus();
    notePushUndo();
    const sel = window.getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      noteSelectLine(noteCurrentLine());
    }
    document.execCommand("foreColor", false, color);
    scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  // Previously greyed out and disabled the color-picker trigger while a
  // DRC note was loaded, forcing DRC notes to stay plain black text. Now
  // a no-op so the text-color tool stays available for DRC notes too.
  function updateNoteColorToolAvailability() {
    noteColorTriggerBtn.disabled = false;
    noteColorTriggerBtn.classList.remove("disabled");
    noteColorTriggerBtn.title = "Text color";
  }

  // Review Trade-style Word-like Tab: advance to the next 96px stop with
  // a faint dot leader. The whole leader is one contenteditable=false token,
  // so one Backspace/Delete removes the entire Tab.
  const NOTE_DOT_TAB_STOP_PX = 96;
  const NOTE_DOT_TAB_FONT_SCALE = 0.72;
  const NOTE_DOT_TAB_LETTER_SPACING_PX = 0.55;
  let noteDotMeasureCanvas = null;

  function measureNoteDotWidth(editor) {
    if (!editor) return 3;
    if (!noteDotMeasureCanvas) noteDotMeasureCanvas = document.createElement("canvas");
    const ctx = noteDotMeasureCanvas.getContext("2d");
    if (!ctx) return 3;
    const cs = getComputedStyle(editor);
    const baseSize = parseFloat(cs.fontSize) || 13;
    ctx.font = `${cs.fontStyle || "normal"} 400 ${baseSize * NOTE_DOT_TAB_FONT_SCALE}px ${cs.fontFamily || "sans-serif"}`;
    return Math.max(1.5, ctx.measureText(".").width + NOTE_DOT_TAB_LETTER_SPACING_PX);
  }

  function noteCaretLeftPx(editor, range) {
    if (!editor || !range) return 0;
    const editorRect = editor.getBoundingClientRect();
    const cs = getComputedStyle(editor);
    const contentLeft = editorRect.left + (parseFloat(cs.paddingLeft) || 0);

    let rect = null;
    try {
      const rects = range.getClientRects();
      if (rects && rects.length) rect = rects[0];
    } catch (_) {}

    if (!rect || !Number.isFinite(rect.left) || (!rect.width && !rect.height)) {
      const marker = document.createElement("span");
      marker.textContent = "\u200B";
      marker.style.cssText = "display:inline-block;width:0;overflow:hidden;padding:0;margin:0;border:0;";
      try {
        range.insertNode(marker);
        rect = marker.getBoundingClientRect();
        range.setStartAfter(marker);
        range.collapse(true);
        marker.remove();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {
        try { marker.remove(); } catch (_) {}
      }
    }

    const x = rect && Number.isFinite(rect.left) ? rect.left - contentLeft : 0;
    return Math.max(0, x);
  }

  function insertNoteDotTab(editor, pushUndoFn) {
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;

    if (typeof pushUndoFn === "function") pushUndoFn();
    if (!range.collapsed) range.deleteContents();

    const x = noteCaretLeftPx(editor, range);
    let gap = NOTE_DOT_TAB_STOP_PX - (x % NOTE_DOT_TAB_STOP_PX);
    if (gap < 10) gap += NOTE_DOT_TAB_STOP_PX;

    const dotWidth = measureNoteDotWidth(editor);
    const count = Math.max(2, Math.round(gap / dotWidth));
    const tab = document.createElement("span");
    tab.className = "trade-review-dot-tab";
    tab.setAttribute("contenteditable", "false");
    tab.setAttribute("aria-label", "Tab");
    tab.textContent = ".".repeat(count);
    range.insertNode(tab);
    range.setStartAfter(tab);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    // v519: inserting the non-editable dot-tab can leave Chrome's collapsed
    // caret carrying a stale native bold typing state from the inline node
    // it just exited.  Do not silently change formatting here: re-evaluate
    // toolbar state from the real caret after the DOM mutation.  The extra
    // selectionchange is intentionally deferred until Chrome has settled
    // the caret around the contenteditable=false span.
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: "\t"
    }));
    requestAnimationFrame(() => {
      if (editor === noteTextarea) updateNoteToolActiveStates();
      else if (editor === brainstormTextarea) updateBrainstormToolActiveStates();
    });
    return true;
  }

  function noteDotTabAtEditingEdge(editor, range, backward) {
    if (!editor || !range || !range.collapsed) return null;
    const isTab = node => node?.nodeType === Node.ELEMENT_NODE &&
      node.classList?.contains("trade-review-dot-tab");

    let node = range.startContainer;
    let offset = range.startOffset;

    if (node.nodeType === Node.TEXT_NODE) {
      const atEdge = backward ? offset === 0 : offset === node.data.length;
      if (!atEdge) return null;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const idx = backward ? offset - 1 : offset;
      if (idx >= 0 && idx < node.childNodes.length) {
        const candidate = node.childNodes[idx];
        if (isTab(candidate)) return candidate;
        if (!(candidate.nodeType === Node.TEXT_NODE && candidate.data === "")) return null;
      }
    }

    while (node && node !== editor) {
      const sibling = backward ? node.previousSibling : node.nextSibling;
      if (sibling) {
        if (isTab(sibling)) return sibling;
        if (sibling.nodeType === Node.TEXT_NODE && sibling.data === "") {
          node = sibling;
          continue;
        }
        return null;
      }
      node = node.parentNode;
    }
    return null;
  }

  function deleteNoteDotTab(editor, tab, pushUndoFn, inputType) {
    if (!editor || !tab || !tab.parentNode) return false;
    if (typeof pushUndoFn === "function") pushUndoFn();
    const parent = tab.parentNode;
    const index = Array.prototype.indexOf.call(parent.childNodes, tab);
    tab.remove();
    const sel = window.getSelection();
    const range = document.createRange();
    try {
      range.setStart(parent, Math.max(0, Math.min(index, parent.childNodes.length)));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: inputType || "deleteContentBackward"
    }));
    return true;
  }

  function noteApplyStrikethrough() {
    noteTextarea.focus();
    notePushUndo();
    const sel = window.getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      noteSelectLine(noteCurrentLine());
    }
    document.execCommand("strikeThrough");
    scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  function noteSetBoldState(on) {
    let current = false;
    try { current = document.queryCommandState("bold"); } catch (_) {}
    if (!!current === !!on) return false;
    try { document.execCommand("bold", false, null); } catch (_) {}
    return true;
  }

  function noteClearFadeStateIfNeeded() {
    if (!noteCurrentForeColorIsFade()) return false;
    try { document.execCommand("foreColor", false, noteNormalTextColor()); } catch (_) {}
    return true;
  }

  function noteApplyNormal() {
    noteTextarea.focus();
    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    if (!collapsed) notePushUndo();

    noteTextStyleMode = "n";
    noteUppercasePending = false;
    const changedBold = noteSetBoldState(false);
    const changedFade = noteClearFadeStateIfNeeded();

    if (!collapsed && (changedBold || changedFade)) scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  function noteApplyFade() {
    noteTextarea.focus();
    const fadeBtn = $("#note-tool-fade");
    if (fadeBtn && fadeBtn.classList.contains("active")) {
      noteApplyNormal();
      return;
    }

    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    if (!collapsed) notePushUndo();

    noteTextStyleMode = "f";
    noteUppercasePending = false;
    noteSetBoldState(false);
    try { document.execCommand("foreColor", false, NOTE_FADE_COLOR); } catch (_) {}

    if (!collapsed) scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  function noteApplyBold() {
    noteTextarea.focus();
    const boldBtn = $("#note-tool-bold");
    if (boldBtn && boldBtn.classList.contains("active")) {
      noteApplyNormal();
      return;
    }

    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    if (!collapsed) notePushUndo();

    noteTextStyleMode = "b";
    noteUppercasePending = false;
    noteClearFadeStateIfNeeded();
    noteSetBoldState(true);

    if (!collapsed) scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  function noteApplyUppercase() {
    noteTextarea.focus();
    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;
    if (collapsed) {
      // No selection: arm/disarm "type in caps" mode for what comes next
      // (see the beforeinput hook below) instead of uppercasing anything
      // that already exists.
      noteUppercasePending = !noteUppercasePending;
      updateNoteToolActiveStates();
      return;
    }
    notePushUndo();
    const text = sel.toString();
    if (!text) return;
    document.execCommand("insertText", false, text.toUpperCase());
    scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  // Shared BB selection transform: preserve the selected rich-text markup,
  // uppercase only text nodes, make the whole selection bold, then collapse
  // the caret at the END of the transformed selection so typing can continue.
  // The caller owns undo/autosave and the AA-style pending state.
  function applyBoldUppercaseSelection(editor) {
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;

    const fragment = range.extractContents();
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => { node.data = node.data.toUpperCase(); });

    const wrap = document.createElement("span");
    wrap.setAttribute("data-bb-temp", "1");
    wrap.appendChild(fragment);
    range.insertNode(wrap);

    const selected = document.createRange();
    selected.selectNodeContents(wrap);
    selection.removeAllRanges();
    selection.addRange(selected);
    try {
      if (!document.queryCommandState("bold")) document.execCommand("bold", false, null);
    } catch (e) {
      try { document.execCommand("bold", false, null); } catch (_) {}
    }

    // The wrapper exists only to keep one stable range while execCommand
    // applies Bold. Unwrap it immediately so BB does not leave extra saved
    // markup behind in Note/DRC/Brainstorm HTML.
    const parent = wrap.parentNode;
    if (parent) {
      const after = wrap.nextSibling;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      parent.removeChild(wrap);
      const caret = document.createRange();
      if (after && after.parentNode === parent) caret.setStartBefore(after);
      else caret.setStart(parent, parent.childNodes.length);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    return true;
  }

  function noteApplyBoldUppercase() {
    noteTextarea.focus();
    const bbBtn = $("#note-tool-bold-upper");
    if (bbBtn && bbBtn.classList.contains("active")) {
      noteApplyNormal();
      return;
    }

    const sel = window.getSelection();
    const collapsed = !sel.rangeCount || sel.getRangeAt(0).collapsed;

    if (collapsed) {
      noteTextStyleMode = "bb";
      noteUppercasePending = true;
      noteClearFadeStateIfNeeded();
      noteSetBoldState(true);
      updateNoteToolActiveStates();
      return;
    }

    // With selected text, BB formats the selection AND immediately arms
    // the caret at its end for continued BOLD + UPPERCASE typing.
    notePushUndo();
    noteClearFadeStateIfNeeded();
    if (!applyBoldUppercaseSelection(noteTextarea)) return;
    noteTextStyleMode = "bb";
    noteUppercasePending = true;
    noteSetBoldState(true);
    noteTextarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    scheduleNoteAutosave();
    updateNoteToolActiveStates();
  }

  function noteInsertSymbol(symbol) {
    // v361: insert emoji/symbol as one plain text node at the saved caret.
    // Avoid execCommand here: Android contenteditable/IME can inherit or
    // split surrounding inline formatting, which made emoji appear in
    // seemingly random places/styles.
    const sel = window.getSelection();
    let range = null;
    if (sel && sel.rangeCount) {
      const candidate = sel.getRangeAt(0);
      if (noteTextarea.contains(candidate.commonAncestorContainer)) {
        range = candidate.cloneRange();
      }
    }
    noteTextarea.focus();
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(noteTextarea);
      range.collapse(false);
    }
    notePushUndo();
    range.deleteContents();
    const node = document.createTextNode(String(symbol || ""));
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    noteTextarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: String(symbol || "")
    }));
    scheduleNoteAutosave();
  }

  // Enter key on a numbered or checklist line continues the pattern
  // ("1." -> "2.", "☐" -> "☐"); pressing Enter on an empty list line
  // breaks out of the list instead of continuing it forever.
  //
  // The split happens at the caret, not always at the end of the line:
  // whatever was typed before the caret stays on the current line, and
  // whatever was typed after it moves down onto the new list line (same
  // as a normal editor). Without this, pressing Enter with the caret at
  // the very start of a line's typed content (right after the "☐ "/"1. "
  // prefix) would leave the line's text untouched and just add a new,
  // empty list item below it — moving the cursor without moving the text
  // the user meant to push down.
  // Splits a plain (non-numbered, non-checklist) line into two SIBLING
  // <div>s ourselves on Enter, instead of letting the browser's native
  // "insertParagraph" handle it. Left to the browser, pressing Enter a
  // second (or later) time inside an existing line <div> can nest the
  // new line INSIDE that div rather than placing it next to it as a
  // sibling — invisible while just reading the note, but it breaks
  // every bit of per-line logic that walks the editor's direct children
  // (notably noteAutoColorParagraphs' cycling palette), since a nested
  // line is never seen as a line of its own and just inherits its
  // parent's color instead of getting the next one in rotation — which
  // is why every line after the first can end up stuck on one color.
  // Splitting via Range.extractContents (rather than textContent, which
  // would flatten any bold/colored spans already in the line) keeps
  // existing inline formatting intact on both halves of the split.
  // A bare <br> for an empty line, or that <br> wrapped in a <font color>
  // when `color` isn't the note's plain default — used when a new line
  // has nothing extracted onto it (see noteHandlePlainLineEnter below).
  // Without this, an empty line has no colored span for the caret to sit
  // inside, so anything typed on it falls back to the browser's default
  // black instead of continuing in whatever color the line above it was.
  const NOTE_DEFAULT_TEXT_RGB = "rgb(43, 42, 37)"; // #2b2a25, the "Default text" swatch
  // `baseRgb` (optional) is the color the line itself already renders in —
  // e.g. its own div-level color. The <font> wrapper is only needed when the
  // caret color differs from that, not from the global default.
  function noteEmptyLineContent(color, baseRgb) {
    const br = document.createElement("br");
    const plain = (baseRgb || NOTE_DEFAULT_TEXT_RGB).replace(/\s+/g, "");
    if (!color || color.replace(/\s+/g, "") === plain) return br;
    const font = document.createElement("font");
    font.setAttribute("color", color);
    font.appendChild(br);
    return font;
  }

  function noteHandlePlainLineEnter(el, sel) {
    if (el === noteTextarea) return false; // no wrapping div yet — let the browser create the very first one
    notePushUndo();
    // Capture the color in effect right at the caret before splitting —
    // needed below if either half of the split ends up empty.
    const caretColor = document.queryCommandValue("foreColor");
    // With 🎨 auto-color off nothing re-colors lines for us, so Enter has to
    // carry the current color over by itself: the line's own div-level color
    // (left over from when auto-color was on) and whatever inline color the
    // caret is sitting in. With it on, noteAutoColorParagraphs below keeps
    // assigning the next color in the rotation, as before.
    const keepColor = !noteAutoColorEnabled;
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
    if (keepColor && el.style.color) newDiv.style.color = el.style.color;
    el.parentNode.insertBefore(newDiv, el.nextSibling);
    // Caret at the very end of a colored run leaves only empty inline
    // shells (<font color></font>) in the extracted fragment; the caret
    // would then land before them, outside the color. Treat that as an
    // empty line so the color is rebuilt around the caret below.
    const fragHasContent = frag.hasChildNodes() &&
      !(keepColor && !(frag.textContent || "").replace(/\u200b/g, "") && !(frag.querySelector && frag.querySelector("img")));
    let newDivEmptyContent = null;
    if (fragHasContent) newDiv.appendChild(frag);
    else newDiv.appendChild((newDivEmptyContent = noteEmptyLineContent(caretColor, keepColor ? getComputedStyle(newDiv).color : undefined)));
    if (!el.hasChildNodes()) el.appendChild(noteEmptyLineContent(caretColor, keepColor ? getComputedStyle(el).color : undefined));
    noteAutoColorParagraphs();
    const caretRange = document.createRange();
    // If the new line is the empty-<font><br></font> case, put the caret
    // *inside* the font element (before the <br>) so typed text lands
    // inside that colored span instead of as a plain sibling of it.
    if (newDivEmptyContent && newDivEmptyContent.nodeName === "FONT") {
      caretRange.setStart(newDivEmptyContent, 0);
    } else {
      caretRange.selectNodeContents(newDiv);
    }
    caretRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caretRange);
    scrollCaretIntoView(newDiv);
    scheduleNoteAutosave();
    return true;
  }

  function noteHandleEnter() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    const lineDiv = noteCurrentLine();
    const el = lineDiv || noteTextarea;
    const lineText = el.textContent;
    const numMatch = lineText.match(/^(\d+)\.\s+/);
    const checkMatch = lineText.match(/^([☐☑])\s+/);
    if (!numMatch && !checkMatch) return noteHandlePlainLineEnter(el, sel);
    const prefix = (numMatch || checkMatch)[0];
    const rest = lineText.slice(prefix.length);
    if (rest.trim() === "") {
      notePushUndo();
      el.textContent = "";
      placeCaretAtEnd(el);
      scrollCaretIntoView(el);
      scheduleNoteAutosave();
      return true;
    }

    // How much of the line's text (prefix included) sits before the
    // caret, measured via a range from the start of the line to the
    // caret — same technique as noteCaretIsAtLineStart, but keeping the
    // length instead of just checking for zero.
    const range = sel.getRangeAt(0);
    let beforeCaretLen = lineText.length; // fall back to "caret at end"
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      beforeCaretLen = preRange.toString().length;
    } catch (err) { /* keep fallback */ }

    const caretInRest = Math.max(0, Math.min(rest.length, beforeCaretLen - prefix.length));
    const before = rest.slice(0, caretInRest);
    const after = rest.slice(caretInRest);

    notePushUndo();
    const nextPrefix = numMatch ? `${parseInt(numMatch[1], 10) + 1}. ` : "☐ ";
    // With 🎨 auto-color off, the new line must keep the current color:
    // capture it before the text is rewritten below.
    const keepColor = !noteAutoColorEnabled;
    const caretColor = keepColor ? document.queryCommandValue("foreColor") : "";
    // Enter at the end of the line moves no text, so leave the line's
    // markup (and any inline colors in it) untouched instead of flattening
    // it through textContent.
    if (after !== "" || !keepColor) el.textContent = prefix + before;
    if (numMatch) noteSetOrderedLineColor(el);
    noteSyncLineChecked(el);

    const newDiv = document.createElement("div");
    newDiv.textContent = nextPrefix + after;
    if (keepColor) {
      if (el.style.color) newDiv.style.color = el.style.color;
      // Inline color at the caret (picked via the toolbar) isn't inherited
      // by a fresh div, so wrap the new line's text in it when it differs
      // from what the line already renders as.
      if (lineDiv && lineDiv.parentNode) lineDiv.parentNode.insertBefore(newDiv, lineDiv.nextSibling);
      else noteTextarea.appendChild(newDiv);
      const plain = getComputedStyle(newDiv).color.replace(/\s+/g, "");
      if (caretColor && caretColor.replace(/\s+/g, "") !== plain) {
        const font = document.createElement("font");
        font.setAttribute("color", caretColor);
        font.textContent = newDiv.textContent;
        newDiv.textContent = "";
        newDiv.appendChild(font);
      }
    }
    if (numMatch) noteSetOrderedLineColor(newDiv);
    noteSyncLineChecked(newDiv);
    if (!newDiv.parentNode) {
      if (lineDiv && lineDiv.parentNode) {
        lineDiv.parentNode.insertBefore(newDiv, lineDiv.nextSibling);
      } else {
        noteTextarea.appendChild(newDiv);
      }
    }

    // Caret goes right after the new line's prefix — i.e. right before
    // whatever text got pushed down onto it.
    const textNode = newDiv.firstChild && newDiv.firstChild.nodeName === "FONT" ? newDiv.firstChild.firstChild : newDiv.firstChild;
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
    scheduleNoteAutosave();
    return true;
  }

  // Photos are embedded directly as data-URI <img> tags inside the note's
  // HTML — consistent with the app being fully offline/self-contained, since
  // nothing needs to be uploaded anywhere and the image travels with the
  // map's .json (export, or the mirrored folder file) automatically.
  const noteImageInput = $("#note-image-input");
  const noteCameraInput = $("#note-camera-input");
  // Line (and caret-at-start state) captured at the moment the image-toolbar
  // button is clicked, before the native file picker steals focus/selection
  // away from the note.
  let noteImageInsertLine = null;
  let noteImageInsertAtStart = false;

  // Inserts one line per dataUrl, each containing an <img>, in order.
  // Normally they go right after the current line, with a single empty
  // line left after the last one so the caret has somewhere to keep
  // typing. But if the caret was at the very start of the line (nothing
  // typed before it), the images go above that line instead, since that's
  // where a cursor at position zero implies the photo(s) belong.
  //
  // Every newly inserted photo starts at 20% of the note's own default
  // display size — the same width/height style.css falls back to (see
  // .note-textarea img: width min(420px,100%), height 300px) — rather
  // than full size, since a freshly dropped-in photo is more often
  // glanced at than read closely; the ➖/➕ buttons (see
  // noteImageShrinkBtn/noteImageGrowBtn below) resize it from there.
  const NOTE_IMG_DEFAULT_INSERT_WIDTH = 84;  // 20% of the 420px default width
  const NOTE_IMG_DEFAULT_INSERT_HEIGHT = 60; // 20% of the 300px default height
  // Builds the actual <img> for one inserted photo — stores it in PhotoDB
  // (dedup'd against every other photo already on this map, node photos
  // included, see addPhotoRecord) rather than embedding its base64 bytes
  // straight into the note's HTML. The live DOM element still shows the
  // photo via a normal object-URL src (see photoUrl); only the note's
  // *stored* copy (see captureActiveNote's stripping step) drops that src
  // down to just the data-photo-id reference.
  function noteMakeImageEl(dataUrl) {
    const id = addPhotoRecord(dataUrl);
    const img = document.createElement("img");
    img.dataset.photoId = id;
    img.src = photoUrl(id);
    img.style.width = `${NOTE_IMG_DEFAULT_INSERT_WIDTH}px`;
    img.style.height = `${NOTE_IMG_DEFAULT_INSERT_HEIGHT}px`;
    return img;
  }
  function noteInsertImages(dataUrls, targetLine, atStart) {
    noteTextarea.focus();
    notePushUndo();
    // Prefer the line captured before focus was stolen (e.g. by the native
    // file picker); falling back to a fresh lookup covers callers (like
    // paste) where the selection is still live at call time.
    const lineDiv = targetLine !== undefined ? targetLine : noteCurrentLine();
    const validLine = lineDiv && lineDiv.parentNode === noteTextarea;
    const parent = validLine ? lineDiv.parentNode : noteTextarea;

    if (atStart && validLine) {
      // Place every image above the line, in order, and leave the line
      // (and its caret) untouched below them — no extra spacer line
      // needed since the original line is already there to keep typing
      // into.
      dataUrls.forEach((dataUrl) => {
        const imgLine = document.createElement("div");
        imgLine.appendChild(noteMakeImageEl(dataUrl));
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
        imgLine.appendChild(noteMakeImageEl(dataUrl));
        parent.insertBefore(imgLine, cursor ? cursor.nextSibling : null);
        cursor = imgLine;
        lastImgLine = imgLine;
      });
      const afterLine = document.createElement("div");
      afterLine.appendChild(document.createElement("br"));
      parent.insertBefore(afterLine, lastImgLine ? lastImgLine.nextSibling : null);
      placeCaretAtEnd(afterLine);
    }
    scheduleNoteAutosave();
  }


  // Single-image convenience wrapper (used by clipboard paste, which only
  // ever offers one image at a time).
  function noteInsertImage(dataUrl, targetLine, atStart) {
    noteInsertImages([dataUrl], targetLine, atStart);
  }

  // Images embedded in a note live inline as base64 in the node's own
  // `notes` array — which is part of the same tree that gets fully
  // JSON.stringify'd on every pushUndo() (map-level undo, fired by the
  // note's own autosave — see commitNotesToNode) and on every persist().
  // Storing screenshots at their original, un-downscaled resolution meant
  // every one of those serializations re-cloned every embedded image
  // across the *whole map*, not just the note being edited — on a
  // trading-journal map with a run of DRC notes full of pasted chart
  // screenshots, a single one of those clones could itself spike memory
  // into an "Out of Memory" tab crash, independent of how many snapshots
  // the undo stacks keep. Downscaling/re-encoding each pasted image here
  // (skipped when it's already small) keeps that per-image cost small
  // regardless of how many screenshots accumulate in the map.
  //
  // Photos are now kept exactly as added: NOTE_IMAGE_DOWNSCALE is off, so
  // nothing is resized or re-encoded on paste/drop/pick, and photos already
  // in a note are no longer shrunk when it's opened. Flip it back to true
  // to restore the memory-saving behavior above (1600px long edge, JPEG 0.85).
  const NOTE_IMAGE_DOWNSCALE = false;
  const NOTE_IMAGE_MAX_DIM = 1600; // long-edge cap, px
  const NOTE_IMAGE_SKIP_BYTES = 400 * 1024; // already-small pastes go through untouched
  function downscaleNoteImageDataUrl(dataUrl) {
    return new Promise((resolve) => {
      if (!NOTE_IMAGE_DOWNSCALE) { resolve(dataUrl); return; } // keep the original bytes, 100% quality
      if (!dataUrl || dataUrl.length <= NOTE_IMAGE_SKIP_BYTES) { resolve(dataUrl); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, NOTE_IMAGE_MAX_DIM / Math.max(img.width, img.height));
          if (scale >= 1) { resolve(dataUrl); return; } // small dimensions, just a big/lossless file — leave it
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) {
          resolve(dataUrl); // fail safe — keep the original rather than lose the paste
        } finally {
          img.onload = img.onerror = null;
        }
      };
      img.onerror = () => { img.onload = img.onerror = null; resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  // Reads every file first (in parallel), downscales any that are large,
  // then inserts them in their original order once they've all finished,
  // so a slow read/downscale never scrambles the sequence.
  function noteHandleImageFiles(fileList, targetLine, atStart) {
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
        if (loaded.length) noteInsertImages(loaded, targetLine, atStart);
        if (hadError) alert("Some images couldn't be read.");
      });
  }

  // Kept for the single-file paste path.
  function noteHandleImageFile(file, targetLine, atStart) {
    if (!file) return;
    noteHandleImageFiles([file], targetLine, atStart);
  }

  $("#note-tool-image").addEventListener("mousedown", (e) => e.preventDefault());
  $("#note-tool-image").addEventListener("click", () => {
    // Capture the cursor's line (and whether it's at the line's start) now,
    // before the native file picker opens and steals focus/selection out
    // from under the note (see noteInsertImage).
    noteImageInsertLine = noteCurrentLine();
    noteImageInsertAtStart = noteCaretIsAtLineStart(noteImageInsertLine);
    noteImageInput.click();
  });
  noteImageInput.addEventListener("change", () => {
    if (noteImageInput.files && noteImageInput.files.length) {
      noteHandleImageFiles(noteImageInput.files, noteImageInsertLine, noteImageInsertAtStart);
    }
    noteImageInput.value = ""; // reset so picking the same file(s) again still fires change
  });

  // v520: direct rear-camera capture on touch devices. The captured image
  // uses the same downscale, PhotoDB insertion and autosave path as gallery photos.
  const noteCameraBtn = $("#note-tool-camera");
  if (noteCameraBtn && noteCameraInput) {
    noteCameraBtn.addEventListener("mousedown", (e) => e.preventDefault());
    noteCameraBtn.addEventListener("click", () => {
      noteImageInsertLine = noteCurrentLine();
      noteImageInsertAtStart = noteCaretIsAtLineStart(noteImageInsertLine);
      noteCameraInput.click();
    });
    noteCameraInput.addEventListener("change", () => {
      if (noteCameraInput.files && noteCameraInput.files.length) {
        noteHandleImageFiles(noteCameraInput.files, noteImageInsertLine, noteImageInsertAtStart);
      }
      noteCameraInput.value = "";
    });
  }

  noteTextarea.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        e.preventDefault();
        // Capture the line and start-of-line state synchronously, while the
        // selection is still live, before the async file read resolves.
        const pasteLine = noteCurrentLine();
        const pasteAtStart = noteCaretIsAtLineStart(pasteLine);
        noteHandleImageFile(item.getAsFile(), pasteLine, pasteAtStart);
        return;
      }
    }
    // Let the browser perform an ordinary text/rich-text paste first, then
    // convert any plain URLs it inserted. A caret marker keeps the insertion
    // point exactly where the browser left it, so typing can continue.
    setTimeout(() => {
      if (noteLinkifyUrls(noteTextarea, true)) scheduleNoteAutosave();
    }, 0);
  });

  function noteDraggedImageFile(e) {
    const dt = e.dataTransfer;
    if (!dt) return null;
    const fromFiles = dt.files && Array.from(dt.files).find(f => f.type && f.type.startsWith("image/"));
    if (fromFiles) return fromFiles;
    const hasImageItem = dt.items && Array.from(dt.items).some(i => i.type && i.type.startsWith("image/"));
    return hasImageItem ? true : null; // "true" just signals we should preventDefault on dragover
  }

  noteTextarea.addEventListener("dragover", (e) => {
    if (noteDraggedImageFile(e)) {
      e.preventDefault();
      noteTextarea.classList.add("drag-over");
    }
  });
  noteTextarea.addEventListener("dragleave", () => noteTextarea.classList.remove("drag-over"));
  noteTextarea.addEventListener("drop", (e) => {
    const file = noteDraggedImageFile(e);
    if (file && file !== true) {
      e.preventDefault();
      noteTextarea.classList.remove("drag-over");
      noteHandleImageFile(file);
    } else {
      noteTextarea.classList.remove("drag-over");
    }
  });

  // ---- Shrink/grow buttons for inline note photos ----
  // A small "−" and "+" pair that hover over whichever note image the
  // pointer is currently over, so the photo's display size can be shrunk
  // or grown back with one click instead of dragging the resize handle in
  // its corner (see the resize:both rule on .note-textarea img in
  // style.css). Kept as a single floating pair positioned over whichever
  // image is hovered, rather than one pair per image, so nothing extra
  // needs wiring up when new images are pasted or dropped in.
  const noteImageShrinkBtn = document.createElement("button");
  noteImageShrinkBtn.type = "button";
  noteImageShrinkBtn.className = "note-img-shrink-btn hidden";
  noteImageShrinkBtn.title = "Make this photo smaller";
  noteImageShrinkBtn.setAttribute("aria-label", "Make this photo smaller");
  noteImageShrinkBtn.textContent = "−";
  document.body.appendChild(noteImageShrinkBtn);

  const noteImageGrowBtn = document.createElement("button");
  noteImageGrowBtn.type = "button";
  noteImageGrowBtn.className = "note-img-shrink-btn note-img-grow-btn hidden";
  noteImageGrowBtn.title = "Make this photo bigger";
  noteImageGrowBtn.setAttribute("aria-label", "Make this photo bigger");
  noteImageGrowBtn.textContent = "+";
  document.body.appendChild(noteImageGrowBtn);

  let noteImageShrinkTarget = null;
  // Which editor the hovered photo belongs to — the note editor by default,
  // or the Brainstorm scratchpad (see the brainstormTextarea listeners
  // below) — so the same floating −/+ pair can snapshot undo and autosave
  // through the right editor.
  const NOTE_IMG_HOST_NOTE = { pushUndo: () => notePushUndo(), save: () => scheduleNoteAutosave() };
  let noteImageShrinkHost = NOTE_IMG_HOST_NOTE;

  function positionNoteImageShrinkBtn(img) {
    const rect = img.getBoundingClientRect();
    noteImageGrowBtn.style.left = `${rect.right - 26}px`;
    noteImageGrowBtn.style.top = `${rect.top + 4}px`;
    noteImageShrinkBtn.style.left = `${rect.right - 52}px`;
    noteImageShrinkBtn.style.top = `${rect.top + 4}px`;
  }
  function showNoteImageShrinkBtn(img, host) {
    noteImageShrinkTarget = img;
    noteImageShrinkHost = host || NOTE_IMG_HOST_NOTE;
    positionNoteImageShrinkBtn(img);
    noteImageShrinkBtn.classList.remove("hidden");
    noteImageGrowBtn.classList.remove("hidden");
  }
  function hideNoteImageShrinkBtn() {
    noteImageShrinkTarget = null;
    noteImageShrinkBtn.classList.add("hidden");
    noteImageGrowBtn.classList.add("hidden");
  }
  noteTextarea.addEventListener("mouseover", (e) => {
    if (e.target && e.target.tagName === "IMG") showNoteImageShrinkBtn(e.target, NOTE_IMG_HOST_NOTE);
  });
  noteTextarea.addEventListener("mouseout", (e) => {
    if (e.target && e.target.tagName === "IMG" &&
        !noteImageShrinkBtn.contains(e.relatedTarget) && !noteImageGrowBtn.contains(e.relatedTarget)) {
      hideNoteImageShrinkBtn();
    }
  });
  noteTextarea.addEventListener("scroll", () => {
    if (noteImageShrinkTarget) positionNoteImageShrinkBtn(noteImageShrinkTarget);
  });
  window.addEventListener("resize", () => {
    if (noteImageShrinkTarget) positionNoteImageShrinkBtn(noteImageShrinkTarget);
  });
  // Prevent the mousedown from stealing focus/selection out of the note,
  // same pattern as the symbol/color popovers.
  noteImageShrinkBtn.addEventListener("mousedown", (e) => e.preventDefault());
  noteImageGrowBtn.addEventListener("mousedown", (e) => e.preventDefault());
  noteImageShrinkBtn.addEventListener("mouseleave", hideNoteImageShrinkBtn);
  noteImageGrowBtn.addEventListener("mouseleave", hideNoteImageShrinkBtn);
  const NOTE_IMG_MIN_WIDTH = 80;
  const NOTE_IMG_MIN_HEIGHT = 60;
  noteImageShrinkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const img = noteImageShrinkTarget;
    if (!img) return;
    const NOTE_IMG_SHRINK_FACTOR = 0.2;
    noteImageShrinkHost.pushUndo();
    const w = Math.max(NOTE_IMG_MIN_WIDTH, Math.round(img.offsetWidth * NOTE_IMG_SHRINK_FACTOR));
    const h = Math.max(NOTE_IMG_MIN_HEIGHT, Math.round(img.offsetHeight * NOTE_IMG_SHRINK_FACTOR));
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    positionNoteImageShrinkBtn(img);
    noteImageShrinkHost.save();
  });
  // Grows back by the shrink button's inverse (5x), capped at the photo's
  // own natural resolution so it never upscales past its real pixel size.
  noteImageGrowBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const img = noteImageShrinkTarget;
    if (!img) return;
    const NOTE_IMG_GROW_FACTOR = 5;
    noteImageShrinkHost.pushUndo();
    const maxW = img.naturalWidth || Infinity;
    const maxH = img.naturalHeight || Infinity;
    const w = Math.min(maxW, Math.round(img.offsetWidth * NOTE_IMG_GROW_FACTOR));
    const h = Math.min(maxH, Math.round(img.offsetHeight * NOTE_IMG_GROW_FACTOR));
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    positionNoteImageShrinkBtn(img);
    noteImageShrinkHost.save();
  });

  // Clicking directly on a recognized URL opens it in a new tab. This is
  // handled explicitly because links inside a contenteditable normally put
  // the caret in the anchor instead of navigating. It also covers real
  // <a> tags pasted from rich text, not only our own auto-created links.
  // Clicking directly on a checklist glyph toggles it, like a real checkbox.
  noteTextarea.addEventListener("click", (e) => {
    const link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (link && noteTextarea.contains(link)) {
      const href = noteSafeAnchorHref(link.getAttribute("href"));
      if (href) {
        e.preventDefault();
        e.stopPropagation();
        const opened = window.open(href, "_blank", "noopener,noreferrer");
        if (opened) opened.opener = null;
      }
      return;
    }
    if (e.target && e.target.tagName === "IMG") {
      openNotePhotoViewer(e.target);
      return;
    }
    const lineDiv = noteCurrentLine();
    const text = (lineDiv || noteTextarea).textContent;
    if (!/^[☐☑]\s/.test(text)) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    // A click-drag that selects text (rather than a plain click) still
    // lands here as a "click" once the mouse is released — without this,
    // starting a text selection right at/near the glyph toggled the
    // checkbox as a side effect instead of just selecting the line.
    if (!sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(lineDiv || noteTextarea);
    preRange.setEnd(range.startContainer, range.startOffset);
    if (preRange.toString().length > 1) return; // only toggle when clicking right on the glyph
    notePushUndo();
    const el = lineDiv || noteTextarea;
    el.textContent = text.replace(/^[☐☑]/, m => (m === "☐" ? "☑" : "☐"));
    noteSyncLineChecked(el);
    scheduleNoteAutosave();
  });

  noteUndoBtn.addEventListener("mousedown", (e) => e.preventDefault());
  noteUndoBtn.addEventListener("click", () => noteUndo());
  noteRedoBtn.addEventListener("mousedown", (e) => e.preventDefault());
  noteRedoBtn.addEventListener("click", () => noteRedo());

  $("#note-tool-ol").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteToggleOrderedList();
  });
  // ---- "😊 Mood To Day" block ----
  // A reusable, non-editable block dropped into the note from the toolbar:
  // a heading plus a row of five faces. Tapping a face marks it (tap it
  // again to clear). The block is plain markup (class + data attributes,
  // no state kept in JS), so it saves with the note, survives undo/redo
  // and reload, and copies/pastes between notes like any other content —
  // the click handler below is delegated on the editor, so a pasted or
  // reloaded block works without any re-wiring.
  const NOTE_MOOD_FACES = [["😀", "Great"], ["🙂", "Good"], ["😐", "Okay"], ["🙁", "Low"], ["😞", "Bad"]];
  function noteBuildMoodBlock() {
    const block = document.createElement("div");
    block.className = "note-mood";
    block.setAttribute("data-mood-block", "1");
    block.setAttribute("contenteditable", "false");
    const title = document.createElement("div");
    title.className = "note-mood-title";
    title.textContent = "Mood To Day";
    const row = document.createElement("div");
    row.className = "note-mood-faces";
    NOTE_MOOD_FACES.forEach(([ch, label], i) => {
      const face = document.createElement("span");
      face.className = "note-mood-face";
      face.dataset.moodValue = String(i + 1);
      face.title = label;
      face.setAttribute("role", "button");
      face.setAttribute("aria-pressed", "false");
      face.textContent = ch;
      row.appendChild(face);
    });
    block.append(title, row);
    return block;
  }
  // The old note-editor "Mood To Day" widget has been retired. Existing
  // saved mood blocks are migrated to the single face that was selected,
  // preserving the user's information without leaving the old interactive
  // widget behind. An unselected old block carries no choice, so it is removed.
  function noteMigrateLegacyMoodBlocks() {
    let changed = false;
    noteTextarea.querySelectorAll(".note-mood").forEach((block) => {
      let emoji = "";
      const selected = block.querySelector(".note-mood-face.selected");
      if (selected) {
        emoji = selected.textContent || "";
      } else {
        const moodValue = Number(block.getAttribute("data-mood"));
        if (moodValue >= 1 && moodValue <= NOTE_MOOD_FACES.length) {
          emoji = NOTE_MOOD_FACES[moodValue - 1][0];
        }
      }
      if (emoji) {
        const line = document.createElement("div");
        line.textContent = emoji;
        block.replaceWith(line);
      } else {
        block.remove();
      }
      changed = true;
    });
    return changed;
  }

  // ---- Add emoji -------------------------------------------------------
  // The note toolbar's 😊 button now opens a simple five-face picker.
  // Choosing one inserts that emoji as ordinary editable note text at the
  // current caret/selection; there is no mood heading, block, selection
  // state, or special saved markup.
  const noteEmojiTriggerBtn = $("#note-tool-emoji");
  const noteEmojiPopover = $("#note-emoji-popover");

  function positionNoteEmojiPopover() {
    const margin = 8;
    const btnRect = noteEmojiTriggerBtn.getBoundingClientRect();
    const popRect = noteEmojiPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6;
    }
    noteEmojiPopover.style.left = `${left}px`;
    noteEmojiPopover.style.top = `${top}px`;
  }
  function openNoteEmojiPopover() {
    noteEmojiPopover.classList.remove("hidden");
    positionNoteEmojiPopover();
  }
  function closeNoteEmojiPopover() {
    noteEmojiPopover.classList.add("hidden");
  }

  noteEmojiTriggerBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // preserve the note caret/selection
    e.stopPropagation();
    // Only one floating note-toolbar picker should be open at a time.
    const colorPopover = $("#note-color-popover");
    if (colorPopover && !colorPopover.classList.contains("hidden")) colorPopover.classList.add("hidden");
    if (noteEmojiPopover.classList.contains("hidden")) openNoteEmojiPopover();
    else closeNoteEmojiPopover();
  });
  noteEmojiPopover.addEventListener("pointerdown", (e) => e.stopPropagation());
  noteEmojiPopover.querySelectorAll(".note-emoji-swatch").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // v501: Yahoo choices contain only an <img>, so the old fallback
      // (btn.dataset.emoji || btn.textContent) was an empty string and
      // inserted nothing. Handle animated Yahoo GIFs here, in the original
      // picker pointerdown path, before the popover is closed.
      if (btn.dataset.yahooGif) {
        const sel = window.getSelection();
        let range = null;
        if (sel && sel.rangeCount) {
          const candidate = sel.getRangeAt(0);
          if (noteTextarea.contains(candidate.commonAncestorContainer)) range = candidate.cloneRange();
        }
        noteTextarea.focus();
        if (!range) { range = document.createRange(); range.selectNodeContents(noteTextarea); range.collapse(false); }

        notePushUndo();
        range.deleteContents();

        const yahoo = document.createElement("span");
        yahoo.className = "note-inline-yahoo-emoji";
        yahoo.dataset.yahooGif = btn.dataset.yahooGif;
        yahoo.dataset.yahooTitle = btn.dataset.yahooTitle || "Yahoo emoticon";
        yahoo.title = yahoo.dataset.yahooTitle;
        yahoo.setAttribute("contenteditable", "false");
        yahoo.setAttribute("aria-label", yahoo.dataset.yahooTitle);

        const yahooFile = btn.dataset.yahooGif.split("/").pop().replace(/\.gif(?:\?.*)?$/i, "");
        const yahooClass = "note-yahoo-" + yahooFile.toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        yahoo.classList.add(yahooClass);
        yahoo.style.backgroundImage = 'url("' + btn.dataset.yahooGif.replace(/"/g, "%22") + '")';
        yahoo.textContent = "\u00A0";

        range.insertNode(yahoo);
        range.setStartAfter(yahoo);
        range.collapse(true);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }

        noteTextarea.dispatchEvent(new InputEvent("input", {
          bubbles:true,
          inputType:"insertText",
          data:null
        }));
        scheduleNoteAutosave();
        btn.dataset.branchlineEmojiHandled = "1";
      } else if (btn.dataset.movingEmoji === "1") {
        const sel = window.getSelection();
        let range = null;
        if (sel && sel.rangeCount) {
          const candidate = sel.getRangeAt(0);
          if (noteTextarea.contains(candidate.commonAncestorContainer)) range = candidate.cloneRange();
        }
        noteTextarea.focus();
        if (!range) { range = document.createRange(); range.selectNodeContents(noteTextarea); range.collapse(false); }

        notePushUndo();
        range.deleteContents();

        const moving = document.createElement("span");
        moving.className = "note-moving-emoji";
        const motion = (btn.dataset.motion || "cheer").toLowerCase().replace(/[^a-z0-9-]/g, "");
        moving.classList.add("note-motion-" + motion);
        moving.dataset.movingEmoji = "1";
        moving.dataset.motion = motion;
        moving.setAttribute("contenteditable", "false");
        moving.setAttribute("aria-label", btn.title || "animated emoji");
        moving.textContent = btn.dataset.emoji || btn.textContent || "✨";

        range.insertNode(moving);
        range.setStartAfter(moving);
        range.collapse(true);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }

        noteTextarea.dispatchEvent(new InputEvent("input", {
          bubbles:true,
          inputType:"insertText",
          data:moving.textContent
        }));
        scheduleNoteAutosave();
        btn.dataset.branchlineEmojiHandled = "1";
      } else if (btn.dataset.animatedFire === "1" || btn.dataset.movingFireV493 === "1") {
        const sel = window.getSelection();
        let range = null;
        if (sel && sel.rangeCount) {
          const candidate = sel.getRangeAt(0);
          if (noteTextarea.contains(candidate.commonAncestorContainer)) range = candidate.cloneRange();
        }
        noteTextarea.focus();
        if (!range) { range = document.createRange(); range.selectNodeContents(noteTextarea); range.collapse(false); }
        notePushUndo();
        range.deleteContents();
        const fire = document.createElement("span");
        fire.className = "note-animated-fire";
        fire.setAttribute("contenteditable", "false");
        fire.setAttribute("aria-label", "animated fire");
        fire.textContent = "🔥";
        range.insertNode(fire);
        range.setStartAfter(fire); range.collapse(true);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        noteTextarea.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:null }));
        scheduleNoteAutosave();
        btn.dataset.branchlineEmojiHandled = "1";
      } else {
        const symbol = btn.dataset.emoji || btn.textContent;
        if (symbol) noteInsertSymbol(symbol);
      }
      closeNoteEmojiPopover();
    });
  });
  document.addEventListener("pointerdown", (e) => {
    if (!noteEmojiPopover.classList.contains("hidden") &&
        !noteEmojiPopover.contains(e.target) && e.target !== noteEmojiTriggerBtn) {
      closeNoteEmojiPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!noteEmojiPopover.classList.contains("hidden")) positionNoteEmojiPopover();
  });

  $("#note-tool-check").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteToggleLinePrefix(/^[☐☑]\s+/, () => "☐ ");
  });
  $("#note-tool-tab").addEventListener("mousedown", (e) => {
    e.preventDefault();
    insertNoteDotTab(noteTextarea, notePushUndo);
  });
  $("#note-tool-strike").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteApplyStrikethrough();
  });
  $("#note-tool-normal")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteApplyNormal();
  });
  $("#note-tool-fade")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteApplyFade();
  });
  $("#note-tool-bold").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteApplyBold();
  });
  $("#note-tool-bold-upper").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteApplyBoldUppercase();
  });
  const noteColorTriggerBtn = $("#note-tool-color");
  const noteColorPopover = $("#note-color-popover");
  const noteAutoColorChoice = $("#note-color-auto");

  function setNoteManualColorSelection(color) {
    setNoteAutoColorEnabled(false);
    noteColorPopover.querySelectorAll(".note-color-swatch").forEach((b) => b.classList.toggle("active", b.dataset.color === color));
    if (noteAutoColorChoice) noteAutoColorChoice.classList.remove("active");
    setNoteColorTrigger(color);
  }

  document.querySelectorAll(".note-color-swatch").forEach(btn => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      noteApplyForeColor(btn.dataset.color);
      setNoteManualColorSelection(btn.dataset.color);
    });
    btn.addEventListener("click", () => { closeNoteColorPopover(); });
  });
  $("#note-color-custom").addEventListener("input", (e) => {
    noteApplyForeColor(e.target.value);
    setNoteManualColorSelection(e.target.value);
  });
  $("#note-color-custom").addEventListener("mousedown", (e) => e.stopPropagation());

  noteAutoColorChoice?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setNoteAutoColorEnabled(true);
    noteColorPopover.querySelectorAll(".note-color-swatch").forEach((b) => b.classList.remove("active"));
    notePushUndo();
    noteSyncAllOrderedColors();
    noteAutoColorParagraphs();
    scheduleNoteAutosave();
  });
  noteAutoColorChoice?.addEventListener("click", () => closeNoteColorPopover());

  noteColorTriggerBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!noteEmojiPopover.classList.contains("hidden")) closeNoteEmojiPopover();
    if (noteColorPopover.classList.contains("hidden")) openNoteColorPopover();
    else closeNoteColorPopover();
  });
  noteColorPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!noteColorPopover.classList.contains("hidden") &&
        !noteColorPopover.contains(e.target) && e.target !== noteColorTriggerBtn) closeNoteColorPopover();
  });
  window.addEventListener("resize", () => {
    if (!noteColorPopover.classList.contains("hidden")) positionNoteColorPopover();
  });
  function openNoteColorPopover(){
    noteColorPopover.classList.remove("hidden");
    positionNoteColorPopover();
  }
  function closeNoteColorPopover(){ noteColorPopover.classList.add("hidden"); }
  function positionNoteColorPopover(){
    const margin = 8;
    const btnRect = noteColorTriggerBtn.getBoundingClientRect();
    const popRect = noteColorPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) top = btnRect.top - popRect.height - 6;
    noteColorPopover.style.left = `${left}px`;
    noteColorPopover.style.top = `${top}px`;
  }
  function setNoteColorTrigger(color){
    const trigger = $("#note-tool-color");
    const label = $("#note-color-trigger-label");
    const swatch = $("#note-color-trigger-swatch");
    if (trigger) { trigger.classList.remove("active"); trigger.title = "Text color"; trigger.setAttribute("aria-label", "Text color"); }
    if (label) label.textContent = "";
    if (swatch) { swatch.classList.remove("note-color-trigger-swatch-auto"); swatch.style.background = color; }
  }

  // ---- Symbol button — used to open a popover of choices, but now only
  // one symbol (➡️) remains, so clicking the button inserts it directly
  // instead of opening a list with a single option. ----
  const noteSymbolTriggerBtn = $("#note-tool-symbol");
  if (noteSymbolTriggerBtn) noteSymbolTriggerBtn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep focus (and the note's caret position) off this button
    e.stopPropagation();
    noteInsertSymbol("➡️");
  });
  // Close on a genuine backdrop click only — not a text selection that was
  // started inside the note card but dragged past its edge before mouseup.
  // In that case mousedown's target is inside the card while mouseup's
  // target is the backdrop, and the browser still fires "click" targeted
  // at their common ancestor (the backdrop itself), which used to close
  // the note out from under an in-progress selection. Requiring the
  // mousedown to ALSO have started on the backdrop rules that out.
  let noteBackdropMousedown = false;
  noteModal.addEventListener("mousedown", (e) => { noteBackdropMousedown = (e.target === noteModal); });
  noteModal.addEventListener("click", (e) => {
    if (!noteIsResizing && e.target === noteModal && noteBackdropMousedown) closeNoteModal();
  });
  noteTitleInput.addEventListener("input", () => {
    scheduleNoteIdleMaintenance();
    scheduleNoteAutosave();
  });
  noteTitleInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let Enter/Delete/arrows trigger the canvas shortcuts while typing a title
    if (e.key === "Escape") { e.preventDefault(); closeNoteModal(); return; }
    // Enter jumps down into the note body instead of doing nothing (it's
    // a single-line input, so there's no newline to insert here anyway).
    if (e.key === "Enter") { e.preventDefault(); noteTextarea.focus(); return; }
    if (e.altKey && e.key === "ArrowLeft" && noteActiveIndex > 0) { e.preventDefault(); goToNote(-1); }
    if (e.altKey && e.key === "ArrowRight" && noteActiveIndex < noteWorkingList.length - 1) { e.preventDefault(); goToNote(1); }
  });
  // Groups plain typing into undo-sized bursts: a snapshot is only taken
  // when there's been a pause since the last one, so undo doesn't have to
  // be pressed once per character. Toolbar-driven mutations push their
  // own snapshot explicitly (see notePushUndo call sites above) and don't
  // rely on this.
  const NOTE_TYPING_BURST_MS = 600;
  noteTextarea.addEventListener("beforeinput", () => {
    const now = Date.now();
    if (now - noteLastPushAt > NOTE_TYPING_BURST_MS || !noteUndoStack.length) {
      if (notePhonePerfMode()) {
        // Do not read noteTextarea.innerHTML here on phone. That forces a
        // serialization of the whole rich note at the exact moment the IME
        // is trying to insert a character. The working copy is the most
        // recently committed HTML and is good enough as the burst's undo
        // checkpoint; toolbar mutations still use the precise notePushUndo().
        const current = noteWorkingList[noteActiveIndex];
        pushBoundedSnapshot(noteUndoStack, current ? (current.html || "") : "", NOTE_UNDO_LIMIT);
      } else {
        pushBoundedSnapshot(noteUndoStack, noteTextarea.innerHTML, NOTE_UNDO_LIMIT);
      }
    }
    noteRedoStack = [];
    noteLastPushAt = now;
    updateNoteUndoButtons();
  });
  // While "type in caps" mode is armed (AA button pressed), transform each
  // character as it's typed rather than inserting it as-is. Guarded by
  // noteUppercaseInserting so the re-inserted (already-uppercase) text
  // doesn't loop back through this same handler.
  noteTextarea.addEventListener("beforeinput", (e) => {
    if (!noteUppercasePending || noteUppercaseInserting) return;
    if (e.inputType === "insertText" && e.data) {
      e.preventDefault();
      noteUppercaseInserting = true;
      document.execCommand("insertText", false, e.data.toUpperCase());
      noteUppercaseInserting = false;
    }
  });
  // Clicking to reposition the caret (rather than typing) drops caps
  // mode, mirroring how Word's Bold button un-presses once you click
  // somewhere that isn't bold — this "AA" is otherwise a plain toggle,
  // so it has no such position to check and just resets on click.
  noteTextarea.addEventListener("mousedown", () => {
    if (noteUppercasePending) {
      noteUppercasePending = false;
      updateNoteToolActiveStates();
    }
  });
  // v632: typing moves the collapsed caret too, but that must NOT be treated
  // as a user caret move. N/F/B/BB may change only after an intentional
  // pointer/navigation move (or a manual toolbar press), never merely because
  // a character was inserted.
  noteTextarea.addEventListener("pointerup", () => {
    requestAnimationFrame(syncNoteTextStyleFromCaret);
  });
  noteTextarea.addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown" ||
        k === "Home" || k === "End" || k === "PageUp" || k === "PageDown") {
      requestAnimationFrame(syncNoteTextStyleFromCaret);
    }
  });
  noteTextarea.addEventListener("input", (e) => {
    // Keep synchronous work tiny. Chrome's own Enter handling can clone a
    // card-heading attribute onto the new line, so only that one local fix
    // stays immediate; all full-note scans are deferred below.
    if (e && e.inputType === "insertParagraph") {
      const ln = noteCurrentLine();
      const prev = ln && ln.previousElementSibling;
      if (ln && ln.nodeType === 1 && ln.hasAttribute("data-card") && prev && prev.hasAttribute("data-card")
          && (prev.textContent || "").trim()) {
        ln.removeAttribute("data-card");
        ln.removeAttribute("data-card-color");
      }
    }
    scheduleNoteIdleMaintenance();
    scheduleNoteAutosave();
  });
  // DRC notes show a color ring at the right edge of each section card;
  // clicking it recolors that card. The color is stored on the heading
  // line itself (data-card-color, honored by decorateDRCCards), so it is
  // part of the note — and of the "DRC" note template when the note is
  // saved as one.
  bindDRCCardColorDot(
    noteTextarea,
    () => !noteModal.classList.contains("note-locked") && noteTextarea.classList.contains("drc-cards"),
    (head, color) => {
      notePushUndo();
      head.setAttribute("data-card-color", color);
      refreshDRCCards();
      scheduleNoteAutosave();
    }
  );
  noteTextarea.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let Tab/Enter/Delete trigger the canvas shortcuts while typing a note
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      insertNoteDotTab(noteTextarea, notePushUndo);
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey && !e.metaKey && !e.altKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (noteTextarea.contains(range.commonAncestorContainer)) {
          const backward = e.key === "Backspace";
          const tab = noteDotTabAtEditingEdge(noteTextarea, range, backward);
          if (tab) {
            e.preventDefault();
            deleteNoteDotTab(noteTextarea, tab, notePushUndo,
              backward ? "deleteContentBackward" : "deleteContentForward");
            return;
          }
        }
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) noteRedo(); else noteUndo();
      return;
    }
    // Ctrl/Cmd+B mirrors the toolbar Bold button — intercepted (rather
    // than left to the browser's own native Ctrl+B handling) so it goes
    // through noteApplyBold and picks up undo tracking and the toolbar's
    // pressed-state highlight the same way a click on the button would.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      noteApplyBold();
      return;
    }
    // Caps Lock mirrors the toolbar "AA" (force-uppercase) toggle — each
    // physical press fires its own keydown, so this just flips the same
    // toggle the button does rather than tracking the key as held down.
    if (e.key === "CapsLock") {
      noteApplyUppercase();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); closeNoteModal(); return; }
    // v519: Shift+Enter is native (soft line break), but Chrome may settle
    // the caret into a different inline formatting context only after the
    // keydown completes. Re-sync B/BB/T. from that final caret so the
    // toolbar can never disagree with what the next character will use.
    if (e.key === "Enter" && e.shiftKey) {
      requestAnimationFrame(updateNoteToolActiveStates);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (noteHandleEnter()) {
        e.preventDefault();
        // noteHandleEnter builds the new line itself (no `input` event
        // fires), so on a DRC note give that line its card immediately —
        // otherwise the caret sits outside the card until you type.
        refreshDRCCards();
      }
    }
    // Alt+Left/Right switch between a node's notes without leaving the
    // keyboard — plain arrow keys stay reserved for moving the caret.
    if (e.altKey && e.key === "ArrowLeft" && noteActiveIndex > 0) { e.preventDefault(); goToNote(-1); }
    if (e.altKey && e.key === "ArrowRight" && noteActiveIndex < noteWorkingList.length - 1) { e.preventDefault(); goToNote(1); }
  });

  noteNavAdd.addEventListener("mousedown", (e) => e.preventDefault());
  noteNavAdd.addEventListener("click", addAnotherNote);
  noteNavFavorite.addEventListener("mousedown", (e) => e.preventDefault());
  noteNavFavorite.addEventListener("click", toggleNoteFavorite);
  if (noteNavFolder) {
    noteNavFolder.addEventListener("mousedown", (e) => e.preventDefault());
    noteNavFolder.addEventListener("click", (e) => {
      e.stopPropagation();
      const current = noteWorkingList[noteActiveIndex];
      if (!current) return;
      openFolderMovePopover(noteNavFolder, notesFolderMgr, current.id, updateNoteFolderUI);
    });
  }
  // ---- Note templates popover ("📋" in the note editor's nav row) ----
  // Top row saves the open note as a template; below it, every saved
  // template — click one to pull it into the open note (fills an empty
  // note, otherwise adds it at the end), 🔁 to overwrite it with the open
  // note, × to delete. Same fixed-position popover pattern as the task
  // list's "📋 Templates" one (see renderTaskTemplatesPopover).
  const noteNavTemplates = $("#note-nav-templates");
  const noteTemplatesPopover = document.createElement("div");
  noteTemplatesPopover.className = "task-templates-popover note-templates-popover hidden";
  document.body.appendChild(noteTemplatesPopover);

  // Adds a template's content to the note that's open right now. An empty
  // note is simply filled in (title too, if it has none); a note that
  // already has text gets the template added after it, separated by a
  // blank line. Goes through the editor's own undo stack, so ↶ takes it
  // straight back out.
  function insertNoteTemplate(tpl) {
    if (!tpl || !noteWorkingList[noteActiveIndex]) return;
    const html = noteHtmlFromRaw(tpl.html || "");
    if (!html && !tpl.title) return;
    notePushUndo();
    const bodyEmpty = !noteTextarea.textContent.trim() && !noteTextarea.querySelector("img");
    if (!noteTitleInput.value.trim() && tpl.title) noteTitleInput.value = tpl.title;
    if (html) {
      if (bodyEmpty) noteTextarea.innerHTML = html;
      else noteTextarea.insertAdjacentHTML("beforeend", "<div><br></div>" + html);
    }
    noteSyncAllCheckedLines();
    noteSyncAllOrderedColors();
    noteAutoColorParagraphs();
    refreshDRCCards();
    scheduleNoteAutosave();
    noteTextarea.focus();
    const range = document.createRange();
    range.selectNodeContents(noteTextarea);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    noteTextarea.scrollTop = noteTextarea.scrollHeight;
  }

  function renderNoteTemplatesPopover() {
    noteTemplatesPopover.innerHTML = "";
    const current = noteWorkingList[noteActiveIndex];
    if (current) captureActiveNote(); // pick up whatever's typed so far
    const canSave = !!(current && snapshotNoteForTemplate(current));

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "task-template-save-btn";
    saveBtn.textContent = "💾 Save this note as a template…";
    saveBtn.disabled = !canSave;
    saveBtn.title = canSave
      ? "Save this note's title and text as a reusable template (photos aren't included)"
      : "This note is empty — write something first";
    saveBtn.addEventListener("click", () => {
      const cur = noteWorkingList[noteActiveIndex];
      if (!cur) return;
      captureActiveNote();
      const name = window.prompt("Name this note template:", (cur.title || "").trim());
      if (name === null) return; // cancelled
      const clean = name.trim();
      const existing = clean && getNoteTemplates().find(t => (t.name || "").trim().toLowerCase() === clean.toLowerCase());
      if (existing) {
        if (!confirm(`A template named "${existing.name}" already exists. Replace it with this note?`)) return;
        updateNoteTemplate(existing.id, cur);
        showToast(`Replaced template "${existing.name}"`);
      } else {
        saveNoteAsTemplate(cur, name);
        showToast("Saved note as a template");
      }
      renderNoteTemplatesPopover();
    });
    noteTemplatesPopover.appendChild(saveBtn);

    // "DRC" and "Plan" are special template names — say so, since it's the
    // only way to know a template of that name is picked up automatically.
    const addHint = () => {
      const hint = document.createElement("div");
      hint.className = "task-templates-empty task-templates-hint";
      hint.textContent = "Tip: “DRC” starts new DRC notes; “Plan” starts a task/subtask called plan; “Review Backtest” and “Take 1 trade” start matching subtasks automatically.";
      noteTemplatesPopover.appendChild(hint);
    };
    const templates = getNoteTemplates();
    if (!templates.length) {
      const empty = document.createElement("div");
      empty.className = "task-templates-empty";
      empty.textContent = "No saved note templates yet.";
      noteTemplatesPopover.appendChild(empty);
      addHint();
      return;
    }
    const divider = document.createElement("div");
    divider.className = "task-templates-divider";
    noteTemplatesPopover.appendChild(divider);
    templates.forEach((tpl) => {
      const row = document.createElement("div");
      row.className = "task-template-row";
      const label = document.createElement("span");
      label.className = "task-template-row-label";
      label.textContent = tpl.name || "Untitled template";
      label.title = "Add this template to the open note";
      label.addEventListener("click", () => {
        insertNoteTemplate(tpl);
        closeNoteTemplatesPopover();
      });
      const replace = document.createElement("button");
      replace.type = "button";
      replace.className = "task-template-row-replace";
      replace.textContent = "🔁";
      replace.disabled = !canSave;
      replace.title = canSave
        ? `Replace "${tpl.name}" with the open note`
        : "This note is empty — write something first";
      replace.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = noteWorkingList[noteActiveIndex];
        if (!cur || !canSave) return;
        if (!confirm(`Replace template "${tpl.name}" with the open note?`)) return;
        captureActiveNote();
        updateNoteTemplate(tpl.id, cur);
        renderNoteTemplatesPopover();
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
        deleteNoteTemplate(tpl.id);
        renderNoteTemplatesPopover();
      });
      row.appendChild(label);
      row.appendChild(replace);
      row.appendChild(del);
      noteTemplatesPopover.appendChild(row);
    });
    addHint();
  }
  function positionNoteTemplatesPopover(btn) {
    const margin = 8;
    const btnRect = btn.getBoundingClientRect();
    const popRect = noteTemplatesPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = Math.max(margin, btnRect.top - popRect.height - 6);
    }
    noteTemplatesPopover.style.left = `${left}px`;
    noteTemplatesPopover.style.top = `${top}px`;
  }
  function openNoteTemplatesPopover(btn) {
    renderNoteTemplatesPopover();
    noteTemplatesPopover.classList.remove("hidden");
    positionNoteTemplatesPopover(btn);
    // Pull whatever the other device saved, then redraw if it added any.
    syncTaskTemplatesWithDrive().then((changed) => {
      if (changed && !noteTemplatesPopover.classList.contains("hidden")) {
        renderNoteTemplatesPopover();
        positionNoteTemplatesPopover(btn);
      }
    });
  }
  function closeNoteTemplatesPopover() {
    noteTemplatesPopover.classList.add("hidden");
  }
  if (noteNavTemplates) {
    // Keep the editor's selection/caret where it is while clicking this.
    noteNavTemplates.addEventListener("mousedown", (e) => e.preventDefault());
    noteNavTemplates.addEventListener("click", (e) => {
      e.stopPropagation();
      if (noteTemplatesPopover.classList.contains("hidden")) openNoteTemplatesPopover(noteNavTemplates);
      else closeNoteTemplatesPopover();
    });
  }
  noteTemplatesPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!noteTemplatesPopover.classList.contains("hidden") &&
        !noteTemplatesPopover.contains(e.target) &&
        e.target !== noteNavTemplates) {
      closeNoteTemplatesPopover();
    }
  });

  if (noteNavInfo) {
    noteNavInfo.addEventListener("mousedown", (e) => e.preventDefault());
    noteNavInfo.addEventListener("click", (e) => {
      e.stopPropagation();
      showCurrentNoteInfo();
    });
  }
  noteNavDelete.addEventListener("mousedown", (e) => e.preventDefault());
  noteNavDelete.addEventListener("click", deleteActiveNote);

  // v457: top-row visibility is owned exclusively by the shared controller
  // in index.html. No legacy pointerup toggle is attached here.
  // v453: phone Note/DRC/Brainstorm top actions are now owned by the
  // shared 5-second reveal controller in index.html. Do not collapse them
  // again when the same reveal touch lands on the title/editor.
  [noteTitleInput, noteTextarea].forEach((el) => {
    if (!el) return;
  });

  $("#note-nav-close").addEventListener("click", closeNoteModal);
  noteNavBack.addEventListener("mousedown", (e) => e.preventDefault());
  noteNavBack.addEventListener("click", () => {
    const ret = noteReturn;
    closeNoteModal();
    runViewerReturn(ret);
  });

  bgInput.addEventListener("input", () => updateTheme({ background: bgInput.value }));
  $("#theme-bg-reset").addEventListener("click", () => { bgInput.value = defaultBg(); updateTheme({ background: null }); });

  connectorModeSel.addEventListener("change", () => {
    connectorColorInput.disabled = connectorModeSel.value !== "custom";
    updateTheme({ connectorMode: connectorModeSel.value });
  });
  connectorColorInput.addEventListener("input", () => updateTheme({ connectorColor: connectorColorInput.value }));

  fontModeSel.addEventListener("change", () => {
    updateTheme({ fontMode: fontModeSel.value });
  });
  fontColorInput.addEventListener("input", () => updateTheme({ fontColor: fontColorInput.value }));

