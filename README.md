# YYC Brokers delivery workspace

React and TypeScript frontend, Zustand stores, and a Node.js HTTP API backed by SQLite.

## Setup and development

Requires Node.js 22.13 or newer and npm. Node 22 may print an experimental SQLite warning.

```sh
npm ci
npm run dev
```

This starts the API on `http://127.0.0.1:3000` and Vite on its displayed URL. Open the Vite URL at `/react/`. Register a store or driver in the frontend. Driver and truck registrations need broker approval.

Set up the first broker account from the login page. An operator first issues a one-time token on the server:

```sh
npm run setup
# With deployment settings: node --env-file=.env server/setup.js
```

Open the login page, choose **Set up broker account**, enter the token, and choose your own broker name, contact phone, email, and password. The token expires after 30 minutes, is stored as a hash, and is consumed when the first broker is created. Setup closes after the first broker account exists, including when that account is disabled. Public store/driver registration cannot create broker accounts. There are no default credentials. Keep the token private.

To create the first broker automatically at startup instead, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12–128 characters, required together) and optionally `ADMIN_NAME` and `ADMIN_PHONE`. When the server starts and no broker exists, it creates that account and logs a confirmation. Once any broker exists, these variables are ignored, so remove `ADMIN_PASSWORD` from `.env` after the first start. Do not commit the password.

Operators can still provision additional brokers or recover access with `npm run create-admin`, using `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12–128 characters), `ADMIN_NAME`, and `ADMIN_PHONE`. With a deployed `.env`, use `node --env-file=.env server/create-admin.js` so provisioning targets the same database as the service. Do not send passwords through chat or commit them to source control.

The default database is `data/yyc.sqlite`. Set `DATABASE_PATH` to use another file; parent directories and an empty schema are created automatically. Existing rows are preserved. Tests use isolated databases and never change the workspace database.

## Production build and local serving

Use Node.js 22.13 or newer. Copy `.env.example` to `.env`, set `PUBLIC_ORIGIN` to your HTTPS origin, and keep `NODE_ENV=production` and `COOKIE_SECURE=true`. Run `npm ci`, `npm run build`, issue a first-broker token with `node --env-file=.env server/setup.js` then run `npm run start:configured` under a process supervisor and complete **Set up broker account** on the login page. Terminate HTTPS at a reverse proxy forwarding to `127.0.0.1:3000`. Startup rejects invalid production origins, insecure cookies, ephemeral databases and invalid backup settings before opening the listener.

Keep the database and backups on persistent storage accessible only to the service account. Configure off-host backups and alerts using the integrations below, and run a recovery drill before launch. Configure routing and recovery delivery if those features are needed. The listener defaults to localhost; set `HOST` explicitly when a container requires another interface.

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3000/react/`. The Node server serves the API, production frontend, and logo assets. The root URL redirects to `/react/`. `HOST` and `PORT` configure the listener; it binds to localhost by default. For HTTPS deployments, set `COOKIE_SECURE=true` and preserve the original Host header through the reverse proxy.

For Vite preview, run `npm start` in one terminal and `npm run preview` in another. Both Vite development and preview proxy `/api` and `/assets` to the API server on port 3000. If you change the API port, update the proxy target in `vite.config.ts`.

## Checks

```sh
npm test
npm run lint
npm run format:check
npm run build
```

Tests cover stale responses across logout and login, registration throttling and concurrency, quote cent precision, malformed URLs/origins, API decoding, booking retries after lost responses and server restarts, per-account login limits, constant database query counts, numeric input constraints, session expiry handling, save/refresh failures, account isolation, CSRF, approvals, version conflicts, shipment revisions, delivery completion, scheduling, static routes, and persistence across database reopening. The HTTP handler runs in memory by default so tests work without listening on sockets. Run `YYC_LIVE_TESTS=true npm test` to exercise the same API tests over localhost where socket access is permitted.

