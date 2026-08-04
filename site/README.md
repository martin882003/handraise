# Handraise launch site

Dependency-free static landing page for the Handraise Product Hunt launch.

## Preview locally

From the repository root:

```sh
python3 -m http.server 4399 --directory site
```

Then open <http://127.0.0.1:4399>.

## Launch configuration

- Product Hunt links are centralized in `PRODUCT_HUNT_URL` at the top of `app.js`.
- GitHub links currently target `https://github.com/martin882003/handraise`.
- Social previews use `assets/handraise-social.png`; edit the adjacent SVG source and rerasterize it at 1200×630 after visual changes.
- The page is plain HTML, CSS and JavaScript and can be deployed to any static host.
- Do not remove the `prefers-reduced-motion` fallback when changing animation.
- Canonical and social metadata target `https://handraise.pages.dev/`.

## Production deployment

The standalone repository is `martin882003/handraise-site`. Cloudflare Pages
deploys its `main` branch with no framework or build step and serves the
repository root at `https://handraise.pages.dev/`.

Keep `_headers`, `robots.txt`, `sitemap.xml` and `site.webmanifest` beside the
page when synchronizing this directory into the standalone repository.

## Release check

Verify the page at desktop and mobile widths, test the workflow tabs and copy button with a keyboard, confirm external URLs, and make sure no content depends on animation to become understandable.

The repository includes an automated real-Chrome check:

```sh
node scripts/site-smoke.mjs
```
