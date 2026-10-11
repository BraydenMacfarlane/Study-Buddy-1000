# Study-Buddy-1000

Single-file study app for Brayden's WGU C202 course. Open `docs/index.html` (or the GitHub Pages site) in a browser. Progress stays in that browser.

Chapters are JSON files in `decks/inbox/`. Rebuild with `./build.sh`, which writes `dist/flashcards.html`.

## Look and icon

Palette ("calm focus"): deep teal `#1f5563` header/primary, warm amber `#f0b65a` accent, warm paper `#f6f3ec` background, slate `#1f2a30` text, muted terracotta `#a8513b` for wrong answers. All colors are CSS variables at the top of `flashcards.html`.

The app icon is drawn by `assets/make_icon.py` (Pillow). After changing it, run the script, rebuild, then copy `apple-touch-icon.png`, `icon-180.png`, `icon-512.png` and `favicon.ico` from `assets/` into `docs/` (and `dist/`).

## Sync across devices

Home → **Sync**. Paste a GitHub personal access token once per device (fine-grained token with only
Account permission **Gists: Read and write**, or a classic token with only the `gist` scope). The app
keeps one secret gist named "Study-Buddy-1000 sync" with `study-buddy-sync.json` (progress, sessions,
plans, scores, user-made folders/cards, with per-item timestamps and deletion tombstones) and
`c202-plan.txt` (the Share-plan text). Devices merge rather than overwrite. The token is stored only in
that device's localStorage (`flashcards.sync.token`): it is never in Export backups or in the gist.

Box helper: `tools/read-plan.sh [SYNC_ID]` prints the plan and a progress summary from the gist
anonymously (Sync ID from the argument, `$SYNC_ID`, or `.sync-id`, which is git-ignored).