`npm run test:property` runs nine fast-check properties plus an API workflow property. The workflow property generates mixed valid and invalid action sequences against isolated SQLite databases, compares results with an independent state model, checks persisted rollback, and replays booking request keys. Set `WORKFLOW_FC_RUNS` (default 25) to control its scenario count. The nine domain properties cover money, window overlap, driver availability, and modeled login/registration request sequences. Each domain property generates 500 cases using a deterministic seed, and fast-check shrinks failures to a smaller counterexample. Property tests also run with `npm test`.

To explore a different sequence or increase coverage:

```sh
FC_SEED=12345 FC_RUNS=2000 WORKFLOW_FC_RUNS=75 npm run test:property
```

Failures report their seed and shrink path. Re-run with that seed and use Node's `--test-name-pattern` option to select the failing property if needed. The limiter models use a bounded set of accounts and addresses; they test limits, expiry, reset and release behavior, not the 10,000-entry storage-cap policy.

`npm run lint` checks frontend, shared, server, test, and development-launcher code. `npm run format` applies formatting to maintained source and documentation.

## Workflow behavior

Store owners request delivery; brokers issue a quotation; the store accepts it; a broker offers the job to an approved, suitable, available driver; the driver accepts, records arrival and pickup, then records delivery evidence. An unresolved issue blocks completion until a broker records a resolution. Revisions archive the previous quotation and its ordered itinerary, then clear acceptance and assignment. The broker’s driver picker and the dispatch server use the same vehicle eligibility rules. Version checks reject stale changes.

Brokers can **Correct quotation** before pickup without changing shipment details. A correction requires a reason and changed cent amounts, archives the previous quote, clears any assignment or pending offer, and returns the delivery to **Quote ready**. The customer must accept the corrected version before a driver can be offered the job. Corrections are rejected after pickup.

For an assigned or in-transit job, **Arrange driver handover** offers responsibility to an approved, suitable replacement using the existing pickup-window reservation model. The old driver stays assigned and their tracking stays visible until the replacement explicitly accepts. Acceptance preserves pickup progress, shipment details and the accepted customer quote; an in-transit delivery stays in transit. The broker must arrange the physical cargo transfer and record the reason. Replacement drivers can decline, brokers can withdraw an offer, and disabling a pending replacement withdraws the offer without cancelling the trip. A disabled original driver does not need to be re-enabled for an accepted replacement to finish delivery. Completed trips cannot be handed over.

Delivery receipt and recipient drafts are kept in memory per signed-in driver and shipment. A version conflict refreshes the record but preserves the draft for review and explicit resubmission. If that refresh fails, the drawer can be closed, the workspace refreshed, and the draft reopened. Drafts are removed on completion, lost assignment, logout or account changes; they do not survive a full page reload. The DOM regressions compile the actual frontend in memory and run these interactions against the real API with jsdom; they do not replace visual browser acceptance.

Offers and accepted jobs reserve their pickup date and window. Flexible windows conflict with every other window on that date. Distinct morning and afternoon windows can be reserved separately. This is a pickup-window reservation model; it does not calculate route duration or travel time.

A successful save followed by a failed state refresh is reported as saved. A version conflict followed by a failed refresh is reported as a conflict. In both cases, further changes are blocked until refresh succeeds; booking forms navigate away after successful creation.

Booking creation requires an `Idempotency-Key` header (16–128 letters, digits, underscores, or hyphens). The frontend generates this key and retains uncertain requests in tab session storage, scoped to the user and exact booking details. Retrying the same request after a lost response returns the original booking, even after server restart. Reusing a key with different details returns HTTP 409. Once the frontend acknowledges a successful booking, a deliberate repeat uses a new key. With browser storage disabled, retry keys last for the current page only.

Login limits track each normalized email and connection-address pair for 15 minutes. Failed logins for one account do not lock unrelated accounts behind the same proxy. Forwarded IP headers are not trusted.

Registration accepts up to 20 attempts per connection address per 15 minutes and allows at most four registrations to hash passwords concurrently. Duplicate emails and truck plates are checked before hashing and checked again in the insertion transaction. Broker provisioning through the local command is separate from public registration limits.

