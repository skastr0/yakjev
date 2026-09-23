#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_ID="${APP_ID:-}"
ASC_PROFILE="${ASC_PROFILE:-<ASC_PROFILE>}"
TEAM_ID="${TEAM_ID:-<APPLE_TEAM_ID>}"
BUNDLE_ID="engineer.castro.yakjev"
PROFILE_NAME="${PROFILE_NAME:-<PROFILE_NAME>}"
CODE_SIGN_IDENTITY="${CODE_SIGN_IDENTITY:-iPhone Distribution}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$MOBILE_DIR/artifacts/testflight}"
GROUP_NAME="${GROUP_NAME:-Internal Testers}"
GROUP_ID="${GROUP_ID:-}"
INVITE_EMAIL="${INVITE_EMAIL:-<INVITE_EMAIL>}"
BUILD_NUMBER="${YAKJEV_IOS_BUILD_NUMBER:-}"
BUILD_ONLY=0
IPA_PATH=""
BUILD_ID=""
SEND_INVITE=1

usage() {
  cat <<'EOF'
Usage: scripts/release-testflight-internal.sh [options]

Archive Yakjev locally, export its IPA, upload to TestFlight, and invite the
owner to the internal group. Uses ASC 2.7 with an explicit auth profile.
Signing identity/profile must already be installed. App creation is separate.

Options:
  --app-id ID              ASC app ID (or APP_ID environment variable)
  --build-number NUMBER    Required when archiving (or YAKJEV_IOS_BUILD_NUMBER)
  --build-only             Archive/export only; no Apple API calls or app ID needed
  --ipa PATH               Verify/upload an existing IPA; skip archive/export
  --distribute-build ID    Distribute this exact processed build; never upload
  --group-id ID            Existing internal TestFlight group
  --invite-email EMAIL     Tester to invite (default: <INVITE_EMAIL>)
  --no-invite              Assign build to group without inviting a tester
  -h, --help               Show help without changing anything

Environment: APP_ID, ASC_PROFILE (default: <ASC_PROFILE>), TEAM_ID, PROFILE_NAME,
CODE_SIGN_IDENTITY, ARTIFACTS_DIR, GROUP_NAME, GROUP_ID, INVITE_EMAIL,
YAKJEV_IOS_BUILD_NUMBER.

Choose the next number before archiving:
  asc --profile '<ASC_PROFILE>' builds next-build-number --app APP_ID --platform IOS

Examples (run from apps/mobile):
  scripts/release-testflight-internal.sh --build-only --build-number 1
  scripts/release-testflight-internal.sh --app-id APP_ID --build-number 2
  scripts/release-testflight-internal.sh --app-id APP_ID --ipa artifacts/testflight/build-1/yakjev.ipa
  scripts/release-testflight-internal.sh --app-id APP_ID --distribute-build BUILD_ID

An upload attempt is recorded before contacting Apple. If upload fails or is
interrupted, inspect ASC builds/uploads and resume with --distribute-build ID.
The script will not retry an uncertain upload or fall back to the latest build.
EOF
}

fail() { printf '[testflight] %s\n' "$*" >&2; exit 1; }
log() { printf '[testflight] %s\n' "$*" >&2; }
asc_cli() { asc --profile "$ASC_PROFILE" "$@"; }
require_value() { [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-id) require_value "$@"; APP_ID="$2"; shift 2 ;;
    --build-number) require_value "$@"; BUILD_NUMBER="$2"; shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --ipa) require_value "$@"; IPA_PATH="$2"; shift 2 ;;
    --distribute-build) require_value "$@"; BUILD_ID="$2"; shift 2 ;;
    --group-id) require_value "$@"; GROUP_ID="$2"; shift 2 ;;
    --invite-email) require_value "$@"; INVITE_EMAIL="$2"; shift 2 ;;
    --no-invite) SEND_INVITE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ -z "$IPA_PATH" || -z "$BUILD_ID" ]] || fail '--ipa and --distribute-build are mutually exclusive'
if [[ "$BUILD_ONLY" -eq 1 ]]; then
  [[ -z "$IPA_PATH" && -z "$BUILD_ID" ]] || fail '--build-only requires the archive lane'
else
  [[ "$APP_ID" =~ ^[0-9]+$ ]] || fail 'Provide the numeric ASC app ID through --app-id or APP_ID'
