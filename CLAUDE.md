# CLAUDE.md — Gold-Style Website Design Rules

These rules apply to every page, component, and style you write in this project. The goal is a website that looks designed by a senior art director for a luxury brand: restrained, confident, gold on deep neutrals. It must never look like a generic AI-generated ("vibe coded") site.

## 1. Priority order

1. **User-provided references come first.** If the user gives screenshots, URLs, Figma files, or brand assets, study them before writing code and match their layout, spacing, type, and mood. Where a reference conflicts with the rules below, follow the reference and say so.
2. The gold design system in this file.
3. Your own judgment, only where neither of the above covers the case.

When given a reference, write down what you extracted from it (palette, fonts, spacing rhythm, corner radius, image treatment) before building, and build from that list.

## 2. Colour: the gold system

Define all colours as CSS variables in one place. Never hardcode hex values in components.

```css
:root {
  /* Gold */
  --gold-100: #F3E7C3;  /* pale champagne, subtle fills */
  --gold-300: #E2C675;  /* highlights, hover */
  --gold-500: #C9A227;  /* primary gold */
  --gold-600: #A9851A;  /* pressed, borders on light */
  --gold-800: #6E5510;  /* gold text on light backgrounds */

  /* Neutrals (warm, never blue-grey) */
  --ink-950: #0C0B09;   /* page background, dark theme */
  --ink-900: #151310;   /* raised surfaces */
  --ink-800: #1F1C17;   /* cards, inputs */
  --ink-600: #4A453B;   /* hairlines on dark */
  --stone-400: #A39C8C; /* secondary text on dark */
  --ivory-100: #F7F3EA; /* primary text on dark / light background */
  --ivory-50:  #FCFAF5;
}
```

Rules:

- **Gold is an accent, not a background.** Roughly 70% deep neutral, 20% ivory/stone, 10% gold. If gold covers large areas, the page looks cheap.
- Use gold for: headlines' key words, thin rules and borders (1px), icons, the primary button, small numerals, hover states.
- Default theme is dark (`--ink-950` background, `--ivory-100` text). A light theme uses `--ivory-50` background with `--gold-800` for gold text, because `--gold-500` on a light background fails contrast.
- A metallic gradient is allowed only on small elements (a logo mark, one headline word, a button edge), built from golds only: `linear-gradient(135deg, #E2C675, #C9A227 45%, #8C6A1C)`. Maximum one or two per screen.
- Body text contrast must meet WCAG AA (4.5:1). Check it; do not assume.

## 3. Banned: the vibe-coded look

Never produce any of the following unless a user reference explicitly requires it:

- Purple, violet, indigo, or purple-to-blue / purple-to-pink gradients, anywhere
- Neon glows, glowing blobs, blurred colour orbs behind the hero
- Glassmorphism cards (frosted blur plus translucent borders) as the default surface
- Inter, Roboto, Poppins, or system-ui as the display font
- Emoji as icons or bullet points; sparkle icons next to headings
- The standard layout: centred hero with a pill badge, two buttons, then three identical icon cards in a row, then a gradient call-to-action
- Uniform large rounded corners (16–24px) on everything, with heavy soft drop shadows
- Gradient text on every heading
- Filler copy ("Unlock the power of…", "Seamlessly…", "Elevate your…") and lorem ipsum
- Fake testimonials, invented statistics, placeholder logos
- Hover animations that scale or bounce every card

If a draft resembles a default Tailwind or shadcn template with colours swapped, redesign it.

## 4. Typography

Fonts carry most of the luxury feel. Always load real web fonts (Google Fonts or self-hosted) with `font-display: swap`.

- **Display (headings):** a refined serif. Choose one: Cormorant Garamond, Playfair Display, Fraunces, or Bodoni Moda.
- **Body and UI:** a quiet sans. Choose one: Jost, Manrope, DM Sans, or Outfit.
- Two families maximum. One display, one body.

Rules:

- Headlines large and light to regular in weight (300–500), with tight line height (1.05–1.15) and slight negative letter spacing on large sizes.
- Small labels and navigation: uppercase, 11–13px, letter spacing 0.12–0.2em.
- Body: 16–18px, line height 1.6–1.7, maximum line length about 65 characters.
- Use a consistent type scale (for example 14 / 16 / 20 / 28 / 40 / 64 / 96) with `clamp()` for fluid sizing.
- Use real typographic characters: curly quotes, proper dashes, non-breaking spaces before units.

## 5. Layout and detail

- Generous whitespace. Section padding around 96–160px on desktop, 56–80px on mobile.
- Use an asymmetric or editorial grid where it fits: offset columns, large images against narrow text. Avoid centring everything.
- Corners: 0–4px. Sharp or nearly sharp reads as luxury.
- Borders: 1px hairlines in `--ink-600` or gold at low opacity instead of shadows. Shadows, if any, are subtle and warm.
- Buttons: primary is solid gold with dark text, or a gold outline; rectangular, uppercase label with letter spacing. One primary action per view.
- Imagery: high quality, warm-toned, consistent treatment. No stock illustrations or 3D blobs. If no images are supplied, design with type, rules, and space instead of placeholders.
- Motion: slow and minimal (300–600ms, ease-out). Fades and short slides on scroll, underline reveals on links. Respect `prefers-reduced-motion`.

## 6. Responsive: desktop and mobile both matter

Design mobile-first, then enhance. Every page must work at 360, 390, 768, 1024, 1440, and 1920px wide.

- No horizontal scrolling at any width.
- Touch targets at least 44×44px; no hover-only interactions.
- Navigation collapses to a designed mobile menu, not a squeezed desktop bar.
- Multi-column grids stack in a sensible reading order.
- Type scales down fluidly; hero headlines never break one word per line.
- Images use `srcset` or responsive sizing, with `width` and `height` set to prevent layout shift.

## 7. Always check your work

After finishing any page or component, verify before reporting it done:

1. Run the site and view it. Take screenshots at 390px and 1440px minimum and inspect them.
2. Compare against the user's references, if any, and list remaining differences.
3. Go through the banned list in section 3 item by item.
4. Confirm fonts loaded (no fallback serif or sans showing).
5. Check text contrast, especially gold on light and stone on dark.
6. Check for overflow, clipped text, misaligned edges, and uneven spacing.
7. Check the browser console for errors and confirm all links and buttons work.
8. Fix what you find, then check again.

Report what you checked and anything you could not verify. Do not say the work is done if a check failed or was skipped.

## 8. Code standards

- Semantic HTML, one `h1` per page, alt text on images, visible focus states (a gold outline works well).
- All design tokens (colour, type scale, spacing) as CSS variables or theme config, reused everywhere.
- No unused libraries. Prefer CSS over JavaScript for layout and simple motion.
- Keep performance in mind: compressed images, lazy loading below the fold, minimal font weights loaded.
