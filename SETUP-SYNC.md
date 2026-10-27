# Optional sync: Firestore + passkey (bring your own Firebase)

The app works fully offline and local-only out of the box. This optional mode adds
**cross-device sync + passkey sign-in**, using **your own** free Firebase project and
**your own** Vercel project. There is no shared backend: your data lives in a Firebase
project only you control, and nobody else ever sees it. Total cost: **$0** (Firebase
Spark free plan + Vercel free tier). No credit card, no Blaze upgrade. If any screen
asks for billing, you're on the wrong screen.

**The shape of it:** the app is served by a Vercel project (the `sync-server/` folder is
its deploy root). Firestore holds your data. Four tiny serverless functions in that same
project run the passkey ceremony, Firebase Auth has no built-in passkey sign-in, and
hand your browser a login token.

---

## Part 1: Firebase console (https://console.firebase.google.com)

1. **Create the project.** "Add project" → name it anything (e.g. `opengym-sync`) →
   continue. Google Analytics: turn it **off** (not needed) → Create project.
2. **Add the web app.** On the project home, click the web icon `</>`. App nickname:
   anything (e.g. `opengym-web`). Leave "Firebase Hosting" **unticked**. Register app.
   You'll see a `firebaseConfig` block: **keep this tab open**, you need those values in
   Part 3 (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`,
   `appId`).
3. **Turn on Firestore.** Left menu: Build → Firestore Database → "Create database" →
   **Start in production mode** → pick a location (you can't change it later, either
   offered region is fine) → Enable.
4. **Turn on Authentication.** Left menu: Build → Authentication → "Get started". You
   don't need to enable any sign-in provider in the list, the app signs in with custom
   tokens minted by the passkey functions. Just visiting this once creates what we need.
5. **Make the service account key** (this is what lets the Vercel functions verify
   passkeys and mint login tokens):
   - Top-left gear → Project settings → **Service accounts** tab.
   - Click **Generate new private key** → Generate key. A `.json` file downloads.
   - That file is a master key to your project. Don't share it, don't put it in any
     repo or chat, you'll paste it once into Vercel in Part 2 and can then delete the
     download.

## Part 2: Vercel project + env vars

Create a Vercel project whose root is this repo's **`sync-server/`** folder (import the
repo and set Root Directory to `sync-server`, or run `npx vercel deploy --prod` from
inside `sync-server/` once everything below is in place). Note the project's domain
(e.g. `your-app.vercel.app`), you need it for the passkey settings.

In the project → Settings → Environment Variables, add for **Production**:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The **entire contents** of the JSON file from Part 1 step 5, pasted as one value |
| `WEBAUTHN_RP_ID` | Your Vercel domain, bare host (e.g. `your-app.vercel.app`) |
| `WEBAUTHN_ORIGIN` | The full origin (e.g. `https://your-app.vercel.app`) |

`WEBAUTHN_RP_NAME` is optional (defaults to `openGym`). Passkeys are locked to this
domain, they are registered against `WEBAUTHN_RP_ID`, so set it to the domain you will
actually open the app on, and don't change it afterwards without re-registering.
All the variables are also listed in `sync-server/.env.example`.

## Part 3: Build + deploy

1. Build the app with Firebase mode on, using the `firebaseConfig` values from Part 1
   step 2 (they're **not** secret: they just name your project; Firestore rules guard
   the data):

   ```sh
   cd app
   npm ci
   VITE_FIREBASE=1 VITE_FB_API_KEY=… VITE_FB_AUTH_DOMAIN=… VITE_FB_PROJECT_ID=… \
   VITE_FB_STORAGE_BUCKET=… VITE_FB_MESSAGING_SENDER_ID=… VITE_FB_APP_ID=… \
   npm run build
   ```

   (`app/.env.example` lists the same variables if you prefer a local `.env` file.
   Without them the build is the plain local-only version.)
2. Copy the build into the deploy root: `cd ../sync-server && node scripts/copy-dist.mjs`
3. Install the functions' deps: `npm install` (inside `sync-server/`).
4. Deploy the Firestore rules from the repo root:
   `npx firebase-tools deploy --only firestore:rules`
   (one-time `npx firebase-tools login` first; or paste `firestore.rules` into
   Firebase console → Firestore Database → Rules → Publish, same thing, no CLI needed).
5. Deploy: `npx vercel deploy --prod` from `sync-server/`. If Vercel asks about SSO /
   deployment protection, disable it for this project so the URL opens without a
   Vercel login.

## Part 4: First sign-in

1. Open your Vercel URL (e.g. `https://your-app.vercel.app`).
2. Pick a **username** → **Create account with passkey** → confirm with Face ID /
   fingerprint / device PIN.
3. Done: you're signed in, and whatever is in the app on that device uploads as the
   starting cloud copy.
4. On your second device: same URL, same username, **Sign in with passkey**. Your plan
   and history arrive; from then on all your devices stay in sync live.
5. Later, to add a passkey on another device: sign in there, then Settings → Account →
   "Add a passkey on this device".

## One honest warning about the trust model

There are no passwords and no invite codes in this setup. The rule is: **whoever first
registers a passkey for a username owns that username**, after that, new passkeys can
only be added while signed in. This is a personal / small-scale setup: register your
username in Part 4 as soon as it deploys, before sharing your URL with anyone. If
someone did beat you to your name, the fix is Firebase console → Firestore Database →
delete the `passkeyUsers` / `passkeys` entries and register again.

Data layout, for the curious: Firestore → `users/{your-uid}` (settings/plan doc) with
`workouts`, `routines`, `exercises`, `bodyweight`, `measurements` subcollections, one
document per item. Passkey material lives in separate collections the app itself can
never read (rules deny it): only the Vercel functions can.
