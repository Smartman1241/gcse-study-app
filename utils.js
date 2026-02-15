/* ===============================
   GCSE Focus - utils.js
   Shared helpers used by all modules
   =============================== */
(() => {
  "use strict";

  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- IDs / numbers ----------
  const uid = () =>
    Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const pad2 = (n) => String(n).padStart(2, "0");

  // ---------- Date helpers ----------
  const todayISO = () => new Date().toISOString().slice(0, 10);

  // Monday-based week start (Mon=0 ... Sun=6)
  const startOfWeekISO = (d = new Date()) => {
    const dt = new Date(d);
    const day = (dt.getDay() + 6) % 7;
    dt.setDate(dt.getDate() - day);
    dt.setHours(0, 0, 0, 0);
    return dt.toISOString().slice(0, 10);
  };

  const dateToMs = (iso) => (iso ? new Date(iso + "T00:00:00").getTime() : null);

  const formatPrettyDate = (d = new Date()) =>
    d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  // ---------- Safe text ----------
  const escapeHtml = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  // Normalize for comparisons (test mode)
  const normalizeAnswer = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  // ---------- Shuffle ----------
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---------- Toast ----------
  let toastTimer = null;
  const toast = (msg) => {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  };

  // ---------- Storage ----------
  const safeParseJSON = (raw, fallback) => {
    try {
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };

  const storageGet = (key, fallback = null) =>
    safeParseJSON(localStorage.getItem(key), fallback);

  const storageSet = (key, value) =>
    localStorage.setItem(key, JSON.stringify(value));

  // Download helper (export)
  const downloadJSON = (filename, obj) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---------- Fuzzy matching for Test Mode ----------
  // User requirement: "majority match; 2 characters wrong is wrong"
  // We'll accept answers if Levenshtein distance <= 1 after normalization.
  const levenshtein = (a, b) => {
    a = String(a);
    b = String(b);
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    // DP row
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;

    for (let i = 1; i <= m; i++) {
      let prev = dp[0]; // dp[i-1][j-1]
      dp[0] = i;        // dp[i][0]
      for (let j = 1; j <= n; j++) {
        const temp = dp[j]; // dp[i-1][j]
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(
          dp[j] + 1,      // deletion
          dp[j - 1] + 1,  // insertion
          prev + cost     // substitution
        );
        prev = temp;
      }
    }
    return dp[n];
  };

  // Returns {ok:boolean, distance:number, expected:string, got:string}
  const fuzzyCheck = (expected, got) => {
    const e = normalizeAnswer(expected);
    const g = normalizeAnswer(got);

    if (!e && !g) return { ok: true, distance: 0, expected: e, got: g };
    if (!e || !g) return { ok: false, distance: Math.max(e.length, g.length), expected: e, got: g };

    if (e === g) return { ok: true, distance: 0, expected: e, got: g };

    const dist = levenshtein(e, g);
    // <= 1 char off allowed. 2+ is wrong.
    return { ok: dist <= 1, distance: dist, expected: e, got: g };
  };

  // ---------- Small scoring helpers ----------
  const percent = (good, total) => (total <= 0 ? 0 : Math.round((good / total) * 100));

  // ---------- Expose ----------
  window.Utils = {
    $, $$,
    uid, clamp, pad2,
    todayISO, startOfWeekISO, dateToMs, formatPrettyDate,
    escapeHtml, normalizeAnswer,
    shuffle,
    toast,
    storageGet, storageSet, downloadJSON,
    levenshtein, fuzzyCheck,
    percent
  };
})();