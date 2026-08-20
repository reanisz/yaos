# RFC: `.obsidian` settings sync (`settingsSync`)

Status: **Accepted decisions.** The sync plane is not implemented. Desktop
smoke of Obsidian `installPlugin` exists (`src/sync/settingsSync/`). This
document is the contract that implementation must not reopen without an
explicit product change.

Vocabulary: `settingsSync` in
[`../engineering/sync-vocabulary.md`](../engineering/sync-vocabulary.md).
[`sync-contract.md`](sync-contract.md) still lists `.obsidian/` as out of
scope until this plane ships.

Probed 2026-08-15 on Obsidian **1.12.7** (Electron 39.8.3). See “Live probe.”

## One sentence

A room holds a **map of named environments**, keyed by this device’s
Obsidian config-folder name. Each environment is an allowlisted slice of
that `configDir`: LWW files plus catalog **intents**, in a Durable Object
manifest that is **not** the vault `Y.Doc`. Plugin/theme binaries are never
stored by YAOS. Obsidian downloads pinned GitHub releases. Plugin `data.json`
moves only when this device’s binary, the pin, and the stored object’s
`pluginVersion` are the same version.

## Why

`.obsidian` as markdown CRDT or as `blobSync` is wrong: JSON character-merge
corrupts, `main.js` in the monolith blows RAM, attachments are
content-addressed and config is path-addressed.

This plane is environment replication, not collaboration. Notes stay CRDT.
YAOS has no user identity. One environment is the default and is enough.
Named environments exist for people who want a second slice (phone vs
laptop, or A vs B in a shared vault). They are not device types. Finer
than that: turn **settings sync** off on that device.

## Non-goals

- Config bytes in the `Y.Doc` (including `Y.Map`).
- YAOS as plugin CDN or updater.
- YAOS-invented profile picker, “mobile vs desktop” toggle, or per-device
  enable bits inside one environment.
- Live `workspace.json` / `workspace-mobile.json`.
- `.trash`, caches, `*.db` / `*.sqlite`, `.git/`, unknown root files.
- YAOS runtime (`plugins/yaos/**`, host/token/vaultId/disk index/queues).
- BRAT / unpublished / sideloaded plugin or theme **bytes**. Catalog only.
- Bookmark/hotkeys/`app.json` structural merge. Whole-file LWW.
- Official-style JSON key-merge of settings.
- R2 for this plane. Multi-cloud backup.
- Hooking `installPlugin` from `onload` with no prompt.

## Product model

### Named environments

Obsidian already names the folder: Settings → Files and links → Override
config folder. The manifest is a map from day one:

```text
room.settingsSync[".obsidian"]
room.settingsSync[".obsidian-mobile"]
room.settingsSync[".obsidian-b"]
```

These are **environments**, not device roles. Same mechanism covers:

1. Phone vs laptop (different plugin sets).
2. Two people in one vault (A’s desktop vs B’s desktop).
3. One shared set (everyone stays on `.obsidian`). That is the expected
   majority. Do not design the default path for the 5% “this machine is
   too weak.”

- This device reads and writes **only** the key that matches its current
  `configDir`.
- Replace on `.obsidian-b` never writes `.obsidian`.
- No YAOS UI for profiles. The folder name *is* the environment.
- A device whose folder has no seed yet is unseeded **for that key**. Notes
  still flow.
- **Settings sync** is a device-local master switch (default on once
  seeded). Off: this device ignores every key. Notes still work. That is
  the granularity escape hatch.

