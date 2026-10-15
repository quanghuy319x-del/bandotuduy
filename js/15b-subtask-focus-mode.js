/* Branchline — immersive Focus Mode for a single subtask.
   Loaded after the existing task countdown and before subtask menus. */
"use strict";

let subtaskFocusSelection = null; // { taskId, subtaskId, title, parent, target }
let subtaskFocusOverlay = null;
let subtaskFocusUiInterval = null;
let subtaskFocusMinutes = 25;
let subtaskFocusReturnElement = null;

function isCurrentSubtaskFocusSession() {
  return !!(focusTimer && subtaskFocusSelection &&
    focusTimer.taskId === subtaskFocusSelection.taskId &&
    focusTimer.subtaskId === subtaskFocusSelection.subtaskId &&
    sameTarget(focusTimer.target, subtaskFocusSelection.target));
}

// Keep a live heartbeat on the real pill as well as the enlarged focus card.
// In particular, the pill keeps beating when Focus Mode is closed but its
// countdown is still running.
function updateSubtaskFocusHeartbeat() {
  document.querySelectorAll(".subtask-row[data-task-id][data-subtask-id]").forEach(row => {
    const active = !!(focusTimer && !focusTimer.paused &&
      focusTimer.subtaskId && focusTimer.taskId === row.dataset.taskId &&
      focusTimer.subtaskId === row.dataset.subtaskId);
    row.classList.toggle("focus-heartbeat", active);
  });
}

