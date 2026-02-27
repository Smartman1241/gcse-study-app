(function () {
  const KEY = "reviseflow_theme";
  const SUPABASE_URL = "https://mgpwknnbhaljsscsvucm.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

  function normalizeTheme(theme) {
    return theme === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    if (!theme) return;
    document.documentElement.setAttribute("data-theme", normalizeTheme(theme));
  }

  function getSupabaseClient() {
    if (window.supabaseClient) return window.supabaseClient;
    if (!window.supabase) return null;
    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.supabaseClient;
  }

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

  async function loadThemeFromSupabase() {
    try {
      const sb = getSupabaseClient();
      if (!sb) return;

      const { data: { session } } = await sb.auth.getSession();
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
    } catch (_) {}
  }

  async function saveThemeToSupabase(theme) {
    try {
      const sb = getSupabaseClient();
      if (!sb) return;

      const { data: { session } } = await sb.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) return;

      await sb.from("user_settings").upsert({
        user_id: userId,
        theme: normalizeTheme(theme),
        updated_at: new Date().toISOString()
      });
    } catch (_) {}
  }

  function setTheme(theme) {
    const next = normalizeTheme(theme);
    applyTheme(next);
    setLocalTheme(next);
    saveThemeToSupabase(next);
  }

  const initialTheme = getLocalTheme();
  if (initialTheme) applyTheme(initialTheme);

  window.setTheme = setTheme;

  document.addEventListener("DOMContentLoaded", function () {
    loadThemeFromSupabase();
  });

  window.addEventListener("storage", function (event) {
    if (event.key === KEY && event.newValue) {
      applyTheme(event.newValue);
    }
  });
})();
