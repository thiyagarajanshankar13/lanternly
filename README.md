# Lanternly website

The landing page for Lanternly, served by GitHub Pages from the `gh-pages` branch.

Plain static files, no build step on GitHub:

- `index.html`: the landing page (styles inline)
- `docs/`: the documentation site (generated, committed as it is)
- `docs-src/`: the documentation's source: one HTML fragment per page in `pages/`, `docs.css`, `docs.js` and `build.mjs`
- `favicon.svg`: the icon
- `.nojekyll`: tells GitHub Pages to serve the files as they are

## Documentation

Edit a fragment in `docs-src/pages/`, then run `node docs-src/build.mjs` (plain Node, no packages) and commit both `docs-src/` and `docs/`. The side menu order is `NAV` at the top of `build.mjs`; it also writes the search index (`docs/search.json`).

## Domain

To use your own domain, add a `CNAME` file holding just the domain (for example `lanternly.dev`), or set it under Settings → Pages → Custom domain, which writes that file for you.

## Logo

The lantern mark and logo live in `brand/`:

- `lanternly-mark.svg`: the mark for dark backgrounds (`lanternly-mark-on-light.svg` for white)
- `lanternly-logo-dark.png` / `lanternly-logo-light.png`: mark + "Lanternly" wordmark (for dark / white backgrounds)
- `lanternly-app-icon.svg` and the 512 px PNGs: square icon for avatars, the GitHub org and social cards

Colours: amber `#fbbf24` (on white `#d97706`), flame gradient `#fde68a` → `#d97706`, glass `#1c1c20`, background `#0f0f11`. Wordmark font: Space Grotesk Bold.