Customer prices and driver rates must be positive amounts in whole cents. The API rejects fractional cents rather than silently rounding them. Weight fields can still accept fractions.

Session changes invalidate outstanding workspace and startup requests. A delayed response or error from an old session cannot restore logged-out data, replace a new account's state, or overwrite its CSRF token. Malformed URL encodings return HTTP 400; malformed, opaque, or disallowed origins return HTTP 403.

State reads filter shipments by the signed-in account in SQL, join names and truck profiles, and fetch history in one batch. Query counts stay constant as records grow; action requests read only the target shipment and relevant driver commitments.

## Handoffs, rate changes, and owner requests

Visible workspaces refresh every ten seconds and when the browser regains focus, becomes visible, or reconnects. Background refresh pauses during writes, unresolved refresh failures, and queued offline actions; offline replay refreshes before and after syncing. Connection failures show a stale-instructions warning. Session expiry returns to login. Removing an assignment triggers a persistent driver warning, removes obsolete controls, and creates a notification for both current and former assigned/offered drivers. Email or other external delivery still requires the notification integration; in-app notifications are always recorded.

**Change driver rate** is separate from the customer quotation. A rate-only correction retains the accepted customer price, quote version, and dispatch. Before an assignment or offer, it applies immediately. After a driver has been selected, the proposed rate requires that driver's acceptance; declining retains the agreed rate. Pickup proceeds at the existing agreed rate if a proposal has not been accepted. Customer price changes still require fresh customer acceptance and release previous dispatch commitments. Financial histories and proposed driver rates are hidden from store owners.

Owners can submit quotation-review, destination/cargo-change, and cancellation requests in **Owner requests**. One request can await review at a time. Owners can withdraw it with an explanation. An urgent cancellation request can supersede an older quotation or shipment request, retaining both in the history. Requests leave the current instructions in force until a broker responds. Brokers see requests in their action queue and must approve and apply the change or decline with an explanation. Approved shipment changes require a fresh quotation; approved quotation reviews require a changed customer price and fresh acceptance. Cancelling after collection arranges a return to pickup rather than discarding cargo responsibility. The driver must record arrival at the return location, then enter the return receipt and receiving contact. Requests and broker decisions remain in the activity history and notify the relevant accounts.

## Delivery evidence policy

Evidence uploaded before pickup never qualifies, even when its timestamp matches pickup. Existing uploads without a pickup version remain available for review but cannot satisfy new completion checks; attach fresh proof for an active legacy trip.

Final delivery requires all intermediate stops completed, no unresolved exception, arrival recorded at the final destination, a delivery evidence file uploaded after that arrival and linked to the current delivery attempt, a receipt reference, and a recipient name. Upload a delivery photo, signature image, or receipt document under **Evidence files** (PNG, JPEG, or PDF, up to 2 MiB). Ten general evidence files are allowed, with a reserved completion-proof slot after final arrival when the general allowance is full. The server enforces these requirements and stores the evidence ID and SHA-256 hash, driver identity, arrival time, and confirmation time with the completion. A filename or typed name alone cannot complete delivery. These records document what the driver submitted; they do not independently verify recipient identity.

Offline drivers can queue arrival, file attachment, and delivery confirmation in that order after pickup. Evidence bytes remain in account-scoped local storage until replay; large files can exhaust browser storage. Completion remains provisional until the server accepts all actions. A stale assignment stops replay for review.

## Browser acceptance and CI

```sh
npx playwright install --with-deps chromium
npm run test:browser
```

