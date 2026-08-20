# Mobile testing guide

Everything to test when you want to test YAOS on a phone or tablet, in one
place. Synthesised from the archived two-device "holy QA" checklist
([archive](../archive/qa/mobile-qa-checklist.md)), the QA history
([archive](../archive/qa/qa-history.md)), the
[multi-device witness runbook](multi-device-witness-runbook.md), the
[Layer 4 harness status](layer4-harness-status.md), and the mobile-conditional
code paths in `src/`.

Read §1 and §2 before anything else: they decide what a mobile run can and
cannot prove, and half the historical false alarms were expected behaviour.

---

## 1. The constraint that shapes every mobile run

The product plugin is mobile-capable (`manifest.json` has
`"isDesktopOnly": false`). The QA harness plugin is not
(`qa/obsidian-harness/manifest.json` has `"isDesktopOnly": true`), and Obsidian
on iOS/iPadOS/Android exposes no Chrome DevTools Protocol port. So:

- `window.__YAOS_QA__`, `window.__YAOS_DEBUG__`, all 41 single-device harness
  scenarios, and both CDP controllers (`qa:obsidian`, `qa:two-device`) are
  **unavailable on device**.
- `setQaNetworkHold("offline")`, `pauseEditorPropagation`, and the rest of the
  QA product control port do not exist in a mobile build. "Offline" on a phone
  means **real airplane mode**.
- Automating three-device CDP for iOS/Android is explicitly not being built
  (`layer4-harness-status.md`).

Mobile evidence therefore comes from exactly four channels:

1. The product command palette — `Export debug trace` /
   `Export debug trace with filenames` (`src/telemetry/installTelemetryRuntime.ts`).
   This is the only trace export path on device.
2. The exported trace header, which carries `operatingSystem: "ios" | "android"`
   and `isMobile: true` (`src/telemetry/diagnostics/diagnosticsService.ts`
   `describePlatform()`). Assert these, or you have not proved the run happened
   on mobile.
3. `YAOS: Export sync diagnostics`, plus vault manifests taken **off** the
   device: `bun run qa:manifest <vault> --hash-paths` then
   `bun run qa:compare expected.json actual.json` (exit 1 = divergence).
4. Direct observation, screen recording, and the manual witness protocol in §6.

The desktop peer of a mixed run **can** still be automated with `qa:two-device`
against one port. Prove the build is sane on desktop before carrying it to a
device (§3).

Also note: **Obsidian mobile renders no status bar.** Everything
`src/status/statusBarController.ts` writes is invisible on a phone. Never make a
status-bar reading a mobile pass criterion; read Notices, the settings panel, or
the exported trace instead.

---

## 2. Known-expected behaviour — do not report these as bugs

| Observation | Why it is expected |
|---|---|
| Attachment missing on mobile with `upload: "x.jpg" too large (… bytes), skipping` | Blob cap is 10 MiB (`server/src/contracts.ts`, 413 enforced in `routes/blobs.ts`); the plugin clamps `maxAttachmentSizeKB` to the advertised server cap |
| Attachments transfer one at a time | "Parallel transfers" defaults to 1 — `settingsTab.ts`: "Default 1 favors reliability on slow or mobile networks" |
| Reconnect takes up to ~30 s after network returns | `MAX_BACKOFF_TIME_MS = 30_000` in `src/sync/vaultSync.ts`, raised deliberately because y-partyserver's 2.5 s default is aggressive for mobile. Wait ≥30 s before calling a reconnect failure |
| A backgrounded device reports `unavailable` divergence in a witness run | The mobile-background guard working. Diagnostics-class, not a sync-correctness failure |
| Transient `binding-health-failed` / `missing-sync-facet` on rapid file switching | WebView editor lifecycle; expect a following `binding-health-restored`. Only a *persistent* failure is a bug |
| Transient DNS/transport failures on poor networks | Handled by retry/backoff |
| `filesystemPersistenceStatus: unavailable_inside_vault` | Expected; use clipboard export |
| Oversized text files skipped during reconcile, with a Notice | `reconciliationController.ts` oversized-file path |

And two harness-side limitations that shape evidence, not behaviour:

- **Background events are not exportable.** When the app is backgrounded the
  `unavailable` divergence fires in the tracker but the checkpoint append cannot
  complete (async `getPathId` suspended). The event lives in the in-memory
  buffer only. `getRuntimeState()` maps `document.visibilityState` and can never
  return `suspended`, so an OS suspend/kill is indistinguishable from
  background in evidence. This is why s12b is PARTIAL, not PASS.
