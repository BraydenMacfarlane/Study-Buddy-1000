# Decks

- `inbox/` : deck JSON files that ship. `../build.sh` bakes every `inbox/*.json` (sorted by filename) into `../dist/flashcards.html`.
- `samples/` : test decks only (not shipped).

## Deck schema (one deck per file, or an array of decks)
```json
{ "id": "c202-ch01", "folder": "C202 Ch 1: Title", "course": "C202", "order": 1,
  "source": "optional string, e.g. textbook + chapter",
  "summary": "optional markdown chapter overview (# ## ### headings, **bold**, *italic*, - / 1. lists, --- rule)",
  "cards": [
    { "id": "c202-ch01-001", "front": "...", "answer": "...", "subtitle": "opt", "note": "opt, e.g. Read more: 1.13 Page", "points": ["opt"] },
    { "id": "c202-ch01-014", "type": "scenario", "front": "scenario text (newlines kept)",
      "choices": ["Legal", "Illegal", "Depends"], "correct": 1, "explanation": "...",
      "answer": "opt", "subtitle": "opt", "note": "opt" } ] }
```
Rules: `id` required on decks and cards (stable ids = in-place updates, progress kept). `correct` is 0-based; 2-5 choices.
Regular cards need `answer` (or `points`). The import in the app also accepts these files directly (merge, never deletes).
