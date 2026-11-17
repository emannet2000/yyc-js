# YYC Brokers delivery workspace

React and TypeScript frontend, Zustand stores, and a Node.js HTTP API backed by SQLite. Includes a separate fictional screen demo.

## Setup and development

Requires Node.js 22.13 or newer and npm. Node 22 may print an experimental SQLite warning.

```sh
npm ci
npm run dev
```

This starts the API on `http://127.0.0.1:3000` and Vite on its displayed URL. Open the Vite URL at `/react/`, or the screen demo at `/demo/`. Register a store or driver in the frontend. Driver and truck registrations need broker approval.

Create a broker account once, from a separate terminal:

```sh
read -r -p 'Broker email: ' ADMIN_EMAIL
read -r -s -p 'Broker password (12–128 characters): ' ADMIN_PASSWORD
export ADMIN_EMAIL ADMIN_PASSWORD
npm run create-admin
unset ADMIN_PASSWORD ADMIN_EMAIL
```

Public registration cannot create broker accounts. There are no built-in accounts or passwords. `ADMIN_NAME` and `ADMIN_PHONE` can also be set when creating the broker.

The default database is `data/yyc.sqlite`. Set `DATABASE_PATH` to use another file; parent directories and an empty schema are created automatically. Existing rows are preserved. Tests use isolated databases and never change the workspace database.

