# Implementation guide

This document is for the engineer (or coding agent) integrating the Sexualsync brand into the live codebase. Read `README.md` first for the high-level "what's in this package" overview; this file is the *how*.

---

## 0 — Inventory check

Before changing anything, confirm:

1. The existing codebase has — or can easily add — a way to inject a CSS file globally. (For Next.js: `app/globals.css` or `_app.tsx`. For Vite: the entry CSS. For a static HTML site: a `<link>` in `<head>`.)
2. The site can load Google Fonts (or has a self-hosted equivalent of Cormorant Garamond, Geist, and JetBrains Mono).
3. You have write access to the file that renders the app header and the marketing landing page.

If any of these is uncertain, ask before continuing.

---

## 1 — Load the brand tokens

Copy `tokens/brand-tokens.css` into your project (suggested: `app/styles/brand-tokens.css` or equivalent) and import it **before** any component CSS so the `:root` custom properties are available everywhere.

```css
/* app/globals.css */
@import "./styles/brand-tokens.css";
/* …everything else after */
```

Then load the three webfonts. Easiest: a single Google Fonts link in `<head>`.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600;1,700&family=Geist:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**Verify:** open the app, inspect any element, confirm `getComputedStyle(document.documentElement).getPropertyValue('--ss-rose')` returns `#e9a8b3`.

---

## 2 — Replace the header wordmark

The current app header reads "Sexualsync" in italic. Replace it with the **split wordmark**.

### Recommended: inline HTML/JSX (lets type scale with the system)

```jsx
function Wordmark({ size = 24 }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: size * 0.32,
      fontFamily: 'var(--ss-font-display)',
      fontStyle: 'italic',
      fontWeight: 500,
      fontSize: size,
      lineHeight: 0.95,
      color: 'var(--ss-cream)',
    }}>
      <span>sexual</span>
      <span style={{
        width: size * 0.12,
        height: size * 0.12,
        borderRadius: '50%',
        background: 'var(--ss-rose)',
        opacity: 0.9,
        display: 'inline-block',
        flex: '0 0 auto',
      }} aria-hidden="true" />
      <span style={{ color: 'var(--ss-rose)' }}>sync</span>
    </span>
  );
}
```

Use `<Wordmark size={24} />` for app headers, `size={52}` for splash, `size={100}` for posters.

### Alternative: drop in the SVG

```html
<img src="/marks/wordmark.svg" alt="Sexualsync" height="32" />
```

The SVG references Cormorant Garamond too, so step 1 (font loading) is still required.

### Common mistake

Do **not** use the typographic middot character (`·`) as the separator — italic font metrics overhang and it disappears between the two italic "l" and "s" glyphs. Always use a real circle element (CSS `border-radius: 50%` or SVG `<circle>`).

---

## 3 — Add the Sync Wave mark

Use `marks/sync-wave.svg` next to the wordmark in:

- The app's persistent header (small — ~24–32px)
- The splash / open screen (large — 88–120px)
- The browser favicon (use `marks/favicon.svg`)
- The App Store / PWA icon (use `marks/app-icon-1024.svg`)

### Favicon

```html
<link rel="icon" type="image/svg+xml" href="/marks/favicon.svg" />
<link rel="apple-touch-icon" href="/marks/app-icon-1024.svg" />
```

### In a React component

```jsx
function SyncWave({ size = 32, color = 'var(--ss-rose)' }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
      <path d="M 12,50 C 22,30 38,30 50,50 C 62,70 78,70 88,50"
            fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"/>
      <path d="M 12,62 C 22,42 38,42 50,62 C 62,82 78,82 88,62"
            fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" opacity="0.45"/>
    </svg>
  );
}
```

When the mark sits inside an interactive control, add an accessible label on the parent (e.g. `aria-label="Sexualsync home"` on the link wrapping it) and keep `aria-hidden="true"` on the SVG itself.

---

## 4 — Update the landing page

The current marketing landing — if any — should be replaced with the layout in `reference-prototypes/preview.html` (the "Landing hero" panel). Exact specs:

| Section | Properties |
|---|---|
| Page background | `var(--ss-bg)` (`#170a10`) |
| Header row | flex row, align-center, justify-between. Sync Wave (30px) + wordmark (20px) on left, `.io` mono label on right. 28px bottom margin. |
| Hero headline | `font-family: var(--ss-font-display); font-style: italic; font-size: 42px; line-height: 1.06; color: var(--ss-cream);`. Wrap "Get in sync." in a `<span>` colored `var(--ss-rose)`. |
| Description | Body sans, 15px, color `var(--ss-cream-muted)`, line-height 1.55. Text from `copy.md`. 18px top margin. |
| CTAs | Two stacked `.ss-pill` buttons, 10px gap, 22px top margin. Primary "Make your private space", ghost "How it works". |
| Privacy card | rose-tinted rounded box at bottom, full width. `padding: 14px 16px; border-radius: 16px; background: rgba(233,168,179,0.06); border: 1px solid var(--ss-hairline);`. Mono eyebrow "Private · for two only" + body text. |

The page is **mobile-first** — the design is laid out for 360–390px viewports. For wider screens, cap the content column at ~520px and center it horizontally on a `var(--ss-bg)` field.

---

## 5 — Update the app splash and partner invite

These follow the same component vocabulary — see `reference-prototypes/preview.html` for layout, and the README's "Screens / Views" section for component-by-component specs.

The partner-invite screen needs one piece of dynamic copy: the partner's display name. Substitute it into the headline as shown in `copy.md` — *"[Name] started a private space for the two of you."* — and the eyebrow — *"An invite from [Name]."*

---

## 6 — Apply tokens across the rest of the app

The five existing screens in the current app (Dashboard, Ask, Ideas, Limits, Settings) already use very similar colors. Audit them against `brand-tokens.css` and replace any one-off hex values with the matching token. Key migrations to watch for:

- The pink "Save changes" / "Add limit" / "Request" button → `.ss-pill`
- The italic "Sexualsync" header → the new split `<Wordmark />`
- The italic display headlines (*"Get turned on. Ask for it."*, *"Feed the fantasy."*) → `.ss-display` class, color `var(--ss-cream)`
- The uppercase tracked eyebrows (`DASHBOARD`, `ASK`, `YOU & YOUR SPACE`) → `.ss-mono` class

This step is mostly mechanical but worth doing — any drift in colors will be obvious next to the new brand.

---

## 7 — Test pass

Before shipping:

- [ ] **Wordmark on every header** — verify the rose dot is visible (not collapsed) on iOS Safari, Android Chrome, and desktop Chrome/Firefox/Safari. If it disappears, the font hasn't loaded yet — gate the wordmark render until `document.fonts.ready` resolves.
- [ ] **Favicon** shows in the browser tab.
- [ ] **App Store icon** renders correctly at 1024, 180, 60, 29.
- [ ] **Tagline cadence** — both "Get curious." and "Get in sync." have periods, and the second one is rose.
- [ ] **Reduced motion** — none of this brand work introduces animation, but verify nothing existing breaks.
- [ ] **Color contrast** — `--ss-cream-muted` text (0.65 alpha) clears 4.6:1 on `--ss-bg`. Anything smaller than 14px should use full `--ss-cream`.

---

## 8 — Out of scope (not in this handoff)

- Email templates
- Open Graph / Twitter share images
- App Store screenshot set
- Onboarding flow
- New product features

If any of these come up, the brand-token + copy combination here is enough to extrapolate from. Keep the voice rules in `copy.md` honest.
