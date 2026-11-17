# PWA delivery pilot

Status: automated rehearsal available; real-phone and real-delivery acceptance pending.
Android native development is deferred. This runbook tests the installed PWA in the
phone browser, not the native companion. No simulated result is a field pass.

## Prepare

1. Run `npm run pilot:check`. Use an isolated staging database and HTTPS origin.
2. Configure road routing and the existing notification delivery webhook if external
   delivery is required. In-app notifications work without a webhook. Verify the
   webhook destination with test accounts before using customer contacts.
3. Use one broker, two stores (one unrelated), and two approved drivers. Install the
   PWA from the browser's install menu. Record phone model, OS, browser/version,
   connection, precise/approximate permission and battery-saver state.
4. Agree on pickup, intermediate stops, final unloading time and acceptance windows.
   Share GPS explicitly; verify only the assigned driver can upload and only the
   owning store and brokers can read the delivery. An unrelated store must see no
   delivery, notification or GPS data. Never enter pilot GPS while driving; a
   passenger or dispatcher operates the phone.

## Phone reliability matrix

For each supported iPhone/Safari and Android/browser combination, record start/end
UTC, server last GPS timestamp, broker screenshot and outcome for every scenario.
Use the PWA's Stop control before switching test accounts.

| Scenario | Procedure | Expected result | Actual/evidence |
| --- | --- | --- | --- |
| Visible tracking | Start sharing and move safely for 10 minutes | Uploads about every 30 seconds; accuracy displayed | Pending |
| Permission denied | Deny location, then allow through site settings and restart | Clear instructions; no invented position | Pending |
| Screen lock | Lock for 10 minutes, return to PWA | Platform may pause GPS; last-known point becomes stale; sharing resumes visibly | Pending |
| Background tab | Switch apps for 10 minutes, return | No claim of continuous tracking; hidden/last-upload indicators are truthful | Pending |
| Battery saver | Repeat visible, hidden and locked checks with saver on/off | Record observed gaps; wake lock is optional and may be rejected/released | Pending |
| Short network loss | Disable network for 2 minutes, keep GPS active, reconnect | Latest valid sample retries; no duplicate cargo actions | Pending |
| Long network loss | Disable network for 7 minutes, reconnect | Samples older than 5 minutes are discarded; wait for fresh GPS | Pending |
| Wake lock | Enable Keep screen awake, switch away/return, then disable | Release/reacquire when permitted; GPS stop releases lock | Pending |
| Stop/logout/completion | Stop, logout, revoke assignment and complete a delivery separately | Watch and buffered location removed; rejected uploads stop sharing | Pending |
| Offline reload | Visit online, then reload offline | Cached shell opens; account APIs are not cached; connection status is explicit | Pending |

The PWA cannot promise GPS after screen lock or OS suspension. If a supported phone
cannot meet the business's required cadence, record that as a failed acceptance
criterion and keep native tracking as later work. Do not mark a paused PWA as a
continuous background tracker.

Platform references: [W3C Geolocation visibility requirements](https://www.w3.org/TR/geolocation/)
and [W3C screen wake lock behavior](https://www.w3.org/TR/screen-wake-lock/).

## Three supervised delivery runs

1. **Normal delivery:** request, quote, store approval, dispatch, driver acceptance,
   pickup, approaching arrival, receipt and completion. Verify pickup, approaching
   and completion messages only reach authorized accounts. Repeat worker runs;
   approaching notification must remain single. Compare estimated and actual times.
2. **Interrupted delivery:** short/long network loss and battery saver. Check GPS
   becomes stale/absent in the broker map. Acknowledge the alert, restore GPS, and
   confirm it clears. Check the unrelated store still cannot see the shipment.
3. **Exception delivery:** create an issue and delay beyond the planned arrival.
   Broker reviews and acknowledges alerts, resolves the issue and arranges the next
   action. Verify store delay message is not repeated on every refresh. Complete
   all required stops and receipt evidence before closing the job.

Use `Update mapped road route` to set per-pickup/intermediate-stop service minutes
and final unloading minutes. Check next-stop arrival, final arrival and completion
estimates separately. Estimates include the configured buffer, not live traffic.
If road routing fails, leave the estimate unavailable; do not substitute a mock ETA.

## Record and approve

Copy this record for each actual run. Do not put private addresses, coordinates,
tokens or recipient contacts in the repository; link evidence in restricted storage.

- Run ID, shipment ID, date/time and environment:
- Driver/store/broker participants (internal IDs):
- Phone/OS/browser and PWA installation status:
- Observed GPS gaps and network/battery conditions:
- Predicted vs actual pickup, final arrival and unloading completion:
- Notification counts and external delivery receipts:
- Alert acknowledgments, issue resolutions and authorization results:
- Restricted evidence link and unresolved defects:
- Result: **PENDING / PASS / FAIL**
- Driver, store and broker sign-off:

Release only after all required scenarios pass on supported phones, notification
delivery is confirmed, and participants accept the observed tracking limitations.
