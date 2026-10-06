/* Branchline — js/01-core-storage.js
   Part 1 of 19 of the former single-file app.js. Contents: intro, constants, tiny helpers, IndexedDB layer, database folder (File System Access API).
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";


  // Small "vNN" badge in the toolbar (see #version-badge in index.html)
  // showing which app.js is actually loaded — reads the real ?v= off
  // this very <script> tag (and style.css's <link>) rather than a
  // separately-hardcoded number, so it can never drift out of sync with
  // the BUMP_VERSION numbers above the tags in index.html.
  (function showVersionBadge() {
    const badge = document.getElementById("version-badge");
    if (!badge) return;
    const versionOf = (url) => {
      const m = (url || "").match(/[?&]v=([^&]+)/);
      return m ? m[1] : "?";
    };
    const jsV = versionOf(document.currentScript && document.currentScript.src);
    const cssLink = document.querySelector('link[rel="stylesheet"][href*="style.css"]');
    const cssV = versionOf(cssLink && cssLink.href);
    badge.textContent = `v${jsV}`;
    badge.title = `app.js v${jsV} · style.css v${cssV}`;
  })();

  /* ---------------- constants ---------------- */

  const PALETTE = [
    "#6F94CC", "#F39236", "#E84D42", "#0BC09C", "#499FE0",
    "#756BD1", "#E86BB8", "#F2C94C", "#5DBB63", "#C46DD1"
  ];

  const NODE_H = 40;
  const ROOT_H = 64;
  // These now represent the actual visual gap between a node's rendered
  // right edge and its child's left edge (place() adds the parent's real
  // width on top of this before positioning the child — see the layout
  // functions), so they're deliberately modest: they no longer have to
  // also account for however wide a typical node happens to be.
  const X_GAP = 70;
  // Gap between the root ("mother node" / title) and its direct children is
  // wider than the gap between later generations, so first-level branches
  // sit further out from the center.
  const ROOT_X_GAP = X_GAP * 2;
  const SLOT_GAP = 14;
  const DB_NAME = "branchline_db";
  const DB_VERSION = 3;
  const STORE = "mindmaps";
  const HANDLE_STORE = "handles";
  // Photos used to live inline as base64 data URLs right inside each
  // node's `images` array — simple, but it meant every autosave, every
  // undo/redo snapshot, and every local IndexedDB write had to carry
  // full-resolution photo bytes along with the node tree, even for a
  // one-character text edit on a completely different node. They now
  // live in their own object store, keyed by a short id; nodes only
  // hold that id. See PhotoDB below and getNodeImages/getNodeImageIds.
  const PHOTO_STORE = "photos";
  const DRAG_THRESHOLD = 4;

  /* ---------------- tiny helpers ---------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ================= Date helpers (task due dates / Calendar) =================
     Dates are stored as plain "YYYY-MM-DD" strings (local calendar day,
     no time/timezone component) so a task's due date means the same
     day everywhere it's viewed — same convention as the standalone
     Tasks app's calendar. */
  function toISODate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function fromISODate(s) {
    const parts = String(s || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  function isSameDate(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function luminance(hex) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substr(0, 2), 16) / 255;
    const g = parseInt(c.substr(2, 2), 16) / 255;
    const b = parseInt(c.substr(4, 2), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function hexToRgba(hex, alpha) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function hexToRgb(hex) {
    const c = (hex || "#000000").replace("#", "");
    return [parseInt(c.substr(0, 2), 16), parseInt(c.substr(2, 2), 16), parseInt(c.substr(4, 2), 16)];
  }

  function rgbToHex(r, g, b) {
    const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  function blendHex(hex, mixHex, amt) {
    const [r1, g1, b1] = hexToRgb(hex);
    const [r2, g2, b2] = hexToRgb(mixHex);
    return rgbToHex(r1 + (r2 - r1) * amt, g1 + (g2 - g1) * amt, b1 + (b2 - b1) * amt);
  }

  const DEFAULT_BG = "#FFF8E1";

  function defaultBg() {
    return DEFAULT_BG;
  }

  function defaultTheme() {
    return {
      background: null,          // null = use the app's default canvas background
      connectorMode: "branch",   // "branch" | "custom"
      connectorColor: "#7c9eff",
      connectorShape: "curved",  // "curved" | "elbow" — map-wide default, set via the root node's right-click menu; any node/connector can override with its own connectorShape
      connectorArrow: false,     // map-wide default arrowhead setting — same idea, per-hop connectorStyle overrides it
      fontMode: "auto",          // "auto" | "custom"
      fontColor: "#f2f3f7"
    };
  }

  function ensureTheme(map) {
    if (!map) return;
    map.theme = Object.assign(defaultTheme(), map.theme || {});
  }

  // Default distance for the hop from a node's parent to the node itself,
  // at a given depth (depth 1 = a direct child of the root). The
  // root-to-first-level hop is wider (ROOT_X_GAP); every hop after that
  // uses a normal X_GAP. Elbow connectors are right-angled rather than a
  // sweeping curve, so they read cleanly at closer range — by default
  // they use half the normal spacing (a custom xGap on a node still
  // always wins, regardless of connector shape).
  function defaultGapForDepth(depth) {
    const base = depth === 1 ? ROOT_X_GAP : X_GAP;
    const isElbow = state.current && state.current.theme && state.current.theme.connectorShape === "elbow";
    return isElbow ? base / 2 : base;
  }

  // The actual distance to use for the hop from a node's parent to the
  // node itself: its own explicit override (set by right-clicking the
  // connector — see openConnectorContextMenu) if it has one, else the
  // normal default for its depth.
  function gapFor(node) {
    return (typeof node.xGap === "number" && node.xGap >= 0) ? node.xGap : defaultGapForDepth(node._depth);
  }

  function haloColorFor(bg) {
    return luminance(bg) > 0.55 ? "rgba(8,10,14,0.42)" : "rgba(255,255,255,0.30)";
  }

  // Solid (non-translucent) contrast color for the text caret — used so the
  // blinking cursor stays visible even when a node's own text color happens
  // to be close to whatever it's sitting on top of (this matters most for
  // level-3+ nodes, which have no fill of their own and sit directly on the
  // user's chosen canvas background).
  function caretColorFor(bg) {
    return luminance(bg) > 0.55 ? "#0d1020" : "#ffffff";
  }

  function applyTheme() {
    if (!state.current) return;
    ensureTheme(state.current);
    const bg = state.current.theme.background || defaultBg();
    document.documentElement.style.setProperty("--bg", bg);
  }


  /* ---------------- IndexedDB layer ---------------- */

  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(HANDLE_STORE)) {
            db.createObjectStore(HANDLE_STORE);
          }
          if (!db.objectStoreNames.contains(PHOTO_STORE)) {
            const photos = db.createObjectStore(PHOTO_STORE, { keyPath: "id" });
            photos.createIndex("mapId", "mapId", { unique: false });
          }
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async getHandle(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readonly");
        const req = tx.objectStore(HANDLE_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async setHandle(key, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    },
    async getAll() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async put(map) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(map);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    },
    async delete(id) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    }
  };

  // Converts a data: URL string into a Blob without a network round trip
  // (fetch() on a data:/blob: URL works in most browsers but isn't
  // guaranteed, and is slower than just decoding the base64 directly).
  // Used to get incoming photos (file upload, paste, crop, label-bake —
  // all of which still hand over a data: URL) into Blob form before they
  // ever touch PhotoDB or the in-memory cache.
  // The decode half of dataUrlToBlob on its own — addPhotoRecord needs the
  // raw bytes to fingerprint them before deciding whether an identical
  // photo is already stored.
  function dataUrlToBytes(dataUrl) {
    const commaIdx = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, commaIdx);
    const body = dataUrl.slice(commaIdx + 1);
    const mimeMatch = /data:([^;]+)/.exec(header);
    const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  }
  function dataUrlToBlob(dataUrl) {
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    return new Blob([bytes], { type: mime });
  }

  // The reverse — only needed where a photo has to leave this browser
  // as a fully self-contained blob of JSON (Export .json, Google Drive,
  // the connected local folder), since a Blob/object URL only means
  // anything inside this tab.
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Photos, stored one row per photo: { id, mapId, blob }. Kept in their
  // own store (see PHOTO_STORE above) so the node tree itself only ever
  // carries small id strings.
  //
  // Older rows (saved before this app stored a Blob) instead have
  // { id, mapId, data } — a base64 data: URL. Base64 inflates the raw
  // bytes by roughly a third and, more importantly, ends up living as a
  // giant JS string in memory for as long as the map is open — a Blob's
  // bytes are held by the browser outside the JS heap and only need a
  // short-lived object URL (see photoUrl/loadPhotoCacheForMap below) to
  // be displayed. Legacy rows are converted to Blob form the first time
  // they're read (see loadPhotoCacheForMap) and written back, so this is
  // a one-time cost per photo, not a repeated one.
  const PhotoDB = {
    async put(rec) {
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    },
    async get(id) {
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readonly");
        const req = tx.objectStore(PHOTO_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
    },
    // Bulk insert is dramatically faster during a first/new-device sync:
    // a Drive map can contain dozens or hundreds of inline photos. The old
    // migration opened one IndexedDB transaction per photo, so the browser
    // spent most of the sync repeatedly creating/committing transactions.
    // One transaction for the whole batch keeps the same data model while
    // cutting that overhead down to a single commit.
    async putMany(records) {
      if (!records || !records.length) return;
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        const store = tx.objectStore(PHOTO_STORE);
        records.forEach((rec) => store.put(rec));
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject((e && e.target && e.target.error) || new Error("Photo batch write aborted"));
      });
    },
    async delete(id) {
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    },
    async getAllForMap(mapId) {
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readonly");
        const req = tx.objectStore(PHOTO_STORE).index("mapId").getAll(IDBKeyRange.only(mapId));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async deleteAllForMap(mapId) {
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        const idx = tx.objectStore(PHOTO_STORE).index("mapId");
        const req = idx.openKeyCursor(IDBKeyRange.only(mapId));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          tx.objectStore(PHOTO_STORE).delete(cursor.primaryKey);
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    },
    // Every row in the store, regardless of which map (if any) it still
    // claims to belong to — used only to hunt for rows whose mapId no
    // longer matches any map this browser actually knows about (a map
    // permanently deleted by an older build that didn't clean up its
    // photos first, an interrupted permanentlyDeleteMap/emptyTrash call,
    // etc.). Never used on the normal read path — that's getAllForMap,
    // scoped to one map via the index so it stays fast even with a lot
    // of rows.
    async getAllRaw() {
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readonly");
        const req = tx.objectStore(PHOTO_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async deleteMany(ids) {
      if (!ids.length) return;
      const db = await DB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        const store = tx.objectStore(PHOTO_STORE);
        ids.forEach(id => store.delete(id));
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    }
  };

  // Recovery/conflict copies can share immutable photo rows/files with the
  // original map instead of duplicating tens of MB of identical bytes.
  // New/edited photos on the recovery copy still belong to the copy itself;
  // only unchanged ids fall back to this source map.
  function sharedPhotoSourceMapId(map) {
    const id = map && map._sharedPhotoSourceMapId;
    return id && id !== map.id ? id : null;
  }

  async function photoRowsForMapWithSharedSource(map) {
    if (!map) return [];
    let own = [];
    try { own = await PhotoDB.getAllForMap(map.id); } catch (e) {}
    const sourceId = sharedPhotoSourceMapId(map);
    if (!sourceId) return own;
    let source = [];
    try { source = await PhotoDB.getAllForMap(sourceId); } catch (e) {}
    const byId = new Map();
    source.forEach((r) => { if (r && r.id) byId.set(r.id, r); });
    own.forEach((r) => { if (r && r.id) byId.set(r.id, r); }); // own wins
    return Array.from(byId.values());
  }

  // In-memory id -> object-URL cache for whichever map is currently
  // open, populated by loadPhotoCacheForMap() (see openMap). Every
  // rendering/editing call site keeps working with a plain URL string
  // exactly as before via getNodeImages()/photoUrl(); only code that
  // actually needs the photo's raw bytes (duplicate, export/sync) reads
  // photoBlobCache instead.
  //
  // photoCache holds the *display* form (an object URL — cheap, just a
  // short registration the browser resolves internally to the Blob's
  // bytes) while photoBlobCache holds the actual Blob each one points
  // to, so a photo's bytes only ever exist once in memory no matter how
  // many nodes reference it. Object URLs are explicitly revoked (see
  // revokePhotoCache/deletePhotoRecord below) since, unlike a plain
  // string, the browser won't reclaim one just because nothing points to
  // it anymore — an un-revoked URL keeps its Blob alive for the rest of
  // the page's life.
  let photoCache = new Map();
  let photoBlobCache = new Map();

  // ---- Identical photos share one id ---------------------------------
  // Every stored photo is fingerprinted (length + a 64-bit hash of its
  // bytes). addPhotoRecord looks the fingerprint up before creating a
  // record: if the very same photo is already stored on this map, the
  // existing id is handed back instead of storing the bytes a second
  // time — so two nodes showing the same picture reference one id, one
  // Blob and one PhotoDB row. Rules that keep that safe:
  //  - the bytes are only dropped once NOTHING in the map still points at
  //    the id (see deletePhotoRecord / photoIsReferenced);
  //  - an owner (a node, a cell, one link's photo list) never holds the
  //    same id twice — it gets its own id, sharing the same in-memory Blob;
  //  - edits (crop / text / combine) always get a fresh id (noDedupe).
  // Photos already stored when a map opens are fingerprinted in the
  // background (indexPhotoFingerprints), so until that finishes a
  // duplicate can still slip through as a separate record — harmless, and
  // "Merge identical photos" in the Storage panel folds those together.
  let photoFpById = new Map();   // id -> fingerprint
  let photoIdsByFp = new Map();  // fingerprint -> Set of ids
  let photoFpGeneration = 0;     // bumped whenever the cache is reloaded, cancelling a stale index pass
  let photoFpIndexPromise = Promise.resolve();

  function fingerprintBytes(bytes) {
    let u8 = bytes;
    if (u8.byteOffset % 4 !== 0) u8 = u8.slice(); // Uint32Array needs a 4-byte aligned start
    const len = u8.length;
    const nWords = len >>> 2;
    const words = new Uint32Array(u8.buffer, u8.byteOffset, nWords);
    const C1 = 0xcc9e2d51, C2 = 0x1b873593;
    let h1 = 0x9747b28c, h2 = 0x5bd1e995;
    for (let i = 0; i < nWords; i++) {
      const w = words[i];
      let k = Math.imul(w, C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, C2);
      h1 ^= k; h1 = (h1 << 13) | (h1 >>> 19); h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
      let k2 = Math.imul(w ^ 0x9e3779b9, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C1);
      h2 ^= k2; h2 = (h2 << 11) | (h2 >>> 21); h2 = (Math.imul(h2, 5) + 0x52dce729) | 0;
    }
    let tail = 0;
    for (let i = nWords << 2; i < len; i++) tail = (tail << 8) | u8[i];
    if (tail) {
      let k = Math.imul(tail, C1); k = (k << 15) | (k >>> 17); k = Math.imul(k, C2); h1 ^= k;
      let k2 = Math.imul(tail ^ 0x9e3779b9, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C1); h2 ^= k2;
    }
    const fmix = (h) => {
      h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
      h ^= h >>> 16; return h >>> 0;
    };
    return `${len}-${fmix(h1 ^ len).toString(36)}${fmix(h2 ^ len).toString(36)}`;
  }
  function rememberPhotoFingerprint(id, fp) {
    if (!id || !fp) return;
    photoFpById.set(id, fp);
    let set = photoIdsByFp.get(fp);
    if (!set) { set = new Set(); photoIdsByFp.set(fp, set); }
    set.add(id);
  }
  function forgetPhotoFingerprint(id) {
    const fp = photoFpById.get(id);
    if (!fp) return;
    photoFpById.delete(id);
    const set = photoIdsByFp.get(fp);
    if (set) { set.delete(id); if (!set.size) photoIdsByFp.delete(fp); }
  }
  // Fingerprints every photo that was already stored when the map opened.
  // One photo at a time with a yield in between, and after a short pause
  // so it never competes with the map's first render.
  async function indexPhotoFingerprints(gen) {
    await new Promise((r) => setTimeout(r, 1200));
    const entries = Array.from(photoBlobCache.entries());
    for (let i = 0; i < entries.length; i++) {
      if (gen !== photoFpGeneration) return;
      const [id, blob] = entries[i];
      if (photoFpById.has(id) || photoBlobCache.get(id) !== blob) continue;
      try {
        const buf = await blob.arrayBuffer();
        if (gen !== photoFpGeneration) return;
        if (photoBlobCache.get(id) === blob) rememberPhotoFingerprint(id, fingerprintBytes(new Uint8Array(buf)));
      } catch (e) { /* unreadable photo — just leave it out of the index */ }
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
  }

  function revokePhotoCache() {
    photoCache.forEach((url) => { try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ } });
  }

  async function loadPhotoCacheForMap(mapId) {
    revokePhotoCache();
    photoCache = new Map();
    photoBlobCache = new Map();
    photoFpGeneration++;
    photoFpById = new Map();
    photoIdsByFp = new Map();
    photoFpIndexPromise = Promise.resolve();
    if (!mapId) return;
    try {
      const map = state.maps.find((m) => m.id === mapId) || (state.current && state.current.id === mapId ? state.current : null);
      const rows = map ? await photoRowsForMapWithSharedSource(map) : await PhotoDB.getAllForMap(mapId);
      const migrations = [];
      rows.forEach(r => {
        let blob = r.blob;
        if (!blob && r.data) {
          // Legacy base64 row — convert once and persist the Blob form
          // so every future load of this photo skips this step. Keep the
          // original row's owner: a shared recovery must never "adopt" the
          // source map's bytes just because it displayed them.
          try {
            blob = dataUrlToBlob(r.data);
            migrations.push(PhotoDB.put({ id: r.id, mapId: r.mapId || mapId, blob }));
          } catch (e) { console.error("Migrating photo to blob storage failed", e); return; }
        }
        if (!blob) return;
        photoBlobCache.set(r.id, blob);
        photoCache.set(r.id, URL.createObjectURL(blob));
      });
      if (migrations.length) Promise.all(migrations).catch(e => console.error("Migrating photo storage failed", e));
    } catch (e) { console.error("Loading photos failed", e); }
    photoFpIndexPromise = indexPhotoFingerprints(photoFpGeneration);
  }

  // Adds a brand-new photo (from a file/paste) to the store + cache for
  // the currently open map and returns its id. Fire-and-forget on the
  // actual disk write — the cache is updated synchronously so rendering
  // never has to wait on it. Still takes a data: URL, same as every
  // existing caller (file upload, paste, crop apply, label bake) already
  // produces — only the storage/display form changes, right here.
  //
  // If an identical photo is already stored on this map, that photo's id is
  // returned and nothing new is stored (see "Identical photos share one id"
  // above). `opts.avoid` — the ids the caller's owner (node/cell/link)
  // already holds — keeps one owner from getting the same id twice; in that
  // case a separate id is made that still shares the existing Blob in
  // memory. `opts.noDedupe` always makes a fresh record (edits).
  function addPhotoRecord(dataUrl, opts) {
    const o = opts || {};
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    const fp = fingerprintBytes(bytes);
    let shareBlob = null;
    if (!o.noDedupe) {
      const twins = photoIdsByFp.get(fp);
      if (twins) {
        const avoid = o.avoid || [];
        for (const twinId of twins) {
          if (!photoBlobCache.has(twinId)) continue;
          if (!avoid.includes(twinId)) return twinId;
          if (!shareBlob) shareBlob = photoBlobCache.get(twinId);
        }
      }
    }
    const id = uid();
    const blob = shareBlob || new Blob([bytes], { type: mime });
    photoBlobCache.set(id, blob);
    photoCache.set(id, URL.createObjectURL(blob));
    rememberPhotoFingerprint(id, fp);
    if (state.current) PhotoDB.put({ id, mapId: state.current.id, blob }).catch(e => console.error("Saving photo failed", e));
    return id;
  }

  // Copies an existing photo onto a brand-new id — used when a photo is
  // Alt/Option-dragged onto another node (a real copy, not a shared
  // reference) so each node ends up owning its own photo record. The two
  // ids can safely share the same underlying Blob (Blobs are immutable)
  // instead of duplicating the bytes in memory.
  //
  // Identical photos now share one id (see above), so a copy simply reuses
  // the id — one stored photo, referenced from both nodes — unless the
  // destination already holds that id (`avoid`), in which case it gets its
  // own id still backed by the same in-memory Blob.
  function duplicatePhotoRecord(oldId, avoid) {
    const blob = photoBlobCache.get(oldId);
    if (!blob) return oldId; // shouldn't happen; fail safe by sharing the id
    if (!Array.isArray(avoid) || !avoid.includes(oldId)) return oldId;
    const id = uid();
    photoBlobCache.set(id, blob);
    photoCache.set(id, URL.createObjectURL(blob));
    const fp = photoFpById.get(oldId);
    if (fp) rememberPhotoFingerprint(id, fp);
    if (state.current) PhotoDB.put({ id, mapId: state.current.id, blob }).catch(e => console.error("Saving photo failed", e));
    return id;
  }

  // ---- Photos embedded inline in notes ---------------------------------
  // A note's rich-text body can hold pasted/dropped screenshots too (see
  // noteInsertImages below). Those now live in PhotoDB exactly like a
  // node's attached photos — the note's stored HTML carries only a
  // data-photo-id="…" attribute on the <img>, never the picture's bytes —
  // so two identical screenshots pasted into one note (or two different
  // notes on the same map) share one PhotoDB row instead of each paste
  // inflating the note's own HTML with a fresh copy of the same base64.
  // Ids only ever appear in that one attribute, so a plain string scan is
  // enough; no need to parse the HTML into a live DOM just to read it.
  function extractNotePhotoIds(html) {
    const ids = [];
    if (!html || html.indexOf("data-photo-id") === -1) return ids;

    // A browser only keeps ONE value when the same HTML attribute appears
    // several times on one element. Older Branchline export/import cycles
    // accidentally stacked a fresh data-photo-id onto the same <img> every
    // time, so a single visible image could contain 7-10 historical ids.
    // The old regex counted every one as a separate photo, which is how one
    // real map ended up trying to migrate hundreds of phantom "photos".
    const tagRe = /<img\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = tagRe.exec(html))) {
      const idMatch = /\bdata-photo-id=(["'])([^"']+)\1/i.exec(tagMatch[0]);
      if (idMatch && idMatch[2]) ids.push(idMatch[2]);
    }
    return ids;
  }

  // Collapses the historical duplicate data-photo-id chain on every note
  // image to ONE id. If the newest/first id has already been lost, prefer an
  // older alias that still exists in PhotoDB or Drive. Those aliases all came
  // from repeated migrations of the very same <img>, so this is a repair, not
  // an image substitution.
  function repairDuplicateNotePhotoAliases(map, availableIds) {
    if (!map || !map.root) return { changedTags: 0, removedAliases: 0, switchedToAvailable: 0 };
    const available = availableIds || new Set();
    let changedTags = 0;
    let removedAliases = 0;
    let switchedToAvailable = 0;

    const repairOwner = (owner) => {
      if (!owner || !Array.isArray(owner.notes)) return;
      owner.notes.forEach((n) => {
        if (!n || !n.html || n.html.indexOf("data-photo-id") === -1) return;
        n.html = n.html.replace(/<img\b[^>]*>/gi, (tag) => {
          const aliasRe = /\s+data-photo-id=(["'])([^"']+)\1/gi;
          const aliases = [];
          let m;
          while ((m = aliasRe.exec(tag))) aliases.push(m[2]);
          if (aliases.length <= 1) return tag;

          const chosen = aliases.find((id) => available.has(id)) || aliases[0];
          if (chosen !== aliases[0]) switchedToAvailable++;
          removedAliases += aliases.length - 1;
          changedTags++;

          let clean = tag.replace(/\s+data-photo-id=(["'])[^"']+\1/gi, "");
          clean = clean.replace(/<img\b/i, (open) => `${open} data-photo-id="${chosen}"`);
          return clean;
        });
      });
    };
    const repairTasks = (tasks) => (tasks || []).forEach((t) => {
      if (!t) return;
      repairOwner(t);
      (t.subtasks || []).forEach(repairOwner);
    });

    (function walk(node) {
      if (!node) return;
      repairOwner(node);
      repairTasks(node.tasks);
      if (node.table && Array.isArray(node.table.attach)) {
        node.table.attach.forEach((row) => (row || []).forEach((a) => {
          if (!a) return;
          repairOwner(a);
          repairTasks(a.tasks);
        }));
      }
      (node.children || []).forEach(walk);
    })(map.root);

    return { changedTags, removedAliases, switchedToAvailable };
  }
  // Every note-bearing "owner" shape (a node, a table cell's attach record,
  // a task, a subtask) stores its notes the same way — see getNodeNotes/
  // getTaskNotes/getCellNotes — so this only needs to look at `.notes`.
  function addNoteOwnerPhotoIds(owner, ids) {
    if (!owner || !Array.isArray(owner.notes)) return;
    owner.notes.forEach((n) => { if (n && n.html) extractNotePhotoIds(n.html).forEach((id) => ids.add(id)); });
  }
  function addTaskListNotePhotoIds(tasks, ids) {
    (tasks || []).forEach((t) => {
      if (!t) return;
      addNoteOwnerPhotoIds(t, ids);
      (t.subtasks || []).forEach((s) => addNoteOwnerPhotoIds(s, ids));
    });
  }

  // Every id any node, table cell, link comment, or inline note image in
  // this tree points at.
  function collectReferencedPhotoIds(root) {
    const ids = new Set();
    const addList = (list) => (list || []).forEach((id) => { if (id) ids.add(id); });
    (function walk(node) {
      if (!node) return;
      getNodeImageIds(node).forEach((id) => ids.add(id));
      getCellImageIds(node).forEach((id) => ids.add(id));
      if (node.linkPhotos) Object.values(node.linkPhotos).forEach(addList);
      addNoteOwnerPhotoIds(node, ids);
      addTaskListNotePhotoIds(node.tasks, ids);
      if (node.table && Array.isArray(node.table.attach)) {
        node.table.attach.forEach((row) => (row || []).forEach((a) => {
          if (!a) return;
          if (a.linkPhotos) Object.values(a.linkPhotos).forEach(addList);
          addNoteOwnerPhotoIds(a, ids);
          addTaskListNotePhotoIds(a.tasks, ids);
        }));
      }
      (node.children || []).forEach(walk);
    })(root);

    // Keep confirmed-unrecoverable ids IN the map, but don't let them block
    // every future Drive save. They remain preserved under the original node/
    // note plus this explicit recovery list, so a later backup/recovery tool
    // can still put bytes back under the same id.
    const quarantined = Array.isArray(root && root._missingPhotoIds)
      ? root._missingPhotoIds
      : [];
    quarantined.forEach((id) => ids.delete(id));

    return ids;
  }
  function photoIsReferenced(id) {
    return !!state.current && collectReferencedPhotoIds(state.current.root).has(id);
  }

  // Shared recovery maps may keep referencing a photo after the source map
  // itself no longer does. Any physical delete/GC must therefore consider
  // ALL maps, not just the map currently being saved.
  function photoIsReferencedByAnyMap(id) {
    if (!id) return false;
    for (const map of state.maps || []) {
      if (map && map.root && collectReferencedPhotoIds(map.root).has(id)) return true;
    }
    return false;
  }

  function sharedPhotoDependentMaps(sourceMapId) {
    if (!sourceMapId) return [];
    return (state.maps || []).filter((m) => sharedPhotoSourceMapId(m) === sourceMapId);
  }

  // Swaps fromId for toId wherever ONE node holds it — its own photos
  // (carrying the per-photo tags/notes/comments/favorite/date over to the
  // new id), its table cells' photos, and its link-comment photos. A list
  // that already holds toId is left alone so no owner ends up with the
  // same id twice. Returns how many lists changed.
  function replacePhotoIdInNode(node, fromId, toId) {
    if (!node || fromId === toId) return 0;
    let changed = 0;
    const swap = (arr) => {
      if (!Array.isArray(arr) || !arr.includes(fromId) || arr.includes(toId)) return false;
      for (let i = 0; i < arr.length; i++) if (arr[i] === fromId) arr[i] = toId;
      return true;
    };
    const renameMeta = () => {
      ["photoTags", "photoNotes", "photoComments", "photoFavorites", "photoTimestamps"].forEach((k) => {
        const m = node[k];
        if (m && Object.prototype.hasOwnProperty.call(m, fromId)) {
          if (!Object.prototype.hasOwnProperty.call(m, toId)) m[toId] = m[fromId];
          delete m[fromId];
        }
      });
    };
    if (Array.isArray(node.images) && node.images.length) {
      if (swap(node.images)) { changed++; renameMeta(); }
    } else if (node.image === fromId) {
      node.images = [toId]; node.image = null; changed++; renameMeta();
    }
    if (node.linkPhotos) Object.values(node.linkPhotos).forEach((arr) => { if (swap(arr)) changed++; });
    // Ids embedded inline in a note (see noteInsertImages/extractNotePhotoIds)
    // live inside data-photo-id="…" attributes in the note's stored HTML
    // rather than in an array, so they need their own swap: a literal
    // string replace of the attribute value (ids are plain uid() strings,
    // never containing regex-special characters, so this is safe without
    // parsing the HTML into a DOM).
    const swapNoteOwner = (owner) => {
      if (!owner || !Array.isArray(owner.notes)) return;
      owner.notes.forEach((n) => {
        if (n && n.html && n.html.indexOf(fromId) !== -1) {
          const swapped = n.html.split(`data-photo-id="${fromId}"`).join(`data-photo-id="${toId}"`);
          if (swapped !== n.html) { n.html = swapped; changed++; }
        }
      });
    };
    const swapTaskList = (tasks) => (tasks || []).forEach((t) => {
      if (!t) return;
      swapNoteOwner(t);
      (t.subtasks || []).forEach(swapNoteOwner);
    });
    swapNoteOwner(node);
    swapTaskList(node.tasks);
    if (node.table && Array.isArray(node.table.attach)) {
      node.table.attach.forEach((row) => (row || []).forEach((a) => {
        if (!a) return;
        if (Array.isArray(a.images) && a.images.length) { if (swap(a.images)) changed++; }
        else if (a.image === fromId) { a.images = [toId]; a.image = null; changed++; }
        if (a.linkPhotos) Object.values(a.linkPhotos).forEach((arr) => { if (swap(arr)) changed++; });
        swapNoteOwner(a);
        swapTaskList(a.tasks);
      }));
    }
    return changed;
  }

  function deletePhotoRecord(id) {
    // Identical photos can share one id, so only drop the bytes once nothing
    // in the map points at this id any more. (If a caller deletes before
    // removing its own reference the bytes simply linger until the idle
    // orphan sweep — never the other way round.)
    if (photoIsReferenced(id)) return;
    forgetPhotoFingerprint(id);
    const url = photoCache.get(id);
    if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ } }
    photoCache.delete(id);
    photoBlobCache.delete(id);
    // Don't touch the disk row yet. The map that's stored in IndexedDB may
    // STILL point at this id (crop / add-text / combine swap a photo for a
    // new id, and the map save that records the swap is debounced and can
    // even queue behind a slow Drive upload). Deleting the row right now
    // left a window where a refresh loaded a map referencing a photo that
    // no longer existed — the photo just vanished. The row is deleted by
    // releasePhotoDeletes() once a map save that no longer references it
    // has actually landed.
    pendingPhotoDeletes.add(id);
  }

  // ids whose PhotoDB row is waiting for a durable map save (see above).
  const pendingPhotoDeletes = new Set();
  // Called right BEFORE a map write starts: takes ownership of everything
  // queued so far. Only ids removed from the tree before this moment are
  // guaranteed to be absent from the map that write stores.
  function takePendingPhotoDeletes() {
    const ids = Array.from(pendingPhotoDeletes);
    pendingPhotoDeletes.clear();
    return ids;
  }
  // Called after that write succeeded. Skips any id the map points at again
  // (e.g. an undo re-attached it in the meantime).
  async function releasePhotoDeletes(ids, map) {
    if (!ids || !ids.length) return;
    try {
      const still = map && map.root ? collectReferencedPhotoIds(map.root) : new Set();
      const candidates = ids.filter((id) => !still.has(id));
      const doomed = [];
      for (const id of candidates) {
        const rec = await PhotoDB.get(id);
        // A shared recovery can stop referencing a source photo, but that
        // must not delete the original map's PhotoDB row.
        if ((!rec || !map || rec.mapId === map.id) && !photoIsReferencedByAnyMap(id)) doomed.push(id);
      }
      if (doomed.length) await PhotoDB.deleteMany(doomed);
    } catch (e) { console.error("Deleting photos failed", e); }
  }
  // The write failed — keep the rows and try again with the next save.
  function requeuePhotoDeletes(ids) {
    (ids || []).forEach((id) => pendingPhotoDeletes.add(id));
  }

  function photoUrl(id) {
    return photoCache.get(id) || "";
  }

  // Walks a map's node tree, migrating any legacy inline photo (a plain
  // `data:` URL, either from before this store existed or from a Drive/
  // folder/export file — see inlinePhotosForPortableCopy) into its own
  // PhotoDB record, replacing it in the tree with just the new id. Ids
  // already present (anything not starting with "data:") are left alone.
  // Safe to call repeatedly — already-migrated nodes are a no-op.
  async function ensurePhotosMigrated(map) {
    if (!map || !map.root) return;
    const puts = [];
    (function walk(node) {
      if (!node) return;
      const raw = Array.isArray(node.images) ? node.images : (node.image ? [node.image] : []);
      // Tracks old raw value (the data URL that used to double as both the
      // photo's content AND its tag key) -> its freshly-minted id, so tags
      // keyed on that old value can be carried over below instead of lost.
      const idForOldValue = new Map();
      if (raw.length) {
        const ids = raw.map((val) => {
          if (typeof val === "string" && val.startsWith("data:")) {
            const id = uid();
            idForOldValue.set(val, id);
            puts.push({ id, mapId: map.id, blob: dataUrlToBlob(val) });
            return id;
          }
          return val;
        });
        node.images = ids;
        node.image = null;
      }
      // photoTags used to be keyed by the raw data URL itself; remap any
      // such keys onto the new id using the mapping just built above, so
      // a photo's tags survive the move into its own store. A key that
      // isn't a data URL is already an id (map's been through this
      // before) and is left as-is.
      if (node.photoTags) {
        const remapped = {};
        Object.keys(node.photoTags).forEach((k) => {
          const newKey = k.startsWith("data:") ? idForOldValue.get(k) : k;
          if (newKey) remapped[newKey] = node.photoTags[k];
        });
        node.photoTags = remapped;
      }
      // Same remap for photo comments (added later, but keyed the same way).
      if (node.photoComments) {
        const remapped = {};
        Object.keys(node.photoComments).forEach((k) => {
          const newKey = k.startsWith("data:") ? idForOldValue.get(k) : k;
          if (newKey) remapped[newKey] = node.photoComments[k];
        });
        node.photoComments = remapped;
      }
      // Same migration for a table node's per-cell photos: a portable
      // copy (import, or a device that just pulled this map from Drive/
      // a folder) stores each cell's photo as a raw data URL — see
      // inlinePhotosForPortableCopy — so it needs the same one-time move
      // into PhotoDB, keyed by its own fresh id, that node.images gets
      // above.
      if (node.table && Array.isArray(node.table.attach)) {
        node.table.attach.forEach(row => (row || []).forEach((a) => {
          if (!a) return;
          if (typeof a.image === "string" && a.image.startsWith("data:")) {
            const id = uid();
            puts.push({ id, mapId: map.id, blob: dataUrlToBlob(a.image) });
            a.image = id;
          }
          if (Array.isArray(a.images) && a.images.length) {
            a.images = a.images.map((val) => {
              if (typeof val === "string" && val.startsWith("data:")) {
                const id = uid();
                puts.push({ id, mapId: map.id, blob: dataUrlToBlob(val) });
                return id;
              }
              return val;
            });
          }
        }));
      }
      // A note's inline images normally already reference PhotoDB via
      // data-photo-id (see noteInsertImages) — nothing to do for those.
      // But a note that still carries a raw `data:` <img> (an old note
      // saved before that existed, or one just brought in from a Drive/
      // folder/import file — see inlinePhotosForPortableCopy, which
      // inlines them back to plain data: URLs for portability) gets the
      // same one-time move into its own PhotoDB record here, so it picks
      // up the same dedup benefit instead of sitting there as loose
      // base64 forever.
      const migrateNoteOwner = (owner) => {
        if (!owner || !Array.isArray(owner.notes)) return;
        owner.notes.forEach((n) => {
          if (!n || !n.html || n.html.indexOf("<img") === -1) return;
          n.html = n.html.replace(/<img\b[^>]*\bsrc="(data:[^"]*)"[^>]*>/g, (tag, dataUrl) => {
            const id = uid();
            puts.push({ id, mapId: map.id, blob: dataUrlToBlob(dataUrl) });

            // Portable copies used to keep the old data-photo-id while also
            // adding src=data:; importing that file then prepended ANOTHER id.
            // Strip all historical aliases before installing the new id so a
            // round trip can never grow 1 image into 2, 3, ... fake photos.
            let clean = tag
              .replace(/\s+data-photo-id=(["'])[^"']+\1/gi, "")
              .replace(`src="${dataUrl}"`, "");
            clean = clean.replace(/<img\b/i, (open) => `${open} data-photo-id="${id}"`);
            return clean;
          });
        });
      };
      const migrateTaskList = (tasks) => (tasks || []).forEach((t) => {
        if (!t) return;
        migrateNoteOwner(t);
        (t.subtasks || []).forEach(migrateNoteOwner);
      });
      migrateNoteOwner(node);
      migrateTaskList(node.tasks);
      if (node.table && Array.isArray(node.table.attach)) {
        node.table.attach.forEach(row => (row || []).forEach((a) => {
          if (!a) return;
          migrateNoteOwner(a);
          migrateTaskList(a.tasks);
        }));
      }
      (node.children || []).forEach(walk);
    })(map.root);
    if (puts.length) await PhotoDB.putMany(puts);
    map._photosMigrated = true;
  }

  // The reverse of ensurePhotosMigrated: produces a deep-cloned, fully
  // self-contained copy of a map with every node.images id resolved back
  // to its actual data URL — used anywhere the map needs to travel
  // outside this browser's own IndexedDB (Export .json, Google Drive,
  // the connected local folder), since none of those destinations can
  // see this browser's PhotoDB.
  async function inlinePhotosForPortableCopy(map) {
    if (!map || !map.root) return map;
    const rows = await photoRowsForMapWithSharedSource(map);
    const lookup = new Map();
    // Rows are stored as a Blob (see PhotoDB above) apart from any
    // not-yet-migrated legacy row, which is already a portable base64
    // string as-is. Either way, the map needs actual inline data: URLs
    // here — a Blob/object URL only means anything inside this tab.
    await Promise.all(rows.map(async (r) => {
      if (r.data) { lookup.set(r.id, r.data); return; }
      if (r.blob) {
        try { lookup.set(r.id, await blobToDataUrl(r.blob)); }
        catch (e) { console.error("Inlining photo failed", e); }
      }
    }));
    // Also fold in anything only in the in-memory cache but not yet
    // flushed to disk (a photo added in the last <1s, say).
    if (state.current && state.current.id === map.id) {
      await Promise.all(Array.from(photoBlobCache.entries()).map(async ([id, blob]) => {
        if (lookup.has(id)) return;
        try { lookup.set(id, await blobToDataUrl(blob)); }
        catch (e) { console.error("Inlining photo failed", e); }
      }));
    }
    const clone = JSON.parse(JSON.stringify(map));
    (function walk(node) {
      if (!node) return;
      if (Array.isArray(node.images)) {
        node.images = node.images.map(id => lookup.get(id) || id);
      }
      // photoTags/photoNotes are keyed by the photo's local id, which is
      // meaningless once this map leaves this browser (Drive/folder/
      // export all carry inline bytes, not local ids — see above). Remap
      // those keys onto the same data URL the photo itself is being
      // inlined to here, so that when this file comes back in through
      // ensurePhotosMigrated(), its existing "data:"-keyed remap logic
      // (see the idForOldValue map there) can reattach the tags/notes to
      // whatever fresh id that photo gets — instead of leaving them
      // keyed to a stale local id that no longer matches anything, which
      // silently dropped tags/notes on any photo that survived a round
      // trip through Drive/folder sync or Export .json.
      if (node.photoTags) {
        const remapped = {};
        Object.keys(node.photoTags).forEach((k) => { remapped[lookup.get(k) || k] = node.photoTags[k]; });
        node.photoTags = remapped;
      }
      if (node.photoNotes) {
        const remapped = {};
        Object.keys(node.photoNotes).forEach((k) => { remapped[lookup.get(k) || k] = node.photoNotes[k]; });
        node.photoNotes = remapped;
      }
      if (node.photoComments) {
        const remapped = {};
        Object.keys(node.photoComments).forEach((k) => { remapped[lookup.get(k) || k] = node.photoComments[k]; });
        node.photoComments = remapped;
      }
      if (node.table && Array.isArray(node.table.attach)) {
        node.table.attach.forEach(row => (row || []).forEach((a) => {
          if (!a) return;
          if (a.image) a.image = lookup.get(a.image) || a.image;
          if (Array.isArray(a.images)) a.images = a.images.map(id => lookup.get(id) || id);
        }));
      }
      // A note's inline images (see noteInsertImages/extractNotePhotoIds)
      // only ever hold a data-photo-id="…" reference in storage, same as
      // node.images holding bare ids — resolve those back to real inline
      // data: URLs too, so an exported/synced copy of this note still
      // shows its pictures outside this browser.
      const inlineNoteOwner = (owner) => {
        if (!owner || !Array.isArray(owner.notes)) return;
        owner.notes.forEach((n) => {
          if (!n || !n.html || n.html.indexOf("data-photo-id") === -1) return;
          n.html = n.html.replace(/<img\b[^>]*>/gi, (tag) => {
            const aliasRe = /\bdata-photo-id=(["'])([^"']+)\1/gi;
            const aliases = [];
            let m;
            while ((m = aliasRe.exec(tag))) aliases.push(m[2]);
            if (!aliases.length) return tag;

            // If an old broken tag has several historical aliases, recover
            // through whichever alias still has bytes instead of looking only
            // at the first one and exporting a permanently broken image.
            const id = aliases.find((candidate) => lookup.has(candidate));
            if (!id) return tag;
            const dataUrl = lookup.get(id);

            // A portable file should contain the actual image bytes (src) and
            // NO browser-local photo id. Keeping both was the root cause of
            // the duplicate-id explosion in the user's 2709.json backup.
            let clean = tag.replace(/\s+data-photo-id=(["'])[^"']+\1/gi, "");
            if (/\bsrc=(["'])[^"']*\1/i.test(clean)) {
              clean = clean.replace(/\bsrc=(["'])[^"']*\1/i, `src="${dataUrl}"`);
            } else {
              clean = clean.replace(/<img\b/i, (open) => `${open} src="${dataUrl}"`);
            }
            return clean;
          });
        });
      };
      const inlineTaskList = (tasks) => (tasks || []).forEach((t) => {
        if (!t) return;
        inlineNoteOwner(t);
        (t.subtasks || []).forEach(inlineNoteOwner);
      });
      inlineNoteOwner(node);
      inlineTaskList(node.tasks);
      if (node.table && Array.isArray(node.table.attach)) {
        node.table.attach.forEach(row => (row || []).forEach((a) => {
          if (!a) return;
          inlineNoteOwner(a);
          inlineTaskList(a.tasks);
        }));
      }
      (node.children || []).forEach(walk);
    })(clone.root);
    // Portable exports/folder backups are self-contained, so they must not
    // retain a browser/Drive-local dependency on another map's photo folder.
    delete clone._sharedPhotoSourceMapId;
    delete clone._photoSharingV1;
    return clone;
  }

  // Load the editable affirmation-lines pool from IndexedDB (falling back
  // to the built-in defaults the first time the app runs), and save it
  // back whenever the person edits it in the manager modal.
  async function loadAffirmationQuotes() {
    try {
      const saved = await DB.getHandle(AFFIRMATION_QUOTES_KEY);
      if (Array.isArray(saved) && saved.length) {
        affirmationQuotesList = saved;
      }
    } catch (e) { /* IndexedDB unavailable — keep the built-in defaults */ }
  }
  async function saveAffirmationQuotes() {
    try {
      await DB.setHandle(AFFIRMATION_QUOTES_KEY, affirmationQuotesList);
    } catch (e) { /* best-effort — keep working in-memory even if this fails */ }
  }

  /* ---------------- database folder (File System Access API) ----------------
     IndexedDB is always the source of truth for fast reads, but when a
     folder is connected every mind map is also mirrored there as a plain
     .json file, so the "database" is a real folder the person can see,
     back up, or move between machines. */

  const FolderDB = {
    dir: null,
    supported: typeof window.showDirectoryPicker === "function",
    needsPermission: false,
    lastFile: {},

    async verify(handle, allowPrompt) {
      try {
        const opts = { mode: "readwrite" };
        if ((await handle.queryPermission(opts)) === "granted") return true;
        if (!allowPrompt) return false;
        if ((await handle.requestPermission(opts)) === "granted") return true;
        return false;
      } catch (e) { return false; }
    },

    async restore() {
      if (!this.supported) return;
      try {
        const handle = await DB.getHandle("mapsFolder");
        if (!handle) return;
        this.dir = handle;
        const ok = await this.verify(handle, false);
        this.needsPermission = !ok;
      } catch (e) { /* handle no longer valid; ignore */ }
    },

    async pick() {
      if (!this.supported) {
        alert("This browser can't connect a local folder for saving. Your maps still autosave to the browser's built-in database — use Export .json to back them up as files.");
        return;
      }
      try {
        const handle = await window.showDirectoryPicker();
        const ok = await this.verify(handle, true);
        if (!ok) return;
        this.dir = handle;
        this.needsPermission = false;
        this.lastFile = {};
        await DB.setHandle("mapsFolder", handle);
        await this.syncFromFolder();
        for (const m of state.maps) await this.save(m);
        await autoRemoveDuplicateMaps();
        renderSidebar();
        updateFolderUI();
      } catch (e) {
        if (e && e.name !== "AbortError") console.error("Folder connect failed", e);
      }
    },

    filenameFor(map) {
      const safe = (map.title || "untitled").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40) || "untitled";
      return `${safe}-${map.id}.json`;
    },

    async save(map) {
      if (!this.dir || this.needsPermission || !map) return;
      try {
        const name = this.filenameFor(map);
        const prev = this.lastFile[map.id];
        if (prev && prev !== name) {
          try { await this.dir.removeEntry(prev); } catch (e) {}
        }
        const fh = await this.dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        // The folder mirror is meant to be a real, self-contained backup
        // file, so it carries actual photo bytes inline rather than this
        // browser's local-only photo ids.
        const portable = await inlinePhotosForPortableCopy(map);
        await w.write(JSON.stringify(portable, null, 2));
        await w.close();
        this.lastFile[map.id] = name;
      } catch (e) { console.error("Folder save failed", e); }
    },

    async remove(map) {
      if (!this.dir || this.needsPermission || !map) return;
      const name = this.lastFile[map.id] || this.filenameFor(map);
      try { await this.dir.removeEntry(name); } catch (e) {}
      delete this.lastFile[map.id];
    },

    async syncFromFolder() {
      if (!this.dir) return;
      const ok = await this.verify(this.dir, true);
      this.needsPermission = !ok;
      if (!ok) return;
      try {
        for await (const [name, handle] of this.dir.entries()) {
          if (handle.kind !== "file" || !name.endsWith(".json")) continue;
          try {
            const file = await handle.getFile();
            const data = JSON.parse(await file.text());
            if (!data || !data.id || !data.root) continue;
            const existing = state.maps.find(m => m.id === data.id);
            // Skip entirely if our copy is already current — otherwise
            // ensurePhotosMigrated below still runs on every sync and
            // re-migrates this file's inline photo bytes into brand-new
            // PhotoDB records each time, even though `data` is about to
            // be thrown away unused, silently duplicating photo storage
            // on every refresh.
            if (existing && (existing.updatedAt || 0) >= (data.updatedAt || 0)) {
              this.lastFile[data.id] = name;
              continue;
            }
            ensureTheme(data);
            ensureLayout(data);
            ensureFavorite(data);
            ensureTrash(data);
            ensureSidesRepaired(data);
            // Folder files always carry inline photo bytes (see save()
            // above) — pull them into this browser's own photo store.
            await ensurePhotosMigrated(data);
            if (!existing) {
              state.maps.push(data);
              await DB.put(data);
            } else {
              Object.assign(existing, data);
              await DB.put(existing);
            }
            this.lastFile[data.id] = name;
          } catch (e) { /* skip unreadable/unrelated file */ }
        }
        sortMaps(state.maps);
      } catch (e) { console.error("Folder sync failed", e); }
    }
  };

  function updateFolderUI() {
    const btn = $("#btn-connect-folder");
    const status = $("#folder-status");
    if (!btn || !status) return;
    if (!FolderDB.supported) {
      status.textContent = "Folder sync isn't supported in this browser";
      btn.textContent = "Connect folder";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if (FolderDB.dir && !FolderDB.needsPermission) {
      status.textContent = `Database folder: ${FolderDB.dir.name}`;
      btn.textContent = "Change";
    } else if (FolderDB.dir && FolderDB.needsPermission) {
      status.textContent = "Folder connected — click to allow access";
      btn.textContent = "Allow access";
    } else {
      status.textContent = "Saving to browser storage only";
      btn.textContent = "Connect folder";
    }
  }