- **Checkpoint segments are lost on plugin reload.** Export bundles *before*
  reloading, and save the exported evidence outside the vault.

---

## 3. Preparation

### 3.1 Build and prove the build on desktop first

```sh
npm run build                 # production main.js
npm run test:regressions      # guards + full headless suite
npm --prefix server run typecheck
```

If the change touches disk mirroring, metadata, or schema, also run the desktop
two-device control arm (needs two desktop Obsidian instances launched with
`--remote-debugging-port=9222` / `9223`):

```sh
npm run build:qa-product && npm run build:harness
bun run qa:two-device --scenario s15-schema-v3-metadata-sync \
  --port-a 9222 --port-b 9223 --trace qa-safe \
  --out-dir qa-runs/s15 --driver raw-cdp
```

Exit 0 = PASS. On failure, `qa-runs/s15/device-{a,b}/result.json` carries
`{ passed, errors }`. A desktop failure means you have no business taking the
build to a device.

### 3.2 Device setup

1. Use a **fresh vault folder on each device** and a **fresh `vaultId`** (new
   test room) on the same deployed Worker. Redeploy the Worker only if server
   code changed.
2. Install the same plugin artifacts everywhere — copy `main.js`,
   `manifest.json`, `styles.css` only. Keep `data.json` per device.
   Do **not** copy whole vault zips between devices: it hides real hydration and
   reconcile behaviour.
3. Enable debug mode on every device (`settings.debug`). Flight recording works
   on mobile — it goes through `app.vault.adapter` and has no Node dependency.
4. Pair Device B from Device A's settings → **Pair new device** → QR / deep
   link. **Never type a `vaultId` by hand**: that caused a silent room split
   (historic Issue 2). Exercise all mobile input paths: camera QR scan, Google
   Lens, "Copy mobile setup URL", "Open mobile setup page", and the manual
   textarea fallback.
5. Keep a timestamped run log. Export diagnostics at every phase boundary on
   every device (`YAOS: Export sync diagnostics`).

One trap when using prepared fixture vaults: `qa:prepare` gives every vault a
**fresh random `vaultId`**, so set the shared connection identity *after*
preparation (see [vault-preparation.md](vault-preparation.md)).

### 3.3 Mobile-reachable control surface

Command palette, no console: `Reconnect to sync server`, `Force reconcile vault
with sync state`, `Import untracked files now`, `Reset local cache (re-sync from
server)`, `Take snapshot now`, `Browse and restore snapshots`,
`Nuclear reset`, `Export debug trace` (`src/commands.ts`,
`src/telemetry/installTelemetryRuntime.ts`).

---

## 4. Core mobile run

Each step: perform, then export diagnostics on **both** devices.

### 4.1 Pairing and setup
Bootstrap Device A from the claim/setup link, pair the mobile device by QR /
deep link, validate the claim button plus camera QR, Lens, and copy-paste
fallback.
**Pass**: Device B receives host, token, and vaultId; no split-brain room.
**Hard fail**: pairing causes a room split.

### 4.2 Empty-vault hydration
Create a brand-new empty vault on mobile, connect with the same host/token/
vaultId, restart Obsidian once.
**Pass**: desktop notes hydrate automatically; no unexpected deletions.
**Hard fail**: hydration fails even once.

### 4.3 Real-time same-note collaboration
Open the same note on desktop and mobile, type concurrently for 30–60 s, then
switch notes rapidly.
**Pass**: converged final content; no persistent degraded or binding failure.
Remote carets should now be visibly distinct per device (colour is derived from
the device name), which is how you tell whose cursor is whose.

### 4.4 Fast edit lifecycle and swipe-kill
Create → rapid type → immediate rename → background → force-close from the app
switcher → reopen.
**Pass**: the last typed line survives; no persistent degraded state.
**Hard fail**: force-close loses recent edits.

### 4.5 Filesystem bridge (desktop-side writes, mobile-side effects)
On desktop:

```sh
for i in {1..50}; do echo "line $i" >> test.md; sleep 0.01; done
```

Then a self-echo suppression check and an out-of-band edit.
**Pass**: rapid-fire appends coalesce into a single ingest/apply event in the
trace; echo suppression holds; out-of-band edits ingest.

### 4.6 Attachment stress and oversize behaviour
Add three files near the limit (8–10 MB) plus one over 10 MB. Prefer real
camera-roll photos or video — that is how a phone hits the cap naturally.
**Pass**: queue drains, files open on both devices, oversize skip is
user-visible and logged, no stuck `0/N` counter.

