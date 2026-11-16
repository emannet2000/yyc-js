# YYC Technical Operations Center — implementation roadmap

## Delivered in this branch
- Browser dashboard at `/sysadmin/` with a manual refresh control
- Session-authenticated, administrator-only read-only endpoints:
  - `GET /api/sysadmin/overview`
  - `GET /api/sysadmin/events`
  - `GET /api/sysadmin/incidents`
- SQLite integrity and foreign-key checks, session and shipment counts, runtime telemetry
- Existing shipment event audit timeline and exception views
- Authorization and telemetry regression tests

The current `admin` role is a brokerage administrator; it is **not** yet a dedicated technical administrator role. Access must be separated before exposing sensitive diagnostics to third-party brokers. Never publish diagnostic data or credentials. These endpoints deliberately provide no arbitrary SQL, shell, restart, or mutation functions.

## Phase 2 — security and incident foundation
- Separate technical administrator role and privileges, MFA and reauthentication
- Persistent incident records with lifecycle, acknowledgments, evidence, and audit
- Structured logging with request correlation and PII redaction
- Metrics retention, alert policies, service-level indicators and external uptime checks
- Backup freshness and independently tested restoration
- Test coverage for access control, pagination, failure modes and service shutdown

## Phase 3 — trucking reliability
- Driver GPS ingestion freshness, offline queues, sync conflicts and geofence checks
- Shipment integrity validators, event timelines, notification retries and dead-letter inspection
- Carrier compliance and operational impact analysis
- Trace booking/dispatch/notification dependencies and cost/usage monitoring

## Phase 4 — release and recovery
- Isolated staging workflow and load simulations (digital twin)
- Release readiness gates, migration checks, disaster drills and documented runbooks
- Approved, idempotent, audited recovery operations; no unrestricted server control
- Controlled feature flags and safe rollback processes

## Phase 5 — AI and advanced capabilities
- Read-only evidence-grounded diagnostic assistant with redaction
- Incident summarization, failure correlation, anomaly and capacity analysis
- Optional policy-constrained automated remediation only after extensive testing

## Current architecture caveat
This repository uses Node.js, React/TypeScript and **SQLite**, not PostgreSQL/Redis. Infrastructure dashboards for services not present in this repository must not display fabricated statuses. Production Render deployment and durable SQLite storage must be verified separately. A public URL must never be treated as authorization.

## Validation before merge
```sh
npm ci
npm test
npm run lint
npm run build
```
Then sign in with a broker administrator in a test environment and open `/sysadmin/`. Confirm store and driver sessions receive HTTP 403 from all SysAdmin endpoints. Review test results and deployment persistence before merging.
