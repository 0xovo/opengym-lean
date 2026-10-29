# Option 2: Sync across your devices (your own Firestore + Vercel)

This is the setup guide for **Option 2**. Option 1 (local only) needs no setup at
all: deploy the static app anywhere and use it, data stays in the browser.

Option 2 adds **cross-device sync and passkey sign-in**, using **your own** free
Firebase project and **your own** Vercel project. There is no shared backend: your
data lives in a Firebase project only you control, and nobody else ever sees it.
Total cost: **$0** (Firebase Spark free plan plus Vercel free tier). No credit card,
no Blaze upgrade. If any screen asks for billing, you are on the wrong screen.

**The shape of it:** a Vercel project serves the app (the `sync-server/` folder of
this repo is its deploy root) and runs four tiny serverless functions for the
passkey ceremony, because Firebase Auth has no built-in passkey sign-in. Firestore
holds your data, and its security rules are what guard it.

**The plan:** Part 1 in the Firebase console (about ten minutes of clicking),
Part 2 is one button click in Vercel, Part 3 publishes the data rules, Part 4 is
your first sign-in. Do them in order.

---

## Part 1: Firebase console (https://console.firebase.google.com)

1. **Create the project.** Click "Add project", name it anything (for example
   `opengym-sync`), continue. Turn Google Analytics **off** (not needed), then
   Create project.
2. **Add the web app.** On the project home, click the web icon `</>`. App
   nickname: anything (for example `opengym-web`). Leave "Firebase Hosting"
   **unticked**. Click Register app. You now see a `firebaseConfig` block with
   values like `apiKey`, `projectId` and `appId`: keep this tab open, you paste
   three of them into Vercel in Part 2.
3. **Turn on Firestore.** Left menu: Build, then Firestore Database, then "Create
   database". Choose **Start in production mode**, pick a location (you cannot
   change it later, either offered region is fine), then Enable. Do not pick
   test mode here: test mode looks like it works, but its rules stay open only
   until a date about 30 days out, and after that date Firestore denies
   everything and sync quietly stops. Production mode plus the rules you
   publish in Part 3 is the setup that keeps working.
4. **Turn on Authentication.** Left menu: Build, then Authentication, then "Get
   started". You do not need to enable any sign-in provider in the list: the app
   signs in with custom tokens minted by the passkey functions. Just visiting
   this page once creates what we need.
5. **Make the service account key.** This is what lets the Vercel functions verify
   passkeys and mint login tokens. Top-left gear, Project settings, **Service
   accounts** tab, **Generate new private key**, Generate key. A `.json` file
   downloads. That file is a master key to your project: do not share it, do not
   put it in any repo or chat. You paste it once into Vercel in Part 2 and can
   then delete the download.

You now have everything Part 2 asks for. The full list, with placeholders:

```
FIREBASE_SERVICE_ACCOUNT=  the entire contents of the .json file from step 5, as one value
VITE_FB_API_KEY=           apiKey from the firebaseConfig block in step 2
VITE_FB_PROJECT_ID=        projectId from the firebaseConfig block in step 2
VITE_FB_APP_ID=            appId from the firebaseConfig block in step 2
WEBAUTHN_RP_ID=            your Vercel domain as a bare host, set in Part 2
WEBAUTHN_ORIGIN=           the same domain with https:// in front, set in Part 2
```

The `VITE_FB_*` values are **not** secret: they just name your project. The
service account JSON is the only secret, and it only ever goes into Vercel.

## Part 2: Deploy to Vercel (one click)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2F0xovo%2Fopengym-lean&project-name=opengym-lean&repository-name=opengym-lean&root-directory=sync-server&env=FIREBASE_SERVICE_ACCOUNT%2CWEBAUTHN_RP_ID%2CWEBAUTHN_ORIGIN%2CVITE_FB_API_KEY%2CVITE_FB_PROJECT_ID%2CVITE_FB_APP_ID&envDescription=All+values+come+from+your+own+Firebase+project+%28SETUP-SYNC.md%2C+Part+1%29.+FIREBASE_SERVICE_ACCOUNT+is+the+service+account+JSON+pasted+as+one+value.+WEBAUTHN_RP_ID+is+your+Vercel+domain+as+a+bare+host+%28your-project.vercel.app%29+and+WEBAUTHN_ORIGIN+is+the+same+domain+with+https%3A%2F%2F+in+front.+VITE_FB_API_KEY%2C+VITE_FB_PROJECT_ID+and+VITE_FB_APP_ID+come+from+the+firebaseConfig+block+of+your+web+app.&envLink=https%3A%2F%2Fgithub.com%2F0xovo%2Fopengym-lean%2Fblob%2Fmain%2FSETUP-SYNC.md)

1. Click the button and sign in to Vercel if asked. It clones this repo to your
   Git account and creates a project with the root directory already set to
   `sync-server`.
2. **Project name:** the name you pick becomes your domain. If you keep
   `opengym-lean`, your app will live at `opengym-lean.vercel.app` (if that name
   is taken, Vercel adjusts it, note the real domain for the next step).
3. **Environment variables:** the form asks for the six variables from Part 1.
   Paste the service account JSON and the three `VITE_FB_*` values as copied. For
   the last two, use the domain from step 2: `WEBAUTHN_RP_ID` is the bare host
   (for example `opengym-lean.vercel.app`), `WEBAUTHN_ORIGIN` is the same with
   `https://` in front (for example `https://opengym-lean.vercel.app`).