## Production build and local serving

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3000/react/`. The Node server serves the API, production frontend, logo assets, and demo. The root URL redirects to `/react/`. `HOST` and `PORT` configure the listener; it binds to localhost by default. For HTTPS deployments, set `COOKIE_SECURE=true` and preserve the original Host header through the reverse proxy.

For Vite preview, run `npm start` in one terminal and `npm run preview` in another. Both Vite development and preview proxy `/api`, `/assets`, and `/demo` to the API server on port 3000. If you change the API port, update the proxy target in `vite.config.ts`.

## Checks

```sh
npm test
npm run lint
npm run format:check
npm run build
```

Tests cover stale responses across logout and login, registration throttling and concurrency, quote cent precision, malformed URLs/origins, API decoding, booking retries after lost responses and server restarts, per-account login limits, constant database query counts, numeric input constraints, session expiry handling, save/refresh failures, demo exceptions and arrival milestones, account isolation, CSRF, approvals, version conflicts, shipment revisions, delivery completion, scheduling, static routes, and persistence across database reopening. The HTTP handler runs in memory by default so tests work without listening on sockets. Run `YYC_LIVE_TESTS=true npm test` to exercise the same API tests over localhost where socket access is permitted. Demo tests execute the actual classic scripts with a minimal DOM stub; they do not replace a visual browser review.

`npm run test:property` runs nine fast-check properties plus an API workflow property. The workflow property generates mixed valid and invalid action sequences against isolated SQLite databases, compares results with an independent state model, checks persisted rollback, and replays booking request keys. Set `WORKFLOW_FC_RUNS` (default 25) to control its scenario count. The nine domain properties cover money, window overlap, driver availability, and modeled login/registration request sequences. Each domain property generates 500 cases using a deterministic seed, and fast-check shrinks failures to a smaller counterexample. Property tests also run with `npm test`.

To explore a different sequence or increase coverage:

```sh
FC_SEED=12345 FC_RUNS=2000 WORKFLOW_FC_RUNS=75 npm run test:property
```

Failures report their seed and shrink path. Re-run with that seed and use Node's `--test-name-pattern` option to select the failing property if needed. The limiter models use a bounded set of accounts and addresses; they test limits, expiry, reset and release behavior, not the 10,000-entry storage-cap policy.

`npm run lint` checks frontend, shared, server, test, and development-launcher code, plus syntax of the combined demo scripts. `npm run format` applies formatting to maintained source and documentation.

## Workflow behavior

Store owners request delivery; brokers issue a quotation; the store accepts it; a broker offers the job to an approved, suitable, available driver; the driver accepts, records arrival and pickup, then records delivery evidence. An unresolved issue blocks completion until a broker records a resolution. Revisions archive the previous quotation and clear acceptance and assignment. Version checks reject stale changes.

Brokers can **Correct quotation** before pickup without changing shipment details. A correction requires a reason and changed cent amounts, archives the previous quote, clears any assignment or pending offer, and returns the delivery to **Quote ready**. The customer must accept the corrected version before a driver can be offered the job. Corrections are rejected after pickup.

For an assigned or in-transit job, **Arrange driver handover** offers responsibility to an approved, suitable replacement using the existing pickup-window reservation model. The old driver stays assigned until the replacement explicitly accepts. Acceptance preserves pickup progress, shipment details and the accepted customer quote; an in-transit delivery stays in transit. The broker must arrange the physical cargo transfer and record the reason. Replacement drivers can decline, brokers can withdraw an offer, and disabling a pending replacement withdraws the offer without cancelling the trip. A disabled original driver does not need to be re-enabled for an accepted replacement to finish delivery. Completed trips cannot be handed over.

Delivery receipt and recipient drafts are kept in memory per signed-in driver and shipment. A version conflict refreshes the record but preserves the draft for review and explicit resubmission. If that refresh fails, the drawer can be closed, the workspace refreshed, and the draft reopened. Drafts are removed on completion, lost assignment, logout or account changes; they do not survive a full page reload. The DOM regressions compile the actual frontend in memory and run these interactions against the real API with jsdom; they do not replace visual browser acceptance.

Offers and accepted jobs reserve their pickup date and window. Flexible windows conflict with every other window on that date. Distinct morning and afternoon windows can be reserved separately. This is a pickup-window reservation model; it does not calculate route duration or travel time.

A successful save followed by a failed state refresh is reported as saved. A version conflict followed by a failed refresh is reported as a conflict. In both cases, further changes are blocked until refresh succeeds; booking forms navigate away after successful creation.

Booking creation requires an `Idempotency-Key` header (16–128 letters, digits, underscores, or hyphens). The frontend generates this key and retains uncertain requests in tab session storage, scoped to the user and exact booking details. Retrying the same request after a lost response returns the original booking, even after server restart. Reusing a key with different details returns HTTP 409. Once the frontend acknowledges a successful booking, a deliberate repeat uses a new key. With browser storage disabled, retry keys last for the current page only.

Login limits track each normalized email and connection-address pair for 15 minutes. Failed logins for one account do not lock unrelated accounts behind the same proxy. Forwarded IP headers are not trusted.

Registration accepts up to 20 attempts per connection address per 15 minutes and allows at most four registrations to hash passwords concurrently. Duplicate emails and truck plates are checked before hashing and checked again in the insertion transaction. Broker provisioning through the local command is separate from public registration limits.

Customer prices and driver rates must be positive amounts in whole cents. The API rejects fractional cents rather than silently rounding them. Weight fields can still accept fractions.

Session changes invalidate outstanding workspace and startup requests. A delayed response or error from an old session cannot restore logged-out data, replace a new account's state, or overwrite its CSRF token. Malformed URL encodings return HTTP 400; malformed, opaque, or disallowed origins return HTTP 403.

State reads filter shipments by the signed-in account in SQL, join names and truck profiles, and fetch history in one batch. Query counts stay constant as records grow; action requests read only the target shipment and relevant driver commitments.

## Browser acceptance and CI

```sh
npx playwright install --with-deps chromium
npm run test:browser
```

The browser command builds the current frontend and runs desktop and mobile viewport acceptance cases for the delivery lifecycle, account recovery, PWA offline shell and browser GPS. Workflow cases forward transport to the real Node handler and isolated SQLite. PWA cases use a loopback server to exercise the actual service worker, manifest and offline reload. Browser GPS coordinates are supplied by Playwright; this does not prove behavior on a locked physical phone. Chromium and the loopback server need normal OS process/network permissions.

Use `npx playwright test --list` to inspect the registered cases. Reports and failure screenshots/traces are written to `playwright-report/` and `test-results/`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` optionally selects an already installed compatible Chromium. In this managed workspace, browser downloads failed DNS resolution; an npm-packaged Chromium fallback downloaded, but its launch failed with an OS `Operation not permitted` error. The suite is authored and discovers all four cases; local browser execution remains unverified.

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

