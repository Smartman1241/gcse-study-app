/* ===============================
   GCSE Focus - app.js
   Global app state + storage + tabs + theme + import/export
   Other modules (tasks/timer/studysets/learn/test) plug into this.
   =============================== */
(() => {
  "use strict";

  const { $, $$, todayISO, formatPrettyDate, storageGet, storageSet, downloadJSON, toast } = window.Utils;

  // ---- Keys ----
  const STORAGE_KEY = "gcse_focus_mvp_v1";
  const THEME_KEY = "gcse_focus_theme_v1";

  // ---- Defaults ----
  const DEFAULT_SUBJECTS = [
    "Maths",
    "English Language",
    "English Literature",
    "Biology",
    "Chemistry",
    "Physics",
    "Combined Science",
    "History",
    "Geography",
    "Computer Science",
    "Religious Studies",
    "French",
    "Spanish",
    "Art",
    "Music",
    "Business",
    "PE",
    "Other",
  ];

  // ---- Simple event bus (modules subscribe to changes) ----
  const bus = (() => {
    const handlers = new Map(); // event -> Set(fn)
    return {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event, payload) {
        handlers.get(event)?.forEach((fn) => {
          try { fn(payload); } catch (e) { console.warn("bus handler error", event, e); }
        });
      },
    };
  })();

  // ---- App state shape ----
  const state = {
    version: 1,
    subjects: [...DEFAULT_SUBJECTS],

    // Tasks module uses this
    tasks: [],

    // Study sets module uses these
    studySets: [], // each: {id,name,subject,desc,createdAt,updatedAt}
    cardsBySet: {}, // setId -> [{id,front,back,createdAt}]
    mcqBySet: {},   // setId -> [{id,q,opts:{A,B,C,D},correct,createdAt}]

    // Timer module uses this
    timer: {
      config: { focusMin: 25, shortMin: 5, longMin: 15 },
      mode: "focus", // focus|short|long
      session: 1,
      remainingSec: 25 * 60,
      running: false,
      lastTickMs: null,
    },

    // Study log for stats
    studyLog: [], // {dateISO, minutes}
    weeklyGoalMin: 600,

    // UI state
    activeTab: "tasks",
    activeSetId: null,
  };

  // ---- Load/save ----
  function load() {
    const saved = storageGet(STORAGE_KEY, null);
    if (!saved || typeof saved !== "object") return;

    // Merge cautiously so new fields keep defaults
    if (Array.isArray(saved.subjects) && saved.subjects.length) state.subjects = saved.subjects;

    if (Array.isArray(saved.tasks)) state.tasks = saved.tasks;

    if (Array.isArray(saved.studySets)) state.studySets = saved.studySets;
    if (saved.cardsBySet && typeof saved.cardsBySet === "object") state.cardsBySet = saved.cardsBySet;
    if (saved.mcqBySet && typeof saved.mcqBySet === "object") state.mcqBySet = saved.mcqBySet;

    if (saved.timer && typeof saved.timer === "object") {
      state.timer = { ...state.timer, ...saved.timer };
      state.timer.config = { ...state.timer.config, ...(saved.timer.config || {}) };
    }

    if (Array.isArray(saved.studyLog)) state.studyLog = saved.studyLog;
    if (Number.isFinite(Number(saved.weeklyGoalMin))) state.weeklyGoalMin = Number(saved.weeklyGoalMin);

    if (typeof saved.activeTab === "string") state.activeTab = saved.activeTab;
    if (typeof saved.activeSetId === "string" || saved.activeSetId === null) state.activeSetId = saved.activeSetId;
  }

  function save() {
    storageSet(STORAGE_KEY, state);
  }

  // ---- Theme ----
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    $("#btnTheme").textContent = theme === "light" ? "🌙 Theme" : "☀️ Theme";
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    applyTheme(saved || "dark");
  }

  // ---- Tabs ----
  function setTab(tab) {
    state.activeTab = tab;
    save();

    $$(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $$("[data-tabpanel]").forEach((p) => (p.hidden = p.dataset.tabpanel !== tab));

    bus.emit("tab:change", { tab });
  }

  function initTabs() {
    $$(".tab").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
    // Quick jump button
    $("#btnQuickSetTab")?.addEventListener("click", () => setTab("studysets"));
    setTab(state.activeTab || "tasks");
  }

  // ---- Subjects selects ----
  function fillSelect(sel, values) {
    if (!sel) return;
    sel.innerHTML = "";
    values.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
  }

  function refreshSubjectSelects() {
    fillSelect($("#taskSubject"), state.subjects);
    fillSelect($("#setSubject"), state.subjects);
    fillSelect($("#flashSetSelect"), state.studySets.map((s) => s.id)); // filled by flashcards module later
    fillSelect($("#learnSetSelect"), state.studySets.map((s) => s.id)); // module later
    fillSelect($("#testSetSelect"), state.studySets.map((s) => s.id));  // module later
    bus.emit("subjects:ready", {});
  }

  // ---- Active set ----
  function setActiveSet(setId) {
    state.activeSetId = setId;
    save();
    bus.emit("set:active", { setId });
  }

  function getActiveSet() {
    if (!state.activeSetId) return null;
    return state.studySets.find((s) => s.id === state.activeSetId) || null;
  }

  // ---- Import/Export/Reset ----
  function exportData() {
    downloadJSON(`gcse-focus-backup-${todayISO()}.json`, state);
    toast("Exported backup.");
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON");

      // Replace state fields we know
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, {
        version: 1,
        subjects: parsed.subjects || [...DEFAULT_SUBJECTS],
        tasks: parsed.tasks || [],
        studySets: parsed.studySets || [],
        cardsBySet: parsed.cardsBySet || {},
        mcqBySet: parsed.mcqBySet || {},
        timer: parsed.timer || {
          config: { focusMin: 25, shortMin: 5, longMin: 15 },
          mode: "focus",
          session: 1,
          remainingSec: 25 * 60,
          running: false,
          lastTickMs: null,
        },
        studyLog: parsed.studyLog || [],
        weeklyGoalMin: Number(parsed.weeklyGoalMin || 600),
        activeTab: parsed.activeTab || "tasks",
        activeSetId: parsed.activeSetId ?? null,
      });

      // Safety: stop running timer on import
      state.timer.running = false;
      state.timer.lastTickMs = null;

      save();
      toast("Imported successfully.");
      bus.emit("app:imported", {});
      refreshSubjectSelects();
      setTab(state.activeTab || "tasks");
      setActiveSet(state.activeSetId);
      renderTopStats();
    } catch (e) {
      console.warn(e);
      toast("Import failed (bad file).");
    }
  }

  function hardReset() {
    if (!confirm("Reset EVERYTHING? This cannot be undone.")) return;
    localStorage.removeItem(STORAGE_KEY);
    toast("Resetting…");
    window.location.reload();
  }

  // ---- Minimal stats (top chips) ----
  function getTodayMinutes() {
    const entry = state.studyLog.find((x) => x.dateISO === todayISO());
    return entry ? Number(entry.minutes || 0) : 0;
  }

  function calcStreak() {
    const map = new Map(state.studyLog.map((x) => [x.dateISO, Number(x.minutes || 0)]));
    let streak = 0;
    let d = new Date(todayISO() + "T00:00:00");
    while (true) {
      const iso = d.toISOString().slice(0, 10);
      const mins = map.get(iso) || 0;
      if (mins > 0) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else break;
    }
    return streak;
  }

  function renderTopStats() {
    $("#uiToday").textContent = formatPrettyDate(new Date());
    $("#uiStreak").textContent = String(calcStreak());
    // Right panel stats are rendered by timer.js (but we can seed safe defaults)
    $("#uiTodayMinutes").textContent = `${getTodayMinutes()}m`;
  }

  // ---- Wire UI controls ----
  function initChrome() {
    $("#btnTheme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(cur === "dark" ? "light" : "dark");
    });

    $("#btnExport").addEventListener("click", exportData);

    $("#fileImport").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importData(file);
      e.target.value = "";
    });

    $("#btnReset").addEventListener("click", hardReset);
  }

  // ---- Public API for modules ----
  window.App = {
    STORAGE_KEY,
    state,
    bus,
    save,
    load,
    setTab,
    setActiveSet,
    getActiveSet,
    refreshSubjectSelects,

    // stats helpers some modules may use
    addStudyMinutes(minutes) {
      const m = Math.max(0, Math.round(Number(minutes || 0)));
      if (m <= 0) return;
      const d = todayISO();
      const entry = state.studyLog.find((x) => x.dateISO === d);
      if (entry) entry.minutes = Number(entry.minutes || 0) + m;
      else state.studyLog.push({ dateISO: d, minutes: m });
      save();
      bus.emit("stats:changed", {});
      renderTopStats();
    },
  };

  // ---- Boot ----
  function boot() {
    load();
    initTheme();
    initChrome();
    initTabs();
    refreshSubjectSelects();

    // default dates
const dueInput = $("#taskDue");
if (dueInput) {
  dueInput.value = dueInput.value || todayISO();
}
    renderTopStats();
    bus.emit("app:ready", {});
    // restore active set (modules will render when they subscribe)
    setActiveSet(state.activeSetId);
  }

  boot();
})();