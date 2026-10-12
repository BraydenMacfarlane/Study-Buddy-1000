#!/usr/bin/env bash
# One-time Firebase setup for Study-Buddy-1000 Google sign-in sync. Run AFTER Brayden has signed the
# Firebase CLI in once:   firebase login --no-localhost
#
#   tools/firebase-setup.sh [PROJECT_ID]          # default: study-buddy-1000, then -sb1 / -sb2 ... if taken
#   tools/firebase-setup.sh PROJECT_ID --hosting  # also deploy docs/ to https://PROJECT_ID.firebaseapp.com
#
# Idempotent: re-running skips anything that already exists. It does not push to GitHub.
# Creates: the Firebase project (Spark / free), a Web app + firebase/config.json, the Firestore
# (default) database in nam5 (production mode = our rules), deploys firestore.rules, enables the
# Google provider, and adds braydenmacfarlane.github.io to Auth's authorized domains.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$(npm prefix -g 2>/dev/null)/bin:$PATH"
command -v firebase >/dev/null || { echo "firebase CLI missing: npm i -g firebase-tools" >&2; exit 2; }
WANT="${1:-study-buddy-1000}"; HOSTING=0
[[ "${2:-}" == "--hosting" || "${1:-}" == "--hosting" ]] && HOSTING=1
[[ "$WANT" == "--hosting" ]] && WANT=study-buddy-1000
PAGES_DOMAIN="braydenmacfarlane.github.io"

EMAIL="$(firebase login:list 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1 || true)"
[[ -n "$EMAIL" ]] || { echo "Not signed in. Ask Brayden to run: firebase login --no-localhost" >&2; exit 3; }
echo "Signed in to the Firebase CLI as $EMAIL"

json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
mine="$(firebase projects:list --json 2>/dev/null | json 'print("\n".join(p["projectId"] for p in d.get("result",[])))' || true)"
PROJECT=""
for cand in "$WANT" "$WANT-sb1" "$WANT-sb2" "$WANT-sb3"; do
  if grep -qx "$cand" <<<"$mine"; then PROJECT="$cand"; echo "Project $PROJECT already exists"; break; fi
done
if [[ -z "$PROJECT" ]]; then
  for cand in "$WANT" "$WANT-sb1" "$WANT-sb2" "$WANT-sb3"; do
    echo "Creating project $cand ..."
    if firebase projects:create "$cand" --display-name "Study-Buddy-1000"; then PROJECT="$cand"; break; fi
    if grep -q "Callers must accept Terms of Service" firebase-debug.log 2>/dev/null; then
      echo "Google Cloud Terms of Service not accepted yet for $EMAIL." >&2
      echo "Open https://console.cloud.google.com/ signed in as $EMAIL, accept the Terms of Service, then re-run." >&2
      exit 4
    fi
    echo "  (could not create $cand; trying the next id)"
  done
fi
[[ -n "$PROJECT" ]] || { echo "Project creation failed. If it mentions Terms of Service, open https://console.firebase.google.com once, accept, and re-run." >&2; exit 4; }
printf '{ "projects": { "default": "%s" } }\n' "$PROJECT" > .firebaserc

APPID="$(firebase apps:list WEB --project "$PROJECT" --json 2>/dev/null | json 'r=[a for a in d.get("result",[]) if a.get("displayName")=="Study-Buddy-1000"]; print(r[0]["appId"] if r else "")' || true)"
if [[ -z "$APPID" ]]; then
  echo "Creating the Web app ..."
  APPID="$(firebase apps:create WEB "Study-Buddy-1000" --project "$PROJECT" --json | json 'print(d["result"]["appId"])')"
fi
echo "Web app: $APPID"
firebase apps:sdkconfig WEB "$APPID" --project "$PROJECT" --json | json 'c=d["result"].get("sdkConfig") or d["result"]; print(json.dumps({k:c[k] for k in ("apiKey","authDomain","projectId","appId","messagingSenderId","storageBucket") if c.get(k)}, indent=2))' > firebase/config.json
echo "Wrote firebase/config.json (public web config, safe to commit)"

if firebase firestore:databases:list --project "$PROJECT" --json 2>/dev/null | grep -q '(default)'; then
  echo "Firestore (default) database already exists"
else
  echo "Creating Firestore (default) in nam5 ..."
  firebase firestore:databases:create "(default)" --location nam5 --project "$PROJECT"
fi

# Enable the Google provider (firebase.json "auth" section; support email = the signed-in account).
python3 - "$EMAIL" <<'PY'
import json, sys
cfg = json.load(open("firebase.json"))
cfg["auth"] = {"providers": {"googleSignIn": {"oAuthBrandDisplayName": "Study-Buddy-1000", "supportEmail": sys.argv[1]}}}
json.dump(cfg, open("firebase.json", "w"), indent=2); open("firebase.json", "a").write("\n")
PY
TARGETS="firestore:rules,auth"; [[ $HOSTING == 1 ]] && { ./build.sh >/dev/null && cp dist/flashcards.html docs/index.html; TARGETS="$TARGETS,hosting"; }
echo "Deploying $TARGETS ..."
firebase deploy --only "$TARGETS" --project "$PROJECT" --non-interactive

echo "Adding $PAGES_DOMAIN to authorized domains ..."
if ! node tools/firebase-auth-domains.js "$PROJECT" "$PAGES_DOMAIN"; then
  echo "  Couldn't add it automatically. Console: https://console.firebase.google.com/project/$PROJECT/authentication/settings -> Authorized domains -> Add domain -> $PAGES_DOMAIN"
fi

./build.sh | tail -2
echo
echo "Done. Next: verify sign-in at https://$PROJECT.firebaseapp.com/ (if --hosting) and, after pushing, on https://$PAGES_DOMAIN/Study-Buddy-1000/"
echo "Console check: https://console.firebase.google.com/project/$PROJECT/authentication/providers (Google should be Enabled)"