function ensureSubtaskFocusOverlay() {
  if (subtaskFocusOverlay) return subtaskFocusOverlay;
  const overlay = document.createElement("div");
  overlay.id = "subtask-focus-overlay";
  overlay.className = "subtask-focus-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Subtask focus mode");
  overlay.setAttribute("aria-hidden", "true");
  // All markup here is static. Task/subtask text is inserted via textContent.
  overlay.innerHTML = `
    <section class="subtask-focus-card" aria-labelledby="subtask-focus-heading">
      <div class="subtask-focus-top">
        <span class="subtask-focus-eyebrow" id="subtask-focus-heading">◎ FOCUS MODE</span>
        <button type="button" class="subtask-focus-close" data-focus-action="exit" aria-label="Exit focus mode" title="Exit focus mode (timer keeps running)">✕</button>
      </div>
      <div class="subtask-focus-task" id="subtask-focus-task"></div>
      <div class="subtask-focus-parent" id="subtask-focus-parent"></div>
      <div class="subtask-focus-countdown" id="subtask-focus-countdown" aria-live="off">25:00</div>
      <div class="subtask-focus-state" id="subtask-focus-state">Choose your focus duration</div>
      <div class="subtask-focus-setup" id="subtask-focus-setup">
        <label for="subtask-focus-minutes">Timer (minutes)</label>
        <div class="subtask-focus-time-entry">
          <input id="subtask-focus-minutes" type="number" min="1" max="360" step="1" inputmode="numeric" value="25" />
          <button type="button" class="subtask-focus-primary" data-focus-action="start">▶ Start focus</button>
        </div>
        <div class="subtask-focus-presets" aria-label="Quick timer presets">
          <button type="button" data-focus-minutes="5">5m</button>
          <button type="button" data-focus-minutes="15">15m</button>
          <button type="button" data-focus-minutes="25">25m</button>
          <button type="button" data-focus-minutes="45">45m</button>
        </div>
      </div>
      <div class="subtask-focus-running hidden" id="subtask-focus-running">
        <button type="button" class="subtask-focus-primary" data-focus-action="pause">⏸ Pause</button>
        <button type="button" data-focus-action="extend">+1m</button>
        <button type="button" data-focus-action="stop">■ Stop</button>
      </div>
      <div class="subtask-focus-finished hidden" id="subtask-focus-finished">
        <button type="button" class="subtask-focus-primary" data-focus-action="again">↻ Start again</button>
        <button type="button" data-focus-action="dismiss">Dismiss chime</button>
      </div>
      <p class="subtask-focus-hint">Exit keeps the timer running. Stop ends the session. The selected subtask pulses while the timer is active.</p>
    </section>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#subtask-focus-minutes");
  const clampMinutes = () => {
    const parsed = Math.round(Number(input.value));
    subtaskFocusMinutes = Math.max(1, Math.min(360, Number.isFinite(parsed) ? parsed : 25));
    input.value = String(subtaskFocusMinutes);
    return subtaskFocusMinutes;
  };
  input.addEventListener("change", () => { clampMinutes(); renderSubtaskFocusOverlay(); });
  input.addEventListener("input", () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 360) {
      subtaskFocusMinutes = Math.round(parsed);
      renderSubtaskFocusOverlay();
    }
  });
  overlay.addEventListener("click", (event) => {
    const preset = event.target.closest("[data-focus-minutes]");
    if (preset) {
      input.value = preset.dataset.focusMinutes;
      clampMinutes();
      renderSubtaskFocusOverlay();
      return;
    }
    const btn = event.target.closest("[data-focus-action]");
    if (!btn) return;
    const action = btn.dataset.focusAction;
    if (action === "exit") { closeSubtaskFocusMode(); return; }
    if (action === "dismiss") { stopFocusChime(); focusJustCompleted = null; renderSubtaskFocusOverlay(); return; }
    if (!subtaskFocusSelection) return;
    if (action === "start" || action === "again") {
      const minutes = clampMinutes();
      if (focusTimer && !isCurrentSubtaskFocusSession() &&
          !window.confirm("Replace the currently running focus timer with this subtask?")) return;
      if (action === "again") stopFocusChime();
      startFocusTimer(
        subtaskFocusSelection.target,
        subtaskFocusSelection.taskId,
        subtaskFocusSelection.title,
        subtaskFocusSelection.subtaskId,
        minutes * 60
      );
    } else if (action === "pause") {
      if (isCurrentSubtaskFocusSession()) toggleFocusPause();
    } else if (action === "extend") {
      if (isCurrentSubtaskFocusSession()) extendFocusTimer(60);
    } else if (action === "stop") {
      if (isCurrentSubtaskFocusSession()) stopFocusTimer();
      stopFocusChime();
      focusJustCompleted = null;
    }
    updateSubtaskFocusHeartbeat();
    renderSubtaskFocusOverlay();
  });
  // Capture Escape before Tasks/Calendar modal handlers; do not close the
  // underlying task editor just because the focus view was dismissed.
  document.addEventListener("keydown", (event) => {
    if (overlay.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSubtaskFocusMode();
    } else if (event.key === "Tab") {
      const focusable = Array.from(overlay.querySelectorAll("button:not(:disabled), input:not(:disabled)"))
        .filter(el => el.getClientRects().length && !el.closest(".hidden"));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  subtaskFocusOverlay = overlay;
  return overlay;
}

function renderSubtaskFocusOverlay() {
  const overlay = subtaskFocusOverlay;
  if (!overlay || overlay.classList.contains("hidden") || !subtaskFocusSelection) return;
  const session = isCurrentSubtaskFocusSession();
  const completed = !session && !!(focusJustCompleted &&
    focusJustCompleted.taskId === subtaskFocusSelection.taskId &&
    focusJustCompleted.subtaskId === subtaskFocusSelection.subtaskId &&
    sameTarget(focusJustCompleted.target, subtaskFocusSelection.target));
  const setup = overlay.querySelector("#subtask-focus-setup");
  const running = overlay.querySelector("#subtask-focus-running");
  const finished = overlay.querySelector("#subtask-focus-finished");
  setup.classList.toggle("hidden", session || completed);
  running.classList.toggle("hidden", !session);
  finished.classList.toggle("hidden", !completed);
  overlay.querySelector("#subtask-focus-task").textContent = subtaskFocusSelection.title;
  overlay.querySelector("#subtask-focus-parent").textContent = subtaskFocusSelection.parent;
  overlay.querySelector("#subtask-focus-task").classList.toggle("is-beating", !!(session && !focusTimer.paused));
  const time = session ? focusTimer.remaining : completed ? 0 : subtaskFocusMinutes * 60;
  overlay.querySelector("#subtask-focus-countdown").textContent = formatFocusTime(time);
  overlay.querySelector("#subtask-focus-state").textContent = session
    ? (focusTimer.paused ? "Paused" : "Focus in progress")
    : completed ? "✓ Session complete" : focusTimer
      ? "Another timer is running — starting here will replace it"
      : "Choose your focus duration";
  if (session) {
    overlay.querySelector('[data-focus-action="pause"]').textContent = focusTimer.paused ? "▶ Resume" : "⏸ Pause";
  }
}

function openSubtaskFocusMode(task, subtask, sourceTarget = null) {
  const target = sourceTarget || tasksEditingTarget;
  if (!target || !task || !subtask) { showToast("Open the subtask in Tasks or Calendar first"); return; }
  const overlay = ensureSubtaskFocusOverlay();
  subtaskFocusReturnElement = document.activeElement;
  subtaskFocusSelection = {
    taskId: task.id,
    subtaskId: subtask.id,
    title: String(subtask.text || "Untitled subtask"),
    parent: String(task.text || "Task"),
    target: { nodeId: target.nodeId, r: target.r == null ? null : target.r, c: target.c == null ? null : target.c }
  };
  overlay.querySelector("#subtask-focus-minutes").value = String(subtaskFocusMinutes);
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  renderSubtaskFocusOverlay();
  updateSubtaskFocusHeartbeat();
  if (subtaskFocusUiInterval) clearInterval(subtaskFocusUiInterval);
  subtaskFocusUiInterval = setInterval(() => {
    renderSubtaskFocusOverlay();
    updateSubtaskFocusHeartbeat();
  }, 350);
  overlay.querySelector(".subtask-focus-close").focus({ preventScroll: true });
}

function closeSubtaskFocusMode() {
  if (!subtaskFocusOverlay) return;
  subtaskFocusOverlay.classList.add("hidden");
  subtaskFocusOverlay.setAttribute("aria-hidden", "true");
  subtaskFocusSelection = null;
  if (subtaskFocusUiInterval) { clearInterval(subtaskFocusUiInterval); subtaskFocusUiInterval = null; }
  updateSubtaskFocusHeartbeat();
  if (subtaskFocusReturnElement && subtaskFocusReturnElement.isConnected) {
    try { subtaskFocusReturnElement.focus({ preventScroll: true }); } catch (_) {}
  }
  subtaskFocusReturnElement = null;
}