The browser command builds the current frontend and runs sixteen acceptance cases covering the delivery lifecycle, account recovery/disable controls, first-broker onboarding, automatic quotation updates and owner requests, driver rate consent with assignment removal warnings, cancellation escalation with split-driver payouts, request-specific drafts and return navigation, and rescue handovers with fresh redelivery proof, each at desktop and mobile viewport sizes. It verifies native forms, navigation, cookie sessions, CSRF-protected mutations, exception resolution, delivery evidence, page errors and horizontal overflow. Playwright intercepts only HTTP transport and forwards every request to the real Node handler and an isolated SQLite database. It does not mock API responses. This allows the suite to run without opening an HTTP listening port; Chromium itself still needs normal OS process/IPC permissions.

Use `npx playwright test --list` to inspect the registered cases. Reports and failure screenshots/traces are written to `playwright-report/` and `test-results/`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` optionally selects an already installed compatible Chromium. Chromium requires normal OS process permissions; this managed workspace runs browser checks outside its process sandbox.

`.github/workflows/checks.yml` runs lint, formatting, unit/integration/property tests, live HTTP integration, the production build and desktop/mobile browser acceptance on pushes and pull requests. Scheduled and manual runs also exercise three recorded seeds that change daily, with 2,000 domain cases per property and 75 workflow scenarios per seed. Failure reports are uploaded as CI artifacts. The workflow has been written and checked locally; it has not been executed on GitHub from this workspace.

## Backup and restore

```sh
npm run backup -- data/yyc.sqlite backups/yyc-snapshot.sqlite
npm run restore -- backups/yyc-snapshot.sqlite data/yyc-restored.sqlite
```

Both destinations must be new files; commands refuse to overwrite an existing file or the source. Backup uses SQLite `VACUUM INTO` for a consistent snapshot, including committed WAL contents, and validates integrity and foreign keys. Snapshot files have mode 0600. Restore validates the snapshot, keeps accounts, password hashes, shipments, booking keys and audit records, and clears sessions and password recovery tokens.

Stop the running server before switching it to the recovered database:

```sh
DATABASE_PATH=data/yyc-restored.sqlite npm start
```

The recovery test backs up a live WAL database, creates a later delivery, restores to a new file, logs in with restored credentials, and compares accounts, completed deliveries, history and idempotent booking replay. It also proves old sessions and reset tokens cannot be revived. Tests never restore over the workspace database.

## Account recovery and broker controls

If the only broker loses access and no email delivery is configured, an operator can provision a second broker with the local `create-admin` command, then perform verified recovery through the Accounts page.

Brokers have an **Accounts** page for stores, drivers and other brokers. A reason is required to disable or re-enable an account. Disabling revokes sessions and reset tokens, withdraws unaccepted offers, and records an account audit event. Accepted jobs remain assigned for operational review. Brokers cannot disable their own account, and the last active broker is protected.

After verifying the account holder, a broker can create a one-time recovery link and share it through a verified private channel. Links expire after 30 minutes. Tokens are stored only as SHA-256 hashes and carried in a URL fragment, which the recovery page removes from browser history. Completing recovery changes the password, revokes all sessions and recovery tokens, and records an audit event. Disabled accounts cannot recover until re-enabled. A second use, an expired token or a superseded link is rejected.

The **Forgot password?** flow supports optional email delivery through an operator-configured HTTPS service:

- `PUBLIC_ORIGIN`: the real frontend origin, such as `https://workspace.example`.
- `RESET_DELIVERY_URL`: an HTTPS endpoint that accepts `{ email, resetUrl, expiresAt }` and delivers the message.
- `RESET_DELIVERY_TOKEN`: its bearer credential, supplied through the deployment's secret configuration.

No delivery service is configured by default. The public form then directs users to YYC for a broker-issued link instead of claiming to send an email. With a service configured, eligible and unknown addresses receive the same generic API response, and tokens are never returned publicly. Delivery failures invalidate the issued token and are logged without secrets. Recovery requests and password hashing are throttled. The delivery integration is tested with an injected callback; no real email was sent during development.

## Limits and recovery

Location sharing and document uploads are implemented. Online payment processing is not connected; billing records verified external transactions. Road routing requires the provider configuration below. Email recovery requires the optional delivery integration described above. The authenticated `/react/` workspace uses SQLite persistence.