Location sharing and document uploads are implemented. Online payment processing is not connected; billing records verified external transactions. Road routing requires the provider configuration below. Email recovery requires the optional delivery integration described above. The `/demo/` screens use fictional, in-memory records, and changes reset on refresh. The authenticated `/react/` workspace uses SQLite persistence.

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

Addresses and recent driver coordinates are sent to configured road services when calculating a route. No public demo routing endpoint is used by default. **Calculate road route and ETA** returns road distance and driving duration through the remaining stops; **Open route in maps** opens navigation separately. GPS sharing refreshes routing at most once per minute. A next-stop ETA requires a driver sample less than five minutes old; planned-address routing provides duration without inventing an arrival time. Manual ETA remains available. Mapped route controls accept whole service minutes per pickup/intermediate stop and final unloading minutes (0–240 each), retained across automatic route refreshes. Final arrival includes driving, the configured travel buffer and remaining stop service; completion additionally includes unloading. The map shows the calculation time and component minutes. Estimates exclude live traffic and do not certify truck-specific restrictions. Progress invalidates route/arrival/completion estimates. Routing errors leave delivery actions available.

Brokers and booking stores can create or revoke a **Recipient tracking link**. Links expire in seven days and rotation invalidates the previous link. Recipients do not log in: they see shipment ID, status, pickup date/window, intermediate stop counts and next-stop ETA. They do not receive customer accounts, contact details, cargo, rates, files, other stop addresses or precise driver coordinates. Tokens are random, stored hashed in SQLite and carried in a URL fragment that the recipient page removes from history. Link lookups use a read-only POST to avoid putting secrets in API access logs. Backup restore revokes these links.

**Share current location** runs at workspace level, so closing the drawer or navigating pages keeps the watch active. The banner shows the last successful GPS upload and warns when the PWA is hidden. Completion, lost assignment, session rejection and logout stop the watch. One recent sample is buffered during a network interruption and discarded after five minutes; reconnecting or returning to the PWA retries valid buffered data. HTTPS and location permission are required. Optional **Keep screen awake** requests a screen wake lock while visible and releases it on hiding or stopping. Devices can reject or release it, including under battery saver. Screen lock, browser closure and OS suspension can pause PWA GPS; continuous background tracking is not guaranteed.

Driver job acceptance/decline, arrival, pickup, intermediate stop completion, delivery, failed attempts, exception reports, return confirmation and evidence attachments use a persistent per-account offline queue. The workspace shows pending actions as provisional until the server confirms them. Reconnection triggers ordered replay after checking the live session. Unique request keys make retries safe after a lost response, including evidence uploads; version conflicts or lost assignments stop replay for explicit review. The driver can discard a conflicting action and later actions for that shipment. No stale action is forced onto a changed delivery.

The production app caches its static shell with a service worker and the last driver workspace for up to 24 hours, allowing a previously loaded workspace to reopen offline. Queued actions remain scoped to the original account across reloads and logout; signing into another account cannot replay them. Logout clears the cached workspace and stops GPS. Browser storage must be available, and the queue is limited to 100 actions and the browser's storage quota; large evidence attachments can reach that quota sooner. An unsuccessful local save is shown as an error. Keep the device private until pending work is synced or discarded. First-time login, routing and recipient tracking require connectivity. Local DOM tests cover offline pickup/delivery replay, lost responses, stopped replay after a broker revision, recipient entry and location-watch lifetime; actual locked-phone background behavior is not claimed.

