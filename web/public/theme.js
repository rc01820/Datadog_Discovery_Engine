// Apply the saved theme before first paint (external file so the strict CSP needs no inline script).
(function () {
  try {
    var pref = localStorage.getItem("dde-theme") || "dark";
    var dark = pref === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : pref !== "light";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) {
    document.documentElement.dataset.theme = "dark";
  }
})();
