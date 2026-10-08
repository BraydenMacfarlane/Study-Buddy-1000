# Study-Buddy-1000

Single-file study app for Brayden's WGU C202 course. Open `docs/index.html` (or the GitHub Pages site) in a browser. Progress stays in that browser.

Chapters are JSON files in `decks/inbox/`. Rebuild with `./build.sh`, which writes `dist/flashcards.html`.

## Look and icon

Palette ("calm focus"): deep teal `#1f5563` header/primary, warm amber `#f0b65a` accent, warm paper `#f6f3ec` background, slate `#1f2a30` text, muted terracotta `#a8513b` for wrong answers. All colors are CSS variables at the top of `flashcards.html`.

The app icon is drawn by `assets/make_icon.py` (Pillow). After changing it, run the script, rebuild, then copy `apple-touch-icon.png`, `icon-180.png`, `icon-512.png` and `favicon.ico` from `assets/` into `docs/` (and `dist/`).
