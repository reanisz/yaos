# Bind-time divergence arbitration

Why `EditorBindingManager.bind()` refuses a buffer that disagrees with the CRDT,
and what it does instead.

## The failure

y-codemirror performs no initial sync. `YSyncPluginValue`'s constructor only
registers an observer; `update()` maps CodeMirror change offsets straight into
the `Y.Text` (`ytext.insert(fromA + adj, …)`). `applyBinding` attached yCollab to
whatever buffer the view held, with no content comparison.

Startup is the common way to meet a mismatched pair. Reconcile **defers open
files** (`planClosedFileReconcile` Rule 2, `open-or-bound`), then `onReconciled`
→ `reconcileOpenEditors` / `validateOpenBindings` binds them. A note edited on
disk while the plugin was unloaded, still open in a leaf, therefore got bound
diverged — and the next keystroke wrote at a semantically wrong offset in the
shared document, in both directions, and replicated.

## Why "decline and leave it unbound" is not a fix

An open-but-unbound diverged note is not a safe resting state:

- reconcile defers on open-ness **alone** (`isOpenOrBound`), so it never
  arbitrates the path;
- with the default `externalEditPolicy: "always"`, the next autosave has
  `syncFileFromDisk` diff-merge the buffer into the CRDT and silently discard
  the remote-only edits;
- DiskMirror force-writes CRDT content over the diverged disk file once the leaf
  stops being the active view. The `getLastEditorActivityForPath` guard that
  would hold that back iterates **bindings**, so it is dead for an unbound path.

So divergence is resolved, then bound.

## The two ways the first version of this corrupted data

The arbitration shipped and then destroyed real content by two independent
mechanisms. Both turn on the same fact about Obsidian: **`view.file` updates
before the editor document loads.** At a file-open or a leaf switch,
`view.editor.getValue()` can still return the previously displayed file's
content, or `""`.

### A — a stale buffer made authoritative

The gate sat above `getCmView()` and read `getValue()` with no readiness or
ownership check, then handed that string to the arbiter as the authoritative
**local** side. For a healthy synced note (`crdtHash == baselineHash`) the
decision table takes `import-disk-to-crdt`, so the previous note's content — or
`""` — was diff-imported into this note's `Y.Text`. No conflict artifact, no
notice, replicated everywhere. In traces it showed as
`binding-divergence-arbitration-started` with `bufferLength` equal to the
previous note's length or `0`, and often a later
`binding-divergence-declined` / `still-diverged-after-arbitration`.

The same stale read existed, pre-dating the arbitration, at
`resolveBindingTarget`'s `ensureFile` seed: a brand-new note could enter the
CRDT holding the previous note's content, with no second side to arbitrate
against later.

### B — the gate's early return skipped the unbind

