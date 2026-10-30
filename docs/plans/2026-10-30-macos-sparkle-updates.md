# macOS automatic updates with Sparkle

Status: proposal for maintainer review; documentation only. No runtime behavior changes.

## Problem and intended experience

The macOS desktop app currently checks releases and opens a download page. Users must download a zip and replace the app themselves. Windows and Linux AppImage already have an installation path through electron-updater. This proposal adds a macOS path without changing those platforms or the DSH plugin.

The intended macOS experience is:

1. Check for compatible updates in the background and download them automatically when automatic updates are enabled.
2. Verify the update and prepare it without interrupting the user.
3. Offer **Restart and update** and **Later** once the update is ready. Defer this prompt while the window is hidden, as the existing prompt does.
4. On confirmation, safely stop the Host, replace the app through Sparkle, and reopen the updated app with the same data locations. Never ask the user to unpack or drag an app manually.

Later leaves the update staged; ordinary quit must not silently install it without the agreed installation policy. Automatic checking, downloading and installing are separate choices. Turning automatic updates off stops scheduled checks/downloads; a manual check remains available. In-progress downloads can be cancelled, and a user may defer installation.

No claim is made that every macOS permission prompt can be suppressed. An unwritable destination may require system authorization. First-launch Gatekeeper approval is separate from update verification.

## Existing integration points

- `app/src/main.mjs`: `startUpdates()` selects `watchReleases()` on macOS, and routes update check/install IPC through the main process. Other platforms use `watchUpdates()` where supported.
- `app/src/updates.mjs`: update state and release-page checking.
- `app/src/update-prompt.mjs`: defer prompts until a visible window exists.
- `app/electron-builder.yml`: architecture-specific zip artifacts, ad-hoc signing, no Developer ID or notarization.
- `.github/workflows/release.yml`: builds macOS arm64 and x64 separately and attaches their zips.
- `app/scripts/check-update.mjs`: macOS currently exercises release notification, not replacement.

These observations describe the current `dev` branch at proposal preparation. Recheck them before implementation.

## Candidate approaches

| Approach | Benefits | Constraints |
| --- | --- | --- |
| Extend electron-updater to macOS | Reuses the existing JavaScript integration and update state | Its Squirrel.Mac path requires application signing. The current ad-hoc release must not be assumed sufficient; validate a supported signing/distribution setup first. |
| Sparkle 2 with an Ed25519 update key | Framework owns verification, replacement and relaunch; update archive authentication does not require purchasing a Developer ID certificate | Requires a native Electron bridge, bundled framework and helpers, an appcast, and a maintained signing/publishing process. |
| Custom zip replacement script | Initially appears simple | Reimplements trust checks, application lifetime, installation permissions and recovery. Reject in favor of a maintained installer. |

Recommend Sparkle for the current distribution model. This is a proposed upstream architecture decision, not maintainer approval. Apple application signing, notarization and Sparkle archive signing are distinct. Sparkle's Ed25519 signature establishes update authenticity; it does not confer Apple identity or notarization.

## Proposed architecture

Use a small macOS-only native bridge loaded by Electron's main process, linked against a pinned Sparkle 2 release. Instantiate `SPUUpdater` with the actual Electron application bundle as host and application bundle, on the Cocoa main thread. Use a custom user driver to report checking, download progress, verified readiness, installation and errors to the existing app UI. Sparkle owns archive verification, installation and relaunch; JavaScript must not replace files itself.

Expose only check, subscribe, cancel/defer and install actions to the main process. The renderer uses existing validated IPC; it cannot supply executable paths, signing keys, arbitrary feeds or installer commands. Do not load the bridge in the renderer or DSH Host. A missing bridge or invalid configuration reports an actionable update error and offers the existing release-page fallback.

Before committing to this bridge, build a minimal packaged Electron proof on both architectures. Verify Cocoa run-loop callbacks, Sparkle lifetime, helper layout, ad-hoc signing compatibility and actual replacement/relaunch. This integration has not been tested by this proposal. If the proof fails, revisit the architecture instead of shipping a shell-copy workaround.

Let Sparkle own scheduling and persisted update preferences. Avoid running the existing four-hour JavaScript release checker alongside it. Map Sparkle state into the About/update UI. Retain throwaway-run isolation: without an explicit test feed and isolated data/preferences, tests must not contact production or alter an installed user copy. Preserve the existing JSON `DS_BOT_UPDATE_URL` test contract or migrate it explicitly; do not silently reinterpret existing tests as an appcast.

## Safe restart and data preservation

Installation must be a handshake, not an unconditional quit:

1. Confirm that the staged release is still eligible and the user requested installation.
2. Block new work while preparing to exit; check active Bot turns, terminal jobs, browser/document work and pending writes through supported existing services. Define and test what can resume. Do not claim unfinished work is preserved merely because chat history is persisted.
3. If work cannot stop safely, show that installation is waiting. Let the user defer; do not force-kill jobs or invent undocumented DSH hooks. If DSH lacks a necessary lifecycle signal, raise that limitation before implementation.
4. Flush app state, stop the Host successfully, then allow Sparkle's installer to proceed. A stop failure aborts installation and restores a usable app state.
5. Relaunch the same application identity and use the saved data/workspace locations. Do not re-import a team or reset first-run preferences.

This feature changes no data schema. App replacement recovery does not imply that downgrading application data is safe. Never delete the installed old app before the installer is ready; rely on Sparkle's supported installation behavior and verify failures on disposable copies. An update failure must remain visible and must not be reported as success.

## Packaging, signatures and publication

