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
    "01-edit-log",
    "01-recovery-history",
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
    "15b-subtask-focus-mode",
    "16-tasks-editor-2",
    "17-calendar-game-timer",
    "18-brainstorm-trash-storage",
    "19-browsers-and-boot"
  ];
  var src = (document.currentScript && document.currentScript.src) || "";
  var m = src.match(/[?&]v=([^&]+)/);
  var version = m ? m[1] : "unversioned";
  // v754: on a GitHub Pages deployment, index.html can reach the browser
  // before every versioned JS file is available at the CDN edge. The old
  // loader showed "Could not load ..." and left the app half-initialized.
  // Retry one entire ordered load with cache-busted module URLs, then
  // display the real error if the second attempt also fails.
  var retryKey = "branchline-script-retry-" + version;
  var priorRetry = 0;
  try { priorRetry = Number(sessionStorage.getItem(retryKey) || 0); } catch (_) {}
  var hasRecentRetry = priorRetry > 0 && Date.now() - priorRetry < 60000;
  var q = (m ? "?v=" + version : "") +
    (hasRecentRetry ? (m ? "&" : "?") + "retry=" + priorRetry : "");

  window.__branchlinePartLoadFailed = function (encodedUrl) {
    var url = decodeURIComponent(encodedUrl);
    if (window.__branchlinePartReloading) return;
    if (!hasRecentRetry) {
      window.__branchlinePartReloading = true;
      var stamp = Date.now();
      try { sessionStorage.setItem(retryKey, String(stamp)); } catch (_) {}
      // A single restart avoids continuing after missing declarations in
      // the middle of the strictly ordered shared-scope JS modules.
      var current = new URL(location.href);
      current.searchParams.set("branchline_retry", String(stamp));
      location.replace(current.href);
      return;
    }
    if (window.__branchlineBootError)
      window.__branchlineBootError("Could not load " + url + " after a cache-busted retry. Check network/Pages deployment, then reload.");
  };
  window.addEventListener("load", function () {
    if (!window.__branchlinePartReloading &&
        (!window.__branchlineBootMsgs || !window.__branchlineBootMsgs.length)) {
      try { sessionStorage.removeItem(retryKey); } catch (_) {}
    }
  }, { once: true });

  for (var i = 0; i < PARTS.length; i++) {
    var url = "js/" + PARTS[i] + ".js" + q;
    var encoded = encodeURIComponent(url);
    document.write('<script src="' + url.replace(/&/g, "&amp;") +
      '" onerror="window.__branchlinePartLoadFailed(\'' + encoded + '\')"><\/script>');
  }
})();
