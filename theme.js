// =====================================
// REVISEFLOW GLOBAL THEME SYSTEM
// Runs BEFORE page finishes loading
// =====================================

(function () {

  const KEY = "reviseflow_theme";

  function apply(theme) {
    if (!theme) return;

    document.documentElement.setAttribute(
      "data-theme",
      theme
    );
  }

  // ---- LOAD IMMEDIATELY ----
  try {
    const saved = localStorage.getItem(KEY);

    if (saved) {
      apply(saved);
    }
  } catch (e) {}

  // ---- GLOBAL FUNCTION ----
  window.setTheme = function (theme) {

    apply(theme);

    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {}

  };

  // ---- PAGE NAVIGATION FIX ----
  document.addEventListener(
    "DOMContentLoaded",
    function () {

      const saved =
        localStorage.getItem(KEY);

      if (saved) apply(saved);

    }
  );

  // ---- TAB SYNC ----
  window.addEventListener(
    "storage",
    function (e) {

      if (e.key === KEY) {
        apply(e.newValue);
      }

    }
  );

})();