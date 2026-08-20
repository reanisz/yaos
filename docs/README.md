# YAOS Documentation

This directory is the durable documentation root for YAOS. The repository-root
[`README.md`](../README.md) remains the public project landing page; local,
volatile, or machine-specific working material belongs in ignored `notes/`.

## Architecture

- [Runtime estates](architecture/runtime-estates.md) — Engine, Observer, and Puppeteer boundaries.
- [Repository layout](architecture/repo-layout.md) — source ownership, build products, and generated-output rules.
- [Monolithic vault CRDT](architecture/monolith.md)
- [Filesystem bridge](architecture/filesystem-bridge.md)
- [Checkpoint journal](architecture/checkpoint-journal.md)
- [Attachment sync](architecture/attachment-sync.md)
- [Snapshot recovery](architecture/snapshots-recovery.md) — current model; see the recovery redesign RFC for the target model.
- [Startup load and blob gate](architecture/startup-load-and-blob-gate.md)
- [Zero-config authentication](architecture/zero-config-auth.md)
- [Warts and limits](architecture/warts-and-limits.md)

## Current engineering references

- [Active threads](engineering/active-threads.md)
- [Follow-ups](engineering/followups.md)
- [Bug and RCA ledger](engineering/bug-rca-ledger.md)
- [Conflict semantics](architecture/conflict-semantics.md)
- [Sync vocabulary](engineering/sync-vocabulary.md)
- [Server acknowledgement design](engineering/server-ack-design.md)
- [Schema-version guard](engineering/schema-version-guard.md)
- [Durable Object hardening implementation](engineering/do-hardening-implementation.md)
- [Update pipeline implementation](engineering/update-pipeline-implementation-1.4.0.md)
- [Server deployment](engineering/server-deployment.md)

## RFCs

- [Recovery snapshot redesign](rfcs/recovery-snapshot-redesign.md)
- [Sync contract](rfcs/sync-contract.md)
- [Frontmatter integrity](rfcs/frontmatter-integrity.md)
- [Durable Object hardening](rfcs/do-hardening.md)
- [Zero-ops update pipeline](rfcs/zero-ops-update-pipeline.md)
- [`.obsidian` settings sync](rfcs/settings-sync.md)

## QA

See [QA documentation](qa/README.md) for the mobile testing guide, current
harness status, reusable runbooks, and fixture-vault preparation guidance.

## Archive

See the [archive index](archive/README.md) for completed plans, historical
verification, technical spikes, and audits. Archived material preserves
provenance but is not current engineering guidance.
