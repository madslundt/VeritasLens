# Changelog

## 0.4.0 — 2026-05-20
- Discreet HUD split: dot-only before answer, full-screen Q+A after.
- Menu spinner: animated indicator while analysis runs.
- Pending-result stash: opening menu mid-check no longer drops the answer.
- Re-analyze from result screen animates again.
- Retries animate through the wait (R1/3, R2/3, R3/3); MAX_RETRIES 2→3.
- History list newest-first; lens name only shown for Auto entries.

## 0.3.1 — 2026-05-19
- Restore the clock on the menu page (regressed in 0.3.0).
- Rename host-exit-dialog call to `requestHostExitConfirm`.

## 0.3.0 — 2026-05-19
- Discreet HUD mode: hide REC, status, and bottom hint while a check is on screen so a bystander sees only the answer.