### 4.7 Offline rename collision
Desktop offline: rename folder `A` → `B`. Mobile offline: edit a note under the
old path `A/…`. Bring desktop online, then mobile.
**Pass**: the edit survives; one winning path; no duplicate resurrection.
**Hard fail**: rename conflict drops edits or duplicates files.

### 4.8 Long-offline anti-resurrection
Keep the mobile device offline (airplane mode). On desktop create a file, sync,
then delete/rename. Bring mobile back.
**Pass**: the deleted file does not resurrect; tombstone and index invariants
hold.

### 4.9 Checkpoint truncation boundary
Keep the mobile device offline, make >50 edits on desktop, bring mobile online.
**Pass**: convergence via checkpoint/journal replay; no corruption, no
duplicates.

### 4.10 Snapshot and restore
Take a snapshot, mutate markdown plus at least one attachment reference, restore
selected files from the snapshot UI.
**Pass**: selected markdown and attachment references restore and download; no
legacy path corruption.
**Hard fail**: post-v2 snapshot restore fails.
Note: restore has only ever been validated across two desktop vaults. A mobile
restore is genuinely new evidence.

### 4.11 Storage pressure / IndexedDB resilience
Fill device storage low (or throttle an emulator) until persistence pressure
appears, and keep editing and syncing through the pressure window.
**Pass**: the plugin surfaces a clear degraded/error state; diagnostics classify
the IndexedDB failure reason (for example `quota_exceeded`); no silent
false-safe behaviour.
**Hard fail**: a storage-pressure failure that is silent or unclassified.
This is the least-tested area in the whole product — `y-indexeddb` startup is
known-flaky in mobile WebViews (YAOS reads its private `_db` to detect that) and
a failed load must fail closed, never continue with empty state.

### 4.12 Mixed-version guard
Keep the mobile device on an older, pre-guard build and connect it to an
upgraded room. Capture the rejection notice.
**Pass**: rejected with `update_required`; `fatalAuthError = true`; the
reconnect loop stops; no partial writes accepted.
**Hard fail**: the guard accepts an incompatible client.
If migrating a v1 room, run the migration first: seed a rename conflict on both
devices while offline, converge, run `YAOS: Migrate schema to v2`, restart both
clients, then confirm the schema reports v2 and no ghost conflict file survives
on disk.

### 4.13 Platform-shaped edge content
Unicode and CRLF are where mobile filesystems differ most (iOS produces NFD
filenames). Generate churn on the desktop side and check convergence on device:

```sh
node --import jiti/register tests/manual/obsidian-vault-stress.ts \
  <vaultRoot> 120 2097152 all atomic
```

It writes emoji, inline-icon bursts, CRLF, and frontmatter churn into
`<vaultRoot>/yaos/qa-stress/` and reports to `/tmp/yaos-stress-report-*.json`.
**Pass**: `qa:manifest` + `qa:compare` show no divergence between the desktop
vault and a copy pulled off the device.
Note NFC/NFD path normalisation has no scenario yet — it is an open follow-up.

---

## 5. Release gate — hard blocks

A mobile run fails the gate if any of these happen:

- Empty-vault hydration fails once.
- Force-close loses recent edits.
- Rename conflict drops edits or duplicates files.
- Pairing causes a room split.
- Post-v2 snapshot restore fails.
- The mixed-version guard accepts an incompatible client.
- A storage-pressure failure is silent or unclassified.

Required artifacts: diagnostics JSON from every phase checkpoint on every
device; a mobile screen recording of pairing, first sync, and one
failure/recovery moment; a server debug trace dump near each checkpoint.

---

## 6. Witness-protocol runs (multi-device quorum proofs)

Use these when the question is "did all devices actually converge on the same
state", not "does the feature work". Full mechanics live in the
[multi-device witness runbook](multi-device-witness-runbook.md); the mobile-
critical rules are:

**Setup on every device**: same plugin version, same vault, same Worker,
`qaDebugMode: true`, the **same `qaTraceSecret`**. On mobile,
`window.__YAOS_DEBUG__` is reached through the command palette, not DevTools.

**Discipline**: never compare wall clocks or `seq` values across devices; key
everything on `deviceId` (never `deviceName`); set the same `scenarioRunId` on
every device *before* starting the flight trace and before any step advance.

**Export**: `YAOS QA: Export witness bundle` on each device → clipboard, or a
selectable modal when the clipboard is unavailable. There is no share sheet and
no local-file export. Save the copied evidence outside the vault **before**
reloading anything, then:

```sh
bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c> \
  --out qa-runs/<run>/report.json
```

