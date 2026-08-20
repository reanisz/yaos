# Documentation Archive

This directory preserves completed plans, time-bounded verification, technical
spikes, and historical records. Archive documents are evidence and provenance,
not current engineering direction.

For current architecture, engineering work, RFCs, and QA procedures, start at
the [documentation index](../README.md).

This is the only index in the archive: every archived file is listed below, so
the tree cannot drift out of sync with a nested index. Files marked **residue**
still name work nobody has closed — read those lines before assuming the whole
document is history.

## Plans and spikes

- [Autophagy plan](autophagy-plan.md) — cleanup charter that merged as PR #54.
  **Residue**: three out-of-scope follow-ups (wire `findCanonicalPathCollisions`
  into disk scan and reconcile admission, migrate `.normalize("NFC")` call sites
  to `canonicalPath`, case-folding product decision) and the lint baseline debt
  (~139 errors, ~12 warnings) whose burn-down is unowned.
- [Sync invariants draft](sync-invariants.md) — 2026-05-09 inventory turning the
  sync contract into ~35 `INV-*` rules with a reason-code registry.
  **Residue**: [`rfcs/sync-contract.md`](../rfcs/sync-contract.md) still gates
  its promotion to `Accepted v1` on this document, and the per-rule statuses here
  are the 2026-05-09 pass — cross-check `docs/engineering/` before trusting one.
- [Server acknowledgement spike](server-ack-spike.md) — the six protocol
  questions behind the `__YPS:` state-vector echo; Q1–Q5 resolved.
  **Residue**: Q6 (echo cost) is deferred pending post-deploy measurement, and
  `server/src/svEcho.ts` points here with an instruction to re-run the spike if
  `y-partyserver` moves off 2.1.2.
- [Memory footprint](memory-footprint.md) — superseded. The warm-rope memory
  thesis did not survive production measurement; kept for the measurement
  methodology (`external` vs `heapUsed`). Current model:
  [architecture/monolith.md](../architecture/monolith.md).

## Audits

Dated audit, verification, and remediation evidence. These must not be read as
current release or architectural status.

- [Autophagy remediation status](audits/autophagy-remediation-status.md) — the
  authoritative closure record for the audit chain below: 11 findings resolved,
  1 partial (TraceSink migration), 7 explicitly deferred. **Residue**: those
  7 deferred findings.
- [Autophagy audit report](audits/autophagy-audit-report.md) — first pass over
  the 39-commit range; verdicts and an 8-step salvage order. Dispositioned by
  the remediation status.
- [Autophagy secondary review](audits/autophagy-audit-report2.md) — independent
  second pass; every claim PARTIAL. **Residue**: 10 numbered high-priority
  action items, plus the hardcoded `hashMismatches=0` diagnostic and the missing
  clean `workspace.json` in prepare-vault.
- [Autophagy evidence ledger](audits/autophagy-ledger.md) — claim-to-commit map
  and risk classification. **Residue**: release CI skipping the strict bundle
  guard is recorded here and closed nowhere.
- [Sync verification v0.5](audits/sync-verification-v0.5.md) — 2026-05-09
  verification of priority invariants against code. **Residue**: 10 Phase-1
  release-gate blockers, two verified violations (pre-auth durable trace writes,
  diagnostics carrying full vault paths), and 18 invariants never examined.

## QA history and completed runbooks

Current reusable procedures live in [QA documentation](../qa/README.md).

- [Mobile QA checklist](qa/mobile-qa-checklist.md) — the "holy QA" two-device
  crucible: Run A (schema v1→v2 migration drill, mixed-version guard) and Run B
  (pairing, hydration, live collaboration, attachment stress, checkpoint
  truncation, snapshot restore, storage pressure). Both complete and passing for
  v1.0.0 scope. Its procedures are synthesised into the current
  [mobile testing guide](../qa/mobile-testing.md).
- [QA history](qa/qa-history.md) — chronological record of what broke and what was
  fixed, with the six major issues and their root causes.
  **Residue**: four optional post-v1 empirical items (mobile churn soak,
  low-storage device matrix, oversize-attachment copy, third-vault recovery kit)
  and a stale "in progress" marker on the offline rename-collision cutover.
- [S15 schema-v3 metadata-sync runbook](qa/s15-schema-v3-metadata-sync-runbook.md)
  — agent-executable two-device CDP scenario for schema-v3 nested metadata.
  **Residue**: the document records no executed run and no pass artifact, so its
  closure is unverified; it is still the desktop control arm for a device run.
