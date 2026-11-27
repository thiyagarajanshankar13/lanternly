# Lanternly website

The landing page for Lanternly, served by GitHub Pages from the `gh-pages` branch.

Plain static files, no build step:

- `index.html`: the page (styles inline)
- `favicon.svg`: the icon
- `.nojekyll`: tells GitHub Pages to serve the files as they are

To use your own domain, add a `CNAME` file holding just the domain (for example `lanternly.dev`), or set it under Settings → Pages → Custom domain, which writes that file for you.

## Logo

The lantern mark and logo live in `brand/`:

- `lanternly-mark.svg`: the mark for dark backgrounds (`lanternly-mark-on-light.svg` for white)
- `lanternly-logo-dark.svg` / `lanternly-logo-light.svg`: mark + "Lanternly" wordmark
- `lanternly-app-icon.svg` and the 512 px PNGs: square icon for avatars, the GitHub org and social cards

Colours: amber `#fbbf24` (on white `#d97706`), flame gradient `#fde68a` → `#d97706`, glass `#1c1c20`, background `#0f0f11`. Wordmark font: Space Grotesk Bold.
