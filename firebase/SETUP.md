# Google sign-in sync: one-time Firebase setup

Everything is on the free Spark plan. Nothing here is live until `firebase/config.json` exists, the app
is rebuilt (`./build.sh` bakes it in), and the build is published.

## What gets created
| Item | How | Notes |
|---|---|---|
| Firebase project `study-buddy-1000` (falls back to `-sb1`, `-sb2` if the id is taken) | CLI `projects:create` | First-ever Firebase use on the account may require accepting the Terms once in the console |
| Web app "Study-Buddy-1000" + `firebase/config.json` | CLI `apps:create`, `apps:sdkconfig` | Web config is public by design; safe to commit |
| Firestore `(default)` in `nam5`, production mode | CLI `firestore:databases:create` | Closed by default; our rules then apply |
| Security rules `firebase/firestore.rules` | CLI `deploy --only firestore:rules` | `users/{uid}`: owner only. `shares/{32-hex id}`: get-by-id only (plan + summary for Study Buddy), owner-only writes, never listable |
| Google sign-in provider | CLI `deploy --only auth` (firebase.json `auth.providers.googleSignIn`) | Console fallback: Authentication → Sign-in method → Google → Enable |
| Authorized domain `braydenmacfarlane.github.io` | `tools/firebase-auth-domains.js` (uses the CLI's login) | Console fallback: Authentication → Settings → Authorized domains → Add |
| Optional: Firebase Hosting copy at `https://<project>.firebaseapp.com/` | `tools/firebase-setup.sh <project> --hosting` | Best URL for the iPhone home-screen app (same origin as the auth handler) |

## Steps
1. On the box: `firebase login --no-localhost` (Brayden opens the printed link, signs in with his Google account, pastes the code back).
2. `tools/firebase-setup.sh` (add `--hosting` to also publish the Firebase Hosting copy).
3. Commit `firebase/config.json`, `.firebaserc`, `firebase.json`; push to publish the GitHub Pages build.
