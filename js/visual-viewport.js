/** Tastaturhöhe für Dialoge/Sheets (--kb auf :root). */
export function installVisualViewportKeyboard() {
  const root = document.documentElement;

  function update() {
    const vv = window.visualViewport;
    if (!vv) {
      root.style.setProperty("--kb", "0px");
      return;
    }
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty("--kb", `${Math.round(kb)}px`);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update);
    window.visualViewport.addEventListener("scroll", update);
  }
  window.addEventListener("resize", update);
  update();
}
