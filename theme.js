// =====================================
// REVISEFLOW GLOBAL THEME SYSTEM
// Production Safe Version
// =====================================

(function () {

  const KEY = "reviseflow_theme";
  const SUPABASE_URL = "https://mgpwknnbhaljsscsvucm.supabase.co";
  const SUPABASE_ANON =
    "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

  // -----------------------------
  // Normalize
  // -----------------------------
  function normalizeTheme(theme) {
    return theme === "light" ? "light" : "dark";
  }

  // -----------------------------
  // Apply Theme
  // -----------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute(
      "data-theme",
      normalizeTheme(theme)
    );
  }

  // -----------------------------
  // Local Storage
  // -----------------------------
  function getLocalTheme() {
    try {
      return localStorage.getItem(KEY);
    } catch (_) {
      return null;
    }
  }

  function setLocalTheme(theme) {
    try {
      localStorage.setItem(KEY, normalizeTheme(theme));
    } catch (_) {}
  }

  // -----------------------------
  // Supabase Client
  // -----------------------------
  function getSupabaseClient() {

    if (window.supabaseClient)
      return window.supabaseClient;

    if (!window.supabase) return null;

    window.supabaseClient =
      window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_ANON
      );

    return window.supabaseClient;
  }

  // -----------------------------
  // Load From Supabase
  // -----------------------------
  async function loadThemeFromSupabase() {

    try {

      const sb = getSupabaseClient();
      if (!sb) return;

      const { data: { session } } =
        await sb.auth.getSession();

      const userId = session?.user?.id;
      if (!userId) return;

      const { data } = await sb
        .from("user_settings")
        .select("theme")
        .eq("user_id", userId)
        .maybeSingle();

      if (data?.theme) {
        applyTheme(data.theme);
        setLocalTheme(data.theme);
      }

    } catch (_) {
      // silent fail
    }
  }

  // -----------------------------
  // Save To Supabase
  // -----------------------------
  async function saveThemeToSupabase(theme) {

    try {

      const sb = getSupabaseClient();
      if (!sb) return;

      const { data: { session } } =
        await sb.auth.getSession();

      const userId = session?.user?.id;
      if (!userId) return;

      await sb
        .from("user_settings")
        .upsert({
          user_id: userId,
          theme: normalizeTheme(theme),
          updated_at: new Date().toISOString()
        });

    } catch (_) {}
  }

  // -----------------------------
  // Public Setter
  // -----------------------------
  function setTheme(theme) {

    const next = normalizeTheme(theme);

    applyTheme(next);
    setLocalTheme(next);

    // async save (non blocking)
    saveThemeToSupabase(next);
  }

  // expose ONE global only
  window.setTheme = setTheme;

  // -----------------------------
  // Instant Load (NO FLASH)
  // -----------------------------
  const initialTheme = getLocalTheme();
  if (initialTheme) {
    applyTheme(initialTheme);
  }

  // -----------------------------
  // After Paage Load → Sync DB
  // -----------------------------
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      loadThemeFromSupabase();
    }
  );

  // -----------------------------
  // Cross Tab Sync
  // -----------------------------
  window.addEventListener(
    "storage",
    (e) => {
      if (e.key === KEY && e.newValue) {
        applyTheme(e.newValue);
      }
    }
  );

})();