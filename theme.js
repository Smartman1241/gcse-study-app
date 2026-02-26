// ReviseFlow Global Theme System
// Account synced via Supabase

(async function () {

  // -----------------------------
  // SUPABASE INIT
  // -----------------------------
  const SUPABASE_URL =
    "https://mgpwknnbhaljsscsvucm.supabase.co";

  const SUPABASE_KEY =
    "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

  const supabase =
    window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_KEY
    );

  // -----------------------------
  // APPLY THEME
  // -----------------------------
  function applyTheme(theme) {
    if (!theme) return;

    document.documentElement.setAttribute(
      "data-theme",
      theme
    );
  }

  // -----------------------------
  // FAST LOAD (NO FLASH)
  // -----------------------------
  const cachedTheme =
    localStorage.getItem("reviseflow_theme");

  if (cachedTheme) {
    applyTheme(cachedTheme);
  }

  // -----------------------------
  // LOAD ACCOUNT THEME
  // -----------------------------
  async function loadAccountTheme() {

    try {

      const {
        data: { session }
      } = await supabase.auth.getSession();

      if (!session?.user) return;

      const { data, error } =
        await supabase
          .from("profiles")
          .select("theme")
          .eq("id", session.user.id)
          .single();

      if (error) return;

      if (data?.theme) {

        applyTheme(data.theme);

        localStorage.setItem(
          "reviseflow_theme",
          data.theme
        );
      }

    } catch (err) {
      console.warn(
        "Theme load failed",
        err
      );
    }
  }

  await loadAccountTheme();

  // -----------------------------
  // GLOBAL THEME SETTER
  // -----------------------------
  window.setTheme = async function (theme) {

    applyTheme(theme);

    localStorage.setItem(
      "reviseflow_theme",
      theme
    );

    try {

      const {
        data: { session }
      } = await supabase.auth.getSession();

      if (!session?.user) return;

      await supabase
        .from("profiles")
        .update({ theme })
        .eq("id", session.user.id);

    } catch (err) {
      console.warn(
        "Theme save failed",
        err
      );
    }
  };

  // -----------------------------
  // TAB SYNC
  // -----------------------------
  window.addEventListener(
    "storage",
    (event) => {

      if (
        event.key === "reviseflow_theme"
      ) {
        applyTheme(event.newValue);
      }

    }
  );

})();