# Decks

- `inbox/` : deck JSON files that ship. `../build.sh` bakes every `inbox/*.json` (sorted by filename) into `../dist/flashcards.html`.
- `samples/` : test decks only (not shipped).

## Deck schema (one deck per file, or an array of decks)
```json
{ "id": "c202-ch01", "folder": "C202 Ch 1: Title", "course": "C202", "order": 1,
  "source": "optional string, e.g. textbook + chapter",
  "summary": "optional markdown chapter overview (# ## ### headings, **bold**, *italic*, - / 1. lists, --- rule)",
  "cards": [
    { "id": "c202-ch01-001", "front": "...", "answer": "...", "subtitle": "opt", "note": "opt, e.g. Read more: 1.13 Page", "points": ["opt"],
      "distractors": ["opt: 2-5 plausible wrong answers"] },
    { "id": "c202-ch01-014", "type": "scenario", "front": "scenario text (newlines kept)",
      "choices": ["Legal", "Illegal", "Depends"], "correct": 1, "explanation": "...",
      "answer": "opt", "subtitle": "opt", "note": "opt" } ] }
```
`summary` is shown as the chapter's **Study guide** (read time = words/220). `course` + `order` drive course grouping, chapter gating, the suggested path and the pacing planner (course config lives in `COURSE_CONFIG` in flashcards.html).

Rules: `id` required on decks and cards (stable ids = in-place updates, progress kept). `correct` is 0-based; 2-5 choices.
Regular cards need `answer` (or `points`). The import in the app also accepts these files directly (merge, never deletes).

### Wrong answers for multiple choice (quiz, quick quiz, boss)
Concept cards get 3 wrong answers. Optional `distractors` (2-5 strings) on a concept card are used first
(3 picked at random if more are given); if fewer than 3, the rest are filled with random answers from other
concept cards in the folder (then the course), as before. Cards without `distractors` work exactly as before.
Duplicates and anything matching the correct answer are never used.
build.sh rejects `distractors` that aren't 2-5 unique non-empty strings, that repeat the answer, or that sit
on a scenario card. The in-app import is lenient: bad entries are dropped silently.
Write distractors in the same style and length as the real answer, plausible but clearly wrong.