The original package manifest, lockfile, ESLint configuration, formatting ignore file, and README contained only null bytes. Configuration was reconstructed from surviving frontend source and dependency metadata. The missing API was implemented against the surviving database schema; it is a new implementation, not a recovery of the original server. Original documentation and historical API behavior remain unavailable.

## Workflow regression checks

Run `npm run test:workflows` for generated shipment sequences, API regressions, and real React form tests in jsdom. `npm test` includes these checks and the scheduling properties; CI runs them automatically. Property failures report a reproducible seed; use `FC_SEED` and `WORKFLOW_FC_RUNS` to vary the generated workflow runs.

A driver can reserve future appointments, but can carry only one live delivery at a time. Pickup and in-transit handover acceptance check live cargo across all dates and windows. A pending in-transit handover also reserves the replacement driver's cargo slot until accepted, declined, or withdrawn. Regression cases check rejected writes leave shipment state unchanged and that released commitments permit progress.

Shipment action forms retain edited fields across version conflicts, including corrected quotes, replacement driver selections, and exception reports. Untouched fields follow refreshed server values. Drafts stay in memory, are scoped to the account, shipment, and action, and clear after confirmed submission, when the action becomes unavailable, or on logout. DOM regression tests exercise conflict and explicit retry against the real API handler. They complement the desktop/mobile Playwright suite; jsdom does not verify browser layout.

## Routing, recipient tracking, multiple stops and offline drivers

A delivery now supports up to 18 ordered intermediate pickups or dropoffs between its original pickup and final destination. Open **Route and stops → Edit intermediate stops**. Stores can edit before quotation; brokers can edit before pickup. Changing stops archives any previous quote, clears prices and assignment, and requires quotation and customer acceptance again. Cargo weight and pallet counts describe the maximum load for truck suitability. Drivers complete each intermediate stop in order with a receipt reference and recipient/releasing contact. Final delivery is blocked until all intermediate stops are complete. Stop evidence stays in the shipment audit trail.

For automatic road routing, configure both operator-managed HTTPS endpoints:

- `ROUTING_URL`: base URL of an OSRM-compatible driving router, without `/route/v1/driving`.
- `GEOCODING_URL`: full URL of a Nominatim-compatible search endpoint.
- `ROUTING_TOKEN`: optional bearer credential supplied to both services.

Addresses and recent driver coordinates are sent to those configured services only when calculating a route. Choose providers with suitable usage limits and coverage. No public routing endpoint is used by default. As an alternative to these two endpoints, configure the hosted ORS provider described below. **Calculate road route and ETA** returns road distance and driving duration through the remaining stops in their chosen order. **Open route in maps** opens navigation separately. GPS sharing automatically refreshes routing at most once per minute. A next-stop ETA is published only with a driver sample less than five minutes old; planned-address routing provides duration without inventing a current arrival time. Return route calculations require a recent driver GPS sample. A future manual ETA takes precedence over a GPS-based ETA until it expires or is cleared. Route calculations without GPS still provide distance and driving time. Estimates exclude live traffic, stop service times and truck-specific road restrictions. Progress and shipment revisions invalidate the previous route and ETA. Routing errors leave the delivery workflow available.

Brokers and booking stores can create or revoke a **Recipient tracking link**. Links expire in seven days and rotation invalidates the previous link. Recipients do not log in: they see shipment ID, status, pickup date/window, intermediate stop counts and next-stop ETA. They do not receive customer accounts, contact details, cargo, rates, files, other stop addresses or precise driver coordinates. Tokens are random, stored hashed in SQLite and carried in a URL fragment that the recipient page removes from history. Link lookups use a read-only POST to avoid putting secrets in API access logs. Backup restore revokes these links.

**Share current location** now runs at workspace level, so closing the delivery drawer or navigating between pages keeps the watch active. A visible workspace banner lets the driver stop sharing. Completion, lost assignment, account changes, session rejection and logout stop the watch. One recent location sample is buffered locally during a network interruption and discarded after five minutes. HTTPS and device location permission are required outside localhost. Browsers can suspend GPS when the phone locks or the browser closes; the native Android companion below provides a location foreground service independent of this browser watch, subject to Android lifecycle limits.

