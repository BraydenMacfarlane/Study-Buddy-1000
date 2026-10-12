#!/usr/bin/env bash
# Print Brayden's Study-Buddy-1000 pacing plan + a progress summary from the secret sync gist.
#
#   tools/read-plan.sh [SYNC_ID]     # gist id/URL, or fs:PROJECT/SHAREID (Google sync "Plan link");
#                                    # default: $SYNC_ID or ./.sync-id
#   tools/read-plan.sh --json [ID]   # raw summary JSON instead of text
#
# Reads the gist anonymously over the public API (secret gists are readable by id). It never sends
# or prints a token, and ignores GH_TOKEN. Anonymous API calls are limited to 60/hour per IP.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE=text
if [[ "${1:-}" == "--json" ]]; then MODE=json; shift; fi
ID="${1:-${SYNC_ID:-}}"
if [[ -z "$ID" && -f .sync-id ]]; then ID="$(tr -d '[:space:]' < .sync-id)"; fi
if [[ "$ID" =~ ^fs:([a-z0-9-]+)/([0-9a-f]{32})$ ]]; then
  # Google sync: public-by-id shares/{id} doc over the Firestore REST API (no credential).
  FS="${FIRESTORE_API_BASE:-https://firestore.googleapis.com}"
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
  CODE=$(env -u GH_TOKEN -u GITHUB_TOKEN curl -sS -o "$TMP" -w '%{http_code}' --max-time 20 \
    "$FS/v1/projects/${BASH_REMATCH[1]}/databases/(default)/documents/shares/${BASH_REMATCH[2]}") || { echo "Couldn't reach Firestore." >&2; exit 3; }
  case "$CODE" in 200) ;; 404) echo "Plan link not found (wrong link, or Brayden hasn't synced yet)." >&2; exit 4 ;; 403) echo "Firestore refused the read (check the security rules)." >&2; exit 5 ;; *) echo "Firestore returned HTTP $CODE." >&2; exit 3 ;; esac
  python3 - "$TMP" > "$TMP.gist" <<'PY2'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8")).get("fields", {})
s = lambda k: (doc.get(k) or {}).get("stringValue")
summary = json.loads(s("summary") or "{}")
payload = {"updatedAt": (doc.get("updatedAt") or {}).get("timestampValue"), "summary": summary}
print(json.dumps({"files": {"study-buddy-sync.json": {"content": json.dumps(payload)}, "c202-plan.txt": {"content": s("plan") or ""}}}))
PY2
  mv "$TMP.gist" "$TMP"; FROM_FS=1
else
ID="${ID##*/}"; ID="${ID%%#*}"
if [[ ! "$ID" =~ ^[0-9a-fA-F]{20,40}$ ]]; then
  echo "No valid Sync ID. Pass it as an argument or save it in /workspace/flashcards/.sync-id" >&2
  echo "(Brayden can copy it from Study-Buddy-1000 > Sync > Sync ID)." >&2
  exit 2
fi
API="${GIST_API_BASE:-https://api.github.com}"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
CODE=$(env -u GH_TOKEN -u GITHUB_TOKEN curl -sS -o "$TMP" -w '%{http_code}' --max-time 20 \
  -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$API/gists/$ID") || { echo "Couldn't reach GitHub." >&2; exit 3; }
case "$CODE" in
  200) ;;
  404) echo "Sync gist $ID not found (wrong Sync ID, or it was deleted)." >&2; exit 4 ;;
  403|429) echo "GitHub rate limit for anonymous requests reached (60/hour). Try again later." >&2; exit 5 ;;
  *) echo "GitHub returned HTTP $CODE." >&2; exit 3 ;;
esac
fi
python3 - "$TMP" "$MODE" <<'PY'
import json, sys, urllib.request, datetime
path, mode = sys.argv[1:3]
g = json.load(open(path, encoding="utf-8"))
files = g.get("files") or {}
def content(name):
    f = files.get(name)
    if not f: return None
    if f.get("truncated") and f.get("raw_url"):
        with urllib.request.urlopen(f["raw_url"], timeout=20) as r: return r.read().decode("utf-8")
    return f.get("content")
raw = content("study-buddy-sync.json")
data = json.loads(raw) if raw else {}
summary = data.get("summary") or {}
if mode == "json":
    print(json.dumps({"updatedAt": data.get("updatedAt"), "summary": summary, "plan": content("c202-plan.txt")}, indent=2)); sys.exit(0)
def local(iso):
    if not iso: return "unknown"
    try:
        from zoneinfo import ZoneInfo
        d = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo("America/Denver"))
        return d.strftime("%a %b %-d, %-I:%M %p MT")
    except Exception: return iso
print(f"== Study-Buddy-1000 pacing plan (last synced {local(data.get('updatedAt'))}) ==")
print(content("c202-plan.txt") or "(no c202-plan.txt in the gist yet)")
print()
print("== Progress summary ==")
courses = summary.get("courses") or {}
if not courses: print("(no summary yet)")
for course, chapters in sorted(courses.items()):
    tc = sum(c.get("cards", 0) for c in chapters); tm = sum(c.get("mastered", 0) for c in chapters)
    passed = sum(1 for c in chapters if c.get("passed"))
    print(f"{course}: {tm}/{tc} cards mastered · {passed}/{len(chapters)} boss quizzes passed")
    for c in chapters:
        bits = [f"{c.get('mastered', 0)}/{c.get('cards', 0)} mastered"]
        if c.get("boss") is not None: bits.append(f"boss best {c['boss']}%" + (" passed" if c.get("passed") else ""))
        else: bits.append("boss not taken")
        if c.get("guide"): bits.append("guide read")
        elif c.get("guide") is False: bits.append("guide not read")
        if c.get("quiz") is not None: bits.append(f"quiz best {c['quiz']}%")
        label = f"Ch {c['ch']}" if c.get("ch") is not None else ""
        print(f"  {label:<6}{c.get('name', '')}: " + " · ".join(bits))
PY