4. Click Deploy and wait for the build. The build checks the variables first
   (and stops with a plain message if one is missing), builds the app with sync
   switched on, and serves it together with the passkey functions. If Vercel
   later asks about deployment protection or SSO, turn it off for this project
   so the URL opens without a Vercel login.
5. If the final domain is not the one you put in the two `WEBAUTHN_*` values,
   fix them under Project, Settings, Environment Variables, then redeploy from
   the Deployments tab. Passkeys are registered against this domain and will not
   work on any other.

Manual alternative to the button: import the repo in Vercel yourself, set Root
Directory to `sync-server`, add the same six variables, and deploy. Same result.

## Part 3: Publish the Firestore rules

The rules in `firestore.rules` (repo root) are what keep every user's data
private: a signed-in user can only touch their own documents, and the passkey
collections are closed to the app entirely. Publish them once:

```sh
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID
```

Run from the repo root (that is where `firebase.json` and `firestore.rules`
live), and replace `YOUR_PROJECT_ID` with your `projectId` from Part 1.

No CLI? Same thing in the console: Firebase console, Firestore Database, Rules
tab, paste the contents of `firestore.rules`, Publish.

## Part 4: First sign-in

1. Open your Vercel URL (for example `https://opengym-lean.vercel.app`).
2. Pick a **username**, then **Create account with passkey**, and confirm with
   Face ID, fingerprint or device PIN.
3. Done: you are signed in, and whatever is in the app on that device uploads as
   the starting cloud copy.
4. On your second device: same URL, same username, **Sign in with passkey**.
   Your plan and history arrive, and from then on all your devices stay in sync
   live.
5. Later, to add a passkey on another device: sign in there first, then
   Settings, Account, "Add a passkey on this device".

## Check it worked

- The Vercel URL opens the app directly, with no Vercel login screen in front.
- Settings, Account shows a passkey sign-in card. That card only exists in the
  sync build, so if you see it, the build picked up your variables.
- Log a workout on one device, sign in on a second device with the same
  username and passkey, and the workout is there.
- Firebase console, Firestore Database shows your data appearing under `users`,
  and your account under `passkeyUsers` and `passkeys`.
- If sign-in fails with an origin or RP error, the two `WEBAUTHN_*` values do
  not match the domain in the address bar. Fix them in the Vercel project
  settings and redeploy.
- If sign-in works but your data never shows on the second device, the usual
  cause is the Firestore rules: either Part 3 was skipped, or the database
  was created in test mode and its roughly 30 days ran out. The tell-tale
  sign is in the browser developer tools console on the signed-in device: a
  Firestore error reading "Missing or insufficient permissions". The fix is
  to publish the rules from Part 3.

## Optional: rest alerts with the phone locked (QStash)

By default the rest timer announces itself locally: a notification when a
rest ends while the app is open or still alive, and a catch-up alert when you
come back to the app after the end has passed. What a web app cannot do on
its own is fire at an exact moment once the phone has locked and the system
has suspended it. For that, the end has to be booked with something that can
wake up on schedule and send a real Web Push.

That something is Upstash QStash, a free scheduling service. With it set up,
starting a rest also books the end with QStash. At the end, QStash calls a
function in your own Vercel project, and that function sends the push to the
phone that started the rest. Pausing or skipping cancels the booking, and
extending the rest re-books it. The free QStash tier, about 1,000 messages a
day, is far more than a rest timer needs. And none of this is required:
without it, everything works exactly as before, with the local alert.

Setup, once Parts 1 to 4 are working:

1. **Create a free Upstash account** at https://upstash.com, then open the
   QStash console.
2. **Generate a VAPID key pair** (the key pair that signs the pushes). In a
   terminal: `npx web-push generate-vapid-keys`. It prints a public key and
   a private key. Treat the private key like the service account: never in a
   repo, never shared.
3. **Add five environment variables** in your Vercel project (Settings,
   Environment Variables, Production):
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, from step 2.
   - `QSTASH_TOKEN`, the token shown in the QStash console.
   - `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`, the two
     signing keys shown in the QStash console. They are how your function
     knows a call at the rest's end really came from QStash.
4. **Redeploy** (Deployments tab, Redeploy) so the functions pick the values
   up. The build log warns about any of the five that are missing, but the
   build succeeds either way.
5. **Subscribe the phone.** Open the app from your Home Screen icon (on iOS,
   web push needs the installed app and iOS 16.4 or later), sign in, then
   Settings, Notifications, and turn them on. That subscribes this phone.
   Each device subscribes itself the same way, and a rest alerts the device
   that started it.

## One honest warning about the trust model

There are no passwords and no invite codes in this setup. The rule is: **whoever
first registers a passkey for a username owns that username**, and after that,
new passkeys can only be added while signed in. This is a personal, small-scale
setup: register your username in Part 4 as soon as it deploys, before sharing
your URL with anyone. If someone did beat you to your name, the fix is Firebase
console, Firestore Database, delete the `passkeyUsers` and `passkeys` entries
for that name, and register again.

Data layout, for the curious: Firestore, `users/{your-uid}` (settings and plan
doc) with `workouts`, `routines`, `exercises`, `bodyweight` and `measurements`
subcollections, one document per item. Passkey material lives in separate
collections the app itself can never read (the rules deny it): only the Vercel
functions can.
