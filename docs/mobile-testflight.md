# Internal TestFlight releases

Yakjev uses local Xcode archives and `asc` CLI 2.7, following the release approach in `../ripple`. The app connects to the server in `YAKJEV_SERVER_URL`; the owner token is entered on the phone and is never bundled in a release.

## Identity and prerequisites

| Setting        | Value                                             |
| -------------- | ------------------------------------------------- |
| ASC app ID     | `APP_ID` in the private release environment       |
| Bundle ID      | `engineer.castro.yakjev`                          |
| Internal group | `Internal Testers`                                |
| App icon       | `apps/mobile/assets/icon.png`, opaque 1024 × 1024 |

Use Bun 1.4.2, Xcode with the iOS SDK, CocoaPods, `asc`, `jq`, and Python 3.11 or newer. The distribution certificate and provisioning profile must already be installed. The release script does not create or revoke certificates, change keychain settings, or change the default ASC auth profile.

The Yakjev app record (`https://appstoreconnect.apple.com/apps/$APP_ID/distribution`) exists with primary language English (U.S.) and SKU `yakjev-ios`. Uploads and TestFlight distribution use a locally configured ASC API profile. Management access remains with the account owner.

## Private release configuration

Signing account, team, profile, identity, and tester settings have no defaults in public source. Store shell variable assignments in ignored `.local/mobile-release.env`, or set `YAKJEV_RELEASE_ENV_FILE` to another private file. Keep this file accessible only to the release operator and never commit it. The wrapper loads it automatically; command-line flags override its values. Exported environment variables can be used when no local file is present.

Populate these variables with the existing local account and signing configuration:

```sh
ASC_PROFILE=
YAKJEV_APPLE_TEAM_ID=
PROFILE_NAME=
CODE_SIGN_IDENTITY=
INVITE_EMAIL=
APP_ID=
YAKJEV_SERVER_URL=
```

`YAKJEV_SERVER_URL` is the tailnet server origin the app opens, required when archiving. The IPA check fails unless the archive embeds it.

`ASC_PROFILE` is always required and passed explicitly to the CLI. The team, provisioning profile name, and code-signing identity are required only when archiving. Uploading an existing IPA or distributing an existing build does not need signing settings. `INVITE_EMAIL` is required only when inviting a tester; `--no-invite` omits that step. No credentials belong in this file beyond the local profile references; keep authentication material in the existing ASC credential store/keychain.

Before running manual ASC commands from the repository root, load the same private configuration:

```sh
set -a
. "${YAKJEV_RELEASE_ENV_FILE:-.local/mobile-release.env}"
set +a
asc --profile "$ASC_PROFILE" apps list --bundle-id engineer.castro.yakjev
```

## Archive and distribute

From the repository root, validate the source and select an unused build number:

```sh
bun install --frozen-lockfile
bun run verify
asc --profile "$ASC_PROFILE" builds next-build-number --app "$APP_ID" --version 0.1.0 --platform IOS
bun run mobile:testflight --app-id "$APP_ID" --build-number 1
```

Replace `1` with the returned next number. `YAKJEV_IOS_BUILD_NUMBER` is consumed by Expo config and checked in the generated native project before archiving. `YAKJEV_APPLE_TEAM_ID` supplies the signing team to Expo and Xcode without a source default. The script exports with manual App Store signing, verifies the IPA's bundle/version, bundled JavaScript, icon, and native Metal shader, then uploads and waits for Apple's processing. It assigns that exact build to the internal group and invites the configured tester. External beta review and a public App Store release are separate actions.

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
asc --profile "$ASC_PROFILE" builds info --app "$APP_ID" --build-number 1 --version 0.1.0 --platform IOS
bun run mobile:testflight --app-id "$APP_ID" --distribute-build "$BUILD_ID"
```

`--distribute-build` resumes group assignment and invitation without uploading. It verifies that the build belongs to Yakjev; it never selects an unrelated latest build. An invitation failure remains an error even if the upload succeeded. Verify availability through `asc --profile "$ASC_PROFILE" builds build-beta-detail view --build-id "$BUILD_ID"` and the configured tester's membership through `asc --profile "$ASC_PROFILE" testflight testers list` before announcing that the app is downloadable.
