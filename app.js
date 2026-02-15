/* ===============================
   GCSE Focus - app.js (FIXED)
   Global app state + storage + tabs + theme + import/export
   Null-safe so UI changes won't crash boot.
   =============================== */
(() => {
  "use strict";

  const U = window.Utils;
  if (!U) {
    console.error("Utils.js not loaded. Make sure <script src='utils.js'></script> is before app.js");
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

  // ---- Simple event bus ----
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

    tasks: [],

    studySets: [],      // {id,name,subject,desc,createdAt,updatedAt}
    cardsBySet: {},     // setId -> [{id,front,back,createdAt}]
    mcqBySet: {},       // setId -> [{id,q,opts:{A,B,C,D},correct,createdAt}]

    timer: {
      config: { focusMin: 25, shortMin: 5, longMin: 15 },
      mode: "focus", // focus|short|long
      session: 1,
      remainingSec: 25 * 60,
      running: false,
      lastTickMs: null,
    },

    studyLog: [], // {dateISO, minutes}
    weeklyGoalMin: 600,

    activeTab: "tasks",
    activeSetId: null,
  };

  // ---- Helpers ----
  function safeText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function safeOn(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  }

  // ---- Load/save ----
  function load() {
    const saved = storageGet(STORAGE_KEY, null);
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
    storageSet(STORAGE_KEY, state);
  }

  // ---- Theme ----
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    const btn = document.getElementById("btnTheme");
    if (btn) btn.textContent = theme === "light" ? "🌙 Theme" : "☀️ Theme";
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    applyTheme(saved || "dark");
  }

  // ---- Tabs ----
  function setTab(tab) {
    if (!tab) tab = "tasks";
    state.activeTab = tab;
    save();

    // Update tab buttons
    $$(".tab").forEach((b) => {
      const isActive = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(isActive));
    });

    // Show/hide panels
    $$("[data-tabpanel]").forEach((p) => {
      p.hidden = p.dataset.tabpanel !== tab;
    });

    bus.emit("tab:change", { tab });
  }

  function initTabs() {
    const tabs = $$(".tab");
    if (tabs.length) {
      tabs.forEach((btn) => {
        btn.addEventListener("click", () => {
          const t = btn.dataset.tab;
          if (t) setTab(t);
        });
      });
      // Optional "quick" jump button (safe)
      const quick = document.getElementById("btnQuickSetTab");
      if (quick) quick.addEventListener("click", () => setTab("studysets"));
    }

    // If the current activeTab doesn't exist in UI, fall back to first tab
    const validTabs = new Set(tabs.map((t) => t.dataset.tab).filter(Boolean));
    const initial = validTabs.has(state.activeTab) ? state.activeTab : (tabs[0]?.dataset.tab || "tasks");
    setTab(initial);
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
    // Only fill selects that exist (null-safe)
    fillSelect($("#taskSubject"), state.subjects);
    fillSelect($("#setSubject"), state.subjects);

    // These are typically filled/overridden by modules; keep safe defaults
    fillSelect($("#flashSetSelect"), state.studySets.map((s) => s.id));
    fillSelect($("#learnSetSelect"), state.studySets.map((s) => s.id));
    fillSelect($("#testSetSelect"), state.studySets.map((s) => s.id));

    bus.emit("subjects:ready", {});
  }

  // ---- Active set ----
  function setActiveSet(setId) {
    state.activeSetId = setId ?? null;
    save();
    bus.emit("set:active", { setId: state.activeSetId });
  }

  function getActiveSet() {
    if (!state.activeSetId) return null;
    return state.studySets.find((s) => s.id === state.activeSetId) || null;
  }

  // ---- Import/Export/Reset ----
  function exportData() {
    downloadJSON(`gcse-focus-backup-${todayISO()}.json`, state);
    toast?.("Exported backup.");
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON");

      // Replace known fields (keep defaults for anything missing)
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
              ...state.timer,
              ...parsed.timer,
              config: { ...state.timer.config, ...(parsed.timer.config || {}) },
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

      // Safety: stop running timer on import
      state.timer.running = false;
      state.timer.lastTickMs = null;

      save();
      toast?.("Imported successfully.");
      bus.emit("app:imported", {});
      refreshSubjectSelects();
      initTabs(); // re-evaluate valid tabs after import
      setActiveSet(state.activeSetId);
      renderTopStats();
    } catch (e) {
      console.warn(e);
      toast?.("Import failed (bad file).");
    }
  }

  function hardReset() {
    if (!confirm("Reset EVERYTHING? This cannot be undone.")) return;
    localStorage.removeItem(STORAGE_KEY);
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
    // These IDs exist in your current index.html
    safeText("uiToday", formatPrettyDate(new Date()));
    safeText("uiStreak", String(calcStreak()));

    // Some versions of your UI had this. Yours currently may not.
    const todayMinEl = document.getElementById("uiTodayMinutes");
    if (todayMinEl) todayMinEl.textContent = `${getTodayMinutes()}m`;
  }

  // ---- Wire UI controls ----
  function initChrome() {
    safeOn("btnTheme", "click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(cur === "dark" ? "light" : "dark");
    });

    safeOn("btnExport", "click", exportData);

    const fileImport = document.getElementById("fileImport");
    if (fileImport) {
      fileImport.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
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

    // default date (null-safe)
    const dueInput = $("#taskDue");
    if (dueInput) dueInput.value = dueInput.value || todayISO();

    renderTopStats();
    bus.emit("app:ready", {});
    setActiveSet(state.activeSetId);
  }

  // IMPORTANT: never crash boot
  try {
    boot();
  } catch (e) {
    console.error("App boot failed:", e);
    toast?.("App error: check console.");
  }
})();