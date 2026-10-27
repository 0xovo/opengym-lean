# openGym (lean fork)

A fork of [openGym](https://github.com/DuarteSantos8/openGym) by DuarteSantos —
an open-source, local-first workout tracker that runs as a progressive web app
(PWA). Plan routines, log workouts, track bodyweight and measurements, and view
progress stats. In this build everything runs in your browser: no account, no
server, and your data stays on your device in local storage.

## What this fork changes

Relative to upstream, this fork trims the app down to the tracking essentials:

- **No gym check-in card** — the membership QR / check-in screen and its home
  card and settings toggle are removed.
- **No AI Coach** — the coach screens, the Coach button in Plan, and the coach
  settings are removed. (The coach code paths in the data layer are left in
  place but unreachable from the UI.)
- Otherwise the UI is upstream's: Home, Plan, Workout, Stats, History,
  Exercises, Measurements, Progress Photos, rest timer, and backup
  export/import in Settings.

## Layout

- `app/` — the web app (upstream's `frontend/`).
- `api/coach/core/` — a library the app imports at build time via a relative
  path (`../../../api/coach/core/...`). Keep this sibling layout or the build
  fails.

## Run locally

```sh
cd app
npm ci
VITE_DEMO=1 npm run build   # static demo build → app/dist/
```

Serve `app/dist/` with any static file server, or use `npm run dev` in `app/`
for development. The `VITE_DEMO=1` build boots in guest/demo mode with an
example profile; clear your browser's site data to reset it.

## Deploy your own

The build output is a static site, so any static host works. On Vercel, for
example: import the repository, set the root directory to `app`, build command
`VITE_DEMO=1 npm run build`, output directory `dist`. Note the `api/` sibling
must be present in the uploaded tree because of the build-time import above.

Data is local-first: it lives in the browser's local storage on each device
and does not sync between devices in this build. Use Settings → Data & backup
to export/import your data. Upstream openGym also offers an optional
self-hosted server mode (API + database, cross-device sync, passkey sign-in);
see the upstream repository if you want that instead.

## License & credit

Licensed under the GNU AGPL-3.0 — see `app/LICENSE`.

This is a fork of **openGym** by **DuarteSantos**:
https://github.com/DuarteSantos8/openGym (also mirrored at
https://gitea.com/DuarteSantos/openGym). All credit for the original app goes
to the upstream project; this fork only removes features.