Driver job acceptance/decline, arrival, pickup, intermediate stop completion, delivery, failed attempts, exception reports, return confirmation and evidence attachments use a persistent per-account offline queue. The workspace shows pending actions as provisional until the server confirms them. Reconnection triggers ordered replay after checking the live session. Pickup arrival and collection use the saved device times during replay, so reconnecting after midnight does not turn an on-time pickup into an overdue one. Unique request keys make retries safe after a lost response, including evidence uploads; a version conflict or lost assignment pauses replay for that delivery while actions for other deliveries continue. The driver can discard a conflicting action and later actions for that shipment. No stale action is forced onto a changed delivery.

The production app caches its static shell with a service worker and the last driver workspace for up to 24 hours, allowing a previously loaded workspace to reopen offline. Queued actions remain scoped to the original account across reloads and logout; signing into another account cannot replay them. Logout clears the cached workspace and stops GPS. Browser storage must be available, and the queue is limited to 100 actions and the browser's storage quota; large evidence attachments can reach that quota sooner. An unsuccessful local save is shown as an error. Keep the device private until pending work is synced or discarded. First-time login, routing and recipient tracking require connectivity. Local DOM tests cover offline pickup/delivery replay, lost responses, stopped replay after a broker revision, recipient entry and location-watch lifetime; actual locked-phone background behavior is not claimed.

## Hosted routing and Android companion

