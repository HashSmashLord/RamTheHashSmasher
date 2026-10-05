// RAMherd: the top bar, shared by every page. The links are real pages (herd.html,
// herder.html, submit.html, rules.html, launch.html); the one behaviour here is the
// pixel toggle that opens the menu at narrow widths. Each page's script calls initNav().

export function initNav(doc = document) {
  const navToggle = doc.getElementById("nav-toggle");
  const mainNav = doc.getElementById("main-nav");
  if (!navToggle || !mainNav) return;

  function setNav(open) {
    mainNav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  navToggle.addEventListener("click", () => setNav(!mainNav.classList.contains("is-open")));
  mainNav.addEventListener("click", (e) => {
    if (e.target.closest("a")) setNav(false);
  });
}
