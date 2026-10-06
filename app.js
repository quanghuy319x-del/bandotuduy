/* ============================================================
   Branchline — offline mind map app
   app.js is now just a small loader. The real code lives in js/ and is
   split into numbered parts (the old single 29,000-line app.js, cut at
   section boundaries — nothing else changed).

   • The parts share ONE scope, so they must load in this exact order.
   • Keep the ?v=NNN on <script src="app.js?v=NNN"> in index.html as your
     one version number: it is passed on to every js/ file below, so
     bumping it still busts the cache for the whole app.
   • To add a new part, create js/NN-name.js (start it with "use strict";)
     and add its name to PARTS below, before the boot part (19-...).
   ============================================================ */
(function () {
  var PARTS = [
    "01-core-storage",
    "02-google-drive-sync",
    "03-sync-safety-merge-lock",
    "04-data-model-1",
    "05-data-model-2",
    "06-state-sidebar-layout",
    "07-rendering-1",
    "08-rendering-2",
    "09-selection-keyboard-menu",
    "10-canvas-toolbar-drc",
    "11-photos-viewer-1",
    "12-photos-viewer-2",
    "13-note-editor-1",
    "14-note-editor-2",
    "15-tasks-editor-1",
    "16-tasks-editor-2",
    "17-calendar-game-timer",
    "18-brainstorm-trash-storage",
    "19-browsers-and-boot"
  ];
  var src = (document.currentScript && document.currentScript.src) || "";
  var m = src.match(/[?&]v=([^&]+)/);
  var q = m ? "?v=" + m[1] : "";
  for (var i = 0; i < PARTS.length; i++) {
    var url = "js/" + PARTS[i] + ".js" + q;
    document.write('<script src="' + url + '" onerror="window.__branchlineBootError&&window.__branchlineBootError(\'Could not load ' + url + '\')"><\/script>');
  }
})();
