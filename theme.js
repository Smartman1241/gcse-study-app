// =====================================
// REVISEFLOW GLOBAL THEME SYSTEM
// ULTRA STABLE PRODUCTION VERSION
// =====================================

(function () {

  "use strict";

  const KEY = "reviseflow_theme";

  const SUPABASE_URL =
    "https://mgpwknnbhaljsscsvucm.supabase.co";

  const SUPABASE_ANON =
    "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

  // -----------------------------
  // Normalize
  // -----------------------------
  function normalize(theme) {
    return theme === "light" ? "light" : "dark";
  }

  // -----------------------------
  // Apply Theme
  // -----------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute(
      "data-theme",
      normalize(theme)
    );
  }

  // -----------------------------
  // Local Storage Safe Access
  // -----------------------------
  function getLocalTheme() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function setLocalTheme(theme) {
    try {
      localStorage.setItem(KEY, normalize(theme));
    } catch {}
  }

  // =====================================================
  // SINGLE GLOBAL SUPABASE CLIENT (CRITICAL FIX)
  // =====================================================
  function getSupabase() {

    // already exists → reuse
    if (window.supabaseClient)
      return window.supabaseClient;

    // SDK not loaded
    if (!window.supabase?.createClient)
      return null;

    try {

      window.supabaseClient =
        window.supabase.createClient(
          SUPABASE_URL,
          SUPABASE_ANON,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true
            }
          }
        );

      return window.supabaseClient;

    } catch {
      return null;
    }
  }

  // -----------------------------
  // Load Theme From DB
  // -----------------------------
  async function loadThemeFromDB() {

    try {

      const sb = getSupabase();
      if (!sb) return;

      const sessionResult =
        await sb.auth.getSession()
          .catch(() => null);

      const session =
        sessionResult?.data?.session;

      if (!session?.user?.id)
        return;

      const { data } = await sb
        .from("user_settings")
        .select("theme")
        .eq("user_id", session.user.id)
        .maybeSingle()
        .catch(() => ({ data: null }));

      if (!data?.theme) return;

      applyTheme(data.theme);
      setLocalTheme(data.theme);

    } catch {
      // never crash page
    }
  }

  // -----------------------------
  // Save Theme
  // -----------------------------
  async function saveTheme(theme) {

    try {

      const sb = getSupabase();
      if (!sb) return;

      const sessionResult =
        await sb.auth.getSession()
          .catch(() => null);

      const session =
        sessionResult?.data?.session;

      if (!session?.user?.id)
        return;

      await sb
        .from("user_settings")
        .upsert({
          user_id: session.user.id,
          theme: normalize(theme),
          updated_at: new Date().toISOString()
        })
        .catch(() => {});

    } catch {}
  }

  // -----------------------------
  // Public API
  // -----------------------------
  function setTheme(theme) {

    const next = normalize(theme);

    applyTheme(next);
    setLocalTheme(next);

    // async background save
    saveTheme(next);
  }

  // expose ONE global only
  window.setTheme = setTheme;

  // =====================================================
  // INSTANT LOAD (PREVENT FLASH)
  // =====================================================
  const cached = getLocalTheme();
  if (cached) applyTheme(cached);

  // =====================================================
  // AFTER PAGE LOAD
  // =====================================================
  window.addEventListener("DOMContentLoaded", () => {

    // delay slightly → prevents auth race
    setTimeout(loadThemeFromDB, 150);

  });

  // =====================================================
  // CROSS TAB SYNC
  // =====================================================
  window.addEventListener("storage", (e) => {

    if (e.key === KEY && e.newValue) {
      applyTheme(e.newValue);
    }

  });

})();