**Sanitize the key.** `basename(app.vault.configDir)` only. Reject empty,
`.`, `..`, embedded `/` or `\`, NUL, length > 64. No leading-dot
requirement (Official *recommends* `.obsidian-mobile`; `MobileConfig` is
still this vault’s `configDir` and is already excluded from the notes
plane). Anything rejected: `settingsSync` **off** on this device, reason
code, notes on. Never use the raw override string as a path or SQL key.

### Seed (per key)

Unseeded key: that environment does not flow. Text/attachments do.

- **Blank** device (YAOS + QA harness only, stock `app.json`/`appearance.json`,
  no extra plugins/snippets/hotkeys). If unsure, it is occupied.
- **Occupied:** three buttons — make **this** the environment; **take** the
  seed for **this key**; **later**. No file diffs.
- Blank after seed: consent, then pour. No zero-tap code install.
- First device for an empty key: confirm, then this device seeds that key.
- Two blanks on the same key: first successful seed `rev` wins.
- Later: settings row + command, no nag.
- After seed, joiners on this key see **this key’s seed vs this device**.
- **Replace:** any device may push its whole slice into **its** key
  (“Replace this environment with this device?”). Last `rev` on that key
  wins if two replace.

### After seed

- **Live LWW** for allowlisted settings files (including bookmarks,
  `workspaces.json`, `core-plugins.json`). Absence wins (deletes
  propagate) **for files**.
- **Plugin/theme code** does not auto-install unless this device’s
  **Auto-install plugins & themes** toggle is on (default **off**,
  device-local — this is consent to download code, not a second enable
  bit). Otherwise: Apply queue, one button.
- **Apply queue is durable.** Write the planned batch to **IndexedDB**
  (same store family as server-ack — not `plugins/yaos/data.json`)
  **before** the first `installPlugin` / file replace. Checkpoint each
  completed step. On boot, resume this queue before any other
  `settingsSync` work. In-memory array is not a queue. Crash mid-batch:
  keep what landed, continue the rest. Partial batch is the contract.
- **Add intent** only when the user installs from the catalog **on this
  device after seed** (or when this device seeds / replaces from disk).
  Never: reconcile sees a local folder the server lacks → add intent.
- Local folder delete is **local only**.
- **Disable** in the environment: `intent.enabled = false` (or core JSON).
  Every device on this key disables. Folder stays until remove.
- **Remove from environment:** write a **tombstone** for that plugin/theme
  id (and drop its `data.json`). Other devices uninstall the folder on
  apply. Tombstones are per-id, LWW by `rev`. Absence of a live intent is
  not enough if clients can also add.

### Exists vs enabled

One key, one enable set.

| Fact | Where |
| --- | --- |
| Plugin/theme **exists** at **version** | live intent on this key |
| **Enabled** (community) | `intent.enabled` on this key |
| **Enabled** (core) | LWW `core-plugins.json` on this key |
| **Removed** | tombstone on this key |
| `community-plugins.json` | local projection from intents |
| `isDesktopOnly` on mobile | skip enable; skip download (platform, not preference) |

Want a different enable set: other config folder, or settings sync off.
Not a local ignore flag.

Status: `key / installed / enabled` (environment). Version mismatch still
loud.

### Version pin

Pin is what **this key** says. Obsidian’s updater is still the updater.

- Drift is visible: local version ≠ pin.
- Promote pin is explicit (or included in auto-install on that device).
- No silent downgrade. No silent pin bump from whoever updated first.
- `minAppVersion` too new / catalog 404 / GitHub down: **skip that intent**,
  rest of batch continues, reason visible. Settings LWW still flows.

## Slice (closed allowlist)

**In**

- Root settings JSON that is not live session: `app.json`, `appearance.json`,
  `hotkeys.json`, `graph.json`, `daily-notes.json`, `templates.json`,
  `backlink.json`, `page-preview.json`, `note-composer.json`,
  `switcher.json`, `bookmarks.json`, `workspaces.json`,
  `core-plugins.json`, `core-plugins-migration.json` if present. Closed
  enum; unknown root `*.json` is **not** synced.
- `snippets/*.css`
- `PluginIntent` / `ThemeIntent` (catalog `repo` + version + `enabled`)
  and tombstones
- `plugins/<id>/data.json` only, under the version contract below

**Never**

- `workspace.json`, `workspace-mobile.json`
- `cache/`, `.trash`, `.git/`, `*.db`, `*.sqlite`
- `file-recovery.json`, `publish.json`, official Sync leftovers
- `plugins/yaos/**` and other sync plugins’ runtime folders
- plugin files other than `data.json`
- theme/plugin binaries
- backups / `*.bak` / conflicted copies
- sibling config folders (this device does not upload another key)
- unknown root `*.json`

Unknown root JSON (e.g. a future `canvas-settings.json`): do not sync.
Record **once per filename** in `settingsSync` status and the local
debug log (`settings.unknown_file_ignored`). Do **not** call
`recordVaultTrace` — that writes the room DO and was the issue #40
amplification path. Polling must not emit again for the same name.

`types.json` is out until someone asks. Templates **folder** is notes (`text`).

Oversize `data.json`: skip + reason. No chunking.

Missing catalog theme (`appearance.json` names a sideloaded folder): notice,
do not file-copy. Device keeps default theme until they install from the
browser.

## `data.json` contract (load-bearing)

A plugin settings object in the manifest is tagged:

```ts
type PluginDataEntry = {
  pluginId: string;
  pluginVersion: string; // producer binary, must equal the pin
  sha256: string;
  size: number;
  rev: number;
};
```

**Invariant (send + recv + tag):** this device does not **PUT** and does not
**apply** `plugins/<id>/data.json` unless

```text
local manifest.version === intent.version === entry.pluginVersion
```

`intent.enabled` does not relax this. Tombstoned ids do not PUT or apply.

Stale client (local 1.5, pin 1.6):

- Must not apply 1.6 `data.json` (protects the phone).
- Must not PUT 1.5 `data.json` (protects the desktop from schema downgrade).
- Local edits to 1.5 settings stay **local** until this device takes the pin.
- A buggy client that still uploads loses: store rejects / peers refuse
  `entry.pluginVersion !== pin`.

Mismatch is **loud**: headline `settingsSync` fact, plugin id, local version,
pin, actions **Update plugin** (install pin here) and **Promote pin** (if
this device is ahead). Not a silent hold.

## Coordination

Manifest beside the room, not in the CRDT. LWW by server `rev`, not mtime.
Top level is `Record<ConfigDirKey, Environment>`.

```ts
type PluginIntent = {
  id: string;
  repo: string;
  version: string;  // pin
  enabled: boolean; // environment, this key
  rev: number;
};

type PluginTombstone = {
  id: string;
  rev: number;
  deletedAt: number; // diagnostics
};
```

Live intent and tombstone for the same id: higher `rev` wins. A later
catalog install on a seeded device creates a live intent that beats the
tombstone.

JSON quarantine inbound: `JSON.parse` before replace; fail closed; keep local;
reason code.

Debounce `data.json` 5–10s, coalesce by path. Extra writes in the window drop.

`classifySyncPath` unchanged. Config is a third classifier; do not punch
`isExcluded`. Watch the allowlist by hash/poll; hidden-dir events are flaky.
Unknown root JSON: ignore + once-per-name notice, as above.

Bytes: DO SQLite. No R2. Capability: `settingsSync.settings`. Install is a
**client** ability (Obsidian API present), not a server flag.

Apply queue: IndexedDB, written before the first mutating step, resumed
on `onload` before watchers. Keep what landed.

Reconcile order on reconnect: apply remote live-set + tombstones **before**
considering any local add. Leftover folders whose id is tombstoned or absent
from live intents are **not** re-added; they uninstall on apply.

## Apply order

On Apply / auto-install / blank pour, per plugin, **this key only**:

1. Non-plugin settings files (including `core-plugins.json`). Atomic. JSON
   quarantine.
2. Snippet bodies, then `appearance.json` (so `enabledCssSnippets` has files).
3. `installTheme` then `appearance.json` `cssTheme`.
4. `installPlugin(repo, version, manifest)` if folder missing or version ≠ pin.
   Do not enable yet.
5. `data.json` only if the version invariant holds.
6. Enable iff `intent.enabled` (skip `isDesktopOnly` on mobile). Never copy
   `community-plugins.json`; `enablePluginAndSave` / `disablePluginAndSave`
   write the local list.
7. Tombstoned ids: `uninstallPlugin` (or equivalent folder remove).
8. `workspaces.json`: write file; refresh the **name list** in memory; never
   `changeLayout`. Live session stays local.
9. Restart notice for `app.json` / hotkeys. Do not promise Excalidraw hot-reload.

If `installPlugin` / `enablePluginAndSave` is missing: notice + list of names
to install manually (`obsidian://show-plugin?id=`). Do not fake an installer.
Rest of settings LWW still runs.

Restricted mode: refuse plugin install until the user turns it off (or
confirms `setEnable(true)`). Do not silently disable restricted mode.

## Clash

Hardcoded ids, no negotiation:

```ts
const SETTINGS_SYNC_CLASH_CORE = ["sync"] as const;
const SETTINGS_SYNC_CLASH_COMMUNITY = [
  "remotely-save",
  "obsidian-livesync",
  "system3-relay",
] as const;
```

Official Sync is core `sync`, not a community id `obsidian-sync`. Relay
is `system3-relay`. Detect **enabled** (core JSON / `enabledPlugins`).
Hit → `settingsSync` **off**, notes on, permanent dismissible banner:
`YAOS Settings Sync is disabled to prevent corruption because <id> is running.`
iCloud / Dropbox / Git: warn only.
Clash after seed: freeze the plane, keep the seed (all keys).

## Installer (undocumented)

Typed in `src/types/obsidian-internals.d.ts`. Score-safe if typed
(Anup / Unxok, 2026-06). Can vanish on an Obsidian bump.

| Call | Role |
| --- | --- |
| `installPlugin(repo, version, manifest)` | GitHub release → `plugins/<id>/`. No enable. No `data.json`. |
| `enablePluginAndSave(id)` | Enable + local `community-plugins.json` |
| `disablePluginAndSave(id)` | Environment disable apply |
| `setEnable(true)` | Restricted mode off (prompted) |
| `uninstallPlugin(id)` | Tombstone apply |
| `customCss.installTheme` | Theme equivalent |
| `obsidian://show-plugin?id=` | Fallback, not sync |

Trust Obsidian’s installer; no extra staging directory.

Do not claim mobile install until one manual iPhone/Android pass. Desktop
ships.

Smoke (debug only): **YAOS: Smoke-install Calendar via Obsidian**.

## Scenarios

- **S1.** Blank phone on `.obsidian`, consent, Dataview pin installed,
  `data.json` after version match, enable from `intent.enabled`. Folder
  complete before enable.
- **S2.** `minAppVersion` too new: skip that plugin, rest applies, UI says why.
- **S3.** Concurrent `app.json` on the same key: one `rev` wins.
- **S4.** Excalidraw 1.6 pin, phone 1.5: no apply, no PUT of 1.5 `data.json`.
  Loud hold. Promote or update.
- **S4b.** Phone 1.5, user tweaks settings, desktop 1.6: desktop must **not**
  accept the 1.5 body (`pluginVersion` tag).
- **S5.** YAOS `data.json` never leaves the device.
- **S6.** No R2. Settings in DO. Code from GitHub.
- **S7.** Remotely Save enabled: settings plane off.
- **S8.** Chatty `data.json`: one PUT per debounce window.
- **S9.** Setup URI carries connection; not the seed.
- **S10.** Messy `.obsidian`: allowlist only.
- **S11.** Disable Dataview on one laptop sharing `.obsidian`: every device
  on that key disables. Want it only on the phone: other folder, or
  settings sync off.
- **S12.** Replace on `.obsidian-mobile`: `.obsidian` unchanged.
- **S13.** A removes Calendar (tombstone). B was offline with the folder.
  B reconnects: does **not** auto-add; applies uninstall.
- **S14.** B sets override `.obsidian-b`, empty key: occupied/blank for that
  key only. A’s `.obsidian` untouched. Shared notes.
- **S15.** Override set to `../../etc`: settingsSync off, notes on.
- **S16.** Weak phone, user does not want a second folder: settings sync
  off. Notes still sync.
- **S17.** Kill Obsidian mid-install of 5 plugins: reboot resumes the
  IndexedDB queue; already-written files stay; remaining steps run.
- **S18.** Obsidian 1.18 adds `canvas-settings.json`: not synced; one
  status line with that name; no DO trace write.
- **S19.** Enable Remotely Save: settings plane off, banner names
  `remotely-save`, notes still sync.

## Implementation sequence

1. RFC (this) + Calendar smoke — done as far as smoke.
2. Seed/unseeded **per configDir key** + master switch + clash + allowlist
   LWW for core files/snippets/bookmarks/`workspaces.json`/`core-plugins.json`.
   No installer in the live path.
3. Intents + tombstones + Apply queue + auto-install toggle + bidirectional
   `data.json` gate + loud mismatch.
4. Remove-from-environment. Replace (per key). Mobile install proof.

## Live probe (2026-08-15)

Isolated vault, CDP 9222, Obsidian 1.12.7.

- `installPlugin("liamcain/obsidian-calendar-plugin", "1.5.10", manifest)` in
  1302 ms. Disk: `main.js` + `manifest.json`. Not enabled. No `data.json`.
- `enablePluginAndSave` then wrote `community-plugins.json` (~1.5 s debounce)
  and Calendar created `data.json`.
- Pin 1.5.9 then 1.5.10 worked; `data.json` left in place.
- `onRaw` only notifies enabled plugins’ `data.json`. Writing
  `community-plugins.json` does not install folders.
- `enablePlugin` checks `isDesktopOnly`; **no** `minAppVersion` on this build.
- Bookmarks core plugin: `{ items: [...] }`, types file/search/group/url/…
  `onExternalSettingsChange` → `loadData()`. Whole-file LWW is enough.
- Workspaces: `saveWorkspace` writes `workspaces.json` via
  `writeConfigJson`. `loadWorkspace` is `changeLayout`. We write the file;
  we do not call `changeLayout`.
- Phone not probed.

## Defaults (not product forks)

These are closed. Reopen only with a product change.

| Topic | Default |
| --- | --- |
| Environment identity | map keyed by sanitized `basename(configDir)` |
| Environments mean | named slices, not device roles |
| Majority path | one key (`.obsidian`), same everywhere |
| YAOS profile UI | none; honor Override config folder |
| ConfigDir sanitize | basename; reject `.` `..` `/` `\` NUL; max 64; **no** required leading `.` |
| Invalid / traversing configDir | settingsSync off |
| Enable | on the intent / `core-plugins.json` (this key) |
| Per-device enable | **dead** |
| Finer than an environment | device master switch off |
| Intent deletion | per-id tombstone, not list absence |
| Auto-add from leftover folders | never |
| Auto-add from user catalog install | yes, after seed, this key |
| Auto-install code | device-local consent, default off |
| Apply queue | IndexedDB; persist before first mutate; resume on boot |
| Unknown root JSON | ignore; once-per-name local notice; never `recordVaultTrace` |
| Clash ids | core `sync`; community `remotely-save`, `obsidian-livesync`, `system3-relay` |
| Bookmark merge | whole-file LWW |
| Smart merge of `app.json` / hotkeys | none |
| Plugin files besides `data.json` | never |
| Snapshots include settings seed | later revision, not this ship |
| Encryption | same Worker auth as notes |
| Smoke command | debug-only |
| QA harness | never an environment intent |
| Watcher | hash/poll allowlist |
| Two replaces on the same key | last `rev` |
| DO wiped | occupied/blank dialog per key |
| `emulate-mobile` | treat as mobile for desktop-only |
| Backgrounded phone | don’t install until foreground |