- Pin the Sparkle release and verify downloaded framework/tool artifacts against reviewed checksums. Bundle the framework, required XPC/helper executables and complete third-party notices, preserving symlinks and executable permissions. Build/sign native bridge and app components in the proper order for arm64 and x64; keep the current minimum macOS version unless compatibility is explicitly reviewed.
- Generate a project-owned Ed25519 signing key under maintainer control. Embed only `SUPublicEDKey` in the app. Keep the private key in a protected release secret or offline signing environment; never expose it to pull requests, fork workflows, artifacts or logs. The contributor must not establish a personal production signing authority for the project.
- Embed a maintainer-approved HTTPS `SUFeedURL`. Use separate arm64/x64 appcasts to prevent wrong-architecture replacement, and separate stable/prerelease channels. Stable installs must not enter prerelease channels automatically. Verify Sparkle version ordering against existing release tags and monotonically increasing `CFBundleVersion` values, including prerelease-to-stable transitions.
- Continue producing zips per architecture. Sign the final immutable update zip with Sparkle's tools, generate the appcast, and verify its signature, version, architecture and minimum-system metadata before publication. Do not modify a zip after signing.
- Attach versioned zips first; publish/update the corresponding feed only after all referenced artifacts are downloadable and verified. A failed build or partial upload must leave the prior valid feed intact. GitHub-hosted assets and a maintainer-approved stable HTTPS feed endpoint can serve this without a paid update service; the exact endpoint is an upstream decision.
- Retain the existing manual download path during rollout and when no valid signed feed is configured. Never accept an unsigned update as fallback. Key loss without an independent trusted recovery route can require manual reinstall; document backup and key rotation before rollout.
- Updating an already installed, non-notarized app does not prove first installation works without Gatekeeper approval. Test both cases without disabling macOS security protections.

## Initial rollout and fallback

Existing releases do not contain Sparkle, its public key or its feed. Users install the first Sparkle-enabled release through the current manual path once. Subsequent releases can use the automatic flow. Do not advertise automatic upgrading from an old release that has only the release-page checker.

If an update is withdrawn, stop offering it in the feed; do not force a downgrade. Publish a fixed version with a higher version number. A failed check/download/signature validation leaves the running version available and offers retry or manual download. Normal updates require no manual file replacement after the initial bootstrap.

## Security and privacy

Require HTTPS and valid archive signatures. Consider Sparkle's signed-feed and verification-before-extraction options for the pinned version, and test their compatibility before enabling them. Reject wrong signatures, malformed metadata, incompatible OS/architecture and unintended downgrades. Never weaken verification to make a test pass.

Disable system-profile submission and external release-note loading unless separately justified. Update requests carry normal network connection metadata but must not contain chats, local paths, credentials or model/provider settings. No telemetry or crash-upload feature is part of this change.

The strongest objection is the additional native maintenance burden in an Electron application. Keep the bridge narrow and prove the full installation chain before expanding UI work. The major failure scenarios are a leaked/lost signing key, interruption while replacing the app, and restart during active work; release-key isolation, disposable installation tests and the shutdown handshake address different parts of those risks, not a universal guarantee.

## Implementation sequence and acceptance

All checks below are planned, not passed. This document adds no dependencies, installer, signing keys or runtime code.

1. Maintainer approves the approach, contribution route, feed ownership, signing responsibility and update defaults.
2. Prove Sparkle replacement/relaunch in a minimal packaged Electron app on arm64 and native Intel. Test the current ad-hoc distribution model explicitly. Treat failure as an architecture blocker.
3. Add the bridge, state adapter and existing-window prompt integration. Add tests for duplicate checks, cancel, Later, hidden windows, Host stop failure and active work deferral.
4. Add packaging and release signing/feed generation with fork-safe secret handling. Validate the actual packaged framework/helper signatures and notices.
5. Exercise old Sparkle-enabled build A to build B using a local/controlled HTTPS feed and isolated synthetic data. Assert installed bundle version B, successful relaunch and unchanged chat/settings/workspace markers; exercise B to C for a second update.
6. Repeat on arm64 and native Intel, the oldest supported macOS version and a current version. Test writable Applications and system authorization/cancellation, read-only/translocated launches, offline checks, download interruption, insufficient disk space, corrupted zip, invalid signature, missing asset, malformed feed, wrong architecture/OS, prerelease isolation and failed Host shutdown. Verify the old version remains usable where installation does not complete.
7. Run the project's required plugin checks (`npm test`, generated client check and lint), desktop tests and packaged lifecycle checks. Exercise Windows and Linux update paths to verify no regression. Record unavailable environments explicitly rather than marking them passed.
8. Obtain maintainer review and real-machine acceptance before enabling the production feed. Document the one-time manual bootstrap and actual system prompts observed.

## References

- [Sparkle setup, EdDSA signing, distribution and appcasts](https://sparkle-project.org/documentation/)
- [Sparkle programmatic setup and API expectations](https://sparkle-project.org/documentation/programmatic-setup/)
- [Sparkle license and bundled third-party licenses](https://github.com/sparkle-project/Sparkle/blob/2.x/LICENSE)
- [Electron macOS autoUpdater requirements](https://www.electronjs.org/docs/latest/api/auto-updater/)
- [electron-builder v26 update documentation](https://www.electron.build/v26/docs/features/auto-update/)
- [DS Bot contribution workflow](../../CONTRIBUTING.md)

Sparkle's MIT license permits integration with this Apache-2.0 project subject to preservation of its license and bundled component notices. Add attribution to `NOTICE` when code/framework integration is implemented; this proposal bundles no third-party code.
