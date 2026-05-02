# Android Setup

This folder contains the Android setup for `formstr-drive` using Capacitor.

## From the Repo Root

Install dependencies:

```bash
pnpm install
```

Build the web app and sync it into Android:

```bash
pnpm android:sync
```

Open the Android project in Android Studio:

```bash
pnpm android:open
```

## What Is Done

- Capacitor is added to the repo
- The Android project is generated and tracked
- The Android shell can launch the app
- The web app build is used inside the Android shell
- Android sign-in is currently shown as not available yet

## Current Limitations

- Final launcher icon and splash branding is not added yet