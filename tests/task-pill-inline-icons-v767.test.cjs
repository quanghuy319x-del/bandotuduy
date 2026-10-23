"use strict";
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const read = filename => fs.readFileSync(path.join(__dirname, "..", filename), "utf8");

test("All Task note icons remain inside the pill", () => {
  const helper = read("js/13-note-editor-1.js");
  const match = helper.match(/function liftSubtaskControlsOutsidePill\(row\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(match, "Pill helper exists");
  assert.match(match[1], /el\.matches\("\.subtask-step-track-inline, \.subsubtask-toggle"\)/);
  assert.doesNotMatch(match[1], /el\.matches\([^)]*\.subtask-note-icon/);
  const task = read("js/16-tasks-editor-2.js");
  const calendar = read("js/17-calendar-game-timer.js");
  assert.match(task, /if \(brainstormIcon\) row\.appendChild\(brainstormIcon\);\s*if \(snote\) row\.appendChild\(snote\);\s*[\s\S]*?liftSubtaskControlsOutsidePill\(row\)/);
  assert.match(calendar, /if \(calBrainstormIcon\) row\.appendChild\(calBrainstormIcon\);\s*if \(calNoteIcon\) row\.appendChild\(calNoteIcon\);\s*[\s\S]*?liftSubtaskControlsOutsidePill\(row\)/);
});
test("Inline icons are laid out within pills at desktop and phone widths", () => {
  const css = read("style.css");
  assert.match(css, /\.subtask-row > \.subtask-note-icon\s*\{[^}]*position:relative/);
  assert.match(css, /\.subtask-row > \.subtask-note-icon\s*\{[^}]*z-index:2/);
  assert.doesNotMatch(css, /\.subtask-row > \.subtask-outside-controls > \.subtask-note-icon/);
  assert.match(css, /@media\(max-width:640px\)\{\s*\.subtask-row > \.subtask-outside-controls\{[^}]*\}\s*\.subtask-row > \.subtask-note-icon\{/);
});
test("HTML and PWA versioning deploy the changed CSS and JS", () => {
  assert.match(read("index.html"), /app\.js\?v=767/);
  assert.match(read("index.html"), /style\.css\?v=767/);
  assert.match(read("index.html"), /sw\.js\?v=767/);
  assert.match(read("sw.js"), /branchline-pwa-v767/);
});