Set `ORS_API_KEY` to an [openrouteservice](https://openrouteservice.org/) API credential to enable its hosted address search and directions together. The default profile is `driving-hgv`; set `ORS_PROFILE=driving-car` if required. This uses generic truck routing, without vehicle dimensions, axle loads, hazmat or live traffic. `ORS_BASE_URL` optionally selects another compatible HTTPS origin. The existing `ROUTING_URL`/`GEOCODING_URL` adapter remains available when no ORS key is set. ORS address results are cached for 24 hours with a bounded cache and concurrent lookup deduplication. Provider errors and quota exhaustion do not discard GPS samples or block the delivery workflow.

Copy `.env.example` to an untracked `.env`, supply your own provider credential and actual HTTPS `PUBLIC_ORIGIN`, then run `npm run start:configured`. No key is included or provisioned. Do not put provider keys in frontend code. Provider authentication and response handling are tested with injected HTTP responses; no paid/live provider request has been made here.

Automatic ETA calculation now runs on the **server** after browser or native phone GPS submissions, at most once per minute per delivery. The browser does not need to remain open for a native location submission to update the ETA. Old automatic ETAs are hidden from recipients when their sample or calculation becomes stale. Manual calculation remains available in the delivery drawer.

The native Android companion and build instructions are in [mobile/android/README.md](mobile/android/README.md). The driver can create a five-minute, one-time pairing code in an assigned delivery, pair the app, and explicitly start its foreground location service. Drivers and brokers can see paired phones, last connection times and revoke access from the delivery drawer. Device tokens are delivery-scoped and expire after seven days. The native app uses Android Keystore encryption, a persistent notification with Stop control, latest-sample retry buffering and authorization checks. Completion, assignment removal, account disabling, password recovery and restore revoke relevant device authorization.

Screen-lock and browser-independent tracking are implemented in the Android source, with Android lifecycle limits described in the mobile README. A local Android SDK build and real-phone acceptance have not been possible here; Gradle/SDK downloads fail DNS resolution. `.github/workflows/android.yml` defines an SDK build/lint job and debug APK artifact, but it has not been run on GitHub in this session. Do not treat the native source as a device-validated release or as a guarantee against Android force-stop, battery policy, permission removal, GPS/network loss or device shutdown.

## Guided handoffs and action queues

Dashboards now show a role-specific **Action required** queue, ordered with open exceptions and failed-delivery decisions first, followed by dispatch, quote review, and driver cargo tasks. All roles have a full action queue in navigation (the broker's **Work queue**). Waiting on another role and completed jobs are excluded from actionable queues. Driver guidance respects existing live-cargo commitments and approval holds.

Delivery cards and drawers explain the next step or current handoff, including quote/offer expiry times where applicable. Dispatch shows how many drivers meet the truck and schedule requirements and explains excluded drivers individually. These explanations do not change server authorization or bypass scheduling checks. Receipt fields and explicit stop evidence are still required for delivery completion.

A confirmed booking opens its new delivery for review and explains the quotation handoff. Shipment notifications link directly to a delivery only while it remains accessible to the signed-in account. DOM regressions exercise customer quote acceptance, broker failed-delivery handling, unsuitable-truck explanations, notification navigation and booking confirmation.

## Workflow recovery and handover payouts

Action and evidence retries first check the original account’s saved request result. A completed decline or upload can therefore be acknowledged after assignment access ends, including across server restarts, without restoring access to the delivery or repeating the action. Changed payloads and other accounts cannot replay that result. Expiry and withdrawal of offers clear orphaned driver-rate proposals.

Handover invoices require an explicit broker allocation across every driver who actually carried cargo. Shares must be nonnegative amounts in whole cents and total the agreed driver rate exactly. Every share needs an explanation, including zero shares. A sole cargo driver receives the full rate by default. Drivers see only their own allocation and payout entries; customer invoices do not expose the allocation.

In Billing, select a completed delivery, enter each cargo driver's share and reason, then issue the invoice. When posting a payout or payout reversal, select its allocated recipient. Per-driver balances prevent overpayment or excessive reversals. **Review driver payout shares** supports corrections, with invoice-version checks, duplicate-retry handling and retained allocation revisions. Reduce an already-paid allocation only after recording the verified payout reversal. When a posting response is lost, retry the same details in the same browser tab to reuse the pending entry key. These records do not transfer money.

Existing invoices and historical payments are preserved during migration. Existing handover invoices require broker review of all driver shares before further payouts. Legacy payout entries are attributed to their existing invoice driver. Review those records against actual transfers before reallocating.

## Exception and delivery-attempt rules

Broker decision drafts are scoped to a particular owner request. Refreshing the same request preserves edits; withdrawing or replacing it clears the old decision and explanation from the new request. A new decision must be selected before submission. Owner withdrawal drafts follow the same request scope.

During a return, external map navigation uses the pickup/return location as its destination, omits unfinished customer stops, and lets the navigation app choose the current origin. The itinerary shows completed historical stops and the return endpoint rather than presenting abandoned deliveries as upcoming work.

An open exception does not prevent a replacement from accepting a rescue handover. Acceptance transfers responsibility but does not resolve the exception: pickup, intermediate cargo completion, delivery, and return completion remain held until a broker records a resolution.

Failed delivery invalidates its previous route and ETA while preserving a pending rescue handover. Scheduling redelivery requires an active assigned driver and a resolved or withdrawn handover. Recipient tracking hides ETA during the failed state, automatic routing pauses, and manual ETA publication is blocked until redelivery or return is arranged. GPS sharing remains available so the broker can locate stranded cargo.

Pickup starts delivery attempt 1. Broker-arranged redelivery saves a separate appointment, starts a new attempt, clears arrival, and requires a fresh evidence upload for that attempt. Files from previous attempts or uploads made during a failed-delivery hold remain in history but cannot prove the new delivery. A reserved proof slot remains available for each new attempt even when earlier files filled the general allowance. Completion retains the attempt number alongside the proof reference.

Migration preserves unambiguous first-attempt files. Legacy retry files whose attempt cannot be determined remain available in history but require fresh proof for an active delivery. Verified payout reversals remain available during legacy allocation review; further positive payouts wait for the corrected split. Reversal balance limits, account permissions, idempotency and invoice-version checks still apply.