## Hosted routing and deferred Android companion

Set `ORS_API_KEY` to an [openrouteservice](https://openrouteservice.org/) API credential to enable its hosted address search and directions together. The default profile is `driving-hgv`; set `ORS_PROFILE=driving-car` if required. This uses generic truck routing, without vehicle dimensions, axle loads, hazmat or live traffic. `ORS_BASE_URL` optionally selects another compatible HTTPS origin. The existing `ROUTING_URL`/`GEOCODING_URL` adapter remains available when no ORS key is set. ORS address results are cached for 24 hours with a bounded cache and concurrent lookup deduplication. Provider errors and quota exhaustion do not discard GPS samples or block the delivery workflow.

Copy `.env.example` to an untracked `.env`, supply your own provider credential and actual HTTPS `PUBLIC_ORIGIN`, then run `npm run start:configured`. No key is included or provisioned. Do not put provider keys in frontend code. Provider authentication and response handling are tested with injected HTTP responses; no paid/live provider request has been made here.

Automatic ETA calculation now runs on the **server** after browser or native phone GPS submissions, at most once per minute per delivery. The browser does not need to remain open for a native location submission to update the ETA. Old automatic ETAs are hidden from recipients when their sample or calculation becomes stale. Manual calculation remains available in the delivery drawer.

The current mobile product is the **PWA**, for drivers and store owners on supported phone browsers. Android native work is deferred and its pairing controls are hidden from the PWA. Existing native source and API tests remain for later development at [mobile/android/README.md](mobile/android/README.md); they are not a current field-validated release.

Screen-lock and browser-independent tracking are implemented in the Android source, with Android lifecycle limits described in the mobile README. A local Android SDK build and real-phone acceptance have not been possible here; Gradle/SDK downloads fail DNS resolution. `.github/workflows/android.yml` defines an SDK build/lint job and debug APK artifact, but it has not been run on GitHub in this session. Do not treat the native source as a device-validated release or as a guarantee against Android force-stop, battery policy, permission removal, GPS/network loss or device shutdown.

## Guided handoffs and action queues

The dashboard and tracking page include a delivery selector and an interactive
OpenStreetMap showing the selected driver's last shared GPS position. Delivery details
also embed the map. Positions refresh approximately every 30 seconds and are marked
stale after five minutes. Drivers must enable location sharing for an active assignment;
missing positions and failed requests show an explicit status. Existing shipment access
checks apply to every location request. The map uses
[Leaflet raster tiles](https://leafletjs.com/examples-v1/quick-start/) and HTML markers,
so it does not require WebGL or canvas. Internet access is required for OpenStreetMap
tiles; tile requests reveal the displayed area, without shipment identifiers or
credentials. No API key is needed. Calgary remains visible when GPS is unavailable.

On a phone, drivers can select an assigned delivery and tap **Share phone GPS** on
the dashboard map, then allow the browser's location request. HTTPS is required
outside localhost. High-accuracy GPS samples are uploaded at most every 30 seconds;
the map refreshes after each successful upload. **Stop sharing phone GPS** stops
the watch. Keep the browser open; locking or closing the phone can suspend updates.
Brokers and stores view the authorized driver position without sharing their own GPS.
Dragging the map pauses following; **Recenter on driver** resumes it.

**Refresh location** checks the selected delivery immediately and shows the last
successful check time. Offline viewers keep the last received position with an
offline notice; reconnection checks for updates automatically. Position age updates
even without new GPS samples: after five minutes the marker turns amber. Accuracy
worse than 100 metres displays a warning alongside the reported accuracy.

The selected delivery summary shows its driver, current status, pickup, destination,
next stop, delivery window and open issue. **Open mapped delivery** opens the same
delivery's details. **Enlarge map** expands the map to 75% of the viewport height;
**Reduce map** or Escape restores its size. A saved arrival estimate appears when
one is available, with its update time; it is not recalculated by the map.

Brokers can switch to **Fleet view** to show the latest shared location per driver
among the currently filtered active deliveries. Markers and the driver list open
their associated delivery. **Fit all drivers** restores the fleet overview after
panning. Locations refresh every 30 seconds; stale positions are amber and missing
GPS positions are not plotted. The broker-only `/api/fleet/tracking` endpoint returns
up to 500 active deliveries and reports when its result is truncated. Store and
driver sessions cannot use this endpoint or the fleet view.

Within the broker fleet view, search by driver, delivery reference, pickup or
destination. The GPS filter separates recent, stale and missing positions. Drivers
without GPS remain in the list with an **Open delivery** action, but have no map
marker. Counts distinguish located drivers, stale positions and drivers without
GPS; search and GPS filters apply to both the map and list. **Clear fleet filters**
restores the fleet within the dashboard's existing delivery filters.

Maps use the existing three roles: brokers (`admin`), drivers/truck owners (`driver`),
and stores/store owners (`store`). Drivers have a next-stop navigation link and route
calculation controls. Brokers retain dispatch and fleet monitoring. Store owners can
select bookings before assignment and see progress and next-step guidance without
GPS upload or route calculation controls. Saved GeoJSON road routes are drawn in
blue with a **Fit road route** control when their shipment version matches; invalid
geometry and routes for older shipment versions are omitted. Road routing still
requires the configured server-side provider. No road geometry is invented when
that provider is unavailable.

## PWA delivery reliability and operations

The install manifest and service worker provide a standalone PWA and offline shell.
Cache Storage contains static shell assets, never account API responses. Existing
driver-only offline workspace/action storage remains scoped to its account.

Brokers see missing GPS after a five-minute assignment grace period, stale GPS,
overdue planned arrival, and unresolved delivery issues in **Delivery alerts**.
Acknowledgments persist in SQLite with the broker and time; they do not resolve
the issue. Refreshed GPS or resolved shipment conditions remove the corresponding
active alert. New stale GPS evidence requires a new acknowledgment. Stores and
drivers cannot read or acknowledge broker alerts.

Pickup and completion updates use the existing notification/audit workflow.
The 30-second maintenance worker also sends store owners a deduplicated approaching
arrival message (fresh GPS/estimate within 15 minutes, final leg, no open issue)
and a delay message when a deadline/last planned arrival has passed. These signals
are recorded transactionally to avoid duplicate messages after retries or restarts.
In-app delivery works without credentials. External delivery requires the existing
configured `NOTIFICATION_DELIVERY` webhook and its verified recipient transport;
no new SMS/email provider or live recipient messages are provisioned by this change.

Run `npm run pilot:check` for the automated PWA rehearsal and `npm run test:browser`
for desktop/mobile browser checks. Field acceptance, including actual phone lock,
battery saver and three supervised deliveries, is recorded separately in
[PWA_PILOT_RUNBOOK.md](PWA_PILOT_RUNBOOK.md). Those field checks remain pending until
performed on the supported devices and deployment.

Dashboards now show a role-specific **Action required** queue, ordered with open exceptions and failed-delivery decisions first, followed by dispatch, quote review, and driver cargo tasks. All roles have a full action queue in navigation (the broker's **Work queue**). Waiting on another role and completed jobs are excluded from actionable queues. Driver guidance respects existing live-cargo commitments and approval holds.

Delivery cards and drawers explain the next step or current handoff, including quote/offer expiry times where applicable. Dispatch shows how many drivers meet the truck and schedule requirements and explains excluded drivers individually. These explanations do not change server authorization or bypass scheduling checks. Receipt fields and explicit stop evidence are still required for delivery completion.

A confirmed booking opens its new delivery for review and explains the quotation handoff. Shipment notifications link directly to a delivery only while it remains accessible to the signed-in account. DOM regressions exercise customer quote acceptance, broker failed-delivery handling, unsuitable-truck explanations, notification navigation and booking confirmation.
