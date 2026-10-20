/**
 * Popup layer + Emergency Glow regressions (v761).
 * Static production-source checks. Browser interaction needs manual smoke test.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const css = read("style.css");
const v761 = css.slice(css.indexOf("/* v761 — strong, readable Emergency Glow"));
test("Emergency Glow is shared by Queue, Tasks, Calendar and Notes", () => {
  assert.ok(v761.length > 500, "Latest override must exist");
  for (const selector of [
    ".subtask-row.emergency-glow",
    "#tasks-modal .subtask-row.emergency-glow",
    "#tasks-modal .shared-queue-subtask-panel .subtask-row.emergency-glow",
    "#cal-day-modal-backdrop .subtask-row.emergency-glow",
    "#note-modal .subtask-row.emergency-glow"
  ]) assert.ok(v761.includes(selector), "Emergency surface missing: " + selector);
  assert.match(v761, /@keyframes emergency-beacon-v761/);
  assert.match(v761, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(v761, /animation:none !important/);
  assert.match(v761, /outline:2px solid rgba\(255,54,34,\.98\) !important/);
  for (const file of ["js/13-note-editor-1.js", "js/16-tasks-editor-2.js", "js/17-calendar-game-timer.js"])
    assert.match(read(file), /emergencyGlow \? " emergency-glow"/);
});
test("Every fixed BODY popover sits above dynamically raised task and note modals", () => {
  const rules = v761.split(/\}\s*/);
  const pop = rules.find(r => r.includes(".task-color-popover") && r.includes(".folder-move-popover"));
  assert.ok(pop, "Missing body-level floating layer");
  for (const selector of [
    ".task-color-popover", ".task-templates-popover",
    ".note-color-popover:not(#note-emoji-popover)",
    ".photo-modal-symbol-popover:not(#photo-modal-combine-popover)",
    ".folder-move-popover", ".editor-photo-menu", ".note-img-shrink-btn",
    "#google-links-menu"
  ]) assert.ok(pop.includes(selector), "Unprotected floating popup: " + selector);
  const layer = Number(pop.match(/z-index:(\d+)/)[1]);
  assert.ok(layer > 3000000 && layer < 3200000, "Popup must be over context menu, below description dialog");
  assert.match(v761, /#note-emoji-popover,[\s\S]*?#photo-modal-combine-popover\s*\{\s*z-index:2147483000 !important/);
  assert.match(v761, /\.subtask-touch-drag-ghost\s*\{\s*z-index:3110000 !important/);
  assert.match(v761, /\.app-toast\s*\{\s*z-index:3120000 !important/);
});
test("Layer priorities preserve Focus Mode over floating controls and boot error banner", () => {
  assert.match(css, /\.subtask-focus-overlay\s*\{[^}]*z-index:2147483500 !important/s);
  const values = [...v761.matchAll(/z-index:(\d+) !important/g)].map(m => Number(m[1]));
  assert.ok(values.every(n => n < 2147483500));
  const index = read("index.html"), sw = read("sw.js");
  assert.match(index, /style\.css\?v=762/);
  assert.match(index, /app\.js\?v=762/);
  assert.match(index, /sw\.js\?v=762/);
  assert.match(sw, /branchline-pwa-v762/);
  assert.match(sw, /subtask-focus-mode\.js\?v=762/);
});
