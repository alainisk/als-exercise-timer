# Tabata Timer

A responsive, offline-capable interval timer. Open a workout, review its duration and sequence, and start directly from the library. Workouts, exercise media and settings use the existing IndexedDB database; the redesign does not migrate or erase saved data.

## Run locally

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open http://127.0.0.1:4173/. No dependencies or build step are required. The app must be served over localhost or HTTPS for its PWA features.

## Test

With Node.js installed:

```sh
node --test tests/timer.test.cjs
```

Tests exercise the production timer logic with deterministic time, including delayed browser ticks and precise completion time. They also check backup validation, exclusion of sync credentials, and atomic video/workout saving. Cancelling either editor leaves saved media unchanged.

## Controls

- Select a workout to preview it; use **Start workout** to begin.
- Use **Edit workout** or **New workout** to configure intervals, cycles and optional media.
- During a workout: **Space** pauses/resumes when focus is outside a button; **Left/Right arrows** skip intervals; **Escape** pauses. Focused buttons keep their native Space behavior.
- **Sound on/off** mutes cues during a session. Settings retain voice, sound, vibration, light theme, backup and existing GitHub Gist sync options.

## Files and deployment

`index.html` contains the screens, `app.js` contains the timer/storage/media logic, `styles.css` contains the original shared components, and `redesign.css` contains the new design tokens and responsive presentation. `sw.js` updates the application cache, including the new stylesheet.

This remains a static GitHub Pages app. Publish the project files to the existing Pages repository to deploy. Production is published to GitHub Pages; Firebase stores encrypted family libraries. `design/` and `tests/` are documentation and development artifacts and are not runtime dependencies.

See [design/verification.md](design/verification.md) for the visual specification, screenshots, browser checks, and test results.

## Local profiles

Use the profile button in the header to switch users or add a name. No email, subscription, or account is required. The original database stays in **My profile**. New profiles get their own IndexedDB database for workouts, videos and settings, and start with an empty library. The selected profile persists on this browser/device. Profile switching is unavailable during workouts and pending save/sync operations.

Every workout has a visible **Delete** action, including the last workout in a profile. Confirming deletion removes its media and shows the empty-library screen. Profiles are local convenience spaces, not password-protected accounts. Existing backup and sync operations apply to the selected profile.


## Private family links (Firebase)

On the browser containing your existing workouts, choose **Family link → Create family link**. This copies profiles and workout details to an encrypted family library. Connect Google Drive first when the library contains media; videos and images upload to your private Tabata Timer Media folder and Firebase stores only file references. Copy that link and open it on other devices. There is no email or password. Anyone possessing the complete link can view and modify this family. Keep it private.

Original local libraries remain in their original IndexedDB databases. Family libraries use separate database namespaces. **Use device library** switches back without deleting either library. Workouts created separately on another device remain in that device library; joining does not automatically merge unrelated local profiles.

Changes sync automatically when the Workouts screen is idle and online, plus on return to the app. Sync pauses during workouts, editing, and profile operations. Offline edits stay local until sync succeeds. **Sync now** retries from the Family link dialog. Independent changes merge; conflicting versions of the same workout are preserved as separate workouts. Deletions propagate, except a concurrent edit is retained to prevent data loss. Preferences and GitHub tokens stay on each device.

Firebase project: `tabata-timer-d9aae`, Spark plan. The app uses the Realtime Database REST API and conditional ETag writes, without shipping administrative credentials or adding an SDK dependency. A random 256-bit link key stays in the URL fragment and local browser storage. Its SHA-256 digest addresses the database record; AES-GCM encrypts profiles, workout details and file references. Media files in Google Drive use Google’s storage protections, not the family-link encryption key. Root/list reads are denied by `firebase/database.rules.json`. Access at the unguessable record address is a bearer capability; no anonymous user directory or public family listing exists. Administrators can see addresses and ciphertext, so treat console access as privileged. Family links are not individually revocable on a device; creating a separate family library creates a new key.

Media uploads use Google Drive’s resumable upload protocol in 4 MiB chunks. SHA-256 references avoid re-uploading unchanged files. Firebase receives only small metadata snapshots, with revision checks between changes. Legacy family media is migrated to Drive when connected. Local originals are retained.

On each device, open the same family link and connect the Google account that uploaded the media. **Download for offline** saves the selected workout’s images/videos locally. Downloaded videos are also cached as you play them. Google access tokens remain only in page memory, so reconnect after reloading or when access expires. Google Drive access is limited to `drive.file`, not your whole Drive. Separate Google accounts need Drive sharing as well as the family link; cross-account access has not yet been verified. Deleting a workout/profile does not delete the original Drive files: manage these in the linked Drive folder. Local cached copies remain until browser site storage is cleared.

Drive files use your existing account’s storage quota. This update does not enable Google Cloud billing. Browser storage and Google Drive quotas still apply. Firebase snapshots retain a 100 MiB metadata limit, but videos no longer count toward it.

Regression tests: `node --test tests/*.test.cjs`. Tests cover encryption, wrong-key rejection, concurrent changes, deletion merging, and existing timer/storage behavior. Independent browser origins have verified profile, workout and public test-video transfer.
