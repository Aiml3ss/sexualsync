# Handoff: Sexualsync — Brand Identity

## Overview

A new visual identity for **Sexualsync** — a private, mobile-first app for couples to send sexual requests and share fantasies. This package contains the chosen logo mark, wordmark, tagline, description, and design tokens needed to apply the identity to the app.

The brand voice is **soft, knowing, direct — never crude.** "The conversation that happens before the bedroom." Read `copy.md` end-to-end before touching any user-facing string.

---

## About the design files

The HTML files in this bundle are **design references**, not production code to ship as-is. The reference prototypes show *what the brand should look and feel like* — the developer's job is to **recreate these designs inside the live Sexualsync codebase** using whatever framework, component library, and styling system that codebase already uses.

If no styling system exists yet, adopt **`brand-tokens.css`** as the source of truth and build component primitives on top of it.

## Fidelity

**High-fidelity (hifi).** Every color, font, size, radius, and string in this package is final. Match it pixel-for-pixel. The only liberties to take are:
- Adapting layouts to other screen widths (the references are designed for ~390px iPhone).
- Mapping to your existing component primitives (e.g. if your codebase already has a `<Button variant="primary">`, use it — just style it to match `.ss-pill`).

---

## What's in the box

```
design_handoff_brand_identity/
├── README.md                    ← you are here
├── IMPLEMENTATION.md            ← step-by-step integration guide
├── copy.md                      ← every approved string, with voice rules
│
├── tokens/
│   ├── brand-tokens.css         ← CSS custom properties (drop in once)
│   └── brand-tokens.json        ← same values as JSON (for design tools / TS)
│
├── marks/
│   ├── sync-wave.svg            ← canonical mark, rose stroke, transparent bg
│   ├── sync-wave-cream.svg      ← cream variant (use on rose surfaces)
│   ├── sync-wave-plum.svg       ← plum variant (use on light surfaces)
│   ├── favicon.svg              ← simplified mark, optimized for 16/32px
│   └── app-icon-1024.svg        ← iOS-style rounded tile, 1024×1024
│
├── wordmark/
│   └── wordmark.svg             ← "sexual · sync" — needs Cormorant Garamond loaded
│
├── reference-prototypes/
│   └── preview.html             ← single-file showcase of the chosen brand
│
└── screenshots/                 ← (optional — see below)
```

---

## The five things to ship

These are the deliverables this handoff exists to make happen.

1. **Replace the current italic "Sexualsync" header** in the live app with the **split wordmark** (`sexual · sync`). The italic + rose-dot + italic-rose composition is the brand signature. Render via the SVG asset, or as inline HTML with Cormorant Garamond loaded.
2. **Add the Sync Wave mark** next to the wordmark in the header, in the splash screen, and as the favicon.
3. **Update the landing/marketing hero** to display the tagline (*"Get curious. Get in sync."*) and the description from `copy.md`. See `reference-prototypes/preview.html` for layout.
4. **Apply `brand-tokens.css`** as the source of truth for colors, type, and radii throughout the app. The existing design already uses very close values — this aligns them precisely.
5. **Generate the App Store icon** from `marks/app-icon-1024.svg` at the standard iOS sizes.

---

## Screens / Views

Three reference views are included as part of the chosen-direction sheet — see `reference-prototypes/preview.html` to see them rendered.

### View 1 — App splash (`ctx-splash`)
- **Purpose:** First open, marketing entry. Establishes brand.
- **Layout:** Vertical flex, all content left-aligned, 28px horizontal padding.
- **Components, top-to-bottom:**
  - Status bar (44px tall, system-rendered)
  - Spacer (flex 1, content centers vertically in remaining space)
  - **Sync Wave mark** at 88px
  - **Split wordmark** at 52px
  - **Tagline block** — "Get curious." on line 1 (cream), "Get in sync." on line 2 (rose). `font-style: italic`, size 22px.
  - Spacer (flex 1)
  - **Primary CTA** — "Start a private space" (`.ss-pill`)
  - **Sign-in nudge** — small centered text, "Already a couple here? Sign in" (sign-in is rose)
  - 30px bottom padding

