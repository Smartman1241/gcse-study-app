/* ===============================
   GCSE Focus - app.js (HARD FIX)
   Global app state + storage + tabs + theme + import/export
   Extremely null-safe so UI changes/modules can't crash boot.
   =============================== */
(() => {
  "use strict";

  // ---- Guard: Utils must exist ----
  const U = window.Utils;
  if (!U) {
    console.error("Utils.js not loaded. Ensure <script src='utils.js'></script> appears before app.js");
    return;
  }

  const { $, $$, todayISO, formatPrettyDate, storageGet, storageSet, downloadJSON, toast } = U;

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

  // ---- Simple event bus (safe emit) ----
  const bus = (() => {
    const handlers = new Map(); // event -> Set(fn)
    return {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event, payload) {
        const set = handlers.get(event);
        if (!set) return;
        set.forEach((fn) => {
          try { fn(payload); }
          catch (e) { console.warn("bus handler error:", event, e); }
        });
      },
    };
  })();

  // ---- App state shape ----
  const state = {
    version: 1,
    subjects: [...DEFAULT_SUBJECTS],

    tasks: [],

    studySets: [],
    cardsBySet: {},
    mcqBySet: {},

    timer: {
      config: { focusMin: 25, shortMin: 5, longMin: 15 },
      mode: "focus",
      session: 1,
      remainingSec: 25 * 60,
      running: false,
      lastTickMs: null,
    },

    studyLog: [],
    weeklyGoalMin: 600,

    activeTab: "tasks",
    activeSetId: null,
  };

  // ---- DOM helpers (never throw) ----
  function byId(id) {
    try { return document.getElementById(id); } catch { return null; }
  }

  function safeText(id, value) {
    const el = byId(id);
    if (el) el.textContent = value;
  }

  function safeOn(id, event, handler) {
    const el = byId(id);
    if (el) el.addEventListener(event, handler);
  }

  function safeCall(fn, label = "safeCall") {
    try { return fn(); }
    catch (e) { console.warn(label, e); return undefined; }
  }

  // ---- Load/save ----
  function load() {
    const saved = safeCall(() => storageGet(STORAGE_KEY, null), "storageGet");
    if (!saved || typeof saved !== "object") return;

    if (Array.isArray(saved.subjects) && saved.subjects.length) state.subjects = saved.subjects;

    if (Array.isArray(saved.tasks)) state.tasks = saved.tasks;

    if (Array.isArray(saved.studySets)) state.studySets = saved.studySets;
    if (saved.cardsBySet && typeof saved.cardsBySet === "object") state.cardsBySet = saved.cardsBySet;
    if (saved.mcqBySet && typeof saved.mcqBySet === "object") state.mcqBySet = saved.mcqBySet;

    if (saved.timer && typeof saved.timer === "object") {
      state.timer = { ...state.timer, ...saved.timer };
      state.timer.config = { ...state.timer.config, ...(saved.timer.config || {}) };

      // sanity
      if (!Number.isFinite(Number(state.timer.remainingSec))) state.timer.remainingSec = 25 * 60;
      if (!Number.isFinite(Number(state.timer.session))) state.timer.session = 1;
      if (typeof state.timer.mode !== "string") state.timer.mode = "focus";
      if (typeof state.timer.running !== "boolean") state.timer.running = false;
    }

    if (Array.isArray(saved.studyLog)) state.studyLog = saved.studyLog;
    if (Number.isFinite(Number(saved.weeklyGoalMin))) state.weeklyGoalMin = Number(saved.weeklyGoalMin);

    if (typeof saved.activeTab === "string") state.activeTab = saved.activeTab;
    if (typeof saved.activeSetId === "string" || saved.activeSetId === null) state.activeSetId = saved.activeSetId;
  }

  function save() {
    safeCall(() => storageSet(STORAGE_KEY, state), "storageSet");
  }

  // ---- Theme ----
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    safeCall(() => localStorage.setItem(THEME_KEY, theme), "setTheme");
    const btn = byId("btnTheme");
    if (btn) btn.textContent = theme === "light" ? "🌙 Theme" : "☀️ Theme";
  }

  function initTheme() {
    const saved = safeCall(() => localStorage.getItem(THEME_KEY), "getTheme");
    applyTheme(saved || "dark");
  }

  // ---- Tabs ----
  function getAvailableTabs() {
    return $$(".tab")
      .map((t) => t?.dataset?.tab)
      .filter(Boolean);
  }

  function setTab(tab) {
    const available = new Set(getAvailableTabs());
    const chosen = (tab && available.has(tab)) ? tab : (available.values().next().value || "tasks");

    state.activeTab = chosen;
    save();

    // update button state
    $$(".tab").forEach((b) => {
      const isActive = b.dataset.tab === chosen;
      b.setAttribute("aria-selected", String(isActive));
    });

    // show/hide panels
    const panels = $$("[data-tabpanel]");
    if (panels.length) {
      panels.forEach((p) => {
        p.hidden = p.dataset.tabpanel !== chosen;
      });
    }

    bus.emit("tab:change", { tab: chosen });
  }

  function initTabs() {
    const tabs = $$(".tab");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn?.dataset?.tab;
        if (t) setTab(t);
      });
    });

    // Optional quick jump
    const quick = byId("btnQuickSetTab");
    if (quick) quick.addEventListener("click", () => setTab("studysets"));

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
    safeCall(() => fillSelect($("#taskSubject"), state.subjects), "fill taskSubject");
    safeCall(() => fillSelect($("#setSubject"), state.subjects), "fill setSubject");

    // These are often overridden by modules later; keep safe defaults
    safeCall(() => fillSelect($("#flashSetSelect"), state.studySets.map((s) => s.id)), "fill flashSetSelect");
    safeCall(() => fillSelect($("#learnSetSelect"), state.studySets.map((s) => s.id)), "fill learnSetSelect");
    safeCall(() => fillSelect($("#testSetSelect"), state.studySets.map((s) => s.id)), "fill testSetSelect");

    bus.emit("subjects:ready", {});
  }

  // ---- Active set ----
  function setActiveSet(setId) {
    state.activeSetId = (setId ?? null);
    save();
    bus.emit("set:active", { setId: state.activeSetId });
  }

  function getActiveSet() {
    if (!state.activeSetId) return null;
    return state.studySets.find((s) => s.id === state.activeSetId) || null;
  }

  // ---- Import/Export/Reset ----
  function exportData() {
    safeCall(() => downloadJSON(`gcse-focus-backup-${todayISO()}.json`, state), "downloadJSON");
    toast?.("Exported backup.");
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON");

      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, {
        version: 1,
        subjects: Array.isArray(parsed.subjects) && parsed.subjects.length ? parsed.subjects : [...DEFAULT_SUBJECTS],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        studySets: Array.isArray(parsed.studySets) ? parsed.studySets : [],
        cardsBySet: parsed.cardsBySet && typeof parsed.cardsBySet === "object" ? parsed.cardsBySet : {},
        mcqBySet: parsed.mcqBySet && typeof parsed.mcqBySet === "object" ? parsed.mcqBySet : {},
        timer: parsed.timer && typeof parsed.timer === "object"
          ? {
              ...parsed.timer,
              config: { focusMin: 25, shortMin: 5, longMin: 15, ...(parsed.timer.config || {}) },
            }
          : {
              config: { focusMin: 25, shortMin: 5, longMin: 15 },
              mode: "focus",
              session: 1,
              remainingSec: 25 * 60,
              running: false,
              lastTickMs: null,
            },
        studyLog: Array.isArray(parsed.studyLog) ? parsed.studyLog : [],
        weeklyGoalMin: Number(parsed.weeklyGoalMin || 600),
        activeTab: typeof parsed.activeTab === "string" ? parsed.activeTab : "tasks",
        activeSetId: parsed.activeSetId ?? null,
      });

      // stop running timer on import
      state.timer.running = false;
      state.timer.lastTickMs = null;

      save();
      toast?.("Imported successfully.");

      bus.emit("app:imported", {});
      refreshSubjectSelects();
      initTabs();
      setActiveSet(state.activeSetId);
      renderTopStats();
    } catch (e) {
      console.warn(e);
      toast?.("Import failed (bad file).");
    }
  }

  function hardReset() {
    if (!confirm("Reset EVERYTHING? This cannot be undone.")) return;
    safeCall(() => localStorage.removeItem(STORAGE_KEY), "remove storage");
    toast?.("Resetting…");
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
    safeText("uiToday", formatPrettyDate(new Date()));
    safeText("uiStreak", String(calcStreak()));

    // Optional (only if present)
    const todayMinEl = byId("uiTodayMinutes");
    if (todayMinEl) todayMinEl.textContent = `${getTodayMinutes()}m`;
  }

  // ---- Wire UI controls ----
  function initChrome() {
    safeOn("btnTheme", "click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(cur === "dark" ? "light" : "dark");
    });

    safeOn("btnExport", "click", exportData);

    const fileImport = byId("fileImport");
    if (fileImport) {
      fileImport.addEventListener("change", (e) => {
        const file = e?.target?.files?.[0];
        if (file) importData(file);
        e.target.value = "";
      });
    }

    safeOn("btnReset", "click", hardReset);
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

    const dueInput = $("#taskDue");
    if (dueInput) dueInput.value = dueInput.value || todayISO();

    renderTopStats();

    // Important: even if a module throws on app:ready, the app must keep running
    bus.emit("app:ready", {});

    setActiveSet(state.activeSetId);
  }

  try {
    boot();
  } catch (e) {
    console.error("App boot failed:", e);
    toast?.("App error: check console.");
  }
})();