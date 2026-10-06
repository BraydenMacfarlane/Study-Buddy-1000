#!/usr/bin/env bash
# Build the deliverable single-file app with every deck in decks/inbox baked in.
#
#   ./build.sh                       # decks/inbox/*.json  -> dist/flashcards.html
#   ./build.sh --inbox DIR --out F   # custom inbox / output (used for testing)
#
# Decks are validated first; on any error nothing is written and the script exits 1.
set -euo pipefail
cd "$(dirname "$0")"
INBOX="decks/inbox"
OUT="dist/flashcards.html"
SRC="flashcards.html"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --inbox) INBOX="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --src) SRC="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
python3 - "$SRC" "$INBOX" "$OUT" <<'PY'
import json, sys, os, re, glob, datetime
src, inbox, out = sys.argv[1:4]
errors, warnings, decks = [], [], []
files = sorted(glob.glob(os.path.join(inbox, "*.json")))
for path in files:
    name = os.path.basename(path)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as e:
        errors.append(f"{name}: not valid JSON ({e})"); continue
    items = data if isinstance(data, list) else [data]
    for d in items:
        if not isinstance(d, dict) or not isinstance(d.get("cards"), list):
            errors.append(f"{name}: each deck must be an object with a \"cards\" list"); continue
        did = str(d.get("id") or "").strip()
        if not did:
            errors.append(f"{name}: deck is missing \"id\" (needed so updates merge in place)")
        if not str(d.get("folder") or "").strip():
            warnings.append(f"{name}: no \"folder\" name; the deck id will be used")
        if "order" in d and not isinstance(d["order"], (int, float)):
            errors.append(f"{name}: \"order\" must be a number")
        ids, scen = set(), 0
        for i, c in enumerate(d["cards"], 1):
            where = f"{name} card {i}"
            if not isinstance(c, dict) or not str(c.get("front") or "").strip():
                errors.append(f"{where}: needs a \"front\""); continue
            cid = str(c.get("id") or "").strip()
            if not cid:
                warnings.append(f"{where}: no \"id\"; position-based id will be used (edits may not merge cleanly)")
            elif cid in ids:
                errors.append(f"{where}: duplicate card id {cid}")
            ids.add(cid)
            if c.get("type") == "scenario":
                scen += 1
                ch = c.get("choices")
                if not isinstance(ch, list) or not (2 <= len([x for x in ch if str(x).strip()]) <= 5):
                    errors.append(f"{where}: scenario needs 2-5 non-empty \"choices\"")
                elif not (isinstance(c.get("correct"), int) and not isinstance(c.get("correct"), bool) and 0 <= c["correct"] < len(ch)):
                    errors.append(f"{where}: \"correct\" must be a 0-based index into choices")
                if not str(c.get("explanation") or "").strip():
                    warnings.append(f"{where}: scenario has no \"explanation\"")
            elif "type" in c and c.get("type") not in (None, "", "card", "basic"):
                errors.append(f"{where}: unknown type {c.get('type')!r}")
            elif not str(c.get("answer") or "").strip() and not c.get("points"):
                errors.append(f"{where}: needs an \"answer\"")
        decks.append(d)
        print(f"  + {did or '?'}: {d.get('folder', '')} ({len(d['cards'])} cards, {scen} scenario)")
seen = {}
for d in decks:
    k = str(d.get("id") or "")
    if k and k in seen: errors.append(f"deck id {k} appears in more than one file")
    seen[k] = 1
for w in warnings: print("warning:", w)
if errors:
    for e in errors: print("ERROR:", e, file=sys.stderr)
    print(f"Build failed ({len(errors)} errors). Nothing written.", file=sys.stderr)
    sys.exit(1)
html = open(src, encoding="utf-8").read()
def embed(obj):
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
info = {"date": datetime.date.today().isoformat(), "decks": len(decks), "ids": [d.get("id") for d in decks]}
for marker, value in (("BUNDLED_DECKS", embed(decks)), ("BUILD_INFO", embed(info))):
    pat = re.compile(r"/\*%s_START\*/.*?/\*%s_END\*/" % (marker, marker), re.S)
    if len(pat.findall(html)) != 1:
        print(f"ERROR: marker {marker} not found exactly once in {src}", file=sys.stderr); sys.exit(1)
    html = pat.sub(lambda m: f"/*{marker}_START*/{value}/*{marker}_END*/", html)
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
open(out, "w", encoding="utf-8").write(html)
print(f"Built {out} with {len(decks)} deck(s) from {inbox} ({len(files)} file(s)).")
PY
