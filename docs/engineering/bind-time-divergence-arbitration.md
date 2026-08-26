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

## Shape

One choke point: the gate lives in `bind()`, above CM resolution. Every trigger
goes through it — `reconcileOpenEditors`, `validateOpenBindings`, file-open,
active-leaf-change, the `onSyncScopeChanged` sweep, and the async
`scheduleCmResolveRetry` timer, which re-enters `bind()` rather than
`applyBinding`.

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

`tests/client/editor-binding-divergence-bind.ts` — 65 assertions: the repro plus
each decision branch, the failure/backoff path, the async-retry path, both
re-attach routes, and the R1/R2/R3 review pins. Ablating the first gate fails 25
assertions (3 in the repro test alone, including the modelled keystroke);
ablating only the second gate fails 6.
