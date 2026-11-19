# Data retention policy (draft for approval)

Status: **DRAFT.** These periods are proposals. The business must approve them,
and counsel or your accountant should confirm them against your legal duties
before the app handles real customer data.

| Data | Proposed period | Enforced in the app today |
|---|---|---|
| Driver location history (GPS samples) | 90 days after recording | Yes. `LOCATION_HISTORY_DAYS` (default 90), pruned hourly. |
| Latest driver location for a delivery | Until the delivery closes, then removed | No. Kept with the delivery record. |
| Delivery records, activity history | 6 years after completion | No. Nothing is deleted automatically. |
| Evidence files (photos, signatures, receipts) | 6 years after completion | No. Kept with the delivery record. |
| Invoices, payments, payouts (ledger) | 6 years after the transaction | No. Ledger entries are never deleted by the app. |
| Account audit records | 6 years | No. Kept. |
| Sign-in sessions | 8 hours | Yes. |
| Password reset and setup tokens | 30 minutes, single use | Yes. |
| Driver pairing codes (Android) | 5 minutes, single use; device authorisation 7 days | Yes. |
| Database backups | Last 14 snapshots (`BACKUP_KEEP`) | Yes. Backups hold all data, so they must follow the same policy. |

## Why six years

Business and tax records are generally kept for six years in Canada. The
period above is a common proposal, not a legal finding. Confirm it with your
accountant or counsel.

## Actions still needed

1. Approve or change each period.
2. Decide whether delivery records should be deleted, or anonymised, after the
   period. The app does not do this yet.
3. Set `LOCATION_HISTORY_DAYS` to the approved value.
4. Tell drivers and recipients what location data is kept and for how long.
