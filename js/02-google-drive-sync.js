/* Branchline — js/02-google-drive-sync.js
   Part 2 of 19 of the former single-file app.js. Contents: Google Drive sync.
   These files share one scope and MUST load in this exact order (see the list in app.js). */
"use strict";

  /* ---------------- Google Drive sync ----------------
     Drive v2 stores each map as a small JSON manifest (nodes/text/settings
     plus stable photo ids) and stores full-resolution photos as separate
     binary files. Metadata can sync/open immediately while photo Blobs are
     fetched lazily only for the map being opened. Legacy v1 inline-photo
     JSON files remain readable and migrate automatically on next save.

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

  // Waits for Google Identity Services to finish loading, instead of
  // failing the instant a click arrives a beat early. The gsi/client
  // script tag is loaded async (see index.html), so on a fresh page load
  // it can still be in flight for anywhere from tens of ms to a couple
  // of seconds after the rest of the app — including this sign-in
  // button — is already interactive. Polls rather than hooking the
  // script's load event so it works no matter when it's called relative
  // to that script finishing (including if it already has).
  function waitForGis(timeoutMs) {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve(true);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        if (window.google && google.accounts && google.accounts.oauth2) { resolve(true); return; }
        if (Date.now() - startedAt >= timeoutMs) { resolve(false); return; }
        setTimeout(check, 100);
      };
      check();
    });
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

  // How often the background poll checks Drive for changes made on other
  // devices. DriveDB.FRESH_WINDOW_MS is derived from this, so change it
  // here only.
  const DRIVE_POLL_INTERVAL_MS = 10000;

  const DriveDB = {
    tokenClient: null,
    accessToken: null,
    tokenExpiresAt: 0,
    // The in-flight requestToken() call, if any: { silent, promise, reject }.
    // See _requestTokenNow() — this exists so a later call can tell
    // whether it's safe to cancel the one already running, instead of
    // always barging in front of it.
    _activeRequest: null,

    // ---- One status field instead of a pile of booleans ----
    // "out"        — signed out.
    // "connecting" — signed in, first sync of this session hasn't
    //                finished yet (editing stays locked until it does,
    //                so a stale local copy can't get overwritten or
    //                overwrite something newer).
    // "ok"         — signed in, synced, everything reaching Drive fine.
    // "reauth"     — Google session/token expired; needs an explicit
    //                Reconnect Google click. Background code never opens
    //                OAuth windows.
    // "broken"     — signed in with a live token, but syncing/uploading
    //                is failing (network, Drive outage, etc.) — usually
    //                recovers on its own once the connection is back.
    // isEditingAllowed() only allows edits in "ok" (see below); every UI
    // string that used to branch on 4-5 separate flags now just branches
    // on this one.
    status: "out",
    get signedIn() { return this.status !== "out"; },
    get dataSynced() { return this.status === "ok" || this.status === "reauth" || this.status === "broken"; },
    get needsReauth() { return this.status === "reauth"; },
    driveBroken() { return this.status === "broken"; },

    // True while a syncFromDrive()/verifyRemote() pass is running —
    // both are "talk to Drive and reconcile" passes that must never
    // overlap each other, so callers only ever need to know "busy or
    // not", not which of the two it is.
    busy: false,
    // True while pushLocalNewer() is actively uploading — kept separate
    // from `busy` because the UI shows a distinct "Uploading changes…"
    // message for it.
    pushingLocal: false,
    lastLocalPushTryAt: 0,
    // Preserve the exact last Drive failure so an explicit Retry button can
    // report the real problem instead of replacing it with a generic message.
    lastDriveError: null,
    lastDriveErrorAt: 0,

    // Timestamp (ms) of the last time this device successfully talked to
    // Drive — purely a UI value (see updateDriveUI's "Synced Xm ago"),
    // never persisted or compared against anything.
    lastSyncedAt: 0,

    // Failed Drive polls (network/Drive outage) can push the connection
    // toward "broken". Authentication expiry is handled separately by
    // requireReconnect(), which never launches Google on its own.
    consecutivePollFailures: 0,
    MAX_POLL_FAILURES: 3,

    // Maps with edits Drive hasn't confirmed receiving yet.
    unsyncedMaps() {
      return state.maps.filter((m) => {
        const known = this.fileIndex[m.id];
        return !!known && (m.updatedAt || 0) > (known.updatedAt || 0);
      });
    },

    // "Am I on the latest version?" — kept for informational/UI timing
    // purposes (freshUntil/isFresh). It is NOT what gates the edit lock
    // or the "checking for a newer version" banner anymore — those are
    // driven by conflictDetected below, so a routine poll that simply
    // hasn't run yet (the timer aging out between cycles) never pauses
    // editing on its own; only Drive actually confirming another device
    // saved something newer does.
    FRESH_WINDOW_MS: DRIVE_POLL_INTERVAL_MS + 6000,
    freshUntil: 0,
    isFresh() { return Date.now() < this.freshUntil; },
    // True only when a Drive check has actually confirmed this device is
    // behind — either another device's saved copy is newer
    // (remoteBehindLocal), or a download of that newer copy just failed
    // (so it's still out there, unconfirmed). Cleared the moment a full
    // sync pass completes with nothing outstanding. This — not the
    // freshUntil timer — is what the edit lock and "checking for a
    // newer version" banner key off, so editing only ever pauses for a
    // real, known reason, never for a routine periodic recheck.
    conflictDetected: false,

    // Human-readable progress for the sync pill/modal. The old UI could sit
    // on a generic "Syncing…" for a long time, which made a large first sync
    // look frozen even while it was downloading photo-heavy maps. These are
    // deliberately UI-only; they never participate in conflict decisions.
    syncPhase: "",
    syncProgressDone: 0,
    syncProgressTotal: 0,
    syncProgressPercent: 0,
    syncStartedAt: 0,
    setSyncProgress(phase, done, total, percent) {
      this.syncPhase = phase || "";
      this.syncProgressDone = Number(done || 0);
      this.syncProgressTotal = Number(total || 0);
      if (!phase) {
        this.syncProgressPercent = 0;
        this.syncStartedAt = 0;
      } else {
        if (!this.syncStartedAt) this.syncStartedAt = Date.now();
        if (Number.isFinite(Number(percent))) {
          this.syncProgressPercent = Math.max(0, Math.min(100, Math.round(Number(percent))));
        } else if (this.syncProgressTotal > 0) {
          this.syncProgressPercent = Math.max(0, Math.min(100,
            Math.round((this.syncProgressDone / this.syncProgressTotal) * 100)));
        } else if (!this.syncProgressPercent) {
          this.syncProgressPercent = 1;
        }
      }
      try { updateDriveUI(); } catch (e) {}
    },
    // True if Drive holds a newer copy of any map this device already has.
    remoteBehindLocal(remoteFiles) {
      return remoteFiles.some((f) => {
        const id = f.appProperties && f.appProperties.branchlineId;
        if (!id) return false;
        const existing = state.maps.find(m => m.id === id);
        const props = f.appProperties || {};
        const remoteUpdatedAt = Number(props.updatedAt || 0);
        const remoteLastEditAt = Number(props.lastEditAt || remoteUpdatedAt || 0);
        const localLastEditAt = existing ? (mapLastEditAt(existing) || Number(existing.updatedAt) || 0) : 0;
        return !!existing && (remoteLastEditAt > localLastEditAt || remoteUpdatedAt > (existing.updatedAt || 0));
      });
    },
    // Check-only pass (no downloads, nothing touched locally): used while
    // a map edit is in progress, when the full sync can't run because it
    // would swap the tree out from under the editor. It keeps the
    // freshness stamp current, and clears it the moment another device
    // saves something newer.
    async verifyRemote() {
      const remoteFiles = await this.listRemote();
      const listedAt = Date.now();
      const behind = this.remoteBehindLocal(remoteFiles);
      this.conflictDetected = behind;
      this.freshUntil = behind ? 0 : listedAt + this.FRESH_WINDOW_MS;
      this.consecutivePollFailures = 0;
    },
    // map id -> { fileId, updatedAt } for every map we know is mirrored to
    // Drive, so save/remove don't have to search every time.
    fileIndex: {},
    // Drive v2 stores the map structure separately from photo Blobs.
    // Cache the remote photo index so normal text autosaves don't list
    // hundreds of photo files again and again.
    photoFileIndex: {},
    photoFolderIndex: {},
    photoHydrationByMap: {},
    photoHydrationById: {},
    photoHydratedMaps: new Set(),

    configured() {
      return !!GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith("PASTE_");
    },

    // Authentication may only be started by an explicit user click.
    // Any automatic path that discovers an expired/rejected token lands
    // here instead of calling Google Identity Services.
    requireReconnect() {
      if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      clearCachedDriveToken();
      if (this.status !== "out") this.status = "reauth";
      stopDriveSyncPolling();
      updateDriveUI();
    },

    // Google OAuth is never launched from a timer. Keep using a valid
    // access token normally; shortly before it expires, switch the UI to
    // "Reconnect Google" and wait for an explicit click.
    refreshTimer: null,
    scheduleRefresh() {
      if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
      if (!this.signedIn || this.needsReauth || !this.tokenExpiresAt) return;
      // A minute before expiry, stop cloud traffic and ask for an explicit
      // reconnect instead of launching any Google auth flow in the background.
      const delay = Math.max(1000, this.tokenExpiresAt - Date.now() - 60000);
      this.refreshTimer = setTimeout(() => {
        this.requireReconnect();
      }, delay);
    },

    // On page load: reuse a still-valid cached token with no network
    // round-trip at all if we have one (the common case for an F5 within
    // the same hour); otherwise fall back to a silent (no popup) Google
    // re-auth attempt, but only if we'd signed in successfully before —
    // so a person who's never connected Drive never sees a Google popup
    // flash by uninvited.
    async restore() {
      if (!this.configured()) return;
      const cached = loadCachedDriveToken();
      if (cached) {
        this.accessToken = cached.token;
        this.tokenExpiresAt = cached.expiresAt;
        this.status = "connecting";
        this.setSyncProgress("Checking Drive…", 0, 0, 2);
        updateDriveUI("Syncing…");
        try {
          await this.syncFromDrive();
          this.status = "ok";
          await this.pushLocalNewer({ force: true, includeNew: true });
          this.setSyncProgress("", 0, 0);
          renderSidebar();
          // Repaint the already-open map's canvas with whatever this sync
          // just pulled in — without this, the currently-open map (and any
          // node badges/score bars on it) stays showing the pre-sync local
          // copy until the first poll tick happens to call renderAll().
          // Same guard as pollDriveUpdates: don't tear down an active edit
          // box mid-keystroke or clobber a change still mid-save.
          if (!state.editingId && !unsavedEdits) renderAll();
          updateDriveUI();
          startDriveSyncPolling();
          this.scheduleRefresh();
          syncTaskTemplatesWithDrive();
          return;
        } catch (e) {
          console.error("Cached Drive token no longer works; reconnect required", e);
          this.requireReconnect();
          return;
        }
      }
      let was = false;
      try { was = await DB.getHandle(DRIVE_SIGNED_IN_KEY); } catch (e) {}
      if (!was) return;
      // This browser connected Drive before, but v389 deliberately does not
      // start GIS during startup. Keep the cached/local map visible and wait
      // for the user to tap Reconnect Google.
      startupLocalPreview = true;
      this.status = "connecting";
      renderSidebar();
      if (!state.editingId && !unsavedEdits) renderAll();
      this.status = "reauth";
      updateDriveUI("Reconnect Google");
      stopDriveSyncPolling();
    },

    // NOTE: deliberately no longer reused across calls — see requestToken()
    // below for why each call gets its own throwaway client instead.
    ensureTokenClient() {
      return !!(window.google && google.accounts && google.accounts.oauth2);
    },

    requestToken(silent) {
      // v389: Never invoke Google Identity Services from a background/silent
      // path. On Android/Edge, prompt:"none" can still hand control to an
      // accounts.google.com auth surface and leave the app trapped there.
      // Background callers must fall back to local data + Reconnect Google;
      // only an explicit user click is allowed to start OAuth.
      if (silent) {
        return Promise.reject(new Error("Google reconnect requires a user click."));
      }

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
      // Fast path: GIS has already finished loading, true for the vast
      // majority of clicks. Go straight to requestAccessToken() below with
      // no async gap at all, so the call stays inside this click's own
      // user gesture — Safari in particular blocks the popup outright if
      // it isn't.
      if (this.ensureTokenClient()) return this._requestTokenNow(silent);
      // Slow path: the accounts.google.com/gsi/client script (loaded
      // async in index.html) hasn't finished downloading/executing yet.
      // Wait for it instead of bailing out with "hasn't loaded yet — try
      // again", which is exactly why sign-in so often needed a second
      // click before — the click itself did nothing wrong, it just lost
      // a race that had nothing to do with the user.
      return waitForGis(8000).then((ready) => {
        if (!ready) throw new Error("Google sign-in script hasn't loaded — check your connection and try again.");
        return this._requestTokenNow(silent);
      });
    },

    _requestTokenNow(silent) {
      // Never let a new call barge in front of one that's already
      // running. A silent background check is still allowed to lose to
      // an explicit click — a person acting right now always outranks an
      // automatic check — but nothing is ever allowed to cancel an
      // explicit request that's already in flight; the safest thing a
      // second call can do there is wait on the one already running
      // (which also means an accidental double-click never opens a
      // second popup).
      if (this._activeRequest) {
        if (this._activeRequest.silent && !silent) {
          this._activeRequest.reject(new Error("Superseded by a newer sign-in request"));
        } else {
          return this._activeRequest.promise;
        }
      }
      let rejectExternally = null;
      const promise = new Promise((resolve, reject) => {
        if (!this.ensureTokenClient()) { reject(new Error("Google sign-in script hasn't loaded — check your connection and try again.")); return; }
        // Watchdog: if neither the success callback nor error_callback
        // ever fires, don't leave the button hung forever with no
        // feedback.
        let settled = false;
        const timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Google sign-in didn't respond after 15 seconds — it may have been blocked by a popup blocker, or this page's origin isn't authorized for this OAuth client yet. Check the browser console for details."));
        }, 15000);
        const settle = (fn, arg) => {
          if (settled) return; // a second callback firing for the same call, or one arriving after this call was itself superseded — ignore rather than double-settle
          settled = true;
          clearTimeout(timeoutId);
          fn(arg);
        };
        rejectExternally = (err) => settle(reject, err);
        // A fresh, throwaway token client for THIS call only, rather than
        // reusing one shared client across calls, so a stale response can
        // only ever reach its own (already-settled, now-inert) closure,
        // never a newer call's.
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: (resp) => {
            if (resp && resp.access_token) {
              this.accessToken = resp.access_token;
              this.tokenExpiresAt = Date.now() + ((resp.expires_in || 3300) * 1000);
              saveCachedDriveToken(this.accessToken, this.tokenExpiresAt);
              // Any successful token — silent or explicit — proves Google
              // auth is working again: drop out of "reauth"/"broken" back
              // to "ok" (both only ever happen after a first successful
              // sync, so "ok" is always the right landing spot here).
              if (this.status === "reauth" || this.status === "broken") this.status = "ok";
              this.consecutivePollFailures = 0;
              settle(resolve, resp.access_token);
            } else {
              settle(reject, resp && resp.error ? new Error(resp.error) : new Error("Sign-in didn't return a token"));
            }
          },
          error_callback: (err) => settle(reject, new Error(describeGisError(err))),
        });
        client.requestAccessToken({ prompt: silent ? "none" : "consent" });
      });
      const entry = { silent, promise, reject: (err) => { if (rejectExternally) rejectExternally(err); } };
      this._activeRequest = entry;
      promise.catch(() => {}).finally(() => {
        if (this._activeRequest === entry) this._activeRequest = null;
      });
      return promise;
    },

    // Reuse a valid token. Once it expires, never start OAuth from a
    // background Drive request; leave the local map available and wait for
    // an explicit Reconnect Google tap.
    async getToken() {
      if (this.accessToken && Date.now() < this.tokenExpiresAt - 5000) return this.accessToken;
      this.requireReconnect();
      throw new Error("Google session expired — tap Reconnect Google.");
    },

    // Thin wrapper around fetch that attaches the bearer token and retries
    // once (with a forced fresh token) on a 401, since a token can expire
    // between getToken() returning it and the request actually landing.
    async api(url, opts, _retried) {
      const token = await this.getToken();
      const input = opts || {};
      const timeoutMs = Number(input.timeoutMs || 45000);
      const fetchOpts = { ...input };
      delete fetchOpts.timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          ...fetchOpts,
          signal: fetchOpts.signal || controller.signal,
          headers: { ...(fetchOpts && fetchOpts.headers), Authorization: `Bearer ${token}` }
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error("Google Drive request timed out");
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401) {
        // v389: A 401 must never recurse into GIS. Re-auth is user initiated.
        this.requireReconnect();
        throw new Error("Google session expired — tap Reconnect Google.");
      }
      return res;
    },

    async signIn(silent) {
      if (!this.configured()) {
        alert("Google Drive sync needs to be set up first — a developer needs to add a Google OAuth Client ID to the app (see the README's \"Google Drive sync setup\" section).");
        return;
      }
      await this.requestToken(!!silent);
      if (this.status === "out") this.status = "connecting";
      try { await DB.setHandle(DRIVE_SIGNED_IN_KEY, true); } catch (e) {}
      this.setSyncProgress("Checking Drive…", 0, 0, 2);
      updateDriveUI("Syncing…");
      try {
        await this.syncFromDrive();
        this.status = "ok";
        await this.pushLocalNewer({ force: true, includeNew: true });
        this.setSyncProgress("", 0, 0);
      } catch (e) {
        console.error("Drive sync failed", e);
        // A successful OAuth token does NOT mean Drive sync succeeded.
        // Keep editing locked and keep a recovery button visible until a
        // real Drive read/upload completes. Previously a failed retry could
        // leave status="ok", which hid Retry Drive even though nothing had
        // actually recovered.
        const tokenStillValid = !!this.accessToken && Date.now() < this.tokenExpiresAt - 5000;
        if (!tokenStillValid || this.needsReauth) {
          this.requireReconnect();
        } else {
          this.status = "broken";
          this.lastLocalPushTryAt = Date.now() - 10000;
          this.setSyncProgress(
            "Drive sync failed — tap Retry Drive",
            0, 0,
            Math.max(1, this.syncProgressPercent || 1)
          );
          try { updateDriveUI(); } catch (e2) {}
        }
        if (!silent) alert("Signed in, but syncing with Drive failed: " + (e.message || e) + "\n\nYour maps are still safe locally — tap Retry Drive after checking the connection.");
      }
      renderSidebar();
      // See the matching comment in restore() above — repaint the open
      // map immediately so a fresher score/badge from this sync doesn't
      // sit stale on screen until the next poll tick.
      if (!state.editingId && !unsavedEdits) renderAll();
      updateDriveUI();
      startDriveSyncPolling();
      this.scheduleRefresh();
      syncTaskTemplatesWithDrive();
    },

    async reconnectAndResume() {
      if (!this.configured()) throw new Error("Google Drive sync is not configured.");
      if (!isOnline) throw new Error("No internet connection.");

      // "Retry Drive" must stay a recovery operation until Drive really
      // answers. Do NOT flip status to "ok" before the read/upload succeeds:
      // doing that hid the retry button after another failed request.
      const tokenStillValid = !!this.accessToken && Date.now() < this.tokenExpiresAt - 5000;
      if (this.needsReauth || !tokenStillValid) {
        await this.signIn(false);
        if (this.needsReauth) throw new Error("Google reconnect is still required.");
        if (this.driveBroken() || this.status !== "ok") {
          throw new Error("Google connected, but Drive sync is still not complete.");
        }
        return true;
      }

      this.consecutivePollFailures = 0;
      this.lastLocalPushTryAt = 0;
      this.setSyncProgress("Retrying Google Drive…", 0, 0, Math.max(1, this.syncProgressPercent || 1));
      try { updateDriveUI(); } catch (e) {}

      // If an automatic retry/poll is already using Drive, wait briefly for
      // it instead of treating this tap as a successful no-op.
      const waitStarted = Date.now();
      while ((this.pushingLocal || this.busy) && Date.now() - waitStarted < 20000) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (this.pushingLocal || this.busy) {
        throw new Error("Drive is still finishing another sync. Tap Retry Drive again in a moment.");
      }

      try {
        // Keep status="broken" while this read is in flight. syncFromDrive()
        // changes it back to "ok" only after Drive actually responds.
        this.busy = true;
        try {
          await this.syncFromDrive();
        } finally {
          this.busy = false;
        }

        // Resume only maps/photos Drive has not confirmed. save() reuses the
        // photos already uploaded before an interruption.
        await this.pushLocalNewer({
          force: true,
          includeNew: true,
          forceRemotePhotos: true,
          throwOnFailure: true
        });

        if (this.needsReauth) throw new Error("Google session expired during the retry.");
        if (this.driveBroken() || this.status !== "ok") {
          throw (this.lastDriveError || new Error("Google Drive retry did not complete."));
        }

        this.setSyncProgress("", 0, 0);
        this.scheduleRefresh();
        startDriveSyncPolling();
        try { updateDriveUI(); } catch (e) {}
        return true;
      } catch (e) {
        // Authentication errors own the "reauth" state. Every other retry
        // failure stays "broken" so Retry Drive remains visible and editing
        // remains locked rather than pretending the device is synced.
        if (!this.needsReauth) {
          this.status = "broken";
          this.lastLocalPushTryAt = Date.now() - 10000;
          const detail = (e && e.message) ? e.message : "Drive retry failed";
          this.setSyncProgress(
            detail.length > 96 ? (detail.slice(0, 93) + "…") : detail,
            0, 0,
            Math.max(1, this.syncProgressPercent || 1)
          );
        }
        try { updateDriveUI(); } catch (e2) {}
        throw e;
      }
    },

    signOut() {
      if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
      // Deliberately NOT calling google.accounts.oauth2.revoke() here.
      // revoke() doesn't just drop this browser's token — it revokes the
      // whole OAuth consent grant for this Google account + this app's
      // client ID, which invalidates every other device/browser's access
      // token issued under that same grant too. A plain local sign-out
      // (forget the token here, let it expire naturally on Google's side
      // within the hour) keeps other devices' sessions untouched.
      this.accessToken = null;
      this.status = "out";
      this.freshUntil = 0;
      this.conflictDetected = false;
      this.fileIndex = {};
      this.photoFileIndex = {};
      this.photoFolderIndex = {};
      this.photoHydrationByMap = {};
      this.photoHydrationById = {};
      this.photoHydratedMaps.clear();
      this.lastSyncedAt = 0;
      this.setSyncProgress("", 0, 0);
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
      // Google Drive's appProperties search syntax requires BOTH a key
      // and a value inside the has{} clause; querying by key alone returns
      // HTTP 400. List the app-created files with pagination, then filter
      // map manifests client-side by branchlineId. Photo files use
      // branchlineMapId (not branchlineId), so they are discarded below.
      const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,appProperties)");
      const q = encodeURIComponent("trashed=false");
      const out = [];
      let pageToken = "";
      do {
        const tokenPart = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
        const res = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&spaces=drive&pageSize=1000${tokenPart}`);
        if (!res.ok) throw new Error("Couldn't list Drive maps (" + res.status + ")");
        const data = await res.json();
        (data.files || []).forEach((f) => {
          if (f.appProperties && f.appProperties.branchlineId) out.push(f);
        });
        pageToken = data.nextPageToken || "";
      } while (pageToken);
      return out;
    },

    driveFormatFor(file) {
      return String((file && file.appProperties && file.appProperties.branchlineFormat) || "1");
    },

    async downloadFile(fileId) {
      const res = await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { timeoutMs: 180000 });
      if (!res.ok) throw new Error("Couldn't download a map from Drive (" + res.status + ")");
      return res.json();
    },

    async downloadPhotoFile(fileId) {
      const res = await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { timeoutMs: 180000 });
      if (!res.ok) throw new Error("Couldn't download a photo from Drive (" + res.status + ")");
      return res.blob();
    },

    // Fetch ONE photo on demand. This is important for a phone that already
    // has the small v2 map manifest but not every binary photo yet: opening a
    // missing slot should repair that slot immediately instead of showing a
    // permanently blank viewer until the whole map is re-hydrated.
    async hydratePhotoById(map, photoId, opts) {
      if (!map || !photoId || !this.signedIn) return false;
      if (photoBlobCache.has(photoId) && photoCache.get(photoId)) return true;

      // Disk may already have it even if the in-memory cache was cold.
      try {
        const rec = await PhotoDB.get(photoId);
        let blob = rec && rec.blob;
        if (!blob && rec && rec.data) {
          try { blob = dataUrlToBlob(rec.data); } catch (e) {}
        }
        if (blob) {
          if (state.current && state.current.id === map.id) {
            const old = photoCache.get(photoId);
            if (old) { try { URL.revokeObjectURL(old); } catch (e) {} }
            photoBlobCache.set(photoId, blob);
            photoCache.set(photoId, URL.createObjectURL(blob));
          }
          return true;
        }
      } catch (e) {}

      const key = map.id + "::" + photoId;
      if (this.photoHydrationById[key]) return this.photoHydrationById[key];

      const run = (async () => {
        let remote = await this.listRemotePhotos(map.id, false);
        let f = remote[photoId];

        // Cached photo index can be stale right after another device rescued
        // an old/quarantined photo, so re-list Drive once before giving up.
        if (!f && (!opts || opts.forceIndex !== false)) {
          remote = await this.listRemotePhotos(map.id, true);
          f = remote[photoId];
        }
        if (!f) return false;

        const blob = await this.downloadPhotoFile(f.id);
        await PhotoDB.put({ id: photoId, mapId: map.id, blob });

        if (state.current && state.current.id === map.id) {
          const old = photoCache.get(photoId);
          if (old) { try { URL.revokeObjectURL(old); } catch (e) {} }
          photoBlobCache.set(photoId, blob);
          photoCache.set(photoId, URL.createObjectURL(blob));
          photoFpGeneration++;
          photoFpIndexPromise = indexPhotoFingerprints(photoFpGeneration);
        }
        return true;
      })();

      this.photoHydrationById[key] = run;
      try {
        return await run;
      } finally {
        delete this.photoHydrationById[key];
      }
    },

    filenameFor(map) {
      const safe = (map.title || "untitled").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40) || "untitled";
      return `${safe}-${map.id}.map.json`;
    },

    photoFilename(mapId, photoId, mime) {
      const ext = mime === "image/png" ? "png"
        : mime === "image/webp" ? "webp"
        : mime === "image/gif" ? "gif"
        : mime === "image/svg+xml" ? "svg"
        : "jpg";
      return `photo-${String(photoId).slice(0, 48)}.${ext}`;
    },

    // Both map manifests and binary photos use resumable uploads. The map
    // manifest stays small; full-resolution image bytes never get expanded
    // into base64 just to sync them.
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

    _escapeDriveQueryValue(value) {
      return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    },

    async _listPhotoEntries(mapId) {
      const mid = this._escapeDriveQueryValue(mapId);
      const q = encodeURIComponent(`trashed=false and appProperties has { key='branchlineMapId' and value='${mid}' }`);
      const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,size,appProperties)");
      const out = [];
      let pageToken = "";
      do {
        const tokenPart = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
        const res = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&spaces=drive&pageSize=1000${tokenPart}`);
        if (!res.ok) throw new Error("Couldn't list Drive photos (" + res.status + ")");
        const data = await res.json();
        out.push(...(data.files || []));
        pageToken = data.nextPageToken || "";
      } while (pageToken);
      return out;
    },

    async listRemotePhotos(mapId, force) {
      if (!force && this.photoFileIndex[mapId]) return this.photoFileIndex[mapId];
      const entries = await this._listPhotoEntries(mapId);
      const index = {};
      entries.forEach((f) => {
        const p = f.appProperties || {};
        if (p.branchlinePhoto === "1" && p.branchlinePhotoId) index[p.branchlinePhotoId] = f;
        if (p.branchlinePhotoFolder === "1") this.photoFolderIndex[mapId] = f.id;
      });
      this.photoFileIndex[mapId] = index;
      return index;
    },

    async ensurePhotoFolder(map) {
      if (this.photoFolderIndex[map.id]) return this.photoFolderIndex[map.id];
      const entries = await this._listPhotoEntries(map.id);
      const existing = entries.find((f) => f.appProperties && f.appProperties.branchlinePhotoFolder === "1");
      if (existing) {
        this.photoFolderIndex[map.id] = existing.id;
        return existing.id;
      }
      const safe = (map.title || "Untitled map").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 48) || "Untitled map";
      const metadata = {
        name: `Branchline Photos - ${safe}`,
        mimeType: "application/vnd.google-apps.folder",
        appProperties: {
          branchlineMapId: map.id,
          branchlinePhotoFolder: "1"
        }
      };
      const res = await this.api("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(metadata)
      });
      if (!res.ok) throw new Error("Couldn't create the Drive photo folder (" + res.status + ")");
      const data = await res.json();
      this.photoFolderIndex[map.id] = data.id;
      return data.id;
    },

    async uploadPhotoFile(map, photoId, blob, folderId) {
      const metadata = {
        name: this.photoFilename(map.id, photoId, blob.type),
        mimeType: blob.type || "application/octet-stream",
        parents: folderId ? [folderId] : undefined,
        appProperties: {
          branchlineMapId: map.id,
          branchlinePhoto: "1",
          branchlinePhotoId: photoId
        }
      };
      if (!metadata.parents) delete metadata.parents;

      // Large first-time migrations can mean dozens/hundreds of separate
      // photo uploads. A single transient 429/5xx/network hiccup must not
      // abort the entire map after 30 successful photos. Retry each photo
      // independently. Before retrying, re-list Drive once: if Google
      // actually committed the previous attempt but the response was lost,
      // reuse that file instead of creating a duplicate.
      let lastError = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (attempt > 1) {
          try {
            const refreshed = await this.listRemotePhotos(map.id, true);
            if (refreshed[photoId]) return refreshed[photoId].id;
          } catch (e) {
            // A failed verification is not fatal; the fresh upload attempt
            // below can still succeed.
          }
          const waitMs = Math.min(12000, 800 * Math.pow(2, attempt - 2));
          this.setSyncProgress(`Drive paused — retrying photo in ${Math.ceil(waitMs / 1000)}s…`, 0, 0);
          await new Promise((r) => setTimeout(r, waitMs));
        }

        try {
          const uploadUrl = await this.startResumableSession(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", "POST", metadata
          );
          const putRes = await this.api(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": blob.type || "application/octet-stream" },
            body: blob,
            timeoutMs: 300000
          });
          if (putRes.ok) {
            const data = await putRes.json();
            return data.id;
          }

          const status = putRes.status;
          let bodyText = "";
          try { bodyText = (await putRes.text()).slice(0, 300); } catch (e) {}
          lastError = new Error("Photo upload failed (" + status + ")" + (bodyText ? ": " + bodyText : ""));

          // 408/409/429 and 5xx are explicitly transient. Google may also
          // return 403 for rate-limit/backend throttling, so retry that too.
          const retryable = status === 403 || status === 408 || status === 409 ||
            status === 429 || (status >= 500 && status <= 599);
          if (!retryable) throw lastError;
        } catch (e) {
          lastError = e;
          // Authentication failures are handled inside api() and should not
          // be hammered with repeated new sessions after reauth was required.
          if (this.needsReauth) throw e;
          if (attempt >= 5) throw e;
        }
      }
      throw lastError || new Error("Couldn't upload photo to Drive");
    },

    // Emergency repair for an interrupted v1 -> v2 migration.
    //
    // During the split-storage migration the local tree is converted from
    // inline data: URLs to short photo ids BEFORE every binary photo has made
    // it to Drive. If the browser/IndexedDB loses one of those Blob rows, the
    // tree still knows the id but neither PhotoDB nor the new Drive photo
    // folder has the bytes. The old v1 Drive JSON is deliberately not replaced
    // until ALL photos upload, so use it as a recovery source.
    //
    // We match by stable node/task/note ids and by photo position inside each
    // owner. If the current Drive file is already v2, we also inspect a few
    // large previous Drive revisions; that gives us a second chance even if a
    // partially-completed migration managed to publish a small manifest.
    async recoverMissingLocalPhotos(map, missingIds) {
      const wanted = new Set((missingIds || []).filter(Boolean));
      if (!map || !map.root || !wanted.size) return { recovered: 0, remaining: Array.from(wanted) };

      const recovered = new Map(); // local photo id -> Blob
      const isDataUrl = (v) => typeof v === "string" && v.startsWith("data:");

      const pairLists = (localList, remoteList) => {
        const a = Array.isArray(localList) ? localList : [];
        const b = Array.isArray(remoteList) ? remoteList : [];
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
          const localId = a[i];
          const remoteValue = b[i];
          if (!wanted.has(localId) || recovered.has(localId) || !isDataUrl(remoteValue)) continue;
          try { recovered.set(localId, dataUrlToBlob(remoteValue)); } catch (e) {}
        }
      };

      const imageList = (owner) => {
        if (!owner) return [];
        if (Array.isArray(owner.images)) return owner.images;
        return owner.image ? [owner.image] : [];
      };

      const dataUrlsFromNoteHtml = (html) => {
        const out = [];
        if (!html || html.indexOf("data:") === -1) return out;
        const re = /<img\b[^>]*\bsrc=(["'])(data:[\s\S]*?)\1[^>]*>/gi;
        let m;
        while ((m = re.exec(html))) out.push(m[2]);
        return out;
      };

      const pairNotes = (localOwner, remoteOwner) => {
        const locals = (localOwner && Array.isArray(localOwner.notes)) ? localOwner.notes : [];
        const remotes = (remoteOwner && Array.isArray(remoteOwner.notes)) ? remoteOwner.notes : [];
        const byId = new Map(remotes.filter(Boolean).map((n) => [n.id, n]));
        locals.forEach((ln, i) => {
          if (!ln) return;
          const rn = (ln.id && byId.get(ln.id)) || remotes[i];
          if (!rn) return;
          pairLists(extractNotePhotoIds(ln.html || ""), dataUrlsFromNoteHtml(rn.html || ""));
        });
      };

      const pairLinkPhotos = (localOwner, remoteOwner) => {
        const a = localOwner && localOwner.linkPhotos;
        const b = remoteOwner && remoteOwner.linkPhotos;
        if (!a || !b) return;
        Object.keys(a).forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(b, k)) pairLists(a[k], b[k]);
        });
      };

      const pairTaskList = (localTasks, remoteTasks) => {
        const locals = Array.isArray(localTasks) ? localTasks : [];
        const remotes = Array.isArray(remoteTasks) ? remoteTasks : [];
        const byId = new Map(remotes.filter(Boolean).map((t) => [t.id, t]));
        locals.forEach((lt, i) => {
          if (!lt) return;
          const rt = (lt.id && byId.get(lt.id)) || remotes[i];
          if (!rt) return;
          pairNotes(lt, rt);

          const ls = Array.isArray(lt.subtasks) ? lt.subtasks : [];
          const rs = Array.isArray(rt.subtasks) ? rt.subtasks : [];
          const subById = new Map(rs.filter(Boolean).map((s) => [s.id, s]));
          ls.forEach((lsub, j) => {
            if (!lsub) return;
            const rsub = (lsub.id && subById.get(lsub.id)) || rs[j];
            if (rsub) pairNotes(lsub, rsub);
          });
        });
      };

      const pairAttach = (localNode, remoteNode) => {
        const la = localNode && localNode.table && Array.isArray(localNode.table.attach)
          ? localNode.table.attach : [];
        const ra = remoteNode && remoteNode.table && Array.isArray(remoteNode.table.attach)
          ? remoteNode.table.attach : [];
        for (let r = 0; r < Math.min(la.length, ra.length); r++) {
          const lrow = la[r] || [], rrow = ra[r] || [];
          for (let col = 0; col < Math.min(lrow.length, rrow.length); col++) {
            const lc = lrow[col], rc = rrow[col];
            if (!lc || !rc) continue;
            pairLists(imageList(lc), imageList(rc));
            pairLinkPhotos(lc, rc);
            pairNotes(lc, rc);
            pairTaskList(lc.tasks, rc.tasks);
          }
        }
      };

      const recoverFromRemoteMap = (remoteMap) => {
        if (!remoteMap || !remoteMap.root) return 0;
        const before = recovered.size;
        const remoteNodes = new Map();
        (function index(n) {
          if (!n) return;
          if (n.id) remoteNodes.set(n.id, n);
          (n.children || []).forEach(index);
        })(remoteMap.root);

        (function walk(localNode) {
          if (!localNode) return;
          const remoteNode = localNode.id ? remoteNodes.get(localNode.id) : null;
          if (remoteNode) {
            pairLists(imageList(localNode), imageList(remoteNode));
            pairLinkPhotos(localNode, remoteNode);
            pairNotes(localNode, remoteNode);
            pairTaskList(localNode.tasks, remoteNode.tasks);
            pairAttach(localNode, remoteNode);
          }
          (localNode.children || []).forEach(walk);
        })(map.root);
        return recovered.size - before;
      };

      const tryDownloadMap = async (fileId) => {
        try {
          const legacy = await this.downloadFile(fileId);
          return recoverFromRemoteMap(legacy);
        } catch (e) {
          console.warn("Couldn't inspect Drive map for photo recovery", e);
          return 0;
        }
      };

      this.setSyncProgress(
        `Repairing ${wanted.size} missing photo${wanted.size === 1 ? "" : "s"} from old Drive copy…`,
        0, wanted.size, Math.max(2, Math.min(10, this.syncProgressPercent || 2))
      );

      // 1) Search every Drive map file carrying this map id. Older builds could
      // leave a duplicate; one of those may still be the big inline-photo v1.
      let matchingFiles = [];
      try {
        matchingFiles = (await this.listRemote()).filter((f) =>
          f && f.appProperties && f.appProperties.branchlineId === map.id
        );
      } catch (e) {}

      // Put the file currently indexed for this map first.
      const known = this.fileIndex[map.id];
      if (known && known.fileId) {
        matchingFiles.sort((a, b) => (a.id === known.fileId ? -1 : (b.id === known.fileId ? 1 : 0)));
      }

      const inspected = new Set();
      for (const f of matchingFiles) {
        if (!f || !f.id || inspected.has(f.id)) continue;
        inspected.add(f.id);
        const format = String((f.appProperties && f.appProperties.branchlineFormat) || "1");
        if (format !== "2") await tryDownloadMap(f.id);
        if (Array.from(wanted).every((id) => recovered.has(id))) break;
      }

      // 2) If the current file is already v2 (or the v1 body did not contain
      // everything), inspect the biggest recent revisions. The old monolithic
      // JSON is normally dramatically larger than the new manifest, so sorting
      // by size finds it without downloading every revision.
      if (known && known.fileId && !Array.from(wanted).every((id) => recovered.has(id))) {
        try {
          const fields = encodeURIComponent("revisions(id,modifiedTime,size)");
          const res = await this.api(
            `https://www.googleapis.com/drive/v3/files/${known.fileId}/revisions?fields=${fields}&pageSize=20`,
            { timeoutMs: 60000 }
          );
          if (res.ok) {
            const data = await res.json();
            const revisions = (data.revisions || []).slice()
              .sort((a, b) => Number(b.size || 0) - Number(a.size || 0))
              .slice(0, 6);
            for (const rev of revisions) {
              if (!rev || !rev.id) continue;
              try {
                const rr = await this.api(
                  `https://www.googleapis.com/drive/v3/files/${known.fileId}/revisions/${rev.id}?alt=media`,
                  { timeoutMs: 180000 }
                );
                if (!rr.ok) continue;
                const oldMap = await rr.json();
                recoverFromRemoteMap(oldMap);
              } catch (e) {
                console.warn("Couldn't inspect an older Drive revision", e);
              }
              if (Array.from(wanted).every((id) => recovered.has(id))) break;
            }
          }
        } catch (e) {
          console.warn("Drive revision recovery unavailable", e);
        }
      }

      if (recovered.size) {
        const records = Array.from(recovered.entries()).map(([id, blob]) => ({ id, mapId: map.id, blob }));
        await PhotoDB.putMany(records);

        // Restore the open map's in-memory display cache too, so recovered
        // images immediately reappear instead of waiting for a reload.
        if (state.current && state.current.id === map.id) {
          for (const [id, blob] of recovered.entries()) {
            const oldUrl = photoCache.get(id);
            if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch (e) {} }
            photoBlobCache.set(id, blob);
            photoCache.set(id, URL.createObjectURL(blob));
          }
          photoFpGeneration++;
          photoFpIndexPromise = indexPhotoFingerprints(photoFpGeneration);
          try { if (!state.editingId && !unsavedEdits) renderAll(); } catch (e) {}
        }
      }

      const remaining = Array.from(wanted).filter((id) => !recovered.has(id));
      if (recovered.size) {
        this.setSyncProgress(
          `Recovered ${recovered.size} missing photo${recovered.size === 1 ? "" : "s"} — continuing upload…`,
          recovered.size, wanted.size,
          Math.max(5, Math.min(15, Math.round((recovered.size / wanted.size) * 15)))
        );
      }
      return { recovered: recovered.size, remaining };
    },

    async syncPhotosForMap(map, opts) {
      const options = opts || {};

      // Re-list Drive first, then use BOTH local and remote ids to repair the
      // duplicate note-image alias chains produced by old export/import code.
      // This is intentionally before collectReferencedPhotoIds(): otherwise
      // hundreds of stale aliases get counted as separate photos again.
      const ownRemote = await this.listRemotePhotos(map.id, !!options.forceRemote);
      const sharedSourceId = sharedPhotoSourceMapId(map);
      const sharedRemote = sharedSourceId
        ? await this.listRemotePhotos(sharedSourceId, !!options.forceRemote)
        : {};
      // Read path sees both sets. Write/cleanup path below only ever mutates
      // ownRemote, so a recovery map can never delete or re-upload the
      // original map's shared Drive photos.
      const remote = { ...sharedRemote, ...ownRemote };
      let localRows = [];
      try { localRows = await photoRowsForMapWithSharedSource(map); } catch (e) {}
      const localIds = new Set(localRows.map((r) => r && r.id).filter(Boolean));
      if (state.current && state.current.id === map.id) {
        for (const id of photoBlobCache.keys()) localIds.add(id);
      }
      const availableIds = new Set([...localIds, ...Object.keys(remote)]);

      // A quarantined photo is not permanently discarded. If the exact id
      // later reappears from another browser, a restored backup, or Drive,
      // automatically put it back into normal sync.
      if (Array.isArray(map.root && map.root._missingPhotoIds) && map.root._missingPhotoIds.length) {
        const before = map.root._missingPhotoIds.length;
        map.root._missingPhotoIds = map.root._missingPhotoIds.filter((id) => !availableIds.has(id));
        if (!map.root._missingPhotoIds.length) delete map.root._missingPhotoIds;
        if (before !== (map.root._missingPhotoIds ? map.root._missingPhotoIds.length : 0)) {
          try { await DB.put(map); } catch (e) {}
        }
      }

      const aliasRepair = repairDuplicateNotePhotoAliases(map, availableIds);
      if (aliasRepair.changedTags) {
        // Data repair only: don't bump updatedAt. The normal manifest upload
        // below publishes the cleaned HTML after its photos are safe.
        try { await DB.put(map); } catch (e) {}
        this.setSyncProgress(
          `Repaired ${aliasRepair.removedAliases} duplicate photo links…`,
          0, 0, 4
        );
        console.warn(
          "Repaired duplicate note photo ids",
          aliasRepair
        );
      }

      const referenced = collectReferencedPhotoIds(map.root);
      const missing = Array.from(referenced).filter((id) => !remote[id]);
      const alreadyUploaded = referenced.size - missing.length;

      // Before uploading, verify that every not-yet-on-Drive photo still has
      // bytes on this device. If IndexedDB lost a REAL photo row, recover it
      // from the still-intact legacy Drive JSON (or an older Drive revision).
      const locallyMissing = missing.filter((id) => !localIds.has(id));
      if (locallyMissing.length) {
        await this.recoverMissingLocalPhotos(map, locallyMissing);
      }

      let folderId = null;
      const unavailable = [];
      for (let i = 0; i < missing.length; i++) {
        const photoId = missing[i];
        const photoNumber = alreadyUploaded + i + 1;
        let rec = null;
        try { rec = await PhotoDB.get(photoId); } catch (e) {}
        let photoBlob = rec && rec.blob;
        if (!photoBlob && rec && rec.data) {
          try { photoBlob = dataUrlToBlob(rec.data); } catch (e) {}
        }
        if (!photoBlob && state.current && state.current.id === map.id) {
          photoBlob = photoBlobCache.get(photoId) || null;
        }

        // One corrupt/missing local row must not stop the other 295 photos
        // from reaching Drive. Record it, continue the rest, and only refuse
        // to publish the new manifest at the end (so the old v1 Drive map
        // remains intact as a safety copy).
        if (!photoBlob) {
          unavailable.push({ id: photoId, number: photoNumber });
          this.setSyncProgress(
            `Photo ${photoNumber}/${referenced.size} unavailable — continuing the others…`,
            alreadyUploaded + i,
            referenced.size,
            referenced.size ? Math.max(5, Math.min(88, Math.round((photoNumber / referenced.size) * 88))) : 88
          );
          continue;
        }

        if (!folderId) folderId = await this.ensurePhotoFolder(map);
        const overallDone = alreadyUploaded + i;
        this.setSyncProgress(
          `Uploading photos ${photoNumber}/${referenced.size}…`,
          overallDone,
          referenced.size,
          referenced.size ? Math.max(5, Math.min(88, Math.round((photoNumber / referenced.size) * 88))) : 88
        );

        let fileId;
        try {
          fileId = await this.uploadPhotoFile(map, photoId, photoBlob, folderId);
        } catch (e) {
          const detail = (e && e.message) ? e.message : String(e);
          throw new Error(`Photo ${photoNumber}/${referenced.size} failed: ${detail}`);
        }

        const uploadedEntry = {
          id: fileId,
          name: this.photoFilename(map.id, photoId, photoBlob.type),
          mimeType: photoBlob.type || "application/octet-stream",
          appProperties: { branchlineMapId: map.id, branchlinePhoto: "1", branchlinePhotoId: photoId }
        };
        ownRemote[photoId] = uploadedEntry;
        remote[photoId] = uploadedEntry;
        // Checkpoint only this map's OWN files. Shared source files remain
        // indexed under the source map id.
        this.photoFileIndex[map.id] = ownRemote;

        // Yield occasionally so mobile Chrome can run auth/UI timers during a
        // several-hundred-photo migration.
        if ((i + 1) % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 40));
      }

      this.photoFileIndex[map.id] = ownRemote;

      let quarantined = [];
      if (unavailable.length) {
        quarantined = unavailable.map((x) => x.id);

        // Recovery has now exhausted every source we have: local PhotoDB,
        // the open-map Blob cache, already-uploaded Drive photos, the legacy
        // monolithic Drive map, and older Drive revisions. Keeping these ids
        // in the required-photo set would make one permanently-lost picture
        // lock the user's entire mindmap forever.
        //
        // Preserve the ids instead of deleting them. They stay attached to
        // their original node/note and are also recorded on the root as an
        // explicit recovery list, but are excluded from Drive completeness
        // checks so the healthy remainder of the map can finally sync.
        const existing = new Set(Array.isArray(map.root._missingPhotoIds) ? map.root._missingPhotoIds : []);
        quarantined.forEach((id) => existing.add(id));
        map.root._missingPhotoIds = Array.from(existing);

        // The referenced Set was calculated before quarantine. Remove only
        // these confirmed-unavailable ids so create/update metadata and
        // cleanup use the same final set in this save pass.
        quarantined.forEach((id) => referenced.delete(id));

        try { await DB.put(map); } catch (e) {}
        this.setSyncProgress(
          `Finalizing map — ${unavailable.length} unavailable photo${unavailable.length === 1 ? "" : "s"} preserved as recovery references…`,
          referenced.size,
          referenced.size,
          90
        );
        console.warn(
          "Drive migration quarantined unrecoverable photo ids",
          quarantined
        );
      }

      return { referenced, remote: ownRemote, quarantined };
    },

    async cleanupRemotePhotos(mapId, referenced, remoteIndex) {
      const index = remoteIndex || await this.listRemotePhotos(mapId, false);
      const keep = new Set(referenced || []);
      // Shared recovery manifests intentionally don't own another copy of
      // these files; keep source Drive files alive while any dependent map
      // still references them.
      sharedPhotoDependentMaps(mapId).forEach((dep) => {
        collectReferencedPhotoIds(dep.root).forEach((id) => keep.add(id));
      });
      const doomed = Object.keys(index).filter((id) => !keep.has(id));
      for (const id of doomed) {
        try {
          await this.api(`https://www.googleapis.com/drive/v3/files/${index[id].id}`, { method: "DELETE" });
          delete index[id];
        } catch (e) {
          console.warn("Couldn't remove an unused Drive photo", id, e);
        }
      }
    },

    async hydratePhotosForMap(map, opts) {
      if (!map || !map.root || !this.signedIn) return false;
      const options = opts || {};
      if (!options.force && this.photoHydratedMaps.has(map.id)) return false;
      if (this.photoHydrationByMap[map.id]) return this.photoHydrationByMap[map.id];

      const run = (async () => {
        const referenced = collectReferencedPhotoIds(map.root);
        if (!referenced.size) {
          this.photoHydratedMaps.add(map.id);
          return false;
        }
        const rows = await photoRowsForMapWithSharedSource(map);
        const localIds = new Set(rows.map((r) => r.id));
        const missing = Array.from(referenced).filter((id) => !localIds.has(id));
        if (!missing.length) {
          this.photoHydratedMaps.add(map.id);
          return false;
        }
        const ownRemote = await this.listRemotePhotos(map.id, !!options.forceIndex);
        const sharedSourceId = sharedPhotoSourceMapId(map);
        const sharedRemote = sharedSourceId
          ? await this.listRemotePhotos(sharedSourceId, !!options.forceIndex)
          : {};
        const remote = { ...sharedRemote, ...ownRemote };
        let downloaded = 0;
        for (let i = 0; i < missing.length; i++) {
          const id = missing[i];
          const f = remote[id];
          if (!f) {
            console.warn("Drive photo is missing for map", map.id, id);
            continue;
          }
          const photoBlob = await this.downloadPhotoFile(f.id);
          const ownerMapId = f.appProperties && f.appProperties.branchlineMapId
            ? f.appProperties.branchlineMapId
            : map.id;
          // If this file came from the shared source, keep one local copy
          // owned by that source rather than duplicating it under recovery id.
          await PhotoDB.put({ id, mapId: ownerMapId, blob: photoBlob });
          downloaded++;
          if (state.current && state.current.id === map.id) {
            const old = photoCache.get(id);
            if (old) { try { URL.revokeObjectURL(old); } catch (e) {} }
            photoBlobCache.set(id, photoBlob);
            photoCache.set(id, URL.createObjectURL(photoBlob));
            if (downloaded % 4 === 0 || i === missing.length - 1) {
              try { if (!state.editingId && !unsavedEdits) renderAll(); } catch (e) {}
            }
          }
        }
        if (downloaded && state.current && state.current.id === map.id) {
          photoFpGeneration++;
          photoFpIndexPromise = indexPhotoFingerprints(photoFpGeneration);
        }
        this.photoHydratedMaps.add(map.id);
        return downloaded > 0;
      })();

      this.photoHydrationByMap[map.id] = run;
      try {
        return await run;
      } finally {
        delete this.photoHydrationByMap[map.id];
      }
    },

    // Conflict copies are rare, so only here do we temporarily rebuild a
    // self-contained/base64 copy. Normal sync never does this anymore.
    async portableRemoteCopy(fileMeta, data) {
      const map = data || await this.downloadFile(fileMeta.id);
      if (this.driveFormatFor(fileMeta) !== "2") return map;
      await this.hydratePhotosForMap(map, { force: true, forceIndex: true });
      return inlinePhotosForPortableCopy(map);
    },

    async createFile(map) {
      const refs = collectReferencedPhotoIds(map.root);
      const metadata = {
        name: this.filenameFor(map),
        mimeType: "application/json",
        appProperties: {
          branchlineId: map.id,
          updatedAt: String(map.updatedAt || 0),
          lastEditAt: String(mapLastEditAt(map) || map.updatedAt || 0),
          branchlineFormat: "2",
          branchlineManifest: "1",
          branchlinePhotoCount: String(refs.size)
        }
      };
      const uploadUrl = await this.startResumableSession(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", "POST", metadata
      );
      const putRes = await this.api(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(map),
        timeoutMs: 180000
      });
      if (!putRes.ok) throw new Error("Couldn't upload a map manifest to Drive (" + putRes.status + ")");
      const data = await putRes.json();
      return data.id;
    },

    async updateFile(fileId, map) {
      const refs = collectReferencedPhotoIds(map.root);
      const metadata = {
        name: this.filenameFor(map),
        mimeType: "application/json",
        appProperties: {
          branchlineId: map.id,
          updatedAt: String(map.updatedAt || 0),
          lastEditAt: String(mapLastEditAt(map) || map.updatedAt || 0),
          branchlineFormat: "2",
          branchlineManifest: "1",
          branchlinePhotoCount: String(refs.size)
        }
      };
      const uploadUrl = await this.startResumableSession(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`, "PATCH", metadata
      );
      const putRes = await this.api(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(map),
        timeoutMs: 180000
      });
      if (!putRes.ok) throw new Error("Couldn't update a map manifest on Drive (" + putRes.status + ")");
    },

    // A 200 from the upload request means Google accepted the bytes, but the
    // old code immediately called the map "Synced" without checking what Drive
    // now reports for that file. On mobile, a tab can be suspended at awkward
    // moments and that made the UI look safer than it really was. A save is now
    // considered complete only after a direct Drive metadata read confirms the
    // exact updatedAt stamp we just uploaded.
    async verifyUploadedStamp(fileId, expectedStamp) {
      for (let i = 0; i < 4; i++) {
        const fields = encodeURIComponent("id,appProperties,modifiedTime");
        const res = await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=${fields}`);
        if (res.ok) {
          const data = await res.json();
          const actual = Number((data.appProperties && data.appProperties.updatedAt) || 0);
          if (actual >= expectedStamp) return true;
        }
        await new Promise(r => setTimeout(r, 450 + i * 350));
      }
      return false;
    },

    // Tiny metadata read used immediately before EVERY normal upload. The
    // previous sync model could still lose cross-device edits in one narrow
    // race: PC uploads, then before the phone's next 10s poll the phone edits
    // its stale copy and autosave uploads it straight over the PC version.
    // Verifying the remote stamp here turns autosave into a compare-before-
    // write operation: if Drive changed since this device last confirmed it,
    // we refuse to upload the stale tree and let syncFromDrive merge/pull it
    // first. Manual "Upload" can explicitly bypass this after its own warning.
    async readRemoteStamp(fileId) {
      const fields = encodeURIComponent("id,appProperties,modifiedTime");
      const res = await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=${fields}`);
      if (!res.ok) throw new Error("Couldn't verify the current Drive revision (" + res.status + ")");
      const data = await res.json();
      return {
        updatedAt: Number((data.appProperties && data.appProperties.updatedAt) || 0),
        lastEditAt: Number((data.appProperties && (data.appProperties.lastEditAt || data.appProperties.updatedAt)) || 0),
        modifiedTime: data.modifiedTime || null
      };
    },

    async save(map, opts) {
      if (!this.signedIn || !map) return false;
      ensureRecoveredEditLog(map);
      const skipRemoteGuard = !!(opts && opts.skipRemoteGuard);
      const forceRemotePhotos = !!(opts && opts.forceRemotePhotos);
      try {
        const knownBefore = this.fileIndex[map.id];
        if (knownBefore && !skipRemoteGuard) {
          const remoteNow = await this.readRemoteStamp(knownBefore.fileId);
          if (remoteNow.updatedAt > (knownBefore.updatedAt || 0) ||
              remoteNow.lastEditAt > (knownBefore.lastEditAt || knownBefore.updatedAt || 0)) {
            this.conflictDetected = true;
            this.freshUntil = 0;
            try { updateDriveUI(); } catch (e) {}
            setTimeout(() => { try { pollDriveUpdates(true); } catch (e) {} }, 900);
            return false;
          }
        }

        if (!map._photosMigrated) await ensurePhotosMigrated(map);

        // Upload missing binary photos before publishing the new metadata
        // revision. A second device can therefore never see a manifest that
        // points at photo files which have not finished uploading yet.
        const photoSync = await this.syncPhotosForMap(map, { forceRemote: forceRemotePhotos });
        const uploadedStamp = map.updatedAt || 0;
        const known = this.fileIndex[map.id];
        let fileId;
        this.setSyncProgress("Uploading map data…", 0, 1, 92);
        if (known) {
          fileId = known.fileId;
          await this.updateFile(fileId, map);
        } else {
          fileId = await this.createFile(map);
        }

        const verified = await this.verifyUploadedStamp(fileId, uploadedStamp);
        if (!verified) throw new Error("Drive did not confirm the uploaded revision yet");
        this.fileIndex[map.id] = {
          fileId,
          updatedAt: uploadedStamp,
          lastEditAt: mapLastEditAt(map) || uploadedStamp,
          format: "2"
        };
        this.photoHydratedMaps.add(map.id);
        setSyncBase(map.id, uploadedStamp);
        await setSyncSnapshot(map.id, map);
        this.lastSyncedAt = Date.now();
        this.consecutivePollFailures = 0;
        this.lastDriveError = null;
        this.lastDriveErrorAt = 0;
        if (this.status === "broken") this.status = "ok";
        updateDriveUI();

        if (photoSync.quarantined && photoSync.quarantined.length) {
          const n = photoSync.quarantined.length;
          try {
            showToast(
              `✅ Drive sync finished. ${n} unavailable photo${n === 1 ? "" : "s"} kept as recovery references.`
            );
          } catch (e) {}
        }

        this.cleanupRemotePhotos(map.id, photoSync.referenced, photoSync.remote).catch((e) => {
          console.warn("Drive photo cleanup failed", e);
        });
        return true;
      } catch (e) {
        console.error("Drive save failed", e);
        this.lastDriveError = e instanceof Error ? e : new Error(String(e));
        this.lastDriveErrorAt = Date.now();
        const tokenLooksExpired = !this.accessToken || Date.now() >= this.tokenExpiresAt;
        if (tokenLooksExpired || this.needsReauth) {
          this.status = "reauth";
        } else {
          // Keep the existing safety lock, but mark the failure as recoverable:
          // pushLocalNewer() will resume from the photos already confirmed on
          // Drive instead of starting the entire migration over.
          this.status = "broken";
          this.lastLocalPushTryAt = Date.now() - 10000;
          this.setSyncProgress("Upload interrupted — retrying from saved photos…", 0, 0, Math.max(1, this.syncProgressPercent || 1));
          setTimeout(() => {
            try { this.pushLocalNewer({ force: true, includeNew: true }); } catch (e3) {}
          }, 1800);
        }
        try { updateDriveUI(); } catch (e2) {}
        return false;
      }
    },

    // ---- Shared settings file (currently: saved task-list templates) ----
    // Kept in ONE small Drive file, tagged appProperties.branchlineSettings
    // (NOT branchlineId), so listRemote()/syncFromDrive() never mistake it
    // for a map. Oldest-created first so every device agrees which file is
    // the "primary" if a race ever produces two.
    async listSettingsFiles() {
      const q = encodeURIComponent("trashed=false and appProperties has { key='branchlineSettings' and value='1' }");
      const fields = encodeURIComponent("files(id,name)");
      const res = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&spaces=drive&pageSize=20&orderBy=createdTime`);
      if (!res.ok) throw new Error("Couldn't list Drive settings (" + res.status + ")");
      const data = await res.json();
      return data.files || [];
    },
    async writeSettingsFile(fileId, payload) {
      const metadata = { name: "branchline-settings.json", appProperties: { branchlineSettings: "1" } };
      const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`
        : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id";
      const uploadUrl = await this.startResumableSession(url, fileId ? "PATCH" : "POST", metadata);
      const putRes = await this.api(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!putRes.ok) throw new Error("Couldn't upload settings to Drive (" + putRes.status + ")");
      return fileId || (await putRes.json()).id;
    },

    async remove(map) {
      if (!this.signedIn || !map) return;
      const known = this.fileIndex[map.id];
      try {
        const entries = await this._listPhotoEntries(map.id);
        const files = entries.filter((f) => f.appProperties && f.appProperties.branchlinePhoto === "1");
        for (const f of files) {
          try { await this.api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE" }); } catch (e) {}
        }
        const folders = entries.filter((f) => f.appProperties && f.appProperties.branchlinePhotoFolder === "1");
        for (const f of folders) {
          try { await this.api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE" }); } catch (e) {}
        }
      } catch (e) { /* best-effort */ }
      if (known) {
        try {
          await this.api(`https://www.googleapis.com/drive/v3/files/${known.fileId}`, { method: "DELETE" });
        } catch (e) { /* best-effort */ }
      }
      delete this.fileIndex[map.id];
      delete this.photoFileIndex[map.id];
      delete this.photoFolderIndex[map.id];
      delete this.photoHydrationByMap[map.id];
      Object.keys(this.photoHydrationById).forEach((k) => {
        if (k.startsWith(map.id + "::")) delete this.photoHydrationById[k];
      });
      this.photoHydratedMaps.delete(map.id);
    },

    // The push half of sync. syncFromDrive() only ever *pulls*, and skips
    // any map whose local copy is newer than Drive's — so if an upload
    // was cut short (phone backgrounded mid-upload, network drop, expired
    // login), that edit used to sit on this device only, invisible to
    // every other device, until the next edit happened to trigger a
    // fresh upload. This finds every map whose local `updatedAt` is
    // ahead of what Drive last confirmed and uploads it again.
    // `includeNew` also uploads maps Drive has never seen (used right
    // after sign-in, when nothing else could be creating them at the
    // same time).
    //
    // Returns true if it pushed anything. Skipped while an edit is still
    // being typed or saved — runPersistNow() uploads those itself, and a
    // second overlapping upload of the same map could land out of order.
    // v302 deliberately quarantined photo ids that one device could not
    // recover, so the rest of the map could finish syncing. Another device
    // (typically the PC) may still have those exact photo Blobs locally.
    // When that happens, make the map dirty automatically so the normal save
    // path un-quarantines and uploads those photos to Drive. No user edit or
    // manual Upload click should be required to rescue them.
    async prepareQuarantinedPhotoRecovery() {
      let rescued = 0;
      let madeDirty = 0;

      for (const map of state.maps) {
        const missing = map && map.root && Array.isArray(map.root._missingPhotoIds)
          ? map.root._missingPhotoIds
          : [];
        if (!missing.length) continue;

        const available = new Set();
        try {
          const rows = await PhotoDB.getAllForMap(map.id);
          rows.forEach((r) => {
            if (!r || !r.id) return;
            if (r.blob || r.data) available.add(r.id);
          });
        } catch (e) {}

        if (state.current && state.current.id === map.id) {
          for (const id of photoBlobCache.keys()) available.add(id);
        }

        const recoverable = missing.filter((id) => available.has(id));
        if (!recoverable.length) continue;
        rescued += recoverable.length;

        // If a normal edit already made this map newer than Drive, its next
        // save will recover the photos anyway. Otherwise bump only the map
        // revision stamp so pushLocalNewer() includes it.
        const known = this.fileIndex[map.id];
        if (!known || (map.updatedAt || 0) <= (known.updatedAt || 0)) {
          map.updatedAt = nextUpdatedAt(map);
          try { await DB.put(map); } catch (e) {}
          madeDirty++;
        }
      }

      if (madeDirty && rescued) {
        try {
          showToast(
            `Recovering ${rescued} photo${rescued === 1 ? "" : "s"} this device still has…`
          );
        } catch (e) {}
      }
      return rescued;
    },

    async pushLocalNewer(opts) {
      const {
        force = false,
        includeNew = false,
        forceRemotePhotos = false,
        throwOnFailure = false
      } = opts || {};
      if (this.status !== "ok" && this.status !== "broken") return false;
      if (this.pushingLocal) return false;
      // Retry a failing push at most every 15s, but always let an explicit
      // trigger (returning to the tab, coming back online) go straight
      // through.
      if (!force && Date.now() - this.lastLocalPushTryAt < 15000) return false;
      const busy = () => {
        // While uploads are failing, an open editor mustn't block the
        // retry — the lock this causes would otherwise never lift.
        try { return !!(((state.editingId && this.status !== "broken")) || unsavedEdits || persistTimer || persistInFlight); }
        catch (e) { return false; }
      };
      if (busy()) return false;

      // A verified/synced PC can still hold photo bytes that the phone lacks
      // from the earlier quarantine migration. Detect those before deciding
      // whether there is "nothing to upload".
      await this.prepareQuarantinedPhotoRecovery();

      const stale = state.maps.filter(m => {
        const known = this.fileIndex[m.id];
        if (!known) return includeNew || this.status === "broken";
        return (m.updatedAt || 0) > (known.updatedAt || 0);
      });
      if (!stale.length) return false;
      this.lastLocalPushTryAt = Date.now();
      this.pushingLocal = true;
      const uploadStartPct = this.syncProgressPercent >= 60 ? this.syncProgressPercent : 5;
      try {
        for (let i = 0; i < stale.length; i++) {
          const m = stale[i];
          if (busy()) break; // an edit started mid-pass — its own save takes over
          const beforePct = uploadStartPct + Math.round((95 - uploadStartPct) * (i / stale.length));
          this.setSyncProgress(`Uploading map ${i + 1}/${stale.length}…`, i, stale.length, beforePct);
          const saved = await this.save(m, { forceRemotePhotos });
          if (!saved) {
            const err = this.lastDriveError || new Error("Google Drive did not accept this map upload.");
            if (throwOnFailure) throw err;
            break;
          }
          const afterPct = uploadStartPct + Math.round((95 - uploadStartPct) * ((i + 1) / stale.length));
          this.setSyncProgress(`Uploading map ${i + 1}/${stale.length}…`, i + 1, stale.length, afterPct);
        }
      } finally {
        this.pushingLocal = false;
      }
      // save() flags status "broken" on failure instead of throwing — if
      // this pass ended that way, retry soon (~5s) rather than waiting
      // the full 15s, since editing is locked while uploads fail.
      if (this.status === "broken") this.lastLocalPushTryAt = Date.now() - 10000;
      return true;
    },

    // Pulls in anything new/changed from Drive, same merge rule as
    // FolderDB: newer `updatedAt` wins, and a map neither side has ever
    // seen just gets added. Only actually downloads a file's content when
    // its tagged updatedAt looks newer than what we already have.
    //
    // Also mirrors deletions: if a map this device previously knew was on
    // Drive (it's in fileIndex from an earlier sync) has since vanished
    // from the Drive listing, that means it was deleted on another
    // device — so it's deleted here too. A map that's only ever existed
    // locally (never made it into fileIndex yet) is never touched by
    // this.
    // Resolves to true only if this pass actually changed local data, so
    // callers like pollDriveUpdates can skip re-rendering when nothing did.
    async syncFromDrive() {
      let changed = false;
      let downloadFailed = false;
      this.setSyncProgress("Listing Drive maps…", 0, 0, 5);
      const remoteFilesRaw = await this.listRemote();
      const listedAt = Date.now();

      // Prefer the last-opened map first. It doesn't change conflict rules,
      // but on a phone/PC hand-off it gets its newest bytes into the local
      // DB before less relevant maps.
      let lastOpenId = null;
      try { lastOpenId = localStorage.getItem(LAST_OPENED_MAP_KEY); } catch (e) {}
      const remoteFiles = remoteFilesRaw.slice().sort((a, b) => {
        const aid = a.appProperties && a.appProperties.branchlineId;
        const bid = b.appProperties && b.appProperties.branchlineId;
        if (aid === lastOpenId && bid !== lastOpenId) return -1;
        if (bid === lastOpenId && aid !== lastOpenId) return 1;
        return 0;
      });

      // The instant the listing shows another device saved something
      // newer, this device is on an old version: lock editing right now,
      // not after the (possibly slow, photo-heavy) download below lands.
      if (this.remoteBehindLocal(remoteFiles)) {
        this.freshUntil = 0;
        this.conflictDetected = true;
        try { updateStaleSyncBanner(); refreshEditLockUI(); } catch (e) {}
      }

      // Decide which files will actually need their JSON body. The old first
      // sync downloaded each one sequentially; because Drive copies contain
      // inline photo bytes, a few large maps multiplied network latency badly.
      // We prefetch up to three bodies in parallel, while keeping all merge /
      // IndexedDB mutations below sequential so conflict behavior stays stable.
      const targets = [];
      for (const f of remoteFiles) {
        const id = f.appProperties && f.appProperties.branchlineId;
        if (!id) continue;
        const remoteUpdatedAt = Number((f.appProperties && f.appProperties.updatedAt) || 0);
        const existing = state.maps.find(m => m.id === id);
        if (!existing || (existing.updatedAt || 0) < remoteUpdatedAt) {
          targets.push(f);
          continue;
        }
        if ((existing.updatedAt || 0) > remoteUpdatedAt) {
          const base = getSyncBase(id);
          if (base !== undefined && (existing.updatedAt || 0) > base && remoteUpdatedAt > base) targets.push(f);
        }
      }

      const deferredByFile = new Map();
      targets.forEach((f) => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        deferredByFile.set(f.id, { promise, resolve });
      });
      let targetCursor = 0;
      const workerCount = Math.min(3, targets.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = targetCursor++;
          if (idx >= targets.length) return;
          const f = targets[idx];
          try {
            const data = await this.downloadFile(f.id);
            deferredByFile.get(f.id).resolve({ data, error: null });
          } catch (error) {
            deferredByFile.get(f.id).resolve({ data: null, error });
          }
        }
      });
      const prefetchedDownload = async (fileId) => {
        const d = deferredByFile.get(fileId);
        if (!d) return this.downloadFile(fileId);
        const out = await d.promise;
        if (out.error) throw out.error;
        return out.data;
      };

      const previouslyKnownIds = new Set(Object.keys(this.fileIndex));
      const seenRemoteIds = new Set();
      let processedDownloads = 0;
      const showDownloadProgress = () => {
        if (!targets.length) return;
        const pct = 10 + Math.round(60 * (processedDownloads / targets.length));
        this.setSyncProgress(
          `Downloading changed maps ${Math.min(processedDownloads + 1, targets.length)}/${targets.length}…`,
          processedDownloads,
          targets.length,
          pct
        );
      };

      for (const f of remoteFiles) {
        const id = f.appProperties && f.appProperties.branchlineId;
        if (!id) continue;
        seenRemoteIds.add(id);
        const remoteUpdatedAt = Number((f.appProperties && f.appProperties.updatedAt) || 0);
        const remoteLastEditAt = Number((f.appProperties && (f.appProperties.lastEditAt || f.appProperties.updatedAt)) || 0);
        const remoteFormat = this.driveFormatFor(f);
        const previousKnown = this.fileIndex[id];
        this.fileIndex[id] = { fileId: f.id, updatedAt: remoteUpdatedAt, lastEditAt: remoteLastEditAt, format: remoteFormat };
        if (!previousKnown || previousKnown.updatedAt !== remoteUpdatedAt || previousKnown.format !== remoteFormat) {
          delete this.photoFileIndex[id];
          this.photoHydratedMaps.delete(id);
        }
        const existing = state.maps.find(m => m.id === id);
        if (existing) {
          const localUpdatedAt = existing.updatedAt || 0;
          const baseBefore = getSyncBase(id);

          // Critical first-sync/poll optimization: an unchanged map does NOT
          // need its entire merge-base tree written back to IndexedDB every
          // 10 seconds. Only refresh that snapshot if the agreed revision has
          // actually moved. The old unconditional write was costly on large
          // maps and made a metadata-only sync feel much slower than it was.
          if (localUpdatedAt === remoteUpdatedAt) {
            if (baseBefore !== remoteUpdatedAt) {
              setSyncBase(id, remoteUpdatedAt);
              await setSyncSnapshot(id, existing);
            }
            continue;
          }

          // First time this device sees a differing map since sync tracking
          // began: establish a conservative base before conflict handling.
          if (baseBefore === undefined) {
            setSyncBase(id, Math.min(localUpdatedAt, remoteUpdatedAt));
            await setSyncSnapshot(id, existing);
          }

          if (localUpdatedAt > remoteUpdatedAt) {
            // Ours is newer and will be uploaded. But if Drive ALSO changed
            // since our last agreed base, fetch it and three-way merge first.
            const base = getSyncBase(id);
            if (base !== undefined && localUpdatedAt > base && remoteUpdatedAt > base) {
              try {
                showDownloadProgress();
                const other = await prefetchedDownload(f.id);
                processedDownloads++;
                if (other && other.root) {
                  let merged = null;
                  try {
                    const snapshot = await getSyncSnapshot(id);
                    if (snapshot) merged = mergeMapContent(snapshot, existing, other);
                  } catch (e) { merged = null; }
                  if (merged) {
                    existing.root = merged.root;
                    existing.links = merged.links;
                    existing.title = merged.title;
                    existing.editorPrefs = merged.editorPrefs;
                    existing._editLog = merged.editLog || mergeMapEditLogs(existing, other);
                    existing._lastEditAt = merged.lastEditAt || Math.max(mapLastEditAt(existing), mapLastEditAt(other));
                    existing.updatedAt = nextUpdatedAt(existing);
                    primeEditLogShadow(existing);
                    await DB.put(existing);
                    showToast("Combined your edits with changes from another device");
                  } else {
                    if (this.driveFormatFor(f) === "2") {
                      await saveConflictCopy(other, "other device", { sharedPhotoSourceMapId: id });
                    } else {
                      const portableOther = await this.portableRemoteCopy(f, other);
                      await saveConflictCopy(portableOther, "other device");
                    }
                  }
                }
                setSyncBase(id, remoteUpdatedAt);
                await setSyncSnapshot(id, existing);
                changed = true;
              } catch (e) {
                console.error("Couldn't fetch the other device's copy", e);
                downloadFailed = true;
              }
            }
            continue;
          }
        }

        try {
          showDownloadProgress();
          const data = await prefetchedDownload(f.id);
          processedDownloads++;
          if (!data || !data.id || !data.root) continue;

          // About to replace this device's copy with Drive's. If this device
          // has edits Drive never received, merge them if possible, otherwise
          // preserve a separate unsynced copy.
          let mergedContent = null;
          let localHasUnsyncedEdits = false;
          if (existing) {
            const base = getSyncBase(id);
            localHasUnsyncedEdits = base !== undefined && (existing.updatedAt || 0) > base;
            if (localHasUnsyncedEdits) {
              try {
                const snapshot = await getSyncSnapshot(id);
                if (snapshot) mergedContent = mergeMapContent(snapshot, existing, data);
              } catch (e) { mergedContent = null; }
              if (mergedContent) {
                showToast("Combined your edits with changes from another device");
              } else {
                await saveConflictCopy(existing, "unsynced copy", { sharedPhotoSourceMapId: existing.id });
              }
            }
          }

          // Device-cache self-cleaning: when Drive is newer, this local copy
          // has no unuploaded edits, and the actual portable map content differs,
          // purge the stale IndexedDB map + its PhotoDB rows before installing
          // Drive's version. This avoids old map/photo cache accumulating and,
          // importantly, never deletes a newer/dirty local edit.
          let purgeStaleDeviceCache = false;
          // v2 manifests keep stable photo ids. Preserve PhotoDB rows across
          // metadata revisions and lazy-download only ids this device lacks.
          // Legacy v1 files still inline bytes and keep the old cleanup path.
          if (remoteFormat !== "2" && existing && !localHasUnsyncedEdits && remoteUpdatedAt > (existing.updatedAt || 0)) {
            try {
              const localPortable = await inlinePhotosForPortableCopy(existing);
              const localSig = (localPortable.title || "") + "\u0000" + mapContentFingerprint(localPortable);
              const remoteSig = (data.title || "") + "\u0000" + mapContentFingerprint(data);
              purgeStaleDeviceCache = localSig !== remoteSig;
            } catch (e) {
              purgeStaleDeviceCache = false;
              console.warn("Skipped stale cache cleanup because map comparison failed", e);
            }
          }

          const replacingOpenMap = !!(purgeStaleDeviceCache && state.current && state.current.id === id);
          if (purgeStaleDeviceCache) {
            if (replacingOpenMap) {
              revokePhotoCache();
              photoCache = new Map();
              photoBlobCache = new Map();
            }
            await DB.delete(id);
            await PhotoDB.deleteAllForMap(id);
          }

          ensureTheme(data);
          ensureLayout(data);
          ensureFavorite(data);
          ensureTrash(data);
          ensureSidesRepaired(data);
          // Legacy v1 Drive maps carry inline bytes. v2 manifests already
          // contain stable photo ids and their Blobs are fetched separately.
          if (remoteFormat === "2") data._photosMigrated = true;
          else await ensurePhotosMigrated(data);

          let storedMap = data;
          if (existing && !purgeStaleDeviceCache) {
            Object.assign(existing, data);
            storedMap = existing;
            if (mergedContent) {
              existing.root = mergedContent.root;
              existing.links = mergedContent.links;
              existing.title = mergedContent.title;
              existing.editorPrefs = mergedContent.editorPrefs;
              existing._editLog = mergedContent.editLog || mergeMapEditLogs(existing, data);
              existing._lastEditAt = mergedContent.lastEditAt || Math.max(mapLastEditAt(existing), mapLastEditAt(data));
              existing.updatedAt = nextUpdatedAt(existing);
            }
            await DB.put(existing);
          } else if (existing && purgeStaleDeviceCache) {
            // Replace the in-memory object too, rather than Object.assign-ing
            // over it, so fields that existed only on the stale cached version
            // cannot survive the cleanup.
            const mapIndex = state.maps.findIndex(m => m.id === id);
            if (mapIndex >= 0) state.maps[mapIndex] = data;
            if (state.current && state.current.id === id) state.current = data;
            await DB.put(data);
            if (replacingOpenMap) await loadPhotoCacheForMap(id);
          } else {
            state.maps.push(data);
            await DB.put(data);
          }

          setSyncBase(id, Math.max(remoteUpdatedAt, storedMap.updatedAt || 0));
          await setSyncSnapshot(id, storedMap);
          primeEditLogShadow(storedMap);
          changed = true;
        } catch (e) {
          console.error("Drive download failed for one map", e);
          downloadFailed = true;
        }
      }

      if (workers.length) await Promise.all(workers);

      for (const id of previouslyKnownIds) {
        if (seenRemoteIds.has(id)) continue;
        delete this.fileIndex[id];
        const existing = state.maps.find(m => m.id === id);
        if (!existing) continue;
        await DB.delete(id);
        await PhotoDB.deleteAllForMap(id);
        await FolderDB.remove(existing);
        changed = true;
        state.maps = state.maps.filter(m => m.id !== id);
        if (state.current && state.current.id === id) {
          state.current = null;
          const next = activeMaps();
          if (next.length) await openMap(next[0].id);
          else {
            revokePhotoCache();
            photoCache = new Map();
            photoBlobCache = new Map();
            clearCanvas();
          }
        }
      }

      sortMaps(state.maps);
      this.lastSyncedAt = Date.now();
      if (this.status === "broken") this.status = "ok";
      this.consecutivePollFailures = 0;
      if (!downloadFailed) {
        this.freshUntil = listedAt + this.FRESH_WINDOW_MS;
        this.conflictDetected = false;
      } else {
        this.conflictDetected = true;
      }
      if (targets.length) this.setSyncProgress("Drive metadata check complete", targets.length, targets.length, 70);
      else this.setSyncProgress("Drive is already up to date", 0, 0, 70);

      // Metadata sync is done. If its map is already open, apply synced
      // editor preferences immediately, then hydrate photos in background.
      if (state.current) {
        applyEditorFontPrefs(state.current);
        const knownOpen = this.fileIndex[state.current.id];
        if (knownOpen && knownOpen.format === "2") {
          this.hydratePhotosForMap(state.current).catch((e) => console.warn("Lazy Drive photo load failed", e));
        }
      }
      return changed;
    }
  };

