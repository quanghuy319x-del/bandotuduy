"use strict";
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("A Google token renews earlier during active use", () => {
  const drive = read("js/02-google-drive-sync.js");
  assert.match(drive, /DRIVE_GESTURE_RENEW_WINDOW_MS = 25 \* 60 \* 1000/);
  assert.match(drive, /remaining > DRIVE_GESTURE_RENEW_WINDOW_MS/);
  assert.match(drive, /await this\.requestToken\(false\)/);
  assert.match(drive, /if \(silent\) \{\s*return Promise\.reject/);
  assert.match(drive, /loadCachedDriveToken\(\)/);
});

test("Ordinary app clicks can renew Google without starting OAuth during typing or background work", () => {
  const boot = read("js/19-browsers-and-boot.js");
  assert.match(boot, /document\.addEventListener\("click", \(event\) => \{/);
  assert.match(boot, /!event\.isTrusted/);
  assert.match(boot, /document\.visibilityState !== "visible"/);
  assert.match(boot, /target\.closest\("#app"\)/);
  assert.match(boot, /\[contenteditable\]/);
  assert.match(boot, /DriveDB\.renewFromUserGesture\(\)/);
  assert.doesNotMatch(boot, /if \(!target\.closest\('button,\[role="button"\]/);
});

test("App shell updates together and preserves cached signed-in browser state", () => {
  assert.match(read("index.html"), /app\.js\?v=766/);
  assert.match(read("index.html"), /sw\.js\?v=766/);
  assert.match(read("sw.js"), /branchline-pwa-v766/);
  assert.match(read("sw.js"), /15b-subtask-focus-mode\.js\?v=766/);
  assert.doesNotMatch(read("js/02-google-drive-sync.js"), /localStorage\.clear\(\)/);
});
