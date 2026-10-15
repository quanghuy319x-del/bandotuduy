/* Branchline — immersive Focus Mode for a single subtask.
   Loaded after the existing task countdown and before subtask menus. */
"use strict";

let subtaskFocusSelection = null; // { taskId, subtaskId, title, parent, target }
let subtaskFocusOverlay = null;
let subtaskFocusUiInterval = null;
let subtaskFocusMinutes = 25;
let subtaskFocusReturnElement = null;

// A soft two-beat "in the zone" sound, synchronized with the 1.55s
// visual heartbeat. Audio is synthesized locally (no sound assets,
// downloads or network use). Only the visible, running Focus Mode plays.
const SUBTASK_FOCUS_SOUND_KEY = "branchline_focus_sound_enabled";
const SUBTASK_FOCUS_VOLUME_KEY = "branchline_focus_sound_volume";
let subtaskFocusSoundEnabled = true;
let subtaskFocusSoundVolume = 45; // more audible default; adjustable from 0–100
try {
  const storedOn = localStorage.getItem(SUBTASK_FOCUS_SOUND_KEY);
  if (storedOn !== null) subtaskFocusSoundEnabled = storedOn === "1";
  const storedVol = Number(localStorage.getItem(SUBTASK_FOCUS_VOLUME_KEY));
  if (localStorage.getItem(SUBTASK_FOCUS_VOLUME_KEY) !== null && Number.isFinite(storedVol)) {
    subtaskFocusSoundVolume = Math.max(0, Math.min(100, Math.round(storedVol)));
  }
} catch (_) { /* still works in private mode if storage is disabled */ }
let subtaskFocusAudioCtx = null;
let subtaskFocusBeatInterval = null;
const SUBTASK_FOCUS_BEAT_MS = 1550;

function stopSubtaskFocusSound() {
  if (subtaskFocusBeatInterval !== null) {
    clearInterval(subtaskFocusBeatInterval);
    subtaskFocusBeatInterval = null;
  }
  if (subtaskFocusAudioCtx && subtaskFocusAudioCtx.state === "running") {
    subtaskFocusAudioCtx.suspend().catch(() => {});
  }
}

function playSubtaskFocusBeat() {
  const ctx = subtaskFocusAudioCtx;
  if (!ctx || ctx.state !== "running" || !subtaskFocusSoundEnabled ||
      subtaskFocusSoundVolume <= 0) return;
  // v710: stronger but still brief "lub-dub" pulses. The old 175-220 Hz
  // sine tones were almost inaudible on many small phone/laptop speakers.
  // Higher triangle tones project clearly without requiring max volume.
  // Keep the envelope short and the absolute gain below 0.4 to avoid blasts.
  try {
    const base = ctx.currentTime + 0.01;
    [[0, 420, 0.20], [0.29, 350, 0.17]].forEach(([offset, freq, length]) => {
      const start = base + offset;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.82, start + length);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0002, 0.37 * Math.pow(subtaskFocusSoundVolume / 100, 0.60)),
        start + 0.018
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + length + 0.01);
    });
  } catch (_) { /* lack of Web Audio should not block the timer */ }
}

function syncSubtaskFocusSound() {
  const shouldPlay = !!(
    subtaskFocusOverlay && !subtaskFocusOverlay.classList.contains("hidden") &&
    isCurrentSubtaskFocusSession() && !focusTimer.paused &&
    subtaskFocusSoundEnabled && subtaskFocusSoundVolume > 0 &&
    document.visibilityState !== "hidden"
  );
  if (!shouldPlay) { stopSubtaskFocusSound(); return; }
  if (subtaskFocusBeatInterval !== null) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    if (!subtaskFocusAudioCtx || subtaskFocusAudioCtx.state === "closed") {
      subtaskFocusAudioCtx = new AudioContextClass();
    }
    const ctx = subtaskFocusAudioCtx;
    // This function is called immediately from Start/Resume/Open clicks,
    // satisfying browsers that require a gesture to unlock audio.
    const result = ctx.resume();
    if (result && typeof result.catch === "function") result.catch(() => {});
    // Scheduling begins immediately and quietly; the first beat plays
    // after resume. Timer visibility checks stop it when not needed.
    subtaskFocusBeatInterval = setInterval(playSubtaskFocusBeat, SUBTASK_FOCUS_BEAT_MS);
    Promise.resolve(result).then(() => {
      if (subtaskFocusBeatInterval !== null) playSubtaskFocusBeat();
    }).catch(() => {});
  } catch (_) { stopSubtaskFocusSound(); }
}

function saveSubtaskFocusSoundPreference() {
  try {
    localStorage.setItem(SUBTASK_FOCUS_SOUND_KEY, subtaskFocusSoundEnabled ? "1" : "0");
    localStorage.setItem(SUBTASK_FOCUS_VOLUME_KEY, String(subtaskFocusSoundVolume));
  } catch (_) {}
}

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
      <div class="subtask-focus-sound-controls">
        <button type="button" data-focus-action="sound-toggle" id="subtask-focus-sound-toggle" aria-pressed="true" title="Mute/unmute the gentle heartbeat sound">🔊 Sound on</button>
        <label for="subtask-focus-volume">Volume
          <input type="range" id="subtask-focus-volume" min="0" max="100" step="5" value="45" aria-label="Focus sound volume"/>
        </label>
      </div>
      <p class="subtask-focus-hint">Exit keeps the timer running, but stops the sound. Pause silences it. The selected subtask pulses while the timer is active.</p>
    </section>`;
  document.body.appendChild(overlay);
  const soundVolumeInput = overlay.querySelector("#subtask-focus-volume");
  soundVolumeInput.value = String(subtaskFocusSoundVolume);
  soundVolumeInput.addEventListener("input", () => {
    subtaskFocusSoundVolume = Math.max(0, Math.min(100, Number(soundVolumeInput.value) || 0));
    saveSubtaskFocusSoundPreference();
    syncSubtaskFocusSound();
    renderSubtaskFocusOverlay();
  });
  document.addEventListener("visibilitychange", syncSubtaskFocusSound);
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
    if (action === "sound-toggle") {
      subtaskFocusSoundEnabled = !subtaskFocusSoundEnabled;
      saveSubtaskFocusSoundPreference();
      syncSubtaskFocusSound();
      renderSubtaskFocusOverlay();
      return;
    }
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
    syncSubtaskFocusSound();
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
  const soundBtn = overlay.querySelector("#subtask-focus-sound-toggle");
  soundBtn.textContent = subtaskFocusSoundEnabled ? "🔊 Sound on" : "🔇 Muted";
  soundBtn.setAttribute("aria-pressed", String(subtaskFocusSoundEnabled));
  overlay.querySelector("#subtask-focus-volume").value = String(subtaskFocusSoundVolume);
  syncSubtaskFocusSound();
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
  // openSubtaskFocusMode is initiated by a direct menu tap/click.
  syncSubtaskFocusSound();
  if (subtaskFocusUiInterval) clearInterval(subtaskFocusUiInterval);
  subtaskFocusUiInterval = setInterval(() => {
    renderSubtaskFocusOverlay();
    updateSubtaskFocusHeartbeat();
  }, 350);
  overlay.querySelector(".subtask-focus-close").focus({ preventScroll: true });
}

function closeSubtaskFocusMode() {
  if (!subtaskFocusOverlay) return;
  stopSubtaskFocusSound();
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