`bind()` used to run `if (existing) this.unbind(view)` before rebinding,
enforcing the invariant at the top of `editorBinding.ts` ("when the view
switches files, reconfigure to empty"). The new gate returned **above** that
teardown. So on a same-leaf switch P → Q that the gate refused, the leaf kept
yCollab attached to **P's** `Y.Text` while Obsidian loaded Q's content into that
same CodeMirror — and y-codemirror maps the whole-document replacement straight
into the attached document. P's note became Q's content. No arbitration
involved; the refusal alone was enough.

## Shape

One choke point: the gate lives in `bind()`. Every trigger goes through it —
`reconcileOpenEditors`, `validateOpenBindings`, file-open, active-leaf-change,
the `onSyncScopeChanged` sweep, and the async `scheduleCmResolveRetry` timer,
which re-enters `bind()` rather than `applyBinding`.

Two things sit above the gate now, and both are load-bearing:

1. **The file-switch teardown**, unconditional and above every early return. If
   the leaf holds a binding for a different path than `view.file.path`, it is
   torn down first. A refusal may leave Q unbound; it may never leave P bound.
   That closes B.
2. **`getCmView()`**. A resolved, container-matched `EditorView` for this view
   is a materially stronger "loaded" signal than `view.file`, and putting the
   gate below it lets the CM-resolve retry ladder run first on its own terms.
   No retry budget is burned by arbitration: `clearCmResolveRetry` has already
   run by the time the gate is reached, and re-entry during an outstanding
   arbitration short-circuits on the in-flight set before any I/O.

## The settled-buffer guard

Before the buffer is treated as the local side — for arbitration **or** for the
`ensureFile` seed — it must agree with disk:

```
normalizeEolForSettleCompare(buffer) === normalizeEolForSettleCompare(await read(path))
```

Normalization is used **only** for this comparison, never on a string that is
then written or handed to the arbiter. CodeMirror normalizes its document to
`\n`; disk keeps whatever the file had. A raw compare would report every note in
a CRLF vault as permanently unsettled and disable the guard vault-wide.

A failed check means "still loading, or mid-typing inside the autosave
debounce". It is **not** a failure, so it does not bind, does not arbitrate,
does not write, and does not arm the 30 s arbitration backoff. It schedules a
short re-check instead: 10 × 300 ms ≈ 3 s of grace, past Obsidian's ~2 s
autosave idle. A timer rather than a vault `modify` subscription because
`EditorBindingManager` has no vault-event wiring at all and the bound is what
makes the timer safe. Past the bound it falls through to the ordinary
decline + backoff with its own reason, `buffer-never-settled`.

`vault.read` is async and `bind()` is sync, so the divergence branch became
"kick the async phase, then maybe arbitrate". Same re-entrancy protections: the
in-flight marker is taken synchronously before the first `await`, and B's
teardown has already run by then. Inside the async phase the buffer is re-read
and divergence re-tested **before** any arbiter runs — the common benign outcome
of a stale gate read is that the editor finished loading meanwhile and the
loaded buffer agrees with the `Y.Text` after all (`binding-divergence-cleared-by-settle`).

Without a disk reader wired the guard cannot run, and bind declines
(`settle-check-unavailable:no-disk-reader`) rather than trusting the buffer. The
seed branch keeps its pre-guard behaviour in that configuration.

### CRLF consequence

A genuinely settled note whose disk and `Y.Text` hold CRLF but whose editor
holds LF passes the settle check and then still arbitrates, because arbitration
compares exact content. That is intentional: an LF buffer cannot safely bind to
a CRLF `Y.Text` — every offset past the first line break differs. It converges
the `Y.Text` to LF once per legacy note. `binding-divergence-arbitration-started`
carries `eolOnlyDivergence` and `exactDiskMatch` so a vault-wide one-time
normalization wave is legible as one rather than as a wave of real divergences.
Where the note also has no disk-index baseline — the routine state, since
`contentHash` is only written at settle points — that one-time convergence also
writes a conflict artifact holding the CRLF text. Accepted noise: nothing is
lost, both sides are on disk, and it fires at most once per note.

The gate skips its content check when the leaf already holds a binding for the
path — re-attaching the same pair cannot change how offsets map. `bind()` runs
it a **second** time after tearing that binding down, because two routes go past
an existing binding and attach yCollab afresh: `getCmView` resolving a different
`EditorView` than the binding holds, and a `repair()` that failed to re-apply.
Both fire in exactly the messy states where "it was already bound" says nothing
about the buffer being attached now.

`bind()` never blocks. On divergence it starts an async arbitration (per-path
in-flight set; concurrent sweeps skip) and returns without binding; the
arbitration re-invokes `bind()` on success. Recursion is bounded by an
independent convergence re-check before that re-invocation — an arbiter that
reports `resolved` without converging is not trusted into a rebind. A failed or
declined arbitration sets a 30 s per-path backoff so repeated sweeps do not
re-arbitrate a persistently failing path every pass.

`trackOpenFile` runs regardless of the bind outcome. Without the path in
DiskMirror's `openPaths`, a remote write takes the ~300 ms closed-file lane and
overwrites the diverged file — the exact loss the arbitration exists to prevent.

## The decision

`ReconciliationController.resolveEditorDivergenceForBind` is the injected
arbiter (`BindDivergenceArbiter`). It reuses `decideClosedFileConflict` with the
**buffer** as the local side rather than the disk file — the buffer is what the
user sees, and disk can lag it by the autosave debounce. Baseline is
`getDiskIndex()[path]?.contentHash`.

| case | action |
| --- | --- |
| buffer == CRDT | not diverged; bind |
| CRDT == baseline | import buffer via `applyDiffToYText` (`ORIGIN_EDITOR_BIND_ARBITRATION`); no artifact, no loss |
| buffer == baseline | replace buffer from the `Y.Text` (`Editor.setValue`; cursor resets) |
| both changed, or no baseline | write the CRDT side as a conflict artifact, notify, then import the buffer |

**Deliberate deviation.** `decideClosedFileConflict`'s missing-baseline branch
defaults to "CRDT wins" when it has no mtime evidence. At bind time there is
evidence the closed-file lane never has: the user has this note open in front of
them. Overwriting the buffer they are looking at reads as data loss even when
nothing is lost, so the visible side wins the file and the remote side is
preserved beside it. Documented at the call site.

## Racing the autosave path

Both arbitration and `syncFileFromDisk` write the `Y.Text` from a base string
captured earlier, and both `await` in between, so an interleave applies
index-based diff ops against a document that moved underneath them. Ordering
does not make it benign. `syncFileFromDisk` therefore skips a path with an
arbitration in flight: arbitration converges the CRDT to the live buffer that
the skipped disk event was reporting anyway, and DiskMirror rewrites disk from
the CRDT once the path binds.

## Coverage

`tests/client/editor-binding-divergence-bind.ts` — 126 assertions: the repro plus
each decision branch, the failure/backoff path, the async-retry path, both
re-attach routes, the R1/R2/R3 review pins, and the incident coverage below.
Ablating the first gate fails 25 assertions (3 in the repro test alone,
including the modelled keystroke); ablating only the second gate fails 6.

The harness models the two things that made the incident possible: a view whose
editor content LAGS its file (`openFile` moves `view.file` without touching the
buffer), and a per-path vault reader (`disk`, `settleBuffer`, `duringDiskRead`).

| ablation | failing assertions |
| --- | --- |
| file-switch teardown (B) | 4, including "the previous note's Y.Text received NOTHING" |
| settled-buffer check (A) | 19 |
| seed branch of the guard | 6 |
| async re-test of divergence | 2 (noise only — the arbiter still converges) |

`modelObsidianFileLoad` is the B pin's mechanism: it replays a whole-document
fill through whatever binding the manager actually holds, so an empty
compartment makes the fill inert and a surviving binding writes the new file's
content into the previous note's `Y.Text`.

Not covered statically, and left for the real-device canary: that a resolved,
DOM-connected `EditorView` really is the stronger loaded signal the gate's new
position assumes. There is no DOM in Node, so `getCmView` is stubbed in every
suite in this area and the reordering itself is not independently pinned.
