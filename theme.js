(function () {

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  // Load saved theme immediately
  const savedTheme = localStorage.getItem("reviseflow_theme");

  if (savedTheme) {
    applyTheme(savedTheme);
  }

  // Sync across tabs
  window.addEventListener("storage", (event) => {
    if (event.key === "reviseflow_theme") {
      applyTheme(event.newValue);
    }
  });

  // Global function you can call anywhere
  window.setTheme = function(theme) {
    localStorage.setItem("reviseflow_theme", theme);
    applyTheme(theme);
  };

})();