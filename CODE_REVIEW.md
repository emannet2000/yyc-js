# Code review and fixes

The source review covered the React frontend, Zustand stores, shared types, HTML/CSS, build configuration, and SQLite structural integrity. The database passed its integrity check and contained no application records.

| Finding                                                        | Resolution                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing backend                                                | Added a Node HTTP server using the existing SQLite schema, registration/login/logout, session and CSRF checks, role/record authorization, broker provisioning, driver approval, profile updates, shipment actions, audit events, and static hosting. |
| API parsing loses HTTP errors                                  | Preserve HTTP status for HTML, empty, null, and JSON errors; accept empty success responses; reject malformed successful JSON.                                                                                                                       |
| Pickup arrival carries into delivery leg                       | Preserve pickup arrival separately and clear the current-leg arrival on pickup. The server implements this.                                                                                                                                          |
| Driver scheduling conflicts                                    | Check pickup-window reservations in the React selector, transactional server actions. Flexible windows overlap all windows on that date.                                                                                                             |
| Expired sessions block startup                                 | Clear authentication and present login for startup 401 responses. Network failures remain retryable.                                                                                                                                                 |
| Successful save looks unsuccessful after refresh failure       | Confirm the save, block more mutations until refresh succeeds, and leave booking forms after successful creation.                                                                                                                                    |
| Preview lacks assets and API                                   | Added preview proxies and a server that serves all production routes.                                                                                                                                                                                |
| No regression tests                                            | Added frontend/store and backend regression tests, including persistence and authorization checks.                                                                                                                                                   |
| Formatting failures                                            | Applied the configured formatter and expanded the formatting check to maintained source and documentation.                                                                                                                                           |
| Booking retries can duplicate records                          | Require account-scoped request keys and store their payload hash and booking ID atomically in SQLite. The frontend retains uncertain requests across tab reloads. Replays survive server restarts; changed payloads conflict.                        |
| Login limits lock out shared connections                       | Limit each normalized account/address pair separately. Other accounts' successful logins cannot reset a blocked account's counter.                                                                                                                   |
| Fractional pallet inputs conflict with server rules            | Pallet fields require safe positive integers; weight fields accept positive fractions and quote fields require whole cents. React fields use matching numeric constraints.                                                                           |
| Failed conflict recovery leaves stale controls enabled         | Block further mutations until refresh succeeds and distinguish conflict messages from successful-save messages. Expired sessions return to login.                                                                                                    |
| State requests query and load unrelated records                | Apply role filters in SQL, join account names and truck profiles, batch audit history, and index ownership, offers and audit lookups. Actions load only their target and relevant commitments.                                                       |
| Stale responses restore logged-out data                        | Session revisions guard boot, refresh, save and error handling. Logout invalidates reads before its POST finishes, and newer refresh responses take precedence.                                                                                      |
| Registration hashes duplicate requests without limits          | Check email/plate uniqueness before hashing and again transactionally, throttle registration by connection address, and cap concurrent registrations at four.                                                                                        |
| Fractional-cent quotes display a different amount              | Validate exact positive cent amounts on the server and in React; use cent steps in the UI. Invalid requests leave shipment versions and audit history unchanged.                                                                                     |
| Malformed URLs and origins produce HTTP 500                    | Catch URL decoding/parsing errors as HTTP 400 and reject invalid or opaque origins as HTTP 403.                                                                                                                                                      |
| Inherited object keys can bypass conservative window conflicts | Property tests reduced a failure to prototype names such as `toString`. Window lookup now accepts only own properties.                                                                                                                               |

The earlier review inferred overlapping bookings from two active jobs whose seeded pickup windows actually differed. The corrected regression explicitly puts jobs in the same window to verify rejection and separately verifies that disjoint windows remain bookable.

## Validation scope

`npm test` exercises the actual HTTP request handler in memory, since the managed environment disallows binding localhost sockets. `YYC_LIVE_TESTS=true npm test` enables live HTTP tests elsewhere. Build, lint, and formatting checks cover the maintained source.

Automated desktop/mobile browser workflows exercise native forms and layout. A full accessibility audit and a public network deployment remain unverified. Road routing, GPS sharing and uploads are now implemented as described in README.md. Email and routing require configured delivery/provider integrations; payments remain an external ledger. The reconstructed shared type contract and new API cannot be compared with the unavailable historical backend.

## Operational additions

- Added a reusable real-handler test fixture and a generated API workflow property with independent transition modeling, authorization checks, monotonic versions, persisted rollback and booking replays.
- Added SQLite snapshot and offline restore commands, exclusive destination publishing, integrity/foreign-key validation, token/session invalidation on restore, and a live-WAL recovery test.
- Added broker account enable/disable and one-time password recovery, optional configured delivery, audit events, expiry/replay/concurrency tests and session revalidation after reading write bodies and password verification.
- Added desktop/mobile Playwright acceptance cases for the delivery lifecycle and account recovery/disable flows. The expanded suite contains sixteen cases across desktop and mobile. Local Chromium runs require execution outside the process sandbox. GitHub CI installs its own browser and runs them.
- Added CI checks for pushes and pull requests, plus scheduled/manual varied-seed domain and workflow property runs. CI is configured in source but has not run on GitHub from this workspace.

