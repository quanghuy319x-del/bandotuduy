/* Branchline — js/01-edit-log.js
   v612: operation log used by cross-device conflict resolution.
   Loaded after core storage and before Google Drive sync. */
"use strict";

  const EDIT_LOG_LIMIT = 2000;
  const EDIT_DEVICE_KEY = "branchline_edit_device_v1";
  const editLogPendingBefore = new Map();
  const editLogShadow = new Map();

  function editClone(v) {
    try { return structuredClone(v); } catch (e) {
      try { return JSON.parse(JSON.stringify(v)); } catch (e2) { return v; }
    }
  }

  function editDeviceId() {
    try {
      let id = localStorage.getItem(EDIT_DEVICE_KEY);
      if (id) return id;
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID() :
        ("dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
      localStorage.setItem(EDIT_DEVICE_KEY, id);
      return id;
    } catch (e) {
      return "device";
    }
  }

  function editDeviceLabel() {
    const sw = Number(window.screen && window.screen.width) || window.innerWidth || 1024;
    const sh = Number(window.screen && window.screen.height) || window.innerHeight || 768;
    return Math.min(sw, sh) <= 640 ? "phone" : "pc";
  }

  function mapLastEditAt(map) {
    return Math.max(0, Number(map && map._lastEditAt) || 0);
  }

  function nextEditAt(map) {
    let remote = 0;
    try {
      const known = DriveDB && DriveDB.fileIndex && map && DriveDB.fileIndex[map.id];
      remote = Number(known && known.lastEditAt) || 0;
    } catch (e) {}
    return Math.max(Date.now(), mapLastEditAt(map) + 1, remote + 1);
  }

  function formatEditDate(iso) {
    if (!iso) return "";
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? (m[3] + "/" + m[2] + "/" + m[1]) : String(iso);
  }

  function formatEditClock(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function editSnapshotMeta(map) {
    return {
      title: map && map.title || "",
      editorPrefs: editClone(map && map.editorPrefs || {}),
      layout: map && map.layout || "",
      theme: editClone(map && map.theme || {}),
      clockHidden: !!(map && map.clockHidden),
      calendarSummaryStyle: map && map.calendarSummaryStyle || ""
    };
  }

  function editSnapshotString(map) {
    if (!map) return "";
    return JSON.stringify({
      root: map.root || null,
      links: map.links || [],
      title: map.title || "",
      editorPrefs: map.editorPrefs || {},
      layout: map.layout || "",
      theme: map.theme || {},
      clockHidden: !!map.clockHidden,
      calendarSummaryStyle: map.calendarSummaryStyle || ""
    });
  }

  function primeEditLogShadow(map) {
    if (!map || !map.id) return;
    try { editLogShadow.set(map.id, editSnapshotString(map)); } catch (e) {}
  }

  function captureEditLogBefore(undoJson, map) {
    if (!map || !map.id || editLogPendingBefore.has(map.id)) return;
    editLogPendingBefore.set(map.id, {
      undoJson: undoJson || null,
      meta: editSnapshotMeta(map)
    });
  }

  function pendingBeforeSnapshot(map) {
    const pending = map && editLogPendingBefore.get(map.id);
    if (pending) {
      try {
        const core = pending.undoJson ? JSON.parse(pending.undoJson) : {};
        return {
          root: core.root || null,
          links: core.links || [],
          title: pending.meta.title || "",
          editorPrefs: pending.meta.editorPrefs || {},
          layout: pending.meta.layout || "",
          theme: pending.meta.theme || {},
          clockHidden: !!pending.meta.clockHidden,
          calendarSummaryStyle: pending.meta.calendarSummaryStyle || ""
        };
      } catch (e) {}
    }
    const shadow = map && editLogShadow.get(map.id);
    if (shadow) {
      try { return JSON.parse(shadow); } catch (e) {}
    }
    return null;
  }

  function editValueEqual(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  function editTouch(base, key) {
    return base ? (base + ":" + key) : ("map:" + key);
  }

  function editObjectId(v) {
    return v && typeof v === "object" && !Array.isArray(v) && v.id != null ? String(v.id) : null;
  }

  function editArrayHasIds(arr) {
    return Array.isArray(arr) && arr.filter(v => v != null).every(v => editObjectId(v));
  }

  function collectEditChanges(before, after, touch, field, out) {
    if (editValueEqual(before, after)) return;
    const skip = field === "updatedAt" || field === "createdAt" || field === "view" ||
      field === "calendarRetained" || (field && field[0] === "_");
    if (skip) return;

    if (Array.isArray(before) || Array.isArray(after)) {
      const b = Array.isArray(before) ? before : [];
      const a = Array.isArray(after) ? after : [];
      if (editArrayHasIds(b) && editArrayHasIds(a)) {
        const bm = new Map(b.map(v => [String(v.id), v]));
        const am = new Map(a.map(v => [String(v.id), v]));
        const ids = [];
        const seen = new Set();
        b.concat(a).forEach(v => {
          const id = v && v.id != null ? String(v.id) : "";
          if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
        });
        ids.forEach(id => {
          const bv = bm.get(id), av = am.get(id);
          const base = "id:" + id;
          if (!bv || !av) {
            out.push({ touch: base + ":*", field: "*", before: bv, after: av, entityId: id });
          } else {
            collectEditChanges(bv, av, base, "", out);
          }
        });
        const bOrder = b.map(v => String(v.id)).join("|");
        const aOrder = a.map(v => String(v.id)).join("|");
        if (bOrder !== aOrder && b.length === a.length) {
          out.push({ touch: editTouch(touch, (field || "items") + ".order"), field: (field || "items") + ".order", before: bOrder, after: aOrder });
        }
        return;
      }
      out.push({ touch: editTouch(touch, field || "items"), field: field || "items", before: editClone(before), after: editClone(after) });
      return;
    }

    const bObj = before && typeof before === "object";
    const aObj = after && typeof after === "object";
    if (bObj || aObj) {
      if (!bObj || !aObj) {
        out.push({ touch: editTouch(touch, field || "value"), field: field || "value", before: editClone(before), after: editClone(after) });
        return;
      }
      const objectId = editObjectId(after) || editObjectId(before);
      const baseTouch = objectId ? ("id:" + objectId) : touch;
      const keys = new Set(Object.keys(before || {}).concat(Object.keys(after || {})));
      keys.forEach(k => {
        if (k === "id" || k === "children") return;
        collectEditChanges(before ? before[k] : undefined, after ? after[k] : undefined, baseTouch, k, out);
      });
      if ((before && before.children) || (after && after.children)) {
        collectEditChanges(before && before.children || [], after && after.children || [], baseTouch, "children", out);
      }
      return;
    }

    out.push({ touch: editTouch(touch, field || "value"), field: field || "value", before: before, after: after });
  }

  function buildEditEntityIndex(snapshot) {
    const idx = new Map();
    if (!snapshot || !snapshot.root) return idx;

    function add(id, info) {
      if (id != null) idx.set(String(id), info);
    }
    function walkNotes(notes, owner) {
      (notes || []).forEach(n => add(n.id, {
        type: "note",
        label: (n.title || "Untitled note").trim(),
        nodeLabel: owner.nodeLabel || "",
        taskLabel: owner.taskLabel || "",
        due: owner.due || "",
        calendarDate: owner.calendarDate || ""
      }));
    }
    function walkTasks(tasks, owner) {
      (tasks || []).forEach(t => {
        const info = {
          type: "task",
          label: (t.text || "Untitled task").trim(),
          nodeLabel: owner.nodeLabel || "",
          due: t.due || owner.calendarDate || "",
          calendarDate: owner.calendarDate || ""
        };
        add(t.id, info);
        walkNotes(t.notes, { ...owner, taskLabel: info.label, due: info.due });
        (t.subtasks || []).forEach(s => {
          add(s.id, {
            type: "subtask",
            label: (s.text || "Untitled subtask").trim(),
            nodeLabel: owner.nodeLabel || "",
            taskLabel: info.label,
            taskId: t.id,
            due: info.due,
            calendarDate: owner.calendarDate || ""
          });
          walkNotes(s.notes, { ...owner, taskLabel: info.label, due: info.due });
        });
      });
    }
    function calendarDateForCell(node, r, c) {
      const t = node && node.table;
      if (!t || !t.calendar || r < 2) return "";
      const year = Number(t.calendarYear), month = Number(t.calendarMonth);
      const start = Number.isFinite(Number(t.calendarStart))
        ? Number(t.calendarStart)
        : (new Date(year, month - 1, 1).getDay() + 6) % 7;
      const offset = (r - 2) * 7 + c - start;
      const d = new Date(year, month - 1, 1 + offset);
      if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return "";
      const p = n => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    }
    function walkNode(node) {
      if (!node) return;
      const nodeLabel = (node.text || "Untitled node").trim();
      add(node.id, { type: "node", label: nodeLabel, nodeLabel: nodeLabel });
      walkNotes(node.notes, { nodeLabel });
      walkTasks(node.tasks, { nodeLabel });
      const t = node.table;
      if (t && Array.isArray(t.attach)) {
        t.attach.forEach((row, r) => (row || []).forEach((host, c) => {
          if (!host) return;
          const calendarDate = calendarDateForCell(node, r, c);
          walkNotes(host.notes, { nodeLabel, calendarDate });
          walkTasks(host.tasks, { nodeLabel, calendarDate });
        }));
      }
      (node.children || []).forEach(walkNode);
    }
    walkNode(snapshot.root);
    return idx;
  }

  function describeEditChange(ch, beforeIdx, afterIdx) {
    const m = String(ch.touch || "").match(/^id:([^:]+):(.+)$/);
    const id = m ? m[1] : (ch.entityId || "");
    const field = m ? m[2] : ch.field;
    const info = afterIdx.get(String(id)) || beforeIdx.get(String(id)) || null;
    const label = info && info.label ? info.label : "item";
    const date = info && (info.due || info.calendarDate);
    const whereDate = date ? (" on date " + formatEditDate(date)) : "";

    if (info && field === "done") {
      const action = ch.after ? "mark done " : "mark undone ";
      if (info.type === "subtask") return action + 'subtask "' + label + '" in task "' + (info.taskLabel || "Untitled task") + '" in task list' + whereDate;
      if (info.type === "task") return action + 'task "' + label + '" in task list' + whereDate;
    }
    if (info && field === "failed") {
      const action = ch.after ? "mark failed " : "clear failed ";
      if (info.type === "subtask") return action + 'subtask "' + label + '" in task "' + (info.taskLabel || "Untitled task") + '" in task list' + whereDate;
      if (info.type === "task") return action + 'task "' + label + '" in task list' + whereDate;
    }
    if (info && field === "text") {
      const oldText = String(ch.before || "").trim();
      const newText = String(ch.after || "").trim();
      if (info.type === "subtask") return 'rename subtask "' + oldText + '" to "' + newText + '" in task "' + (info.taskLabel || "Untitled task") + '"';
      if (info.type === "task") return 'rename task "' + oldText + '" to "' + newText + '"';
      if (info.type === "node") return 'rename node "' + oldText + '" to "' + newText + '"';
    }
    if (info && field === "due") {
      return 'set task "' + label + '" date to ' + (ch.after ? formatEditDate(ch.after) : "none");
    }
    if (info && field === "html") {
      return 'edit note "' + label + '"' + (info.taskLabel ? (' in task "' + info.taskLabel + '"') : (info.nodeLabel ? (' in node "' + info.nodeLabel + '"') : ""));
    }
    if (info && field === "*") {
      const verb = ch.after == null ? "delete " : (ch.before == null ? "add " : "edit ");
      if (info.type === "subtask") return verb + 'subtask "' + label + '" in task "' + (info.taskLabel || "Untitled task") + '"' + whereDate;
      return verb + info.type + ' "' + label + '"' + whereDate;
    }
    if (ch.touch === "map:title") return 'rename map "' + String(ch.before || "") + '" to "' + String(ch.after || "") + '"';
    if (info) return 'edit ' + String(field || "content") + ' on ' + info.type + ' "' + label + '"' + whereDate;
    return "edit " + String(field || "map content");
  }

  function normalizeEditLog(map) {
    if (!map) return [];
    if (!Array.isArray(map._editLog)) map._editLog = [];
    return map._editLog;
  }

  function appendEditLogEntry(map, ts, description, touches) {
    const log = normalizeEditLog(map);
    const deviceId = editDeviceId();
    if (!map._editSeq || typeof map._editSeq !== "object") map._editSeq = {};
    map._editSeq[deviceId] = (Number(map._editSeq[deviceId]) || 0) + 1;
    const seq = map._editSeq[deviceId];
    const entry = {
      id: deviceId + ":" + seq + ":" + ts,
      ts: ts,
      deviceId: deviceId,
      device: editDeviceLabel(),
      seq: seq,
      description: description,
      line: formatEditClock(ts) + " " + description,
      touches: Array.from(new Set((touches || []).filter(Boolean)))
    };
    log.push(entry);
    if (log.length > EDIT_LOG_LIMIT) {
      const drop = log.length - EDIT_LOG_LIMIT;
      const removed = log.splice(0, drop);
      let maxDropped = Number(map._editLogDroppedBefore) || 0;
      removed.forEach(e => { maxDropped = Math.max(maxDropped, Number(e && e.ts) || 0); });
      map._editLogDroppedBefore = maxDropped;
    }
    map._lastEditAt = Math.max(mapLastEditAt(map), ts);
    return entry;
  }

  function recordPendingEditLog(map) {
    if (!map || !map.id) return false;
    const before = pendingBeforeSnapshot(map);
    const afterText = editSnapshotString(map);
    if (!before) {
      primeEditLogShadow(map);
      editLogPendingBefore.delete(map.id);
      return false;
    }
    let after;
    try { after = JSON.parse(afterText); } catch (e) { return false; }

    const changes = [];
    collectEditChanges(before, after, "map", "", changes);

    const parentMap = (snap) => {
      const out = new Map();
      (function walk(n, p) {
        if (!n) return;
        out.set(String(n.id), p == null ? null : String(p));
        (n.children || []).forEach(c => walk(c, n.id));
      })(snap && snap.root, null);
      return out;
    };
    const bp = parentMap(before), ap = parentMap(after);
    const ids = new Set([...bp.keys(), ...ap.keys()]);
    ids.forEach(id => {
      if (bp.has(id) && ap.has(id) && bp.get(id) !== ap.get(id)) {
        changes.push({ touch: "id:" + id + ":parent", field: "parent", before: bp.get(id), after: ap.get(id), entityId: id });
      }
    });

    editLogPendingBefore.delete(map.id);
    editLogShadow.set(map.id, afterText);
    if (!changes.length) return false;

    const beforeIdx = buildEditEntityIndex(before);
    const afterIdx = buildEditEntityIndex(after);
    const changedSubtaskParents = new Set();
    changes.forEach(ch => {
      const m = String(ch.touch || "").match(/^id:([^:]+):(done|failed|\*)$/);
      if (!m) return;
      const info = afterIdx.get(m[1]) || beforeIdx.get(m[1]);
      if (info && info.type === "subtask" && info.taskId) changedSubtaskParents.add(String(info.taskId));
    });

    const primary = [];
    const allTouches = changes.map(ch => ch.touch);
    changes.forEach(ch => {
      const m = String(ch.touch || "").match(/^id:([^:]+):(done|failed)$/);
      if (m && changedSubtaskParents.has(m[1])) return;
      primary.push(ch);
    });

    const ts = nextEditAt(map);
    if (!primary.length) {
      appendEditLogEntry(map, ts, "edit map content", allTouches);
      return true;
    }
    primary.slice(0, 20).forEach((ch, i) => {
      const desc = describeEditChange(ch, beforeIdx, afterIdx);
      appendEditLogEntry(map, ts + i, desc, [ch.touch].concat(i === 0 ? allTouches : []));
    });
    map._lastEditAt = Math.max(mapLastEditAt(map), ts + Math.max(0, primary.length - 1));
    return true;
  }

  function ensureRecoveredEditLog(map) {
    if (!map || !map.id) return;
    const log = normalizeEditLog(map);
    if (log.length || mapLastEditAt(map)) return;
    const ts = Math.max(1, Number(map.updatedAt) || Date.now());
    appendEditLogEntry(map, ts, "recover unsynced local edit from previous session", ["map:*"]);
  }

  function mergeMapEditLogs(localMap, remoteMap) {
    const byId = new Map();
    [localMap, remoteMap].forEach(map => {
      (map && Array.isArray(map._editLog) ? map._editLog : []).forEach(e => {
        if (!e || !e.id) return;
        const prior = byId.get(e.id);
        if (!prior || (Number(e.ts) || 0) >= (Number(prior.ts) || 0)) byId.set(e.id, editClone(e));
      });
    });
    const merged = Array.from(byId.values()).sort((a, b) =>
      (Number(a.ts) || 0) - (Number(b.ts) || 0) ||
      String(a.deviceId || "").localeCompare(String(b.deviceId || "")) ||
      (Number(a.seq) || 0) - (Number(b.seq) || 0)
    );
    if (merged.length > EDIT_LOG_LIMIT) merged.splice(0, merged.length - EDIT_LOG_LIMIT);
    return merged;
  }

  function editTouchMatches(entryTouch, wanted) {
    if (!entryTouch || !wanted) return false;
    if (entryTouch === wanted || entryTouch === "map:*") return true;
    const wm = wanted.match(/^(id:[^:]+):/);
    if (wm && entryTouch === wm[1] + ":*") return true;
    return false;
  }

  function latestEditTouchAt(map, touch) {
    const log = map && Array.isArray(map._editLog) ? map._editLog : [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (!e || !Array.isArray(e.touches)) continue;
      if (e.touches.some(t => editTouchMatches(t, touch))) return Number(e.ts) || 0;
    }
    return 0;
  }

  function chooseLaterEditValue(localMap, remoteMap, touch, localValue, remoteValue) {
    const lt = latestEditTouchAt(localMap, touch);
    const rt = latestEditTouchAt(remoteMap, touch);
    if (lt > rt) return { chosen: true, value: editClone(localValue), side: "local", ts: lt };
    if (rt > lt) return { chosen: true, value: editClone(remoteValue), side: "remote", ts: rt };
    const lm = mapLastEditAt(localMap), rm = mapLastEditAt(remoteMap);
    if (lt === 0 && rt === 0 && lm !== rm) {
      return lm > rm
        ? { chosen: true, value: editClone(localValue), side: "local", ts: lm }
        : { chosen: true, value: editClone(remoteValue), side: "remote", ts: rm };
    }
    return { chosen: false, value: null, side: null, ts: Math.max(lt, rt) };
  }
