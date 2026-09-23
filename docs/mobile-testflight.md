# Internal TestFlight releases

Yakjev uses local Xcode archives and `asc` CLI 2.7, following the release approach in `../ripple`. The app connects to the existing production server; the owner token is entered on the phone and is never bundled in a release.

## Identity and prerequisites

| Setting           | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Bundle ID         | `engineer.castro.yakjev`                                      |
| Apple team        | `<APPLE_TEAM_ID>`                                                  |
| ASC CLI profile   | `<ASC_PROFILE>` (passed explicitly; default profile is not changed) |
| Signing identity  | Existing `iPhone Distribution: <SIGNING_NAME>`               |
| App Store profile | `<PROFILE_NAME>`                       |
| Internal group    | `Internal Testers`                                            |
| Owner invitation  | `<INVITE_EMAIL>`                                         |
| App icon          | `apps/mobile/assets/icon.png`, opaque 1024 × 1024             |

Use Bun 1.4.2, Xcode with the iOS SDK, CocoaPods, `asc`, `jq`, and Python 3.11 or newer. The distribution certificate and provisioning profile must already be installed. The release script does not create or revoke certificates, change keychain settings, or change the default ASC auth profile.

Apple's app record is separate from its bundle identifier. Create the iOS app record in App Store Connect once, using the bundle ID above, primary language English (U.S.), and SKU `yakjev-ios`. Browser/passkey login works for this step; the release script uses the existing API key through `asc` afterward. Set `APP_ID` to the numeric identifier returned by:

```sh
asc --profile '<ASC_PROFILE>' apps list --bundle-id engineer.castro.yakjev
```

## Archive and distribute

From the repository root, validate the source and select an unused build number:

```sh
bun install --frozen-lockfile
bun run verify
asc --profile '<ASC_PROFILE>' builds next-build-number --app "$APP_ID" --version 0.1.0 --platform IOS
bun run mobile:testflight --app-id "$APP_ID" --build-number 1
```

Replace `1` with the returned next number. `YAKJEV_IOS_BUILD_NUMBER` is consumed by Expo config and checked in the generated native project before archiving. The script exports with manual App Store signing, verifies the IPA's bundle/version, bundled JavaScript, icon, and native Metal shader, then uploads and waits for Apple's processing. It assigns that exact build to the internal group and invites the owner. External beta review and a public App Store release are separate actions.

To prepare a signed IPA without contacting the ASC API:

```sh
bun run mobile:testflight --build-only --build-number 1
```

Archives, IPAs, and release receipts live under ignored `apps/mobile/artifacts/testflight/`. Do not commit signing material or upload credentials.

## Resume after an interruption

Upload an already inspected IPA once:

```sh
bun run mobile:testflight --app-id "$APP_ID" --ipa apps/mobile/artifacts/testflight/build-1/yakjev.ipa
```

An upload-attempt receipt prevents automatic duplicate submission after a timeout or interruption. Inspect the exact version/build in ASC before retrying anything:

```sh
asc --profile '<ASC_PROFILE>' builds info --app "$APP_ID" --build-number 1 --version 0.1.0 --platform IOS
bun run mobile:testflight --app-id "$APP_ID" --distribute-build "$BUILD_ID"
```

`--distribute-build` resumes group assignment and invitation without uploading. It verifies that the build belongs to Yakjev; it never selects an unrelated latest build. An invitation failure remains an error even if the upload succeeded. Verify availability through `asc builds build-beta-detail view --build-id "$BUILD_ID"` and the owner's membership through `asc testflight testers list` before announcing that the app is downloadable.
