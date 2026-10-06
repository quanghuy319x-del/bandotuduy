/* Branchline — js/05-data-model-2.js
   Part 5 of 19 of the former single-file app.js. Contents: data model (part 2).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---- Task-template sync across devices (via Google Drive) ----
     Templates are stored per browser, so a phone never saw the ones made
     on the PC. This mirrors them through the settings file above:
     union of both sides by template id, newest edit wins, and a
     deletion record beats an older copy. Never touches maps, and any
     failure here is logged and ignored. */
  const TASK_TEMPLATES_DELETED_KEY = "branchlineTaskListTemplatesDeleted_v1";
  function getDeletedTaskTemplates() {
    try {
      const o = JSON.parse(localStorage.getItem(TASK_TEMPLATES_DELETED_KEY));
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (e) {}
    return {};
  }
  function saveDeletedTaskTemplates(o) {
    try { localStorage.setItem(TASK_TEMPLATES_DELETED_KEY, JSON.stringify(o)); } catch (e) {}
  }
  // a = local (its order is kept), b = remote.
  function mergeTaskTemplateSets(a, b) {
    const deleted = {};
    for (const src of [a.deleted, b.deleted]) {
      for (const id in (src || {})) deleted[id] = Math.max(deleted[id] || 0, Number(src[id]) || 0);
    }
    const best = new Map();
    const order = [];
    for (const t of [...(a.items || []), ...(b.items || [])]) {
      if (!t || !t.id) continue;
      const cur = best.get(t.id);
      if (!cur) { best.set(t.id, t); order.push(t.id); }
      else if ((t.updatedAt || 0) > (cur.updatedAt || 0)) best.set(t.id, t);
    }
    const items = [];
    for (const id of order) {
      const t = best.get(id);
      if (deleted[id] && deleted[id] >= (t.updatedAt || 0)) continue;
      items.push(t);
    }
    return { items, deleted };
  }
  // Order-insensitive fingerprint, so two devices that list the same
  // templates in a different order don't keep re-uploading forever.
  function taskTemplateSetSig(s) {
    const items = (s.items || []).map(t => t.id + ":" + (t.updatedAt || 0)).sort().join(",");
    const del = Object.keys(s.deleted || {}).map(id => id + ":" + s.deleted[id]).sort().join(",");
    return items + "|" + del;
  }
  // Shared "QUEUE TASKS" task for the Tasks modal. Unlike the normal
  // node-owned tasks below it, this one is global: every Tasks list reads
  // the same queue items. It rides in the same small Drive settings file
  // as task/note templates, so phone/PC share one queue. The legacy
  // DRC-named storage keys are intentionally kept so anything added in
  // v206/v207 is preserved instead of being migrated or lost.
  const DRC_QUEUE_KEY = "branchlineDRCQueue_v1";
  const DRC_QUEUE_DELETED_KEY = "branchlineDRCQueueDeleted_v1";
  function getDRCQueueItems() {
    try {
      const list = JSON.parse(localStorage.getItem(DRC_QUEUE_KEY) || "[]");
      return Array.isArray(list) ? list.filter(x => x && x.id) : [];
    } catch (e) { return []; }
  }
  function saveDRCQueueItems(list) {
    try { localStorage.setItem(DRC_QUEUE_KEY, JSON.stringify(Array.isArray(list) ? list : [])); } catch (e) {}
  }
  function getDeletedDRCQueueItems() {
    try {
      const o = JSON.parse(localStorage.getItem(DRC_QUEUE_DELETED_KEY) || "{}");
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch (e) { return {}; }
  }
  function saveDeletedDRCQueueItems(o) {
    try { localStorage.setItem(DRC_QUEUE_DELETED_KEY, JSON.stringify(o || {})); } catch (e) {}
  }
  function drcQueueSet() {
    return { items: getDRCQueueItems(), deleted: getDeletedDRCQueueItems() };
  }
  function drcQueueDisplayItems() {
    // Unfinished/failed items stay first in their existing order.
    // Completed queue items stay at the end, newest completion/update first.
    return getDRCQueueItems().slice().sort((a, b) => {
      const doneDiff = Number(!!a.done) - Number(!!b.done);
      if (doneDiff) return doneDiff;
      if (a.done && b.done) return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      return 0;
    });
  }
  function saveDRCQueueMutation(items, deleted) {
    saveDRCQueueItems(items);
    if (deleted) saveDeletedDRCQueueItems(deleted);
    scheduleTaskTemplateSync();
    try { renderTasksModal(); } catch (e) {}
  }
  function addDRCQueueSubtask(text) {
    const clean = (text || "").trim();
    if (!clean || !requireSignIn()) return false;
    const items = getDRCQueueItems();
    items.push({ id: uid(), text: clean, done: false, failed: false, updatedAt: Date.now() });
    saveDRCQueueMutation(items);
    return true;
  }
  function updateDRCQueueSubtask(id, mutator) {
    if (!requireSignIn()) return false;
    const items = getDRCQueueItems();
    const item = items.find(x => x.id === id);
    if (!item) return false;
    mutator(item);
    item.updatedAt = Date.now();
    saveDRCQueueMutation(items);
    return true;
  }
  function deleteDRCQueueSubtask(id) {
    if (!requireSignIn()) return false;
    const items = getDRCQueueItems();
    const item = items.find(x => x.id === id);
    if (!item) return false;
    const deleted = getDeletedDRCQueueItems();
    deleted[id] = Math.max(Number(deleted[id]) || 0, Date.now());
    saveDRCQueueMutation(items.filter(x => x.id !== id), deleted);
    return true;
  }

  let taskTemplateSyncRunning = false;
  let taskTemplateSyncQueued = false;
  let taskTemplateSyncTimer = null;
  let taskTemplateLastSyncAt = 0;
  function scheduleTaskTemplateSync() {
    clearTimeout(taskTemplateSyncTimer);
    taskTemplateSyncTimer = setTimeout(() => { syncTaskTemplatesWithDrive(); }, 1000);
  }
  // Resolves true if this device's template list changed as a result.
  async function syncTaskTemplatesWithDrive() {
    if (!DriveDB.signedIn || DriveDB.needsReauth || !isOnline) return false;
    if (taskTemplateSyncRunning) { taskTemplateSyncQueued = true; return false; }
    taskTemplateSyncRunning = true;
    let changedLocal = false;
    try {
      const files = await DriveDB.listSettingsFiles();
      // Read every settings file; if any read fails, stop — writing a merge
      // built from incomplete data could drop someone's templates.
      const remoteDocs = [];
      for (const f of files) remoteDocs.push(await DriveDB.downloadFile(f.id));
      let remote = { items: [], deleted: {} };
      let remoteNotes = { items: [], deleted: {} };
      let remoteDRCQueue = { items: [], deleted: {} };
      for (const doc of remoteDocs) {
        const tt = (doc && doc.taskTemplates) || {};
        remote = mergeTaskTemplateSets(remote, {
          items: Array.isArray(tt.items) ? tt.items : [],
          deleted: (tt.deleted && typeof tt.deleted === "object") ? tt.deleted : {}
        });
        // Saved note templates ride in the same settings file, under
        // their own key, merged the exact same way (by id, newest wins,
        // deletion records beat older copies).
        const nt = (doc && doc.noteTemplates) || {};
        remoteNotes = mergeTaskTemplateSets(remoteNotes, {
          items: Array.isArray(nt.items) ? nt.items : [],
          deleted: (nt.deleted && typeof nt.deleted === "object") ? nt.deleted : {}
        });
        const dq = (doc && doc.drcQueue) || {};
        remoteDRCQueue = mergeTaskTemplateSets(remoteDRCQueue, {
          items: Array.isArray(dq.items) ? dq.items : [],
          deleted: (dq.deleted && typeof dq.deleted === "object") ? dq.deleted : {}
        });
      }
      const local = { items: getTaskListTemplates(), deleted: getDeletedTaskTemplates() };
      const merged = mergeTaskTemplateSets(local, remote);
      const mergedSig = taskTemplateSetSig(merged);
      if (mergedSig !== taskTemplateSetSig(local)) {
        saveTaskListTemplates(merged.items);
        saveDeletedTaskTemplates(merged.deleted);
        changedLocal = true;
      }
      const localNotes = { items: getNoteTemplates(), deleted: getDeletedNoteTemplates() };
      const mergedNotes = mergeTaskTemplateSets(localNotes, remoteNotes);
      const mergedNotesSig = taskTemplateSetSig(mergedNotes);
      if (mergedNotesSig !== taskTemplateSetSig(localNotes)) {
        saveNoteTemplates(mergedNotes.items);
        saveDeletedNoteTemplates(mergedNotes.deleted);
        changedLocal = true;
      }
      const localDRCQueue = drcQueueSet();
      const mergedDRCQueue = mergeTaskTemplateSets(localDRCQueue, remoteDRCQueue);
      const mergedDRCQueueSig = taskTemplateSetSig(mergedDRCQueue);
      if (mergedDRCQueueSig !== taskTemplateSetSig(localDRCQueue)) {
        saveDRCQueueItems(mergedDRCQueue.items);
        saveDeletedDRCQueueItems(mergedDRCQueue.deleted);
        changedLocal = true;
        try { renderTasksModal(); } catch (e) {}
      }
      const somethingToStore = merged.items.length || Object.keys(merged.deleted).length
        || mergedNotes.items.length || Object.keys(mergedNotes.deleted).length
        || mergedDRCQueue.items.length || Object.keys(mergedDRCQueue.deleted).length;
      if (somethingToStore && (!files.length || files.length > 1
          || mergedSig !== taskTemplateSetSig(remote)
          || mergedNotesSig !== taskTemplateSetSig(remoteNotes)
          || mergedDRCQueueSig !== taskTemplateSetSig(remoteDRCQueue))) {
        // Keep any other keys a newer app version may have put in the file.
        const payload = Object.assign({}, remoteDocs[0] || {}, {
          v: 1, savedAt: Date.now(),
          taskTemplates: { items: merged.items, deleted: merged.deleted },
          noteTemplates: { items: mergedNotes.items, deleted: mergedNotes.deleted },
          drcQueue: { items: mergedDRCQueue.items, deleted: mergedDRCQueue.deleted }
        });
        const primaryId = await DriveDB.writeSettingsFile(files.length ? files[0].id : null, payload);
        // Two files only ever appear from a simultaneous first save on two
        // devices; both were merged above, so the extras are now redundant.
        for (const extra of files.slice(1)) {
          try { await DriveDB.api(`https://www.googleapis.com/drive/v3/files/${extra.id}`, { method: "DELETE" }); } catch (e) {}
        }
        void primaryId;
      }
      taskTemplateLastSyncAt = Date.now();
    } catch (e) {
      console.error("Task template sync failed", e);
    } finally {
      taskTemplateSyncRunning = false;
      if (taskTemplateSyncQueued) { taskTemplateSyncQueued = false; scheduleTaskTemplateSync(); }
    }
    return changedLocal;
  }
  // Appends a fresh copy of every task in a saved template onto `host`'s
  // existing task list — every task/subtask id is regenerated so they're
  // fully independent from here on, same as any other newly added task.
  // Existing tasks on `host` are left untouched.
  function insertTaskListTemplate(tpl, host) {
    if (!tpl || !host || !Array.isArray(tpl.tasks) || !tpl.tasks.length) return;
    pushUndo();

    // Read through getNodeTasks first so any old star migration is completed
    // before deciding whether this list already owns its single allowed ★.
    const existingTasks = getNodeTasks(host).slice();
    let starAvailable = !existingTasks.some(t => getTaskStars(t) > 0);

    const newTasks = tpl.tasks.map(t => {
      // A template may contain one priority star. If the destination already
      // has a starred task, keep that existing task untouched and import the
      // template task unstarred. This preserves the one-star-per-list rule.
      const wantsStar = getTaskStars(t) > 0;
      const stars = wantsStar && starAvailable ? 1 : 0;
      if (stars) starAvailable = false;

      const task = {
        id: uid(), text: t.text, done: false, stars, starred: stars > 0, due: null,
        subtasks: (t.subtasks || []).map(s => {
          const sub = { id: uid(), text: s.text, done: false };
          if (s.brBefore > 0) sub.brBefore = Math.min(5, s.brBefore | 0);
          return sub;
        })
      };
      if (t.color) task.color = t.color;
      return task;
    });

    // getNodeTasks() above also marks a legacy list as starsReset=true.
    // Keeping its migrated array and appending here prevents a freshly inserted
    // template star from being mistaken for an old pre-reset star and cleared.
    host.tasks = existingTasks.concat(newTasks);
    host.starsReset = true;
    persist();
  }

  /* ---- Note templates ----
     Same idea as the task-list templates above, for a single note: the
     note editor's "📋" button saves the open note (its title + rich text)
     under a name, then any other note — on any node, cell, task or
     subtask, in any map — can pull it in. Stored per browser in
     localStorage and mirrored through the same Drive settings file (see
     syncTaskTemplatesWithDrive), so they follow the person across
     devices. A template is a reusable shape: inline photos are left out
     (they're per-map records that wouldn't exist elsewhere) and ticked
     checklist lines come back unticked. */
  const NOTE_TEMPLATES_KEY = "branchlineNoteTemplates_v1";
  const NOTE_TEMPLATES_DELETED_KEY = "branchlineNoteTemplatesDeleted_v1";
  function getNoteTemplates() {
    try {
      const saved = JSON.parse(localStorage.getItem(NOTE_TEMPLATES_KEY));
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return [];
  }
  function saveNoteTemplates(list) {
    try { localStorage.setItem(NOTE_TEMPLATES_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function getDeletedNoteTemplates() {
    try {
      const o = JSON.parse(localStorage.getItem(NOTE_TEMPLATES_DELETED_KEY));
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (e) {}
    return {};
  }
  function saveDeletedNoteTemplates(o) {
    try { localStorage.setItem(NOTE_TEMPLATES_DELETED_KEY, JSON.stringify(o)); } catch (e) {}
  }
  // The saved note template with this name (case-insensitive) — newest one
  // if several share it. "DRC" and "Plan" are special names: see
  // getDRCTemplateText and planTemplateSeedFor.
  function findNoteTemplateByName(name) {
    const want = (name || "").trim().toLowerCase();
    let best = null;
    getNoteTemplates().forEach((t) => {
      if ((t.name || "").trim().toLowerCase() !== want) return;
      if (!best || (t.updatedAt || 0) > (best.updatedAt || 0)) best = t;
    });
    return best;
  }
  // Starting content for the first note of a task/subtask named "plan":
  // the note template called "Plan", if one has been saved.
  function planTemplateSeedFor(owner) {
    if (!owner || !isPlanText(owner.text)) return null;
    const tpl = findNoteTemplateByName("plan");
    if (!tpl) return null;
    return { title: tpl.title || "", html: tpl.html || "" };
  }

  // Trading-workflow subtasks that should behave like the existing special
  // Brainstorm / DRC / Plan affordances: their note icon is visible before a
  // note exists, and the first note starts from a saved template with the
  // same name when one is available. These remain per-subtask notes (unlike
  // DRC/Brainstorm, which redirect to their shared host-level content).
  const SPECIAL_SUBTASK_NOTE_TEMPLATE_NAMES = [
    ["review backtest", "Review Backtest"],
    ["take 1 trade", "Take 1 trade"],
  ];
  function specialSubtaskNoteTemplateName(owner) {
    const text = ((owner && owner.text) || "").trim().toLowerCase();
    const match = SPECIAL_SUBTASK_NOTE_TEMPLATE_NAMES.find(([needle]) => text.includes(needle));
    return match ? match[1] : "";
  }
  function specialSubtaskTemplateSeedFor(owner) {
    const name = specialSubtaskNoteTemplateName(owner);
    if (!name) return null;
    const tpl = findNoteTemplateByName(name);
    if (!tpl) return null;
    return { title: tpl.title || "", html: tpl.html || "" };
  }
  // The reusable shape of `note` ({title, html}) — or null if there's
  // nothing worth saving (no title and no text once photos are dropped).
  function snapshotNoteForTemplate(note) {
    if (!note) return null;
    const tmp = document.createElement("div");
    tmp.innerHTML = noteHtmlFromRaw(note.html || "");
    tmp.querySelectorAll("img").forEach((img) => {
      const parent = img.parentElement;
      img.remove();
      // A line that only held a photo would be left as an empty <div>.
      if (parent && parent !== tmp && !parent.textContent.trim() && !parent.children.length) parent.remove();
    });
    // Ticked checklist lines (☑, struck through) go back to unticked.
    [tmp, ...Array.from(tmp.children)].forEach((el) => {
      const first = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      if (first && /^☑/.test(first.nodeValue)) first.nodeValue = first.nodeValue.replace(/^☑/, "☐");
      el.classList.remove("note-line-checked");
      if (el.getAttribute("class") === "") el.removeAttribute("class");
    });
    const title = (note.title || "").trim();
    if (!title && !tmp.textContent.trim()) return null;
    return { title, html: tmp.textContent.trim() ? tmp.innerHTML : "" };
  }
  // Saves `note` as a new named template. Returns it, or null if empty.
  function saveNoteAsTemplate(note, name) {
    const snap = snapshotNoteForTemplate(note);
    if (!snap) return null;
    const tpl = {
      id: uid(),
      name: (name || "").trim() || snap.title || "Untitled template",
      title: snap.title,
      html: snap.html,
      updatedAt: Date.now()
    };
    const list = getNoteTemplates();
    list.push(tpl);
    saveNoteTemplates(list);
    scheduleTaskTemplateSync();
    return tpl;
  }
  // Overwrites an existing template's content in place (same id + name).
  function updateNoteTemplate(id, note) {
    const snap = snapshotNoteForTemplate(note);
    if (!snap) return false;
    const list = getNoteTemplates();
    const tpl = list.find(t => t.id === id);
    if (!tpl) return false;
    tpl.title = snap.title;
    tpl.html = snap.html;
    tpl.updatedAt = Date.now();
    saveNoteTemplates(list);
    scheduleTaskTemplateSync();
    return true;
  }
  function deleteNoteTemplate(id) {
    saveNoteTemplates(getNoteTemplates().filter(tpl => tpl.id !== id));
    const gone = getDeletedNoteTemplates();
    gone[id] = Date.now();
    saveDeletedNoteTemplates(gone);
    scheduleTaskTemplateSync();
  }

  // The affirmation typing game lives on its own per node — reached from
  // the node's right-click menu ("🎮 Affirmation game"), not the tasks
  // modal. Shape: node.affirmation = {wins, quote, count, target}. `wins`
  // is how many full rounds have been completed (shown as a ✓ badge with
  // a count on the node); `quote`/`count`/`target` describe whichever
  // round is currently in progress (or null/0 if none is), so closing the
  // game mid-round and coming back later resumes instead of losing
  // progress.
  //
  // The pool of lines itself is editable from the app (see the "Edit
  // lines" manager modal) and persisted in IndexedDB under the same
  // key/value store used for folder handles, keyed AFFIRMATION_QUOTES_KEY.
  // DEFAULT_AFFIRMATION_QUOTES seeds that pool the first time the app
  // runs; affirmationQuotesList is the live, editable in-memory copy.
  function getNodeAffirmation(node) {
    return (node && node.affirmation) ? node.affirmation : null;
  }
  function nodeAffirmationWins(node) {
    const a = getNodeAffirmation(node);
    return a ? (a.wins || 0) : 0;
  }
  const DEFAULT_AFFIRMATION_QUOTES = [
    "Ta là cái biết hằng hữu bất sinh bất diệt",
    "Thêm cũng ko được bớt cũng chẳng xong",
    "Ta là cái biết thân tâm hoàn cảnh",
    "Chừng nào còn biết ơn, Chừng đó còn hạnh phúc",
    "Buồn như buồn, vui như vui, phiền não như phiền não",
    "Không cần Không muốn",
  ];
  const AFFIRMATION_QUOTES_KEY = "affirmation_quotes";
  let affirmationQuotesList = DEFAULT_AFFIRMATION_QUOTES.slice();
  const AFFIRMATION_TARGET = 20;
  // How many correct retypes a round needs, based on how many rounds
  // ("wins") have already been completed on that node: 1st=5, 2nd=10,
  // 3rd=15, and the 4th round onward is the full AFFIRMATION_TARGET (20)
  // — see affirmationTargetForRound below.
  const AFFIRMATION_TARGETS_BY_ROUND = [5, 10, 15];
  function affirmationTargetForRound(winsSoFar) {
    const n = winsSoFar || 0;
    return n < AFFIRMATION_TARGETS_BY_ROUND.length ? AFFIRMATION_TARGETS_BY_ROUND[n] : AFFIRMATION_TARGET;
  }
  // Commas don't count in the affirmation game: they're treated like a
  // space, so typing them or skipping them are both fine ("ơn, Chừng",
  // "ơn,Chừng" and "ơn Chừng" all match).
  function stripAffirmationCommas(s) {
    return (s || "").replace(/[,，、]/g, " ").replace(/\s+/g, " ");
  }
  // v459: Vietnamese tone/diacritic marks never count as typing errors.
  // NFD removes marks such as ̀/́/̉/̃/̣/̂/̆/̛;
  // Vietnamese đ/Đ is a separate letter, so fold it to d as well.
  function normalizeAffirmationText(s) {
    return stripAffirmationCommas(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .trim()
      .toLocaleLowerCase("vi");
  }

  // v460: relaxed whole-line comparison. After Vietnamese accents are
  // normalized away, a line passes when similarity is strictly above 80%.
  // Levenshtein distance allows ordinary substitutions, missing letters and
  // extra letters without making the exercise overly strict.
  function affirmationSimilarity(a, b) {
    a = normalizeAffirmationText(a);
    b = normalizeAffirmationText(b);
    const maxLen = Math.max(a.length, b.length);
    if (!maxLen) return 1;
    if (!a.length || !b.length) return 0;
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost
        );
      }
      [prev, curr] = [curr, prev];
    }
    return Math.max(0, 1 - prev[b.length] / maxLen);
  }

  // The "Brainstorm" note-typing score task — reached from the same
  // right-click menu as the Affirmation game and Timer, but simpler than
  // either: no target quote, no countdown, just a plain free-typed
  // scratchpad (host.brainstorm = {text}) that autosaves as you type.
  // Follows the same host-based {nodeId, r, c} pattern as the timer/game
  // above (see resolveHost) so it works identically on a whole node or a
  // single table cell. Every non-empty line written is worth 1 point
  // toward the node's task score (see nodeTaskProgress above).
  function getNodeBrainstorm(host) {
    return window.BranchlineEditors.brainstorm.get(host);
  }
  function getBrainstormText(host) {
    return window.BranchlineEditors.brainstorm.text(host);
  }
  function brainstormLineCount(host) {
    return window.BranchlineEditors.brainstorm.lineCount(host);
  }
  function brainstormPoints(host) {
    return window.BranchlineEditors.brainstorm.points(host);
  }

  // A "DRC" note (see getDRCTemplateText / the drc flag set on it above) is
  // considered "filled in" — and worth points below — once the person has
  // typed more than one line into it, or at least 10 letters total,
  // beyond the template's own fixed section labels. Splits the note's
  // per-line HTML (one <div> per line, matching noteHtmlFromRaw) back
  // into plain-text lines, drops any line that's just one of the fixed
  // labels, then checks what's left.
  function noteLinesFromHtml(html) {
    return window.BranchlineEditors.note.linesFromHtml(html);
  }
  // A note counts as a "DRC" note purely by its title — typed manually,
  // left over from an older note, or set by the 📋 DRC… shortcut/the
  // task-named-"DRC" auto-prefill — so this matches consistently
  // regardless of how the note came to be. Same comparison the task-name
  // check above uses (trim + uppercase).
  function isDRCNote(note) {
    return window.BranchlineEditors.drc.isNote(note);
  }
  // v359: Note is the single editor/data model. Brainstorm is a Note
  // variant; only its icon differs.
  function isBrainstormNote(note) {
    return !!(note && (note.kind === "brainstorm" || (note.title || "").trim().toLowerCase() === "brainstorm"));
  }
  function syncBrainstormMirrorFromNotes(node) {
    if (!node) return;
    const n = getNodeNotes(node).find(isBrainstormNote);
    if (!n) { node.brainstorm = null; return; }
    const html = n.html || "";
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    node.brainstorm = { text: tmp.innerText || tmp.textContent || "", html };
  }
  // "Plan" gets its own icon too (the green-checklist PLAN sheet — see
  // NODE_PLAN_ICON_IMG). It applies when the note's own title is "plan",
  // or — for a task's/subtask's note, where the owner's name doubles as
  // the note's title — when the task/subtask itself is named "plan".
  // Case-insensitive, trimmed, same comparison as DRC above. Unlike DRC
  // this is icon-only: no template, points, or single-note rule.
  function isPlanText(str) {
    return window.BranchlineEditors.note.isPlanText(str);
  }
  // A subtask whose text STARTS with "brainstorm" gets an always-visible
  // Brainstorm scratchpad icon, even before anything has been typed into it.
  // Accepts natural separators: "brainstorm foo", "brainstorm: foo",
  // "brainstorm - foo", etc., case-insensitively.
  function isBrainstormPrefixText(str) {
    return window.BranchlineEditors.brainstorm.isPrefix(str);
  }
  function hasBrainstormContent(host) {
    return window.BranchlineEditors.brainstorm.hasContent(host);
  }
  function subtaskHasBrainstormMarker(s) {
    return !!(s && (isBrainstormPrefixText(s.text) || hasBrainstormContent(s)));
  }
  function nodeTaskNoteMarkerCount(node) {
    let count = 0;
    getNodeTasks(node).forEach((t) => {
      if (taskHasNotes(t)) count++;
      getTaskSubtasks(t).forEach((sub) => {
        if (taskHasNotes(sub)) count++;
      });
    });
    return count;
  }
  function nodeSubtaskBrainstormMarkerCount(node) {
    let count = 0;
    getNodeTasks(node).forEach((t) => {
      getTaskSubtasks(t).forEach((sub) => {
        if (subtaskHasBrainstormMarker(sub)) count++;
      });
    });
    return count;
  }
  function isPlanNote(note) {
    return !!(note && isPlanText(note.title));
  }
  // owner = the task/subtask the note belongs to (omit for node/cell notes).
  function isPlanNoteFor(note, owner) {
    return isPlanNote(note) || !!(owner && isPlanText(owner.text));
  }

  // Calendar special markers should mean "there is something to review",
  // not merely "the editor/template was opened". For Plan / Review Backtest /
  // Take 1 trade, an untouched saved template counts as empty. Images/media
  // always count as content. DRC keeps its stricter existing filled check.
  function noteBodyContentSignature(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    const hasMedia = !!tmp.querySelector("img,video,audio,iframe,canvas,svg");
    const text = (tmp.textContent || "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return { text, hasMedia };
  }
  function drcNoteHasUserContent(note) {
    if (!note) return false;
    const body = noteBodyContentSignature(note.html || "");
    if (body.hasMedia) return true;
    const labels = drcTemplateLines().map(l => String(l).trim().toLowerCase()).filter(Boolean);
    return noteLinesFromHtml(note.html || "")
      .map(l => String(l).trim())
      .filter(Boolean)
      .some(line => !labels.includes(line.toLowerCase()));
  }
  function specialNoteHasMeaningfulContent(note, owner) {
    if (!note) return false;
    if (isDRCNote(note)) return drcNoteHasUserContent(note);

    const body = noteBodyContentSignature(note.html || "");
    if (body.hasMedia) return true;
    if (!body.text) return false;

    let templateName = specialSubtaskNoteTemplateName(owner);
    if (!templateName && isPlanNoteFor(note, owner)) templateName = "Plan";
    if (!templateName) return true;

    const tpl = findNoteTemplateByName(templateName);
    if (!tpl) return true;
    const seed = noteBodyContentSignature(tpl.html || "");
    return body.text !== seed.text || body.hasMedia !== seed.hasMedia;
  }
  function drcNoteIsFilled(note) {
    return window.BranchlineEditors.drc.isFilled(note, drcTemplateLines());
  }
  // Count of filled-in DRC notes on the node (there can be more than one —
  // each "📋 DRC…" click starts a fresh one, so this adds up like a daily
  // streak). No longer fed into nodeTaskProgress's score — kept only for
  // the "(N filled in)" count in the DRC context-menu row.
  function drcPoints(node) {
    return getNodeNotes(node).filter(n => isDRCNote(n) && drcNoteIsFilled(n)).length * 5;
  }

  // Shared cap for the node icon strip (see renderNode/computeNodeBox):
  // photos, notes, and links each collapse from "one icon per item" down
  // to a single representative icon + a "Nx" count badge once there are
  // more than this many, so a node with dozens of any one thing still
  // reads as one compact cell instead of a wall of tiny icons.
  const STRIP_OVERFLOW_CAP = 16;
  // How many cells a bucket of items (all the notes, or all the links)
  // contributes to the strip's layout — every item while under the cap,
  // or just the one stand-in cell once collapsed.
  function stripBucketCount(len) {
    return len > STRIP_OVERFLOW_CAP ? 1 : len;
  }

  // Bare host/paths ("example.com") still work as a link this way — without
  // a scheme, clicking would otherwise try to load it as a path relative to
  // this local file instead of a real web address.
  function normalizeUrl(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
    return "https://" + trimmed;
  }

  // Shortens a URL for display in menus — strips the scheme and clips
  // long paths so a single entry never blows out the context menu width.
  function shortenUrlForMenu(u) {
    const stripped = (u || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    return stripped.length > 34 ? stripped.slice(0, 33) + "…" : stripped;
  }

  // Recognizable icon per link destination, so a node's link markers and
  // the link picker/manage menus read at a glance instead of every link
  // showing the same generic 🔗 — checked as an ordered list of
  // host/path patterns rather than a lookup map since e.g. Docs and
  // Sheets share the same docs.google.com host and only differ by path.
  // Each icon is a small brand-colored SVG (not an emoji) so it reads as
  // "the real logo" rather than a generic glyph.
  const LINK_ICON_SVGS = {
    youtube: '<svg viewBox="0 0 24 24"><rect x="1" y="5" width="22" height="14" rx="4" fill="#FF0000"/><path d="M10 8.6l6.5 3.4-6.5 3.4z" fill="#fff"/></svg>',
    docs: '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v14a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2684FC"/><path d="M14 2l5 5h-5z" fill="#0F62D6"/><rect x="5.5" y="10.5" width="9" height="1.6" rx=".8" fill="#fff"/><rect x="5.5" y="13.7" width="9" height="1.6" rx=".8" fill="#fff"/><rect x="5.5" y="16.9" width="6" height="1.6" rx=".8" fill="#fff"/></svg>',
    sheets: '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v14a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#0F9D58"/><path d="M14 2l5 5h-5z" fill="#57BB8F"/><rect x="7.5" y="10" width="9" height="8.5" rx="1.1" fill="#fff"/><line x1="7.5" y1="12.9" x2="16.5" y2="12.9" stroke="#0F9D58" stroke-width="1"/><line x1="7.5" y1="15.7" x2="16.5" y2="15.7" stroke="#0F9D58" stroke-width="1"/><line x1="10.5" y1="10" x2="10.5" y2="18.5" stroke="#0F9D58" stroke-width="1"/><line x1="13.5" y1="10" x2="13.5" y2="18.5" stroke="#0F9D58" stroke-width="1"/></svg>',
    slides: '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v14a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#F4B400"/><path d="M14 2l5 5h-5z" fill="#FBDA8E"/><rect x="7" y="11" width="10" height="6" rx=".8" fill="#fff"/></svg>',
    forms: '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v14a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#673AB7"/><path d="M14 2l5 5h-5z" fill="#C6B3E6"/><rect x="7" y="11" width="6" height="1.3" fill="#fff"/><rect x="14.5" y="10.6" width="2" height="2" rx=".3" fill="#fff"/><rect x="7" y="14" width="6" height="1.3" fill="#fff"/><rect x="14.5" y="13.6" width="2" height="2" rx=".3" fill="#fff"/></svg>',
    photos: '<svg viewBox="0 0 24 24"><path d="M12 12 L12 0 A6 6 0 0 1 12 12 Z" fill="#E94235"/><path d="M12 12 L24 12 A6 6 0 0 1 12 12 Z" fill="#4A82F2"/><path d="M12 12 L12 24 A6 6 0 0 1 12 12 Z" fill="#31A354"/><path d="M12 12 L0 12 A6 6 0 0 1 12 12 Z" fill="#FBBB05"/></svg>',
    drive: '<svg viewBox="0 0 24 24"><path d="M8.5 3h7l7.3 12.6h-7z" fill="#FFC107"/><path d="M1.7 15.6l3.8-6.6 7.3 12.6H9.3z" fill="#4CAF50"/><path d="M15.3 21.6H8.8l3.7-6.6h7.3z" fill="#2196F3"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3c2.35 2.45 3.55 5.45 3.55 9S14.35 18.55 12 21"/><path d="M12 3C9.65 5.45 8.45 8.45 8.45 12S9.65 18.55 12 21"/></svg>',
  };
  const LINK_ICON_RULES = [
    { test: (h, p) => h === "docs.google.com" && p.startsWith("/spreadsheets"), key: "sheets" },
    { test: (h, p) => h === "docs.google.com" && p.startsWith("/presentation"), key: "slides" },
    { test: (h, p) => h === "docs.google.com" && p.startsWith("/forms"), key: "forms" },
    { test: (h) => h === "docs.google.com", key: "docs" },
    { test: (h) => h === "sheets.google.com", key: "sheets" },
    { test: (h) => h === "slides.google.com", key: "slides" },
    { test: (h) => h === "forms.google.com" || h === "forms.gle", key: "forms" },
    { test: (h) => h === "photos.google.com" || h === "photos.app.goo.gl", key: "photos" },
    { test: (h) => h === "youtube.com" || h === "www.youtube.com" || h === "youtu.be" || h === "m.youtube.com", key: "youtube" },
    { test: (h) => h === "drive.google.com", key: "drive" },
  ];
  function linkIconKey(u) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname;
      for (const rule of LINK_ICON_RULES) {
        if (rule.test(host, path)) return rule.key;
      }
    } catch (e) { /* not a parseable absolute URL — fall through */ }
    return "link";
  }
  // Builds a "[icon] title" (or "[icon] shortened-url" when no title has
  // been fetched/set) row label as a small DOM fragment — the icon comes
  // from our own trusted SVG map (safe as innerHTML) but the label text
  // goes through textContent so it can never be interpreted as markup.
  function linkRowFragment(u, node) {
    const frag = document.createDocumentFragment();
    const iconSpan = document.createElement("span");
    iconSpan.className = "ctx-item-link-icon";
    iconSpan.innerHTML = linkIconFor(u);
    frag.appendChild(iconSpan);
    const label = getLinkTitle(node, u) || shortenUrlForMenu(u);
    frag.appendChild(document.createTextNode(" " + label));
    return frag;
  }

  function linkIconFor(u) {
    return LINK_ICON_SVGS[linkIconKey(u)];
  }

  // A table cell's links use the exact same multi-link model as a node's
  // own links (see getNodeUrls/getLinkTitle above) — an array of URLs
  // plus a { [url]: title } map for display names — just scoped to one
  // cell's attach record instead of the whole node. Reads either the old
  // single plain `url` string (from before this existed) or the new
  // `urls` array, same fallback shape as getNodeUrls.
  function getCellUrls(a) {
    if (!a) return [];
    if (Array.isArray(a.urls) && a.urls.length) return a.urls;
    if (a.url) return [a.url];
    return [];
  }
  function cellHasUrls(a) {
    return getCellUrls(a).length > 0;
  }
  function getCellLinkTitle(a, url) {
    return (a && a.linkTitles && a.linkTitles[url]) || "";
  }
  function setCellLinkTitle(a, url, title) {
    if (!a || !url) return;
    if (!a.linkTitles) a.linkTitles = {};
    const clean = (title || "").trim();
    if (clean) a.linkTitles[url] = clean;
    else delete a.linkTitles[url];
  }
  // Same per-link comment as getLinkComment/setLinkComment above, just
  // scoped to a table cell's own attach record.
  function getCellLinkComment(a, url) {
    return (a && a.linkComments && a.linkComments[url]) || "";
  }
  function setCellLinkComment(a, url, comment) {
    if (!a || !url) return;
    if (!a.linkComments) a.linkComments = {};
    const clean = (comment || "").trim();
    if (clean) a.linkComments[url] = clean;
    else delete a.linkComments[url];
  }
  // Same per-link attached photo(s) as getLinkPhotos/addLinkPhoto/
  // removeLinkPhoto above, just scoped to a table cell's own attach record.
  function getCellLinkPhotos(a, url) {
    return (a && a.linkPhotos && a.linkPhotos[url]) || [];
  }
  function addCellLinkPhoto(a, url, dataUrl) {
    if (!a || !url) return null;
    const id = addPhotoRecord(dataUrl, { avoid: getCellLinkPhotos(a, url) });
    if (!a.linkPhotos) a.linkPhotos = {};
    if (!a.linkPhotos[url]) a.linkPhotos[url] = [];
    a.linkPhotos[url].push(id);
    return id;
  }
  function removeCellLinkPhoto(a, url, photoId) {
    if (!a || !a.linkPhotos || !a.linkPhotos[url]) return;
    a.linkPhotos[url] = a.linkPhotos[url].filter((id) => id !== photoId);
    if (!a.linkPhotos[url].length) delete a.linkPhotos[url];
    deletePhotoRecord(photoId);
  }
  // Same "[icon] title" row-label builder as linkRowFragment above, just
  // reading a cell's own linkTitles instead of a node's.
  function cellLinkRowFragment(u, a) {
    const frag = document.createDocumentFragment();
    const iconSpan = document.createElement("span");
    iconSpan.className = "ctx-item-link-icon";
    iconSpan.innerHTML = linkIconFor(u);
    frag.appendChild(iconSpan);
    const label = getCellLinkTitle(a, u) || shortenUrlForMenu(u);
    frag.appendChild(document.createTextNode(" " + label));
    return frag;
  }
  // Same best-effort auto-title fetch as fetchLinkTitle above, scoped to
  // one cell instead of a node — re-resolves the live cell by {nodeId,
  // r, c} since several seconds may have passed before this resolves.
  async function fetchCellLinkTitle(nodeId, r, c, url) {
    let title = null;
    const ytId = youtubeVideoId(url);
    try {
      if (ytId) {
        const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (res.ok) title = (await res.json()).title;
      } else {
        const res = await fetch(url, { mode: "cors" });
        if (res.ok) title = new DOMParser().parseFromString(await res.text(), "text/html").title;
      }
    } catch (e) {
      console.warn("Branchline: couldn't auto-fetch link title for", url, e);
    }
    title = (title || "").trim();
    const liveNode = findNode(nodeId);
    if (!liveNode || !liveNode.table) return;
    const a = getCellAttach(liveNode, r, c);
    if (!title || !getCellUrls(a).includes(url) || getCellLinkTitle(a, url)) return;
    setCellLinkTitle(a, url, title.slice(0, 80));
    renderAll();
    persist();
  }

  // Native prompt for adding a new URL to a node — appends it to the
  // node's `urls` array, then immediately asks for an optional display
  // name too. Asking up front is the *only* reliable way to get a
  // readable name — auto-fetching the real page title (see
  // fetchLinkTitle) fails for virtually all sites, YouTube included,
  // since browsers block the cross-origin fetch with a CORS error
  // before the response can even be read. Leaving this second prompt
  // blank still attempts the background fetch on the off chance a
  // particular link/proxy setup allows it, but don't count on it.
  function addNodeUrl(nodeId) {
    if (!requireSignIn()) return;
    const node = findNode(nodeId);
    if (!node) return;
    const input = window.prompt("URL to add to this node:", "https://");
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    if (!trimmed) return;
    const url = normalizeUrl(trimmed);
    const name = window.prompt("Name for this link (leave blank to use the URL):", "");
    pushUndo();
    const urls = getNodeUrls(node).slice();
    urls.push(url);
    node.urls = urls;
    node.url = null; // fully migrated onto the array field
    setLinkTimestamp(node, url, Date.now());
    if (name && name.trim()) setLinkTitle(node, url, name);
    renderAll();
    persist();
    if (!getLinkTitle(node, url)) fetchLinkTitle(node, url);
  }

  // Native prompt for editing (or, if cleared, removing) one existing URL
  // by its index in the node's `urls` array. Changing the URL text
  // itself invalidates whatever title (fetched or manual) was attached
  // to the old address, and re-triggers a fetch for the new one.
  function editNodeUrl(nodeId, index) {
    if (!requireSignIn()) return;
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node).slice();
    if (index < 0 || index >= urls.length) return;
    const oldUrl = urls[index];
    const input = window.prompt("Edit URL (clear to remove):", oldUrl);
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    pushUndo();
    if (trimmed) {
      const newUrl = normalizeUrl(trimmed);
      urls[index] = newUrl;
      if (newUrl !== oldUrl) {
        setLinkTitle(node, oldUrl, null);
        node.urls = urls;
        node.url = null;
        renderAll();
        persist();
        fetchLinkTitle(node, newUrl);
        return;
      }
    } else {
      setLinkTitle(node, oldUrl, null);
      urls.splice(index, 1);
    }
    node.urls = urls;
    node.url = null;
    renderAll();
    persist();
  }

  // Native prompt for giving a link its own custom name, independent of
  // whatever fetchLinkTitle did or didn't manage to find automatically.
  // This is the reliable path — most ordinary sites don't allow the
  // cross-origin title fetch to succeed at all (see fetchLinkTitle).
  function renameNodeUrl(nodeId, index) {
    if (!requireSignIn()) return;
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node);
    if (index < 0 || index >= urls.length) return;
    const url = urls[index];
    const input = window.prompt("Name for this link (leave blank to just show the URL):", getLinkTitle(node, url));
    if (input === null) return; // cancelled
    pushUndo();
    setLinkTitle(node, url, input);
    renderAll();
    persist();
  }

  // Removes one URL from a node by its index in the `urls` array — the
  // context menu's ✕ next to each attached link, for a one-click removal
  // that doesn't need the edit prompt's "clear the field" workaround.
  function removeNodeUrl(nodeId, index) {
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node).slice();
    if (index < 0 || index >= urls.length) return;
    pushUndo();
    setLinkTitle(node, urls[index], null);
    urls.splice(index, 1);
    node.urls = urls;
    node.url = null;
    renderAll();
    persist();
  }

  // Right-click on a single link marker — same shape as openNoteManageMenu:
  // just this one link's rename/remove, since each link now has its own
  // icon rather than one shared icon for the lot.
  // Lists every link on a node — the overflow icon's counterpart to
  // openNoteManageMenu below, reachable once a node has passed the
  // STRIP_OVERFLOW_CAP link count and collapsed to one icon + a count
  // badge (see renderNode), so every individual link is still reachable
  // for opening, renaming, or removing.
  function openLinksManageMenu(nodeId, x, y) {
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node);
    if (!urls.length) return;
    resetContextMenu();

    const header = document.createElement("div");
    header.className = "ctx-item ctx-item-header";
    header.style.cursor = "default";
    const headerLabel = document.createElement("span");
    headerLabel.className = "ctx-item-label";
    headerLabel.textContent = `Links (${urls.length})`;
    header.appendChild(headerLabel);
    const addBtn = document.createElement("span");
    addBtn.className = "ctx-item-add";
    addBtn.textContent = "+";
    addBtn.title = "Add a new link";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      addNodeUrl(nodeId);
    });
    header.appendChild(addBtn);
    ctxMenu.appendChild(header);

    urls.forEach((u, i) => {
      const it = document.createElement("div");
      it.className = "ctx-item";
      it.title = u;
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.appendChild(linkRowFragment(u, node));
      labelSpan.addEventListener("click", () => {
        closeContextMenu();
        openLinkSmart(u, {
          videoKey: `${nodeId}|${u}`,
          get: () => getLinkComment(findNode(nodeId) || node, u),
          set: (v) => setLinkComment(findNode(nodeId) || node, u, v),
          getFavorite: () => getLinkFavorite(findNode(nodeId) || node, u),
          setFavorite: (v) => setLinkFavorite(findNode(nodeId) || node, u, v),
          getPhotos: () => getLinkPhotos(findNode(nodeId) || node, u),
          addPhoto: (dataUrl) => addLinkPhoto(findNode(nodeId) || node, u, dataUrl),
          removePhoto: (id) => removeLinkPhoto(findNode(nodeId) || node, u, id),
        });
      });
      it.appendChild(labelSpan);
      const rename = document.createElement("span");
      rename.className = "ctx-item-remove ctx-item-rename";
      rename.textContent = "✎";
      rename.title = "Rename";
      rename.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); renameNodeUrl(nodeId, i); });
      it.appendChild(rename);
      const rm = document.createElement("span");
      rm.className = "ctx-item-remove";
      rm.textContent = "✕";
      rm.title = "Remove";
      rm.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); removeNodeUrl(nodeId, i); });
      it.appendChild(rm);
      ctxMenu.appendChild(it);
    });
    positionContextMenu(x, y);
  }

  function openUrlSingleManageMenu(nodeId, index, x, y) {
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node);
    const u = urls[index];
    if (!u) return;
    resetContextMenu();
    const it = document.createElement("div");
    it.className = "ctx-item";
    it.title = u;
    const labelSpan = document.createElement("span");
    labelSpan.className = "ctx-item-label";
    labelSpan.appendChild(linkRowFragment(u, node));
    it.appendChild(labelSpan);
    const popup = document.createElement("span");
    popup.className = "ctx-item-remove ctx-item-popup";
    popup.textContent = "🪟";
    popup.title = "Open in a new window (smaller than this one)";
    popup.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); openUrlAsPopup(u); });
    it.appendChild(popup);
    const rename = document.createElement("span");
    rename.className = "ctx-item-remove ctx-item-rename";
    rename.textContent = "✎";
    rename.title = "Rename";
    rename.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); renameNodeUrl(nodeId, index); });
    it.appendChild(rename);
    const comment = document.createElement("span");
    comment.className = "ctx-item-remove ctx-item-comment";
    comment.textContent = "💬";
    comment.title = "Comment";
    comment.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); commentOnNodeUrl(nodeId, index); });
    it.appendChild(comment);
    const rm = document.createElement("span");
    rm.className = "ctx-item-remove";
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); removeNodeUrl(nodeId, index); });
    it.appendChild(rm);
    it.addEventListener("click", () => { closeContextMenu(); editNodeUrl(nodeId, index); });
    ctxMenu.appendChild(it);
    positionContextMenu(x, y);
  }

  // Opens the same paragraph-friendly comment editor as the video
  // modal's inline comment box (see openLinkCommentModal) — the "💬"
  // button next to a link's rename/remove buttons in its right-click
  // menu. The comment only ever shows as a hover tooltip on the link's
  // own icon (see attachLinkCommentTooltip); it has no other effect on
  // the link.
  function commentOnNodeUrl(nodeId, index) {
    if (!requireSignIn()) return;
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node);
    const u = urls[index];
    if (!u) return;
    openLinkCommentModal(u, {
      get: () => getLinkComment(findNode(nodeId) || node, u),
      set: (v) => setLinkComment(findNode(nodeId) || node, u, v),
      getFavorite: () => getLinkFavorite(findNode(nodeId) || node, u),
      setFavorite: (v) => setLinkFavorite(findNode(nodeId) || node, u, v),
    });
  }

  function newMindMap(title) {
    const root = newNode(title || "Central idea");
    return {
      id: uid(),
      title: title || "Untitled map",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      favorite: false,
      trashedAt: null,  // timestamp when moved to trash, or null if not trashed — see deleteMap/restoreMap
      root,
      links: [],   // cross-links: [{ id, a: nodeId, b: nodeId }] — connections that
                   // aren't part of the parent/child tree (e.g. "this idea relates to that one")
      view: { scale: 1, tx: 0, ty: 0 },
      editorPrefs: {
        phone: { noteFontSize: 13, brainstormFontSize: 13 },
        desktop: { noteFontSize: 15, brainstormFontSize: 15 }
      },
      theme: defaultTheme(),
      layout: "mindmap"   // "mindmap" | "righty" | "timeline" (legacy "logic" is migrated to "righty" by ensureLayout)
    };
  }

  function ensureFavorite(map) {
    if (!map) return;
    if (typeof map.favorite !== "boolean") map.favorite = false;
  }

  function ensureTrash(map) {
    if (!map) return;
    if (typeof map.trashedAt !== "number") map.trashedAt = null;
  }

  // The sidebar's regular map list and "open next map" fallbacks should
  // never surface a trashed map — only the trash modal does. Kept as
  // helpers rather than filtering state.maps itself, since state.maps is
  // the full source of truth (trashed maps still need to persist, sync,
  // and show up in the trash modal).
  function activeMaps() {
    return state.maps.filter(m => !m.trashedAt);
  }
  function trashedMapsList() {
    return state.maps.filter(m => m.trashedAt);
  }

  // Favorited maps always float to the top; within each group (favorite /
  // not), most-recently-updated first — same ordering used everywhere the
  // map list is touched, so the sidebar stays consistent no matter which
  // code path last modified it.
  function sortMaps(list) {
    list.sort((a, b) => {
      const fa = a.favorite ? 1 : 0, fb = b.favorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0);
    });
    return list;
  }

  function ensureLinks(map) {
    if (!map) return;
    if (!Array.isArray(map.links)) map.links = [];
  }

  function ensureLayout(map) {
    if (!map) return;
    // "Logic chart" was removed as its own menu option since it was
    // identical to "Righty mindmap" (both just layoutMindmap(root, false)
    // — see layout() below) — migrate any map saved with the old value
    // so it keeps rendering exactly the same way under the new name.
    if (map.layout === "logic") map.layout = "righty";
    if (map.layout !== "timeline" && map.layout !== "righty") map.layout = "mindmap";
  }

  // Per-map clock/calendar visibility — see isClockHidden/setClockHidden.
  // Defaults to hidden (true) for maps that have never had the toggle
  // touched, so the root node's live clock and the toolbar's 📅 Calendar
  // button stay out of the way unless someone opts in for that specific map.
  function ensureClockHidden(map) {
    if (!map) return;
    if (typeof map.clockHidden !== "boolean") map.clockHidden = true;
  }

  // One-time data repair, run once per map (flagged via map._sidesRepaired
  // so it never runs again after that, even across reopens). An earlier
  // version of Timeline mode's per-branch left/right split wrote its
  // auto-balanced choice directly onto node.side — but .side is a field
  // Mindmap mode's own layout also reads for every node, not just root's
  // direct children, so any map that had been opened in Timeline before
  // that was fixed could pick up "phantom" side flips deep in the tree
  // that the person never actually dragged. Back in Mindmap mode those
  // phantom flips make a node fan the opposite way from its own branch,
  // sending its connector line all the way across the canvas instead of
  // following its siblings. This clears any such non-top-level side just
  // once — a real user-dragged deep override made after this fix is safe
  // and is never touched by this again.
  function ensureSidesRepaired(map) {
    if (!map || map._sidesRepaired || !map.root) return;
    (function strip(node, depth) {
      if (depth > 1 && node.side) node.side = null;
      (node.children || []).forEach(c => strip(c, depth + 1));
    })(map.root, 0);
    map._sidesRepaired = true;
  }

  // One-time data repair: the affirmation typing game used to live as a
  // special task (t.type === "affirmation") inside a node's regular task
  // list. It now lives on its own as node.affirmation = {wins, quote,
  // count, target}, reached from the right-click menu instead of the
  // tasks modal. Any old affirmation-type task found on a node folds its
  // progress into the new counter (a completed one adds a win; an
  // in-progress one is resumed) and is removed from node.tasks so the
  // task list is plain checkboxes again. Flagged via map._affirmationMigrated
  // so it only ever runs once per map.
  function ensureAffirmationMigrated(map) {
    if (!map || map._affirmationMigrated || !map.root) return;
    (function walk(node) {
      const tasks = (node && Array.isArray(node.tasks)) ? node.tasks : [];
      const oldAffirmations = tasks.filter(t => t && t.type === "affirmation");
      if (oldAffirmations.length) {
        if (!node.affirmation) node.affirmation = { wins: 0, quote: null, count: 0, target: AFFIRMATION_TARGET };
        oldAffirmations.forEach(t => {
          if (t.done) {
            node.affirmation.wins = (node.affirmation.wins || 0) + 1;
          } else if (!node.affirmation.quote) {
            // Resume whichever in-progress round was found first.
            node.affirmation.quote = t.quote || t.text || null;
            node.affirmation.count = t.count || 0;
            node.affirmation.target = t.target || AFFIRMATION_TARGET;
          }
        });
        node.tasks = tasks.filter(t => !t || t.type !== "affirmation");
      }
      (node.children || []).forEach(walk);
    })(map.root);
    map._affirmationMigrated = true;
  }

