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


## Private family links (Railway)

Use **Family link → Create family link** on the browser with your workouts. Open the resulting private link on other devices. Profiles, workouts, images and videos synchronize without Google sign-in. **Download for offline** stores the selected workout’s media locally. Keep the family link private: anyone holding it can read and modify the library.

The app remains available on GitHub Pages so existing device storage stays accessible. `cloud-config.js` points both frontends to the Railway API. The Railway app serves the same frontend at its own domain. Opening a new origin cannot access another origin’s IndexedDB; create/open the family link from the old site to bring existing data across. Device libraries and family libraries use separate namespaces and are retained.

`server.cjs` is a small Node server. It stores encrypted JSON snapshots and media in the private Railway `tabata-storage` bucket. No separate database service or volume is required. It uses conditional object writes for concurrent updates; the client performs three-way merging and preserves conflict copies. Independent server tests verify capability isolation, stale revision rejection, request validation and media integrity. Production verification must also test the bucket’s conditional-write support.

The family key remains in the URL fragment and browser storage. The browser sends a domain-separated SHA-256 access capability and AES-GCM encrypted content. Cloud media has a random IV, ciphertext hash and plaintext hash; downloads verify both. Bucket credentials remain in Railway variable references. Public static files are explicitly allowlisted; server source and environment files are not served. Signed downloads expire after 15 minutes. CORS allows only the two app origins. New family creation is capability based; requests are bounded by metadata/file sizes, three simultaneous uploads, 1,000 writes/hour and a default 2 GiB/hour upload allowance per running process (`HOURLY_UPLOAD_BYTES`). These are abuse safeguards, not a billing cap.

Uploads stream through the service into multipart object storage with bounded server memory; interrupted uploads can require retrying the file. Files are limited to 512 MB and browser encryption temporarily needs memory proportional to file size. Successful files are cached locally, so retrying a family sync skips completed files. Downloads go directly from the private bucket through short-lived signed URLs; service uploads incur Railway service egress charges. Cloud media is retained when workouts are deleted to avoid deleting files used by another profile or conflict copy. Bucket object versioning is unavailable; keep exports for independent backups.

Legacy Firebase family links are imported once into Railway; Firebase originals are not deleted. Legacy Google Drive references are migrated from cached files when possible. If a file is only in Drive, reconnect the account through the recovery control. GitHub tokens and device preferences remain local.

### Deployment

Use the included Dockerfile (Node 24, pinned pnpm lockfile), one replica, and healthcheck `/api/health`. Attach the private bucket with its **Add to Service → AWS SDK (Generic)** control. Required variables: `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Railway supplies `PORT` and `RAILWAY_PUBLIC_DOMAIN`; additional trusted origins can be specified in `ALLOWED_ORIGINS`. The server configures bucket CORS during startup.

Run `pnpm install --ignore-scripts`, then `pnpm test`. Local HTTP integration tests require permission to listen on loopback. To run against cloud storage locally, configure bucket credentials privately; never commit them.
