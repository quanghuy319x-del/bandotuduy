/* ============================================================
   Branchline — offline mind map app
   Single-file app logic. No external dependencies, no network.
   Storage: IndexedDB (persistent, per-browser-profile "database").
   ============================================================ */

(function () {
  "use strict";

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
  const DB_VERSION = 2;
  const STORE = "mindmaps";
  const HANDLE_STORE = "handles";
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
        await w.write(JSON.stringify(map, null, 2));
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
            ensureTheme(data);
            ensureLayout(data);
            ensureFavorite(data);
            ensureSidesRepaired(data);
            const existing = state.maps.find(m => m.id === data.id);
            if (!existing) {
              state.maps.push(data);
              await DB.put(data);
            } else if ((data.updatedAt || 0) > (existing.updatedAt || 0)) {
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

  /* ---------------- Google Drive sync ----------------
     Mirrors every map to Google Drive as its own .json file, the same way
     FolderDB mirrors to a local folder — same merge-by-updatedAt policy,
     just a different backend. This is what actually gets your maps from
     one device/browser to another (a local "Connect folder" only syncs
     devices that share a filesystem, e.g. via Dropbox/iCloud).

     REQUIRES a Google Cloud OAuth Client ID pasted into GOOGLE_CLIENT_ID
     below — see the "Google Drive sync setup" section of the README for
     how to get one. Without it, the sign-in button just explains that. */
  const GOOGLE_CLIENT_ID = "270018625814-4jfdor9fci625de9b4j7hjta15urcqoe.apps.googleusercontent.com";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_SIGNED_IN_KEY = "driveWasSignedIn";
  const DRIVE_TOKEN_CACHE_KEY = "branchline_drive_token";

  // Translates the handful of error codes GIS's error_callback actually
  // sends into something a person can act on, instead of a bare code like
  // "popup_failed_to_open".
  function describeGisError(err) {
    const code = (err && err.type) || String(err || "");
    if (code === "popup_failed_to_open") return "Google's sign-in popup was blocked by the browser. Allow popups for this page and try again.";
    if (code === "popup_closed") return "The Google sign-in popup was closed before finishing.";
    return "Google sign-in failed (" + code + "). This often means this page's exact origin isn't listed under \"Authorized JavaScript origins\" for this OAuth client in Google Cloud Console.";
  }

  // The access token itself is cached in localStorage (not just in memory)
  // so an F5 reload can reuse it directly — no Google round-trip, no
  // popup — for as long as it's still valid (Google issues these with
  // roughly a 1-hour lifetime; there's no way to get a longer-lived one
  // without a backend server, which this app deliberately doesn't have).
  function saveCachedDriveToken(token, expiresAt) {
    try { localStorage.setItem(DRIVE_TOKEN_CACHE_KEY, JSON.stringify({ token, expiresAt })); } catch (e) {}
  }
  function loadCachedDriveToken() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DRIVE_TOKEN_CACHE_KEY) || "null");
      if (parsed && parsed.token && parsed.expiresAt > Date.now() + 60000) return parsed;
    } catch (e) {}
    return null;
  }
  function clearCachedDriveToken() {
    try { localStorage.removeItem(DRIVE_TOKEN_CACHE_KEY); } catch (e) {}
  }

  const DriveDB = {
    tokenClient: null,
    accessToken: null,
    tokenExpiresAt: 0,
    signedIn: false,
    syncing: false,
    refreshTimer: null,
    // map id -> { fileId, updatedAt } for every map we know is mirrored to
    // Drive, so save/remove don't have to search every time.
    fileIndex: {},

    configured() {
      return !!GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith("PASTE_");
    },

    // Keeps you signed in for as long as Google will allow without ever
    // needing another click on "Sign in with Google" — refreshes the
    // access token silently in the background, well before it actually
    // expires. This is deliberately NOT tied to the Drive-sync poll
    // (which only runs while the tab is visible, to save API quota) or
    // to any user action — it runs on its own timer so a session stays
    // alive even while the tab sits in the background or idle.
    //
    // The ceiling on "as long as possible" is set by Google, not by this
    // app: a pure client-side app like this only ever gets short-lived
    // (~1hr) access tokens, never a long-lived refresh token (that
    // requires a backend to hold it securely). So this refreshes on a
    // rolling basis for as long as it keeps succeeding — which in
    // practice can be indefinitely, for as long as the browser still
    // allows Google's silent background sign-in check to go through —
    // and only actually ends the session on an explicit "Sign out" or a
    // refresh that Google itself has started rejecting.
    scheduleRefresh() {
      if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
      if (!this.signedIn) return;
      // Refresh 5 minutes before the current token expires (or almost
      // immediately if it's already past that point) — never less than a
      // few seconds out, so a failing refresh can't spin in a tight loop.
      const delay = Math.max(5000, this.tokenExpiresAt - Date.now() - 5 * 60 * 1000);
      this.refreshTimer = setTimeout(async () => {
        try {
          await this.requestToken(true);
          this.scheduleRefresh(); // got a fresh token — line up the next one
        } catch (e) {
          console.error("Background Drive token refresh failed, will retry", e);
          // A transient network hiccup or a momentarily-blocked silent
          // check shouldn't end the session early — keep trying rather
          // than giving up after one failure.
          this.refreshTimer = setTimeout(() => this.scheduleRefresh(), 2 * 60 * 1000);
        }
      }, delay);
    },

    // On page load: reuse a still-valid cached token with no network
    // round-trip at all if we have one (the common case for an F5 within
    // the same hour); otherwise fall back to a silent (no popup) Google
    // re-auth attempt, but only if we'd signed in successfully before —
    // so a person who's never connected Drive never sees a Google popup
    // flash by uninvited. That silent fallback isn't 100% guaranteed by
    // every browser (some block the background auth check as a
    // third-party cookie), so an occasional real "Sign in with Google"
    // click is still possible once the cached token itself expires.
    async restore() {
      if (!this.configured()) return;
      const cached = loadCachedDriveToken();
      if (cached) {
        this.accessToken = cached.token;
        this.tokenExpiresAt = cached.expiresAt;
        this.signedIn = true;
        updateDriveUI("Syncing…");
        try {
          await this.syncFromDrive();
          for (const m of state.maps) if (!this.fileIndex[m.id]) await this.save(m);
          renderSidebar();
          updateDriveUI();
          startDriveSyncPolling();
          this.scheduleRefresh();
          return;
        } catch (e) {
          console.error("Cached Drive token didn't work, falling back", e);
          this.accessToken = null;
          this.signedIn = false;
          clearCachedDriveToken();
          // fall through to the silent-reauth attempt below
        }
      }
      let was = false;
      try { was = await DB.getHandle(DRIVE_SIGNED_IN_KEY); } catch (e) {}
      if (!was) return;
      try { await this.signIn(true); } catch (e) { /* silent attempt only — fail quietly */ }
    },

    ensureTokenClient() {
      if (this.tokenClient) return true;
      if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: () => {}, // overridden per-call, see requestToken()
        error_callback: (err) => {
          // Fires for things that never reach the callback above at all —
          // a popup Google/the browser blocked or the user closed, or (the
          // most common silent-failure case) this page's origin isn't in
          // the OAuth client's "Authorized JavaScript origins" list in
          // Google Cloud Console. Routed to whichever promise is currently
          // waiting in requestToken() below.
          if (this._pendingReject) this._pendingReject(
            new Error(describeGisError(err))
          );
        },
      });
      return true;
    },

    requestToken(silent) {
      // Google Identity Services simply does not work when the page is
      // opened as a local file (origin "null" / file://) — there is no
      // way to authorize that as a JS origin in Google Cloud Console, and
      // GIS fails silently rather than raising an error: no popup, no
      // callback, no exception. Catch that up front with a clear message
      // instead of leaving the button looking like it did nothing.
      if (location.protocol === "file:") {
        return Promise.reject(new Error(
          "Google sign-in can't run from a file opened directly (file://). " +
          "Serve this folder over http/https instead — e.g. run a local " +
          "server and open http://localhost, or host it (GitHub Pages, " +
          "etc.), and make sure that exact origin is added under " +
          "\"Authorized JavaScript origins\" for this OAuth client."
        ));
      }
      return new Promise((resolve, reject) => {
        if (!this.ensureTokenClient()) { reject(new Error("Google sign-in script hasn't loaded yet — try again in a second, or check your connection.")); return; }
        // Watchdog: if neither the success callback nor error_callback
        // ever fires (seen in some browsers when the popup is blocked
        // without triggering GIS's own popup_failed_to_open error), don't
        // leave the button hung forever with no feedback.
        const timeoutId = setTimeout(() => {
          this._pendingReject = null;
          reject(new Error("Google sign-in didn't respond after 15 seconds — it may have been blocked by a popup blocker, or this page's origin isn't authorized for this OAuth client yet. Check the browser console for details."));
        }, 15000);
        const settle = (fn, arg) => { clearTimeout(timeoutId); this._pendingReject = null; fn(arg); };
        this._pendingReject = (err) => settle(reject, err);
        this.tokenClient.callback = (resp) => {
          if (resp && resp.access_token) {
            this.accessToken = resp.access_token;
            this.tokenExpiresAt = Date.now() + ((resp.expires_in || 3300) * 1000);
            saveCachedDriveToken(this.accessToken, this.tokenExpiresAt);
            settle(resolve, resp.access_token);
          } else {
            settle(reject, resp && resp.error ? new Error(resp.error) : new Error("Sign-in didn't return a token"));
          }
        };
        this.tokenClient.requestAccessToken({ prompt: silent ? "none" : "consent" });
      });
    },

    async getToken() {
      if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) return this.accessToken;
      return this.requestToken(true); // token expired mid-session — refresh silently
    },

    // Thin wrapper around fetch that attaches the bearer token and retries
    // once (with a forced fresh token) on a 401, since a token can expire
    // between getToken() returning it and the request actually landing.
    async api(url, opts, _retried) {
      const token = await this.getToken();
      const res = await fetch(url, {
        ...opts,
        headers: { ...(opts && opts.headers), Authorization: `Bearer ${token}` }
      });
      if (res.status === 401 && !_retried) {
        this.accessToken = null;
        return this.api(url, opts, true);
      }
      return res;
    },

    async signIn(silent) {
      if (!this.configured()) {
        alert("Google Drive sync needs to be set up first — a developer needs to add a Google OAuth Client ID to the app (see the README's \"Google Drive sync setup\" section).");
        return;
      }
      await this.requestToken(!!silent);
      this.signedIn = true;
      try { await DB.setHandle(DRIVE_SIGNED_IN_KEY, true); } catch (e) {}
      updateDriveUI("Syncing…");
      try {
        await this.syncFromDrive();
        for (const m of state.maps) if (!this.fileIndex[m.id]) await this.save(m);
      } catch (e) {
        console.error("Drive sync failed", e);
        if (!silent) alert("Signed in, but syncing with Drive failed: " + (e.message || e) + "\n\nYour maps are still safe locally — try signing in again, or check the browser console for details.");
      }
      renderSidebar();
      updateDriveUI();
      startDriveSyncPolling();
      this.scheduleRefresh();
    },

    signOut() {
      if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
      // Deliberately NOT calling google.accounts.oauth2.revoke() here.
      // revoke() doesn't just drop this browser's token — it revokes the
      // whole OAuth consent grant for this Google account + this app's
      // client ID, which invalidates every other device/browser's access
      // token issued under that same grant too. That made "Sign out" on
      // one device silently sign out every other device the next time it
      // tried to refresh/poll. A plain local sign-out (forget the token
      // here, let it expire naturally on Google's side within the hour)
      // keeps other devices' sessions untouched.
      this.accessToken = null;
      this.signedIn = false;
      this.fileIndex = {};
      DB.setHandle(DRIVE_SIGNED_IN_KEY, false).catch(() => {});
      clearCachedDriveToken();
      updateDriveUI();
      stopDriveSyncPolling();
    },

    // Lists every Drive file this app has access to (drive.file scope
    // limits that to files the app itself created), along with the
    // metadata we tagged them with — cheap compared to downloading every
    // file's content just to check whether it changed.
    async listRemote() {
      // Drive's query language needs a specific value inside `has {}` for
      // property filters — there's no documented "key exists, any value"
      // form — so rather than fight that, just list every non-trashed
      // file the app can see (drive.file scope already restricts that to
      // files this app itself created) and filter for our tag afterward.
      const fields = encodeURIComponent("files(id,name,appProperties)");
      const q = encodeURIComponent("trashed=false");
      const res = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&spaces=drive&pageSize=1000`);
      if (!res.ok) throw new Error("Couldn't list Drive files (" + res.status + ")");
      const data = await res.json();
      return (data.files || []).filter(f => f.appProperties && f.appProperties.branchlineId);
    },

    async downloadFile(fileId) {
      const res = await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      if (!res.ok) throw new Error("Couldn't download a map from Drive (" + res.status + ")");
      return res.json();
    },

    filenameFor(map) {
      const safe = (map.title || "untitled").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40) || "untitled";
      return `${safe}-${map.id}.json`;
    },

    // Both create and update go through Drive's *resumable* upload
    // protocol rather than the simpler one-shot "multipart" upload used
    // before — multipart is capped at 5MB per request, which a mindmap
    // full of full-resolution photos can easily exceed. Resumable upload
    // has no such cap: it's a two-step handshake (ask Drive for a
    // one-time upload URL, then PUT the actual content to it) that also
    // sets the metadata (name, appProperties) and content together in one
    // session, so the two can't end up out of sync the way two separate
    // PATCHes could.
    async startResumableSession(url, method, metadata) {
      const res = await this.api(url, {
        method,
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(metadata)
      });
      if (!res.ok) throw new Error("Couldn't start a Drive upload (" + res.status + ")");
      const uploadUrl = res.headers.get("Location");
      if (!uploadUrl) throw new Error("Drive didn't return an upload session URL");
      return uploadUrl;
    },

    async createFile(map) {
      const metadata = { name: this.filenameFor(map), appProperties: { branchlineId: map.id, updatedAt: String(map.updatedAt || 0) } };
      const uploadUrl = await this.startResumableSession(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", "POST", metadata
      );
      const putRes = await this.api(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(map)
      });
      if (!putRes.ok) throw new Error("Couldn't upload a map to Drive (" + putRes.status + ")");
      const data = await putRes.json();
      return data.id;
    },

    async updateFile(fileId, map) {
      const metadata = { name: this.filenameFor(map), appProperties: { branchlineId: map.id, updatedAt: String(map.updatedAt || 0) } };
      const uploadUrl = await this.startResumableSession(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`, "PATCH", metadata
      );
      const putRes = await this.api(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(map)
      });
      if (!putRes.ok) throw new Error("Couldn't update a map on Drive (" + putRes.status + ")");
    },

    async save(map) {
      if (!this.signedIn || !map) return;
      try {
        const known = this.fileIndex[map.id];
        if (known) {
          await this.updateFile(known.fileId, map);
          known.updatedAt = map.updatedAt;
        } else {
          const fileId = await this.createFile(map);
          this.fileIndex[map.id] = { fileId, updatedAt: map.updatedAt };
        }
      } catch (e) { console.error("Drive save failed", e); }
    },

    async remove(map) {
      if (!this.signedIn || !map) return;
      const known = this.fileIndex[map.id];
      if (!known) return;
      try {
        await this.api(`https://www.googleapis.com/drive/v3/files/${known.fileId}`, { method: "DELETE" });
      } catch (e) { /* best-effort */ }
      delete this.fileIndex[map.id];
    },

    // Pulls in anything new/changed from Drive, same merge rule as
    // FolderDB: newer `updatedAt` wins, and a map neither side has ever
    // seen just gets added. Only actually downloads a file's content when
    // its tagged updatedAt looks newer than what we already have.
    //
    // Also mirrors deletions: if a map this device previously knew was on
    // Drive (it's in fileIndex from an earlier sync) has since vanished
    // from the Drive listing, that means it was deleted on another
    // device — so it's deleted here too, the same way a local delete
    // removes it. A map that's only ever existed locally (never made it
    // into fileIndex yet) is never touched by this — only maps we'd
    // already confirmed were on Drive.
    async syncFromDrive() {
      const remoteFiles = await this.listRemote();
      const previouslyKnownIds = new Set(Object.keys(this.fileIndex));
      const seenRemoteIds = new Set();
      for (const f of remoteFiles) {
        const id = f.appProperties && f.appProperties.branchlineId;
        if (!id) continue;
        seenRemoteIds.add(id);
        const remoteUpdatedAt = Number((f.appProperties && f.appProperties.updatedAt) || 0);
        this.fileIndex[id] = { fileId: f.id, updatedAt: remoteUpdatedAt };
        const existing = state.maps.find(m => m.id === id);
        if (existing && (existing.updatedAt || 0) >= remoteUpdatedAt) continue; // ours is already current
        try {
          const data = await this.downloadFile(f.id);
          if (!data || !data.id || !data.root) continue;
          ensureTheme(data);
          ensureLayout(data);
          ensureFavorite(data);
          ensureSidesRepaired(data);
          if (existing) {
            Object.assign(existing, data);
            await DB.put(existing);
          } else {
            state.maps.push(data);
            await DB.put(data);
          }
        } catch (e) { console.error("Drive download failed for one map", e); }
      }
      for (const id of previouslyKnownIds) {
        if (seenRemoteIds.has(id)) continue;
        delete this.fileIndex[id];
        const existing = state.maps.find(m => m.id === id);
        if (!existing) continue; // already gone locally too, nothing to do
        await DB.delete(id);
        await FolderDB.remove(existing);
        state.maps = state.maps.filter(m => m.id !== id);
        if (state.current && state.current.id === id) {
          state.current = null;
          if (state.maps.length) await openMap(state.maps[0].id);
          else clearCanvas();
        }
      }
      sortMaps(state.maps);
    }
  };

  function updateDriveUI(overrideStatus) {
    const status = $("#drive-status");
    const btn = $("#btn-google-signin");
    if (!status || !btn) return;
    if (overrideStatus) { status.textContent = overrideStatus; return; }
    if (DriveDB.signedIn) {
      status.textContent = "Synced to Google Drive";
      btn.textContent = "Sign out";
    } else {
      status.textContent = "Not synced to Google Drive";
      btn.textContent = "Sign in with Google";
    }
  }

  // Signing in only syncs once, at that moment — without this, a change
  // made on another device wouldn't show up here until you next reload
  // (or manually sign in again). Polls every 1s while the tab is
  // actually visible (skipped in background tabs to save battery/quota —
  // Drive's API quota is generous enough that 1s is fine while visible),
  // plus once immediately whenever you switch back to this tab.
  let driveSyncTimer = null;
  function startDriveSyncPolling() {
    stopDriveSyncPolling();
    driveSyncTimer = setInterval(pollDriveUpdates, 1000);
  }
  function stopDriveSyncPolling() {
    if (driveSyncTimer) { clearInterval(driveSyncTimer); driveSyncTimer = null; }
  }
  async function pollDriveUpdates() {
    if (!DriveDB.signedIn || DriveDB.syncing) return;
    if (document.visibilityState !== "visible") return;
    // Don't touch the map tree while you're actively mid-keystroke in a
    // node's text — an incoming update would swap out the very node
    // object your editor box is still pointing at.
    if (state.editingId) return;
    DriveDB.syncing = true;
    try {
      await DriveDB.syncFromDrive();
      renderSidebar();
      renderAll();
    } catch (e) {
      console.error("Drive poll failed", e);
    }
    DriveDB.syncing = false;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pollDriveUpdates();
  });

  /* ---------------- data model ---------------- */

  function newNode(text) {
    // `side` starts unset on every node. For a direct child of the root in
    // Mindmap layout it gets assigned "left"/"right" automatically the
    // first time it's laid out as a top-level branch — see layoutMindmap —
    // and then stays put across reorders. Any node at any depth can also
    // pick up an explicit "left"/"right" override once the user drags it
    // across the center line: that override makes its whole subtree fan
    // out the same direction as it, instead of blindly following whichever
    // side its parent branch happens to be on — see place() / placeLocal()
    // and maybeFlipSideOnDrop().
    //
    // `xGap` starts unset too. It's the horizontal distance from this
    // node's own parent, overriding the normal depth-based default (wider
    // for the root's direct children, ROOT_X_GAP, then X_GAP for every hop
    // after that). Set by right-clicking the connector above this node —
    // see openConnectorContextMenu() — and, unlike `side`, it only ever
    // affects this one node's own distance from its parent; descendants
    // keep using their own default (or their own override) measured onward
    // from wherever this node ends up.
    //
    // `connectorStyle` is null to inherit the map-wide arrow default, or
    // an explicit "line" (force no arrowhead) or "arrow" (force an
    // arrowhead) that overrides it for just this hop.
    //
    // `connectorShape` works the same way for the line's routing: null
    // inherits the map-wide "curved"/"elbow" default, or an explicit
    // value overrides it for just this hop. Both are set from the
    // combined "Connector style" picker on the connector's own
    // right-click menu, or in bulk from a parent node's menu.
    return { id: uid(), text: text || "", children: [], collapsed: false, color: null, struck: false, note: "", notes: [], image: null, images: [], url: null, urls: [], side: null, xGap: null, connectorStyle: null, connectorShape: null };
  }

  // Nodes used to hold a single `image` data-URL; they now hold an `images`
  // array so multiple photos can be attached. This reads either shape so
  // maps saved before the change still work without a migration step.
  function getNodeImages(node) {
    if (!node) return [];
    if (Array.isArray(node.images) && node.images.length) return node.images;
    if (node.image) return [node.image];
    return [];
  }
  function nodeHasImages(node) {
    return getNodeImages(node).length > 0;
  }

  // On-canvas photo markers are tiny (9–18px), but a full photo is stored
  // at its original resolution (no downscaling) so the lightbox still
  // looks sharp — full quality, exactly as attached. Painting that
  // full-resolution bitmap as the background-image of a dozen little
  // thumbnails is what actually made the canvas heavy to composite once
  // a few photo-heavy nodes were on screen — every pan/drag frame has to
  // recomposite all of that
  // decoded pixel data even though only a handful of on-screen pixels are
  // ever visible. This cache holds a small, pre-cropped stand-in (keyed by
  // the full photo's own data URL, so it's computed once per photo and
  // reused everywhere that photo appears) built once and reused instead.
  // Sized for the worst case on-screen footprint of a "large" thumbnail
  // (18 CSS px) at max zoom (2.5x, see the zoom handlers) on a high-DPI
  // screen, with a little headroom — not a fixed guess — so photos stay
  // sharp all the way to full zoom instead of turning soft once the small
  // stand-in gets stretched past its own resolution.
  const THUMB_DISPLAY_PX = Math.round(clamp(18 * 2.5 * (window.devicePixelRatio || 1) * 1.15, 96, 240));
  const nodeThumbCache = new Map(); // full data URL -> small data URL
  const nodeThumbPending = new Set(); // full data URLs currently being downscaled
  function getMarkerThumb(fullDataUrl, onReady) {
    const cached = nodeThumbCache.get(fullDataUrl);
    if (cached) return cached;
    if (!nodeThumbPending.has(fullDataUrl)) {
      nodeThumbPending.add(fullDataUrl);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height) || 1;
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_DISPLAY_PX;
        canvas.height = THUMB_DISPLAY_PX;
        canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, THUMB_DISPLAY_PX, THUMB_DISPLAY_PX);
        nodeThumbCache.set(fullDataUrl, canvas.toDataURL("image/jpeg", 0.7));
        nodeThumbPending.delete(fullDataUrl);
        onReady();
      };
      img.onerror = () => { nodeThumbPending.delete(fullDataUrl); };
      img.src = fullDataUrl;
    }
    return null;
  }

  // Nodes used to hold a single freeform `note` string; they now hold a
  // `notes` array (each `{id, html}`) so more than one note can be
  // attached. This reads either shape so maps saved before the change
  // still work without a migration step.
  function getNodeNotes(node) {
    if (!node) return [];
    if (Array.isArray(node.notes) && node.notes.length) return node.notes;
    if (node.note && node.note.trim()) return [{ id: uid(), title: "", html: node.note }];
    return [];
  }
  function nodeHasNotes(node) {
    return getNodeNotes(node).length > 0;
  }

  // Short label for a note, for the menus below — its title if it has
  // one, otherwise a plain-text preview of the body.
  function notePreviewText(n) {
    const title = (n.title || "").trim();
    if (title) return title.length > 40 ? title.slice(0, 39) + "…" : title;
    const tmp = document.createElement("div");
    tmp.innerHTML = n.html || "";
    const text = (tmp.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return "(empty note)";
    return text.length > 40 ? text.slice(0, 39) + "…" : text;
  }

  // Right-click on a note marker — same shape as openUrlManageMenu: each
  // row opens that note in the editor, plus a ✕ to delete it on the spot
  // without opening the editor, and an entry to start a brand-new note.
  function openNoteManageMenu(nodeId, x, y) {
    const node = findNode(nodeId);
    if (!node) return;
    const notes = getNodeNotes(node);
    if (!notes.length) return;
    resetContextMenu();
    notes.forEach((n, i) => {
      const it = document.createElement("div");
      it.className = "ctx-item";
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.textContent = "📝 " + notePreviewText(n);
      labelSpan.addEventListener("click", () => { closeContextMenu(); openNoteModal(nodeId, i); });
      it.appendChild(labelSpan);
      const removeBtn = document.createElement("span");
      removeBtn.className = "ctx-item-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "Delete this note";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        const remaining = getNodeNotes(node).slice();
        remaining.splice(i, 1);
        node.notes = remaining;
        node.note = "";
        closeContextMenu();
        renderAll();
        persist();
      });
      it.appendChild(removeBtn);
      ctxMenu.appendChild(it);
    });
    const addIt = document.createElement("div");
    addIt.className = "ctx-item";
    addIt.textContent = "+ Add note…";
    addIt.addEventListener("click", () => { closeContextMenu(); openNoteModal(nodeId, notes.length); });
    ctxMenu.appendChild(addIt);
    positionContextMenu(x, y);
  }

  // Nodes used to hold a single `url` string; they now hold a `urls` array
  // so multiple links can be attached. This reads either shape so maps
  // saved before the change still work without a migration step.
  function getNodeUrls(node) {
    if (!node) return [];
    if (Array.isArray(node.urls) && node.urls.length) return node.urls;
    if (node.url) return [node.url];
    return [];
  }
  function nodeHasUrls(node) {
    return getNodeUrls(node).length > 0;
  }

  // Per-node checklist ("today's tasks"). Stored as node.tasks = [{id,
  // text, done}], separate from the freeform note so progress can be
  // computed and shown right on the node in the mindmap.
  function getNodeTasks(node) {
    return (node && Array.isArray(node.tasks)) ? node.tasks : [];
  }
  function nodeHasTasks(node) {
    return getNodeTasks(node).length > 0;
  }
  // Tasks carry a 0–3 "stars" priority level, used only for progress
  // weighting (see nodeTaskProgress) — it does not affect task order.
  // Also tolerates old maps saved before this existed, which only ever
  // had a boolean `starred` flag, treated as 1 star.
  function getTaskStars(t) {
    if (typeof t.stars === "number" && !Number.isNaN(t.stars)) return clamp(Math.round(t.stars), 0, 3);
    return t.starred ? 1 : 0;
  }
  function nodeTaskProgress(node) {
    const tasks = getNodeTasks(node);
    // Progress is subtask-based: a task with subtasks contributes their
    // done/total counts. A task with none of its own counts as a single
    // unit instead (done via its own checkbox), so plain tasks still
    // move the needle. Each star of priority multiplies the weight by 3
    // (0 stars = 1x, 1 star = 3x, 2 stars = 6x, 3 stars = 9x), so marking
    // (or completing subtasks of) a higher-starred task moves the node's
    // ring/bar further.
    let total = 0, done = 0;
    tasks.forEach((t) => {
      const stars = getTaskStars(t);
      const weight = stars > 0 ? stars * 3 : 1;
      const subs = getTaskSubtasks(t);
      if (subs.length) {
        total += subs.length * weight;
        done += subs.filter(s => s.done).length * weight;
      } else {
        total += weight;
        if (t.done) done += weight;
      }
    });
    return { done, total, pct: total ? done / total : 0 };
  }

  // Subtasks — a small checklist living on a single task, stored as
  // t.subtasks = [{id, text, done}]. Checking every subtask marks the
  // parent task done automatically, and toggling the parent's own
  // checkbox cascades to all of its subtasks — the same way nested
  // checklists behave in most task apps.
  function getTaskSubtasks(t) {
    return (t && Array.isArray(t.subtasks)) ? t.subtasks : [];
  }
  function taskSubtaskProgress(t) {
    const subs = getTaskSubtasks(t);
    const total = subs.length;
    const done = subs.filter(s => s.done).length;
    return { done, total, pct: total ? done / total : 0 };
  }
  // How "done" a single task is, as a 0–1 fraction: a task with subtasks
  // is as done as its subtasks are (partial credit counts), otherwise
  // it's a flat 1 or 0 from its own checkbox.
  function taskEffectiveDoneFraction(t) {
    const subs = getTaskSubtasks(t);
    if (subs.length) return subs.filter(s => s.done).length / subs.length;
    return t.done ? 1 : 0;
  }
  // Recomputes a task's own `done` from its subtasks (all done => task
  // done). No-op for tasks without any subtasks yet.
  function syncTaskDoneFromSubtasks(t) {
    const subs = getTaskSubtasks(t);
    if (subs.length) t.done = subs.every(s => s.done);
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
  function normalizeAffirmationText(s) {
    return (s || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
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

  // Native prompt for adding a new URL to a node — appends it to the
  // node's `urls` array. No custom modal needed for a single text field.
  function addNodeUrl(nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    const input = window.prompt("URL to add to this node:", "https://");
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    if (!trimmed) return;
    pushUndo();
    const urls = getNodeUrls(node).slice();
    urls.push(normalizeUrl(trimmed));
    node.urls = urls;
    node.url = null; // fully migrated onto the array field
    renderAll();
    persist();
  }

  // Native prompt for editing (or, if cleared, removing) one existing URL
  // by its index in the node's `urls` array.
  function editNodeUrl(nodeId, index) {
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node).slice();
    if (index < 0 || index >= urls.length) return;
    const input = window.prompt("Edit URL (clear to remove):", urls[index]);
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    pushUndo();
    if (trimmed) {
      urls[index] = normalizeUrl(trimmed);
    } else {
      urls.splice(index, 1);
    }
    node.urls = urls;
    node.url = null;
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
    urls.splice(index, 1);
    node.urls = urls;
    node.url = null;
    renderAll();
    persist();
  }

  // Small popup — reuses the shared ctx-menu element — listing every URL
  // attached to a node so the person can pick which one to open when
  // there's more than one.
  function openUrlMenu(nodeId, x, y) {
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node);
    if (!urls.length) return;
    resetContextMenu();
    urls.forEach((u) => {
      const it = document.createElement("div");
      it.className = "ctx-item";
      it.textContent = "🔗 " + shortenUrlForMenu(u);
      it.title = u;
      it.addEventListener("click", () => { closeContextMenu(); window.open(u, "_blank", "noopener"); });
      ctxMenu.appendChild(it);
    });
    positionContextMenu(x, y);
  }

  // Right-click on the 🔗 marker itself — same shape as openUrlMenu but
  // each row is editable and removable, since links no longer show up
  // in the node's own right-click menu (only here, at the marker).
  function openUrlManageMenu(nodeId, x, y) {
    const node = findNode(nodeId);
    if (!node) return;
    const urls = getNodeUrls(node);
    if (!urls.length) return;
    resetContextMenu();
    urls.forEach((u, i) => {
      const it = document.createElement("div");
      it.className = "ctx-item";
      it.title = u;
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.textContent = "🔗 " + shortenUrlForMenu(u);
      it.appendChild(labelSpan);
      const rm = document.createElement("span");
      rm.className = "ctx-item-remove";
      rm.textContent = "✕";
      rm.title = "Remove";
      rm.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); removeNodeUrl(nodeId, i); });
      it.appendChild(rm);
      it.addEventListener("click", () => { closeContextMenu(); editNodeUrl(nodeId, i); });
      ctxMenu.appendChild(it);
    });
    positionContextMenu(x, y);
  }

  function newMindMap(title) {
    const root = newNode(title || "Central idea");
    return {
      id: uid(),
      title: title || "Untitled map",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      favorite: false,
      root,
      links: [],   // cross-links: [{ id, a: nodeId, b: nodeId }] — connections that
                   // aren't part of the parent/child tree (e.g. "this idea relates to that one")
      view: { scale: 1, tx: 0, ty: 0 },
      theme: defaultTheme(),
      layout: "mindmap"   // "mindmap" | "logic" | "timeline"
    };
  }

  function ensureFavorite(map) {
    if (!map) return;
    if (typeof map.favorite !== "boolean") map.favorite = false;
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
    if (map.layout !== "logic" && map.layout !== "timeline") map.layout = "mindmap";
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

  function sampleMindMap() {
    const m = newMindMap("Welcome to Branchline");
    const c1 = newNode("Try Tab to add a child");
    const c2 = newNode("Try Enter to add a sibling");
    const c3 = newNode("Double-click to rename");
    const c4 = newNode("Right-click for more actions");
    const g1 = newNode("Deeper branches fade in style");
    c1.children.push(g1);
    m.root.children.push(c1, c2, c3, c4);
    return m;
  }

  /* ---------------- app state ---------------- */

  const state = {
    maps: [],
    current: null,       // full mindmap object
    selectedId: null,
    editingId: null,
    linkFromId: null,    // when set, we're in "pick the other end of a link" mode
    highlightId: null,   // when set, this node + its branch stay sharp and
                          // every other node/connector is blurred — a
                          // transient view setting, never persisted (see
                          // the `persist` function below, which only
                          // saves `state.current`)
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
  // right-click/long-press menu in the app). Routing that reset through
  // one helper means the drag handle (see initContextMenuDrag below) gets
  // re-inserted every time without having to touch each menu function
  // individually.
  function resetContextMenu() {
    ctxMenu.innerHTML = "";
    const handle = document.createElement("div");
    handle.className = "ctx-drag-handle";
    handle.title = "Drag to move";
    ctxMenu.appendChild(handle);
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

  /* ---------------- persistence flow ---------------- */

  async function loadAllMaps() {
    state.maps = await DB.getAll();
    state.maps.forEach(ensureFavorite);
    sortMaps(state.maps);
  }

  const persist = debounce(async () => {
    if (!state.current) return;
    saveStatus.textContent = "Saving…";
    saveStatus.className = "save-status saving";
    state.current.updatedAt = Date.now();
    state.current.view = { scale: state.scale, tx: state.tx, ty: state.ty };
    await DB.put(state.current);
    await FolderDB.save(state.current);
    await DriveDB.save(state.current);
    const idx = state.maps.findIndex(m => m.id === state.current.id);
    if (idx >= 0) state.maps[idx] = state.current; else state.maps.unshift(state.current);
    sortMaps(state.maps);
    renderSidebar();
    saveStatus.textContent = "Saved";
    saveStatus.className = "save-status saved";
  }, 500);

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

  function pushUndo() {
    if (!state.current) return;
    state.undoStack.push(JSON.stringify({ root: state.current.root, links: state.current.links || [] }));
    if (state.undoStack.length > 60) state.undoStack.shift();
    state.redoStack = [];
  }

  function undo() {
    if (!state.current || state.undoStack.length === 0) return;
    state.redoStack.push(JSON.stringify({ root: state.current.root, links: state.current.links || [] }));
    const snap = JSON.parse(state.undoStack.pop());
    state.current.root = snap.root;
    state.current.links = snap.links || [];
    state.selectedId = null;
    renderAll();
    persist();
  }

  function redo() {
    if (!state.current || state.redoStack.length === 0) return;
    state.undoStack.push(JSON.stringify({ root: state.current.root, links: state.current.links || [] }));
    const snap = JSON.parse(state.redoStack.pop());
    state.current.root = snap.root;
    state.current.links = snap.links || [];
    state.selectedId = null;
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
    undoBtn.disabled = !state.current || state.undoStack.length === 0;
    redoBtn.disabled = !state.current || state.redoStack.length === 0;
  }

  /* ---------------- sidebar ---------------- */

  function renderSidebar() {
    sortMaps(state.maps);
    listEl.innerHTML = "";
    if (state.maps.length === 0) {
      emptyState.classList.remove("hidden");
      nodeFabs.classList.add("hidden");
    } else {
      emptyState.classList.add("hidden");
      nodeFabs.classList.remove("hidden");
    }
    for (const m of state.maps) {
      const li = document.createElement("li");
      li.className = "map-item" + (state.current && m.id === state.current.id ? " active" : "");
      const star = document.createElement("span");
      star.className = "item-star" + (m.favorite ? " favorited" : "");
      star.textContent = m.favorite ? "★" : "☆";
      star.title = m.favorite ? "Remove from favorites" : "Add to favorites";
      star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(m.id); });
      const dot = document.createElement("span"); dot.className = "dot";
      const name = document.createElement("span"); name.className = "name"; name.textContent = m.title || "Untitled map";
      const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = relTime(m.updatedAt);
      const del = document.createElement("span"); del.className = "item-del"; del.textContent = "✕";
      del.title = "Delete map";
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteMap(m.id); });
      li.append(star, dot, name, meta, del);
      li.addEventListener("click", () => openMap(m.id));
      listEl.appendChild(li);
    }
  }

  // Favoriting doesn't go through the debounced `persist()` (that only ever
  // saves state.current) since you can star any map in the list, including
  // ones that aren't currently open — so it saves directly instead.
  async function toggleFavorite(id) {
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
    state.current = m;
    ensureTheme(state.current);
    ensureLinks(state.current);
    ensureLayout(state.current);
    ensureFavorite(state.current);
    ensureSidesRepaired(state.current);
    ensureAffirmationMigrated(state.current);
    state.selectedId = null;
    state.editingId = null;
    state.linkFromId = null;
    state.highlightId = null;
    state.undoStack = [];
    state.redoStack = [];
    const v = m.view || { scale: 1, tx: 60, ty: 60 };
    state.scale = v.scale || 1; state.tx = v.tx || 60; state.ty = v.ty || 60;
    titleInput.value = m.title || "";
    layoutSelect.value = state.current.layout || "mindmap";
    renderSidebar();
    renderAll();
    applyTransform();
    // Remembered across reloads so boot() can reopen whichever map you
    // were last looking at, rather than always the top of the sidebar
    // list (most recently *edited*, which isn't necessarily the same map).
    try { localStorage.setItem(LAST_OPENED_MAP_KEY, id); } catch (e) {}
  }

  async function createMap() {
    const m = newMindMap("Untitled map");
    state.maps.unshift(m);
    await DB.put(m);
    await openMap(m.id);
    titleInput.focus();
    titleInput.select();
  }

  async function deleteMap(id) {
    const m = state.maps.find(x => x.id === id);
    if (!m) return;
    if (!confirm(`Delete "${m.title || 'Untitled map'}"? This cannot be undone.`)) return;
    await DB.delete(id);
    await FolderDB.remove(m);
    await DriveDB.remove(m);
    state.maps = state.maps.filter(x => x.id !== id);
    if (state.current && state.current.id === id) {
      state.current = null;
      if (state.maps.length) await openMap(state.maps[0].id);
      else { clearCanvas(); renderSidebar(); }
    } else {
      renderSidebar();
    }
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

  /* ---------------- layout engine ---------------- */

  const TIMELINE_ROOT_GAP = 34;  // gap from root down to the first branch's row
  const TIMELINE_ROW_GAP = 20;   // gap between one branch's row and the next

  // Shared depth/size measuring pass, used by every layout mode.
  function measureTree(node, depth) {
    node._depth = depth;
    computeNodeBox(node);
    if (node.collapsed || !node.children || node.children.length === 0) return;
    for (const c of node.children) measureTree(c, depth + 1);
  }

  // Shared bounding-box pass (including any manual drag offsets), used by
  // every layout mode once node._x/_y have been assigned.
  function computeBBox(root) {
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    (function walk(n) {
      const w = n._w, h = n._h;
      const nx = nodeCenterX(n), ny = n._y + (n.oy || 0);
      minX = Math.min(minX, nx - w / 2);
      maxX = Math.max(maxX, nx + w / 2);
      minY = Math.min(minY, ny - h / 2);
      maxY = Math.max(maxY, ny + h / 2);
      if (!n.collapsed) (n.children || []).forEach(walk);
    })(root);
    return { minX, maxX, minY, maxY };
  }

  function layout(root) {
    const mode = (state.current && state.current.layout) || "mindmap";
    if (mode === "logic") layoutMindmap(root, false);
    else if (mode === "timeline") layoutTimeline(root);
    else layoutMindmap(root, true);
    // The layout passes above place every node at its automatic slot, then
    // manual drag offsets (ox/oy) are added on top at render time. Dragging
    // a node — or editing text so a box grows — can push it into a sibling
    // it wasn't overlapping before. Rather than only fixing that when the
    // user explicitly clicks "Auto-arrange" (which wipes every manual nudge
    // in the whole map), resolve any leftover overlaps here on every
    // render, so nodes never visually collide but manual positioning is
    // otherwise left alone.
    resolveOverlaps(root);
    return computeBBox(root);
  }

  // Nudges any two overlapping node boxes apart vertically (never
  // horizontally, so each node's depth column — and therefore the whole
  // branch/tree reading order — stays put) until nothing overlaps. Runs as
  // a handful of relaxation passes since separating one pair can introduce
  // a new overlap with a third node.
  function resolveOverlaps(root) {
    const nodes = [];
    // Track each node's parent (just for this pass) so we can tell ancestor
    // pairs apart from unrelated ones below, and so an overlap fix can carry
    // a node's whole subtree along with it instead of leaving children
    // behind at their old spot.
    const parentOf = new Map();
    (function collect(n, parent) {
      if (n !== root) nodes.push(n);
      if (parent) parentOf.set(n, parent);
      if (!n.collapsed) (n.children || []).forEach(c => collect(c, n));
    })(root, null);

    function isAncestor(a, b) {
      // true if `a` is an ancestor of `b` — an ancestor/descendant pair is
      // expected to sit close together (that's the whole point of the
      // connector between them) and pushing them apart would just detach
      // the child from its parent's column, so those pairs are skipped.
      let p = parentOf.get(b);
      while (p) {
        if (p === a) return true;
        p = parentOf.get(p);
      }
      return false;
    }

    // Moves a node AND everything under it by the same amount, so a node's
    // children stay put relative to their parent — i.e. each node's own
    // subtree keeps its internal vertical alignment — instead of the parent
    // drifting away from children left behind at their pre-push position
    // (which is what used to cause a moved branch's descendants to overlap
    // an unrelated neighboring branch).
    function shiftSubtree(n, dy) {
      n._y += dy;
      if (!n.collapsed) (n.children || []).forEach(c => shiftSubtree(c, dy));
    }

    const PAD = 10;
    const MAX_PASSES = 8;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          if (isAncestor(a, b) || isAncestor(b, a)) continue;
          const ax = nodeCenterX(a), ay = a._y + (a.oy || 0);
          const bx = nodeCenterX(b), by = b._y + (b.oy || 0);
          const overlapX = (a._w / 2 + b._w / 2 + PAD) - Math.abs(ax - bx);
          const overlapY = (a._h / 2 + b._h / 2 + PAD) - Math.abs(ay - by);
          if (overlapX > 0 && overlapY > 0) {
            moved = true;
            const push = overlapY / 2;
            if (ay <= by) { shiftSubtree(a, -push); shiftSubtree(b, push); }
            else { shiftSubtree(a, push); shiftSubtree(b, -push); }
          }
        }
      }
      if (!moved) break;
    }
  }

  // Classic radial mind map. With splitSides=true, top-level branches
  // alternate left/right of the root (the default "Mindmap" layout). With
  // splitSides=false, every branch fans out to the right only, stacked
  // top to bottom (the "Logic chart" layout).
  function layoutMindmap(root, splitSides) {
    const children = root.children || [];
    const right = [], left = [];
    if (splitSides) {
      // Each top-level branch keeps whatever side it was already assigned
      // (persisted on the node itself), so reordering siblings — or adding
      // a new one — never flips a side that wasn't the one actually being
      // dragged. Only a node that has never had a side (brand new, or from
      // a map saved before this existed) gets one now, balanced against
      // whatever's already assigned so a fresh map still fans out evenly.
      let rightCount = children.filter(c => c.side === "right").length;
      let leftCount = children.filter(c => c.side === "left").length;
      children.forEach(c => {
        if (c.side !== "left" && c.side !== "right") {
          if (leftCount < rightCount) { c.side = "left"; leftCount++; }
          else { c.side = "right"; rightCount++; }
        }
      });
      children.forEach(c => (c.side === "left" ? left : right).push(c));
    } else {
      children.forEach(c => right.push(c));
    }

    root._x = 0; root._y = 0; root._depth = 0;
    computeNodeBox(root);

    // How much vertical room a node's whole subtree needs to stack without
    // overlapping ITSELF — its own height, or the combined height of its
    // children (with gaps) if that's bigger. This is computed bottom-up and
    // is purely local to the node: it has no idea what any other branch, or
    // any node at the "same level" elsewhere in the tree, looks like. That's
    // what let's place() below give every node a private slot sized to its
    // own subtree, so alignment only ever has to work *inside* that node —
    // an unrelated node at the same depth in a different branch never needs
    // to line up with it, and can't be pushed into it either.
    function subtreeExtent(node) {
      if (node.collapsed || !node.children || node.children.length === 0) {
        return (node._subtreeH = node._h || NODE_H);
      }
      let total = 0;
      node.children.forEach((c, i) => {
        total += subtreeExtent(c);
        if (i > 0) total += SLOT_GAP;
      });
      return (node._subtreeH = Math.max(node._h || NODE_H, total));
    }

    // Places a node at vertical center `y`, inside the slot [y -
    // node._subtreeH/2, y + node._subtreeH/2] already reserved for its
    // whole subtree by the caller. Children are stacked and centered
    // entirely within that local slot, so a node's own layout never
    // depends on, or disturbs, anything outside its own subtree.
    function place(node, depth, sign, y, parentOffset) {
      // A node normally just inherits the direction its ancestor branch is
      // already fanning (the `sign` handed down from the caller). But if
      // this particular node has its own explicit left/right override
      // (set when the user drags it across the center line — see
      // maybeFlipSideOnDrop), that wins instead, and everything under it
      // switches to fan the same way, regardless of which side its parent
      // is on.
      // Only a top-level branch (depth 1, i.e. a direct child of root) is
      // allowed to pick its own side — that's what makes each branch fan
      // one direction only. A deeper node can still end up with a leftover
      // .side (e.g. from being dragged across its branch's local spine
      // while in Timeline mode), but Mindmap mode must ignore that here,
      // or a single branch would fan both left and right at once.
      const nodeSign = (depth === 1 && (node.side === "left" || node.side === "right"))
        ? (node.side === "left" ? -1 : 1)
        : sign;
      // Distance out from the center builds up hop by hop from the parent's
      // own OUTER edge (not just its anchor point), so a wide parent node
      // — one whose text pushed its box wider than the default gap — still
      // leaves enough room before its child starts. A custom xGap on one
      // node (see gapFor) still shifts it and everything past it without
      // disturbing anything closer in; it's just measured from the actual
      // rendered edge now instead of a flat distance from the root.
      const offset = parentOffset + gapFor(node);
      node._x = nodeSign * offset;
      if (node.collapsed || !node.children || node.children.length === 0) {
        node._y = y;
        return;
      }
      let total = 0;
      node.children.forEach((c, i) => {
        total += c._subtreeH;
        if (i > 0) total += SLOT_GAP;
      });
      let cursor = y - total / 2;
      node.children.forEach(c => {
        const center = cursor + c._subtreeH / 2;
        place(c, depth + 1, nodeSign, center, offset + node._w);
        cursor += c._subtreeH + SLOT_GAP;
      });
      // center parent over its children
      const first = node.children[0]._y;
      const last = node.children[node.children.length - 1]._y;
      node._y = (first + last) / 2;
    }

    function layoutSide(list, sign) {
      if (list.length === 0) return;
      list.forEach(n => measureTree(n, 1));
      list.forEach(n => subtreeExtent(n));
      let total = 0;
      list.forEach((n, i) => {
        total += n._subtreeH;
        if (i > 0) total += SLOT_GAP;
      });
      let cursor = -total / 2;
      list.forEach(n => {
        const center = cursor + n._subtreeH / 2;
        // The root is centered on the spine (not anchored like everything
        // past it), so its "outer edge" toward this fan direction is half
        // its own width, not 0 — otherwise a wide root would suffer the
        // same too-close-to-its-child overlap that wide non-root nodes do.
        place(n, 1, sign, center, root._w / 2);
        cursor += n._subtreeH + SLOT_GAP;
      });
    }

    layoutSide(right, 1);
    layoutSide(left, -1);

    return computeBBox(root);
  }

  // Vertical "spine" layout: the root sits at the top with each top-level
  // branch stacked directly beneath it in turn. Each branch's own
  // descendants fan out sideways from that branch — splitting between
  // left and right (like a mini mind map hanging off the spine) rather
  // than being locked to a single side for the whole branch, so a branch
  // with a lot of children doesn't need to push way out to one side while
  // the other side sits empty.
  function layoutTimeline(root) {
    const children = root.children || [];
    root._x = 0; root._y = 0; root._depth = 0;
    measureTree(root, 0);

    // Pass 1: lay out each branch's own subtree in isolation, centered on
    // its own local y=0 (not yet placed on the spine), and record how
    // tall that centered subtree actually is. This has to happen before
    // any row is positioned, because — see pass 2 below — a row needs to
    // know the height of the row AFTER it, not just its own, to leave a
    // clean gap on both sides.
    const laidOut = children.map((branch) => {
      branch._x = 0; // always sits directly on the spine

      // Split this branch's own direct children left/right, exactly like
      // the Mindmap layout splits the root's children — each child keeps
      // whatever side it was already assigned (persisted on the node
      // itself via maybeFlipSideOnDrop), and only a side-less child (brand
      // new, or from a map saved before this existed) gets balanced onto
      // whichever side currently has fewer. Crucially, that auto-balance
      // is NOT written back onto c.side: .side is a shared field that
      // Mindmap mode's own place() also reads for every node (not just
      // root's direct children), so persisting an auto-assigned side here
      // would leak into Mindmap mode and make that same node split away
      // from its branch there too. Only a genuinely user-dragged side
      // (already present on the node) is meant to carry across layouts —
      // an auto-balanced one is scoped to this Timeline render only.
      const bChildren = branch.children || [];
      const right = [], left = [];
      if (bChildren.length) {
        let rightCount = bChildren.filter(c => c.side === "right").length;
        let leftCount = bChildren.filter(c => c.side === "left").length;
        bChildren.forEach(c => {
          if (c.side === "left") { left.push(c); return; }
          if (c.side === "right") { right.push(c); return; }
          if (leftCount < rightCount) { left.push(c); leftCount++; }
          else { right.push(c); rightCount++; }
        });
      }

      // Same local, bottom-up sizing idea as the Mindmap layout's
      // subtreeExtent(): how much vertical room a node's own subtree needs,
      // based only on itself and its own descendants — never on any other
      // branch or any node elsewhere at the "same level". That's what lets
      // each node's children be spaced purely relative to each other.
      function subtreeExtent(node) {
        if (node.collapsed || !node.children || node.children.length === 0) {
          return (node._subtreeH = node._h || NODE_H);
        }
        let total = 0;
        node.children.forEach((c, i) => {
          total += subtreeExtent(c);
          if (i > 0) total += SLOT_GAP;
        });
        return (node._subtreeH = Math.max(node._h || NODE_H, total));
      }

      // Same recursive placement as the Mindmap layout's place(): a node
      // normally inherits the direction its ancestor is already fanning,
      // but its own explicit side override (set by dragging it across the
      // spine) wins instead, and everything under it follows that instead.
      // `y` is the vertical center of the slot already reserved for this
      // node's whole subtree, so its children only ever need to fit inside
      // that local slot.
      function place(node, curSign, y, parentOffset) {
        const nodeSign = node.side === "left" ? -1 : node.side === "right" ? 1 : curSign;
        // Measured from the parent's own OUTER edge (not just its anchor
        // point), so a wide parent — one whose text pushed its box wider
        // than the default gap — still leaves enough room before its own
        // child starts, instead of the child's edge landing inside it.
        const offset = parentOffset + gapFor(node);
        node._x = nodeSign * offset;
        if (node.collapsed || !node.children || node.children.length === 0) {
          node._y = y;
          return;
        }
        let total = 0;
        node.children.forEach((c, i) => {
          total += c._subtreeH;
          if (i > 0) total += SLOT_GAP;
        });
        let cursor = y - total / 2;
        node.children.forEach(c => {
          const center = cursor + c._subtreeH / 2;
          place(c, nodeSign, center, offset + node._w);
          cursor += c._subtreeH + SLOT_GAP;
        });
        const first = node.children[0]._y;
        const last = node.children[node.children.length - 1]._y;
        node._y = (first + last) / 2;
      }

      // Lays out one side's subtree(s) stacked top-to-bottom and centered
      // on this branch's own local y=0 — same idea as the Mindmap layout's
      // layoutSide(), just scoped to one branch instead of the whole map.
      // Returns the side's total stacked height so the row height below can
      // be the TALLER of the two sides, not their sum.
      function layoutSide(list, sign) {
        if (list.length === 0) return 0;
        list.forEach(n => subtreeExtent(n));
        let total = 0;
        list.forEach((n, i) => {
          total += n._subtreeH;
          if (i > 0) total += SLOT_GAP;
        });
        let cursor = -total / 2;
        list.forEach(n => {
          const center = cursor + n._subtreeH / 2;
          // The branch itself sits centered on the spine (branch._x === 0,
          // same treatment as the root), so its outer edge toward this fan
          // direction is half its own width, not 0.
          place(n, sign, center, branch._w / 2);
          cursor += n._subtreeH + SLOT_GAP;
        });
        return total;
      }

      const rightHeight = layoutSide(right, 1);
      const leftHeight = layoutSide(left, -1);
      const localHeight = Math.max(branch._h || NODE_H, rightHeight, leftHeight);
      branch._y = 0; // both sides were just centered around this same baseline
      return { branch, localHeight };
    });

    // Pass 2: place each row along the spine. Two branches can have very
    // different heights (especially now that each one's own children can
    // split across both sides instead of piling onto a single side), so
    // spacing rows by "previous branch's height + gap" alone isn't
    // enough — a short branch followed by a tall one would let the tall
    // one's top half creep up into the short one's row. Advancing by
    // HALF the previous row's height plus HALF the next row's height
    // (plus the fixed gap) instead guarantees the same clean gap between
    // every pair of rows regardless of how lopsided their heights are —
    // which is what keeps different branches' node boxes, and the
    // connector curves fanning off them, from ever overlapping.
    let spineCursor = (root._h || ROOT_H) / 2 + TIMELINE_ROOT_GAP + (laidOut.length ? laidOut[0].localHeight / 2 : 0);
    laidOut.forEach(({ branch, localHeight }, i) => {
      if (i > 0) {
        spineCursor += laidOut[i - 1].localHeight / 2 + TIMELINE_ROW_GAP + localHeight / 2;
      }
      const offset = spineCursor;
      (function shift(n) {
        n._y += offset;
        if (!n.collapsed) (n.children || []).forEach(shift);
      })(branch);
    });

    return computeBBox(root);
  }

  /* ---------------- text measuring / wrapping ---------------- */

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");

  function measureW(text) { return measureCtx.measureText(text).width; }

  function breakLongWord(word, maxW) {
    const parts = [];
    let cur = "";
    for (const ch of word) {
      const t = cur + ch;
      if (cur && measureW(t) > maxW) { parts.push(cur); cur = ch; }
      else cur = t;
    }
    if (cur) parts.push(cur);
    return parts;
  }

  function wrapParagraph(para, maxW) {
    if (!para) return [""];
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];
    const lines = [];
    let cur = "";
    for (const word of words) {
      if (measureW(word) > maxW) {
        if (cur) { lines.push(cur); cur = ""; }
        const chunks = breakLongWord(word, maxW);
        for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
        cur = chunks[chunks.length - 1] || "";
        continue;
      }
      const test = cur ? cur + " " + word : word;
      if (measureW(test) <= maxW) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  function wrapText(text, maxW) {
    const paras = (text || "").split(/\n/);
    let lines = [];
    for (const p of paras) lines = lines.concat(wrapParagraph(p, maxW));
    return lines.length ? lines : [""];
  }

  // Computes and caches this node's rendered box size (node._w / node._h)
  // based on its current text, so long text wraps and grows the node
  // instead of being clipped or overflowing it.
  function computeNodeBox(node) {
    const depth = node._depth || 0;
    const fontWeight = depth === 0 ? 800 : depth === 1 ? 600 : depth === 2 ? 500 : 400;
    const fontSize = depth === 0 ? 21 : depth === 3 ? 12.5 : 13.5;
    measureCtx.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Helvetica, Arial, sans-serif`;
    const text = node.text || "(untitled)";
    const padX = depth === 0 ? 56 : 32;
    // Small safety buffer so a slight mismatch between canvas-measured width
    // and actual rendered width never causes the CSS wrap to break a word
    // mid-letter (e.g. "Risk" -> "Ris"/"k").
    const SAFETY = 6;
    const maxBoxW = depth === 0 ? 340 : 230;
    const maxTextW = maxBoxW - padX;
    const minW = depth === 0 ? 130 : 56;

    const oneLineW = Math.ceil(measureW(text)) + padX + SAFETY;
    let w, lines;
    if (oneLineW <= maxBoxW && !/\n/.test(text)) {
      w = clamp(oneLineW, minW, maxBoxW);
      lines = [text];
    } else {
      lines = wrapText(text, maxTextW);
      const widest = Math.max(...lines.map(l => measureW(l)));
      w = clamp(Math.ceil(widest) + padX + SAFETY, minW, maxBoxW);
    }

    const lineHeight = depth === 0 ? 24 : depth === 3 ? 16 : 17;
    const vPad = depth === 0 ? 28 : 16;
    const baseH = depth === 0 ? ROOT_H : NODE_H;
    const h = Math.max(baseH, Math.ceil(lines.length * lineHeight + vPad));

    // Reserve room inside the box for the combined note/link/photo strip,
    // which renders in normal flow below the text (see renderNode) instead
    // of floating outside the frame or overlapping the label. Matches the
    // sizing renderNode/CSS actually use so the box always fully encloses it.
    const nodeImages = getNodeImages(node);
    const stripIconCountForBox = getNodeNotes(node).length + (getNodeUrls(node).length ? 1 : 0) + (nodeAffirmationWins(node) ? 1 : 0);
    let stripW = 0, stripH = 0;
    if (stripIconCountForBox || nodeImages.length) {
      // Past 10 photos, collapse down to a single cover thumbnail with a
      // count badge (see renderNode) instead of a wall of thumbnails, so
      // a node with dozens of photos still reads as one compact cell.
      const overflow = nodeImages.length > 10;
      const shownCount = overflow ? 1 : nodeImages.length;
      const itemCount = stripIconCountForBox + shownCount;
      const large = itemCount < 6;
      const thumb = large ? 18 : 9;
      const gap = large ? 3 : 2;
      const cols = Math.min(itemCount, 5);
      const rows = Math.ceil(itemCount / 5);
      stripW = cols * thumb + (cols - 1) * gap;
      stripH = 5 /* margin-top */ + rows * thumb + (rows - 1) * gap;
    }

    // Reserve room for the task-progress bar + percentage label, which
    // render in normal flow below the text/photos (see renderNode) so the
    // box always fully encloses them instead of floating over the label.
    // A minimum width is enforced too, so the bar+label row always has
    // enough room to sit comfortably even on a short one-word node.
    const taskProgForBox = nodeTaskProgress(node);
    let barH = 0, barMinW = 0;
    if (taskProgForBox.total) {
      barH = 6 /* margin-top */ + 8 /* bar height */;
      barMinW = 56 /* track */ + 6 /* gap */ + 30 /* "100%" label */ + padX;
    }

    node._w = Math.max(w, stripW + padX, barMinW);
    node._h = h + stripH + barH;
    node._lines = lines;
    return { w: node._w, h: node._h };
  }

  // A node's box is anchored on its `_x` layout position rather than
  // centered on it: nodes fanning right keep their LEFT edge fixed at
  // `_x` and grow rightward as their text does, nodes fanning left keep
  // their RIGHT edge fixed and grow leftward, and the root (which has no
  // single direction) stays centered as before. This is what makes every
  // sibling at a given depth/side line up on the same vertical edge no
  // matter how long each one's own text is, since `_x` (before any manual
  // drag offset) is identical across siblings by default.
  function nodeLeftX(node) {
    const base = node._x + (node.ox || 0);
    // Depth 0 (the root) and any node whose automatic `_x` is exactly 0
    // — e.g. a Timeline branch's own root, which sits centered on the
    // vertical spine rather than fanning left/right — stay centered like
    // before. Everything actually fanning out gets the anchored treatment.
    if (node._depth === 0 || node._x === 0) return base - node._w / 2;
    return node._x >= 0 ? base : base - node._w;
  }
  function nodeRightX(node) { return nodeLeftX(node) + node._w; }
  function nodeCenterX(node) { return nodeLeftX(node) + node._w / 2; }

  /* ---------------- branch color resolution ---------------- */

  function branchColorFor(root, node) {
    // find the top-level ancestor (depth 1) that node descends from
    if (node === root) return null;
    let color = null;
    (function find(n, top) {
      for (const c of n.children || []) {
        const t = top || c;
        if (c === node) { color = t.color; return; }
        find(c, t);
      }
    })(root, null);
    return color;
  }

  function assignBranchColors(root) {
    const children = root.children || [];
    // Colors are cached on each branch (c.color) so they stay stable across
    // re-renders/reorders. That caching is exactly why a naive `i %
    // PALETTE.length` goes wrong: once a branch is deleted or the list is
    // reordered, a *new* branch can land on the same index another branch
    // used earlier — and that other branch's cached color never moved, so
    // you'd get a repeat before all 10 palette colors were even used.
    // Instead, only fill in colors for branches that don't have one yet,
    // and actively skip whatever colors are already in use by siblings —
    // so every branch gets a distinct color until the palette itself runs
    // out (only then does it start repeating).
    const used = new Set(children.filter(c => c.color).map(c => c.color));
    let cursor = 0;
    children.forEach((c) => {
      if (c.color) return;
      let color = null;
      for (let k = 0; k < PALETTE.length; k++) {
        const candidate = PALETTE[(cursor + k) % PALETTE.length];
        if (!used.has(candidate)) { color = candidate; cursor = (cursor + k + 1) % PALETTE.length; break; }
      }
      if (!color) color = PALETTE[cursor % PALETTE.length]; // palette exhausted; a repeat is unavoidable
      c.color = color;
      used.add(color);
    });
  }

  /* ---------------- rendering ---------------- */

  function renderAll() {
    if (!state.current) { clearCanvas(); return; }
    updateUndoRedoButtons();
    emptyState.classList.add("hidden");
    nodeFabs.classList.remove("hidden");
    applyTheme();
    assignBranchColors(state.current.root);
    const bbox = layout(state.current.root);
    const pad = 140;
    const width = (bbox.maxX - bbox.minX) + pad * 2;
    const height = (bbox.maxY - bbox.minY) + pad * 2;
    const originX = -bbox.minX + pad;
    const originY = -bbox.minY + pad;
    state.originX = originX;
    state.originY = originY;

    worldEl.style.width = width + "px";
    worldEl.style.height = height + "px";
    svgEl.setAttribute("width", width);
    svgEl.setAttribute("height", height);
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

    nodesLayer.innerHTML = "";
    svgEl.innerHTML = svgDefs();

    const nodes = [];
    (function collect(n) { nodes.push(n); if (!n.collapsed) (n.children || []).forEach(collect); })(state.current.root);

    // lines first (under nodes)
    const layoutMode = state.current.layout || "mindmap";
    const branches = state.current.root.children || [];
    for (const n of nodes) {
      if (n.collapsed || !n.children || n.children.length === 0) continue;
      for (const c of n.children) {
        // In Timeline mode the root only visually connects to the first
        // branch; the rest chain branch-to-branch down the spine (drawn below).
        if (layoutMode === "timeline" && n === state.current.root) continue;
        drawConnector(n, c, originX, originY);
      }
    }
    if (layoutMode === "timeline" && branches.length) {
      drawConnector(state.current.root, branches[0], originX, originY, { orientation: "v" });
      for (let i = 0; i < branches.length - 1; i++) {
        drawConnector(branches[i], branches[i + 1], originX, originY, { orientation: "v", colorNode: branches[i + 1], depth: 1 });
      }
    }

    if (state.current.links && state.current.links.length) {
      const byId = new Map(nodes.map(n => [n.id, n]));
      for (const link of state.current.links) {
        const a = byId.get(link.a), b = byId.get(link.b);
        if (a && b) drawLink(a, b, originX, originY, link);
      }
    }

    for (const n of nodes) {
      renderNode(n, originX, originY);
    }

    if (state.linkFromId) {
      const from = nodes.find(n => n.id === state.linkFromId);
      if (from) {
        const div = nodesLayer.querySelector(`.node[data-id="${from.id}"]`);
        if (div) div.classList.add("link-source");
      } else {
        state.linkFromId = null;
      }
    }

    titleInput.value = state.current.title || "";
    updateLinkHint();
    applyHighlight();
  }

  // Blurs every node/connector except a chosen node and its whole branch
  // (descendants), so that part of the map stands out against everything
  // else. Re-applied at the end of every renderAll() since that rebuilds
  // nodesLayer/svgEl from scratch and would otherwise drop the classes.
  function applyHighlight() {
    nodesLayer.querySelectorAll(".node").forEach(div => div.classList.remove("highlight-dim", "highlight-focus"));
    svgEl.querySelectorAll(".connector").forEach(g => g.classList.remove("highlight-dim", "highlight-focus"));
    const activeId = state.highlightId;
    if (!activeId) return;
    const node = findNode(activeId);
    if (!node) { state.highlightId = null; return; }
    const ids = new Set();
    (function collect(n) { ids.add(n.id); (n.children || []).forEach(collect); })(node);
    nodesLayer.querySelectorAll(".node").forEach(div => {
      div.classList.add(ids.has(div.dataset.id) ? "highlight-focus" : "highlight-dim");
    });
    svgEl.querySelectorAll(".connector").forEach(g => {
      const inBranch = ids.has(g.dataset.parent) && ids.has(g.dataset.child);
      g.classList.add(inBranch ? "highlight-focus" : "highlight-dim");
    });
  }

  function setHighlight(nodeId) {
    state.highlightId = (state.highlightId === nodeId) ? null : nodeId;
    applyHighlight();
  }
  function clearHighlight() {
    if (!state.highlightId) return;
    state.highlightId = null;
    applyHighlight();
  }

  // Cross-links connect two arbitrary nodes rather than a parent to its
  // child, so there's no fixed "side" to route from/to — instead we aim
  // each end at the edge of its node along the straight line between their
  // centers, then bow the middle out a bit so it reads as distinct from
  // the tree connectors underneath it.
  function linkPath(a, b, ox, oy) {
    const ax = ox + nodeCenterX(a), ay = oy + a._y + (a.oy || 0);
    const bx = ox + nodeCenterX(b), by = oy + b._y + (b.oy || 0);
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const edgeOffset = (n) => Math.abs(ux) > Math.abs(uy) ? (n._w / 2) : (n._h / 2);
    const x1 = ax + ux * edgeOffset(a), y1 = ay + uy * edgeOffset(a);
    const x2 = bx - ux * edgeOffset(b), y2 = by - uy * edgeOffset(b);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const bow = Math.min(36, dist * 0.18);
    const cx = mx + -uy * bow, cy = my + ux * bow;
    return `M ${x1} ${y1} Q ${cx} ${cy}, ${x2} ${y2}`;
  }

  function drawLink(a, b, ox, oy, link) {
    const path = linkPath(a, b, ox, oy);
    const bg = (state.current.theme && state.current.theme.background) || defaultBg();
    const color = "#e0b04a";

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "connector link-connector");
    g.dataset.link = link.id;

    const halo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    halo.setAttribute("d", path);
    halo.setAttribute("stroke", haloColorFor(bg));
    halo.setAttribute("stroke-width", "4.6");
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke-linecap", "round");
    g.appendChild(halo);

    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", path);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", "2");
    el.setAttribute("stroke-dasharray", "1, 7");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("fill", "none");
    el.setAttribute("opacity", "0.9");
    g.appendChild(el);

    g.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLinkContextMenu(e.clientX, e.clientY, link);
    });

    svgEl.appendChild(g);
  }

  function svgDefs() {
    return `<defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.2" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <marker id="connector-arrow" viewBox="0 0 10 10" refX="8" refY="5"
              markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/>
      </marker>
    </defs>`;
  }

  // Rounded right-angle ("elbow") connector: a horizontal run out of the
  // parent, a rounded corner, a vertical run, another rounded corner, then
  // a horizontal run into the child — the classic org-chart look. Falls
  // back to a plain straight segment if there isn't room for the bend.
  function roundedElbowPath(x1, y1, x2, y2, r) {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const mx = x1 + dx / 2;
    const rr = Math.min(r, Math.abs(dx) / 2, Math.abs(dy) / 2);
    const sx = dx >= 0 ? 1 : -1;
    const sy = dy >= 0 ? 1 : -1;
    return `M ${x1} ${y1} L ${mx - sx * rr} ${y1} Q ${mx} ${y1} ${mx} ${y1 + sy * rr} L ${mx} ${y2 - sy * rr} Q ${mx} ${y2} ${mx + sx * rr} ${y2} L ${x2} ${y2}`;
  }

  // Same "elbow" idea, but for vertically-stacked hops (Timeline layout's
  // spine) — the bend happens on a horizontal run at the vertical midpoint
  // instead of a vertical run at the horizontal midpoint.
  function roundedElbowPathVertical(x1, y1, x2, y2, r) {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const my = y1 + dy / 2;
    const rr = Math.min(r, Math.abs(dx) / 2, Math.abs(dy) / 2);
    const sx = dx >= 0 ? 1 : -1;
    const sy = dy >= 0 ? 1 : -1;
    return `M ${x1} ${y1} L ${x1} ${my - sy * rr} Q ${x1} ${my} ${x1 + sx * rr} ${my} L ${x2 - sx * rr} ${my} Q ${x2} ${my} ${x2} ${my + sy * rr} L ${x2} ${y2}`;
  }

  function connectorPath(parent, child, ox, oy) {
    const px = parent._x + (parent.ox || 0), py = parent._y + (parent.oy || 0);
    const cx = child._x + (child.ox || 0), cy = child._y + (child.oy || 0);
    const sign = cx >= px ? 1 : -1;
    // Route from whichever edge of the parent box faces the child to
    // whichever edge of the child box faces the parent — with the new
    // anchored (non-centered) boxes, the child's parent-facing edge sits
    // at its fixed `_x` position, so it lines up with every sibling at
    // the same depth regardless of how wide any of their text boxes are.
    const x1 = ox + (sign > 0 ? nodeRightX(parent) : nodeLeftX(parent));
    const y1 = oy + py;
    const x2 = ox + (sign > 0 ? nodeLeftX(child) : nodeRightX(child));
    const y2 = oy + cy;
    // Connector shape — "elbow" draws a rounded right-angle org-chart-style
    // path; anything else (including "curved" and legacy/unknown values)
    // falls back to the default S-curve below. A hop's own connectorShape
    // wins if set (from the combined "Connector style" picker); otherwise
    // it falls back to the map-wide default from the root node's menu.
    const shape = child.connectorShape || (state.current.theme && state.current.theme.connectorShape) || "curved";
    if (shape === "elbow") {
      return roundedElbowPath(x1, y1, x2, y2, 14);
    }
    const dx = (x2 - x1) * 0.55;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  // Same idea as connectorPath, but for nodes stacked vertically (the
  // root-to-first-branch and branch-to-branch spine links in the Timeline
  // layout) rather than side by side. The x coordinate deliberately
  // ignores each node's manual horizontal nudge (ox) — the spine is meant
  // to read as one continuous straight line down the middle of the map
  // regardless of how far any individual branch has been dragged
  // sideways, so only the node's automatic layout position (_x, which is
  // always 0 for the root/branches in Timeline mode) feeds the x here.
  function connectorPathVertical(parent, child, ox, oy) {
    const ph = parent._h, ch = child._h;
    const py = parent._y + (parent.oy || 0);
    const cy = child._y + (child.oy || 0);
    const sign = cy >= py ? 1 : -1;
    const y1 = oy + py + sign * (ph / 2);
    const x1 = ox + parent._x;
    const y2 = oy + cy - sign * (ch / 2);
    const x2 = ox + child._x;
    const shape = child.connectorShape || (state.current.theme && state.current.theme.connectorShape) || "curved";
    if (shape === "elbow") {
      return roundedElbowPathVertical(x1, y1, x2, y2, 14);
    }
    const dy = (y2 - y1) * 0.55;
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }

  function drawConnector(parent, child, ox, oy, opts) {
    opts = opts || {};
    const orientation = opts.orientation || "h";
    const path = orientation === "v"
      ? connectorPathVertical(parent, child, ox, oy)
      : connectorPath(parent, child, ox, oy);
    const theme = state.current.theme;
    const colorNode = opts.colorNode || child;
    const color = theme.connectorMode === "custom"
      ? theme.connectorColor
      : (colorNode.color || branchColorFor(state.current.root, colorNode) || "#5b6272");
    const depth = opts.depth != null ? opts.depth : child._depth;
    // Thickness steps down by level so the trunk clearly reads as more
    // important than a leaf twig — matches the box-styling tiers (pill,
    // solid box, outlined box, plain text). Level 3+ is dotted, so it gets
    // a noticeably thinner stroke than a solid line of the same "weight"
    // would need, since dots read as thin even at low width.
    const width = depth <= 1 ? 3 : depth === 2 ? 1.8 : 1.1;
    const bg = theme.background || defaultBg();

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "connector");
    g.dataset.parent = parent.id;
    g.dataset.child = child.id;
    g.dataset.orientation = orientation;

    // halo underneath, so the line always reads clearly against whatever
    // background color is chosen
    const halo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    halo.setAttribute("d", path);
    halo.setAttribute("stroke", haloColorFor(bg));
    // Dotted level's halo gets a smaller bump than solid lines, so the halo
    // dots don't balloon past the thin dots they're meant to frame.
    halo.setAttribute("stroke-width", depth >= 3 ? width + 0.9 : width + 1.8);
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke-linecap", "round");
    // Keep the halo dotted in lockstep with the main line at level 3+, so it
    // doesn't show through the gaps as a solid line underneath the dots.
    if (depth >= 3) halo.setAttribute("stroke-dasharray", `0.1, ${width * 2.6}`);
    g.appendChild(halo);

    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", path);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", width);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("opacity", depth <= 1 ? "0.95" : "1");
    if (depth === 1) el.setAttribute("filter", "url(#glow)");
    // From level 3 down, switch to a dotted line — reinforces that these
    // are the least important tier, on top of the thinner stroke.
    if (depth >= 3) el.setAttribute("stroke-dasharray", `0.1, ${width * 2.6}`);
    // "Arrow" connector style — set per-hop via the combined "Connector
    // style" picker (see openConnectorContextMenu), or inherited from the
    // map-wide default (root node's menu) when this hop has no override —
    // adds an arrowhead pointing from parent to child, colored to match
    // the line via context-stroke. An explicit "line" override always
    // wins over the map-wide default.
    const wantsArrow = child.connectorStyle === "arrow"
      || (!child.connectorStyle && !!(theme && theme.connectorArrow));
    if (orientation !== "v" && wantsArrow) {
      el.setAttribute("marker-end", "url(#connector-arrow)");
    }
    g.appendChild(el);

    // A real parent→child hop (as opposed to the "v" spine connectors
    // chaining sibling branches together in Timeline mode) has an actual
    // distance the user can customize — right-click it to open a small
    // input for that. A wide invisible stroke sits on top so thin (or
    // dotted, level-3+) lines are still easy to hover and right-click.
    if (orientation !== "v") {
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", path);
      hit.setAttribute("class", "connector-hit");
      hit.setAttribute("stroke", "#000");
      hit.setAttribute("stroke-width", Math.max(14, width + 12));
      hit.setAttribute("fill", "none");
      hit.setAttribute("opacity", "0");
      g.appendChild(hit);

      g.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openConnectorContextMenu(e.clientX, e.clientY, parent, child);
      });
    }

    svgEl.appendChild(g);
  }

  // Fast-path update used while dragging or typing: recompute just the
  // connector path(s) touching one node, without a full re-render.
  function updateConnectorDom(parent, child, ox, oy) {
    const g = svgEl.querySelector(`g.connector[data-parent="${parent.id}"][data-child="${child.id}"]`);
    if (!g) return;
    const orientation = g.dataset.orientation || "h";
    const path = orientation === "v"
      ? connectorPathVertical(parent, child, ox, oy)
      : connectorPath(parent, child, ox, oy);
    g.querySelectorAll("path").forEach(p => p.setAttribute("d", path));
  }

  // Refreshes every connector touching a node, whether it's that node's tree
  // parent/children or (in Timeline mode) a spine link to a sibling branch.
  function refreshConnectorsFor(node) {
    const touching = svgEl.querySelectorAll(`g.connector[data-parent="${node.id}"], g.connector[data-child="${node.id}"]`);
    touching.forEach(g => {
      const p = findNode(g.dataset.parent), c = findNode(g.dataset.child);
      if (p && c) updateConnectorDom(p, c, state.originX, state.originY);
    });
  }

  // Fast-path used while dragging: move a node's div and the connectors
  // touching it, without re-running the full layout.
  function updateNodePositionDom(node) {
    const div = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
    if (div) {
      const w = node._w || NODE_H, h = node._h || NODE_H;
      div.style.left = (state.originX + nodeLeftX(node)) + "px";
      div.style.top = (state.originY + node._y + (node.oy || 0) - h / 2) + "px";
    }
    refreshConnectorsFor(node);
  }

  // Fast-path used while dragging: move one cross-link's path without a
  // full re-render (mirrors updateNodePositionDom for tree connectors).
  function updateLinkDom(link, a, b) {
    const g = svgEl.querySelector(`g.connector[data-link="${link.id}"]`);
    if (!g) return;
    const path = linkPath(a, b, state.originX, state.originY);
    g.querySelectorAll("path").forEach(p => p.setAttribute("d", path));
  }

  // Re-runs layout (which may reorder siblings, flip a side, or resize the
  // canvas) but — unlike renderAll() — never touches nodesLayer.innerHTML or
  // svgEl.innerHTML, so every existing node div and connector line is just
  // moved to its new spot instead of being torn down and recreated. That
  // full rebuild is what caused the visible blink when a drag crossed the
  // center line or reordered siblings. Only safe to call when the set of
  // nodes/connectors on screen hasn't changed shape (nothing added or
  // removed, no collapse toggled) — exactly the case while a drag is live.
  //
  // freezeOrigin (used while a drag is in progress) keeps state.originX/
  // originY and the world/svg canvas size exactly as they were, instead of
  // recomputing them from the fresh bounding box. Every node's on-screen
  // position is originX/originY plus its own local coordinate, so without
  // this, a side-flip or reorder that shifts the bounding box (e.g. a
  // branch now reaching further left) shifts that shared origin — which
  // visibly nudges EVERY node, including ones that didn't logically move
  // at all, like the dragged node's parent or the root. Freezing origin
  // during the drag keeps those untouched nodes visually still; the
  // canvas is resized/recentered properly in one shot once the drag ends.
  function repositionAll(freezeOrigin) {
    if (!state.current) return;
    const bbox = layout(state.current.root);

    if (!freezeOrigin) {
      const pad = 140;
      const width = (bbox.maxX - bbox.minX) + pad * 2;
      const height = (bbox.maxY - bbox.minY) + pad * 2;
      state.originX = -bbox.minX + pad;
      state.originY = -bbox.minY + pad;

      worldEl.style.width = width + "px";
      worldEl.style.height = height + "px";
      svgEl.setAttribute("width", width);
      svgEl.setAttribute("height", height);
      svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }

    const nodes = [];
    (function collect(n) { nodes.push(n); if (!n.collapsed) (n.children || []).forEach(collect); })(state.current.root);
    for (const n of nodes) updateNodePositionDom(n);

    if (state.current.links && state.current.links.length) {
      for (const link of state.current.links) {
        const a = findNode(link.a), b = findNode(link.b);
        if (a && b) updateLinkDom(link, a, b);
      }
    }
  }

  let dragCandidate = null;
  let suppressNextNodeClick = false;

  // Tracks every touch currently down anywhere in the viewport (canvas
  // background or on a node), keyed by pointerId, so a second finger
  // landing mid-gesture can be recognized as the start of a pinch-zoom
  // regardless of what the first finger touched. Mouse/pen pointers are
  // never added here — only "touch" ones (see viewportEl's pointerdown
  // listener below), since pinch is a touch-only gesture.
  const activePointers = new Map();

  // Dragging a node's task ring / progress bar / photo strip onto a
  // *different* node moves (or, with Alt/Option held, copies) that data
  // over — an easy way to reassign a checklist or a batch of photos
  // without opening menus. Uses native HTML5 drag-and-drop rather than
  // the mouse-based dragCandidate mechanism above (which is reserved for
  // repositioning/reparenting whole nodes), so the two never collide.
  let markerDragState = null;

  function startMarkerDrag(e, node, type, extra) {
    e.stopPropagation();
    markerDragState = Object.assign({ type, sourceNodeId: node.id }, extra);
    e.dataTransfer.effectAllowed = "copyMove";
    // Firefox requires data to actually be set for the drag to proceed.
    try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
    e.currentTarget.classList.add("marker-dragging");
  }

  function endMarkerDrag(e) {
    e.currentTarget.classList.remove("marker-dragging");
    markerDragState = null;
    nodesLayer.querySelectorAll(".node.marker-drop-target").forEach(d => d.classList.remove("marker-drop-target"));
  }

  // Applies a completed marker drop: merges the dragged data onto the
  // target node, then (unless the user held Alt/Option to copy) clears it
  // from the source so it reads as a move rather than a duplication.
  function completeMarkerDrop(targetId, copy) {
    if (!markerDragState) return;
    const { type, sourceNodeId, photoIndex, overflowFrom } = markerDragState;
    if (sourceNodeId === targetId) return;
    const source = findNode(sourceNodeId);
    const target = findNode(targetId);
    if (!source || !target) return;

    if (type === "tasks") {
      const srcTasks = getNodeTasks(source);
      if (!srcTasks.length) return;
      pushUndo();
      const carried = copy
        ? srcTasks.map(t => Object.assign({}, t, {
            id: uid(),
            subtasks: getTaskSubtasks(t).map(s => Object.assign({}, s, { id: uid() })),
          }))
        : srcTasks;
      target.tasks = getNodeTasks(target).concat(carried);
      if (!copy) source.tasks = [];
    } else if (type === "photos") {
      const srcImages = getNodeImages(source);
      if (!srcImages.length) return;
      pushUndo();
      target.images = getNodeImages(target).concat(srcImages);
      if (!copy) { source.images = []; source.image = null; }
    } else if (type === "photo") {
      // A single thumbnail, dragged by its index in the source's images.
      const srcImages = getNodeImages(source);
      if (photoIndex == null || photoIndex < 0 || photoIndex >= srcImages.length) return;
      pushUndo();
      target.images = getNodeImages(target).concat([srcImages[photoIndex]]);
      if (!copy) {
        const remaining = srcImages.slice();
        remaining.splice(photoIndex, 1);
        source.images = remaining;
        source.image = null;
      }
    } else if (type === "photos-overflow") {
      // The "+N" badge — everything past the thumbnails actually shown.
      const srcImages = getNodeImages(source);
      const carried = srcImages.slice(overflowFrom || 0);
      if (!carried.length) return;
      pushUndo();
      target.images = getNodeImages(target).concat(carried);
      if (!copy) {
        source.images = srcImages.slice(0, overflowFrom || 0);
        source.image = null;
      }
    } else if (type === "note-single") {
      // A single note, dragged by its index in the source's notes — same
      // shape as the "photo" single-thumbnail case above, since each note
      // now has its own icon rather than one shared icon for the lot.
      const { noteIndex } = markerDragState;
      const srcNotes = getNodeNotes(source);
      if (noteIndex == null || noteIndex < 0 || noteIndex >= srcNotes.length) return;
      pushUndo();
      target.notes = getNodeNotes(target).concat([srcNotes[noteIndex]]);
      target.note = "";
      if (!copy) {
        const remaining = srcNotes.slice();
        remaining.splice(noteIndex, 1);
        source.notes = remaining;
        source.note = "";
      }
    } else if (type === "urls") {
      const srcUrls = getNodeUrls(source);
      if (!srcUrls.length) return;
      pushUndo();
      target.urls = getNodeUrls(target).concat(srcUrls);
      target.url = null;
      if (!copy) { source.urls = []; source.url = null; }
    } else {
      return;
    }
    renderAll();
    persist();
  }

  function renderNode(node, ox, oy) {
    const depth = node._depth;
    const w = node._w || NODE_H;
    const h = node._h || (depth === 0 ? ROOT_H : NODE_H);
    const div = document.createElement("div");
    // Older saves may have `glow: true` from before named intensities
    // existed — treat that the same as "soft" instead of producing a
    // dead "glow-true" class that matches no CSS rule.
    const glowVariant = node.glow === true ? "soft" : node.glow;
    div.className = `node depth-${Math.min(depth, 3)}` + (node.id === state.selectedId ? " selected" : "") + (node.struck ? " struck" : "") + (glowVariant ? ` glow-${glowVariant}` : "");
    div.dataset.id = node.id;
    div.style.left = (ox + nodeLeftX(node)) + "px";
    div.style.top = (oy + node._y + (node.oy || 0) - h / 2) + "px";
    div.style.width = w + "px";
    div.style.height = h + "px";
    div.title = node.text;

    const theme = state.current.theme;
    if (depth === 0) {
      div.style.border = "2px solid #F5A25C";
    }

    const color = depth === 0 ? null : (node.color || branchColorFor(state.current.root, node) || "#5b6272");
    // What's actually visible behind this node's text, used both to keep
    // the editing caret visible and, for the solid-filled first level
    // only, to pick a plain black/white text color with good contrast
    // against that fill — every level below that tints its text with
    // the branch color instead (see below).
    let effectiveBg = theme.background || defaultBg();
    if (color) {
      div.style.setProperty("--sel-color", color);
      if (depth === 1) {
        div.style.background = color;
        effectiveBg = color;
      } else if (depth === 2) {
        // Level 3: outlined box only — transparent fill, branch color on the border.
        div.style.background = "transparent";
        div.style.borderColor = color;
      } else {
        // Level 4 and deeper: no box at all — no fill, no border — just
        // the text, tinted with the branch color so nodes still read as
        // part of their branch without a bordered box around them.
        div.style.background = "transparent";
        div.style.color = color;
      }
    }
    if (depth === 0) effectiveBg = "#0A0B24"; // matches --root-fill
    // Level 3+ nodes (outlined boxes and, deeper still, no box at all)
    // have their text tinted with the branch color instead of plain
    // black/white, so the color story stays consistent all the way down
    // the branch rather than only kicking in once the box disappears —
    // unless the user has set a custom font color, which still wins.
    div.style.color = (color && depth > 1 && theme.fontMode !== "custom")
      ? color
      : (theme.fontMode === "custom" ? theme.fontColor : caretColorFor(effectiveBg));
    div.style.caretColor = caretColorFor(effectiveBg);

    div.textContent = node.text || (node.id === state.editingId ? "" : "(untitled)");

    if (node.id === state.editingId) {
      div.contentEditable = "true";
      div.addEventListener("input", () => autosizeEditingBox(div, node));
      // Pasting an image while typing a node's text would otherwise let
      // the browser embed it directly inline in the contenteditable box
      // (rendered at full size, blowing up the node on the canvas). Route
      // it to the node's photo attachments instead, same as pasting an
      // image with the node just selected (not being edited) already does.
      div.addEventListener("paste", (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const imageItem = Array.from(items).find(i => i.type && i.type.startsWith("image/"));
        if (!imageItem) return;
        const file = imageItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        handleNodePhotoFiles(node.id, [file]);
      });
    }

    // collapse toggle — hidden while actively editing so it doesn't sit
    // inside the contenteditable box and throw off caret placement.
    if (node.children && node.children.length > 0 && node.id !== state.editingId) {
      const toggle = document.createElement("span");
      toggle.className = "node-collapse";
      if (depth > 0 && node._x < 0) {
        toggle.style.right = "auto";
        toggle.style.left = "-9px";
      }
      toggle.textContent = node.collapsed ? "+" : "–";
      toggle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      toggle.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        node.collapsed = !node.collapsed;
        renderAll();
        persist();
      });
      div.appendChild(toggle);
      if (node.collapsed) {
        const badge = document.createElement("span");
        badge.className = "node-badge";
        badge.textContent = countAll(node);
        div.appendChild(badge);
      }
    }

    const nodeUrls = getNodeUrls(node);
    const nodeNotes = getNodeNotes(node);
    const affirmationWins = nodeAffirmationWins(node);
    const taskProg = nodeTaskProgress(node);

    const nodeImages = getNodeImages(node);
    // Note, link, and affirmation-completion markers all render inline as
    // cells of this same strip, right alongside the photo thumbnails,
    // instead of floating outside the node — so every attachment/status
    // indicator for a node lives in one place. Only the task-progress bar
    // (see below) stays separate, since it's a full-width row rather than
    // a small square cell.
    const stripIconCount = nodeNotes.length + (nodeUrls.length ? 1 : 0) + (affirmationWins ? 1 : 0);
    if ((stripIconCount || nodeImages.length) && node.id !== state.editingId) {
      const strip = document.createElement("span");
      // A handful of items deserve bigger cells than a full grid of them
      // would — "large" only kicks in when everything still fits in one
      // row (under the 5-column cap). Past 10 photos, collapse to a
      // single cover thumbnail + count badge (see the loop below) rather
      // than 9 thumbnails plus a separate "+N" tile, so a node with many
      // photos stays compact.
      const overflow = nodeImages.length > 10;
      const shownCount = overflow ? 1 : nodeImages.length;
      const itemCount = stripIconCount + shownCount;
      const large = itemCount < 6;
      strip.className = "node-photo-strip" + (large ? " large" : "");
      strip.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      strip.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      if (nodeImages.length) {
        // Dragging the strip's own background (not a specific icon/thumb,
        // which each have their own drag handlers) moves every photo at
        // once — matches dragging the old standalone photo strip.
        strip.title = "Drag onto another node to move the photos there (hold Alt to copy)";
        strip.draggable = true;
        strip.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photos"));
        strip.addEventListener("dragend", endMarkerDrag);
      }
      // Pin the strip's actual width in JS to exactly what fits `cols`
      // cells per row (same formula computeNodeBox uses to reserve room
      // in the node box), instead of trusting the CSS max-width to land
      // on the same number — a few px of drift between the two would
      // make the browser wrap to an extra row the box never made room
      // for, pushing cells outside the frame.
      const thumbPx = large ? 18 : 9;
      const gapPx = large ? 3 : 2;
      const cols = Math.min(itemCount, 5);
      strip.style.width = (cols * thumbPx + (cols - 1) * gapPx) + "px";

      // One icon per note (instead of a single icon plus a count badge),
      // same cell size/box as a photo thumbnail — each is independently
      // clickable/draggable, so a node with several notes reads at a
      // glance as "several notes" without needing to decode a number.
      nodeNotes.forEach((n, i) => {
        const noteIcon = document.createElement("span");
        noteIcon.className = "node-photo-thumb node-note-marker";
        noteIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/></svg>';
        noteIcon.title = notePreviewText(n);
        noteIcon.draggable = true;
        noteIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "note-single", { noteIndex: i }));
        noteIcon.addEventListener("dragend", endMarkerDrag);
        noteIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openNoteModal(node.id, i);
        });
        noteIcon.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openNoteManageMenu(node.id, e.clientX, e.clientY);
        });
        strip.appendChild(noteIcon);
      });

      if (nodeUrls.length) {
        const urlIcon = document.createElement("span");
        urlIcon.className = "node-photo-thumb node-url-marker";
        urlIcon.textContent = "🔗";
        urlIcon.title = (nodeUrls.length > 1 ? `${nodeUrls.length} links — click to choose` : nodeUrls[0]) + " · right-click to edit/remove · drag onto another node to move (Alt to copy)";
        urlIcon.draggable = true;
        urlIcon.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "urls"));
        urlIcon.addEventListener("dragend", endMarkerDrag);
        urlIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          if (nodeUrls.length > 1) {
            openUrlMenu(node.id, e.clientX, e.clientY);
          } else {
            window.open(nodeUrls[0], "_blank", "noopener");
          }
        });
        urlIcon.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openUrlManageMenu(node.id, e.clientX, e.clientY);
        });
        if (nodeUrls.length > 1) {
          const count = document.createElement("span");
          count.className = "node-marker-count";
          count.textContent = String(nodeUrls.length);
          urlIcon.appendChild(count);
        }
        strip.appendChild(urlIcon);
      }

      if (affirmationWins) {
        // One checkmark cell with an incrementing count badge (same
        // pattern as the multi-link icon above), rather than a stack of
        // icons per win — click it to jump straight into a new round.
        const affIcon = document.createElement("span");
        affIcon.className = "node-photo-thumb node-affirmation-marker";
        affIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5L19.5 7"/></svg>';
        affIcon.title = `Affirmation game — ${affirmationWins} round${affirmationWins === 1 ? "" : "s"} completed. Click to play again.`;
        affIcon.addEventListener("click", (e) => {
          e.stopPropagation();
          openAffirmationGame(node.id);
        });
        const affCount = document.createElement("span");
        affCount.className = "node-marker-count";
        affCount.textContent = String(affirmationWins);
        affIcon.appendChild(affCount);
        strip.appendChild(affIcon);
      }

      for (let i = 0; i < shownCount; i++) {
        const thumb = document.createElement("span");
        thumb.className = "node-photo-thumb";
        // Use the small pre-cropped stand-in (see getMarkerThumb) instead
        // of painting the full-resolution photo into this tiny box — keeps
        // the canvas cheap to composite no matter how many/how large the
        // attached photos are. Falls back to the full image for the one
        // frame before its thumbnail has been generated.
        const fullSrc = nodeImages[i];
        const cachedThumb = getMarkerThumb(fullSrc, () => {
          const liveThumb = nodesLayer.querySelector(`.node[data-id="${node.id}"] .node-photo-thumb[data-src-index="${i}"]`);
          if (liveThumb) liveThumb.style.backgroundImage = `url("${nodeThumbCache.get(fullSrc)}")`;
        });
        thumb.dataset.srcIndex = String(i);
        thumb.style.backgroundImage = `url("${cachedThumb || fullSrc}")`;
        thumb.draggable = true;
        thumb.addEventListener("dragend", endMarkerDrag);
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          openPhotoModal(node.id, i);
        });
        if (overflow) {
          // The one cell stands in for the whole collection — a count
          // badge (same style as the multi-link badge above) instead of
          // a wall of individual thumbnails, and dragging/clicking it
          // acts on all the photos together rather than just this one.
          thumb.title = `${nodeImages.length} photos — click to view, or drag to move them all onto another node (hold Alt to copy)`;
          thumb.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photos"));
          const badge = document.createElement("span");
          badge.className = "node-marker-count";
          badge.textContent = String(nodeImages.length);
          thumb.appendChild(badge);
        } else {
          thumb.title = "Click to view photo — drag onto another node to move it there (hold Alt to copy)";
          thumb.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "photo", { photoIndex: i }));
        }
        strip.appendChild(thumb);
      }
      div.appendChild(strip);
    }

    if (taskProg.total && node.id !== state.editingId) {
      const row = document.createElement("span");
      row.className = "node-progress-row";
      row.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      row.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      row.addEventListener("click", (e) => { e.stopPropagation(); openTasksModal(node.id); });
      row.title = `${taskProg.done} of ${taskProg.total} tasks done — drag onto another node to move the tasks there (hold Alt to copy)`;
      row.draggable = true;
      row.addEventListener("dragstart", (e) => startMarkerDrag(e, node, "tasks"));
      row.addEventListener("dragend", endMarkerDrag);

      const track = document.createElement("span");
      track.className = "node-progress-track";
      const fill = document.createElement("span");
      fill.className = "node-progress-fill" + (taskProg.pct >= 1 ? " done" : "");
      fill.style.width = Math.round(taskProg.pct * 100) + "%";
      track.appendChild(fill);

      const pctLabel = document.createElement("span");
      pctLabel.className = "node-progress-pct" + (taskProg.pct >= 1 ? " done" : "");
      pctLabel.textContent = String(taskProg.done);

      // On a level-1 node (the solid-filled branch pill) the bar sits on
      // top of an arbitrary branch color, so it can't rely on a fixed
      // teal/gold or a same-hue tint — either washes out depending on the
      // branch color. Instead the track is a neutral dark groove and the
      // fill a bright, near-opaque bar, which reads clearly as "progress"
      // against any branch color the same way a scrubber reads against
      // colorful album art. The % label gets its own small dark chip
      // behind it (rather than colored text sitting directly on the pill)
      // so it stays legible no matter how light or saturated the branch
      // color is.
      if (depth === 1 && color) {
        track.style.background = "rgba(0,0,0,0.32)";
        track.style.boxShadow = "inset 0 1px 3px rgba(0,0,0,0.45)";
        fill.style.background = taskProg.pct >= 1
          ? "linear-gradient(90deg, #ffe8ab, #ffc98a)"
          : "rgba(255,255,255,0.92)";
        fill.style.boxShadow = "0 0 5px rgba(255,255,255,0.35)";
        pctLabel.classList.add("node-progress-pct-chip");
      }

      row.appendChild(track);
      row.appendChild(pctLabel);
      div.appendChild(row);
    }

    function beginNodeDrag(e) {
      e.stopPropagation();
      if (node.id === state.editingId) return;
      // A second (or third) finger landing on the node — e.g. the start of
      // a pinch that happens to begin over a node — shouldn't kick off a
      // node drag; only the first touch/click does.
      if (e.pointerType && activePointers.size > 1) return;
      dragCandidate = {
        id: node.id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startOx: node.ox || 0,
        startOy: node.oy || 0,
        // Absolute (layout-space) Y at the moment the drag starts, tracked
        // independently of node._y so it stays correct even after a sibling
        // reorder shifts the node into a new slot mid-drag.
        startAbsY: node._y + (node.oy || 0),
        moved: false,
        dropTargetId: null,
        // How much of the current drag delta is already "baked into" the
        // dragged nodes' left/top (as opposed to sitting in a live CSS
        // transform — see the mousemove handler). Starts at zero since
        // left/top haven't moved yet.
        bakedDx: 0,
        bakedDy: 0,
        // Snapshot every descendant's current offset so the whole branch can
        // be translated by the same delta as the node being dragged.
        descendants: collectDescendants(node).map(c => ({
          id: c.id,
          startOx: c.ox || 0,
          startOy: c.oy || 0
        }))
      };
    }
    div.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      beginNodeDrag(e);
    });
    div.addEventListener("pointerdown", (e) => {
      // Mouse is already handled by the mousedown listener above; this one
      // only needs to cover touch/pen so drags work on touch devices.
      if (e.pointerType === "mouse") return;
      beginNodeDrag(e);
    });
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (suppressNextNodeClick) { suppressNextNodeClick = false; return; }
      if (state.linkFromId) { completeLinkTo(node.id); return; }
      selectNode(node.id);
    });
    div.addEventListener("dblclick", (e) => { e.stopPropagation(); startEdit(node.id); });
    div.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); selectNode(node.id); openContextMenu(e.clientX, e.clientY, node); });

    // Accept a task-ring / progress-bar / photo-strip drag started on some
    // other node (see startMarkerDrag above).
    div.addEventListener("dragover", (e) => {
      if (!markerDragState || markerDragState.sourceNodeId === node.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      div.classList.add("marker-drop-target");
    });
    div.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && div.contains(e.relatedTarget)) return;
      div.classList.remove("marker-drop-target");
    });
    div.addEventListener("drop", (e) => {
      if (!markerDragState || markerDragState.sourceNodeId === node.id) return;
      e.preventDefault();
      e.stopPropagation();
      div.classList.remove("marker-drop-target");
      completeMarkerDrop(node.id, e.altKey);
    });

    div.addEventListener("blur", () => { if (state.editingId === node.id) commitEdit(div); });
    div.addEventListener("keydown", (e) => nodeKeydown(e, node, div));

    nodesLayer.appendChild(div);

    if (node.id === state.editingId) {
      // Focus synchronously, not via requestAnimationFrame — the div is
      // already attached to the DOM (appendChild just above), and on
      // touch devices a deferred focus() falls outside the tap's "user
      // activation" window, so the on-screen keyboard doesn't reopen for
      // the new node (e.g. right after tapping the add-child/add-sibling
      // buttons) even though focus visibly lands there.
      div.focus();
      placeCaretAtEnd(div);
    }
  }

  // Reads a contenteditable node's text back out while preserving line
  // breaks the browser may represent as <br> or nested <div>s.
  function getEditableText(div) {
    let text = "";
    div.childNodes.forEach((node) => {
      if (node.nodeType === 3) {
        text += node.textContent;
      } else if (node.nodeName === "BR") {
        text += "\n";
      } else if (node.nodeType === 1 && (node.classList.contains("node-collapse") || node.classList.contains("node-badge") || node.classList.contains("node-photo-strip") || node.classList.contains("node-progress-row"))) {
        // These are UI overlays (collapse toggle, child-count badge, note
        // icon, photo thumbnail) rendered inside the node box, not part of
        // the typed text — skip them or their glyphs (e.g. "–") get
        // appended to the text.
      } else if (node.nodeName === "DIV" || node.nodeName === "P") {
        if (text.length && !text.endsWith("\n")) text += "\n";
        text += node.textContent;
      } else {
        text += node.textContent;
      }
    });
    return text.trim();
  }

  // Grows (or shrinks) the node box live as the person types, keeping it
  // centered on its layout position, so text never overflows its box.
  function autosizeEditingBox(div, node) {
    const text = getEditableText(div);
    const box = computeNodeBox(Object.assign({}, node, { text }));
    node._w = box.w;
    node._h = box.h;
    const cy = state.originY + node._y + (node.oy || 0);
    div.style.width = box.w + "px";
    div.style.height = box.h + "px";
    div.style.left = (state.originX + nodeLeftX(node)) + "px";
    div.style.top = (cy - box.h / 2) + "px";
    refreshConnectorsFor(node);
  }

  function countAll(node) {
    let n = 0;
    (function walk(x) { for (const c of x.children || []) { n++; walk(c); } })(node);
    return n;
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ---------------- selection / editing ---------------- */

  function findNode(id, node = state.current && state.current.root) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const r = findNode(id, c);
      if (r) return r;
    }
    return null;
  }

  function findParent(id, node = state.current && state.current.root) {
    if (!node) return null;
    for (const c of node.children || []) {
      if (c.id === id) return node;
      const r = findParent(id, c);
      if (r) return r;
    }
    return null;
  }

  // Flat list of every descendant under `node` (not including node itself),
  // used to drag a whole branch as one unit and to reset it after a reparent.
  function collectDescendants(node) {
    const list = [];
    (function walk(n) {
      (n.children || []).forEach(c => { list.push(c); walk(c); });
    })(node);
    return list;
  }

  // True if `id` belongs to node's own subtree (itself or any descendant) —
  // used to stop a branch from being dropped onto itself or its own child.
  function isWithinSubtree(node, id) {
    if (node.id === id) return true;
    for (const c of node.children || []) {
      if (isWithinSubtree(c, id)) return true;
    }
    return false;
  }

  // Moves a node (and everything under it) to become the last child of a
  // different node — this is what a completed drag-to-reparent does.
  function reparentNode(nodeId, newParentId) {
    const node = findNode(nodeId);
    const newParent = findNode(newParentId);
    if (!node || !newParent) return;
    const oldParent = findParent(nodeId);
    if (!oldParent) return; // the central node has no parent — can't be moved
    const idx = oldParent.children.findIndex(c => c.id === nodeId);
    if (idx === -1) return;
    oldParent.children.splice(idx, 1);
    newParent.children.push(node);
    newParent.collapsed = false;
    // Drop the manual nudge offset so the branch settles into its fresh
    // auto-layout spot under the new parent instead of an old, unrelated one.
    // Reset the whole subtree, not just the moved node, since it was dragged
    // (and dropped) as one unit.
    node.ox = 0;
    node.oy = 0;
    // Drop any explicit left/right override the node had picked up from a
    // drag under its old parent — under the new parent it should go back
    // to inheriting that branch's side until the user flips it again.
    node.side = null;
    // Same for a custom connector distance — a distance tailored to the
    // old parent isn't meaningful under a new one.
    node.xGap = null;
    collectDescendants(node).forEach(d => { d.ox = 0; d.oy = 0; });
    state.selectedId = node.id;
    renderAll();
  }

  // While dragging, checks whether the node has been pulled far enough past
  // an adjacent sibling (same parent) to swap places with it — repeated so a
  // fast drag can hop past more than one sibling in a single move. Returns
  // true if the sibling order actually changed, so the caller knows to
  // re-run layout. For most nodes this is a plain positional swap. For a
  // root-level branch in Mindmap layout, swapping past a sibling on the
  // *other* side of the map is treated as the user dragging that branch
  // across the center line: only the dragged node's side flips to follow
  // it — the neighbor it passed keeps whichever side it was already on, so
  // one drag never yanks an unrelated branch to the opposite side too.
  // Reorders a node among its siblings to match where it's currently being
  // dragged, vertically. This only ever touches array order (top-to-bottom
  // stacking) — it must NOT also decide the node's left/right side. Left
  // and right branches sit interleaved in the same array (not grouped), so
  // a purely vertical drag can easily swap past a sibling that happens to
  // be on the other side; flipping side on that alone was causing nodes to
  // jump to the opposite side from a plain up/down drag. Side is decided
  // separately, only from actual horizontal position, by
  // maybeFlipSideOnDrop() once the drag ends.
  function maybeReorderSiblings(node, targetAbsY) {
    const parent = findParent(node.id);
    if (!parent || !parent.children || parent.children.length < 2) return false;
    const siblings = parent.children;
    let idx = siblings.indexOf(node);
    if (idx === -1) return false;
    let changed = false;

    while (idx > 0 && targetAbsY < siblings[idx - 1]._y) {
      siblings[idx] = siblings[idx - 1];
      siblings[idx - 1] = node;
      idx--;
      changed = true;
    }
    while (idx < siblings.length - 1 && targetAbsY > siblings[idx + 1]._y) {
      siblings[idx] = siblings[idx + 1];
      siblings[idx + 1] = node;
      idx++;
      changed = true;
    }

    if (!changed) return false;
    layout(state.current.root);
    return true;
  }

  // Called once a drag finishes (mouseup), for any node at any depth in
  // Mindmap or Timeline layout: if the node ended up on the opposite side
  // of the center line from where it's currently drawn, give it an
  // explicit side override so it — and everything under it, via
  // place()/placeLocal() — flips to fan out the other way instead of
  // staying stuck following its parent branch's side. Returns true if a
  // flip happened, so the caller knows to snap the drag offset back to
  // zero and re-render.
  function maybeFlipSideOnDrop(node) {
    const layoutMode = (state.current && state.current.layout) || "mindmap";
    // "Logic chart" only ever fans one direction (right), so there's no
    // opposite side to flip to.
    if (layoutMode === "logic") return false;
    // node._x is 0 for the root, and also for a Timeline branch's own node
    // (it sits directly on the spine) — neither has a side of its own to
    // flip; only their descendants do.
    if (!node._x) return false;
    // In Mindmap mode only a top-level branch (depth 1) can have its own
    // side — every deeper node just inherits its branch's direction (see
    // layoutMindmap's place()), so setting .side on a deeper node here
    // would have no visible effect. Block it rather than silently writing
    // a .side that layout ignores.
    if (layoutMode === "mindmap" && node._depth !== 1) return false;
    const finalWorldX = node._x + (node.ox || 0);
    if (finalWorldX === 0) return false;
    const curSide = node._x > 0 ? "right" : "left";
    const newSide = finalWorldX > 0 ? "right" : "left";
    if (newSide === curSide) return false;
    node.side = newSide;
    return true;
  }

  // Same idea, but live — called on every mousemove while a node is being
  // dragged, so its subtree flips direction the instant it crosses the
  // center line instead of waiting for the mouse to be released. Besides
  // setting the side, this has to keep the drag feeling continuous: the
  // dragged node must stay exactly under the cursor across the flip (its
  // own _x jumps when the side changes, so ox/startOx are re-anchored to
  // compensate), and every descendant is re-anchored to that SAME (ox, oy)
  // offset — not reset to zero — so the whole subtree keeps moving as one
  // rigid unit. That matters because each connector's on-screen length is
  // (clean gap) + (this node's ox − its parent's ox): as long as every
  // node in the subtree shares the identical ox/oy, that second term stays
  // zero and every connector's distance is exactly its clean gap,
  // unchanged by the flip — only the underlying clean layout (and so which
  // direction each hop fans) actually mirrors.
  function maybeFlipSideDuringDrag(node, dxLocal, dyLocal) {
    const layoutMode = (state.current && state.current.layout) || "mindmap";
    if (layoutMode === "logic") return false;
    if (!node._x) return false;
    if (layoutMode === "mindmap" && node._depth !== 1) return false;
    const worldX = node._x + (node.ox || 0);
    const worldY = node._y + (node.oy || 0);
    if (worldX === 0) return false;
    const curSide = node._x > 0 ? "right" : "left";
    const newSide = worldX > 0 ? "right" : "left";
    if (newSide === curSide) return false;

    node.side = newSide;
    layout(state.current.root);

    node.ox = worldX - node._x;
    node.oy = worldY - node._y;
    dragCandidate.startOx = node.ox - dxLocal;
    // Vertical layout can shift too (e.g. a top-level branch moving
    // between the left/right lists re-centers both), so re-anchor the
    // reorder target the same way the horizontal one is re-anchored above.
    dragCandidate.startAbsY = worldY - dyLocal;

    dragCandidate.descendants.forEach(d => {
      d.startOx = node.ox - dxLocal;
      d.startOy = node.oy - dyLocal;
    });

    return true;
  }

  // While dragging a node, figure out whether the pointer is currently over
  // a different, droppable node, and keep the highlight in sync.
  function updateDropTarget(e, node) {
    let targetId = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetDiv = el && el.closest ? el.closest(".node[data-id]") : null;
    if (targetDiv) {
      const id = targetDiv.dataset.id;
      if (id !== node.id && !isWithinSubtree(node, id)) targetId = id;
    }
    if (dragCandidate.dropTargetId && dragCandidate.dropTargetId !== targetId) {
      const prevDiv = nodesLayer.querySelector(`.node[data-id="${dragCandidate.dropTargetId}"]`);
      if (prevDiv) prevDiv.classList.remove("drop-target");
    }
    dragCandidate.dropTargetId = targetId;
    if (targetId) {
      const div = nodesLayer.querySelector(`.node[data-id="${targetId}"]`);
      if (div) div.classList.add("drop-target");
    }
  }

  function selectNode(id) {
    if (state.editingId === id) return; // a click inside the box being edited is just caret placement, not a request to stop editing
    commitEditIfActive();
    state.selectedId = id;
    renderAll();
  }

  function startEdit(id) {
    state.selectedId = id;
    state.editingId = id;
    renderAll();
  }

  // `render` can be set to false by a caller that is about to make further
  // state changes (e.g. creating and focusing a new node) and will do its
  // own single renderAll() afterward — see commitEditIfActive below for why
  // that matters on touch devices.
  function commitEdit(div, { render = true } = {}) {
    const id = div.dataset.id;
    const node = findNode(id);
    if (!node) return;
    const text = getEditableText(div);
    if (node.text !== text) {
      pushUndo();
      node.text = text;
      // The central/root node's text doubles as the map's title everywhere
      // else (sidebar list, title field) — keep them in sync.
      if (state.current && node.id === state.current.root.id) {
        state.current.title = text;
        titleInput.value = text;
        renderSidebar();
      }
    }
    state.editingId = null;
    if (render) renderAll();
    persist();
  }

  // Saves whatever is currently being typed before anything else (switching
  // maps, selecting another node, clicking empty canvas) is allowed to clear
  // state.editingId. Every place that ends editing should call this first —
  // otherwise the in-progress text is discarded instead of saved, which is
  // what was happening when clicking outside a node's box.
  //
  // Pass { render: false } when the caller is going to change more state
  // right after (e.g. fabTargetNode, before creating+focusing a new node)
  // and will call renderAll() itself once at the end. Doing two separate
  // renderAll() passes back-to-back — one here to exit the old node's edit,
  // one later to create and focus the new node — makes the whole sequence
  // take long enough that touch browsers stop treating the later focus()
  // as part of the original tap, so the on-screen keyboard doesn't reopen
  // even though focus visibly lands on the new node.
  function commitEditIfActive({ render = true } = {}) {
    if (!state.editingId) return;
    const div = nodesLayer.querySelector(`.node[data-id="${state.editingId}"]`);
    if (div) commitEdit(div, { render });
    else state.editingId = null;
  }

  function addChild(parentId) {
    const parent = findNode(parentId);
    if (!parent) return null;
    pushUndo();
    const n = newNode("");
    parent.children.push(n);
    parent.collapsed = false;
    return n;
  }

  function addSibling(nodeId) {
    const node = findNode(nodeId);
    if (!node) return null;
    const parent = findParent(nodeId);
    if (!parent) return addChild(nodeId); // root has no siblings -> add child instead
    pushUndo();
    const n = newNode("");
    const idx = parent.children.findIndex(c => c.id === nodeId);
    parent.children.splice(idx + 1, 0, n);
    return n;
  }

  function deleteBranch(nodeId) {
    const parent = findParent(nodeId);
    if (!parent) { alert("The central idea can't be deleted."); return; }
    const node = findNode(nodeId);
    if (node.children && node.children.length > 0) {
      if (!confirm("Delete this node and all its children?")) return;
    }
    pushUndo();
    const removedIds = new Set();
    (function collect(n) { removedIds.add(n.id); (n.children || []).forEach(collect); })(node);
    parent.children = parent.children.filter(c => c.id !== nodeId);
    // any cross-link touching a node that no longer exists gets cleaned up too
    if (state.current.links && state.current.links.length) {
      state.current.links = state.current.links.filter(l => !removedIds.has(l.a) && !removedIds.has(l.b));
    }
    state.selectedId = parent.id;
    renderAll();
    persist();
  }

  /* ---------------- cross-links ---------------- */

  let defaultHintHTML = null;
  function updateLinkHint() {
    if (!hintBar) return;
    if (defaultHintHTML === null) defaultHintHTML = hintBar.innerHTML;
    if (state.linkFromId) {
      viewportEl.classList.add("linking");
      hintBar.innerHTML = `<span>Click another node to link it &middot; <kbd>Esc</kbd> cancel</span>`;
    } else {
      viewportEl.classList.remove("linking");
      hintBar.innerHTML = defaultHintHTML;
    }
  }

  // Enters "pick the other end" mode: the next node the person clicks gets
  // linked to `nodeId`. Clicking the same node, empty canvas, or Escape
  // cancels it instead of completing a link.
  function startLinkFrom(nodeId) {
    if (!findNode(nodeId)) return;
    commitEditIfActive();
    state.linkFromId = nodeId;
    state.editingId = null;
    renderAll();
  }

  function cancelLinking() {
    if (!state.linkFromId) return;
    state.linkFromId = null;
    renderAll();
  }

  function linkExists(aId, bId) {
    return (state.current.links || []).some(l =>
      (l.a === aId && l.b === bId) || (l.a === bId && l.b === aId));
  }

  function completeLinkTo(targetId) {
    const fromId = state.linkFromId;
    state.linkFromId = null;
    if (!fromId || !targetId || fromId === targetId) { renderAll(); return; }
    if (!findNode(fromId) || !findNode(targetId)) { renderAll(); return; }
    if (linkExists(fromId, targetId)) { renderAll(); return; }
    pushUndo();
    if (!state.current.links) state.current.links = [];
    state.current.links.push({ id: uid(), a: fromId, b: targetId });
    renderAll();
    persist();
  }

  function linksForNode(nodeId) {
    return (state.current.links || []).filter(l => l.a === nodeId || l.b === nodeId);
  }

  function removeLink(linkId) {
    if (!state.current || !state.current.links) return;
    pushUndo();
    state.current.links = state.current.links.filter(l => l.id !== linkId);
    renderAll();
    persist();
  }

  /* ---------------- keyboard ---------------- */

  function nodeKeydown(e, node, div) {
    const editing = state.editingId === node.id;
    if (editing) {
      if (e.key === "Tab") {
        e.preventDefault();
        commitEdit(div);
        const n = addChild(node.id);
        if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
        persist();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdit(div);
        const n = addSibling(node.id);
        if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
        persist();
      } else if (e.key === "Escape") {
        e.preventDefault();
        commitEdit(div);
      }
      e.stopPropagation();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (!state.current) return;
    const activeIsEditable = document.activeElement && document.activeElement.isContentEditable;
    const activeIsInput = document.activeElement && (document.activeElement.tagName === "INPUT");
    if (activeIsEditable || activeIsInput) return; // handled by node/title listeners

    if (state.linkFromId && e.key === "Escape") {
      e.preventDefault();
      cancelLinking();
      return;
    }
    if (state.highlightId && e.key === "Escape") {
      e.preventDefault();
      clearHighlight();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.selectedId) addNodeUrl(state.selectedId);
      return;
    }
    if (!state.selectedId) {
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        state.selectedId = state.current.root.id;
      }
      return;
    }
    const node = findNode(state.selectedId);
    if (!node) return;

    if (e.key === "Tab") {
      e.preventDefault();
      const n = addChild(node.id);
      if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
      persist();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = addSibling(node.id);
      if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
      persist();
    } else if (e.key === "F2") {
      e.preventDefault();
      startEdit(node.id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteBranch(node.id);
    } else if (e.key === " ") {
      e.preventDefault();
      if (node.children && node.children.length) {
        pushUndo();
        node.collapsed = !node.collapsed;
        renderAll();
        persist();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      pushUndo();
      node.struck = !node.struck;
      renderAll();
      persist();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      navigate(node, e.key);
    }
  });

  function navigate(from, dir) {
    const all = [];
    (function collect(n) { all.push(n); if (!n.collapsed) (n.children || []).forEach(collect); })(state.current.root);
    const dx = dir === "ArrowRight" ? 1 : dir === "ArrowLeft" ? -1 : 0;
    const dy = dir === "ArrowDown" ? 1 : dir === "ArrowUp" ? -1 : 0;
    let best = null, bestScore = Infinity;
    for (const n of all) {
      if (n.id === from.id) continue;
      const ddx = n._x - from._x, ddy = n._y - from._y;
      if (dx !== 0 && Math.sign(ddx || 0) !== dx && !(dx === 1 && n._depth > from._depth) && !(dx === -1 && n._depth < from._depth)) {
        // fallback simple directional filter
      }
      const alongAxis = dx !== 0 ? ddx * dx : ddy * dy;
      if (alongAxis <= 0) continue;
      const perpPenalty = dx !== 0 ? Math.abs(ddy) : Math.abs(ddx);
      const score = alongAxis + perpPenalty * 2;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) { state.selectedId = best.id; renderAll(); }
  }

  /* ---------------- context menu ---------------- */

  // Combined "Connector style" picker — one shared row of three
  // mutually-exclusive buttons (Curved / Elbow / Arrow) used identically
  // in three places: the root node's menu (sets the map-wide default),
  // a "mother" node's bulk picker (sets all of its direct children's
  // hops at once), and a single connector's own right-click menu (sets
  // just that one hop). `read()` returns which button should show as
  // active ("curved" | "elbow" | "arrow" | null for a mixed bulk
  // selection with no single answer), and `choose(value)` applies a click.
  function renderConnectorStyleRow(ctxMenu, label, read, choose) {
    const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
    const labelEl = document.createElement("div");
    labelEl.className = "ctx-item"; labelEl.style.cursor = "default";
    labelEl.textContent = label;
    ctxMenu.appendChild(labelEl);

    const row = document.createElement("div");
    row.className = "ctx-style-row";
    const current = read();
    [["curved", "Curved"], ["elbow", "Elbow"], ["arrow", "Arrow"]].forEach(([val, text]) => {
      const btn = document.createElement("div");
      btn.className = "ctx-style-btn" + (current === val ? " active" : "");
      btn.textContent = text;
      btn.addEventListener("click", () => {
        closeContextMenu();
        pushUndo();
        choose(val);
        renderAll();
        persist();
      });
      row.appendChild(btn);
    });
    ctxMenu.appendChild(row);
  }

  function openContextMenu(x, y, node) {
    resetContextMenu();
    const items = [];
    // Double-click/F2 rename a node's text just fine with a mouse and
    // keyboard, but neither is reliable on a touchscreen — a double-tap
    // doesn't always synthesize a dblclick event, and there's no F2 key.
    // Long-press already opens this menu on touch, so put Rename here too.
    items.push(["Rename", () => startEdit(node.id)]);
    items.push([node.struck ? "Remove strikethrough" : "Strikethrough", () => { pushUndo(); node.struck = !node.struck; renderAll(); persist(); }]);
    items.push(["Copy as outline", () => copyNodeBranchToClipboard(node)]);
    items.push([state.highlightId === node.id ? "Remove highlight" : "Highlight branch", () => setHighlight(node.id)]);
    if (node.ox || node.oy) {
      items.push(["Reset position", () => { pushUndo(); delete node.ox; delete node.oy; renderAll(); persist(); }]);
    }
    items.push(["Add link…", () => addNodeUrl(node.id)]);
    items.push([nodeHasNotes(node) ? `Notes (${getNodeNotes(node).length})…` : "Add note…", () => openNoteModal(node.id)]);
    {
      const prog = nodeTaskProgress(node);
      const label = prog.total ? `Tasks… (${prog.done}/${prog.total})` : "Add tasks…";
      items.push([label, () => openTasksModal(node.id)]);
    }
    items.push(["Add photo…", () => openNodePhotoPicker(node.id)]);
    if (nodeHasImages(node)) {
      items.push([getNodeImages(node).length > 1 ? "View photos…" : "View photo…", () => openPhotoModal(node.id, 0)]);
      items.push(["Remove all photos", () => { pushUndo(); node.images = []; node.image = null; renderAll(); persist(); }]);
    }
    for (const [label, fn, removeFn] of items) {
      const it = document.createElement("div");
      it.className = "ctx-item";
      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-item-label";
      labelSpan.textContent = label;
      it.appendChild(labelSpan);
      if (removeFn) {
        const rm = document.createElement("span");
        rm.className = "ctx-item-remove";
        rm.textContent = "✕";
        rm.title = "Remove";
        // Stop the click from also bubbling into the row's own handler
        // below (which would open the edit prompt right after removing).
        rm.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); removeFn(); });
        it.appendChild(rm);
      }
      it.addEventListener("click", () => { closeContextMenu(); fn(); });
      ctxMenu.appendChild(it);
    }

    // Affirmation typing game — its own grouped section (separated by a
    // divider) rather than living inside the tasks checklist. The wins
    // counter shows on the row once at least one round's been completed;
    // a second row opens the shared lines-editor modal.
    {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);

      const wins = nodeAffirmationWins(node);
      const gameItem = document.createElement("div");
      gameItem.className = "ctx-item";
      const gameLabel = document.createElement("span");
      gameLabel.className = "ctx-item-label";
      gameLabel.textContent = wins ? `🎮 Affirmation game (✓ ${wins})` : "🎮 Affirmation game";
      gameItem.appendChild(gameLabel);
      gameItem.addEventListener("click", () => { closeContextMenu(); openAffirmationGame(node.id); });
      ctxMenu.appendChild(gameItem);

      const editItem = document.createElement("div");
      editItem.className = "ctx-item";
      const editLabel = document.createElement("span");
      editLabel.className = "ctx-item-label";
      editLabel.textContent = "✎ Edit affirmation lines…";
      editItem.appendChild(editLabel);
      editItem.addEventListener("click", () => { closeContextMenu(); openAffirmationQuotesModal(); });
      ctxMenu.appendChild(editItem);
    }

    // Glow effect picker — several intensities/speeds rather than a plain
    // on/off toggle, plus "None" to turn it off. Reuses the same
    // label-then-row layout as the branch color swatches below.
    {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const label = document.createElement("div");
      label.className = "ctx-item"; label.style.cursor = "default";
      label.textContent = "Glow effect";
      ctxMenu.appendChild(label);

      const row = document.createElement("div");
      row.className = "ctx-glow-options";
      const GLOW_OPTIONS = [
        [null, "None"],
        ["soft", "Soft"],
        ["fast", "Fast"],
        ["blink", "Blink"],
      ];
      const currentGlow = node.glow === true ? "soft" : (node.glow || null);
      GLOW_OPTIONS.forEach(([value, glowLabel]) => {
        const opt = document.createElement("span");
        opt.className = "ctx-glow-opt" + (currentGlow === value ? " active" : "");
        opt.textContent = glowLabel;
        opt.addEventListener("click", () => {
          pushUndo();
          node.glow = value;
          closeContextMenu();
          renderAll();
          persist();
        });
        row.appendChild(opt);
      });
      ctxMenu.appendChild(row);
    }

    // Connector style — map-wide default, so it only makes sense to offer
    // on the root (level 0) node rather than per-branch. Any individual
    // node's or connector's own picker can still override it for just
    // that hop (see the bulk "children" picker below, and
    // openConnectorContextMenu for a single hop).
    if (node === state.current.root) {
      renderConnectorStyleRow(ctxMenu, "Connector style",
        () => {
          ensureTheme(state.current);
          return state.current.theme.connectorArrow ? "arrow" : (state.current.theme.connectorShape || "curved");
        },
        (val) => {
          ensureTheme(state.current);
          if (val === "arrow") {
            state.current.theme.connectorArrow = true;
          } else {
            state.current.theme.connectorArrow = false;
            state.current.theme.connectorShape = val;
          }
        }
      );
    }

    // A "mother" node with children gets a single input that sets the
    // distance for ALL of its direct children's connectors at once — the
    // per-connector right-click menu (see openConnectorContextMenu) still
    // works for tweaking just one, but this is the quick way to set them
    // all the same when you don't want to click each one individually.
    if (node.children && node.children.length) {
      const sep0 = document.createElement("div"); sep0.className = "ctx-sep"; ctxMenu.appendChild(sep0);
      const distLabel = document.createElement("div");
      distLabel.className = "ctx-item";
      distLabel.style.cursor = "default";
      distLabel.textContent = "Children distance";
      ctxMenu.appendChild(distLabel);

      const distRow = document.createElement("div");
      distRow.className = "ctx-distance-row";
      const distInput = document.createElement("input");
      distInput.type = "number";
      distInput.min = String(MIN_X_GAP);
      distInput.max = String(MAX_X_GAP);
      distInput.step = "5";
      distInput.value = Math.round(gapFor(node.children[0]));
      distInput.className = "ctx-distance-input";
      distRow.appendChild(distInput);
      const distUnit = document.createElement("span");
      distUnit.className = "ctx-distance-unit";
      distUnit.textContent = "px";
      distRow.appendChild(distUnit);
      ctxMenu.appendChild(distRow);

      distRow.addEventListener("click", (e) => e.stopPropagation());
      distInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { distInput.blur(); closeContextMenu(); }
      });
      distInput.addEventListener("change", () => {
        const v = parseFloat(distInput.value);
        if (Number.isNaN(v)) return;
        const clamped = Math.max(MIN_X_GAP, Math.min(MAX_X_GAP, Math.round(v)));
        pushUndo();
        node.children.forEach(c => { c.xGap = clamped; });
        renderAll();
        persist();
      });

      const anyCustomGap = node.children.some(c => typeof c.xGap === "number" && c.xGap >= 0);
      if (anyCustomGap) {
        const resetAll = document.createElement("div");
        resetAll.className = "ctx-item";
        resetAll.textContent = "Reset all to default spacing";
        resetAll.addEventListener("click", () => {
          closeContextMenu();
          pushUndo();
          node.children.forEach(c => { c.xGap = null; });
          renderAll();
          persist();
        });
        ctxMenu.appendChild(resetAll);
      }

      // Bulk connector style — same combined Curved/Elbow/Arrow picker as
      // the per-connector menu (see openConnectorContextMenu), but applied
      // to every direct child's connector at once instead of one at a time.
      renderConnectorStyleRow(ctxMenu, "Children connector style",
        () => {
          ensureTheme(state.current);
          const values = node.children.map((c) => {
            if (c.connectorStyle === "arrow") return "arrow";
            if (c.connectorStyle === "line") return c.connectorShape || state.current.theme.connectorShape || "curved";
            return state.current.theme.connectorArrow ? "arrow" : (c.connectorShape || state.current.theme.connectorShape || "curved");
          });
          return values.every(v => v === values[0]) ? values[0] : null;
        },
        (val) => {
          node.children.forEach((c) => {
            if (val === "arrow") {
              c.connectorStyle = "arrow";
            } else {
              c.connectorStyle = "line";
              c.connectorShape = val;
            }
          });
        }
      );
    }

    const existingLinks = linksForNode(node.id);
    if (existingLinks.length) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      for (const link of existingLinks) {
        const otherId = link.a === node.id ? link.b : link.a;
        const other = findNode(otherId);
        const it = document.createElement("div");
        it.className = "ctx-item danger";
        it.textContent = `Remove link to "${other ? (other.text || "(untitled)") : "unknown node"}"`;
        it.addEventListener("click", () => { closeContextMenu(); removeLink(link.id); });
        ctxMenu.appendChild(it);
      }
    }

    const topAncestor = findTopAncestor(node);
    if (topAncestor) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const label = document.createElement("div");
      label.className = "ctx-item"; label.style.cursor = "default";
      label.textContent = "Branch color";
      ctxMenu.appendChild(label);
      const sw = document.createElement("div"); sw.className = "ctx-swatches";
      PALETTE.forEach(c => {
        const s = document.createElement("span");
        s.className = "ctx-swatch" + (topAncestor.color === c ? " active" : "");
        s.style.background = c;
        s.addEventListener("click", () => { pushUndo(); topAncestor.color = c; closeContextMenu(); renderAll(); persist(); });
        sw.appendChild(s);
      });
      ctxMenu.appendChild(sw);
    }

    if (findParent(node.id)) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const del = document.createElement("div");
      del.className = "ctx-item danger";
      del.textContent = "Delete branch (Del)";
      del.addEventListener("click", () => { closeContextMenu(); deleteBranch(node.id); });
      ctxMenu.appendChild(del);
    }

    positionContextMenu(x, y);
  }

  function openLinkContextMenu(x, y, link) {
    resetContextMenu();
    const del = document.createElement("div");
    del.className = "ctx-item danger";
    del.textContent = "Delete link";
    del.addEventListener("click", () => { closeContextMenu(); removeLink(link.id); });
    ctxMenu.appendChild(del);

    positionContextMenu(x, y);
  }

  const MIN_X_GAP = 60;
  const MAX_X_GAP = 900;

  // Right-click on a parent→child connector: lets the user type an exact
  // pixel distance for that one hop (see gapFor/place/placeLocal), instead
  // of only being able to eyeball it by dragging.
  function openConnectorContextMenu(x, y, parent, child) {
    resetContextMenu();

    const isCustom = typeof child.xGap === "number" && child.xGap >= 0;
    const currentGap = isCustom ? child.xGap : defaultGapForDepth(child._depth);

    const label = document.createElement("div");
    label.className = "ctx-item";
    label.style.cursor = "default";
    label.textContent = "Connector distance";
    ctxMenu.appendChild(label);

    const row = document.createElement("div");
    row.className = "ctx-distance-row";
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(MIN_X_GAP);
    input.max = String(MAX_X_GAP);
    input.step = "5";
    input.value = Math.round(currentGap);
    input.className = "ctx-distance-input";
    row.appendChild(input);
    const unit = document.createElement("span");
    unit.className = "ctx-distance-unit";
    unit.textContent = "px";
    row.appendChild(unit);
    ctxMenu.appendChild(row);

    // Keep clicks/typing in the input from bubbling to the document-level
    // listener that closes the menu on any outside click.
    row.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { input.blur(); closeContextMenu(); }
    });
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (Number.isNaN(v)) return;
      const clamped = Math.max(MIN_X_GAP, Math.min(MAX_X_GAP, Math.round(v)));
      pushUndo();
      child.xGap = clamped;
      renderAll();
      persist();
    });

    if (isCustom) {
      const sep = document.createElement("div"); sep.className = "ctx-sep"; ctxMenu.appendChild(sep);
      const reset = document.createElement("div");
      reset.className = "ctx-item";
      reset.textContent = "Reset to default spacing";
      reset.addEventListener("click", () => {
        closeContextMenu();
        pushUndo();
        child.xGap = null;
        renderAll();
        persist();
      });
      ctxMenu.appendChild(reset);
    }

    renderConnectorStyleRow(ctxMenu, "Connector style",
      () => {
        ensureTheme(state.current);
        if (child.connectorStyle === "arrow") return "arrow";
        if (child.connectorStyle === "line") return child.connectorShape || state.current.theme.connectorShape || "curved";
        return state.current.theme.connectorArrow ? "arrow" : (child.connectorShape || state.current.theme.connectorShape || "curved");
      },
      (val) => {
        if (val === "arrow") {
          child.connectorStyle = "arrow";
        } else {
          child.connectorStyle = "line";
          child.connectorShape = val;
        }
      }
    );

    positionContextMenu(x, y);
    setTimeout(() => input.focus(), 0);
  }

  // Flattens a node and its descendants into an indented outline, e.g.:
  //   Project Launch
  //     - Research
  //       - Competitors
  //       - Market size
  //     - Design
  // Each level adds two spaces of indent plus a "- " marker, so depth
  // stays readable even if leading whitespace gets collapsed by whatever
  // it's pasted into (email clients, chat apps, etc. often strip runs of
  // spaces) — the accumulating "- " prefixes still show the level.
  function nodeBranchToOutline(node) {
    const lines = [];
    (function walk(n, depth) {
      const label = (n.text || "(untitled)").trim() || "(untitled)";
      const indent = "  ".repeat(depth);
      const marker = depth ? "- " : "";
      lines.push(indent + marker + label);
      (n.children || []).filter(Boolean).forEach(c => walk(c, depth + 1));
    })(node, 0);
    return lines.join("\n");
  }

  async function copyNodeBranchToClipboard(node) {
    const text = nodeBranchToOutline(node);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("no clipboard API");
      }
      showToast("Copied to clipboard");
    } catch (err) {
      // Fallback for browsers/contexts without navigator.clipboard
      // (e.g. non-secure local file contexts in some browsers).
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Copied to clipboard");
      } catch (err2) {
        showToast("Couldn't copy — try again");
      }
    }
  }

  let toastEl = null;
  let toastHideTimer = null;
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "app-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth; // restart CSS transition
    toastEl.classList.add("show");
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  function findTopAncestor(node) {
    if (!state.current) return null;
    if (node === state.current.root) return null;
    let found = null;
    (function walk(n, top) {
      for (const c of n.children || []) {
        const t = top || c;
        if (c === node) { found = t; return; }
        walk(c, t);
      }
    })(state.current.root, null);
    return found;
  }

  let ctxMenuDragging = false;
  function closeContextMenu() { if (!ctxMenuDragging) ctxMenu.classList.add("hidden"); }
  document.addEventListener("click", closeContextMenu);
  document.addEventListener("scroll", closeContextMenu, true);

  // Lets the context menu (right-click on desktop, long-press on touch)
  // be dragged around by its handle strip — mainly for touch, where
  // there's no way to just right-click again somewhere else if the menu
  // landed somewhere inconvenient (e.g. partly under a thumb, or over the
  // node it's acting on).
  (function initContextMenuDrag() {
    let startX, startY, startLeft, startTop;
    function onMove(e) {
      // Touch fires pointermove continuously while dragging, same as
      // mousemove — no per-event work here beyond the clamp, so this stays
      // smooth even while the menu's own content is mid-scroll from the
      // sticky-handle drag.
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const rect = ctxMenu.getBoundingClientRect();
      const margin = 8; // same margin positionContextMenu() uses when the menu first opens
      const left = clamp(startLeft + dx, margin, Math.max(margin, window.innerWidth - rect.width - margin));
      const top = clamp(startTop + dy, margin, Math.max(margin, window.innerHeight - rect.height - margin));
      ctxMenu.style.left = left + "px";
      ctxMenu.style.top = top + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ctxMenu.classList.remove("dragging");
      // Same trick as the note-resize handle: a drag that ends up back
      // over the menu (or over the page behind it) fires a "click" right
      // after this mouseup/touchend, which would otherwise close the menu
      // the instant you finish dragging it. Deferring the flag reset lets
      // that synchronous click see the drag as still "in progress".
      setTimeout(() => { ctxMenuDragging = false; }, 0);
    }
    function onStart(e) {
      if (!e.target.classList.contains("ctx-drag-handle")) return;
      e.preventDefault();
      e.stopPropagation();
      ctxMenuDragging = true;
      ctxMenu.classList.add("dragging");
      startX = e.clientX;
      startY = e.clientY;
      const rect = ctxMenu.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
    ctxMenu.addEventListener("mousedown", onStart);
    ctxMenu.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      onStart(e);
    });
  })();

  /* ---------------- canvas pan / zoom ---------------- */

  function applyTransform() {
    worldEl.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    // Only promote #world to its own composited GPU layer *while* pan/zoom
    // is actually moving. Chromium (and others) render a composited layer
    // by scaling a cached bitmap rather than re-rasterizing text/lines at
    // the new scale, which is what was making the map look blurry once
    // zoomed in — especially visible on a high-DPI/4K display. Dropping
    // will-change back to "auto" a beat after the last change forces a
    // fresh, crisp repaint at rest; it's re-applied on the next move so
    // panning/zooming itself still stays smooth.
    worldEl.style.willChange = "transform";
    if (transformSettleTimer) clearTimeout(transformSettleTimer);
    transformSettleTimer = setTimeout(() => { worldEl.style.willChange = "auto"; }, 160);
  }
  let transformSettleTimer = null;

  let panning = false, panStart = null;
  // Set while two (or more) touches are down at once — drives pinch-zoom
  // instead of the single-finger pan/drag handling below. See the
  // viewportEl pointerdown listener for how it's populated.
  let pinchState = null;

  function startPan(clientX, clientY) {
    commitEditIfActive();
    panning = true;
    panStart = { x: clientX, y: clientY, tx: state.tx, ty: state.ty };
    viewportEl.classList.add("panning");
    state.selectedId = null;
    state.editingId = null;
    state.linkFromId = null;
    renderAll();
  }

  viewportEl.addEventListener("mousedown", (e) => {
    if (e.target.closest(".node") || e.target.closest("#node-fabs")) return;
    startPan(e.clientX, e.clientY);
  });

  // Touch handling for pan/pinch-zoom lives separately from the mouse path
  // above rather than trying to reuse mousedown, since touch needs to
  // recognize a *second* finger landing (anywhere, including on top of a
  // node) as the start of a pinch. This listener runs in the capture phase
  // so it always sees every touch inside the viewport even though a node's
  // own pointerdown handler (bubble phase, see beginNodeDrag) stops
  // propagation for its own purposes.
  viewportEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      // Second finger down — cleanly end whatever single-finger gesture
      // (pan or node drag) the first finger had already started, then
      // switch entirely to pinch-zoom.
      finishInteraction();
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
      const rect = viewportEl.getBoundingClientRect();
      pinchState = {
        startDist: dist,
        startScale: state.scale,
        // World-space point currently under the pinch midpoint — held
        // fixed under the fingers as they move, the same way the wheel
        // zoom below keeps the point under the cursor fixed.
        anchorX: (midX - rect.left - state.tx) / state.scale,
        anchorY: (midY - rect.top - state.ty) / state.scale
      };
    } else if (activePointers.size === 1 && !e.target.closest(".node") && !e.target.closest("#node-fabs")) {
      startPan(e.clientX, e.clientY);
    }
  }, { capture: true });

  function handleMoveAt(e) {
    if (panning) {
      state.tx = panStart.tx + (e.clientX - panStart.x);
      state.ty = panStart.ty + (e.clientY - panStart.y);
      applyTransform();
      return;
    }
    if (!dragCandidate) return;
    const node = findNode(dragCandidate.id);
    if (!node) { dragCandidate = null; return; }
    const dxScreen = e.clientX - dragCandidate.startClientX;
    const dyScreen = e.clientY - dragCandidate.startClientY;
    if (!dragCandidate.moved) {
      if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD) return;
      dragCandidate.moved = true;
      pushUndo();
      const div = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
      // Cache the dragged node's own div and every descendant's div once,
      // here, rather than re-querying the DOM on every mousemove — the
      // per-frame handler below only ever touches these cached elements.
      dragCandidate.div = div;
      dragCandidate.descendants.forEach(d => {
        d.div = nodesLayer.querySelector(`.node[data-id="${d.id}"]`);
        // Descendants ride along via the same live-drag transform as the
        // dragged node itself (see the mousemove handler) but don't carry
        // the .dragging class that gives it a will-change hint — set it
        // directly so the whole branch gets promoted to the compositor,
        // not just the node under the cursor.
        if (d.div) d.div.style.willChange = "transform";
      });
      if (div) {
        div.classList.add("dragging");
        // The dragged box always sits right under the cursor, so without
        // this, elementFromPoint below would just find itself and never
        // the node underneath it that it's about to be dropped onto.
        div.style.pointerEvents = "none";
      }
    }
    const dxLocal = dxScreen / state.scale;
    const dyLocal = dyScreen / state.scale;
    node.ox = dragCandidate.startOx + dxLocal;

    // Flip immediately if this drag just carried the node across the
    // center line — see maybeFlipSideDuringDrag for how it keeps the node
    // under the cursor and lets its children reflow to the new side right
    // away, while the mouse is still held.
    const flipped = maybeFlipSideDuringDrag(node, dxLocal, dyLocal);

    // Where the node "wants" to be vertically, tracked from the drag start
    // rather than from node._y directly, so it stays correct across any
    // sibling reorder that happens below.
    const targetAbsY = dragCandidate.startAbsY + dyLocal;
    const reordered = maybeReorderSiblings(node, targetAbsY);
    node.oy = targetAbsY - node._y;

    if (reordered || flipped) {
      // Sibling order or side changed — everyone needs a fresh layout pass,
      // not just this node, so the siblings/descendants that shifted are
      // actually redrawn. repositionAll(true) re-runs layout but moves
      // existing DOM elements in place rather than wiping and recreating
      // them (that full rebuild is what caused the visible blink crossing
      // the center line), and keeps the canvas origin frozen so unrelated
      // nodes — like the dragged node's parent or the root — don't visibly
      // shift just because the bounding box changed shape mid-drag. The
      // canvas gets resized/recentered properly once the drag ends.
      repositionAll(true);
      // repositionAll just wrote fresh left/top for this node (and every
      // descendant, via the loop below) reflecting the FULL delta so far.
      // Any transform left over from the plain-drag path below would now
      // double-count that delta, and the running "baked" total needs to
      // catch up to match, so the next plain-drag frame computes the right
      // remaining delta instead of jumping.
      if (dragCandidate.div) dragCandidate.div.style.transform = "";
      dragCandidate.descendants.forEach(d => { if (d.div) d.div.style.transform = ""; });
      dragCandidate.bakedDx = dxLocal;
      dragCandidate.bakedDy = dyLocal;
    } else {
      // No reorder/flip this frame — the common case on every mousemove.
      // Rewriting left/top here (as updateNodePositionDom does) forces the
      // browser to lay out and repaint the whole node box every frame,
      // including everything rendered inside it — a big photo strip makes
      // that repaint far more expensive, which is exactly what made drags
      // feel unsmooth on photo-heavy nodes. A CSS transform for just the
      // delta since the last full reposition is compositor-only: the node
      // (photos and all) is repainted once, then just moved as a bitmap,
      // so the drag stays smooth regardless of how much is inside the box.
      const tdx = dxLocal - dragCandidate.bakedDx;
      const tdy = dyLocal - dragCandidate.bakedDy;
      const t = `translate(${tdx}px, ${tdy}px)`;
      if (dragCandidate.div) dragCandidate.div.style.transform = t;
      dragCandidate.descendants.forEach(d => { if (d.div) d.div.style.transform = t; });
      // Connector lines are cheap SVG path updates (not affected by photo
      // count), so they still get refreshed every frame for a live feel.
      refreshConnectorsFor(node);
    }

    // Carry every descendant along by the same delta so a branch moves as
    // one rigid unit instead of the parent sliding out from under its kids.
    dragCandidate.descendants.forEach(d => {
      const dNode = findNode(d.id);
      if (!dNode) return;
      dNode.ox = d.startOx + dxLocal;
      dNode.oy = d.startOy + dyLocal;
      if (reordered || flipped) {
        // A full reposition already ran above (using each descendant's
        // pre-update ox/oy) — redo it now that the up-to-date offsets are
        // set, so descendants land exactly on this frame's delta too.
        updateNodePositionDom(dNode);
      } else {
        // Position is already handled by the shared transform above; just
        // keep this descendant's connectors in sync.
        refreshConnectorsFor(dNode);
      }
    });

    // The central node has nowhere to be reparented to, so only offer a
    // drop target for everything else.
    if (findParent(node.id)) updateDropTarget(e, node);
  }
  window.addEventListener("mousemove", handleMoveAt);
  // Touch/pen pointermove: pinch-zoom takes priority whenever two touches
  // are down; otherwise it's the same pan/node-drag handling as mouse.
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") return;
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchState && activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
      const newScale = clamp(pinchState.startScale * (dist / pinchState.startDist), 0.25, 2.5);
      const rect = viewportEl.getBoundingClientRect();
      state.scale = newScale;
      state.tx = (midX - rect.left) - pinchState.anchorX * newScale;
      state.ty = (midY - rect.top) - pinchState.anchorY * newScale;
      applyTransform();
      return;
    }
    handleMoveAt(e);
  });
  function finishInteraction() {
    if (panning) { panning = false; viewportEl.classList.remove("panning"); persistViewOnly(); }
    if (dragCandidate) {
      const node = findNode(dragCandidate.id);
      const moved = dragCandidate.moved;
      const dropTargetId = dragCandidate.dropTargetId;
      if (node) {
        const div = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
        if (div) { div.classList.remove("dragging"); div.style.pointerEvents = ""; div.style.transform = ""; }
      }
      // Clear any leftover live-drag transform (and its will-change hint)
      // on the descendants too — repositionAll/reparentNode below
      // re-establish the real left/top, but neither touches these.
      dragCandidate.descendants.forEach(d => {
        if (d.div) { d.div.style.transform = ""; d.div.style.willChange = ""; }
      });
      if (dropTargetId) {
        const targetDiv = nodesLayer.querySelector(`.node[data-id="${dropTargetId}"]`);
        if (targetDiv) targetDiv.classList.remove("drop-target");
      }
      if (moved && node && dropTargetId) {
        reparentNode(node.id, dropTargetId);
      } else if (moved && node) {
        // Live flip during the drag (see maybeFlipSideDuringDrag) already
        // keeps side in sync on every frame — this only catches the rare
        // case a flip is still needed right at the moment of release.
        const worldXAtDrop = node._x + (node.ox || 0);
        if (maybeFlipSideOnDrop(node)) {
          layout(state.current.root);
          // Keep the node exactly where it visually was at release instead
          // of letting it jump to the new side's raw slot center.
          node.ox = worldXAtDrop - node._x;
        }
        // Deliberately no ox/oy reset here. They're already recomputed
        // fresh on every mousemove to reflect exactly where the node was
        // dragged to relative to its current (possibly reordered or
        // flipped) automatic slot — there's nothing to "clean up". Zeroing
        // them unconditionally used to snap the node onto its slot's raw
        // center on drop, and since whether a reorder happened was tracked
        // with a flag that, once set, never cleared even if a later swing
        // of the drag undid it, a long or fast drag could end up snapping
        // the node all the way back to right where it started.
        //
        // The canvas origin/size was frozen for the whole drag (see
        // repositionAll's freezeOrigin) so nothing not actually moving —
        // like the dragged node's parent or the root — visibly drifted.
        // Now that the drag is over, settle it properly in one shot.
        repositionAll(false);
      }
      dragCandidate = null;
      if (moved) { suppressNextNodeClick = true; persist(); }
    }
  }
  window.addEventListener("mouseup", finishInteraction);
  function onTouchPointerEnd(e) {
    if (e.pointerType === "mouse") return;
    activePointers.delete(e.pointerId);
    if (pinchState) {
      if (activePointers.size < 2) {
        pinchState = null;
        persistViewOnly();
        if (activePointers.size === 1) {
          // One finger remains down after the pinch ends — resume panning
          // from here instead of leaving the gesture stuck until the next
          // fresh touch.
          const remaining = Array.from(activePointers.values())[0];
          startPan(remaining.x, remaining.y);
        }
      }
      return;
    }
    finishInteraction();
  }
  window.addEventListener("pointerup", onTouchPointerEnd);
  window.addEventListener("pointercancel", onTouchPointerEnd);

  viewportEl.addEventListener("wheel", (e) => {
    if (!state.current) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.0012;
    const newScale = clamp(state.scale * (1 + delta), 0.25, 2.5);
    const rect = viewportEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - state.tx) / state.scale, wy = (my - state.ty) / state.scale;
    state.tx = mx - wx * newScale;
    state.ty = my - wy * newScale;
    state.scale = newScale;
    applyTransform();
    persistViewOnly();
  }, { passive: false });

  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#zoom-in").addEventListener("click", () => { state.scale = clamp(state.scale * 1.15, 0.25, 2.5); applyTransform(); persistViewOnly(); });
  $("#zoom-out").addEventListener("click", () => { state.scale = clamp(state.scale / 1.15, 0.25, 2.5); applyTransform(); persistViewOnly(); });
  $("#zoom-reset").addEventListener("click", () => { state.scale = 1; state.tx = 60; state.ty = 60; applyTransform(); persistViewOnly(); });

  // Floating add-child / add-sibling buttons — same effect as the Tab/Enter
  // shortcuts, for anyone who'd rather click (or has no keyboard handy).
  // Falls back to the central node when nothing is selected yet, same as
  // the global Tab/Enter handler above.
  function fabTargetNode() {
    if (!state.current) return null;
    // render: false — the fab click handlers below set state.selectedId /
    // state.editingId for the *new* node right after this returns, then do
    // their own single renderAll(). That renderAll() both commits the DOM
    // change that drops the old node out of edit mode and creates+focuses
    // the new node's div in one pass, instead of two renderAll() passes
    // back-to-back (see commitEditIfActive's comment for why that matters).
    commitEditIfActive({ render: false });
    return (state.selectedId && findNode(state.selectedId)) || state.current.root;
  }
  // Belt-and-suspenders alongside the closest("#node-fabs") checks in the
  // pan-start handlers above: stop the mousedown here too so a click never
  // races a pan-start that would null out state.selectedId first.
  $("#fab-add-child").addEventListener("mousedown", (e) => e.stopPropagation());
  $("#fab-add-sibling").addEventListener("mousedown", (e) => e.stopPropagation());
  $("#fab-add-child").addEventListener("click", () => {
    const node = fabTargetNode();
    if (!node) return;
    const n = addChild(node.id);
    if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
    persist();
  });
  $("#fab-add-sibling").addEventListener("click", () => {
    const node = fabTargetNode();
    if (!node) return;
    const n = addSibling(node.id);
    if (n) { state.selectedId = n.id; state.editingId = n.id; renderAll(); }
    persist();
  });

  /* ---------------- toolbar ---------------- */

  titleInput.addEventListener("input", () => {
    if (!state.current) return;
    state.current.title = titleInput.value;
    // Keep the central node's text in sync with the title field, the same
    // way editing the central node itself updates the title (see commitEdit).
    if (state.current.root.text !== titleInput.value) {
      state.current.root.text = titleInput.value;
      renderAll();
    }
    renderSidebar();
    persist();
  });
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") titleInput.blur(); });

  layoutSelect.addEventListener("change", () => {
    if (!state.current) return;
    state.current.layout = layoutSelect.value;
    state.selectedId = null;
    renderAll();
    persist();
  });

  $("#btn-new-map").addEventListener("click", createMap);
  $("#btn-empty-new").addEventListener("click", createMap);
  $("#btn-delete-map").addEventListener("click", () => { if (state.current) deleteMap(state.current.id); });

  // Clears every node's manual drag offset (ox/oy) in one go, so the whole
  // map snaps back to the automatic layout — the fix for branches that have
  // drifted into overlapping each other after being nudged around.
  function autoArrange() {
    if (!state.current) return;
    let touched = false;
    (function check(n) {
      if (n.ox || n.oy) touched = true;
      (n.children || []).forEach(check);
    })(state.current.root);
    if (!touched) return;
    pushUndo();
    (function clear(n) {
      delete n.ox; delete n.oy;
      (n.children || []).forEach(clear);
    })(state.current.root);
    renderAll();
    persist();
  }
  $("#btn-auto-arrange").addEventListener("click", autoArrange);

  $("#btn-help").addEventListener("click", () => $("#help-modal").classList.remove("hidden"));
  $("#help-close").addEventListener("click", () => $("#help-modal").classList.add("hidden"));
  $("#help-modal").addEventListener("click", (e) => { if (e.target.id === "help-modal") e.currentTarget.classList.add("hidden"); });

  $("#btn-export").addEventListener("click", () => {
    if (!state.current) return;
    const blob = new Blob([JSON.stringify(state.current, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.current.title || "mindmap").replace(/[^a-z0-9\-_]+/gi, "_") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.root || !data.root.id) throw new Error("bad format");
      data.id = uid(); // avoid collisions
      data.updatedAt = Date.now();
      ensureTheme(data);
      ensureLayout(data);
      ensureFavorite(data);
      ensureSidesRepaired(data);
      state.maps.unshift(data);
      sortMaps(state.maps);
      await DB.put(data);
      await FolderDB.save(data);
      await DriveDB.save(data);
      await openMap(data.id);
    } catch (err) {
      alert("Couldn't import that file — it doesn't look like a Branchline map.");
    }
    e.target.value = "";
  });

  /* ---------------- global shortcuts (map list / new) ---------------- */

  document.addEventListener("keydown", (e) => {
    const activeIsEditable = document.activeElement && (document.activeElement.isContentEditable || document.activeElement.tagName === "INPUT");
    if (activeIsEditable) return;
    if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey) createMap();
  });

  /* ---------------- theme panel ---------------- */

  const themeModal = $("#theme-modal");
  const bgInput = $("#theme-bg");
  const connectorModeSel = $("#theme-connector-mode");
  const connectorColorInput = $("#theme-connector-color");
  const fontModeSel = $("#theme-font-mode");
  const fontColorInput = $("#theme-font-color");

  function openThemePanel() {
    if (!state.current) return;
    ensureTheme(state.current);
    const t = state.current.theme;
    bgInput.value = t.background || defaultBg();
    connectorModeSel.value = t.connectorMode;
    connectorColorInput.value = t.connectorColor;
    connectorColorInput.disabled = t.connectorMode !== "custom";
    fontModeSel.value = t.fontMode;
    fontColorInput.value = t.fontColor;
    fontColorInput.disabled = t.fontMode !== "custom";
    themeModal.classList.remove("hidden");
  }

  function updateTheme(patch) {
    if (!state.current) return;
    Object.assign(state.current.theme, patch);
    applyTheme();
    renderAll();
    persist();
  }

  $("#btn-theme").addEventListener("click", openThemePanel);
  $("#theme-close").addEventListener("click", () => themeModal.classList.add("hidden"));
  themeModal.addEventListener("click", (e) => { if (e.target === themeModal) themeModal.classList.add("hidden"); });

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

  // Photos are stored exactly as provided — no downscaling, no lossy
  // re-encoding — so what you attach is byte-for-byte what you get back.
  // Accepts one or more files and appends each as a new photo on the
  // node, rather than replacing whatever is already attached.
  const nodeImageInput = $("#node-image-input");
  const photoModal = $("#photo-modal");
  const photoModalImg = $("#photo-modal-img");
  let pendingPhotoNodeId = null;

  function openNodePhotoPicker(nodeId) {
    pendingPhotoNodeId = nodeId;
    nodeImageInput.click();
  }

  function handleNodePhotoFiles(nodeId, fileList) {
    const node = findNode(nodeId);
    const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith("image/"));
    if (!node || !files.length) return;
    if (!Array.isArray(node.images)) node.images = getNodeImages(node);
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
        node.images.push(reader.result);
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

  // Paste a screenshot (or any copied image) straight onto the selected
  // node as a photo — no need to save it to disk first and go through
  // "Add photo…". Only kicks in when the paste isn't headed for a text
  // field (typing into a node, a modal, the title bar, etc. — those get
  // to handle their own paste, e.g. the note editor's own image-paste
  // support) and no modal is currently open, so it can't hijack a paste
  // the person meant for something else.
  document.addEventListener("paste", (e) => {
    if (!state.current || !state.selectedId || state.editingId) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (document.querySelector(".modal:not(.hidden)")) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageItem = Array.from(items).find(i => i.type && i.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    handleNodePhotoFiles(state.selectedId, [file]);
  });

  // Gallery state for the lightbox — which node's photos, and which index.
  let photoModalState = null;
  const photoModalPrev = $("#photo-modal-prev");
  const photoModalNext = $("#photo-modal-next");
  const photoModalCount = $("#photo-modal-count");
  const photoModalDelete = $("#photo-modal-delete");
  const photoModalClose = $("#photo-modal-close");

  // Crop button — built here rather than in index.html so the whole
  // feature lives in this one file. Styled like the delete button, just
  // shifted further from the corner so the two don't overlap.
  const photoModalCrop = document.createElement("button");
  photoModalCrop.id = "photo-modal-crop";
  photoModalCrop.className = "photo-modal-delete";
  photoModalCrop.title = "Crop this photo";
  photoModalCrop.setAttribute("aria-label", "Crop this photo");
  photoModalCrop.textContent = "⛶";
  photoModalCrop.style.right = "calc(4vw + 72px)";
  photoModal.querySelector(".photo-modal-card").appendChild(photoModalCrop);

  // Text button — sits one slot further out than crop, same styling.
  // Lets the user drop editable labels onto the photo and bake them in.
  const photoModalText = document.createElement("button");
  photoModalText.id = "photo-modal-text";
  photoModalText.className = "photo-modal-delete";
  photoModalText.title = "Add text to this photo";
  photoModalText.setAttribute("aria-label", "Add text to this photo");
  photoModalText.textContent = "Aa";
  photoModalText.style.right = "calc(4vw + 116px)";
  photoModalText.style.fontSize = "12px";
  photoModalText.style.fontWeight = "700";
  photoModal.querySelector(".photo-modal-card").appendChild(photoModalText);

  let cropping = false;
  let cropCleanup = null;
  let addingText = false;
  let textCleanup = null;
  let rearmTextPlacement = null;

  // ---- Scroll-to-zoom on the photo preview ----
  // A separate pan/zoom of just the currently displayed photo (independent
  // of the mindmap canvas's own zoom) — scroll to zoom in/out toward the
  // cursor, drag to pan around once zoomed in. Resets whenever a different
  // photo is shown, or the modal is closed.
  let photoZoom = { scale: 1, tx: 0, ty: 0 };
  const PHOTO_ZOOM_MIN = 1, PHOTO_ZOOM_MAX = 6;

  function applyPhotoZoom() {
    photoModalImg.style.transform = photoZoom.scale === 1
      ? ""
      : `translate(${photoZoom.tx}px, ${photoZoom.ty}px) scale(${photoZoom.scale})`;
    photoModalImg.classList.toggle("zoomed", photoZoom.scale > 1);
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
    const rect = photoModalImg.getBoundingClientRect();
    // Cursor's offset from the image's current (already zoomed/panned)
    // on-screen center — used to keep the point under the cursor fixed
    // as the scale changes, so zooming feels anchored to the mouse
    // rather than always zooming toward the photo's center.
    const offX = e.clientX - (rect.left + rect.width / 2);
    const offY = e.clientY - (rect.top + rect.height / 2);
    const prevScale = photoZoom.scale;
    const delta = -e.deltaY * 0.0018;
    const newScale = clamp(prevScale * (1 + delta), PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
    if (newScale === prevScale) return;
    const factor = newScale / prevScale;
    photoZoom.tx += offX * (1 - factor);
    photoZoom.ty += offY * (1 - factor);
    photoZoom.scale = newScale;
    if (photoZoom.scale === PHOTO_ZOOM_MIN) { photoZoom.tx = 0; photoZoom.ty = 0; }
    applyPhotoZoom();
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

  function openPhotoModal(nodeId, index) {
    const node = findNode(nodeId);
    const images = getNodeImages(node);
    if (!images.length) return;
    photoModalState = { nodeId, index: clamp(index || 0, 0, images.length - 1) };
    resetPhotoZoom();
    renderPhotoModal();
    photoModal.classList.remove("hidden");
  }
  function renderPhotoModal() {
    if (!photoModalState) return;
    const images = getNodeImages(findNode(photoModalState.nodeId));
    if (!images.length) { closePhotoModal(); return; }
    if (photoModalState.index >= images.length) photoModalState.index = images.length - 1;
    photoModalImg.src = images[photoModalState.index];
    const multi = images.length > 1;
    photoModalPrev.classList.toggle("hidden", !multi);
    photoModalNext.classList.toggle("hidden", !multi);
    photoModalCount.classList.toggle("hidden", !multi);
    photoModalCount.textContent = multi ? `${photoModalState.index + 1} / ${images.length}` : "";
  }
  function closePhotoModal() {
    photoModal.classList.add("hidden");
    photoModalImg.src = "";
    photoModalState = null;
    resetPhotoZoom();
  }
  function stepPhotoModal(delta) {
    if (!photoModalState) return;
    const images = getNodeImages(findNode(photoModalState.nodeId));
    if (!images.length) return;
    photoModalState.index = (photoModalState.index + delta + images.length) % images.length;
    resetPhotoZoom();
    renderPhotoModal();
  }
  photoModalClose.addEventListener("click", closePhotoModal);
  photoModalPrev.addEventListener("click", (e) => { e.stopPropagation(); stepPhotoModal(-1); });
  photoModalNext.addEventListener("click", (e) => { e.stopPropagation(); stepPhotoModal(1); });
  photoModalDelete.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!photoModalState) return;
    const node = findNode(photoModalState.nodeId);
    if (!node) return;
    const images = getNodeImages(node);
    if (!images.length) return;
    pushUndo();
    images.splice(photoModalState.index, 1);
    node.images = images;
    node.image = null;
    renderAll();
    persist();
    if (!images.length) closePhotoModal(); else renderPhotoModal();
  });
  photoModal.addEventListener("click", (e) => { if (e.target === photoModal && !cropping && !addingText) closePhotoModal(); });
  document.addEventListener("keydown", (e) => {
    if (photoModal.classList.contains("hidden")) return;
    if (e.key === "Escape") { if (cropping) cropCleanup(); else if (addingText) textCleanup(); else closePhotoModal(); }
    else if (cropping || addingText) return;
    else if (e.key === "ArrowLeft") stepPhotoModal(-1);
    else if (e.key === "ArrowRight") stepPhotoModal(1);
  });

  // ---- Crop ----
  // Lets the user drag out a rectangle over the currently displayed photo
  // and replace it with just that region. Built with plain absolutely-
  // positioned elements over the image rather than a canvas overlay, so
  // it stays crisp at any zoom and needs no extra markup in index.html.
  photoModalCrop.addEventListener("click", (e) => {
    e.stopPropagation();
    if (addingText) return;
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
    const node = findNode(photoModalState.nodeId);
    const images = getNodeImages(node);
    const src = images[photoModalState.index];
    if (!src) return;

    cropping = true;
    const card = photoModal.querySelector(".photo-modal-card");
    const img = photoModalImg;
    const iw = img.offsetWidth, ih = img.offsetHeight;

    // Hide everything except the image and the crop controls while cropping.
    const hiddenWhileCropping = [photoModalPrev, photoModalNext, photoModalCount, photoModalDelete, photoModalCrop, photoModalText, photoModalClose];
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

      const liveNode = findNode(photoModalState.nodeId);
      const liveImages = getNodeImages(liveNode);
      if (liveImages.length) {
        pushUndo();
        liveImages[photoModalState.index] = croppedUrl;
        liveNode.images = liveImages;
        liveNode.image = null;
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

  function startAddText() {
    if (addingText || cropping || !photoModalState) return;
    resetPhotoZoom();
    const node = findNode(photoModalState.nodeId);
    const images = getNodeImages(node);
    const src = images[photoModalState.index];
    if (!src) return;

    addingText = true;
    const card = photoModal.querySelector(".photo-modal-card");
    const img = photoModalImg;
    const iw = img.offsetWidth, ih = img.offsetHeight;

    const hiddenWhileAddingText = [photoModalPrev, photoModalNext, photoModalCount, photoModalDelete, photoModalCrop, photoModalClose];
    hiddenWhileAddingText.forEach(el => { el.dataset.prevDisplay = el.style.display; el.style.display = "none"; });

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute", left: img.offsetLeft + "px", top: img.offsetTop + "px",
      width: iw + "px", height: ih + "px",
      overflow: "hidden", borderRadius: "10px", zIndex: "5", cursor: "text", touchAction: "none"
    });

    const TEXT_COLORS = ["#ffffff", "#2b2a25", "#e0433a", "#f5b301", "#4a9e4a", "#4a72d6"];
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
        const dx = e.clientX - resizeStart.x, dy = e.clientY - resizeStart.y;
        const delta = (dx + dy) / 2;
        pendingResizeSize = clamp(Math.round(resizeStart.size + delta), 10, 140);
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
      function beginDrag(e) {
        e.preventDefault(); e.stopPropagation();
        selectBox(box);
        dragging = true;
        dragStart = { x: e.clientX, y: e.clientY, bx: box.x, by: box.y };
        document.addEventListener("pointermove", onDrag);
        document.addEventListener("pointerup", onDragEnd);
      }
      wrap.addEventListener("pointerdown", (e) => {
        if (e.target === el && document.activeElement === el && activeBox === box) return; // already selected: allow text caret/selection
        beginDrag(e);
      });
      // The grab handle always starts a drag, even while the box is
      // selected and focused for editing — it's the escape hatch from
      // the caret-vs-move ambiguity above.
      grab.addEventListener("pointerdown", beginDrag);
      function onDrag(e) {
        if (!dragging) return;
        const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
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

    overlay.addEventListener("pointerdown", (e) => {
      if (e.target !== overlay) return; // a click landed on an existing box, not empty space
      if (!placementArmed) { deselectAll(); return; } // click away just finishes the current label
      placementArmed = false;
      photoModalText.classList.remove("bl-text-armed");
      const rect = overlay.getBoundingClientRect();
      const x = clamp(e.clientX - rect.left, 0, Math.max(0, iw - 20));
      const y = clamp(e.clientY - rect.top, 0, Math.max(0, ih - 20));
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

    const swatchEls = [];
    function syncSwatches() {
      swatchEls.forEach((sw, i) => {
        sw.style.border = TEXT_COLORS[i] === currentColor ? "2px solid var(--accent, #7c9eff)" : "1.5px solid rgba(255,255,255,0.4)";
      });
    }
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

    function cleanup() {
      overlay.remove();
      toolbar.remove();
      hiddenWhileAddingText.forEach(el => { el.style.display = el.dataset.prevDisplay || ""; delete el.dataset.prevDisplay; });
      photoModalText.classList.remove("bl-text-armed");
      addingText = false;
      textCleanup = null;
      rearmTextPlacement = null;
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

      const liveNode = findNode(photoModalState.nodeId);
      const liveImages = getNodeImages(liveNode);
      if (liveImages.length) {
        pushUndo();
        liveImages[photoModalState.index] = outUrl;
        liveNode.images = liveImages;
        liveNode.image = null;
        renderAll();
        persist();
      }
      cleanup();
    });
  }

  /* ---------------- note editor ---------------- */

  const noteModal = $("#note-modal");
  const noteTextarea = $("#note-textarea");
  const noteTitleInput = $("#note-title-input");
  const noteCard = $(".note-modal-card");
  const noteResizeHandle = $("#note-resize-handle");
  let noteEditingId = null;
  let noteSaveTimer = null;
  let noteIsResizing = false;
  // A node can now hold several notes. While the modal is open,
  // noteWorkingList holds an editable in-memory copy of that node's notes
  // ({id, title, html} each) and noteActiveIndex is which one is in the
  // editor right now. Nothing here is written back to the node itself
  // until commitNotesToNode() runs (autosave, navigating away, or closing).
  let noteWorkingList = [];
  let noteActiveIndex = 0;
  const noteNavAdd = $("#note-nav-add");
  const noteNavDelete = $("#note-nav-delete");

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

  // Opens the note editor for a node. `index` picks which of the node's
  // notes to show: omit it to land on the last (most recently added) one,
  // or pass notes.length (or any out-of-range index) to start a brand-new
  // blank note instead of an existing one.
  function openNoteModal(nodeId, index) {
    const node = findNode(nodeId);
    if (!node) return;
    commitEditIfActive();
    noteEditingId = nodeId;
    noteWorkingList = getNodeNotes(node).map(n => ({ id: n.id || uid(), title: n.title || "", html: n.html }));
    const wantsNew = index != null && index >= noteWorkingList.length;
    if (!noteWorkingList.length || wantsNew) {
      noteWorkingList.push({ id: uid(), title: "", html: "" });
    }
    noteActiveIndex = wantsNew ? noteWorkingList.length - 1
      : clamp(index == null ? noteWorkingList.length - 1 : index, 0, noteWorkingList.length - 1);
    loadNoteIntoEditor();
    noteModal.classList.remove("hidden");
    const current = noteWorkingList[noteActiveIndex];
    const isBlank = !(current.title && current.title.trim()) && !(current.html && current.html.trim());
    requestAnimationFrame(() => { (isBlank ? noteTitleInput : noteTextarea).focus(); });
  }

  // Loads noteWorkingList[noteActiveIndex] into the visible editor and
  // refreshes the nav row (‹ 2 / 3 › + 🗑) to match.
  function loadNoteIntoEditor() {
    const node = findNode(noteEditingId);
    const current = noteWorkingList[noteActiveIndex];
    noteTitleInput.value = current.title || "";
    noteTextarea.dataset.placeholder = `Note for "${node ? (node.text || "(untitled)") : ""}"…`;
    noteTextarea.innerHTML = noteHtmlFromRaw(current.html);
    noteSyncAllCheckedLines();
    noteSyncAllOrderedColors();
    updateNoteNavUI();
  }

  function updateNoteNavUI() {
    // No more pager buttons/label to sync — paging between notes is now
    // keyboard-only (Alt+←/→), see the keydown handlers below.
  }

  // Reads whatever's currently in the editor (title + body) back into the
  // working list, without touching the node yet — called before
  // navigating away from the note currently on screen so nothing typed
  // is lost.
  function captureActiveNote() {
    const current = noteWorkingList[noteActiveIndex];
    if (!current) return;
    current.title = noteTitleInput.value;
    current.html = noteTextarea.innerHTML;
  }

  function goToNote(delta) {
    captureActiveNote();
    noteActiveIndex = clamp(noteActiveIndex + delta, 0, noteWorkingList.length - 1);
    loadNoteIntoEditor();
    commitNotesToNode();
  }

  function addAnotherNote() {
    captureActiveNote();
    noteWorkingList.push({ id: uid(), title: "", html: "" });
    noteActiveIndex = noteWorkingList.length - 1;
    loadNoteIntoEditor();
    commitNotesToNode();
    requestAnimationFrame(() => { noteTitleInput.focus(); });
  }

  // Deletes the note currently in the editor. If it's the only one left,
  // just clears it instead — closing the marker down to zero without
  // leaving the editor in a no-notes-open state.
  function deleteActiveNote() {
    captureActiveNote();
    if (noteWorkingList.length <= 1) {
      noteWorkingList[0].title = "";
      noteWorkingList[0].html = "";
    } else {
      noteWorkingList.splice(noteActiveIndex, 1);
      noteActiveIndex = clamp(noteActiveIndex, 0, noteWorkingList.length - 1);
    }
    loadNoteIntoEditor();
    commitNotesToNode();
  }

  function closeNoteModal() {
    flushNoteAutosave();
    noteEditingId = null;
    noteWorkingList = [];
    noteActiveIndex = 0;
    noteModal.classList.add("hidden");
    $("#note-color-popover").classList.add("hidden");
  }

  // Debounced autosave: fires a short beat after the user stops typing,
  // so notes save themselves without needing an explicit Save click.
  function scheduleNoteAutosave() {
    captureActiveNote();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(commitNotesToNode, 500);
  }

  function flushNoteAutosave() {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
    commitNotesToNode();
  }

  // Writes noteWorkingList onto the node's `notes` array. Entries that are
  // still genuinely blank (no title and never typed into) are dropped so
  // an idle "+ New note" click doesn't leave a phantom entry inflating
  // the marker's count — matches the old single-note behavior, where an
  // empty note never made the marker appear in the first place.
  function commitNotesToNode() {
    const node = findNode(noteEditingId);
    if (!node) return;
    captureActiveNote();
    const cleaned = noteWorkingList.filter(n => (n.title && n.title.trim()) || (n.html && n.html.trim()));
    const before = JSON.stringify(getNodeNotes(node));
    const after = JSON.stringify(cleaned);
    if (before !== after) {
      pushUndo();
      node.notes = cleaned;
      node.note = "";
      renderAll();
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
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    while (node && node !== container && node.parentNode !== container) {
      node = node.parentNode;
    }
    return node === container ? null : node;
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
    const lineDiv = noteCurrentLine();
    const el = lineDiv || noteTextarea;
    const text = el.textContent;
    const match = text.match(prefixRegex);
    el.textContent = match ? text.slice(match[0].length) : makePrefix() + text;
    noteSyncLineChecked(el);
    placeCaretAtEnd(el);
    scheduleNoteAutosave();
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

  // Colors a line based on the number in its own "N. " prefix, or clears
  // the color if the line isn't numbered. Applied at the div level (not
  // wrapped in a span), so it never collides with a manual foreColor
  // selection made via the color picker inside the line's text.
  function noteSetOrderedLineColor(el) {
    if (!el) return;
    const match = (el.textContent || "").match(/^(\d+)\.\s/);
    el.style.color = match ? noteColorForOrdinal(parseInt(match[1], 10)) : "";
  }

  // Re-applies auto ordinal colors across every line, for notes loaded
  // from storage (or imported/exported) that have numbered prefixes but no
  // inline color saved yet. `container` defaults to the per-node rich note
  // editor but is also passed the per-task note editor.
  function noteSyncAllOrderedColors(container = noteTextarea) {
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
  }

  function noteApplyForeColor(color) {
    noteTextarea.focus();
    const sel = window.getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      noteSelectLine(noteCurrentLine());
    }
    document.execCommand("foreColor", false, color);
    scheduleNoteAutosave();
  }

  function noteApplyStrikethrough() {
    noteTextarea.focus();
    const sel = window.getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      noteSelectLine(noteCurrentLine());
    }
    document.execCommand("strikeThrough");
    scheduleNoteAutosave();
  }

  // Enter key on a numbered or checklist line continues the pattern
  // ("1." -> "2.", "☐" -> "☐"); pressing Enter on an empty list line
  // breaks out of the list instead of continuing it forever.
  function noteHandleEnter() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    const lineDiv = noteCurrentLine();
    const lineText = (lineDiv || noteTextarea).textContent;
    const numMatch = lineText.match(/^(\d+)\.\s+/);
    const checkMatch = lineText.match(/^([☐☑])\s+/);
    if (!numMatch && !checkMatch) return false;
    const prefix = (numMatch || checkMatch)[0];
    const rest = lineText.slice(prefix.length);
    if (rest.trim() === "") {
      if (lineDiv) lineDiv.textContent = "";
      placeCaretAtEnd(lineDiv || noteTextarea);
      scheduleNoteAutosave();
      return true;
    }
    const nextPrefix = numMatch ? `${parseInt(numMatch[1], 10) + 1}. ` : "☐ ";
    const newDiv = document.createElement("div");
    newDiv.textContent = nextPrefix;
    if (numMatch) noteSetOrderedLineColor(newDiv);
    if (lineDiv && lineDiv.parentNode) {
      lineDiv.parentNode.insertBefore(newDiv, lineDiv.nextSibling);
    } else {
      noteTextarea.appendChild(newDiv);
    }
    placeCaretAtEnd(newDiv);
    scheduleNoteAutosave();
    return true;
  }

  // Photos are embedded directly as data-URI <img> tags inside the note's
  // HTML — consistent with the app being fully offline/self-contained, since
  // nothing needs to be uploaded anywhere and the image travels with the
  // map's .json (export, or the mirrored folder file) automatically.
  const noteImageInput = $("#note-image-input");

  // Inserts a line containing an <img>, right after the current line, then
  // leaves an empty line after it so the caret has somewhere to keep typing.
  function noteInsertImage(dataUrl) {
    noteTextarea.focus();
    const lineDiv = noteCurrentLine();
    const imgLine = document.createElement("div");
    const img = document.createElement("img");
    img.src = dataUrl;
    imgLine.appendChild(img);
    const afterLine = document.createElement("div");
    afterLine.appendChild(document.createElement("br"));

    if (lineDiv && lineDiv.parentNode === noteTextarea) {
      lineDiv.parentNode.insertBefore(imgLine, lineDiv.nextSibling);
      imgLine.parentNode.insertBefore(afterLine, imgLine.nextSibling);
    } else {
      noteTextarea.appendChild(imgLine);
      noteTextarea.appendChild(afterLine);
    }
    placeCaretAtEnd(afterLine);
    scheduleNoteAutosave();
  }

  // Images embedded in a note are stored exactly as provided — no
  // downscaling, no lossy re-encoding.
  function noteHandleImageFile(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => { noteInsertImage(reader.result); };
    reader.onerror = () => alert("Couldn't read that image file.");
    reader.readAsDataURL(file);
  }

  $("#note-tool-image").addEventListener("mousedown", (e) => e.preventDefault());
  $("#note-tool-image").addEventListener("click", () => noteImageInput.click());
  noteImageInput.addEventListener("change", () => {
    const file = noteImageInput.files && noteImageInput.files[0];
    if (file) noteHandleImageFile(file);
    noteImageInput.value = ""; // reset so picking the same file again still fires change
  });

  noteTextarea.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        e.preventDefault();
        noteHandleImageFile(item.getAsFile());
        return;
      }
    }
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

  // Clicking directly on a checklist glyph toggles it, like a real checkbox.
  noteTextarea.addEventListener("click", (e) => {
    const lineDiv = noteCurrentLine();
    const text = (lineDiv || noteTextarea).textContent;
    if (!/^[☐☑]\s/.test(text)) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(lineDiv || noteTextarea);
    preRange.setEnd(range.startContainer, range.startOffset);
    if (preRange.toString().length > 1) return; // only toggle when clicking right on the glyph
    const el = lineDiv || noteTextarea;
    el.textContent = text.replace(/^[☐☑]/, m => (m === "☐" ? "☑" : "☐"));
    noteSyncLineChecked(el);
    scheduleNoteAutosave();
  });

  $("#note-tool-ol").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteToggleOrderedList();
  });
  $("#note-tool-check").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteToggleLinePrefix(/^[☐☑]\s+/, () => "☐ ");
  });
  $("#note-tool-strike").addEventListener("mousedown", (e) => {
    e.preventDefault();
    noteApplyStrikethrough();
  });
  document.querySelectorAll(".note-color-swatch").forEach(btn => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus (and the note's text selection) off this button
      noteApplyForeColor(btn.dataset.color);
      setNoteColorTrigger(btn.dataset.color);
    });
    // Close the popover on "click" rather than inside the mousedown handler
    // above. Hiding it mid-mousedown used to remove it from the hit tree
    // before mouseup/click fired, so the browser re-targeted that click
    // onto whatever sat underneath — the note-modal backdrop, since the
    // popover intentionally renders outside the card (see the
    // .note-color-popover CSS comment) so it isn't clipped — which closed
    // the whole note editor. Waiting for "click" lets the swatch stay put
    // through the full mousedown→mouseup→click sequence, so the click
    // always resolves on the swatch itself and never leaks to the modal.
    btn.addEventListener("click", () => { closeNoteColorPopover(); });
  });
  $("#note-color-custom").addEventListener("input", (e) => {
    noteApplyForeColor(e.target.value);
    setNoteColorTrigger(e.target.value);
  });
  $("#note-color-custom").addEventListener("mousedown", (e) => e.stopPropagation());

  // Single trigger button that opens/closes the color popover, instead of
  // 6 separate swatch buttons always taking up space in the toolbar.
  const noteColorTriggerBtn = $("#note-tool-color");
  const noteColorPopover = $("#note-color-popover");
  noteColorTriggerBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (noteColorPopover.classList.contains("hidden")) {
      openNoteColorPopover();
    } else {
      closeNoteColorPopover();
    }
  });
  noteColorPopover.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", (e) => {
    if (!noteColorPopover.classList.contains("hidden") &&
        !noteColorPopover.contains(e.target) && e.target !== noteColorTriggerBtn) {
      closeNoteColorPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (!noteColorPopover.classList.contains("hidden")) positionNoteColorPopover();
  });
  function openNoteColorPopover(){
    noteColorPopover.classList.remove("hidden");
    positionNoteColorPopover();
  }
  function closeNoteColorPopover(){ noteColorPopover.classList.add("hidden"); }
  // Places the popover using fixed viewport coordinates (rather than CSS
  // relative-to-button positioning) and clamps it so it always stays fully
  // on-screen, whichever edge of the note modal the trigger button is near.
  function positionNoteColorPopover(){
    const margin = 8;
    const btnRect = noteColorTriggerBtn.getBoundingClientRect();
    const popRect = noteColorPopover.getBoundingClientRect();
    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
    let top = btnRect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = btnRect.top - popRect.height - 6; // not enough room below: flip above
    }
    noteColorPopover.style.left = `${left}px`;
    noteColorPopover.style.top = `${top}px`;
  }
  function setNoteColorTrigger(color){ $("#note-color-trigger-swatch").style.background = color; }

  noteModal.addEventListener("click", (e) => { if (!noteIsResizing && e.target === noteModal) closeNoteModal(); });
  noteTitleInput.addEventListener("input", scheduleNoteAutosave);
  noteTitleInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let Enter/Delete/arrows trigger the canvas shortcuts while typing a title
    if (e.key === "Escape") { e.preventDefault(); closeNoteModal(); return; }
    // Enter jumps down into the note body instead of doing nothing (it's
    // a single-line input, so there's no newline to insert here anyway).
    if (e.key === "Enter") { e.preventDefault(); noteTextarea.focus(); return; }
    if (e.altKey && e.key === "ArrowLeft" && noteActiveIndex > 0) { e.preventDefault(); goToNote(-1); }
    if (e.altKey && e.key === "ArrowRight" && noteActiveIndex < noteWorkingList.length - 1) { e.preventDefault(); goToNote(1); }
  });
  noteTextarea.addEventListener("input", scheduleNoteAutosave);
  noteTextarea.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let Tab/Enter/Delete trigger the canvas shortcuts while typing a note
    if (e.key === "Escape") { e.preventDefault(); closeNoteModal(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      if (noteHandleEnter()) e.preventDefault();
    }
    // Alt+Left/Right switch between a node's notes without leaving the
    // keyboard — plain arrow keys stay reserved for moving the caret.
    if (e.altKey && e.key === "ArrowLeft" && noteActiveIndex > 0) { e.preventDefault(); goToNote(-1); }
    if (e.altKey && e.key === "ArrowRight" && noteActiveIndex < noteWorkingList.length - 1) { e.preventDefault(); goToNote(1); }
  });

  noteNavAdd.addEventListener("mousedown", (e) => e.preventDefault());
  noteNavAdd.addEventListener("click", addAnotherNote);
  noteNavDelete.addEventListener("mousedown", (e) => e.preventDefault());
  noteNavDelete.addEventListener("click", deleteActiveNote);
  $("#note-nav-close").addEventListener("click", closeNoteModal);

  bgInput.addEventListener("input", () => updateTheme({ background: bgInput.value }));
  $("#theme-bg-reset").addEventListener("click", () => { bgInput.value = defaultBg(); updateTheme({ background: null }); });

  connectorModeSel.addEventListener("change", () => {
    connectorColorInput.disabled = connectorModeSel.value !== "custom";
    updateTheme({ connectorMode: connectorModeSel.value });
  });
  connectorColorInput.addEventListener("input", () => updateTheme({ connectorColor: connectorColorInput.value }));

  fontModeSel.addEventListener("change", () => {
    fontColorInput.disabled = fontModeSel.value !== "custom";
    updateTheme({ fontMode: fontModeSel.value });
  });
  fontColorInput.addEventListener("input", () => updateTheme({ fontColor: fontColorInput.value }));

  /* ---------------- tasks editor ---------------- */

  const tasksModal = $("#tasks-modal");
  const tasksModalTitle = $("#tasks-modal-title");
  const tasksListEl = $("#tasks-list");
  const tasksNewInput = $("#tasks-new-input");
  const tasksProgressBar = $("#tasks-progress-bar");
  const tasksProgressLabel = $("#tasks-progress-label");
  const tasksFocusTimerEl = $("#tasks-focus-timer");
  let tasksEditingId = null;
  // Which tasks have their subtask checklist explicitly collapsed in the
  // tasks modal — subtasks are expanded by default, so this only tracks
  // the ones someone has double-clicked closed. Keyed by task id, kept
  // for the life of the page (not persisted) so it survives re-renders
  // but resets on reload.
  const collapsedSubtaskIds = new Set();

  // Per-task focus timer — a lightweight, non-persisted countdown so the
  // person can start a quick focus session on one task at a time. It
  // keeps running (via setInterval) even if the tasks modal is closed or
  // switched to a different node, so leaving the modal doesn't cancel it.
  // Starts short — an extra "+1m" button lets you stack on more time
  // instead of committing to a long duration up front.
  const FOCUS_DURATION = 1 * 60; // 1 minute
  const FOCUS_EXTEND = 1 * 60; // added per "+1m" click
  let focusTimer = null; // { nodeId, taskId, subtaskId, taskText, remaining, duration, paused, intervalId } — subtaskId is null for a task-level timer
  let focusJustCompleted = null; // { nodeId, taskId, subtaskId } — shown briefly after a session finishes
  let lastFocusTaskText = ""; // kept around so the "Time's up!" tab title can still name the task once focusTimer itself is cleared

  // The browser tab title mirrors the countdown, so the time is visible
  // even when this tab isn't the active one. BASE_TITLE is captured once
  // up front (before anything ever overwrites document.title) so it can
  // always be restored exactly once the timer/alarm is done.
  const BASE_TITLE = document.title;
  const TITLE_TASK_MAX = 40;

  function titleTaskLabel(text) {
    const t = (text || "").trim() || "Focus";
    return t.length > TITLE_TASK_MAX ? t.slice(0, TITLE_TASK_MAX - 1) + "…" : t;
  }

  function updateFocusTitle() {
    if (focusTimer) {
      document.title = `${focusTimer.paused ? "⏸" : "⏱"} ${formatFocusTime(focusTimer.remaining)} · ${titleTaskLabel(focusTimer.taskText)}`;
    } else if (focusChimeIntervalId) {
      document.title = `⏰ Time's up! · ${titleTaskLabel(lastFocusTaskText)}`;
    } else {
      document.title = BASE_TITLE;
    }
  }

  function formatFocusTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Single focus-timer widget, shown once at the top of the tasks modal
  // (next to its title) rather than duplicated on every task/subtask row.
  // It isn't tied to any particular task — just a general session for
  // whatever the person is working through in this list.
  function renderFocusTimerWidget() {
    if (!tasksFocusTimerEl) return;
    tasksFocusTimerEl.innerHTML = "";

    if (focusTimer) {
      const timeLabel = document.createElement("span");
      timeLabel.className = "task-timer-time" + (focusTimer.paused ? " paused" : "");
      timeLabel.textContent = formatFocusTime(focusTimer.remaining);
      timeLabel.title = focusTimer.paused ? "Focus timer paused" : "Focusing — time remaining";

      const pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "task-timer-btn";
      pauseBtn.title = focusTimer.paused ? "Resume" : "Pause";
      pauseBtn.textContent = focusTimer.paused ? "▶" : "⏸";
      pauseBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFocusPause(); });

      const extendBtn = document.createElement("button");
      extendBtn.type = "button";
      extendBtn.className = "task-timer-btn task-timer-extend";
      extendBtn.title = "Add 1 more minute";
      extendBtn.textContent = "+1m";
      extendBtn.addEventListener("click", (e) => { e.stopPropagation(); extendFocusTimer(FOCUS_EXTEND); });

      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "task-timer-btn task-timer-stop";
      stopBtn.title = "Stop focus timer";
      stopBtn.textContent = "■";
      stopBtn.addEventListener("click", (e) => { e.stopPropagation(); stopFocusTimer(); });

      tasksFocusTimerEl.appendChild(timeLabel);
      tasksFocusTimerEl.appendChild(pauseBtn);
      tasksFocusTimerEl.appendChild(stopBtn);
      tasksFocusTimerEl.appendChild(extendBtn);
    } else if (focusJustCompleted) {
      const doneLabel = document.createElement("span");
      doneLabel.className = "task-timer-done-label";
      doneLabel.textContent = "✓ Focus done";
      doneLabel.title = "Tap anywhere to stop the chime";
      tasksFocusTimerEl.appendChild(doneLabel);
    } else {
      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.className = "task-timer-btn task-timer-start";
      startBtn.title = "Start a focus timer (1 min, +1m button to extend)";
      startBtn.textContent = "⏱";
      startBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startFocusTimer(tasksEditingId, null, "Focus session");
      });
      tasksFocusTimerEl.appendChild(startBtn);
    }
  }

  function refreshTasksModalIfOpen(nodeId) {
    if (!tasksModal.classList.contains("hidden") && tasksEditingId === nodeId) {
      renderTasksModal();
    }
  }

  function startFocusTimer(nodeId, taskId, taskText, subtaskId = null) {
    stopFocusTimer();
    stopFocusChime();
    focusJustCompleted = null;
    focusTimer = {
      nodeId, taskId, subtaskId, taskText,
      remaining: FOCUS_DURATION,
      duration: FOCUS_DURATION,
      paused: false,
      intervalId: setInterval(focusTimerTick, 1000),
    };
    updateFocusTitle();
    refreshTasksModalIfOpen(nodeId);
  }

  function focusTimerTick() {
    if (!focusTimer || focusTimer.paused) return;
    focusTimer.remaining--;
    if (focusTimer.remaining <= 0) {
      focusTimerComplete();
      return;
    }
    updateFocusTitle();
    refreshTasksModalIfOpen(focusTimer.nodeId);
  }

  function toggleFocusPause() {
    if (!focusTimer) return;
    focusTimer.paused = !focusTimer.paused;
    updateFocusTitle();
    refreshTasksModalIfOpen(focusTimer.nodeId);
  }

  // Stacks more time onto a running (or paused) timer, e.g. from a "+1m"
  // button — lets a short default session grow as long as needed instead
  // of forcing a long duration up front.
  function extendFocusTimer(seconds) {
    if (!focusTimer) return;
    focusTimer.remaining += seconds;
    focusTimer.duration += seconds;
    updateFocusTitle();
    refreshTasksModalIfOpen(focusTimer.nodeId);
  }

  function stopFocusTimer() {
    if (focusTimer && focusTimer.intervalId) clearInterval(focusTimer.intervalId);
    const prev = focusTimer;
    focusTimer = null;
    updateFocusTitle();
    if (prev) refreshTasksModalIfOpen(prev.nodeId);
  }

  function focusTimerComplete() {
    const finished = focusTimer;
    if (finished && finished.intervalId) clearInterval(finished.intervalId);
    focusTimer = null;
    if (finished) lastFocusTaskText = finished.taskText;
    startFocusChime();
    updateFocusTitle();
    if (finished) {
      focusJustCompleted = { nodeId: finished.nodeId, taskId: finished.taskId, subtaskId: finished.subtaskId };
      refreshTasksModalIfOpen(finished.nodeId);
      setTimeout(() => {
        if (focusJustCompleted && focusJustCompleted.taskId === finished.taskId && focusJustCompleted.subtaskId === finished.subtaskId) {
          focusJustCompleted = null;
          refreshTasksModalIfOpen(finished.nodeId);
        }
      }, 4000);
    }
  }

  // The alarm keeps chiming — not just a single beep — until the person
  // dismisses it with any click/tap/keypress anywhere on the page, or
  // starts another focus timer. A generous safety cap stops it on its
  // own if the tab is left unattended, so it can never ring forever.
  const FOCUS_CHIME_INTERVAL = 1500;
  const FOCUS_CHIME_MAX_MS = 5 * 60 * 1000; // 5 minutes, just in case
  let focusChimeIntervalId = null;
  let focusChimeCapTimeoutId = null;
  let focusChimeDismissHandler = null;

  function startFocusChime() {
    stopFocusChime();
    playFocusChime();
    focusChimeIntervalId = setInterval(playFocusChime, FOCUS_CHIME_INTERVAL);
    focusChimeCapTimeoutId = setTimeout(stopFocusChime, FOCUS_CHIME_MAX_MS);
    focusChimeDismissHandler = () => stopFocusChime();
    // capture:true so it fires even if the click lands on something that
    // would otherwise stop propagation before reaching document.
    document.addEventListener("pointerdown", focusChimeDismissHandler, { capture: true, once: true });
    document.addEventListener("keydown", focusChimeDismissHandler, { capture: true, once: true });
    updateFocusTitle();
  }

  function stopFocusChime() {
    if (focusChimeIntervalId) { clearInterval(focusChimeIntervalId); focusChimeIntervalId = null; }
    if (focusChimeCapTimeoutId) { clearTimeout(focusChimeCapTimeoutId); focusChimeCapTimeoutId = null; }
    if (focusChimeDismissHandler) {
      document.removeEventListener("pointerdown", focusChimeDismissHandler, { capture: true });
      document.removeEventListener("keydown", focusChimeDismissHandler, { capture: true });
      focusChimeDismissHandler = null;
    }
    updateFocusTitle();
  }

  // A short two-tone chime via the Web Audio API — no audio file needed,
  // and it fails silently if the browser blocks autoplay before any
  // user gesture (there will have been one, since a click started the
  // timer, but this stays defensive either way).
  function playFocusChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      [880, 1174.66].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.value = 0.0001;
        o.connect(g);
        g.connect(ctx.destination);
        const start = ctx.currentTime + i * 0.16;
        g.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        o.start(start);
        o.stop(start + 0.55);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch (e) { /* ignore — chime is a nice-to-have, not essential */ }
  }


  // Reordering tasks by drag — drag the ⠿ handle on the left of any task
  // up or down to drop it before/after another task in the list.
  let taskDragState = null;

  function startTaskDrag(e, li, taskId) {
    e.stopPropagation();
    taskDragState = { taskId };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
    li.classList.add("task-dragging");
  }

  function endTaskDrag(li) {
    li.classList.remove("task-dragging");
    taskDragState = null;
    tasksListEl.querySelectorAll(".task-row").forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
  }

  function reorderTask(sourceTaskId, targetTaskId, before) {
    const node = findNode(tasksEditingId);
    if (!node || sourceTaskId === targetTaskId) return;
    const tasks = getNodeTasks(node).slice();
    const fromIdx = tasks.findIndex(x => x.id === sourceTaskId);
    if (fromIdx === -1) return;
    const [moved] = tasks.splice(fromIdx, 1);
    const toIdx = tasks.findIndex(x => x.id === targetTaskId);
    if (toIdx === -1) {
      tasks.push(moved);
    } else {
      tasks.splice(before ? toIdx : toIdx + 1, 0, moved);
    }
    pushUndo();
    node.tasks = tasks;
    persist();
    renderTasksModal();
  }

  // Reordering subtasks by drag — same ⠿ handle convention as tasks. A
  // subtask can be dropped on another subtask row (to land at that exact
  // spot) or directly on a task's own row (to land at the end of that
  // task's list) — either way, it works both within the same task and
  // across two different tasks.
  let subtaskDragState = null;

  // Which tasks currently have their "add a subtask" input expanded —
  // it starts life as a small + button and swaps for the input on
  // click, collapsing back once you click away with nothing typed.
  let subtaskAddOpenFor = new Set();

  function startSubtaskDrag(e, row, taskId, subtaskId) {
    e.stopPropagation();
    subtaskDragState = { taskId, subtaskId };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch (err) {}
    row.classList.add("task-dragging");
  }

  function endSubtaskDrag(row) {
    row.classList.remove("task-dragging");
    subtaskDragState = null;
    tasksListEl.querySelectorAll(".subtask-row").forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
    tasksListEl.querySelectorAll(".task-row.subtask-drop-target").forEach(r => r.classList.remove("subtask-drop-target"));
  }

  // Moves a subtask to a new spot — anywhere in its own task's list, or
  // into a different task's list entirely. `targetTaskId`/`targetSubtaskId`
  // describe where it's landing: pass a specific targetSubtaskId (plus
  // `before`) to drop it right next to that subtask, or leave
  // targetSubtaskId null to just drop it at the end of targetTaskId's list
  // (e.g. when it's dropped on the task's row rather than one of its
  // existing subtasks).
  function moveSubtask(sourceTaskId, sourceSubtaskId, targetTaskId, targetSubtaskId, before) {
    const node = findNode(tasksEditingId);
    if (!node) return;
    if (sourceTaskId === targetTaskId && sourceSubtaskId === targetSubtaskId) return;
    const tasks = getNodeTasks(node);
    const sourceTask = tasks.find(x => x.id === sourceTaskId);
    const targetTask = tasks.find(x => x.id === targetTaskId);
    if (!sourceTask || !targetTask) return;
    const sourceSubs = getTaskSubtasks(sourceTask).slice();
    const fromIdx = sourceSubs.findIndex(x => x.id === sourceSubtaskId);
    if (fromIdx === -1) return;
    const [moved] = sourceSubs.splice(fromIdx, 1);

    pushUndo();

    const sameTask = sourceTaskId === targetTaskId;
    const destSubs = sameTask ? sourceSubs : getTaskSubtasks(targetTask).slice();
    const toIdx = targetSubtaskId ? destSubs.findIndex(x => x.id === targetSubtaskId) : -1;
    if (toIdx === -1) {
      destSubs.push(moved);
    } else {
      destSubs.splice(before ? toIdx : toIdx + 1, 0, moved);
    }

    sourceTask.subtasks = sourceSubs;
    targetTask.subtasks = destSubs;
    if (!sameTask) {
      // Moving a subtask in or out changes what each task's own subtasks
      // add up to, which can flip its auto-derived done state.
      syncTaskDoneFromSubtasks(sourceTask);
      syncTaskDoneFromSubtasks(targetTask);
    }
    persist();
    renderTasksModal();
  }

  function openTasksModal(nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    commitEditIfActive();
    closeContextMenu();
    tasksEditingId = nodeId;
    tasksModalTitle.textContent = `Tasks — ${node.text || "(untitled)"}`;
    renderTasksModal();
    tasksModal.classList.remove("hidden");
    requestAnimationFrame(() => { tasksNewInput.focus(); autosizeTextarea(tasksNewInput); });
  }

  function closeTasksModal() {
    tasksModal.classList.add("hidden");
    tasksEditingId = null;
    subtaskAddOpenFor.clear();
    renderAll();
  }

  // Builds the expanded subtask checklist panel for one task — a nested
  // <li> (so it sits inline in the same <ul> right under its task row)
  // holding a checkbox list plus a small "add subtask" input.
  function renderSubtaskPanel(node, t) {
    const wrap = document.createElement("li");
    wrap.className = "subtask-panel";

    const list = document.createElement("ul");
    list.className = "subtask-list";

    getTaskSubtasks(t).forEach((s) => {
      const row = document.createElement("li");
      row.className = "subtask-row" + (s.done ? " done" : "");

      row.addEventListener("dragover", (e) => {
        if (!subtaskDragState) return;
        if (subtaskDragState.taskId === t.id && subtaskDragState.subtaskId === s.id) return;
        e.preventDefault();
        e.stopPropagation(); // don't also trigger this task's row-level drop target below it
        e.dataTransfer.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        row.classList.toggle("drag-over-top", before);
        row.classList.toggle("drag-over-bottom", !before);
      });
      row.addEventListener("dragleave", (e) => {
        if (e.relatedTarget && row.contains(e.relatedTarget)) return;
        row.classList.remove("drag-over-top", "drag-over-bottom");
      });
      row.addEventListener("drop", (e) => {
        if (!subtaskDragState) return;
        if (subtaskDragState.taskId === t.id && subtaskDragState.subtaskId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        row.classList.remove("drag-over-top", "drag-over-bottom");
        moveSubtask(subtaskDragState.taskId, subtaskDragState.subtaskId, t.id, s.id, before);
      });

      const shandle = document.createElement("span");
      shandle.className = "task-drag-handle subtask-drag-handle";
      shandle.textContent = "⠿";
      shandle.title = "Drag to reorder";
      shandle.draggable = true;
      shandle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      shandle.addEventListener("dragstart", (e) => startSubtaskDrag(e, row, t.id, s.id));
      shandle.addEventListener("dragend", () => endSubtaskDrag(row));

      const scb = document.createElement("input");
      scb.type = "checkbox";
      scb.className = "subtask-checkbox";
      scb.checked = !!s.done;
      scb.addEventListener("click", (e) => e.stopPropagation());
      scb.addEventListener("change", () => {
        pushUndo();
        s.done = scb.checked;
        syncTaskDoneFromSubtasks(t);
        persist();
        renderTasksModal();
      });

      // A subtask can also be marked done by clicking its text (in
      // addition to the checkbox above) — a short delay tells a single
      // click (toggle done) apart from the first half of a double-click
      // (start editing), so the two don't fight over the same gesture.
      const stext = document.createElement("span");
      stext.className = "subtask-text";
      stext.contentEditable = "false";
      stext.spellcheck = false;
      stext.textContent = s.text;

      let stextClickTimer = null;
      stext.addEventListener("click", () => {
        if (stext.isContentEditable) return; // mid-edit — let the cursor place normally
        if (stextClickTimer) { clearTimeout(stextClickTimer); stextClickTimer = null; return; }
        stextClickTimer = setTimeout(() => {
          stextClickTimer = null;
          pushUndo();
          s.done = !s.done;
          syncTaskDoneFromSubtasks(t);
          persist();
          renderTasksModal();
        }, 220);
      });
      stext.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (stextClickTimer) { clearTimeout(stextClickTimer); stextClickTimer = null; }
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
        else if (e.key === "Escape") { e.preventDefault(); stext.textContent = s.text; stext.blur(); }
      });
      stext.addEventListener("blur", () => {
        const v = stext.textContent.trim();
        if (v && v !== s.text) {
          pushUndo();
          s.text = v;
          persist();
        } else {
          stext.textContent = s.text;
        }
        stext.contentEditable = "false";
      });

      const sdel = document.createElement("button");
      sdel.type = "button";
      sdel.className = "subtask-delete";
      sdel.title = "Delete subtask";
      sdel.textContent = "×";
      sdel.addEventListener("click", () => {
        pushUndo();
        t.subtasks = getTaskSubtasks(t).filter(x => x !== s);
        syncTaskDoneFromSubtasks(t);
        persist();
        renderTasksModal();
      });

      row.appendChild(shandle);
      row.appendChild(scb);
      row.appendChild(stext);
      row.appendChild(sdel);
      list.appendChild(row);
    });

    wrap.appendChild(list);

    // The "+" trigger itself now lives on the main task row, next to its
    // timer, so it's reachable without opening the panel first. This add
    // row only needs to exist while that trigger has put it into "open"
    // (typing) mode.
    if (subtaskAddOpenFor.has(t.id)) {
      const addRow = document.createElement("div");
      addRow.className = "subtask-add-row";

      const addInput = document.createElement("textarea");
      addInput.rows = 1;
      addInput.className = "subtask-new-input autosize-input";
      addInput.placeholder = "Add a subtask and press Enter…";
      addInput.spellcheck = false;
      addInput.dataset.taskId = t.id;
      addInput.addEventListener("click", (e) => e.stopPropagation());
      addInput.addEventListener("input", () => autosizeTextarea(addInput));
      addInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const v = addInput.value.trim();
          if (!v) return;
          pushUndo();
          if (!Array.isArray(t.subtasks)) t.subtasks = [];
          t.subtasks.push({ id: uid(), text: v, done: false });
          // A brand-new subtask is unchecked, so the parent can no longer
          // be considered fully done.
          t.done = false;
          persist();
          renderTasksModal();
          // Re-render rebuilds the DOM, so re-focus the (new) input for
          // this same task, letting the person add several in a row.
          requestAnimationFrame(() => {
            const el = tasksListEl.querySelector(`.subtask-new-input[data-task-id="${t.id}"]`);
            if (el) el.focus();
          });
        } else if (e.key === "Escape") {
          e.preventDefault();
          addInput.blur();
        }
      });
      addInput.addEventListener("blur", () => {
        // Nothing typed — collapse the input away again. A pending value
        // is left as-is (re-opening keeps it) rather than lost.
        if (!addInput.value.trim()) {
          subtaskAddOpenFor.delete(t.id);
          renderTasksModal();
        }
      });
      addRow.appendChild(addInput);
      wrap.appendChild(addRow);
      requestAnimationFrame(() => addInput.focus());
    }

    return wrap;
  }

  function renderTasksModal() {
    const node = findNode(tasksEditingId);
    if (!node) return;
    renderFocusTimerWidget();
    const tasks = getNodeTasks(node);
    tasksListEl.innerHTML = "";
    tasks.forEach((t) => {
      const li = document.createElement("li");
      const subProg = taskSubtaskProgress(t);
      // The panel (and its border/fill) should only ever appear for a task
      // that actually has subtasks, or one whose "+" button was just
      // clicked to start adding its first one — not for every plain task
      // by default.
      const subExpanded = (subProg.total > 0 || subtaskAddOpenFor.has(t.id)) && !collapsedSubtaskIds.has(t.id);
      const showingSubtasks = subExpanded && subProg.total > 0;
      li.className = "task-row" + (t.done ? " done" : "") + (getTaskStars(t) > 0 ? " starred" : "") + (showingSubtasks ? " has-open-subtasks" : "");

      li.addEventListener("dragover", (e) => {
        if (taskDragState && taskDragState.taskId !== t.id) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = li.getBoundingClientRect();
          const before = (e.clientY - rect.top) < rect.height / 2;
          li.classList.toggle("drag-over-top", before);
          li.classList.toggle("drag-over-bottom", !before);
        } else if (subtaskDragState) {
          // A subtask dragged onto a task's own row (rather than one of
          // its existing subtask rows) — drop it at the end of this
          // task's subtask list. Works for a different task or, just as
          // well, sending it to the bottom of its own current task.
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          li.classList.add("subtask-drop-target");
        }
      });
      li.addEventListener("dragleave", (e) => {
        if (e.relatedTarget && li.contains(e.relatedTarget)) return;
        li.classList.remove("drag-over-top", "drag-over-bottom", "subtask-drop-target");
      });
      li.addEventListener("drop", (e) => {
        if (taskDragState && taskDragState.taskId !== t.id) {
          e.preventDefault();
          const rect = li.getBoundingClientRect();
          const before = (e.clientY - rect.top) < rect.height / 2;
          li.classList.remove("drag-over-top", "drag-over-bottom");
          reorderTask(taskDragState.taskId, t.id, before);
        } else if (subtaskDragState) {
          e.preventDefault();
          li.classList.remove("subtask-drop-target");
          moveSubtask(subtaskDragState.taskId, subtaskDragState.subtaskId, t.id, null, false);
        }
      });

      const handle = document.createElement("span");
      handle.className = "task-drag-handle";
      handle.textContent = "⠿";
      handle.title = "Drag to reorder";
      handle.draggable = true;
      handle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      handle.addEventListener("dragstart", (e) => startTaskDrag(e, li, t.id));
      handle.addEventListener("dragend", () => endTaskDrag(li));

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "task-checkbox";
      cb.checked = !!t.done;
      cb.addEventListener("change", () => {
        pushUndo();
        t.done = cb.checked;
        // Checking/unchecking a task with subtasks cascades to all of
        // them, mirroring the auto-complete-parent behavior below.
        const subs = getTaskSubtasks(t);
        if (subs.length) subs.forEach(s => { s.done = t.done; });
        persist();
        renderTasksModal();
      });

      const stars = getTaskStars(t);
      const star = document.createElement("button");
      star.type = "button";
      star.className = "task-star" + (stars > 0 ? " starred" : "");
      star.textContent = stars > 0 ? "★".repeat(stars) : "☆";
      star.title = stars > 0
        ? `${stars} star${stars > 1 ? "s" : ""} — counts ${stars * 3}x toward progress. Click to ${stars < 3 ? "add another star" : "clear stars"}.`
        : "Star this task for priority — click again for 2 or 3 stars, each multiplying its weight toward progress (3x/6x/9x)";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        pushUndo();
        t.stars = stars >= 3 ? 0 : stars + 1;
        t.starred = t.stars > 0; // kept in sync for older code paths reading the legacy flag
        persist();
        renderTasksModal();
      });

      const text = document.createElement("span");
      text.className = "task-text";
      text.contentEditable = "true";
      text.spellcheck = false;
      text.textContent = t.text;
      text.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); text.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); text.textContent = t.text; text.blur(); }
      });
      text.addEventListener("blur", () => {
        const v = text.textContent.trim();
        if (v && v !== t.text) {
          pushUndo();
          t.text = v;
          persist();
        } else {
          text.textContent = t.text;
        }
      });

      // Double-clicking anywhere on the row (other than its own controls,
      // which have their own click behavior) opens/closes this task's
      // subtask panel — replaces the old separate ▸/▾ expand button.
      li.title = subExpanded
        ? "Double-click to hide subtasks"
        : (subProg.total ? `${subProg.done} of ${subProg.total} subtasks — double-click to view` : "Double-click to add subtasks");
      li.addEventListener("dblclick", (e) => {
        if (e.target.closest(".task-checkbox, .task-star, .task-delete, .task-drag-handle, .task-subtask-add-btn, .task-note-btn, .task-text")) return;
        if (subExpanded) {
          collapsedSubtaskIds.add(t.id);
        } else {
          collapsedSubtaskIds.delete(t.id);
          // No subtasks yet — double-clicking to "expand" should behave
          // like pressing the + button: open the add-subtask input.
          if (!subProg.total) subtaskAddOpenFor.add(t.id);
        }
        renderTasksModal();
      });

      // "+" trigger for adding a subtask — sits right in the main row so
      // it's reachable without opening the subtask panel first. Clicking
      // it opens (and expands, if collapsed) the panel with its
      // add-input focused and ready to type.
      const subtaskAddBtn = document.createElement("button");
      subtaskAddBtn.type = "button";
      subtaskAddBtn.className = "task-subtask-add-btn";
      subtaskAddBtn.title = "Add a subtask";
      subtaskAddBtn.textContent = "+";
      subtaskAddBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsedSubtaskIds.delete(t.id);
        subtaskAddOpenFor.add(t.id);
        renderTasksModal();
      });

      // Single plain-text note on the task — deliberately much simpler
      // than a node's notes (no title, no rich formatting, no multiples):
      // just one optional block of text, opened in its own small popup
      // (see openTaskNoteModal) rather than inline in the list.
      const noteBtn = document.createElement("button");
      noteBtn.type = "button";
      noteBtn.className = "task-note-btn" + (t.note ? " has-note" : "");
      noteBtn.title = t.note ? "Edit note" : "Add note";
      noteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/></svg>';
      noteBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      noteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openTaskNoteModal(node.id, t.id);
      });

      const del = document.createElement("button");
      del.className = "task-delete";
      del.title = "Delete task";
      del.textContent = "×";
      del.addEventListener("click", () => {
        pushUndo();
        node.tasks = getNodeTasks(node).filter(x => x !== t);
        persist();
        renderTasksModal();
      });

      li.appendChild(handle);
      li.appendChild(cb);
      li.appendChild(text);
      li.appendChild(subtaskAddBtn);
      li.appendChild(noteBtn);
      li.appendChild(star);
      li.appendChild(del);
      tasksListEl.appendChild(li);

      if (subExpanded) tasksListEl.appendChild(renderSubtaskPanel(node, t));
    });

    const prog = nodeTaskProgress(node);
    tasksProgressBar.style.width = Math.round(prog.pct * 100) + "%";
    tasksProgressBar.classList.toggle("done", prog.pct >= 1);
    tasksProgressLabel.textContent = prog.total ? `${prog.done} of ${prog.total} done` : "No tasks yet";
  }

  function addTaskFromModal() {
    const node = findNode(tasksEditingId);
    if (!node) return;
    const val = tasksNewInput.value.trim();
    if (!val) return;
    pushUndo();
    if (!Array.isArray(node.tasks)) node.tasks = [];
    node.tasks = node.tasks.concat([{ id: uid(), text: val, done: false, stars: 0 }]);
    tasksNewInput.value = "";
    autosizeTextarea(tasksNewInput);
    persist();
    renderTasksModal();
  }

  // Grows a textarea's height to fit whatever's been typed (up to its
  // CSS max-height, after which it scrolls), so a long task/subtask is
  // visible in full while composing instead of scrolling sideways in a
  // single-line box.
  function autosizeTextarea(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  tasksNewInput.addEventListener("input", () => autosizeTextarea(tasksNewInput));
  // Belt-and-suspenders for the keyboard-overlap fix above: the CSS
  // --keyboard-inset padding shifts the whole modal up, but if the task
  // list itself is long enough that the modal card was already scrolled,
  // the input can still end up just out of view. A short delay lets the
  // on-screen keyboard's open animation (and the resulting visualViewport
  // resize) finish first, so scrollIntoView measures against the final,
  // keyboard-shrunk layout rather than the pre-keyboard one.
  tasksNewInput.addEventListener("focus", () => {
    setTimeout(() => tasksNewInput.scrollIntoView({ block: "nearest", behavior: "smooth" }), 300);
  });
  tasksNewInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addTaskFromModal(); }
    else if (e.key === "Escape") { e.preventDefault(); closeTasksModal(); }
  });
  $("#tasks-back").addEventListener("click", closeTasksModal);
  $("#tasks-close").addEventListener("click", closeTasksModal);
  tasksModal.addEventListener("click", (e) => { if (e.target === tasksModal) closeTasksModal(); });
  document.addEventListener("keydown", (e) => {
    if (tasksModal.classList.contains("hidden")) return;
    if (e.key === "Escape" && document.activeElement !== tasksNewInput) closeTasksModal();
  });

  /* ---------------- task note (single, plain-text, own popup) ---------------- */
  // A task's note is deliberately much simpler than a node's notes — just
  // one optional block of plain text — but opens the same way, in its own
  // small popup window layered on top of the tasks modal, rather than
  // inline in the list.
  const taskNoteModal = $("#task-note-modal");
  const taskNoteModalTitle = $("#task-note-modal-title");
  const taskNoteTextarea = $("#task-note-textarea");
  const taskNoteDeleteBtn = $("#task-note-delete-btn");
  const taskNoteCloseBtn = $("#task-note-close-btn");
  let taskNoteEditingNodeId = null;
  let taskNoteEditingTaskId = null;

  function currentTaskNoteTask() {
    const node = findNode(taskNoteEditingNodeId);
    if (!node) return null;
    return getNodeTasks(node).find(x => x.id === taskNoteEditingTaskId) || null;
  }

  function openTaskNoteModal(nodeId, taskId) {
    const node = findNode(nodeId);
    const t = node && getNodeTasks(node).find(x => x.id === taskId);
    if (!t) return;
    taskNoteEditingNodeId = nodeId;
    taskNoteEditingTaskId = taskId;
    taskNoteModalTitle.textContent = t.text || "(untitled task)";
    // t.note is stored as HTML (one <div> per line), same as per-node
    // notes; noteHtmlFromRaw upgrades old plain-text notes on first open,
    // and re-syncing ordinal colors picks up numbered lines saved before
    // this coloring existed.
    taskNoteTextarea.innerHTML = noteHtmlFromRaw(t.note || "");
    noteSyncAllOrderedColors(taskNoteTextarea);
    taskNoteDeleteBtn.style.display = t.note ? "" : "none";
    taskNoteModal.classList.remove("hidden");
    requestAnimationFrame(() => taskNoteTextarea.focus());
  }

  function saveTaskNote() {
    const t = currentTaskNoteTask();
    if (!t) return;
    const isEmpty = !taskNoteTextarea.textContent.trim();
    const html = isEmpty ? undefined : taskNoteTextarea.innerHTML;
    if (html !== (t.note || undefined)) {
      pushUndo();
      t.note = html;
      persist();
    }
    taskNoteDeleteBtn.style.display = t.note ? "" : "none";
  }

  function closeTaskNoteModal() {
    saveTaskNote();
    taskNoteModal.classList.add("hidden");
    taskNoteEditingNodeId = null;
    taskNoteEditingTaskId = null;
    // The note icon's filled/empty state and title may have changed.
    if (!tasksModal.classList.contains("hidden")) renderTasksModal();
  }

  // Same "1." -> "2." auto-continue as noteHandleEnter, including the
  // per-number color cycling (noteSetOrderedLineColor / NOTE_OL_COLORS),
  // just scoped to this smaller contenteditable instead of the rich
  // per-node note editor. Enter on a numbered line inserts the next
  // number in its own color; Enter on an empty numbered line (just the
  // prefix, no text after it) clears the prefix instead of numbering
  // forever.
  function taskNoteHandleEnter() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    const lineDiv = noteCurrentLine(taskNoteTextarea);
    const lineText = (lineDiv || taskNoteTextarea).textContent;
    const numMatch = lineText.match(/^(\d+)\.\s+/);
    if (!numMatch) return false;
    const rest = lineText.slice(numMatch[0].length);
    if (rest.trim() === "") {
      if (lineDiv) lineDiv.textContent = "";
      placeCaretAtEnd(lineDiv || taskNoteTextarea);
      return true;
    }
    const newDiv = document.createElement("div");
    newDiv.textContent = `${parseInt(numMatch[1], 10) + 1}. `;
    noteSetOrderedLineColor(newDiv);
    if (lineDiv && lineDiv.parentNode) {
      lineDiv.parentNode.insertBefore(newDiv, lineDiv.nextSibling);
    } else {
      taskNoteTextarea.appendChild(newDiv);
    }
    placeCaretAtEnd(newDiv);
    return true;
  }

  taskNoteTextarea.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeTaskNoteModal(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      if (taskNoteHandleEnter()) e.preventDefault();
    }
  });
  taskNoteCloseBtn.addEventListener("click", closeTaskNoteModal);
  taskNoteDeleteBtn.addEventListener("click", () => {
    const t = currentTaskNoteTask();
    if (!t) return;
    pushUndo();
    t.note = undefined;
    taskNoteTextarea.innerHTML = "";
    persist();
    taskNoteDeleteBtn.style.display = "none";
    taskNoteTextarea.focus();
  });
  taskNoteModal.addEventListener("click", (e) => { if (e.target === taskNoteModal) closeTaskNoteModal(); });

  /* ---------------- affirmation typing game ---------------- */
  // A lightweight typing-practice task: pick a random line, and the task
  // is complete once it's been retyped (matching exactly) AFFIRMATION_TARGET
  // times. Progress (t.count) lives on the task itself, same as `done` on
  // a regular task, so it's saved with the map and survives reloads.

  const affirmationModal = $("#affirmation-modal");
  const affirmationQuoteEl = $("#affirmation-quote");
  const affirmationInput = $("#affirmation-input");
  const affirmationProgressBar = $("#affirmation-progress-bar");
  const affirmationProgressLabel = $("#affirmation-progress-label");
  const affirmationFeedback = $("#affirmation-feedback");
  let affirmationNodeId = null;

  function getAffirmationNode() {
    return findNode(affirmationNodeId);
  }

  // Opens the game for a node, from the right-click menu. Resumes an
  // in-progress round if one exists on the node already; otherwise picks
  // a fresh random line and starts a new one.
  function openAffirmationGame(nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    if (!affirmationQuotesList.length) {
      openAffirmationQuotesModal();
      return;
    }
    if (!node.affirmation) node.affirmation = { wins: 0, quote: null, count: 0, target: AFFIRMATION_TARGET };
    if (!node.affirmation.quote) {
      node.affirmation.quote = affirmationQuotesList[Math.floor(Math.random() * affirmationQuotesList.length)];
      node.affirmation.count = 0;
      node.affirmation.target = AFFIRMATION_TARGET;
      persist();
    }
    affirmationNodeId = nodeId;
    affirmationFeedback.textContent = "";
    affirmationFeedback.className = "affirmation-feedback";
    renderAffirmationModal();
    affirmationModal.classList.remove("hidden");
    requestAnimationFrame(() => affirmationInput.focus());
  }

  function closeAffirmationGame() {
    affirmationModal.classList.add("hidden");
    affirmationInput.value = "";
    affirmationInput.classList.remove("shake");
    affirmationNodeId = null;
    renderAll();
  }

  function renderAffirmationModal() {
    const node = getAffirmationNode();
    const a = getNodeAffirmation(node);
    if (!a) { closeAffirmationGame(); return; }
    affirmationQuoteEl.textContent = a.quote || "";
    const target = a.target || AFFIRMATION_TARGET;
    const count = Math.min(a.count || 0, target);
    affirmationInput.value = "";
    affirmationInput.disabled = false;
    affirmationInput.placeholder = "Type the line above and press Enter…";
    renderAffirmationProgress(a, "");
  }

  // Single combined progress bar: each full rep fills 1/target of the
  // bar, and the rep currently being typed fills its own slice live,
  // letter by letter, as leading characters match — so the bar visibly
  // ticks up on every correct keystroke, not just on a full match.
  function renderAffirmationProgress(a, typedRaw) {
    const target = a.target || AFFIRMATION_TARGET;
    const count = Math.min(a.count || 0, target);
    const quote = a.quote || "";
    const chars = Array.from(quote);
    const typed = Array.from(typedRaw || "");
    let correctCount = 0;
    let hitMismatch = false;
    for (let i = 0; i < typed.length && !hitMismatch; i++) {
      if (i < chars.length && typed[i].toLocaleLowerCase("vi") === chars[i].toLocaleLowerCase("vi")) {
        correctCount++;
      } else {
        hitMismatch = true;
      }
    }
    const lineFraction = chars.length ? correctCount / chars.length : 0;
    const combined = count >= target ? 1 : (count + lineFraction) / target;
    affirmationProgressBar.style.width = Math.round(combined * 100) + "%";
    affirmationProgressBar.classList.toggle("done", count >= target);
    affirmationProgressBar.classList.toggle("wrong", hitMismatch && count < target);
    affirmationProgressLabel.textContent = `${count} / ${target}`;
  }

  function submitAffirmationAttempt() {
    const node = getAffirmationNode();
    const a = getNodeAffirmation(node);
    if (!a) return;
    const target = a.target || AFFIRMATION_TARGET;
    if ((a.count || 0) >= target) return;
    const typed = normalizeAffirmationText(affirmationInput.value);
    if (!typed) return;
    const expected = normalizeAffirmationText(a.quote);
    if (typed === expected) {
      pushUndo();
      a.count = (a.count || 0) + 1;
      const justWon = a.count >= target;
      if (justWon) {
        a.wins = (a.wins || 0) + 1;
        // Round complete — clear it so the next open starts a fresh line.
        a.quote = null;
        a.count = 0;
      }
      persist();
      affirmationFeedback.textContent = justWon ? "🎉 All done!" : "";
      affirmationFeedback.className = "affirmation-feedback" + (justWon ? " ok" : "");
      if (justWon) {
        renderAll();
        requestAnimationFrame(() => affirmationInput.blur());
        affirmationInput.disabled = true;
        affirmationInput.placeholder = "All done — great job!";
      } else {
        renderAffirmationModal();
      }
    } else {
      affirmationInput.classList.remove("shake");
      void affirmationInput.offsetWidth; // restart the CSS animation on repeat misses
      affirmationInput.classList.add("shake");
      affirmationFeedback.textContent = "Not quite — try again";
      affirmationFeedback.className = "affirmation-feedback bad";
    }
  }

  affirmationInput.addEventListener("input", () => {
    const a = getNodeAffirmation(getAffirmationNode());
    if (!a) return;
    renderAffirmationProgress(a, affirmationInput.value);
  });
  affirmationInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submitAffirmationAttempt(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAffirmationGame(); }
  });
  $("#affirmation-back").addEventListener("click", closeAffirmationGame);
  affirmationModal.addEventListener("click", (e) => { if (e.target === affirmationModal) closeAffirmationGame(); });

  /* ---------------- affirmation lines manager ---------------- */
  // Lets the person edit the pool of lines itself: rename any existing
  // line in place, delete one, or add new ones. Changes save immediately
  // (debounced text edits save on blur/Enter) via saveAffirmationQuotes().

  const affirmationQuotesModal = $("#affirmation-quotes-modal");
  const affirmationQuotesListEl = $("#affirmation-quotes-list");
  const affirmationQuotesNewInput = $("#affirmation-quotes-new-input");

  function openAffirmationQuotesModal() {
    renderAffirmationQuotesModal();
    affirmationQuotesModal.classList.remove("hidden");
    requestAnimationFrame(() => affirmationQuotesNewInput.focus());
  }
  function closeAffirmationQuotesModal() {
    affirmationQuotesModal.classList.add("hidden");
    affirmationQuotesNewInput.value = "";
  }

  function renderAffirmationQuotesModal() {
    affirmationQuotesListEl.innerHTML = "";
    if (!affirmationQuotesList.length) {
      const empty = document.createElement("li");
      empty.className = "affirmation-quotes-empty";
      empty.textContent = "No lines yet — add one below.";
      affirmationQuotesListEl.appendChild(empty);
      return;
    }
    affirmationQuotesList.forEach((quote, idx) => {
      const li = document.createElement("li");
      li.className = "affirmation-quote-row";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "affirmation-quote-row-input";
      input.spellcheck = false;
      input.value = quote;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); input.value = quote; input.blur(); }
      });
      input.addEventListener("blur", () => {
        const v = input.value.trim();
        if (v && v !== affirmationQuotesList[idx]) {
          affirmationQuotesList[idx] = v;
          saveAffirmationQuotes();
        } else {
          input.value = affirmationQuotesList[idx];
        }
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "affirmation-quote-row-delete";
      del.title = "Remove this line";
      del.textContent = "×";
      del.addEventListener("click", () => {
        affirmationQuotesList.splice(idx, 1);
        saveAffirmationQuotes();
        renderAffirmationQuotesModal();
      });

      li.appendChild(input);
      li.appendChild(del);
      affirmationQuotesListEl.appendChild(li);
    });
  }

  function addAffirmationQuoteFromModal() {
    const v = affirmationQuotesNewInput.value.trim();
    if (!v) return;
    affirmationQuotesList.push(v);
    saveAffirmationQuotes();
    affirmationQuotesNewInput.value = "";
    renderAffirmationQuotesModal();
  }

  $("#affirmation-quotes-close").addEventListener("click", closeAffirmationQuotesModal);
  affirmationQuotesModal.addEventListener("click", (e) => { if (e.target === affirmationQuotesModal) closeAffirmationQuotesModal(); });
  affirmationQuotesNewInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); addAffirmationQuoteFromModal(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAffirmationQuotesModal(); }
  });
  document.addEventListener("keydown", (e) => {
    if (affirmationQuotesModal.classList.contains("hidden")) return;
    if (e.key === "Escape" && document.activeElement !== affirmationQuotesNewInput) closeAffirmationQuotesModal();
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
    await loadAllMaps();
    await loadAffirmationQuotes();
    await FolderDB.restore();
    if (FolderDB.dir && !FolderDB.needsPermission) {
      await FolderDB.syncFromFolder();
    }
    await DriveDB.restore(); // silent re-sign-in, only if previously connected
    if (state.maps.length === 0) {
      const sample = sampleMindMap();
      await DB.put(sample);
      await FolderDB.save(sample);
      await DriveDB.save(sample);
      state.maps.push(sample);
    }
    updateFolderUI();
    updateDriveUI();
    renderSidebar();
    // Reopen whichever map you had open last, if it still exists — falls
    // back to the top of the list (e.g. first run, or that map got
    // deleted on another device since).
    let lastId = null;
    try { lastId = localStorage.getItem(LAST_OPENED_MAP_KEY); } catch (e) {}
    const toOpen = (lastId && state.maps.find(m => m.id === lastId)) ? lastId : state.maps[0].id;
    await openMap(toOpen);
  }

  $("#btn-connect-folder").addEventListener("click", () => FolderDB.pick());
  $("#btn-google-signin").addEventListener("click", () => {
    if (DriveDB.signedIn) DriveDB.signOut();
    else DriveDB.signIn(false).catch(err => alert(err.message || "Google sign-in failed."));
  });

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

})();
