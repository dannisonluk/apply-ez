# Mobile app

Expo SDK 54, React Native 0.81. The app and the scraper share no runtime code — they
talk over Supabase's HTTP API — so `apps/mobile` is a separate npm install rather than
a pnpm workspace member. See [`../README.md`](../README.md#layout) for why.

## Running it

```bash
cd apps/mobile
npm install
cp .env.example .env          # fill in EXPO_PUBLIC_SUPABASE_URL + ..._ANON_KEY
npm start
```

The anon key is safe in the app bundle — it is public by design and every table it
can reach is guarded by RLS. The **service-role key must never appear here**; it
belongs only in the scraper's GitHub Actions secrets.

Push notifications need a development build (`npx expo run:android`), not Expo Go:
remote push was removed from Expo Go on Android in SDK 53. Registration fails soft
with an explanatory message, so the rest of the app works either way. Sending also
needs an EAS project id (`eas init`) because `getExpoPushTokenAsync` requires one.

### Building the Android APK

```bash
cd apps/mobile
npx eas-cli build --platform android --profile preview   # apk, sideloadable
```

`preview` and `development` produce an **apk**; `production` produces an aab. The
Supabase values the bundle needs are **EAS environment variables**, not `.env` —
`EXPO_PUBLIC_*` is inlined at build time and `.env` is gitignored, so a cloud build
relying on it would ship an app that boots straight into a configuration error.
`eas env:list --environment preview` shows what a build will actually see.

**Pin every `expo-*` package, including transitive ones.** A release APK that crashed
on launch was `expo-font@57.0.4` against `expo-modules-core@3.0.30`:
`NoSuchMethodError: getDirectConverter` in `FontLoaderModule`. Nothing about the build
looks wrong, which is what makes it worth recording:

- `expo@54.0.37` carries the correct `expo-font@14.0.12`, but **nested**;
- `@expo/vector-icons` declares a peer of `expo-font: ">=14.0.4"`;
- npm 7+ installs peer dependencies automatically, that open range matched the newest
  release, and 57.0.4 was **hoisted to the top level** — which is the copy autolinking
  picks, so the APK shipped a font module built against a core that does not exist in
  it.

`npx expo install --check` does **not** catch this. It only inspects direct
dependencies and answers "Dependencies are up to date" both before and after the fix.
`npm ls expo-font` is the check that shows it, and declaring `expo-font` directly is
the fix.

For an Android-only crash, reproduce it rather than reading the artifact: the manifest,
the ABI list and the native `.so` files all looked correct here.
`npx expo prebuild --platform android` then `./gradlew assembleRelease` gives an APK in
about a minute, and `adb logcat -d | grep -A 30 'FATAL EXCEPTION'` gives the answer.
`/android` is gitignored, so the prebuild does not dirty the tree.

### Building the APK locally, without the EAS queue

`eas build --local` **does not work on Windows at all** — the CLI refuses with
`Unsupported platform, macOS or Linux is required`, regardless of whether Docker is
running, because it checks the host OS rather than the container runtime. And a native
Windows build cannot work either: React Native's CMake step puts the absolute source
path inside the object-file path, so the root is counted twice and the longest path for
`safeareacontext` is **385 characters** against Windows' 260 limit. Even a zero-length
staging directory leaves it at 280, so shortening the project path does not rescue it
(`C://apply-ez` still lands at 283).

The way through is a Linux container, where the project is simply `/app`:

```bash
cd tools/local-android-build
docker build -t applyez-build:1 .              # node 20 + JDK 17, no SDK

# once: install a LINUX Android SDK into a volume
docker run --rm -v applyez-android-sdk:/opt/android-sdk \
  -v "$PWD/setup-sdk.sh:/setup-sdk.sh:ro" applyez-build:1 bash /setup-sdk.sh

# each build
docker run --rm -v applyez-android-sdk:/opt/android-sdk \
  -v "<repo>/apps/mobile:/app" -v applyez-gradle:/root/.gradle \
  -v "$PWD/build-apk.sh:/build-apk.sh:ro" \
  -e EXPO_PUBLIC_SUPABASE_URL=... -e EXPO_PUBLIC_SUPABASE_ANON_KEY=... \
  applyez-build:1 bash /build-apk.sh
```

The APK lands in `apps/mobile/android/app/build/outputs/apk/release/`. A cold build
takes about 12 minutes; the SDK and Gradle caches live in volumes, so it is paid once.

Three things that cost time to discover:

- **The host Android SDK is unusable.** It is a Windows install, so build-tools holds
  only `aapt.exe`/`d8.bat` and the NDK ships only
  `toolchains/llvm/prebuilt/windows-x86_64`. Mounted into Linux, AGP finds no `aapt`
  and reports build-tools as *corrupted*, which reads like a broken SDK install rather
  than a platform mismatch.
- **The Windows `node_modules` does work** under Linux — `sdks/hermesc/linux64-bin` is
  present and every package resolves — so `npm ci` is not needed.
- **Git Bash rewrites `-w /app`** into a Windows path and Docker rejects it. Set
  `MSYS_NO_PATHCONV=1`, or rely on `WORKDIR` in the Dockerfile as this one does.
  `-v "...:/app"` is unaffected, which makes the failure look arbitrary.

The result is signed with the **debug keystore**, because `expo prebuild` configures the
release build type that way. It installs fine, but not over an EAS-signed build —
uninstall first. For a shareable artifact, use EAS.

## Sending a notification

The scraper sends them (see [`OPERATIONS.md`](OPERATIONS.md#push-notifications)); this
app only registers a token and routes a tap.

The token write goes through `register_push_token` / `disable_push_token` rather than
writing the table. A direct upsert cannot work: `ON CONFLICT DO UPDATE` has to see the
existing row, and `anon` has no `SELECT` on `push_tokens` by design, so Postgres rejects
it with an RLS error that names the *INSERT* policy — which exists and is correct.
`PATCH ?token=eq.…` fails the same way and is worse: it matches zero rows and answers
`204`, so turning notifications off looked like it worked while the row stayed
`enabled = true`. See `supabase/migrations/0006_push_token_rpc.sql`.
