/**
 * Branchline Drive single-writer regression tests (v759).
 * Run: node --test tests/recovery-sync-v759.test.cjs
 * No Google credentials/network/browser needed. The methods under test are
 * extracted from production js/02-google-drive-sync.js, not reimplemented.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.resolve(__dirname, "../js/02-google-drive-sync.js"), "utf8");
function between(first, last) {
  const a = source.indexOf(first), b = source.indexOf(last, a);
  assert.ok(a >= 0 && b > a, "Missing production method " + first);
  return source.slice(a, b).trim().replace(/,\s*$/, "");
}
const clone = value => JSON.parse(JSON.stringify(value));
const canonicalMethod = between("    canonicalRemoteFiles(files) {", "    driveFormatFor(file) {");
const saveMethods = between("    async save(map, opts) {", "    // ---- Shared settings file");
const fakeConsole = { info() {}, warn() {}, error() {} };
const mkRemote = (fileId, mapId, revision, editAt = revision, modifiedTime = "") => ({
  id: fileId, modifiedTime,
  appProperties: {
    branchlineId: mapId, updatedAt: String(revision), lastEditAt: String(editAt)
  }
});

function makeCanonical() {
  const api = new Function("console", "return ({" + canonicalMethod + "});")(fakeConsole);
  api.fileIndex = {};
  return api;
}

function makeSaver({ listed = [], locks = undefined, gate = null } = {}) {
  let remote = { updatedAt: 1, lastEditAt: 1 };
  const uploads = [], snapshots = [], photoCleanup = [], failedSaves = [];
  const bases = [];
  const navigator = { onLine: true };
  if (locks) navigator.locks = locks;
  const deps = {
    navigator, console: fakeConsole, cloudOnlyMapList: false,
    ensureRecoveredEditLog() {}, updateDriveUI() {},
    pollDriveUpdates() {}, ensurePhotosMigrated: async () => {},
    editClone: clone,
    collectReferencedPhotoIds: () => new Set(),
    DB: { put: async () => {} },
    nextUpdatedAt: m => Number(m.updatedAt) + 1,
    sameSyncContent: (a, b) => JSON.stringify(a.root) === JSON.stringify(b.root),
    mapLastEditAt: m => Number(m._lastEditAt) || 0,
    setSyncBase: (id, stamp) => bases.push(stamp),
    setSyncSnapshot: async (id, map) => snapshots.push(clone(map)),
    showToast() {}, setTimeout() {}
  };
  const names = Object.keys(deps);
  const api = new Function(...names, "return ({" + saveMethods + "});")
    (...Object.values(deps));
  Object.assign(api, {
    status: "ok", signedIn: true, needsReauth: false,
    cloudCatalogIds: new Set(), pendingCloudCreates: new Set(),
    async finishCloudCreate() {},
    accessToken: "test-token", tokenExpiresAt: Date.now() + 100000,
    _mapSaveQueue: new Map(), photoHydratedMaps: new Set(), fileIndex: {},
    setSyncProgress() {},
    async listRemote() { return listed; },
    canonicalRemoteFiles: makeCanonical().canonicalRemoteFiles,
    driveFormatFor: () => "2",
    async readRemoteStamp() { return { ...remote }; },
    async syncPhotosForMap() {
      return { referenced: new Set(), remote: {}, quarantined: [] };
    },
    async updateFile(fileId, map) {
      // Simulate the await between metadata PATCH and JSON PUT.
      if (gate && uploads.length === 0) {
        gate.entered();
        await gate.wait;
      }
      const uploaded = clone(map);
      uploads.push(uploaded);
      remote = { updatedAt: uploaded.updatedAt, lastEditAt: uploaded._lastEditAt };
    },
    async createFile(map) {
      const uploaded = clone(map);
      uploads.push(uploaded);
      remote = { updatedAt: uploaded.updatedAt, lastEditAt: uploaded._lastEditAt };
      return "created-map-file";
    },
    async verifyUploadedStamp(fileId, expected) {
      return remote.updatedAt === expected;
    },
    async cleanupRemotePhotos(mapId, refs) {
      photoCleanup.push({ mapId, count: refs.size });
    }
  });
  api.canonicalRemoteFiles = api.canonicalRemoteFiles.bind(api);
  return { api, uploads, snapshots, photoCleanup, bases, failedSaves };
}

test("duplicate Drive map IDs choose one stable canonical file regardless of list order", () => {
  const api = makeCanonical();
  api.fileIndex = { m: { fileId: "preferred" } };
  const one = mkRemote("old", "m", 10, 10);
  const two = mkRemote("new", "m", 20, 20);
  const another = mkRemote("untouched", "other-map", 1, 1);
  assert.deepEqual(api.canonicalRemoteFiles([one, two, another]).map(f => f.id), ["new", "untouched"]);
  assert.deepEqual(api.canonicalRemoteFiles([two, one, another]).map(f => f.id), ["new", "untouched"]);
  assert.equal(api.duplicateRemoteMapIds.get("m"), 2);
  const tiedA = mkRemote("preferred", "m", 30, 30, "2026-01-01T00:00:00Z");
  const tiedB = mkRemote("other", "m", 30, 30, "2026-01-01T00:00:00Z");
  assert.equal(api.canonicalRemoteFiles([tiedB, tiedA])[0].id, "preferred");
  assert.equal(api.canonicalRemoteFiles([tiedA, tiedB])[0].id, "preferred");
});

test("typing during an in-progress PUT uploads immutable revisions in order", async () => {
  let entered;
  const arrived = new Promise(resolve => entered = resolve);
  let release;
  const wait = new Promise(resolve => release = resolve);
  const { api, uploads, snapshots } = makeSaver({ gate: { entered, wait } });
  api.fileIndex.m = { fileId: "drive-file", updatedAt: 1, lastEditAt: 1 };
  const map = { id: "m", root: { id: "root", text: "old" },
    updatedAt: 2, _lastEditAt: 2, links: [] };
  const initialSave = api.save(map);
  await arrived;
  map.root.text = "new";
  map.updatedAt = 3;
  map._lastEditAt = 3;
  const nextSave = api.save(map);
  assert.equal(uploads.length, 0, "First PUT is deliberately suspended");
  release();
  assert.deepEqual(await Promise.all([initialSave, nextSave]), [true, true]);
  assert.deepEqual(uploads.map(m => m.root.text), ["old", "new"]);
  assert.deepEqual(snapshots.map(m => m.root.text), ["old", "new"]);
  assert.deepEqual(snapshots.map(m => m.updatedAt), [2, 3]);
  assert.equal(api.fileIndex.m.updatedAt, 3);
  assert.equal(api._mapSaveQueue.size, 0);
});

test("repeated single-PC updates converge without changing file ID or creating extra files", async () => {
  const { api, uploads, snapshots } = makeSaver();
  api.fileIndex.m = { fileId: "drive-file", updatedAt: 1, lastEditAt: 1 };
  const map = { id: "m", root: { id: "root", text: "0" },
    updatedAt: 1, _lastEditAt: 1, links: [] };
  for (let i = 2; i <= 32; i++) {
    map.root.text = String(i);
    map.updatedAt = i;
    map._lastEditAt = i;
    assert.equal(await api.save(map), true, "Save " + i);
    assert.equal(api.fileIndex.m.fileId, "drive-file");
  }
  assert.equal(uploads.length, 31);
  assert.equal(snapshots.length, 31);
  assert.deepEqual(uploads.map(x => x.root.text), snapshots.map(x => x.root.text));
  assert.equal(api.fileIndex.m.updatedAt, 32);
});

test("a map with an existing Drive manifest never creates another on first local upload", async () => {
  const remote = mkRemote("already-on-drive", "m", 12, 12);
  const { api, uploads } = makeSaver({ listed: [remote] });
  const map = { id: "m", root: { id: "r", text: "edited" },
    updatedAt: 13, _lastEditAt: 13 };
  assert.equal(await api.save(map), false, "must defer until Drive is reconciled");
  assert.equal(uploads.length, 0, "no duplicate file created");
  assert.equal(api.fileIndex.m.fileId, "already-on-drive");
  assert.equal(api.conflictDetected, true);
});

test("first save of a genuinely new map creates one manifest", async () => {
  const { api, uploads, snapshots } = makeSaver();
  const map = { id: "new-map", root: { id: "r", text: "first" },
    updatedAt: 2, _lastEditAt: 2 };
  assert.equal(await api.save(map), true);
  assert.equal(uploads.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(api.fileIndex["new-map"].fileId, "created-map-file");
});


test("a newer unsaved edit remains protected while the previous Drive upload completes", async () => {
  const sidebar = fs.readFileSync(path.resolve(__dirname, "../js/06-state-sidebar-layout.js"), "utf8");
  const a = sidebar.indexOf("  async function runPersistNow() {");
  const b = sidebar.indexOf("  // Guards against overlapping saves:", a);
  assert.ok(a >= 0 && b > a);
  const liveMap = { id: "m", root: { id: "r", text: "before" }, updatedAt: 1 };
  let signal;
  const entered = new Promise(resolve => signal = resolve);
  let release;
  const wait = new Promise(resolve => release = resolve);
  const state = { current: liveMap, maps: [liveMap], scale: 1, tx: 0, ty: 0 };
  const deps = {
    state, navigator: { onLine: true },
    saveStatus: { textContent: "", className: "" },
    recordPendingEditLog() {}, nextUpdatedAt: m => Number(m.updatedAt) + 1,
    takePendingPhotoDeletes: () => [],
    DB: { put: async () => {} },
    releasePhotoDeletes: async () => {},
    requeuePhotoDeletes() {},
    FolderDB: { save: async () => {} },
    sortMaps() {}, renderSidebar() {}, updateSaveStatusLabel() {},
    scheduleAutoPhotoCleanup() {},
    DriveDB: {
      signedIn: true, needsReauth: false,
      async save() { signal(); await wait; return true; }
    }
  };
  const params = Object.keys(deps);
  const run = new Function(...params, [
    "let persistTimer = 1, unsavedEdits = true, persistAgainAfter = false, lastSavedAt = 0;",
    sidebar.slice(a, b),
    "return { runPersistNow, markPending() { persistTimer = 42; unsavedEdits = true; }, getDirty() { return unsavedEdits; } };"
  ].join("\n"))(...Object.values(deps));
  const saving = run.runPersistNow();
  await entered;
  liveMap.root.text = "new edit";
  liveMap.updatedAt += 1;
  run.markPending();
  release();
  await saving;
  assert.equal(run.getDirty(), true, "next edit must stay unsaved/locked until its own save");
});
