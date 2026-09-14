# Tabata Timer

A responsive interval timer with private user accounts, personal workout libraries, uploaded videos, YouTube/Vimeo links and sharing by username. Firebase Authentication handles passwords; Firebase Realtime Database stores library metadata and sharing permissions. Railway hosts the API/frontend and private file bucket.

## Accounts and sharing

- **Log in / Sign up** creates an account with a unique username, recovery email and password of at least 12 characters. Usernames are case-insensitive and use 3–24 letters, numbers or underscores. Log in with username and password; use **Forgot your password?** with your recovery email.
- Profiles organize workouts within your account. Accounts have separate local databases and server libraries. The unsigned device library remains available separately.
- **More options → Share workout** lists every recipient and adds/removes access by existing username. Share changes take effect immediately on the server. The recipient sees the workout in **Shared with me**, can run it and can save an independent editable copy. The original is view-only for recipients.
- Removal stops subsequent authorized requests. A previously issued file URL lasts up to 60 seconds. Copies or files a person already saved cannot be recalled.
- Owned workouts synchronize automatically while the home screen is idle. Offline edits stay on the device; reconnect or use **Sync now**. Concurrent changes merge; conflicting edits are preserved as separate copies. Shared workouts require an online access check when opening and starting.
- Logging out first syncs, then removes the account's local library, cached media, sync baseline and session. It will keep you logged in if it cannot save your changes. Close other account tabs if local database removal is blocked.

## Videos

In an exercise editor, upload MP4, MOV or WebM (up to 512 MB), or paste a HTTPS YouTube/Vimeo link. Public YouTube watch, shortened, shorts, live and embed URLs are supported; Vimeo public and unlisted privacy hashes are preserved. Links survive edits, backups, copies and cross-device sync without uploading video bytes.

Provider players have their own play controls and need internet/embedding permission. Pausing or leaving an interval unloads its player; resume may require tapping Play again. **Open video** opens the original source if embedding is unavailable. Linked videos are not included in offline downloads. File codec/browser support still applies to uploaded videos.

## Existing device and family libraries

Private family links are retired in the new app and API. Older browser databases and encrypted cloud objects are retained rather than deleted. The unsigned device view opens the previously selected local family cache when one exists.

After logging in, choose **Import device workouts** to copy the old library on that browser into the current account/profile. Locally available images and videos are included; originals stay untouched. Import validates and stages the entire library before committing. Each import creates independent copies; repeated imports create additional copies. If an old file exists only in the retired cloud library, download/export it using the previous app before rollout or reattach it to the local workout before importing. The new account API cannot decrypt former family-link ciphertext.

Browser storage is origin-specific: import on the original GitHub Pages origin if that is where the files were saved. `cloud-config.js` sends Pages account requests to Railway; Railway and localhost use their own `/api`.

## Deployment configuration

The source changes alone do not configure Firebase or publish the app. Before deploying:

1. In the existing Firebase project, enable **Authentication → Sign-in method → Email/Password**. Configure the password-reset email template and authorized app domains.
2. Set `FIREBASE_DATABASE_URL`, `FIREBASE_WEB_API_KEY` (Firebase project web API key), and `FIREBASE_SERVICE_ACCOUNT_JSON` in Railway. The service account needs access to Firebase Authentication and Realtime Database. Keep the JSON key exclusively in server environment variables. Application Default Credentials can be used instead of the JSON key in supported environments.
3. Keep the private Railway bucket variables: `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. `PORT` and `RAILWAY_PUBLIC_DOMAIN` are provided by Railway. `ALLOWED_ORIGINS` is a comma-separated list for additional trusted frontend origins.
4. Publish `firebase/database.rules.json`. It denies all direct client reads/writes, including former family capability paths. Only the trusted Railway Admin SDK accesses account metadata. Preserve an export of older libraries and complete required recovery before retiring old direct access.
5. Deploy using the included Dockerfile and `/api/health` healthcheck. It returns healthy only when the account service and bucket are configured (it is a configuration check, not a live Firebase/bucket probe). Keep one service replica while the in-process upload/auth limits are used. Publish the same frontend files to Pages if retaining that origin.
6. Verify real sign-up, duplicate usernames, username login, password-reset delivery, an uploaded file, two separate accounts sharing/revoking access, refresh after token expiry, and a second-device sync against the live providers. Local integration tests use injected Firebase/bucket fixtures and do not establish live provider configuration.

No passwords or service-account credentials are included in static assets. The API verifies Firebase ID tokens including revocation, checks ownership and current sharing permissions, validates library data, uses Firebase transactions for revision conflicts and hashes uploads. Account media is private object storage protected by server authorization; it does not use the old family encryption scheme. Object bytes are never stored in the database. Uploaded files are retained when a workout is deleted, protecting existing copies; administrative cleanup is a separate operation.

## Local development and tests

Node 22+ and pnpm are required. Run `pnpm install --ignore-scripts`, then `pnpm start`. Copy the variable names from `.env.example` into your local environment; alternatively use `node --env-file=.env server.cjs` after supplying private values. `ALLOWED_ORIGINS` must include your local URL for account POST requests. Without Firebase settings the device timer still works and account endpoints return a clear unavailable error.

Run `pnpm test`. Tests cover timer behavior, atomic local saving, provider URL parsing, link-preserving conflict copies, ownership, recipient lists, revocation, media access and stale revisions. Legacy encryption/capability tests remain as recovery regressions; the test fixture explicitly opts into the retired route, which production never enables.

## Files

- `app.js`, `index.html`, `styles.css`, `redesign.css`: timer, editors, local profile storage and account/sharing interfaces.
- `accounts.cjs`, `server.cjs`: authenticated API, Firebase adapter and Railway file storage.
- `account-sync.js`, `account-media.js`, `sync-merge.js`: sessions, synchronization and file handling.
- `video-sources.js`: shared client/server provider URL parser.
- `sw.js`: offline application shell. API, signed media and third-party players are never cached by the service worker.
- `family-sync.js`, `cloud-media.js`, `drive-media.js`: preserved legacy code, not loaded by the current app.

The Firebase implementation follows the official [Authentication REST API](https://firebase.google.com/docs/reference/rest/auth), [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens) and [Realtime Database transactions](https://firebase.google.com/docs/database/admin/save-data) documentation.
