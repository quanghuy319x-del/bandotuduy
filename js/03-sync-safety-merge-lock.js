/* Branchline — js/03-sync-safety-merge-lock.js
   Part 3 of 19 of the former single-file app.js. Contents: sync safety net, node-level three-way merge, sign-in-required edit lock.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- sync safety net ----------------
     Three helpers that keep "synced" honest and stop a refresh from
     discarding work that never reached Drive. */

  // For every map, the version stamp it had the last time this device
  // KNEW it matched Drive (right after a download, or right after an
  // upload that actually succeeded). A map whose own updatedAt is above
  // this has edits Drive has never seen ("dirty"). Kept in localStorage
  // so it survives a reload — which is exactly when it matters.
  const SYNC_BASE_KEY = "branchline_sync_base_v1";
  function readSyncBases() {
    try { return JSON.parse(localStorage.getItem(SYNC_BASE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function getSyncBase(id) {
    const v = readSyncBases()[id];
    return typeof v === "number" ? v : undefined;
  }
  function setSyncBase(id, value) {
    try {
      const all = readSyncBases();
      all[id] = value;
      localStorage.setItem(SYNC_BASE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // Version stamps come from each device's own clock, and the newest
  // stamp wins. A phone whose clock runs even a few seconds behind the PC
  // therefore stamped its NEWER edit with an OLDER number, so the next
  // download (or a refresh) quietly replaced it with the PC's copy. This
  // never stamps below what Drive already has, so a real edit always wins.
  function nextUpdatedAt(map) {
    const known = DriveDB.fileIndex && DriveDB.fileIndex[map.id];
    return Math.max(Date.now(), (map.updatedAt || 0) + 1, ((known && known.updatedAt) || 0) + 1);
  }

  // True while a local save or upload is still pending/running. Wrapped
  // because the variables live further down the file.
  function localSaveBusy() {
    try { return !!(unsavedEdits || persistTimer || persistInFlight); }
    catch (e) { return false; }
  }

  // Keeps a losing version instead of throwing it away. For v2 maps we keep
  // the same stable photo ids and point the recovery copy at the original
  // map's photo store/folder, so a 60 MB map does NOT become another 60 MB
  // just because conflict protection created a backup. Legacy inline-photo
  // maps still fall back to the old self-contained migration.
  async function saveConflictCopy(sourceMap, label, opts) {
    try {
      const options = opts || {};
      const copy = JSON.parse(JSON.stringify(sourceMap));
      const sourceId = options.sharedPhotoSourceMapId || null;
      const t = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      copy.id = uid();
      copy.title = `${copy.title || "Untitled map"} (${label} ${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())})`;
      copy.updatedAt = Date.now();
      copy.trashedAt = null;

      if (sourceId && sourceId !== copy.id) {
        copy._sharedPhotoSourceMapId = sourceId;
        copy._photoSharingV1 = true;
        copy._photosMigrated = true;
      } else {
        await ensurePhotosMigrated(copy);
      }

      await DB.put(copy);
      state.maps.push(copy);
      showToast(`Kept a copy of the version that would have been overwritten: "${copy.title}"`);
      return copy;
    } catch (e) {
      console.error("Couldn't keep a conflict copy", e);
      return null;
    }
  }


  // One-time cleanup for recovery maps created by older builds, which copied
  // every photo into a fresh map id. Match by exact byte fingerprint, remap
  // only proven-identical ids to the original map, then delete the duplicate
  // rows owned by the recovery. Unique recovery-only photos stay independent.
  function recoveryBaseTitle(title) {
    const m = String(title || "").match(/^(.*) \((?:other device|unsynced copy) \d{1,2}\/\d{1,2} \d{1,2}:\d{2}\)$/i);
    return m ? m[1] : null;
  }

  async function photoRecordFingerprint(rec) {
    if (!rec) return null;
    try {
      let blob = rec.blob || null;
      if (!blob && rec.data) blob = dataUrlToBlob(rec.data);
      if (!blob) return null;
      const buf = await blob.arrayBuffer();
      return fingerprintBytes(new Uint8Array(buf));
    } catch (e) {
      return null;
    }
  }

  async function migrateLegacyConflictPhotoCopies() {
    let convertedMaps = 0;
    let freedBytes = 0;
    const fpCache = new Map();

    const fpFor = async (rec) => {
      if (!rec || !rec.id) return null;
      if (fpCache.has(rec.id)) return fpCache.get(rec.id);
      const fp = await photoRecordFingerprint(rec);
      fpCache.set(rec.id, fp);
      return fp;
    };

    const copies = state.maps.filter((m) => !sharedPhotoSourceMapId(m) && recoveryBaseTitle(m.title));
    for (const copy of copies) {
      const baseTitle = recoveryBaseTitle(copy.title);
      const candidates = state.maps.filter((m) => m.id !== copy.id && (m.title || "") === baseTitle);
      if (!candidates.length) continue;

      let copyRows = [];
      try { copyRows = await PhotoDB.getAllForMap(copy.id); } catch (e) {}
      if (!copyRows.length) continue;

      const copyFp = new Map();
      for (const r of copyRows) {
        const fp = await fpFor(r);
        if (fp) copyFp.set(r.id, fp);
      }
      if (!copyFp.size) continue;

      let best = null;
      for (const candidate of candidates) {
        let sourceRows = [];
        try { sourceRows = await PhotoDB.getAllForMap(candidate.id); } catch (e) {}
        if (!sourceRows.length) continue;
        const byFp = new Map();
        for (const r of sourceRows) {
          const fp = await fpFor(r);
          if (fp && !byFp.has(fp)) byFp.set(fp, r.id);
        }
        let matches = 0;
        copyFp.forEach((fp) => { if (byFp.has(fp)) matches++; });
        if (matches && (!best || matches > best.matches)) best = { map: candidate, byFp, matches };
      }
      if (!best) continue;

      const oldIds = [];
      let changedRefs = 0;
      for (const r of copyRows) {
        const fp = copyFp.get(r.id);
        const sourceId = fp && best.byFp.get(fp);
        if (!sourceId || sourceId === r.id) continue;
        let changed = 0;
        (function walk(n) {
          if (!n) return;
          changed += replacePhotoIdInNode(n, r.id, sourceId);
          (n.children || []).forEach(walk);
        })(copy.root);
        if (changed) {
          changedRefs += changed;
          oldIds.push(r.id);
        }
      }
      if (!changedRefs) continue;

      copy._sharedPhotoSourceMapId = best.map.id;
      copy._photoSharingV1 = true;
      copy._photosMigrated = true;
      copy.updatedAt = nextUpdatedAt(copy);
      await DB.put(copy);

      // Tree first, bytes second: a crash can therefore never leave the
      // stored recovery pointing at ids whose duplicate rows were deleted.
      const still = collectReferencedPhotoIds(copy.root);
      const doomed = [];
      for (const id of oldIds) {
        if (still.has(id)) continue;
        const rec = await PhotoDB.get(id);
        if (rec && rec.mapId === copy.id) {
          if (rec.blob && typeof rec.blob.size === "number") freedBytes += rec.blob.size;
          else if (typeof rec.data === "string") {
            const commaIdx = rec.data.indexOf(",");
            freedBytes += Math.floor((rec.data.length - (commaIdx + 1)) * 0.75);
          }
          doomed.push(id);
        }
      }
      if (doomed.length) await PhotoDB.deleteMany(doomed);
      convertedMaps++;

      if (state.current && state.current.id === copy.id) {
        await loadPhotoCacheForMap(copy.id);
        try { renderAll(); } catch (e) {}
      }

      // Publish the lightweight manifest and let Drive cleanup remove only
      // this recovery map's now-unused duplicate photo files.
      if (DriveDB.signedIn && !DriveDB.needsReauth && !DriveDB.driveBroken()) {
        try { await DriveDB.save(copy); } catch (e) { console.warn("Couldn't publish shared recovery migration", e); }
      }
    }

    if (convertedMaps) {
      try {
        showToast(`Recovery photos shared across ${convertedMaps} map${convertedMaps === 1 ? "" : "s"}` +
          (freedBytes ? ` — freed ${formatStorageBytes(freedBytes)} locally.` : "."));
      } catch (e) {}
    }
    return { convertedMaps, freedBytes };
  }

  // Old builds made conflict/recovery copies self-contained, which meant
  // every photo was duplicated under a new map id. Migrate those copies
  // conservatively: only when the title identifies a conflict copy and at
  // least 80% of its stored photo bytes/count match one same-title source
  // map byte-for-byte. Matching photos are switched to the source's stable
  // ids, then the redundant recovery-owned Blob rows are deleted.
  function legacyRecoveryBaseTitle(map) {
    const title = String((map && map.title) || "");
    const m = /^(.*) \((?:other device|unsynced copy) \d{1,2}\/\d{1,2} \d{1,2}:\d{2}\)$/.exec(title);
    return m ? m[1] : null;
  }

  function photoRecordByteSize(rec) {
    if (!rec) return 0;
    if (rec.blob && typeof rec.blob.size === "number") return rec.blob.size;
    if (typeof rec.data === "string") {
      const comma = rec.data.indexOf(",");
      return Math.max(0, Math.floor((rec.data.length - (comma + 1)) * 0.75));
    }
    return 0;
  }

  async function photoRecordFingerprint(rec) {
    if (!rec) return null;
    try {
      if (rec.blob) {
        const buf = await rec.blob.arrayBuffer();
        return fingerprintBytes(new Uint8Array(buf));
      }
      if (typeof rec.data === "string" && rec.data.startsWith("data:")) {
        return fingerprintBytes(dataUrlToBytes(rec.data).bytes);
      }
    } catch (e) {}
    return null;
  }

  function replacePhotoIdEverywhere(map, fromId, toId) {
    if (!map || !map.root || !fromId || !toId || fromId === toId) return 0;
    let changed = 0;
    (function walk(node) {
      if (!node) return;
      changed += replacePhotoIdInNode(node, fromId, toId);
      (node.children || []).forEach(walk);
    })(map.root);
    return changed;
  }

  let legacyRecoveryPhotoMigrationRunning = null;
  async function migrateLegacyRecoveryPhotoSharing() {
    if (legacyRecoveryPhotoMigrationRunning) return legacyRecoveryPhotoMigrationRunning;
    legacyRecoveryPhotoMigrationRunning = (async () => {
      let migratedMaps = 0;
      let removedRows = 0;
      let freedBytes = 0;

      for (const recovery of state.maps.slice()) {
        if (!recovery || sharedPhotoSourceMapId(recovery)) continue;
        const baseTitle = legacyRecoveryBaseTitle(recovery);
        if (!baseTitle) continue;

        let recoveryRows = [];
        try { recoveryRows = await PhotoDB.getAllForMap(recovery.id); } catch (e) {}
        if (!recoveryRows.length) continue;

        const candidates = state.maps.filter((m) =>
          m && m.id !== recovery.id &&
          String(m.title || "") === baseTitle &&
          !legacyRecoveryBaseTitle(m)
        );
        if (!candidates.length) continue;

        // Prefer the candidate whose raw photo-size profile overlaps most;
        // this cheap pass avoids hashing unrelated same-title maps.
        let source = null;
        let sourceRows = null;
        let bestSizeScore = -1;
        const recoverySizes = new Map();
        recoveryRows.forEach((r) => {
          const size = photoRecordByteSize(r);
          recoverySizes.set(size, (recoverySizes.get(size) || 0) + 1);
        });
        for (const candidate of candidates) {
          let rows = [];
          try { rows = await PhotoDB.getAllForMap(candidate.id); } catch (e) {}
          if (!rows.length) continue;
          const counts = new Map();
          rows.forEach((r) => {
            const size = photoRecordByteSize(r);
            counts.set(size, (counts.get(size) || 0) + 1);
          });
          let score = 0;
          recoverySizes.forEach((count, size) => {
            score += Math.min(count, counts.get(size) || 0);
          });
          if (score > bestSizeScore) {
            bestSizeScore = score;
            source = candidate;
            sourceRows = rows;
          }
        }
        if (!source || !sourceRows || bestSizeScore <= 0) continue;

        const sourceByFp = new Map();
        for (let i = 0; i < sourceRows.length; i++) {
          const row = sourceRows[i];
          const fp = await photoRecordFingerprint(row);
          if (fp) {
            let ids = sourceByFp.get(fp);
            if (!ids) { ids = []; sourceByFp.set(fp, ids); }
            ids.push(row.id);
          }
          if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
        }

        const replacements = [];
        let matchedBytes = 0;
        const totalBytes = recoveryRows.reduce((sum, r) => sum + photoRecordByteSize(r), 0);
        for (let i = 0; i < recoveryRows.length; i++) {
          const row = recoveryRows[i];
          const fp = await photoRecordFingerprint(row);
          const ids = fp && sourceByFp.get(fp);
          if (ids && ids.length) {
            replacements.push({ oldId: row.id, sourceId: ids[0], bytes: photoRecordByteSize(row) });
            matchedBytes += photoRecordByteSize(row);
          }
          if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
        }

        const countRatio = replacements.length / Math.max(1, recoveryRows.length);
        const byteRatio = matchedBytes / Math.max(1, totalBytes);
        if (countRatio < 0.8 && byteRatio < 0.8) continue;

        let changedRefs = 0;
        replacements.forEach(({ oldId, sourceId }) => {
          changedRefs += replacePhotoIdEverywhere(recovery, oldId, sourceId);
        });
        if (!changedRefs) continue;

        recovery._sharedPhotoSourceMapId = source.id;
        recovery._photoSharingV1 = true;
        recovery._photosMigrated = true;
        recovery.updatedAt = nextUpdatedAt(recovery);

        // Save the new references first. Only after the tree is durable is it
        // safe to drop duplicate recovery-owned photo rows.
        await DB.put(recovery);
        const stillReferenced = collectReferencedPhotoIds(recovery.root);
        const doomed = replacements
          .filter(({ oldId }) => !stillReferenced.has(oldId))
          .map(({ oldId }) => oldId);
        if (doomed.length) {
          await PhotoDB.deleteMany(doomed);
          removedRows += doomed.length;
          const doomedSet = new Set(doomed);
          freedBytes += replacements
            .filter((x) => doomedSet.has(x.oldId))
            .reduce((sum, x) => sum + x.bytes, 0);
        }

        migratedMaps++;
        if (state.current && state.current.id === recovery.id) {
          await loadPhotoCacheForMap(recovery.id);
          try { renderAll(); } catch (e) {}
        }

        // Let the normal verified Drive save publish the lightweight
        // manifest and delete the recovery map's now-unused duplicate Drive
        // files. If Drive is busy/offline, updatedAt remains dirty and the
        // existing retry/pushLocalNewer path will finish it later.
        if (DriveDB.signedIn && !DriveDB.busy && !DriveDB.pushingLocal && isOnline) {
          try { await DriveDB.save(recovery); } catch (e) {
            console.warn("Recovery photo-sharing Drive migration will retry later", e);
          }
        }
      }

      if (migratedMaps) {
        try {
          showToast(
            `Shared recovery photos for ${migratedMaps} map${migratedMaps === 1 ? "" : "s"}` +
            (freedBytes ? ` — freed ~${formatStorageBytes(freedBytes)} locally.` : ".")
          );
        } catch (e) {}
      }
      return { migratedMaps, removedRows, freedBytes };
    })();

    try {
      return await legacyRecoveryPhotoMigrationRunning;
    } finally {
      legacyRecoveryPhotoMigrationRunning = null;
    }
  }

  /* ---------------- node-level three-way merge ----------------
     Before this, ANY overlap (this device changed a map AND Drive's
     copy also changed since they last agreed) fell straight back to
     keeping the loser as a separate "conflict copy" map — safe, but it
     meant two people editing two *different* nodes of the same map
     always split into two maps instead of combining into one.

     This attempts a conservative three-way merge first: base (the tree
     as it stood the last time this device and Drive were known to
     agree — see getSyncSnapshot), local (this device's tree now), and
     remote (Drive's tree now). It only ever combines changes it's
     CERTAIN don't collide:
       - a node edited on only one side since base → take that side's edit
       - a node added on only one side → keep it
       - a node deleted on only one side → keep it anyway (losing a node
         is worse than an occasional node that should have been deleted
         coming back — the person can delete it again)
       - a node edited (or reparented) DIFFERENTLY on both sides → bail
         out of the whole merge immediately

     "Bail out" means throw MERGE_CONFLICT, which the caller catches and
     falls back to the exact old behavior (keep the loser as a separate
     map). So this can only ever make conflict copies rarer — it never
     makes the safety net weaker. */
  const MERGE_CONFLICT = Symbol("merge-conflict");

  function ownFieldsOf(node) {
    const { children, ...rest } = node || {};
    return rest;
  }

  // node id -> its parent's id (or null for the root), for every node in
  // the tree. Used to detect "moved to a different parent" — the one
  // kind of change this pass refuses to guess about.
  function buildParentMap(root) {
    const map = new Map();
    (function walk(node, parentId) {
      if (!node) return;
      map.set(node.id, parentId);
      (node.children || []).forEach(c => walk(c, node.id));
    })(root, null);
    return map;
  }

  // node id -> node, for every node in the tree.
  function buildNodeMap(root) {
    const map = new Map();
    (function walk(node) {
      if (!node) return;
      map.set(node.id, node);
      (node.children || []).forEach(walk);
    })(root);
    return map;
  }

  // Merges one node's own fields (not children) three ways. Returns the
  // merged own-fields object, or throws MERGE_CONFLICT if both sides
  // changed it differently since base.
  function mergeOwnFields(baseNode, localNode, remoteNode) {
    const baseOwn = JSON.stringify(ownFieldsOf(baseNode));
    const localOwn = JSON.stringify(ownFieldsOf(localNode));
    const remoteOwn = JSON.stringify(ownFieldsOf(remoteNode));
    if (localOwn === remoteOwn) return ownFieldsOf(localNode);
    if (localOwn === baseOwn) return ownFieldsOf(remoteNode); // only remote changed it
    if (remoteOwn === baseOwn) return ownFieldsOf(localNode); // only local changed it
    throw MERGE_CONFLICT; // both changed it, differently
  }

  // Merges the tree rooted at each of base/local/remote. baseParent is
  // only used to detect reparenting; a node whose parent differs between
  // local and remote (and neither matches base) is a move-vs-move
  // collision and bails the whole merge.
  function mergeTree(baseRoot, localRoot, remoteRoot, baseParent) {
    const baseNodes = buildNodeMap(baseRoot);
    const localNodes = buildNodeMap(localRoot);
    const remoteNodes = buildNodeMap(remoteRoot);
    const localParent = buildParentMap(localRoot);
    const remoteParent = buildParentMap(remoteRoot);

    function mergeSubtree(id) {
      const baseNode = baseNodes.get(id);
      const localNode = localNodes.get(id);
      const remoteNode = remoteNodes.get(id);
      if (!localNode && !remoteNode) return null; // gone from both — drop it
      if (!baseNode) {
        // New since base — can only exist on one side (ids are random),
        // so just keep that side's whole subtree untouched.
        const src = localNode || remoteNode;
        return { ...ownFieldsOf(src), children: (src.children || []).map(c => mergeSubtree(c.id)).filter(Boolean) };
      }
      if (!localNode || !remoteNode) {
        // Deleted on exactly one side — keep it rather than lose it, and
        // still walk its children against whichever copy survived.
        const src = localNode || remoteNode;
        return { ...mergeOwnFields(baseNode, src, src), children: (src.children || []).map(c => mergeSubtree(c.id)).filter(Boolean) };
      }
      // Present on both sides — check it wasn't moved to two different
      // new parents (a moved-here-and-there-differently collision).
      const lp = localParent.get(id), rp = remoteParent.get(id), bp = baseParent.get(id);
      if (lp !== bp && rp !== bp && lp !== rp) throw MERGE_CONFLICT;
      const own = mergeOwnFields(baseNode, localNode, remoteNode);
      const baseChildIds = new Set((baseNode.children || []).map(c => c.id));
      const localChildIds = (localNode.children || []).map(c => c.id);
      const remoteChildIds = (remoteNode.children || []).map(c => c.id);
      const ordered = [];
      const seen = new Set();
      localChildIds.concat(remoteChildIds).forEach(cid => {
        if (!seen.has(cid)) { seen.add(cid); ordered.push(cid); }
      });
      const children = ordered.map(mergeSubtree).filter(Boolean);
      return { ...own, children };
    }

    return mergeSubtree(baseRoot.id === localRoot.id && baseRoot.id === remoteRoot.id ? baseRoot.id : localRoot.id);
  }

  // Merges links (cross-connections between nodes, {id, a, b}) by
  // simple union on id, then drops any link pointing at a node the
  // merged tree no longer has (never dangling).
  function mergeLinks(baseLinks, localLinks, remoteLinks, mergedNodeIds) {
    const byId = new Map();
    (baseLinks || []).forEach(l => byId.set(l.id, l));
    (localLinks || []).forEach(l => byId.set(l.id, l));
    (remoteLinks || []).forEach(l => byId.set(l.id, l));
    return Array.from(byId.values()).filter(l => mergedNodeIds.has(l.a) && mergedNodeIds.has(l.b));
  }

  // Merges a whole map's content three ways: root tree, links, and
  // title. Returns { root, links, title } on success, or throws
  // MERGE_CONFLICT (caller should fall back to the old conflict-copy
  // behavior) if any part collided.
  function mergeMapContent(base, local, remote) {
    if (!base || !base.root || !local || !local.root || !remote || !remote.root) throw MERGE_CONFLICT;
    const baseParent = buildParentMap(base.root);
    const mergedRoot = mergeTree(base.root, local.root, remote.root, baseParent);
    if (!mergedRoot) throw MERGE_CONFLICT;
    // Safety net: if the merge somehow produced the same node id twice
    // (a corner case in reparenting this pass doesn't fully reason
    // about), refuse the merge rather than hand back a broken tree.
    const seenIds = new Set();
    let duplicate = false;
    (function walk(n) {
      if (!n) return;
      if (seenIds.has(n.id)) duplicate = true;
      seenIds.add(n.id);
      (n.children || []).forEach(walk);
    })(mergedRoot);
    if (duplicate) throw MERGE_CONFLICT;
    const links = mergeLinks(base.links, local.links, remote.links, seenIds);
    let title;
    if (local.title === remote.title) title = local.title;
    else if (local.title === base.title) title = remote.title;
    else if (remote.title === base.title) title = local.title;
    else throw MERGE_CONFLICT;

    const basePrefs = readAllEditorFontPrefs(base);
    const localPrefs = readAllEditorFontPrefs(local);
    const remotePrefs = readAllEditorFontPrefs(remote);
    const mergePref = (device, key) => {
      if (localPrefs[device][key] === remotePrefs[device][key]) return localPrefs[device][key];
      if (localPrefs[device][key] === basePrefs[device][key]) return remotePrefs[device][key];
      if (remotePrefs[device][key] === basePrefs[device][key]) return localPrefs[device][key];
      throw MERGE_CONFLICT;
    };
    const editorPrefs = {
      phone: {
        noteFontSize: mergePref("phone", "noteFontSize"),
        brainstormFontSize: mergePref("phone", "brainstormFontSize")
      },
      desktop: {
        noteFontSize: mergePref("desktop", "noteFontSize"),
        brainstormFontSize: mergePref("desktop", "brainstormFontSize")
      }
    };
    return { root: mergedRoot, links, title, editorPrefs };
  }

  // The last content both this device and Drive are known to have
  // agreed on for a map — the "base" a three-way merge compares
  // against. Stored in IndexedDB (via the generic handle store), not
  // localStorage, since a mind map's tree can be too big for
  // localStorage's much smaller quota. Best-effort: if it's missing,
  // callers just skip the merge attempt and fall back to the old
  // conflict-copy behavior, so a failed read here never breaks sync.
  async function getSyncSnapshot(id) {
    try { return await DB.getHandle("syncSnapshot:" + id); } catch (e) { return null; }
  }
  async function setSyncSnapshot(id, mapLike) {
    try {
      await DB.setHandle("syncSnapshot:" + id, {
        root: mapLike.root,
        links: mapLike.links || [],
        title: mapLike.title || "",
        editorPrefs: readAllEditorFontPrefs(mapLike)
      });
    } catch (e) { console.error("Couldn't save sync snapshot", e); }
  }

  function driveSyncStatusText() {
    if (!DriveDB.lastSyncedAt) return "Google Drive verified";
    const label = relTime(DriveDB.lastSyncedAt);
    return "Drive verified " + (label === "now" ? "just now" : label + " ago");
  }

  // The sidebar's "Syncing…" text is easy to miss (small, tucked away,
  // not even visible if the sidebar is collapsed on mobile), and before
  // this the canvas gave zero indication that what it was showing might
  // still be the pre-sync local copy. This banner is loud on purpose —
  // anyone looking at the map itself, not just the sidebar, should know
  // not to treat it as final while a sync is still in flight.
  function updateStaleSyncBanner() {
    const banner = $("#stale-sync-banner");
    if (!banner) return;
    const stillSyncing = DriveDB.signedIn && !DriveDB.dataSynced && isOnline;
    // Drive has actually confirmed another device saved something newer
    // (see DriveDB.conflictDetected) — editing is paused until this
    // device catches up. Never true just because the routine poll
    // timer hasn't ticked yet.
    const checking = DriveDB.signedIn && DriveDB.dataSynced && isOnline
      && !driveLockReason() && DriveDB.conflictDetected;
    banner.classList.toggle("hidden", !(stillSyncing || checking));
    const text = $("#stale-sync-text");
    if (text) {
      const pct = Math.max(1, DriveDB.syncProgressPercent || 1);
      text.textContent = checking
        ? "\u23f3 Verifying the newest Google Drive version before editing \u2014 this prevents a stale phone/PC copy from overwriting newer work."
        : "\u23f3 Syncing Google Drive \u2014 " + pct + "%" + (DriveDB.syncPhase ? " \u00b7 " + DriveDB.syncPhase : "");
    }
  }

  // Why editing is locked *despite* being signed in, or null when it
  // isn't. Signed-out isn't listed here on purpose — that case already
  // has its own full-screen panel (see applySignedOutGate).
  function driveLockReason() {
    if (!DriveDB.signedIn) return null;
    if (!isOnline) return "offline";
    if (DriveDB.needsReauth) return "reauth";
    if (DriveDB.driveBroken()) return "broken";
    return null;
  }

  // The loud counterpart to the small sidebar status line. The sidebar
  // text is easy to miss — it's tiny, it's off to the side, and on
  // mobile the sidebar may not even be open — which is exactly how a
  // long editing session can happen on top of a dead Drive session. This
  // sits across the top of the map itself, in red, with the one button
  // that fixes it.
  function updateDriveLostBanner() {
    const banner = $("#drive-lost-banner");
    if (!banner) return;
    const reason = driveLockReason();
    banner.classList.toggle("hidden", !reason);
    if (!reason) return;
    const text = $("#drive-lost-text");
    const btn = $("#drive-lost-reconnect");
    if (text) {
      text.textContent = reason === "offline"
        ? "\u26a0\ufe0f No internet connection \u2014 editing is locked so nothing can be written to this device only and then lost."
        : reason === "reauth"
        ? "\u26a0\ufe0f Your Google session has expired \u2014 editing is locked until you reconnect. Nothing you've already typed is lost."
        : "\u26a0\ufe0f Changes aren't reaching Google Drive \u2014 editing is locked until the connection is back. Nothing you've already typed is lost.";
    }
    if (btn) {
      btn.classList.toggle("hidden", reason === "offline");
      btn.textContent = reason === "broken" ? "Retry Drive" : "Reconnect Google";
    }
  }

  function updateCloudSyncPill() {
    const pill = document.getElementById("cloud-sync-pill");
    if (!pill) return;
    let stateName = "warning";
    let label = "☁ Cloud: not connected";
    if (!DriveDB.signedIn) {
      stateName = "warning";
      label = "☁ Cloud: off";
    } else if (!isOnline) {
      stateName = "error";
      label = "☁ Cloud: offline";
    } else if (DriveDB.needsReauth) {
      stateName = "error";
      label = "☁ Cloud: reconnect";
    } else if (DriveDB.driveBroken()) {
      stateName = "error";
      label = "☁ Cloud: upload failed";
    } else if (!DriveDB.dataSynced || DriveDB.busy || DriveDB.pushingLocal || localSaveBusy()) {
      stateName = "syncing";
      const pct = Math.max(1, DriveDB.syncProgressPercent || 1);
      label = DriveDB.syncPhase ? ("☁ " + DriveDB.syncPhase + " · " + pct + "%") : ("☁ Cloud: syncing… " + pct + "%");
    } else {
      const m = state.current;
      const known = m && DriveDB.fileIndex[m.id];
      const dirty = !!(m && (!known || (m.updatedAt || 0) > (known.updatedAt || 0)));
      if (dirty || DriveDB.unsyncedMaps().length) {
        stateName = "syncing";
        label = "☁ Cloud: waiting…";
      } else {
        stateName = "verified";
        label = "✓ Cloud: verified";
      }
    }
    pill.dataset.state = stateName;
    pill.textContent = label;
    pill.title = stateName === "verified"
      ? "This map's latest revision was confirmed by Google Drive. Click for sync details."
      : "Click for Google Drive sync details.";
    try { updateSyncStatusModal(); } catch (e) {}
  }

  function updateDriveUI(overrideStatus) {
    const status = $("#drive-status");
    const btn = $("#btn-google-signin");
    const onlineDot = $("#online-indicator");
    updateStaleSyncBanner();
    updateDriveLostBanner();
    if (onlineDot) {
      onlineDot.classList.toggle("offline", !isOnline);
      onlineDot.title = isOnline ? "Online" : "Offline — editing locally";
    }
    if (!status || !btn) return;
    applySignedOutGate();
    // The button's own visibility/label always reflects the real
    // signedIn/needsReauth/dataSynced state, whether or not this call
    // is just passing an override status string (e.g. "Syncing…") —
    // otherwise a mid-sync call here would leave the button showing
    // "Sign in with Google" even though we're already signed in and
    // just waiting on the initial Drive sync to finish.
    const stillSyncing = DriveDB.signedIn && !DriveDB.dataSynced && isOnline;
    if (DriveDB.needsReauth || (DriveDB.driveBroken() && isOnline)) {
      btn.textContent = DriveDB.driveBroken() && !DriveDB.needsReauth ? "Retry Drive" : "Reconnect Google";
      btn.classList.remove("hidden");
    } else if (stillSyncing) {
      // Signed in, sync in flight: no action to take yet, so don't
      // show a "Sign in with Google" (or even "Sign out") button at all.
      btn.classList.add("hidden");
    } else if (DriveDB.signedIn) {
      btn.textContent = "Sign out";
      btn.classList.remove("hidden");
    } else {
      btn.textContent = "Sign in with Google";
      btn.classList.remove("hidden");
    }
    if (overrideStatus) {
      const pct = Math.max(1, DriveDB.syncProgressPercent || 1);
      status.textContent = DriveDB.syncPhase ? (DriveDB.syncPhase + " · " + pct + "%") : overrideStatus;
      updateCloudSyncPill();
      refreshEditLockUI();
      return;
    }
    if (!isOnline) {
      // Offline trumps everything else here — even a fully signed-in,
      // fully synced device can't edit right now, so say so plainly
      // rather than showing a stale "Synced …" line that implies
      // editing still works.
      status.textContent = "Offline — editing locally, sync pending";
    } else if (DriveDB.needsReauth) {
      status.textContent = "Google session expired \u2014 editing paused";
    } else if (DriveDB.driveBroken()) {
      status.textContent = "Changes NOT on Drive \u2014 retrying, editing paused";
    } else if (DriveDB.signedIn && DriveDB.dataSynced && DriveDB.conflictDetected) {
      status.textContent = "Checking for a newer version\u2026 editing paused";
    } else if (DriveDB.signedIn && DriveDB.dataSynced && (DriveDB.pushingLocal || localSaveBusy())) {
      status.textContent = "Uploading changes\u2026";
    } else if (DriveDB.signedIn && DriveDB.dataSynced && DriveDB.unsyncedMaps().length) {
      status.textContent = "\u26a0 Changes not on Drive yet \u2014 retrying\u2026";
    } else if (DriveDB.signedIn) {
      status.textContent = driveSyncStatusText();
    } else {
      status.textContent = "Not synced to Google Drive";
    }
    updateCloudSyncPill();
    refreshEditLockUI();
  }

  // Keep the edit lock (and its status text) in sync with the browser's
  // actual connectivity, not just whatever it was when the page loaded.
  window.addEventListener("online", () => {
    isOnline = true;
    // Back online: silently verify Drive. Only a real newer remote copy
    // interrupts editing; routine checks stay out of the way.
    verifyLatestOnForeground();
  });
  window.addEventListener("offline", () => {
    isOnline = false;
    updateDriveUI();
  });

  /* ---------------- sign-in-required edit lock ----------------
     The app is read-only until the person signs in with Google — every
     mutation funnels through here (directly, or via pushUndo()'s guard
     below) so there's one place that decides whether an edit is allowed
     and one place that prompts sign-in when it isn't. */

  // Tracks the browser's connectivity so editing can also be blocked
  // while offline — being signed in + synced only proves the *last*
  // sync succeeded, not that this device can still reach Drive right
  // now. Kept as its own flag (rather than re-checking navigator.onLine
  // inline everywhere) so the online/offline listeners below have one
  // place to update and the rest of the gate logic stays simple.
  let isOnline = navigator.onLine;

  // Returning to the app now uses a silent metadata check instead of
  // blocking every tap behind a visible "checking latest" state. A real
  // newer Drive revision still triggers the conflict lock below.
  let foregroundDriveCheckSeq = 0;

  // Signed in + first sync done + online + Drive actually reachable, and
  // no confirmed newer copy sitting on Drive from another device. The
  // last one only ever becomes true from an actual Drive check that
  // found (or failed to fetch) something newer — never merely because
  // the routine poll timer hasn't run yet.
  function isEditingAllowed() {
    // v490 local-first: cloud/network health must never make the local map
    // read-only. Signed-out users still use the existing sign-in/local-only
    // gate, but once signed in, edits are saved locally and Drive catches up
    // when connectivity/session/upload health recovers.
    if (!DriveDB.signedIn) return localOnlyMode();
    return true;
  }

  // Set only while flushing already-typed work to disk as the lock comes
  // down (see flushEditsBeforeLock) — the flush itself calls pushUndo()
  // via commitNotesToNode(), which would otherwise be refused by the very
  // lock we're applying, throwing away the text we're trying to rescue.
  let finalFlushInProgress = false;

  // Thrown by pushUndo() when editing is blocked, so the rest of whatever
  // handler called it stops right where it is instead of mutating state
  // that then has no undo entry. It's caught nowhere on purpose: letting
  // it surface as an uncaught error in the console is harmless (it never
  // escapes the single event handler that triggered it) and is exactly
  // the signal a developer would want if something did slip past a guard.
  class EditBlockedError extends Error {
    constructor() { super("Editing is blocked until you sign in with Google."); }
  }

  let signinRequiredModalEl = null, signinRequiredSigninBtn = null, signinRequiredCancelBtn = null;
  function ensureSigninRequiredModal() {
    if (signinRequiredModalEl) return;
    signinRequiredModalEl = $("#signin-required-modal");
    if (!signinRequiredModalEl) return;
    signinRequiredSigninBtn = $("#signin-required-signin");
    signinRequiredCancelBtn = $("#signin-required-cancel");
    signinRequiredSigninBtn.addEventListener("click", () => {
      closeSigninRequiredModal();
      DriveDB.signIn(false).catch(err => alert(err.message || "Google sign-in failed."));
    });
    signinRequiredCancelBtn.addEventListener("click", closeSigninRequiredModal);
    signinRequiredModalEl.addEventListener("click", (e) => {
      if (e.target === signinRequiredModalEl) closeSigninRequiredModal();
    });
  }
  function openSigninRequiredModal() {
    ensureSigninRequiredModal();
    if (!signinRequiredModalEl) return;
    const heading = signinRequiredModalEl.querySelector("h2");
    const body = signinRequiredModalEl.querySelector("p");
    const stillSyncing = DriveDB.signedIn && !DriveDB.dataSynced && isOnline;
    const offline = !isOnline;
    const disconnected = driveLockReason() === "reauth" || driveLockReason() === "broken";
    const checkingNewer = DriveDB.signedIn && DriveDB.dataSynced && !offline && !disconnected
      && DriveDB.conflictDetected;
    if (heading) heading.textContent = offline
      ? "You're offline"
      : disconnected
      ? "Disconnected from Google Drive"
      : checkingNewer
      ? "Checking for a newer version\u2026"
      : (stillSyncing ? "Syncing\u2026" : "Sign in to edit");
    if (body) body.textContent = offline
      ? "Editing is paused until you're back online, so a change made here can't drift out of sync with your other devices. Reconnect and try again."
      : disconnected
      ? "Editing is paused because changes can't reach Drive right now \u2014 anything typed from here on would live only in this browser and disappear on a refresh. Everything already typed has been saved. Reconnect to carry on."
      : checkingNewer
      ? "Another device may have saved a newer version. Editing is paused until this device has confirmed (or downloaded) the latest one, so it can't be overwritten by an old copy. This only takes a moment \u2014 try again in a second."
      : stillSyncing
      ? "Hang on \u2014 making sure this device has your latest saved changes before you start editing, so a newer version from another device can't get overwritten. This only takes a moment."
      : "This map is read-only until you sign in with Google. Editing, undo/redo, and adding tasks, notes, or photos all need a signed-in session.";
    if (signinRequiredSigninBtn) {
      signinRequiredSigninBtn.textContent = DriveDB.driveBroken()
        ? "Retry Drive"
        : (disconnected ? "Reconnect Google" : "Sign in with Google");
      signinRequiredSigninBtn.classList.toggle("hidden", stillSyncing || offline || checkingNewer);
    }
    zoomModalOpen(signinRequiredModalEl);
  }
  function closeSigninRequiredModal() {
    zoomModalClose(signinRequiredModalEl);
  }

  // The single gate every edit attempt passes through: pops the sign-in
  // modal immediately and reports "blocked" if not signed in, otherwise
  // is a silent no-op and reports "allowed".
  function requireSignIn() {
    if (finalFlushInProgress) return true;
    if (isEditingAllowed()) return true;
    openSigninRequiredModal();
    return false;
  }

  // Keeps the always-visible chrome (undo/redo, the "+" FAB) looking
  // disabled while logged out, so the lock is visible before someone
  // even tries to edit — the modal above is still what actually enforces
  // it for anything not covered by a visible button (keyboard shortcuts,
  // drag, paste, context-menu actions, etc).
  // Everything already typed but not yet committed, pushed through to
  // IndexedDB the instant before the lock comes down. Without this, the
  // half-second of typing still sitting in the note editor's own
  // debounce (and any map edit still inside persist()'s 500ms window)
  // would be refused by the lock on its way out and silently dropped —
  // the person would watch the app lock itself and take their last
  // sentence with it.
  let editLockWasLocked = false;
  function flushEditsBeforeLock() {
    finalFlushInProgress = true;
    try {
      try { if (noteEditingId) flushNoteAutosave(); } catch (e) {}
      try { flushPersist(); } catch (e) {}
    } catch (e) {
      // Can fire harmlessly during boot, before the note editor's and
      // persist layer's own state exists yet — nothing to flush then.
    } finally {
      finalFlushInProgress = false;
    }
  }

  // Makes the open note editor genuinely read-only, rather than letting
  // someone keep typing into a box whose contents the lock would refuse
  // to commit. The toolbar and per-note actions are disabled via CSS
  // (see .note-locked in style.css) rather than each button's `disabled`
  // property, so unlocking doesn't have to re-derive which of them were
  // legitimately disabled on their own (undo/redo in particular).
  function applyNoteEditorLock(locked) {
    const modal = document.getElementById("note-modal");
    if (!modal) return;
    const body = document.getElementById("note-textarea");
    const title = document.getElementById("note-title-input");
    if (body) body.contentEditable = locked ? "false" : "true";
    if (title) title.readOnly = locked || !!noteEditingSubtaskId;
    modal.classList.toggle("note-locked", locked);
    const lockNote = document.getElementById("note-lock-banner");
    if (lockNote) lockNote.classList.toggle("hidden", !locked);
    if (locked && body && document.activeElement === body) body.blur();
  }

  function refreshEditLockUI() {
    const locked = !isEditingAllowed();
    if (locked && !editLockWasLocked) flushEditsBeforeLock();
    editLockWasLocked = locked;
    applyNoteEditorLock(locked);
    if (!locked) closeSigninRequiredModal();
    document.body.classList.toggle("edit-locked", locked);
    const fabAddChild = $("#fab-add-child");
    const fabAddSibling = $("#fab-add-sibling");
    if (fabAddChild) fabAddChild.classList.toggle("locked", locked);
    if (fabAddSibling) fabAddSibling.classList.toggle("locked", locked);
    const titleInputEl = $("#title-input");
    if (titleInputEl) titleInputEl.readOnly = locked;
    updateUndoRedoButtons();
  }

  // Signing in only syncs once, at that moment — without this, a change
  // made on another device wouldn't show up here until you next reload
  // (or manually sign in again). Polls every DRIVE_POLL_INTERVAL_MS (10s)
  // while the tab is actually visible (skipped in background tabs to save
  // battery/quota), plus once immediately whenever you switch back to
  // this tab.
  let driveSyncTimer = null;
  // Set when a poll pulled in remote changes that the screen doesn't show
  // yet; cleared once the map/sidebar have actually been redrawn. Needed
  // because a poll can find changes while an edit is in progress (redraw
  // must wait) and the *next* poll will see nothing new to report.
  let driveRenderPending = false;
  function startDriveSyncPolling() {
    stopDriveSyncPolling();
    driveSyncTimer = setInterval(pollDriveUpdates, DRIVE_POLL_INTERVAL_MS);
  }
  function stopDriveSyncPolling() {
    if (driveSyncTimer) { clearInterval(driveSyncTimer); driveSyncTimer = null; }
  }
  async function pollDriveUpdates(force) {
    if (!DriveDB.signedIn || DriveDB.busy) return;
    if (document.visibilityState !== "visible") return;
    // Don't touch the map tree while you're actively mid-keystroke in a
    // node's text — an incoming update would swap out the very node
    // object your editor box is still pointing at. Same idea for
    // unsavedEdits: a change you just finished (blurred a node, dragged
    // something) can still be sitting in persist()'s debounce/awaits for
    // up to ~500ms+ after editingId clears, and pulling in a remote
    // version during that window would silently overwrite it.
    if (state.editingId || unsavedEdits) {
      // The full sync has to wait, but the freshness check must not:
      // otherwise a long edit would age out the "latest version" stamp
      // (locking mid-typing), and a newer copy saved by another device
      // in the meantime would go unnoticed.
      DriveDB.busy = true;
      try {
        await DriveDB.verifyRemote();
      } catch (e) {
        console.error("Drive freshness check failed", e);
        DriveDB.consecutivePollFailures++;
        if (DriveDB.consecutivePollFailures >= DriveDB.MAX_POLL_FAILURES && DriveDB.status !== "reauth") DriveDB.status = "broken";
      }
      DriveDB.busy = false;
      updateDriveUI();
      return;
    }
    DriveDB.busy = true;
    try {
      if (await DriveDB.syncFromDrive()) driveRenderPending = true;
      // Then the other direction: re-upload any map whose local copy is
      // newer than Drive's (an earlier upload that never finished — see
      // pushLocalNewer). `force` is true when this poll was triggered by
      // returning to the tab or coming back online, false for the interval timer.
      await DriveDB.pushLocalNewer({ force: force === true });
      // Re-check both conditions: either can flip from clear to set while
      // the syncFromDrive() network call above was in flight (the guards
      // above only ran before it started). If either did, don't blow away
      // whatever the user just started editing or hasn't finished saving —
      // a renderAll() here would tear down and refocus an active edit box
      // from outside the user's tap gesture (which is why the on-screen
      // keyboard would flash and immediately close on mobile), or clobber
      // a change that's still mid-save.
      // Only redraw when this poll (or an earlier one that had to wait)
      // actually brought in changes. This used to rebuild the sidebar AND
      // every node of the canvas from scratch on every poll tick even
      // when nothing had changed — which made the whole map stutter, and
      // dropped any click whose press and release straddled a rebuild
      // (the element pressed no longer exists, so no click event fires).
      if (driveRenderPending && !state.editingId && !unsavedEdits) {
        driveRenderPending = false;
        renderSidebar();
        renderAll();
      }
      DriveDB.consecutivePollFailures = 0;
    } catch (e) {
      console.error("Drive poll failed", e);
      // One failed poll is a network blip and not worth interrupting
      // anyone over; several in a row means this tab has genuinely lost
      // Drive, which the person needs to know before they type another
      // paragraph into it.
      DriveDB.consecutivePollFailures++;
      if (DriveDB.consecutivePollFailures >= DriveDB.MAX_POLL_FAILURES && DriveDB.status !== "reauth") {
        DriveDB.status = "broken";
        updateDriveUI();
      }
    }
    DriveDB.busy = false;
    DriveDB.setSyncProgress("", 0, 0);
    // The shared DRC queue lives in the small settings file rather than a
    // map file. Refresh that file occasionally while this tab stays open,
    // so a queue change made on another device arrives without a reload.
    if (Date.now() - taskTemplateLastSyncAt > 30000) syncTaskTemplatesWithDrive();
    // Refresh the "Synced Xm ago" label every tick regardless of whether
    // this particular poll changed anything — otherwise it'd only ever
    // update at the moment something actually synced, and would sit
    // frozen on a stale "2m ago" indefinitely once nothing new comes in.
    updateDriveUI();
  }
  async function verifyLatestOnForeground() {
    if (!DriveDB.signedIn || !DriveDB.dataSynced || !isOnline) return;

    const seq = ++foregroundDriveCheckSeq;
    try {
      // Let an already-running sync finish, but do not lock editing or
      // change the visible status just because the user returned to the tab.
      const started = Date.now();
      while (DriveDB.busy && Date.now() - started < 15000) {
        await new Promise(r => setTimeout(r, 120));
      }
      if (seq !== foregroundDriveCheckSeq || document.visibilityState !== "visible" || DriveDB.busy) return;

      // Metadata-only check first. In the normal case (nothing newer on
      // Drive) this is completely silent and causes no canvas rebuild.
      DriveDB.busy = true;
      try {
        await DriveDB.verifyRemote();
      } catch (e) {
        console.error("Silent foreground Drive check failed", e);
        DriveDB.consecutivePollFailures++;
        if (DriveDB.consecutivePollFailures >= DriveDB.MAX_POLL_FAILURES && DriveDB.status !== "reauth") {
          DriveDB.status = "broken";
          updateDriveUI();
        }
        return;
      } finally {
        DriveDB.busy = false;
      }

      if (seq !== foregroundDriveCheckSeq || document.visibilityState !== "visible") return;

      // Only interrupt the user when Drive actually contains a newer copy.
      // Then the existing conflict UI/lock is meaningful rather than routine.
      if (DriveDB.conflictDetected) {
        updateDriveUI();
        await pollDriveUpdates(true);
      }
    } finally {
      if (seq === foregroundDriveCheckSeq) updateDriveUI();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      verifyLatestOnForeground();
      if (Date.now() - taskTemplateLastSyncAt > 30000) syncTaskTemplatesWithDrive();
    }
  });

  // "⟳ Load latest" — a manual, do-it-now version of the background poll,
  // for when you don't want to wait on (or trust) the automatic check:
  // saves whatever is pending, pulls down anything newer from Drive, then
  // uploads anything Drive is missing. Work on this device that Drive
  // never received is kept as a copy rather than overwritten (see
  // saveConflictCopy).
  const loadLatestBtn = document.getElementById("btn-load-latest");
  let loadLatestRunning = false;
  async function loadLatestFromDrive() {
    if (loadLatestRunning) return;
    if (!DriveDB.signedIn) {
      DriveDB.signIn(false).catch(err => alert(err.message || "Google sign-in failed."));
      return;
    }
    if (!isOnline) { showToast("You're offline \u2014 can't reach Google Drive"); return; }
    loadLatestRunning = true;
    const originalLabel = loadLatestBtn.textContent;
    loadLatestBtn.disabled = true;
    loadLatestBtn.textContent = "\u27f3 Loading\u2026";
    try {
      if (DriveDB.needsReauth) {
        // Session expired: an explicit sign-in (a real click) is the fix,
        // and it syncs on its own.
        await DriveDB.signIn(false);
        showToast("Reconnected and loaded the latest from Drive");
        return;
      }
      // Commit whatever is mid-edit, then let any save/upload/poll in
      // flight finish so nothing overlaps.
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      try { flushPersist(); } catch (e) {}
      const t0 = Date.now();
      while ((DriveDB.busy || localSaveBusy()) && Date.now() - t0 < 15000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      DriveDB.busy = true;
      let changed = false;
      try {
        changed = await DriveDB.syncFromDrive();
        DriveDB.status = "ok";
        await DriveDB.pushLocalNewer({ force: true });
      } finally {
        DriveDB.busy = false;
      }
      driveRenderPending = false;
      renderSidebar();
      renderAll();
      updateDriveUI();
      await syncTaskTemplatesWithDrive();
      if (DriveDB.driveBroken()) showToast("Loaded from Drive, but some of your changes still aren't uploading \u2014 retrying");
      else showToast(changed ? "\u2705 Loaded the latest from Drive" : "\u2705 Already on the latest version");
    } catch (e) {
      console.error("Load latest failed", e);
      showToast("Couldn't load from Drive: " + ((e && e.message) || e));
    } finally {
      DriveDB.setSyncProgress("", 0, 0);
      loadLatestRunning = false;
      loadLatestBtn.disabled = false;
      loadLatestBtn.textContent = originalLabel;
    }
  }
  loadLatestBtn.addEventListener("click", loadLatestFromDrive);

  // "⬆ Upload" — the push counterpart to "⟳ Load latest". Uploads the map
  // that's open right now to Google Drive immediately, for when you'd
  // rather not just trust that the automatic upload happened. It:
  //   1. commits anything mid-edit and lets in-flight saves finish,
  //   2. checks Drive first — if another device saved a NEWER copy of
  //      this map, it asks before replacing it and keeps that copy as its
  //      own map so nothing is lost (same rule as the background sync),
  //   3. force-uploads the map even if it already looks "synced",
  //   4. re-reads Drive afterwards to confirm the upload really landed.
  const uploadNowBtn = document.getElementById("btn-upload-now");
  let uploadNowRunning = false;
  async function uploadCurrentMapToDrive() {
    if (uploadNowRunning) return;
    if (!state.current) { showToast("Open a map first"); return; }
    if (!DriveDB.signedIn) {
      DriveDB.signIn(false).catch(err => alert(err.message || "Google sign-in failed."));
      return;
    }
    if (!isOnline) { showToast("You're offline \u2014 can't reach Google Drive"); return; }
    uploadNowRunning = true;
    const originalLabel = uploadNowBtn.textContent;
    uploadNowBtn.disabled = true;
    uploadNowBtn.textContent = "\u2b06 Uploading\u2026";
    let holdingFlags = false;
    try {
      if (DriveDB.needsReauth) {
        // Expired Google session: a real click is the fix.
        await DriveDB.signIn(false);
        if (!state.current) return;
      }
      // Commit whatever is mid-edit (including a note still in its
      // autosave debounce), then let any save/upload/poll in flight
      // finish so two uploads of the same map can't overlap.
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      try { flushAllPendingSaves(); } catch (e) {}
      const t0 = Date.now();
      const busy = () => DriveDB.busy || DriveDB.pushingLocal || localSaveBusy();
      while (busy() && Date.now() - t0 < 20000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (busy()) { showToast("Still saving \u2014 try Upload again in a moment"); return; }
      if (!state.current) return;

      // Claim the sync flags so the background poll doesn't start its own
      // upload of this same map while ours is running.
      DriveDB.busy = true;
      DriveDB.pushingLocal = true;
      holdingFlags = true;

      const map = state.current;
      const stamp = map.updatedAt || 0;
      const findRemote = async () => (await DriveDB.listRemote())
        .find(f => f.appProperties && f.appProperties.branchlineId === map.id);

      const before = await findRemote();
      if (before) {
        const remoteStamp = Number((before.appProperties && before.appProperties.updatedAt) || 0);
        // Make sure save() updates the existing Drive file rather than
        // creating a duplicate if this device hadn't indexed it yet.
        if (!DriveDB.fileIndex[map.id]) DriveDB.fileIndex[map.id] = { fileId: before.id, updatedAt: remoteStamp };
        if (remoteStamp > stamp) {
          const ok = confirm("Google Drive already has a NEWER version of this map (saved from another device).\n\nUploading will replace it with this device's version. Drive's version will be kept as a separate map in your list so nothing is lost.\n\nUpload anyway?");
          if (!ok) { showToast("Upload cancelled \u2014 tap \u27f3 Load latest to get Drive's newer version instead"); return; }
          let kept = null;
          try {
            const other = await DriveDB.downloadFile(before.id);
            if (other && other.root) {
              if (DriveDB.driveFormatFor(before) === "2") {
                kept = await saveConflictCopy(other, "other device", { sharedPhotoSourceMapId: map.id });
              } else {
                const portableOther = await DriveDB.portableRemoteCopy(before, other);
                kept = await saveConflictCopy(portableOther, "other device");
              }
            }
          } catch (e) { console.error("Couldn't fetch Drive's newer copy", e); }
          if (!kept) { showToast("Couldn't back up Drive's newer copy first \u2014 nothing was uploaded"); return; }
          renderSidebar();
        }
      }

      await DriveDB.save(map, { skipRemoteGuard: true });
      if (DriveDB.driveBroken()) {
        showToast("\u26a0 Upload to Drive failed \u2014 check your connection and try again");
        return;
      }

      // Don't just trust that the PUT returned OK: ask Drive what it holds now.
      const after = await findRemote();
      const afterStamp = after ? Number((after.appProperties && after.appProperties.updatedAt) || 0) : 0;
      syncTaskTemplatesWithDrive();
      if (after && afterStamp >= stamp) {
        const name = (map.title || "Untitled map").slice(0, 40);
        showToast("\u2705 Uploaded \u201c" + name + "\u201d to Google Drive");
      } else {
        showToast("\u26a0 Upload finished but Drive doesn't show it yet \u2014 try again");
      }
    } catch (e) {
      console.error("Manual upload failed", e);
      showToast("Couldn't upload to Drive: " + ((e && e.message) || e));
    } finally {
      if (holdingFlags) { DriveDB.busy = false; DriveDB.pushingLocal = false; }
      uploadNowRunning = false;
      uploadNowBtn.disabled = false;
      uploadNowBtn.textContent = originalLabel;
      try { updateDriveUI(); } catch (e) {}
    }
  }
  uploadNowBtn.addEventListener("click", uploadCurrentMapToDrive);

  const cloudSyncPill = document.getElementById("cloud-sync-pill");
  const syncStatusModal = document.getElementById("sync-status-modal");
  const syncModalClose = document.getElementById("sync-modal-close");
  const syncModalCancel = document.getElementById("sync-modal-cancel");
  const syncModalNow = document.getElementById("sync-modal-now");
  let syncModalRunning = false;

  function syncStampText(stamp) {
    if (!stamp) return "Not uploaded yet";
    try {
      const d = new Date(Number(stamp));
      if (Number.isNaN(d.getTime())) return String(stamp);
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (e) { return String(stamp); }
  }

  function updateSyncStatusModal() {
    if (!syncStatusModal) return;
    const hero = document.getElementById("sync-modal-hero");
    const stateEl = document.getElementById("sync-modal-state");
    const subEl = document.getElementById("sync-modal-substate");
    const mapEl = document.getElementById("sync-modal-map");
    const pendingEl = document.getElementById("sync-modal-pending");
    const lastEl = document.getElementById("sync-modal-last");
    const revisionEl = document.getElementById("sync-modal-revision");
    const tipEl = document.getElementById("sync-modal-tip");
    const progressEl = document.getElementById("sync-modal-progress");
    const progressFillEl = document.getElementById("sync-modal-progress-fill");
    const progressTextEl = document.getElementById("sync-modal-progress-text");

    const map = state.current;
    const known = map && DriveDB.fileIndex[map.id];
    const pendingCount = state.maps.filter((m) => {
      const k = DriveDB.fileIndex[m.id];
      return !k || (m.updatedAt || 0) > (k.updatedAt || 0);
    }).length;

    let mode = "warning";
    let heading = "Cloud sync is off";
    let detail = "Sign in with Google before editing on more than one device.";
    if (!DriveDB.signedIn) {
      mode = "warning";
    } else if (!isOnline) {
      mode = "error";
      heading = "Offline — not safe to switch devices";
      detail = "Reconnect to the internet so this device can verify its latest changes on Google Drive.";
    } else if (DriveDB.needsReauth) {
      mode = "error";
      heading = "Google reconnect required";
      detail = "Your Google session expired. Reconnect before continuing to edit.";
    } else if (DriveDB.driveBroken()) {
      mode = "error";
      heading = "Upload failed — changes are local only";
      detail = "The app is retrying. Do not switch devices until the status becomes Verified.";
    } else if (!DriveDB.dataSynced || DriveDB.busy || DriveDB.pushingLocal || localSaveBusy()) {
      mode = "syncing";
      heading = DriveDB.syncPhase || "Syncing…";
      const elapsed = DriveDB.syncStartedAt ? Math.max(1, Math.round((Date.now() - DriveDB.syncStartedAt) / 1000)) : 0;
      detail = "Comparing map data with Google Drive" + (elapsed ? (" · " + elapsed + "s elapsed") : "") + ". Photos are stored separately and load only when their map is opened.";
    } else if (pendingCount > 0) {
      mode = "syncing";
      heading = "Waiting to upload " + pendingCount + (pendingCount === 1 ? " map" : " maps");
      detail = "Keep this tab open until the pending count reaches zero.";
    } else {
      mode = "verified";
      heading = "✓ Verified — safe to switch devices";
      detail = "Google Drive has confirmed the latest known revision. Your other device can now load it.";
    }

    const progressPct = mode === "verified"
      ? 100
      : (mode === "syncing" ? Math.max(1, DriveDB.syncProgressPercent || 1) : 0);
    if (hero) hero.dataset.state = mode;
    if (stateEl) stateEl.textContent = mode === "syncing" ? (heading + " · " + progressPct + "%") : heading;
    if (subEl) subEl.textContent = detail;
    if (progressEl) progressEl.classList.toggle("hidden", mode !== "syncing" && mode !== "verified");
    if (progressFillEl) progressFillEl.style.width = progressPct + "%";
    if (progressTextEl) progressTextEl.textContent = progressPct + "%";
    if (mapEl) mapEl.textContent = map ? ((map.title || "Untitled map") + " · " + syncStampText(map.updatedAt)) : "No map open";
    if (pendingEl) pendingEl.textContent = String(pendingCount);
    if (lastEl) {
      if (!DriveDB.lastSyncedAt) lastEl.textContent = "Not verified this session";
      else {
        const ago = relTime(DriveDB.lastSyncedAt);
        lastEl.textContent = ago === "now" ? "Just now" : ago + " ago";
      }
    }
    if (revisionEl) revisionEl.textContent = known ? syncStampText(known.updatedAt) : "Not on Drive yet";
    if (tipEl) tipEl.innerHTML = mode === "verified"
      ? "On your phone, wait for <b>Verified — safe to switch devices</b> before closing the tab or moving to your PC."
      : "Keep this device open until the status becomes <b>Verified — safe to switch devices</b>. If it stays here, press <b>Sync &amp; verify now</b>.";
    if (syncModalNow && !syncModalRunning) {
      syncModalNow.textContent = DriveDB.signedIn ? "⟳ Sync & verify now" : "Sign in with Google";
      syncModalNow.disabled = false;
    }
  }

  function openSyncStatusModal() {
    if (!syncStatusModal) return;
    updateSyncStatusModal();
    zoomModalOpen(syncStatusModal);
  }
  function closeSyncStatusModal() { zoomModalClose(syncStatusModal); }

  if (cloudSyncPill) cloudSyncPill.addEventListener("click", openSyncStatusModal);
  if (syncModalClose) syncModalClose.addEventListener("click", closeSyncStatusModal);
  if (syncModalCancel) syncModalCancel.addEventListener("click", closeSyncStatusModal);
  if (syncStatusModal) syncStatusModal.addEventListener("click", (e) => {
    if (e.target === syncStatusModal && !syncModalRunning) closeSyncStatusModal();
  });
  if (syncModalNow) syncModalNow.addEventListener("click", async () => {
    if (syncModalRunning) return;
    syncModalRunning = true;
    syncModalNow.disabled = true;
    syncModalNow.textContent = "⟳ Verifying…";
    try {
      if (!DriveDB.signedIn || DriveDB.needsReauth) {
        await DriveDB.signIn(false);
      } else {
        await loadLatestFromDrive();
      }
      // loadLatestFromDrive already performs pull -> merge -> push. One
      // extra metadata check on the open map gives the modal a very simple
      // final invariant: Drive's confirmed stamp must be at least the local
      // stamp before we tell the user it is safe to switch devices.
      const map = state.current;
      const known = map && DriveDB.fileIndex[map.id];
      if (map && known && isOnline && !DriveDB.driveBroken() && !DriveDB.needsReauth) {
        try {
          const remote = await DriveDB.readRemoteStamp(known.fileId);
          if (remote.updatedAt > (known.updatedAt || 0)) {
            // Drive changed again during our manual sync (another device
            // saved in the middle). Reconcile once more instead of showing
            // a false green "Verified" from the older fileIndex value.
            DriveDB.conflictDetected = true;
            DriveDB.freshUntil = 0;
            DriveDB.busy = true;
            try {
              await DriveDB.syncFromDrive();
              await DriveDB.pushLocalNewer({ force: true, includeNew: true });
            } finally {
              DriveDB.busy = false;
            }
          } else if (remote.updatedAt < (map.updatedAt || 0)) {
            await DriveDB.pushLocalNewer({ force: true, includeNew: true });
          }
        } catch (e) { console.error("Final sync verification failed", e); }
      }
    } catch (e) {
      console.error("Sync modal action failed", e);
      showToast("Couldn't verify Drive: " + ((e && e.message) || e));
    } finally {
      syncModalRunning = false;
      updateDriveUI();
      updateSyncStatusModal();
    }
  });

