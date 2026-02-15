/* ===============================
   GCSE Focus - timer.js (FIXED + NULL SAFE)
   =============================== */
(() => {
  "use strict";

  const { $, pad2, clamp, todayISO, startOfWeekISO, dateToMs } = window.Utils;
  const { state, save, bus, addStudyMinutes } = window.App;

  const el = {
    focus: $("#tmFocus"),
    short: $("#tmShort"),
    long: $("#tmLong"),

    circle: $("#timerCircle"),
    mode: $("#tmMode"),
    time: $("#tmTime"),
    hint: $("#tmHint"),

    start: $("#btnTimerStart"),
    skip: $("#btnTimerSkip"),
    reset: $("#btnTimerReset"),

    todayMin: $("#uiTodayMinutes"),
    weekMin: $("#uiWeekMinutes"),
    goalBar: $("#uiGoalBar"),
    goalText: $("#uiGoalText"),
    weeklyGoal: $("#uiWeeklyGoal"),
  };

  let interval = null;

  function getModeDurationSec(mode) {
    const c = state.timer.config;
    if (mode === "focus") return (c.focusMin || 25) * 60;
    if (mode === "short") return (c.shortMin || 5) * 60;
    return (c.longMin || 15) * 60;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  }

  function updateRing() {
    if (!el.circle) return;
    const total = getModeDurationSec(state.timer.mode);
    const done = total - state.timer.remainingSec;
    const pct = clamp((done / total) * 100, 0, 100);
    el.circle.style.setProperty("--p", pct + "%");
  }

  function updateUI() {
    if (el.mode)
      el.mode.textContent =
        state.timer.mode === "focus"
          ? "Focus"
          : state.timer.mode === "short"
          ? "Short break"
          : "Long break";

    if (el.time) el.time.textContent = formatTime(state.timer.remainingSec);
    if (el.hint) el.hint.textContent = `Session ${state.timer.session} of 4`;
    if (el.start) el.start.textContent = state.timer.running ? "⏸ Pause" : "▶ Start";

    updateRing();
  }

  function advanceMode() {
    if (state.timer.mode === "focus") {
      state.timer.mode = state.timer.session >= 4 ? "long" : "short";
    } else {
      state.timer.session = state.timer.mode === "long" ? 1 : state.timer.session + 1;
      state.timer.mode = "focus";
    }

    state.timer.running = false;
    state.timer.lastTickMs = null;
    state.timer.remainingSec = getModeDurationSec(state.timer.mode);
    save();
    updateUI();
  }

  function tick() {
    if (!state.timer.running) return;

    const now = Date.now();
    if (!state.timer.lastTickMs) state.timer.lastTickMs = now;

    const delta = Math.floor((now - state.timer.lastTickMs) / 1000);
    if (delta <= 0) return;

    state.timer.lastTickMs = now;
    state.timer.remainingSec -= delta;

    if (state.timer.remainingSec <= 0) {
      if (state.timer.mode === "focus") {
        addStudyMinutes(state.timer.config.focusMin || 25);
      }
      advanceMode();
    }

    save();
    updateUI();
    renderStats();
  }

  function startPause() {
    state.timer.running = !state.timer.running;
    state.timer.lastTickMs = state.timer.running ? Date.now() : null;

    if (state.timer.running && !interval) {
      interval = setInterval(tick, 300);
    }

    save();
    updateUI();
  }

  function resetTimer() {
    state.timer.running = false;
    state.timer.lastTickMs = null;
    state.timer.mode = "focus";
    state.timer.session = 1;
    state.timer.remainingSec = getModeDurationSec("focus");
    save();
    updateUI();
  }

  function skip() {
    advanceMode();
    renderStats();
  }

  function getTodayMinutes() {
    const entry = state.studyLog.find((x) => x.dateISO === todayISO());
    return entry ? Number(entry.minutes || 0) : 0;
  }

  function getWeekMinutes() {
    const start = startOfWeekISO();
    const startMs = dateToMs(start);
    const endMs = dateToMs(todayISO()) + 86400000;

    return state.studyLog
      .filter((x) => {
        const ms = dateToMs(x.dateISO);
        return ms >= startMs && ms < endMs;
      })
      .reduce((a, x) => a + Number(x.minutes || 0), 0);
  }

  function renderStats() {
    const today = getTodayMinutes();
    const week = getWeekMinutes();

    if (el.todayMin) el.todayMin.textContent = `${today}m`;
    if (el.weekMin) el.weekMin.textContent = `${week}m`;

    if (el.weeklyGoal) {
      state.weeklyGoalMin = clamp(Number(el.weeklyGoal.value || 600), 60, 2400);
    }

    const pct = clamp((week / state.weeklyGoalMin) * 100, 0, 100);

    if (el.goalBar) el.goalBar.style.width = pct + "%";
    if (el.goalText) el.goalText.textContent = `${week} / ${state.weeklyGoalMin}`;

    save();
  }

  function syncConfigFromInputs() {
    if (el.focus) state.timer.config.focusMin = clamp(Number(el.focus.value || 25), 10, 90);
    if (el.short) state.timer.config.shortMin = clamp(Number(el.short.value || 5), 3, 20);
    if (el.long) state.timer.config.longMin = clamp(Number(el.long.value || 15), 10, 45);
    save();
  }

  function init() {
    if (!el.start) return;

    if (el.focus) el.focus.value = state.timer.config.focusMin;
    if (el.short) el.short.value = state.timer.config.shortMin;
    if (el.long) el.long.value = state.timer.config.longMin;
    if (el.weeklyGoal) el.weeklyGoal.value = state.weeklyGoalMin;

    el.start?.addEventListener("click", startPause);
    el.skip?.addEventListener("click", skip);
    el.reset?.addEventListener("click", resetTimer);

    [el.focus, el.short, el.long].forEach((i) => {
      if (!i) return;
      i.addEventListener("change", () => {
        syncConfigFromInputs();
        if (!state.timer.running) {
          state.timer.remainingSec = getModeDurationSec(state.timer.mode);
          updateUI();
        }
      });
    });

    el.weeklyGoal?.addEventListener("change", renderStats);

    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

      if (e.code === "Space") {
        e.preventDefault();
        startPause();
      }
      if (e.key.toLowerCase() === "r") {
        resetTimer();
      }
    });

    updateUI();
    renderStats();
  }

  bus.on("app:ready", init);
  bus.on("stats:changed", renderStats);
})();