## Delivery workflow corrections

- Disabled-driver trips can now be handed over to an approved replacement with explicit driver acceptance. Quote and cargo details and pickup progress are preserved, and offers can be declined or withdrawn. Disabling a proposed replacement or completing the trip clears its pending handover.
- Quote-only corrections before pickup archive prior prices and require fresh customer acceptance, without artificial cargo changes. Stale, unauthorized, invalid, post-pickup and terminal corrections are rejected.
- Delivery evidence drafts survive version-conflict remounts, drawer closure and a later manual refresh. Drafts remain account-scoped in memory and are removed after completion, lost assignment or logout. New actual-frontend DOM regressions verify conflict/retry behavior without claiming a browser run.

## Additional workflow regressions

Automated reproductions exposed concurrent live cargo being allowed when appointment windows or dates differed, and shipment action fields being lost after version conflicts. Shared live-cargo checks now guard pickup and both stages of an in-transit handover, including pending transfer reservations. Future appointment reservations remain supported. API regressions check rollback and recovery after delivery or transfer withdrawal; generated properties vary cargo ownership, status, dates, and windows.

Shipment action forms now retain only edited fields in account-scoped memory through refresh/remount. Real React/jsdom tests reproduce conflicts for quote corrections, replacement selection, and issue reports, then explicitly retry against the API. Additional store tests verify draft pruning and account privacy. Run `npm run test:workflows` for the focused workflow suite; the default test command and CI include these regressions automatically.

## Milestone audit follow-up

Two additional regression cases returned success before the fix: pickup while an exception remained unresolved, and a second arrival overwriting the current leg's timestamp and adding duplicate audit history. Pickup now rejects an open exception with HTTP 409 until broker resolution. A repeated arrival also returns 409 with no shipment, version, or history changes. Pickup preserves the first arrival as `pickupArrivedAt` and enables a separate delivery-leg arrival. Driver controls reflect both guards. API and React DOM regressions verify the hold, resolution, both arrival legs, and rejected-write rollback; the generated workflow model includes the same restrictions.

## Shared-session refresh follow-up

A second login in another tab replaces the browser's session cookie. Previously, refreshing the first tab loaded the current workspace but kept the previous CSRF token, so saves still failed with 403. Refreshing into a different account also retained the previous account's navigation and selected delivery. Reproductions cover same-account session replacement and switching accounts.

The state response now pairs the workspace with its current session CSRF token. Accepted refreshes synchronize that token, invalidate responses from the prior session, and clear navigation and private drafts on an account change. Startup tracks an accepted session replacement so it finishes loading normally. API-backed React regressions verify that Refresh restores quotation acceptance and that only the new account's delivery changes; store tests cover old responses, pending writes, draft cleanup, and startup.

## Role handoff corrections

Assignment-changing actions now notify former drivers as well as current participants. Visible workspaces poll every ten seconds, refresh on focus/reconnect, and warn drivers persistently when assignment responsibility changes. Driver rate proposals preserve customer acceptance and require the selected driver's consent. Owner requests provide broker-approved quotation, shipment, and cancellation/return flows. First-broker onboarding requires an expiring operator-issued token, consumed atomically. Delivery completion requires final arrival and a post-pickup evidence file, with proof metadata retained. API, actual-frontend DOM, offline replay, and browser tests cover these handoffs.

## Recovery and settlement fixes

- Saved action/evidence results are checked before current shipment visibility, scoped to the original account and exact request. Lost decline/upload responses can replay after access removal or restart.
- Evidence carries the pickup version. Equal timestamps cannot qualify pre-pickup evidence, and a reserved completion-proof slot avoids the ten-file deadlock. Legacy evidence is preserved but does not qualify as current proof.
- Expired/withdrawn offers clear orphaned rate proposals; owner requests support withdrawal and urgent cancellation supersession.
- Cargo-driver payout allocations require explicit cent-exact shares after handover, with private per-driver balances, recipient-specific postings/reversals, immutable revision records and protection for amounts already paid. Legacy invoices and entries migrate without losing existing payments; handover allocations require review.
- API, migration, DOM and desktop/mobile browser regressions exercise the recovery paths and split-driver financial forms.

## Request, return, and attempt isolation

- Owner-request response and withdrawal drafts include the request ID, are pruned when requests change, and require a fresh explicit broker decision for a new request. Same-request conflict recovery is retained.
- Return navigation removes unfinished delivery waypoints and uses the device's current origin. Return itineraries retain completed history and show the correct return endpoint.
- Legacy allocation review permits validated payout reversals while continuing to block new payouts until all cargo drivers are allocated.
- Rescue handover acceptance matches the API while preserving unresolved cargo holds.
- Failed delivery clears ETA/route, masks stale legacy estimates, pauses automatic routing and disables manual ETA publication until a broker arranges the next action.
- Evidence is bound to pickup and delivery attempt. Redelivery requires fresh arrival and proof, with a reserved upload slot per attempt and conservative migration of ambiguous historical evidence.
- Focused API, migration, actual React DOM and desktop/mobile browser cases reproduce the six exception paths.
