/**
 * Focus Mode stacking regression (v760).
 * Run: node --test tests/focus-mode-layer.test.cjs
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");

test("Focus Mode covers Task List, nested popups, and sidebar", () => {
  const style = read("style.css");
  const block = style.match(/\.subtask-focus-overlay\s*\{([^}]*)\}/);
  assert.ok(block, "Focus Mode overlay CSS exists");
  assert.match(block[1], /position\s*:\s*fixed/);
  assert.match(block[1], /inset\s*:\s*0/);
  const value = block[1].match(/z-index\s*:\s*(\d+)/);
  assert.ok(value, "Focus Mode defines z-index");
  const layer = Number(value[1]);
  const otherStyles = style.replace(block[0], "");
  const otherLayers = Array.from(otherStyles.matchAll(/z-index\s*:\s*(\d+)/g), m => Number(m[1]));
  assert.ok(layer > Math.max(...otherLayers), "Focus Mode must exceed every app CSS layer");
  assert.ok(layer < 2147483647, "Fatal boot error banner remains visible");
  assert.match(style, /\.subtask-focus-overlay\.hidden\s*\{\s*display\s*:\s*none\s*!important/);
});

test("Focus Mode entry point is loaded and hosted at body level", () => {
  const loader = read("app.js");
  const focus = read("js/15b-subtask-focus-mode.js");
  const tasks = read("js/16-tasks-editor-2.js");
  assert.match(loader, /"15b-subtask-focus-mode"/);
  assert.ok(loader.indexOf('"15b-subtask-focus-mode"') < loader.indexOf('"16-tasks-editor-2"'));
  assert.match(tasks, /openSubtaskFocusMode\(t, s, sourceTarget\)/);
  assert.match(focus, /document\.body\.appendChild\(overlay\)/);
  assert.match(focus, /overlay\.classList\.remove\("hidden"\)/);
});

test("Focus Mode CSS and scripts are cache-busted together", () => {
  const index = read("index.html");
  const sw = read("sw.js");
  assert.match(index, /style\.css\?v=760/);
  assert.match(index, /app\.js\?v=760/);
  assert.match(index, /sw\.js\?v=760/);
  assert.match(sw, /branchline-pwa-v760/);
  assert.match(sw, /subtask-focus-mode\.js\?v=760/);
});
