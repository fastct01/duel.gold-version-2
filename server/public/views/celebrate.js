/* Victory confetti for the result screen: a short burst of sparse gold pieces (styles: .pl-confetti in app.css).
   Plays once per match, only for a win, never with reduced motion, and cleans itself up. */

const COLOURS = ["var(--gold-300)", "var(--gold-500)", "var(--gold-100)", "var(--ok)", "var(--ivory-100)"];
let lastMatch = null;

export function mount(name, app) {
  const r = app.S.result;
  if (name !== "result" || !r || r.result !== "win" || r.id === lastMatch) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = document.querySelector(".mx-result");
  if (!host) return;
  lastMatch = r.id;
  const box = document.createElement("div");
  box.className = "pl-confetti";
  box.setAttribute("aria-hidden", "true");
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < 34; i++) {
    const p = document.createElement("i");
    if (i % 3 === 0) p.className = "dot";
    p.style.cssText = `left:${rnd(2, 98)}%;background:${COLOURS[i % COLOURS.length]};--d:${rnd(1.7, 2.9).toFixed(2)}s;--dl:${rnd(0, 0.5).toFixed(2)}s;` +
      `--dx:${rnd(-60, 60).toFixed(0)}px;--r:${rnd(-540, 540).toFixed(0)}deg`;
    box.appendChild(p);
  }
  /* a fixed overlay over the result, outside #main, so the re-render that follows a match (balance refresh) can't wipe it */
  const rect = host.getBoundingClientRect();
  box.style.cssText = `left:${Math.round(rect.left)}px;top:${Math.round(Math.max(0, rect.top - 40))}px;width:${Math.round(rect.width)}px`;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3800);
}
