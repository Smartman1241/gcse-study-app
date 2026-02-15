/* ===============================
   GCSE Focus - timer.js
   Pomodoro engine + progress ring + stats integration
   =============================== */
(() => {
  "use strict";

  const {
    $, pad2, clamp, todayISO, startOfWeekISO, dateToMs
  } = window.Utils;

  const { state, save, bus, addStudyMinutes } = window.App;

  // --- Elements ---
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

  // --- Helpers ---
  function getModeDurationSec(mode) {
    const c = state.timer.config;
    if (mode === "focus") return c.focusMin * 60;
    if (mode === "short") return c.shortMin * 60;
    return c.longMin * 60;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  function updateRing() {
    const total = getModeDurationSec(state.timer.mode);
    const done = total - state.timer.remainingSec;
    const pct = clamp((done / total) * 100, 0, 100);
    el.circle.style.setProperty("--p", pct + "%");
  }

  function updateUI() {
    el.mode.textContent =
      state.timer.mode === "focus"
        ? "Focus"
        : state.timer.mode === "short"
        ? "Short break"
        : "Long break";

    el.time.textContent = formatTime(state.timer.remainingSec);
    el.hint.textContent = `Session ${state.timer.session} of 4`;
    el.start.textContent = state.timer.running ? "⏸ Pause" : "▶ Start";

    updateRing();
  }

  // --- Timer cycle logic ---
  function advanceMode() {
    if (state.timer.mode === "focus") {
      // After focus
      if (state.timer.session >= 4) {
        state.timer.mode = "long";
      } else {
        state.timer.mode = "short";
      }
    } else {
      // After break
      if (state.timer.mode === "long") {
        state.timer.session = 1;
      } else {
        state.timer.session += 1;
      }
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
        addStudyMinutes(state.timer.config.focusMin);
      }
      advanceMode();
    }

    save();
    updateUI();
    renderStats();
  }

  function startPause() {
    if (!state.timer.running) {
      state.timer.running = true;
      state.timer.lastTickMs = Date.now();
      if (!interval) interval = setInterval(tick, 300);
    } else {
      state.timer.running = false;
      state.timer.lastTickMs = null;
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

  // --- Stats ---
  function getTodayMinutes() {
    const entry = state.studyLog.find((x) => x.dateISO === todayISO());
    return entry ? Number(entry.minutes || 0) : 0;
  }

  function getWeekMinutes() {
    const start = startOfWeekISO();
    const startMs = dateToMs(start);
    const endMs = dateToMs(todayISO()) + 24 * 3600 * 1000;

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

    el.todayMin.textContent = `${today}m`;
    el.weekMin.textContent = `${week}m`;

    state.weeklyGoalMin = clamp(Number(el.weeklyGoal.value || 600), 60, 2400);
    const pct = clamp((week / state.weeklyGoalMin) * 100, 0, 100);

    el.goalBar.style.width = pct + "%";
    el.goalText.textContent = `${week} / ${state.weeklyGoalMin}`;
    save();
  }

  // --- Config ---
  function syncConfigFromInputs() {
    state.timer.config.focusMin = clamp(Number(el.focus.value || 25), 10, 90);
    state.timer.config.shortMin = clamp(Number(el.short.value || 5), 3, 20);
    state.timer.config.longMin = clamp(Number(el.long.value || 15), 10, 45);
    save();
  }

  function init() {
    if (!el.start) return;

    // load config into inputs
    el.focus.value = state.timer.config.focusMin;
    el.short.value = state.timer.config.shortMin;
    el.long.value = state.timer.config.longMin;
    el.weeklyGoal.value = state.weeklyGoalMin;

    el.start.addEventListener("click", startPause);
    el.skip.addEventListener("click", skip);
    el.reset.addEventListener("click", resetTimer);

    [el.focus, el.short, el.long].forEach((i) =>
      i.addEventListener("change", () => {
        syncConfigFromInputs();
        if (!state.timer.running) {
          state.timer.remainingSec = getModeDurationSec(state.timer.mode);
          updateUI();
        }
      })
    );

    el.weeklyGoal.addEventListener("change", renderStats);

    // Keyboard shortcuts
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