fi
if [[ -z "$IPA_PATH" && -z "$BUILD_ID" ]]; then
  [[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || fail 'Provide a positive integer --build-number or YAKJEV_IOS_BUILD_NUMBER'
fi
for command in asc jq python3; do
  command -v "$command" >/dev/null || fail "Missing command: $command"
done
mkdir -p "$ARTIFACTS_DIR"

if [[ "$BUILD_ONLY" -eq 0 ]]; then
  log "Checking ASC profile: $ASC_PROFILE"
  asc_cli doctor >/dev/null
  app_json="$(asc_cli apps view --id "$APP_ID" --output json)"
  [[ "$(jq -r '.data.attributes.bundleId' <<<"$app_json")" == "$BUNDLE_ID" ]] || fail 'ASC app bundle ID does not match Yakjev'
fi

if [[ -z "$IPA_PATH" && -z "$BUILD_ID" ]]; then
  for command in bunx pod security xcodebuild plutil; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
  done
  identities="$(security find-identity -v -p codesigning)"
  [[ "$identities" == *"$CODE_SIGN_IDENTITY"* ]] || fail "Installed signing identity not found: $CODE_SIGN_IDENTITY"
  export YAKJEV_IOS_BUILD_NUMBER="$BUILD_NUMBER"
  RUN_DIR="$ARTIFACTS_DIR/build-$BUILD_NUMBER"
  ARCHIVE_PATH="$RUN_DIR/yakjev.xcarchive"
  IPA_PATH="$RUN_DIR/yakjev.ipa"
  EXPORT_OPTIONS_PATH="$RUN_DIR/ExportOptions.plist"
  [[ ! -e "$ARCHIVE_PATH" && ! -e "$IPA_PATH" ]] || fail "Build artifacts already exist at $RUN_DIR; use --ipa to upload, or choose a new build number"
  mkdir -p "$RUN_DIR"

  log "Generating native project for build $BUILD_NUMBER"
  (cd "$MOBILE_DIR" && CI=1 bunx expo prebuild --platform ios --no-install --no-clean)
  actual_build="$(plutil -extract CFBundleVersion raw "$MOBILE_DIR/ios/yakjev/Info.plist")"
  [[ "$actual_build" == "$BUILD_NUMBER" ]] || fail 'Expo config must consume YAKJEV_IOS_BUILD_NUMBER before archiving'
  (cd "$MOBILE_DIR/ios" && pod install)

  python3 - "$EXPORT_OPTIONS_PATH" "$TEAM_ID" "$BUNDLE_ID" "$PROFILE_NAME" <<'PY'
import plistlib, sys
path, team, bundle, profile = sys.argv[1:]
with open(path, 'wb') as output:
    plistlib.dump({
        'method': 'app-store-connect', 'signingStyle': 'manual',
        'teamID': team, 'provisioningProfiles': {bundle: profile},
        'stripSwiftSymbols': True, 'uploadSymbols': True,
        'manageAppVersionAndBuildNumber': False,
    }, output)
PY
  log "Archiving build $BUILD_NUMBER"
  xcodebuild -workspace "$MOBILE_DIR/ios/yakjev.xcworkspace" -scheme yakjev \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM="$TEAM_ID" PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
    CODE_SIGN_IDENTITY="$CODE_SIGN_IDENTITY" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    archive
  asc_cli xcode export --archive-path "$ARCHIVE_PATH" \
    --export-options "$EXPORT_OPTIONS_PATH" --ipa-path "$IPA_PATH" \
    --output json > "$RUN_DIR/export.json"
fi

if [[ -z "$BUILD_ID" ]]; then
  [[ -f "$IPA_PATH" ]] || fail "IPA not found: $IPA_PATH"
  metadata="$(python3 - "$IPA_PATH" "$BUNDLE_ID" "$BUILD_NUMBER" <<'PY'
import hashlib, json, plistlib, re, sys, zipfile
path, bundle, expected_build = sys.argv[1:]
with zipfile.ZipFile(path) as archive:
    names = set(archive.namelist())
    roots = [name for name in names if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', name)]
    if len(roots) != 1:
        raise SystemExit('IPA must contain exactly one main app Info.plist')
    info = plistlib.loads(archive.read(roots[0]))
    prefix = roots[0][:-len('Info.plist')]
    build = str(info.get('CFBundleVersion', ''))
    version = str(info.get('CFBundleShortVersionString', ''))
    if info.get('CFBundleIdentifier') != bundle:
        raise SystemExit('IPA bundle identifier does not match Yakjev')
    if not re.fullmatch(r'[1-9][0-9]*', build) or (expected_build and build != expected_build):
        raise SystemExit('IPA build number is invalid or does not match the requested build')
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', version):
        raise SystemExit('IPA marketing version is invalid')
    js = prefix + 'main.jsbundle'
    if js not in names or archive.getinfo(js).file_size == 0:
        raise SystemExit('IPA is missing its bundled JavaScript')
    icon = info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {})
    if not (icon.get('CFBundleIconFiles') or icon.get('CFBundleIconName')):
        raise SystemExit('IPA has no primary app icon declaration')
    if prefix + 'Assets.car' not in names and not any(name.startswith(prefix + 'AppIcon') and name.endswith('.png') for name in names):
        raise SystemExit('IPA is missing app icon assets')
    shaders = [name for name in names if name.startswith(prefix) and name.endswith((
        '/YakjevGraphShaders.bundle/Graph.metal',
        '/YakjevGraphShaders.bundle/default.metallib',
    ))]
    if not shaders or not any(archive.getinfo(name).file_size > 0 for name in shaders):
        raise SystemExit('IPA is missing the native graph shader resource')
with open(path, 'rb') as source:
    checksum = hashlib.file_digest(source, 'sha256').hexdigest()
print(json.dumps({'bundleId': bundle, 'version': version, 'buildNumber': build, 'sha256': checksum}))
PY
  )"
  VERSION="$(jq -r '.version' <<<"$metadata")"
  BUILD_NUMBER="$(jq -r '.buildNumber' <<<"$metadata")"
  log "Verified IPA: $BUNDLE_ID $VERSION ($BUILD_NUMBER), JavaScript, icon, and Metal shader"
  if [[ "$BUILD_ONLY" -eq 1 ]]; then
    printf '%s\n' "$metadata" > "$RUN_DIR/ipa.json"
    log "Build-only complete: $IPA_PATH"
    exit 0
  fi

  RECEIPT_DIR="$ARTIFACTS_DIR/$APP_ID-$VERSION-$BUILD_NUMBER"
  mkdir -p "$RECEIPT_DIR"
  # A failed or interrupted upload may have committed on Apple's side. Never
  # repeat it automatically, including on the next invocation of this script.
  if ! (set -o noclobber; printf '%s\n' "$metadata" > "$RECEIPT_DIR/upload-attempt.json") 2>/dev/null; then
    fail "Upload already attempted; inspect ASC builds/uploads and use --distribute-build ID. Receipt: $RECEIPT_DIR"
  fi
  log "Uploading $VERSION ($BUILD_NUMBER)"
  if ! asc_cli builds upload --app "$APP_ID" --ipa "$IPA_PATH" --wait \
    --output json > "$RECEIPT_DIR/upload.json"; then
    fail "Upload did not finish cleanly. Do not re-upload; inspect ASC builds/uploads, then resume with --distribute-build ID. Receipt: $RECEIPT_DIR"
  fi
  # Resolve only the IPA's exact version/build; upload IDs are not build IDs.
  build_json="$(asc_cli builds info --app "$APP_ID" --build-number "$BUILD_NUMBER" \
    --version "$VERSION" --platform IOS --output json)"
  printf '%s\n' "$build_json" > "$RECEIPT_DIR/build.json"
  BUILD_ID="$(jq -er '.data.id' <<<"$build_json")"
fi

log "Checking exact build $BUILD_ID before distribution"
build_app="$(asc_cli builds app view --build-id "$BUILD_ID" --output json)"
[[ "$(jq -r '.data.id' <<<"$build_app")" == "$APP_ID" ]] || fail 'Build belongs to a different ASC app'
asc_cli builds wait --build-id "$BUILD_ID" --fail-on-invalid --timeout 20m >/dev/null

if [[ -z "$GROUP_ID" ]]; then
  groups="$(asc_cli testflight groups list --app "$APP_ID" --internal --paginate --output json)"
  GROUP_ID="$(jq -r --arg name "$GROUP_NAME" '[.data[] | select(.attributes.name == $name)] | if length > 1 then error("Duplicate internal group names") else .[0].id // empty end' <<<"$groups")"
  if [[ -z "$GROUP_ID" ]]; then
    GROUP_ID="$(asc_cli testflight groups create --app "$APP_ID" --name "$GROUP_NAME" --internal --output json | jq -er '.data.id')"
  fi
fi
groups="$(asc_cli testflight groups list --app "$APP_ID" --internal --paginate --output json)"
jq -e --arg id "$GROUP_ID" '.data | any(.id == $id)' <<<"$groups" >/dev/null || fail 'Group must be an internal group belonging to this app'

asc_cli builds add-groups --build-id "$BUILD_ID" --group "$GROUP_ID" --output table
if [[ "$SEND_INVITE" -eq 1 ]]; then
  # ASC 2.7 invite only applies --group when creating a missing tester. An
  # existing app tester must be assigned explicitly before sending the invite.
  app_testers="$(asc_cli testflight testers list --app "$APP_ID" \
    --email "$INVITE_EMAIL" --paginate --output json)"
  TESTER_ID="$(jq -r --arg email "$INVITE_EMAIL" '[.data[] | select((.attributes.email | ascii_downcase) == ($email | ascii_downcase))] | if length > 1 then error("Duplicate tester email") else .[0].id // empty end' <<<"$app_testers")"
  if [[ -n "$TESTER_ID" ]]; then
    asc_cli testflight testers add-groups --id "$TESTER_ID" \
      --group "$GROUP_ID" --output table
  fi
  # Let real errors fail; uploading alone is not a successful invitation.
  asc_cli testflight testers invite --app "$APP_ID" --email "$INVITE_EMAIL" \
    --group "$GROUP_ID" --output table
  testers="$(asc_cli testflight testers list --app "$APP_ID" --group "$GROUP_ID" \
    --email "$INVITE_EMAIL" --output json)"
  jq -e --arg email "$INVITE_EMAIL" '.data | any((.attributes.email | ascii_downcase) == ($email | ascii_downcase))' <<<"$testers" >/dev/null || fail 'Invited tester is not present in the target group'
fi
asc_cli builds build-beta-detail view --build-id "$BUILD_ID" --output table
log "Distributed exact build $BUILD_ID to internal group $GROUP_ID"
