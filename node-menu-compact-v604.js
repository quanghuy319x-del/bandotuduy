/* Branchline v604 — compact/reorganize the whole node context menu.
   Presentation-only: moves the existing DOM nodes after openContextMenu()
   builds them, so every original click handler and data behavior stays intact. */
(() => {
  const menu = document.getElementById("ctx-menu");
  if (!menu) return;

  const style = document.createElement("style");
  style.textContent = `
    .ctx-menu.node-context-menu .ctx-item-header{
      min-height:0!important;
      padding:4px 7px 3px!important;
    }
    .ctx-menu.node-context-menu .ctx-item-header .ctx-item-label{
      font-size:10px!important;
      font-weight:800;
      letter-spacing:.05em;
    }
    .ctx-runtime-grid{
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:4px;
      padding:2px 4px 4px;
    }
    .ctx-runtime-grid>.ctx-item{
      min-width:0;
      min-height:30px!important;
      padding:5px 7px!important;
      font-size:11.5px!important;
      line-height:1.15!important;
      border:1px solid var(--border);
      border-radius:6px;
      background:transparent;
      box-sizing:border-box;
    }
    .ctx-runtime-grid>.ctx-item:hover{
      border-color:var(--accent);
      background:var(--accent-dim);
    }
    .ctx-runtime-grid .ctx-item-label{
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .ctx-runtime-option-row{
      display:flex;
      align-items:center;
      gap:6px;
      padding:3px 7px;
    }
    .ctx-runtime-option-label{
      flex:0 0 76px;
      min-width:0;
      font-size:11px;
      font-weight:700;
      color:var(--text-dim);
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .ctx-runtime-inline-control{
      flex:1 1 auto!important;
      padding:0!important;
      margin:0!important;
      min-width:0;
    }
    .ctx-runtime-option-row .ctx-glow-opt{
      padding:4px 7px!important;
      font-size:11px!important;
    }
    .ctx-runtime-option-row .ctx-style-btn{
      padding:5px 4px!important;
      font-size:11px!important;
    }
    .ctx-runtime-option-row .ctx-distance-input{
      width:58px;
      padding:5px 6px!important;
    }
    .ctx-runtime-mini{
      min-height:28px!important;
      padding:4px 7px!important;
      font-size:11px!important;
      margin-left:auto;
    }
    .ctx-runtime-clock{
      min-height:30px!important;
      padding:5px 8px!important;
      margin:2px 4px;
      border:1px solid var(--border);
    }
    .ctx-menu.node-context-menu .ctx-compact-row{
      padding:3px 7px!important;
    }
    .ctx-menu.node-context-menu .ctx-sep{
      margin:3px 2px;
    }
    .ctx-runtime-danger-head{
      color:var(--danger)!important;
    }
    .ctx-runtime-danger{
      min-height:32px!important;
      padding:6px 8px!important;
      margin:2px 4px;
      border:1px solid rgba(220,80,80,.25);
    }
    @media (pointer:coarse){
      .ctx-menu.node-context-menu{
        min-width:min(310px,calc(100vw - 12px))!important;
        padding:6px!important;
      }
      .ctx-menu.node-context-menu .ctx-item-header{
        min-height:0!important;
        padding:5px 6px 3px!important;
      }
      .ctx-menu.node-context-menu .ctx-runtime-grid>.ctx-item{
        min-height:38px!important;
        padding:7px 8px!important;
        font-size:13px!important;
      }
      .ctx-runtime-option-label{
        flex-basis:82px;
        font-size:12px;
      }
      .ctx-runtime-option-row .ctx-glow-opt,
      .ctx-runtime-option-row .ctx-style-btn{
        padding:7px!important;
        font-size:12px!important;
      }
      .ctx-runtime-clock,
      .ctx-runtime-danger{
        min-height:38px!important;
        padding:7px 8px!important;
        font-size:13px!important;
      }
    }
  `;
  document.head.appendChild(style);

  const headerTitle = (el) =>
    (el?.querySelector(".ctx-item-label")?.textContent || el?.textContent || "").trim();

  function sectionHeader(title) {
    return [...menu.querySelectorAll(":scope > .ctx-item-header")]
      .find(el => headerTitle(el) === title) || null;
  }

  function collectUntilNextHeader(header) {
    const out = [];
    let cur = header?.nextElementSibling;
    while (cur && !cur.classList.contains("ctx-item-header")) {
      out.push(cur);
      cur = cur.nextElementSibling;
    }
    return out;
  }

  function compactSection(title) {
    const header = sectionHeader(title);
    if (!header) return;
    const nodes = collectUntilNextHeader(header)
      .filter(el => el.classList.contains("ctx-item") && !el.classList.contains("ctx-item-header"));
    if (!nodes.length) return;
    const grid = document.createElement("div");
    grid.className = "ctx-runtime-grid";
    header.after(grid);
    nodes.forEach(el => grid.appendChild(el));
  }

  function moveFormatRowsIntoAppearance() {
    const header = sectionHeader("Appearance");
    if (!header) return;
    const rows = [...menu.querySelectorAll(":scope > .ctx-compact-row")];
    let anchor = header;
    rows.forEach(row => {
      anchor.after(row);
      anchor = row;
    });
  }

  function pairControl(labelStarts, shortLabel, controlSelector) {
    const labels = [...menu.querySelectorAll(":scope > .ctx-item")]
      .filter(el => (el.textContent || "").trim().startsWith(labelStarts));
    labels.forEach(label => {
      const control = label.nextElementSibling;
      if (!control || !control.matches(controlSelector)) return;
      const row = document.createElement("div");
      row.className = "ctx-runtime-option-row";
      const small = document.createElement("span");
      small.className = "ctx-runtime-option-label";
      small.textContent = shortLabel;
      small.title = (label.textContent || "").trim();
      row.appendChild(small);
      label.before(row);
      control.classList.add("ctx-runtime-inline-control");
      row.appendChild(control);
      label.remove();
    });
  }

  function compactClock() {
    const item = [...menu.querySelectorAll(":scope > .ctx-item")]
      .find(el => /^🕐 (Show|Hide) root node clock/.test((el.textContent || "").trim()));
    if (!item) return;
    item.classList.add("ctx-runtime-clock");
    item.textContent = (item.textContent || "").startsWith("🕐 Show") ? "🕐 Show Clock / Calendar" : "🕐 Hide Clock / Calendar";
  }

  function attachDistanceReset() {
    const reset = [...menu.querySelectorAll(":scope > .ctx-item")]
      .find(el => (el.textContent || "").trim().startsWith("↺ Reset all to default spacing"));
    if (!reset) return;
    const row = [...menu.querySelectorAll(".ctx-runtime-option-row")]
      .find(el => (el.querySelector(".ctx-runtime-option-label")?.textContent || "") === "↔ Children");
    if (!row) return;
    reset.classList.add("ctx-runtime-mini");
    reset.textContent = "Reset";
    row.appendChild(reset);
  }

  function groupLinkRemovals() {
    const items = [...menu.querySelectorAll(":scope > .ctx-item.danger")]
      .filter(el => (el.textContent || "").trim().startsWith("🔗 Remove link to"));
    if (!items.length) return;
    const first = items[0];
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    const head = document.createElement("div");
    head.className = "ctx-item ctx-item-header";
    const label = document.createElement("span");
    label.className = "ctx-item-label";
    label.textContent = "Links";
    head.appendChild(label);
    const grid = document.createElement("div");
    grid.className = "ctx-runtime-grid";
    first.before(sep, head, grid);
    items.forEach(el => grid.appendChild(el));
  }

  function isolateDelete() {
    const del = [...menu.querySelectorAll(":scope > .ctx-item.danger")]
      .find(el => (el.textContent || "").trim().startsWith("🗑️ Delete branch"));
    if (!del) return;
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    const head = document.createElement("div");
    head.className = "ctx-item ctx-item-header ctx-runtime-danger-head";
    const label = document.createElement("span");
    label.className = "ctx-item-label";
    label.textContent = "Danger";
    head.appendChild(label);
    del.before(sep, head);
    del.classList.add("ctx-runtime-danger");
  }

  let running = false;
  function organize() {
    if (running || menu.classList.contains("hidden")) return;
    if (menu.querySelector(".ctx-runtime-grid")) return;
    running = true;
    try {
      // Main logical action sections: one/two compact rows rather than a long list.
      ["Clipboard", "Node", "Content", "Reference", "Work"].forEach(compactSection);

      // Keep text formatting + font/fill colors inside Appearance.
      moveFormatRowsIntoAppearance();

      // Appearance/layout controls: label + options on the same row.
      pairControl("✨ Glow effect", "✨ Glow", ".ctx-glow-options");
      pairControl("🏷️ Task badge style", "🏷 Badge", ".ctx-glow-options");
      pairControl("◐ Node / cell icon style", "◐ Icons", ".ctx-glow-options");
      pairControl("🔀 Connector style", "🔀 Connector", ".ctx-style-row");
      pairControl("↔️ Children distance", "↔ Children", ".ctx-distance-row");
      pairControl("🔀 Children connector style", "🔀 Children", ".ctx-style-row");
      attachDistanceReset();
      compactClock();

      // Destructive link removals and branch delete stay at the bottom,
      // clearly separated from normal work/style actions.
      groupLinkRemovals();
      isolateDelete();
    } finally {
      running = false;
    }
  }

  const observer = new MutationObserver(() => requestAnimationFrame(organize));
  observer.observe(menu, {childList:true, subtree:false});
  document.addEventListener("contextmenu", () => requestAnimationFrame(organize), true);
  document.addEventListener("pointerup", () => requestAnimationFrame(organize), true);
})();