### View 2 — Landing hero (home)
- **Purpose:** What a new visitor sees on the domain.
- **Layout:** Vertical stack, 24px horizontal padding.
- **Components, top-to-bottom:**
  - Header row — Sync Wave (30px) + wordmark (20px) + `.io` mono tag pushed right
  - 28px gap
  - **Headline** — *"Get curious. Get in sync."* — italic display at 42px, the second sentence colored rose
  - **Description** — direct-medium copy from `copy.md`, 15px body
  - **Two CTAs** stacked — primary "Make your private space", ghost "How it works"
  - Spacer (flex 1)
  - **Privacy reassurance card** — rose-tinted rounded box, "Private · for two only" + the "No feed…" expansion

### View 3 — Partner invite
- **Purpose:** What a partner sees when invited to join a space.
- **Layout:** Vertical stack, 24px horizontal padding.
- **Components:**
  - Mono eyebrow — "An invite from [partner name]"
  - Headline — "[partner] started a private space for the two of you." (40px italic)
  - **Invite card** — rose-tinted rounded box with mark + wordmark + a partner quote + reassurance text
  - Spacer
  - Primary CTA "Accept the invite"
  - Ghost CTA "Maybe later"

See `IMPLEMENTATION.md` for exact color/font/size/spacing values for every element.

---

## Design tokens

See `tokens/brand-tokens.css` for the canonical list. Summary:

**Colors**
| Token | Hex | Use |
|---|---|---|
| `--ss-bg` | `#170a10` | Page background |
| `--ss-surface` | `#23111a` | Card / panel |
| `--ss-surface-2` | `#2c1622` | Raised card / hover |
| `--ss-rose` | `#e9a8b3` | Primary accent (CTAs, "sync", key glyphs) |
| `--ss-rose-soft` | `#d39ba9` | Secondary accent |
| `--ss-rose-deep` | `#b87989` | Pressed accent |
| `--ss-cream` | `#f3dcd9` | Primary text on dark |
| `--ss-cream-muted` | `rgba(243,220,217,0.65)` | Body copy |
| `--ss-cream-faint` | `rgba(243,220,217,0.32)` | Captions |
| `--ss-ink` | `#170a10` | Text on rose accent |
| `--ss-hairline` | `rgba(243,220,217,0.08)` | Dividers |

**Type**
- **Display** — Cormorant Garamond, italic 500 (Google Fonts)
- **Body** — Geist 400 (Google Fonts; falls back to Inter, system)
- **Mono** — JetBrains Mono 400, uppercase, tracking 0.16em

**Radii** — 12 / 16 / 20 / 999px (pill)

---

## Assets

All marks are vector SVG and color-correct. Drop them into the codebase's standard icon directory. **Do not raster the SVGs except for the iOS app icon** — keep them as vectors at runtime so they stay crisp at every screen density.

For the iOS app icon, render `app-icon-1024.svg` to the standard set: 1024 (App Store), 180/120 (iPhone), 167/152 (iPad), 76 (iPad notification), 60/40/29/20 (system).

---

## Files in this codebase that originated the design

These are the files in the design exploration project where the brand was developed. **You do not need to copy them into the production codebase.** They're listed here only as the source of truth if any question arises about *why* something looks the way it does.

- `Sexualsync — Brand Exploration.html` — top-level exploration canvas
- `boards.jsx` — every artboard's interior content (chosen + alternates)
- `marks.jsx` — SVG source for the six explored marks
- `brand-tokens.js` — runtime token bag (same values as `tokens/brand-tokens.css`)

---

## Notes / asks

- **Screenshots not included by default.** If you want PNG renders of the three reference views, ask — happy to add a `screenshots/` folder.
- **Color contrast:** the rose accent on plum surface clears WCAG AA for normal text. The cream-muted (0.65 alpha) on plum sits at ~4.6:1 — fine for body copy at 14px+; bump to full `--ss-cream` for any text below 14px.
- **No emoji on marketing surfaces.** The in-product `Ask` chip icons (peach, tongue, etc.) are part of the *product*, not the brand. Don't carry them into landing pages or social cards.