Integrity is checked before any rule: mismatched `qaTraceSecretHash`,
`scenarioRunId`, `scenarioId`, or bundle schema version rejects the run
(`bundle_secret_hash_mismatch` etc.). Differing per-device `localTraceId` is
fine. A passing three-device run must invoke `analyzeConvergenceEvidence`.

Scenario picker:

| Symptom you are chasing | Run |
|---|---|
| Does a real editor edit converge across three devices? | `s12a-three-device-active-edit` (Linux + real iPad + real Android, strict foreground) |
| Does mobile background/foreground lifecycle break witness? | `s12b` (Android backgrounded, quorum policy `required`) |
| Open-editor remote edit duplication or stale echo? | `s13` |
| Conflict-artifact locality regression? | `s12c` (disable YAOS on iPad, concurrent remote edits, re-enable) |

For `s12a-three-device-active-edit` the pass contract is strict: exactly one
`desktop`, one `ios`, and one `android` bundle; every mobile witness event
`runtimeState: foreground` (any non-foreground event invalidates the artifact);
Device A holds one step-1 baseline hash and a distinct step-2 `local-edit` hash
for the same `pathId`; iPad and Android settle that exact hash at steps 3 and 4;
`report.json` has `summary.ok: true`. CDP, simulators, browser emulation, shell
writes, adapter writes, `app.vault.modify`, and test-helper writes are all
prohibited — the edit must be typed in the Obsidian editor. Evidence goes to
`qa-runs/s12a-three-device-active-edit-pass/` or `…-fail/`, with a
human-readable `summary.md` naming the run ID, the three device roles, and every
hash.

---

## 7. What mobile has and has not proven

Proven on real devices:

- Android participates in the witness workflow; mobile bundle export works
  (`s12a` Linux+Android PASS).
- Android open-editor remote edit converges with
  `editorHash == crdtHash == diskHash` and zero transient lag (`s13`
  Linux+Android PASS).
- Three devices agree on a pre-existing hash — but no edit was made
  (`s12a` three-device, PASS (weak)).

Not proven, and the reason each matters:

1. **True mobile background behaviour** — `s12b` is PARTIAL; the background
   `unavailable` event never reaches an exportable segment.
2. **Three-device quorum after an actual edit** — `s12a-three-device-active-edit`
   has never been executed on real hardware. Note the code for it does not exist
   in `qa/` either; the runbook procedure is the implementation.
3. **Real-device `s12c` conflict artifact.**
4. **iPad re-enable-while-file-open** — a 2026-05-27 trace shows a typed local
   edit (`LOCAL_ON_IPAD`) silently lost with no conflict artifact. Desktop CDP
   cannot settle this: the ordering is platform-specific. Issue #22-B and the
   controller-recovery variant both carry "iPad proof: still pending".
5. **Soak and stress** — no 30–60 min mobile churn soak, no low-storage device
   matrix beyond a simulated quota.
6. **Mobile IndexedDB quota behaviour** — under-tested empirically (§4.11).

If you can only do one thing with real devices, do (2) and (4) in the same
session: they are the two gaps that block closing items in
[followups.md](../engineering/followups.md) and
[bug-rca-ledger.md](../engineering/bug-rca-ledger.md).

---

## 8. Mobile-specific code paths worth watching in a trace

- `src/runtime/connectionController.ts` — `visibilitychange`: `hidden` →
  `flushOpenWrites("app-backgrounded")`, `visible` → reconnect/refresh. The core
  mobile lifecycle branch.
- `src/sync/vaultSync.ts` — `MAX_BACKOFF_TIME_MS = 30_000` mobile-tuned backoff.
- `src/sync/diskIndex.ts` — hashing must stay on the WebCrypto path; Node
  `crypto` does not exist in mobile WebViews, so a regression there breaks mobile
  only.
- `src/sync/closedFileConflict.ts` — mtime is unreliable under iCloud and
  Android document providers; resolution falls back to CRDT-wins.
- `server/src/routes/ticket.ts` — WebSocket tickets expire after 5 minutes; a
  device backgrounded past that must fetch a fresh ticket on resume.
- `src/main.ts` / `src/settings/PairDeviceModal.ts` / `server/src/setupQr.ts` /
  `server/src/setupPage.ts` — the whole QR + `obsidian://yaos` deep-link
  onboarding path, which only mobile exercises.
- `src/main.ts` telemetry gate — flight recording runs on mobile, gated only by
  `settings.debug`; the historic mobile crash was `require("fs")` in the
  telemetry runtime, now guarded by `Platform.isMobile`.
