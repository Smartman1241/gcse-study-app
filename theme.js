// =====================================
// ReviseFlow GLOBAL THEME SYSTEM
// ONLY FILE REQUIRED ON ALL PAGES
// =====================================

(function () {

  const STORAGE_KEY = "reviseflow_theme";

  // ----------------------------
  // APPLY THEME
  // ----------------------------
  function applyTheme(theme) {
    if (!theme) return;

    document.documentElement.setAttribute(
      "data-theme",
      theme
    );
  }

  // ----------------------------
  // LOAD IMMEDIATELY
  // ----------------------------
  try {

    const saved =
      localStorage.getItem(STORAGE_KEY);

    if (saved) {
      applyTheme(saved);
    }

  } catch (e) {}

  // ----------------------------
  // GLOBAL SETTER
  // ----------------------------
  window.setTheme = function (theme) {

    applyTheme(theme);

    try {
      localStorage.setItem(
        STORAGE_KEY,
        theme
      );
    } catch (e) {}

  };

  // ----------------------------
  // SYNC OTHER OPEN TABS
  // ----------------------------
  window.addEventListener(
    "storage",
    function (event) {

      if (
        event.key === STORAGE_KEY
      ) {
        applyTheme(
          event.newValue
        );
      }

    }
  );

})();