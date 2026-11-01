# opengym-lean

A leaner fork of [openGym](https://github.com/DuarteSantos8/openGym). Same workout tracker, less of everything else.

**Live: [opengym-lean.vercel.app](https://opengym-lean.vercel.app)**

<table align="center">
<tr>
<td align="center"><img src="assets/screenshots/home.png" alt="Home screen" width="230"><br><sub><b>Home</b> · today and the week at a glance</sub></td>
<td align="center"><img src="assets/screenshots/workout.png" alt="Workout screen" width="230"><br><sub><b>Guided workout</b> · sets, reps and progression</sub></td>
<td align="center"><img src="assets/screenshots/stats.png" alt="Stats screen" width="230"><br><sub><b>Stats</b> · activity heatmap and muscle balance</sub></td>
</tr>
</table>

This is my own project built on top of openGym. It is not part of the upstream app and it is not the official version. I liked openGym, so I stripped it down to the parts I actually use and made it plug and play: open it and train. No server, no account, no setup. If you want your data synced across devices, you can link your own Firebase project with a short guided setup.

## Use it

**Just open it.** Go to the live site, add it to your home screen, and train. Everything runs in your browser, your data stays in your browser, and it starts empty, with none of the demo data the original ships.

**Or sync it.** Follow [SETUP-SYNC.md](SETUP-SYNC.md) to connect your own free Firebase project and deploy the small sync backend to Vercel. Sign in with a passkey or with Google, and your plans and history follow you between phone and laptop. Your data lives in your Firebase project, under your account, not on anyone else's server.

## What I removed

- The gym check-in card and its QR code flow.
- The AI Coach screens and settings.
- The admin dashboard and the first-launch onboarding screens.
- Photos and videos attached to finished workouts.
- The Docker self-hosting stack, and the demo data. This fork starts empty.
- Dead weight in general: a Settings row offering an Android APK this fork does not ship, glow and ping effects on buttons, and copy that promised things a web app cannot do.

## What I added

- Optional sync with your own Firebase project, free tier is enough, with passkey sign-in and Google sign-in.
- A Sign-in methods card in Settings: link a Google account, add or remove a passkey, with a guard so you can never remove your last way in.
- Rest timer alerts that work with no server: a notification on the device when a rest ends. With an optional free QStash account, the alert can also be booked ahead and pushed to your locked phone, see the QStash section of [SETUP-SYNC.md](SETUP-SYNC.md).

## What stayed the same

Workout logging, routines and weekly plans, stats, history, the exercise library, measurements, progress photos, and backup export and import. The app itself is Duarte Santos's openGym and full credit stays with him. This fork is AGPL-3.0 like the original, see [NOTICE.md](NOTICE.md).

## Support

If this fork saved you a subscription, you can buy me a coffee: [ko-fi.com/0xovo](https://ko-fi.com/0xovo). Updates land on X first: [@0xovoo](https://x.com/0xovoo).
