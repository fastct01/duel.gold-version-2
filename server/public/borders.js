/* Click glow (styles: borders.css): each click on a card sends one lap of white light around its border.
   One delegated listener, so cards rendered later need no wiring. A second click restarts the lap from the top. */
const CARDS = ".dg-box,.dg-stat,.lb-card,.lb-gcard,.gl-hero,.gl-invite,.mx-panel,.mx-readyblock,.mx-short,.mx-confirm,.invite-banner," +
  ".pr-side,.pr-run,.age-card,.wd-confirm,.dep-sent,.si-invite,.cv-card[data-c]";
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

document.addEventListener("click", (e) => {
  if (reduce.matches || !(e.target instanceof Element)) return;
  const card = e.target.closest(CARDS);
  if (!card || card.matches(".ledger .dg-stat")) return; // ledger figures are an open band, not cards
  card.classList.remove("ab-run");
  void card.offsetWidth; // a reflow between remove and add restarts the animation
  card.classList.add("ab-run");
}, true);

/* the lap is done: drop the class so nothing is drawn while idle */
document.addEventListener("animationend", (e) => {
  if (e.animationName === "abLap" && e.target instanceof Element) e.target.classList.remove("ab-run");
});
