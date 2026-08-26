import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import { editorInfoField, MarkdownView, Notice, type MarkdownFileInfo, type Workspace } from "obsidian";
import type { VaultSync } from "./vaultSync";
import { applyDiffToYText } from "./diff";
import type { TraceRecord } from "../observability/traceContext";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import { ORIGIN_EDITOR_HEALTH_HEAL } from "./origins";
import { deviceCursorColor } from "../utils/deviceCursorColor";

/**
 * Manages per-editor CM6 bindings via yCollab.
 *
 * Strategy:
 *   - One global Compartment registered via registerEditorExtension.
 *   - When a MarkdownView is opened/focused, we reconfigure that
 *     editor's compartment to yCollab(ytext, awareness, {undoManager}).
 *   - When the view is closed or switches files, reconfigure to empty.
 */

/**
 * Freshly reconfigured editors can briefly report no ySyncFacet even though
 * the compartment update is still settling into the live view state.
 */
const BASE_BINDING_SETTLE_WINDOW_MS = 750;
const FAST_SWITCH_BINDING_SETTLE_WINDOW_MS = 1600;
const FAST_SWITCH_WINDOW_MS = 2000;
const POST_BIND_HEALTH_GRACE_MS = 100;
const LIVE_UPDATE_HEALTH_RETRY_DELAY_MS = 120;
const CM_RESOLVE_RETRY_DELAY_MS = 100;
const CM_RESOLVE_MAX_RETRIES = 8;

/**
 * How long to wait before re-testing a buffer that was not settled yet, and how
 * many times.
 *
 * This is a DIFFERENT mechanism from DIVERGENCE_ARBITRATION_BACKOFF_MS and must
 * stay one. "The buffer does not match disk yet" is the ordinary state of a leaf
 * that is still loading a file, or of a note being typed into inside Obsidian's
 * autosave debounce — neither is a failure, and neither should park the path for
 * 30 s. 10 x 300 ms gives ~3 s of grace, past Obsidian's ~2 s autosave idle, and
 * then falls through to the real backoff so a permanently unsettled path cannot
 * spin timers forever.
 *
 * A timer rather than a vault `modify` subscription: EditorBindingManager has no
 * vault-event wiring at all today, and adding one would mean a new plugin-level
 * registration plus a teardown path for a signal that only needs to be "look
 * again shortly". The bound is what makes the timer safe.
 */
const UNSETTLED_BUFFER_RECHECK_DELAY_MS = 300;
const UNSETTLED_BUFFER_MAX_RECHECKS = 10;

/**
 * Line-ending normalization, for the settled-buffer comparison ONLY.
 *
 * CodeMirror normalizes its document to "\n" (`EditorState.lineSeparator`
 * defaults to splitting on any of \n, \r\n, \r and joining with \n). Disk, and
 * therefore the `Y.Text` seeded from disk, keeps whatever the file had. On a
 * CRLF vault a raw `buffer === disk` test is therefore permanently false, and a
 * settled-buffer guard written that way would silently disable itself for the
 * whole vault — every note would look "still loading", forever.
 *
 * Used exclusively to answer "has the editor finished loading this file?".
 * Never applied to a string that is then written into the `Y.Text` or handed to
 * the arbiter: arbitration compares and merges EXACT content, and normalizing
 * its inputs would fabricate edits.
 */
function normalizeEolForSettleCompare(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Outcome of "is this buffer the loaded, settled content of its file?". */
interface BufferSettleCheck {
	/**
	 * settled     — buffer equals disk modulo line endings; safe to treat as the
	 *               local side.
	 * unsettled   — buffer disagrees with disk: still loading, or mid-typing
	 *               inside the autosave debounce. Look again shortly.
	 * unavailable — the check itself could not run (no disk reader wired, view
	 *               moved, buffer unreadable). Not retryable on a short timer.
	 */
	status: "settled" | "unsettled" | "unavailable";
	buffer: string;
	disk: string | null;
	reason: string;
}

/** Which read of the buffer the settle check is protecting. */
type BufferSettleMode = "arbitrate" | "seed";

/** Why a getCmView() call failed to resolve an editor, for degraded traces. */
interface CmResolveFailure {
	reason: "no-known-cm-views" | "no-container-match" | "ambiguous";
	knownCmViews: number;
	containerMatches: number;
	infoMatches: number;
}

/** Map from MarkdownView instance id to its binding state. */
interface EditorBinding {
	view: MarkdownView;
	path: string;
	/**
	 * The Y.Text yCollab is attached to. Recorded because "which document is
	 * this leaf writing into" is the question every corruption in this area
	 * turns on, and it was previously only reachable through the UndoManager's
	 * scope.
	 */
	ytext: Y.Text;
	undoManager: Y.UndoManager;
	cm: EditorView;
	cmId: string;
	fileId?: string;
	lastBoundAt: string;
	lastBoundAtMs: number;
	lastEditorChangeAtMs: number;
	settleWindowMs: number;
}

export interface BindingDebugInfo {
	leafId: string;
	path: string;
	fileId?: string;
	storedCmId: string;
	liveCmId: string | null;
	cmMatches: boolean;
	lastBoundAt: string;
}

export interface CollabDebugInfo {
	leafId: string;
	path: string;
	cmId: string | null;
	hasSyncFacet: boolean;
	awarenessMatchesProvider: boolean | null;
	yTextMatchesExpected: boolean | null;
	undoManagerMatchesFacet: boolean | null;
	facetFileId: string | null;
	expectedFileId: string | null;
	facetTextLength: number | null;
	cmDocLength: number | null;
}

export interface BindingHealthStatus {
	bound: boolean;
	healthy: boolean;
	settling: boolean;
	issues: string[];
}

interface BindingHealthCheck {
	healthy: boolean;
	settling: boolean;
	issues: string[];
	deferredIssues: string[];
}

interface BindingTarget {
	ytext: Y.Text;
	fileId?: string;
}

/**
 * Harness-only gate for pausing editor<->CRDT propagation on specific paths.
 * Supplied by the QA harness via the EditorBindingManager constructor.
 * Absent in production. Default: all paths are unpaused.
 *
 * The gate owns the mutable paused-path set. The EditorBindingManager
 * only reads from it (isPaused) — it does not mutate it.
 *
 * The harness must call reconfigureBindingForPath after mutating the set
 * so that the CodeMirror compartment is updated.
 */
export interface BindingPropagationGate {
	/** Returns true if propagation for this path is currently paused. */
	isPaused(path: string): boolean;
	/**
	 * Called by EditorBindingManager to expose a reconfigure hook for
	 * the harness. The harness calls reconfigure(path, deviceName) after
	 * pausing or resuming to apply the CM extension change.
	 */
	registerReconfigureHook(
		fn: (path: string, deviceName: string, action: "pause" | "resume") => void,
	): void;
}

/**
 * Result of one bind-time divergence arbitration.
 *
 * "resolved" is a claim that the editor buffer and the `Y.Text` now hold the
 * same string. EditorBindingManager re-verifies it before binding anyway — see
 * finishDivergenceArbitration — because an arbiter that returns "resolved"
 * without converging would otherwise put us straight back into the corruption
 * the arbitration exists to prevent, in a loop.
 */
export type BindDivergenceOutcome = "resolved" | "declined";

/**
 * Resolve a buffer-vs-CRDT divergence so `path` can be bound.
 *
 * Injected rather than reached for: arbitration needs the disk-index baseline,
 * the conflict-artifact writer and `applyDiffToYText`, all of which live behind
 * the reconciliation controller. EditorBindingManager must not import the
 * controller (the controller already imports it), so the dependency is inverted
 * into this one narrow async callback — which is also the seam the tests drive.
 *
 * `bufferContent` is the buffer as bind() read it. The implementation must not
 * assume it is still current when it runs: it re-reads and re-verifies.
 */
export type BindDivergenceArbiter = (
	path: string,
	bufferContent: string,
) => Promise<BindDivergenceOutcome>;

/**
 * How long a path whose arbitration failed is left alone.
 *
 * Reconcile sweeps call bind() for every open view on every pass. Without a
 * backoff a path whose arbitration keeps failing — an unwritable conflict
 * artifact directory, a vault adapter erroring — would re-arbitrate on every
 * sweep, forever, each attempt doing real I/O.
 */
const DIVERGENCE_ARBITRATION_BACKOFF_MS = 30_000;

/**
 * Trace-safe description of a rejected promise's reason. Anything can be
 * thrown, and stringifying a plain object yields "[object Object]" — which
 * reads in a trace as though the reason was captured when it was not.
 */
function describeThrown(error: unknown): string | null {
	if (error === null || error === undefined) return null;
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return `non-error thrown (${typeof error})`;
}

export class EditorBindingManager {
	/** The CM6 compartment that holds yCollab for each editor. */
	readonly compartment = new Compartment();

	/** Track which views are currently bound. Keyed by MarkdownView leaf id. */
	private bindings = new Map<string, EditorBinding>();
	private knownCmViews = new Set<EditorView>();
	private cmIds = new WeakMap<EditorView, string>();
	private cmToLeafId = new WeakMap<EditorView, string>();
	private cmCounter = 0;
	private pendingHealthChecks = new Map<string, number>();
	private healthWorkInFlight = new Set<string>();
	private lastDeviceName = "unknown";
	private cmDegradedWarned = false;
	private cmResolveAttempts = new Map<string, number>();
	private pendingCmResolveRetries = new Map<string, number>();
	/**
	 * Why the last getCmView() call returned null. Attached to the degraded
	 * trace so field reports separate "no editor ever registered" (our CM6
	 * extension reached this editor too late) from "registered but
	 * unclaimable" (ambiguous container).
	 */
	private lastCmResolveFailure: CmResolveFailure | null = null;

	/**
	 * Paths with an arbitration currently running. Bind attempts for a path in
	 * this set return without action — concurrent reconcile sweeps must not each
	 * start their own arbitration, and must not bind while one is mid-flight.
	 */
	private divergenceArbitrationInFlight = new Set<string>();
	/**
	 * path → earliest Date.now() at which arbitration may be attempted again
	 * after a failure or a decline. See DIVERGENCE_ARBITRATION_BACKOFF_MS.
	 */
	private divergenceArbitrationRetryAfter = new Map<string, number>();
	/**
	 * path → pending short re-check timer for a buffer that had not settled yet,
	 * and path → how many of those re-checks have been spent.
	 * See UNSETTLED_BUFFER_RECHECK_DELAY_MS.
	 */
	private pendingUnsettledRechecks = new Map<string, number>();
	private unsettledBufferAttempts = new Map<string, number>();
	/**
	 * Paths whose buffer the async settle check has just confirmed and which it
	 * is re-entering into bind() as a result.
	 *
	 * Only the no-`Y.Text` seed branch needs this. The diverged branch re-enters
	 * bind() in a state where the buffer and the `Y.Text` hold the same string, so
	 * the gate passes on its own merits; the seed branch re-enters with the same
	 * "no Y.Text" condition it started from and would otherwise re-check forever.
	 * Consumed on the first read in the gate, so it can never let a later,
	 * unrelated bind() past.
	 */
	private settledBufferPass = new Set<string>();

	private readonly debug: boolean;

	constructor(
		private vaultSync: VaultSync,
		private readonly workspace: Workspace,
		debug: boolean,
		private trace?: TraceRecord,
		private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void,
		private readonly bindingPropagationGate?: BindingPropagationGate,
		/**
		 * Markdown sync-scope predicate, supplied by the plugin so binding sees
		 * the live `Exclude paths` setting rather than a snapshot. Defaults to
		 * "everything is in scope" so existing call sites and test harnesses that
		 * construct without it keep their behaviour.
		 */
		private readonly isMarkdownPathSyncable: (path: string) => boolean = () => true,
		/**
		 * Bind-time divergence arbiter. Absent means "no arbiter wired": bind()
		 * then DECLINES a diverged bind rather than attaching yCollab to a buffer
		 * that does not match the Y.Text. Declining is the safe default and the
		 * one an unconfigured harness gets — attaching would map the next
		 * keystroke to a wrong offset in the shared document, and that corruption
		 * replicates.
		 */
		private readonly resolveDivergenceForBind?: BindDivergenceArbiter,
		/**
		 * Read `path` from the vault as disk holds it, or null when there is no
		 * such file or it cannot be read.
		 *
		 * Injected for the same reason the arbiter is: EditorBindingManager is
		 * handed a `Workspace`, not an `App`, and must not grow a vault dependency
		 * to answer one question. That question is "has the editor finished loading
		 * this file into its buffer?", and it exists because `view.file` updates
		 * BEFORE the editor document loads — a stale read at bind time imported the
		 * previous note's content into this note's Y.Text in production.
		 *
		 * Absent means the settled-buffer guard cannot run. bind() then declines a
		 * diverged bind rather than trusting an unverifiable buffer, and leaves the
		 * pre-existing seed behaviour alone.
		 */
		private readonly readDiskContent?: (path: string) => Promise<string | null>,
	) {
		this.debug = debug;
		// Register the reconfigure hook so the harness can trigger CM extension
		// changes after mutating the paused-path set.
		bindingPropagationGate?.registerReconfigureHook((path, deviceName, action) => {
			for (const [leafId, binding] of this.bindings) {
				if (binding.path !== path) continue;
				if (action === "pause") {
					try {
						binding.cm.dispatch({ effects: this.compartment.reconfigure([]) });
					} catch {
						// view may be destroyed
					}
				} else {
					// Resume: re-apply yCollab via repair.
					this.repair(binding.view, deviceName, "harness-resume-binding-propagation");
				}
				void leafId;
			}
		});
	}

	/**
	 * Returns the base extension to register globally.
	 * Starts as empty; reconfigured per-editor when a note is opened.
	 */
	getBaseExtension(): Extension {
		const registerKnownCmView = this.registerKnownCmView.bind(this);
		const handleLiveEditorUpdate = this.handleLiveEditorUpdate.bind(this);
		const unregisterKnownCmView = this.unregisterKnownCmView.bind(this);
		return [
			this.compartment.of([]),
			ViewPlugin.fromClass(
				class {
					constructor(readonly view: EditorView) {
						registerKnownCmView(view);
					}

					update(update: ViewUpdate): void {
						handleLiveEditorUpdate(update);
					}

					destroy(): void {
						unregisterKnownCmView(this.view);
					}
				},
			),
		];
	}

	/**
	 * Bind a MarkdownView's editor to the correct Y.Text.
	 * Call this when a leaf becomes active or a file is opened.
	 */
	bind(view: MarkdownView, deviceName: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;

		// Only bind .md files
		if (!file.path.endsWith(".md")) return;

		// resolveBindingTarget is the load-bearing gate; this one short-circuits
		// before getCmView and scheduleCmResolveRetry below, and puts the refusal
		// where a reader looks for it.
		//
		// It tears down first. Returning above the `if (existing) this.unbind(...)`
		// below would otherwise mean bind() can no longer clear a stale binding on
		// an out-of-scope path — and a binding CAN arrive at one without passing
		// through here, e.g. updatePathsAfterRename rewriting a bound path into an
		// excluded folder.
		if (!this.isMarkdownPathSyncable(file.path)) {
			this.traceOutOfScopeTeardown(view, file.path, "bind");
			this.unbindByPath(file.path);
			this.log(`bind: "${file.path}" outside sync scope, skipping`);
			return;
		}

		const leafId = view.leaf.id ?? file.path;

		// UNCONDITIONAL teardown on a same-leaf file switch. This is the
		// invariant stated at the top of this file — "when the view is closed or
		// switches files, reconfigure to empty" — and it has to be enforced HERE,
		// above every route that can return early, not at the `if (existing)`
		// further down.
		//
		// Incident: the divergence gate shipped with its refusal ABOVE that
		// teardown. On a same-leaf switch P -> Q that the gate refused, the leaf
		// kept yCollab attached to P's Y.Text while Obsidian loaded Q's content
		// into the very same CodeMirror. y-codemirror maps that whole-document
		// replacement straight into the attached Y.Text (`ytext.insert(fromA +
		// adj, …)`, no content comparison), so P's note BECAME Q's content and
		// replicated. No arbitration was involved; a refusal alone was enough.
		//
		// So: a refusal must never leave yCollab attached to the previous file's
		// Y.Text. Everything below may decline to bind Q; nothing below may leave
		// P bound.
		const priorBinding = this.bindings.get(leafId);
		if (priorBinding && priorBinding.path !== file.path) {
			this.log(
				`bind: leaf switched "${priorBinding.path}" -> "${file.path}" ` +
				`(leaf=${leafId}) — detaching before anything else`,
			);
			this.trace?.("editor", "binding-detached-on-file-switch", {
				leafId,
				from: priorBinding.path,
				to: file.path,
			});
			this.unbind(view);
		}

		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`bind: no CM EditorView for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, "bind");
			return;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;

		// Divergence gate. bind() is the single door every bind trigger goes
		// through — reconcileOpenEditors, validateOpenBindings, file-open,
		// active-leaf-change, the onSyncScopeChanged sweep, and the async
		// scheduleCmResolveRetry timer, which re-enters HERE rather than at
		// applyBinding.
		//
		// It sits BELOW getCmView deliberately. `view.file` updates before the
		// editor document loads, so `view.file` alone is not evidence that the
		// buffer belongs to this path — reading it above CM resolution is how the
		// previous note's content got handed to the arbiter as this note's
		// authoritative local side. A resolved, container-matched EditorView for
		// this view is a materially stronger loaded signal, and putting the gate
		// after it means the CM-resolve retry ladder runs first, on its own terms.
		//
		// No retry budget is burned by arbitration: getCmView already succeeded
		// here, so clearCmResolveRetry above has reset the ladder for this leaf.
		// Re-entry while arbitration is outstanding is cheap — the in-flight set
		// short-circuits it before any I/O.
		//
		// y-codemirror performs NO initial sync (see canBindWithoutDivergence),
		// so a bind onto a mismatched buffer writes the user's next keystroke at
		// a semantically wrong offset in the shared document. Startup is the
		// common way to meet a mismatched pair: reconcile DEFERS open files
		// (planClosedFileReconcile Rule 2, "open-or-bound"), then onReconciled
		// binds them — including a note edited on disk while the plugin was
		// unloaded.
		if (!this.guardBindDivergence(view, file.path, deviceName, leafId)) {
			return;
		}

		const cmId = this.getCmId(cm);
		const existing = this.bindings.get(leafId);

		if (existing && existing.path === file.path && existing.cm === cm) {
			const health = this.inspectBindingHealth(view, existing);
			if (health.healthy) {
				if (health.settling) {
					const deferred = health.deferredIssues.join(",");
					this.log(
						`bind: waiting for "${file.path}" to settle ` +
						`(leaf=${leafId}, cm=${cmId}, deferred=${deferred})`,
					);
					return;
				}

				this.log(`bind: already bound "${file.path}" (leaf=${leafId}, cm=${cmId})`);
				return;
			}

			const reason = health.issues.join(",") || "unknown";
			this.log(
				`bind: repairing unhealthy binding "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}, issues=${reason})`,
			);
			if (this.repair(view, deviceName, `bind-health:${reason}`)) {
				return;
			}

			this.log(
				`bind: repair failed for "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}) — falling back to rebind`,
			);
		}

		if (existing && existing.path === file.path && existing.cm !== cm) {
			this.log(
				`bind: editor view changed for "${file.path}" ` +
				`(leaf=${leafId}, stored=${existing.cmId}, live=${cmId})`,
			);
		}

		// A different-path binding is already gone — the file-switch teardown at
		// the top of bind() ran unconditionally, above every early return. What
		// remains here is a SAME-path binding being rebuilt.
		if (existing) {
			this.unbind(view);

			// Second gate, and it is not redundant. The gate at the top skipped
			// its content check when this leaf already held a binding for this
			// path, on the reasoning that re-attaching the SAME pair cannot change
			// how offsets map. That reasoning ends here: everything below attaches
			// yCollab to whatever `cm` getCmView just resolved, and the two routes
			// that reach it are exactly the messy ones —
			//
			//   cm-changed  — `existing.cm !== cm`, so the buffer being bound is
			//                 not the buffer the old binding was keeping in step
			//                 with the Y.Text;
			//   repair-fell-through — repair() failed to re-apply, and bind() is
			//                 rebuilding the binding from scratch.
			//
			// The unbind above is what makes this call do real work: with the
			// binding gone, guardBindDivergence no longer takes its already-bound
			// shortcut, and a mismatch routes into arbitration instead of being
			// attached. One string compare on a rare event.
			if (!this.guardBindDivergence(view, file.path, deviceName, leafId)) {
				return;
			}
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			"bind",
		);
		if (!target) {
			return;
		}

		this.applyBinding({
			action: "bind",
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
		});
	}

	repair(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!file.path.endsWith(".md")) return false;

		const leafId = view.leaf.id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`repair: no CM EditorView for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, `repair:${reason}`);
			return true;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;

		const existing = this.bindings.get(leafId);
		if (!existing) {
			this.log(
				`repair: no tracked binding for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason})`,
			);
			this.bind(view, deviceName);
			const rebound = this.bindings.get(leafId);
			return rebound?.path === file.path && rebound.cm === cm;
		}

		if (existing.path !== file.path || existing.cm !== cm) {
			this.log(
				`repair: binding target changed for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason}) — forcing rebind`,
			);
			this.rebind(view, deviceName, reason);
			return true;
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`repair:${reason}`,
		);
		if (!target) {
			// An out-of-scope path is not hard-tombstoned, so the fallback below
			// would report "not repaired" and leave the existing entry in
			// this.bindings with yCollab still attached — a live CRDT binding on a
			// path the user removed from sync. Tear it down instead; the refusal
			// is deliberate, not a repair failure for a caller to retry.
			if (!this.isMarkdownPathSyncable(file.path)) {
				this.traceOutOfScopeTeardown(view, file.path, "repair-or-heal");
				this.unbindByPath(file.path);
				return true;
			}
			return this.isHardTombstonedPath(file.path);
		}

		return this.applyBinding({
			action: "repair",
			deviceName,
			view,
			cm,
			cmId: this.getCmId(cm),
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			existing,
			reason,
		});
	}

	heal(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!file.path.endsWith(".md")) return false;

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`heal:${reason}`,
		);
		if (!target) {
			// An out-of-scope path is not hard-tombstoned, so the fallback below
			// would report "not repaired" and leave the existing entry in
			// this.bindings with yCollab still attached — a live CRDT binding on a
			// path the user removed from sync. Tear it down instead; the refusal
			// is deliberate, not a repair failure for a caller to retry.
			if (!this.isMarkdownPathSyncable(file.path)) {
				this.traceOutOfScopeTeardown(view, file.path, "repair-or-heal");
				this.unbindByPath(file.path);
				return true;
			}
			return this.isHardTombstonedPath(file.path);
		}

		const currentContent = view.editor.getValue();
		const crdtContent = target.ytext.toJSON();
		const diffApplied = crdtContent !== currentContent;
		if (diffApplied) {
			this.log(
				`heal: applying local editor content to "${file.path}" ` +
				`(${crdtContent.length} -> ${currentContent.length} chars, reason=${reason})`,
			);
			applyDiffToYText(target.ytext, crdtContent, currentContent, ORIGIN_EDITOR_HEALTH_HEAL);
		}

		// Emit editor.heal.applied unconditionally on heal() entry so that
		// "no editor.heal.applied event" means "heal() was not invoked",
		// not "heal() was invoked but happened to be a no-op". The
		// diffApplied flag distinguishes the two cases.
		this.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.editorHealApplied,
			severity: "info",
			scope: "file",
			source: "editorBinding",
			layer: "editor",
			path: file.path,
			data: {
				reason,
				crdtLength: crdtContent.length,
				editorLength: currentContent.length,
				crdtMatchesEditorBefore: !diffApplied,
				diffApplied,
			},
		});

		return this.repair(view, deviceName, reason);
	}

	rebind(view: MarkdownView, deviceName: string, reason: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;
		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, `rebind:${reason}`);
			return;
		}

		const leafId =
			view.leaf.id ?? file.path;
		this.log(`rebind: forcing "${file.path}" (leaf=${leafId}, reason=${reason})`);
		this.unbind(view);
		this.bind(view, deviceName);
	}

	/**
	 * Unbind a MarkdownView's editor (clear yCollab extension).
	 */
	unbind(view: MarkdownView): void {
		const file = view.file;
		const leafId =
			view.leaf.id ?? file?.path ?? "unknown";

		const binding = this.bindings.get(leafId);
		if (!binding) return;

		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		binding.undoManager.destroy();
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);

		try {
			binding.cm.dispatch({
				effects: this.compartment.reconfigure([]),
			});
		} catch {
			// View may already be destroyed
		}

		this.clearLocalCursor("unbind");

		this.log(`unbind: unbound "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`);
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		for (const path of Array.from(this.pendingUnsettledRechecks.keys())) {
			this.clearUnsettledBufferRecheck(path);
		}
		this.settledBufferPass.clear();
		for (const [leafId, binding] of this.bindings) {
			this.clearScheduledHealthCheck(leafId);
			this.clearCmResolveRetry(leafId);
			this.healthWorkInFlight.delete(leafId);
			this.cmToLeafId.delete(binding.cm);
			binding.undoManager.destroy();
			this.log(`unbindAll: destroyed binding for "${binding.path}"`);
		}
		this.bindings.clear();
	}

	/**
	 * Unbind any editors that are bound to the given path.
	 * Called when a file is deleted (locally or remotely).
	 */
	unbindByPath(path: string): void {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path === path) {
				this.clearScheduledHealthCheck(leafId);
				this.clearCmResolveRetry(leafId);
				this.healthWorkInFlight.delete(leafId);
				binding.undoManager.destroy();
				try {
					binding.cm.dispatch({
						effects: this.compartment.reconfigure([]),
					});
				} catch {
					// View may already be destroyed
				}
				this.cmToLeafId.delete(binding.cm);
				this.bindings.delete(leafId);
				this.log(`unbindByPath: unbound "${path}" (leaf=${leafId})`);
				// Don't break — a path could theoretically be open in multiple leaves
			}
		}
	}

	/**
	 * Release bindings whose workspace leaf no longer exists.
	 *
	 * Closing a tab is the one lifecycle event with no cleanup path: `unbind`
	 * needs a live MarkdownView to derive its key, `unbindByPath` only fires on
	 * delete/rename, and `auditBindings` skips detached views outright because
	 * `isAuditActionable` bails when `view.file` is null. Measured on a
	 * 121-note vault: `bindings` reached 133 entries with a single tab open,
	 * each stranded entry pinning a dead MarkdownView, its EditorView, the
	 * detached DOM and a live UndoManager doc listener (~39 KB apiece).
	 *
	 * Two independent signals must agree before we release anything:
	 *
	 *   1. the leaf key is absent from the workspace, and
	 *   2. CodeMirror already tore the view down, so our ViewPlugin.destroy
	 *      hook removed it from knownCmViews.
	 *
	 * Requiring both keeps a workspace mutation that transiently hides a leaf
	 * from stranding a live editor. Verified against reading-mode toggles,
	 * sidebar collapse, popout moves and split focus changes: every one of
	 * those keeps the EditorView registered, so none of them prune.
	 */
	pruneOrphanedBindings(liveLeafKeys: ReadonlySet<string>, source: string): number {
		let pruned = 0;
		let deferred = 0;

		for (const [leafId, binding] of Array.from(this.bindings)) {
			if (liveLeafKeys.has(leafId)) continue;
			if (this.knownCmViews.has(binding.cm)) {
				// Signals disagree: the leaf is gone but CodeMirror still holds
				// the view. Leave it for the next sweep rather than guess.
				deferred += 1;
				continue;
			}

			this.clearScheduledHealthCheck(leafId);
			this.clearCmResolveRetry(leafId);
			this.healthWorkInFlight.delete(leafId);
			binding.undoManager.destroy();
			this.cmToLeafId.delete(binding.cm);
			this.bindings.delete(leafId);
			pruned += 1;
			this.log(
				`pruneOrphanedBindings: released "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`,
			);
		}

		if (pruned > 0 || deferred > 0) {
			this.trace?.("editor", "bindings-pruned", {
				source,
				pruned,
				deferred,
				remaining: this.bindings.size,
				knownCmViews: this.knownCmViews.size,
			});
		}
		return pruned;
	}

	/**
	 * Build a per-binding UndoManager without Yjs's permanent doc listener.
	 *
	 * Y.UndoManager's constructor registers two subscriptions on the shared
	 * vault doc: `afterTransaction`, which `destroy()` removes, and an
	 * anonymous `destroy` closure, which it does not — `destroy()` only calls
	 * `doc.off('afterTransaction', ...)`. That closure holds a hard reference
	 * to every UndoManager ever constructed on the doc, including the ones we
	 * tear down correctly, so the observer set grows for the whole session.
	 * Measured against a real vault: 268 `destroy` observers after ordinary
	 * use, and creating then correctly destroying 50 managers left 50 behind.
	 *
	 * We already destroy our managers explicitly on unbind, prune and
	 * teardown, so the auto-destroy-on-doc-destroy hook buys us nothing.
	 * Remove whichever `destroy` observers the constructor just added.
	 *
	 * `_observers` is Yjs-internal, so every access is shape-checked; if a
	 * future Yjs changes it we silently keep the old behaviour rather than
	 * throw during a bind.
	 */
	private createUndoManager(ytext: Y.Text): Y.UndoManager {
		const doc = ytext.doc;
		// Only the `destroy` hook is surplus here — this manager's
		// `afterTransaction` subscription is the one that makes undo work.
		const before = this.snapshotDocObservers(doc, "destroy");
		const undoManager = new Y.UndoManager(ytext);
		this.releaseAddedDocObservers(doc, "destroy", before);
		return undoManager;
	}

	/**
	 * Build the collab extension without the manager y-codemirror hides in it.
	 *
	 * `YSyncConfig`'s constructor unconditionally runs `new Y.UndoManager(ytext)`
	 * (y-codemirror.next/src/y-sync.js:11) and then never reads it — the manager
	 * the editor actually drives is the one we pass to yUndoManagerFacet. That
	 * stray manager stays subscribed to the vault doc forever, so every rebind
	 * leaked one `afterTransaction` observer and one of Yjs's unremovable
	 * `destroy` closures. Measured: +72 of each across 72 tab opens, even with
	 * binding pruning working.
	 *
	 * Our own manager is constructed before this call, so anything that appears
	 * on either observer set during `yCollab` belongs to the stray one and is
	 * safe to drop.
	 */
	private buildCollabExtension(ytext: Y.Text, undoManager: Y.UndoManager): Extension {
		const doc = ytext.doc;
		const destroyBefore = this.snapshotDocObservers(doc, "destroy");
		const transactionBefore = this.snapshotDocObservers(doc, "afterTransaction");

		const extension = yCollab(ytext, this.vaultSync.provider.awareness, {
			undoManager,
		});

		this.releaseAddedDocObservers(doc, "destroy", destroyBefore);
		this.releaseAddedDocObservers(doc, "afterTransaction", transactionBefore);
		return extension;
	}

	/**
	 * Drop observers registered on `doc` since `before` was captured.
	 *
	 * Yjs never removes an UndoManager's `destroy` hook — `destroy()` only
	 * unsubscribes `afterTransaction` — so managers we create would otherwise be
	 * pinned for the lifetime of the doc. We destroy ours explicitly on unbind,
	 * prune and teardown, so the auto-destroy hook buys us nothing.
	 */
	private releaseAddedDocObservers(
		doc: Y.Doc | null,
		event: "destroy" | "afterTransaction",
		before: ReadonlySet<(...args: never[]) => void> | null,
	): void {
		if (!doc || !before) return;
		const after = this.snapshotDocObservers(doc, event);
		if (!after) return;
		for (const observer of after) {
			if (before.has(observer)) continue;
			doc.off(event, observer);
		}
	}

	/**
	 * Copy of the doc's observers for `event`, or null if Yjs's shape changed.
	 * `_observers` is Yjs-internal, so every step is shape-checked; on an
	 * unexpected layout we return null and keep the old leaky behaviour rather
	 * than throw mid-bind.
	 */
	private snapshotDocObservers(
		doc: Y.Doc | null,
		event: string,
	): Set<(...args: never[]) => void> | null {
		if (!doc || !("_observers" in doc)) return null;
		const observers = doc._observers;
		if (!(observers instanceof Map)) return null;
		const forEvent = observers.get(event);
		if (!(forEvent instanceof Set)) return null;
		return new Set(forEvent);
	}

	/**
	 * Check if a path is currently bound to an active editor.
	 */
	isBound(path: string): boolean {
		for (const binding of this.bindings.values()) {
			if (binding.path === path) return true;
		}
		return false;
	}

	/**
	 * True when attaching yCollab to this view cannot corrupt the shared
	 * document — i.e. the editor buffer already agrees with the `Y.Text`, or
	 * there is no `Y.Text` yet so binding will seed one from the buffer.
	 *
	 * y-codemirror performs NO initial sync: `YSyncPluginValue`'s constructor
	 * only registers an observer, and `update()` maps editor change offsets
	 * straight into the `Y.Text` (`ytext.insert(fromA + adj, …)`). Bind onto a
	 * buffer that does not match and the user's next keystroke writes at a
	 * semantically wrong offset, or throws `Length exceeded!` from inside the
	 * CodeMirror update cycle — either way the corruption replicates.
	 *
	 * Nothing checks this today: `bind()` never compares, and
	 * `inspectBindingHealth` verifies facet identity and awareness, never
	 * content. The one method that would reconcile the two, `heal()`, has no
	 * production caller.
	 *
	 * Callers that can encounter a genuinely diverged pair should decline to
	 * bind and let reconcile's closed-file planner arbitrate, rather than pick
	 * a winner here — both sides may hold real content, and silently choosing
	 * the editor is how the CRDT loses remote edits with no artifact.
	 */
	canBindWithoutDivergence(view: MarkdownView): boolean {
		const file = view.file;
		if (!file) return false;
		const ytext = this.vaultSync.getTextForPath(file.path);
		if (!ytext) return true;
		try {
			return ytext.toJSON() === view.editor.getValue();
		} catch {
			// A view mid-teardown can throw out of `editor.getValue()`. This
			// predicate is called from sweeps that iterate every open leaf, so an
			// unhandled throw here aborts the whole sweep and leaves the remaining
			// leaves unexamined. Same discipline as DiskMirror's
			// hasFocusedEditorUnflushedChanges: an editor in flux is treated as
			// "not safe", never as a reason to stop.
			return false;
		}
	}

	/**
	 * Gate for bind(): true when the caller may proceed to attach yCollab.
	 *
	 * False means one of:
	 *   - the buffer and the `Y.Text` disagree and an arbitration has just been
	 *     kicked off (bind() is re-invoked when it converges),
	 *   - an arbitration for this path is already in flight,
	 *   - arbitration is in its post-failure backoff window,
	 *   - there is no arbiter wired, or the buffer could not be read.
	 *
	 * In every one of those cases the correct action is to NOT bind and to NOT
	 * retry in a loop. The caller's trackOpenFile is unaffected — the
	 * orchestrator calls it after bind() regardless of the outcome, which is
	 * load-bearing: without the path in DiskMirror's openPaths a remote write
	 * takes the closed-file lane and force-writes CRDT content over the diverged
	 * file within ~300ms (diskMirror.ts queueImmediateWrite / flushWrite), and
	 * the getLastEditorActivityForPath guard that would normally hold it back
	 * iterates BINDINGS, so it is dead for an unbound path.
	 */
	private guardBindDivergence(
		view: MarkdownView,
		path: string,
		deviceName: string,
		leafId: string,
	): boolean {
		// Consumed unconditionally so a token can never outlive the one bind()
		// the async settle check minted it for. Only the seed branch reads it.
		const settleConfirmed = this.settledBufferPass.delete(path);

		// The harness gate deliberately holds a bound buffer and its Y.Text apart.
		// Arbitration would "fix" the scenario out from under it.
		if (this.bindingPropagationGate?.isPaused(path)) return true;

		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) {
			// No Y.Text yet: binding SEEDS one from this buffer via
			// resolveBindingTarget -> ensureFile. There is nothing to diverge from,
			// but the stale-buffer hazard is the same one and the consequence is
			// worse — the note enters the CRDT holding the previous note's content,
			// or "", with nothing to arbitrate against later.
			//
			// view.file updates before the editor document loads; a stale read here
			// imported the previous note's content into this note's Y.Text in
			// production.
			if (!this.readDiskContent) return true;
			if (settleConfirmed) return true;
			return this.beginBufferSettleCheck(view, path, deviceName, leafId, "seed");
		}

		// Already attached to this very buffer. bind() will no-op, repair, or
		// re-attach the same pair; none of those changes how offsets map, and
		// arbitration here would write into a Y.Text that yCollab is live on.
		const existing = this.bindings.get(leafId);
		if (existing && existing.path === path) return true;

		let bufferContent: string;
		try {
			bufferContent = view.editor.getValue();
		} catch (err) {
			this.trace?.("editor", "binding-divergence-check-failed", {
				path,
				leafId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}

		if (ytext.toJSON() === bufferContent) return true;

		// Diverged AS READ — which is not yet a fact about this note. The read
		// above may have returned the PREVIOUSLY displayed file's content, or "",
		// because view.file updates before the editor document loads. Handing that
		// string to the arbiter as the authoritative local side is exactly how a
		// healthy synced note (crdtHash == baselineHash) took the
		// "import-disk-to-crdt" branch and silently imported the previous note's
		// content into its Y.Text in production — no artifact, replicated
		// everywhere.
		//
		// So nothing is arbitrated from here. The async phase first confirms the
		// buffer is the settled content of THIS path, then re-reads and re-checks
		// divergence before any arbiter runs.
		return this.beginBufferSettleCheck(view, path, deviceName, leafId, "arbitrate");
	}

	/**
	 * Enter the async phase for a path bind() has just refused: confirm the
	 * buffer has settled, then (for "arbitrate") re-check divergence and arbitrate
	 * if it survives, or (for "seed") let the seeding bind through.
	 *
	 * Always returns false — the current bind attempt never proceeds. The async
	 * phase re-invokes bind() when it has something to bind.
	 */
	private beginBufferSettleCheck(
		view: MarkdownView,
		path: string,
		deviceName: string,
		leafId: string,
		mode: BufferSettleMode,
	): false {
		if (this.divergenceArbitrationInFlight.has(path)) {
			this.trace?.("editor", "binding-divergence-arbitration-skipped", {
				path,
				leafId,
				reason: "in-flight",
			});
			return false;
		}

		const retryAfter = this.divergenceArbitrationRetryAfter.get(path) ?? 0;
		const now = Date.now();
		if (now < retryAfter) {
			this.trace?.("editor", "binding-divergence-arbitration-skipped", {
				path,
				leafId,
				reason: "backoff",
				retryInMs: retryAfter - now,
			});
			return false;
		}

		if (mode === "arbitrate" && !this.resolveDivergenceForBind) {
			this.trace?.("editor", "binding-divergence-declined", {
				path,
				leafId,
				reason: "no-arbiter",
			});
			this.log(
				`bind: "${path}" left unbound — editor buffer and CRDT diverged and no arbiter is wired`,
			);
			// Backoff even here: without it every sweep re-traces the same refusal.
			this.divergenceArbitrationRetryAfter.set(path, now + DIVERGENCE_ARBITRATION_BACKOFF_MS);
			return false;
		}

		// The in-flight marker is taken SYNCHRONOUSLY, before the first await, and
		// after bind()'s file-switch teardown has already run. Concurrent reconcile
		// sweeps therefore skip without touching disk, and no leaf is left holding a
		// stale binding while this runs.
		this.divergenceArbitrationInFlight.add(path);
		void this.runBufferSettleCheck(view, path, deviceName, leafId, mode);
		return false;
	}

	/**
	 * The async phase. Two things happen here that used to happen synchronously
	 * on a buffer nobody had checked:
	 *
	 *   1. the buffer is confirmed to be the settled content of THIS path
	 *      (see checkBufferSettled), and
	 *   2. divergence is re-tested against the freshly read buffer.
	 *
	 * Step 2 is not belt-and-braces. The common benign case for a stale gate read
	 * is that the editor finishes loading while the settle check is awaiting, and
	 * the loaded buffer agrees with the `Y.Text` after all — nothing to arbitrate,
	 * just bind.
	 */
	private async runBufferSettleCheck(
		view: MarkdownView,
		path: string,
		deviceName: string,
		leafId: string,
		mode: BufferSettleMode,
	): Promise<void> {
		let rebind = false;
		try {
			rebind = await this.decideAfterBufferSettleCheck(view, path, deviceName, leafId, mode);
		} catch (err) {
			this.divergenceArbitrationRetryAfter.set(
				path,
				Date.now() + DIVERGENCE_ARBITRATION_BACKOFF_MS,
			);
			this.trace?.("editor", "binding-divergence-declined", {
				path,
				leafId,
				mode,
				reason: "settle-check-threw",
				error: describeThrown(err),
				retryAfterMs: DIVERGENCE_ARBITRATION_BACKOFF_MS,
			});
		} finally {
			this.divergenceArbitrationInFlight.delete(path);
		}

		// Outside the try on purpose: the re-entrant bind() must see the path clear
		// of the in-flight marker, or it would skip itself.
		if (rebind) this.bind(view, deviceName);
	}

	/**
	 * The decision half of runBufferSettleCheck, split out so that its early
	 * returns cannot skip the caller's re-bind — a `return` inside a `try` runs
	 * the `finally` and then leaves the function, statements after the block
	 * included.
	 *
	 * Returns whether bind() should be re-entered for this path.
	 */
	private async decideAfterBufferSettleCheck(
		view: MarkdownView,
		path: string,
		deviceName: string,
		leafId: string,
		mode: BufferSettleMode,
	): Promise<boolean> {
		const check = await this.checkBufferSettled(view, path);

		if (check.status === "unavailable") {
			// Not retryable on a short timer: nothing about waiting 300 ms fixes
			// "no disk reader wired" or "the view moved on". Take the real
			// backoff so sweeps stop re-tracing it.
			this.clearUnsettledBufferRecheck(path);
			this.divergenceArbitrationRetryAfter.set(
				path,
				Date.now() + DIVERGENCE_ARBITRATION_BACKOFF_MS,
			);
			this.trace?.("editor", "binding-divergence-declined", {
				path,
				leafId,
				mode,
				reason: `settle-check-unavailable:${check.reason}`,
				retryAfterMs: DIVERGENCE_ARBITRATION_BACKOFF_MS,
			});
			return false;
		}

		if (check.status === "unsettled") {
			// NOT a failure, and deliberately NOT the 30 s backoff: this is what
			// a leaf that is still loading a file looks like, and what a note
			// being typed into inside the autosave debounce looks like. Nothing
			// is bound, nothing is arbitrated, nothing is written.
			this.handleUnsettledBuffer(view, path, deviceName, leafId, mode, check);
			return false;
		}

		this.clearUnsettledBufferRecheck(path);

		if (view.file?.path !== path) {
			this.trace?.("editor", "binding-settle-check-view-gone", {
				path,
				leafId,
				mode,
				nowShowing: view.file?.path ?? null,
			});
			return false;
		}

		if (mode === "seed") {
			this.trace?.("editor", "binding-seed-buffer-settled", {
				path,
				leafId,
				bufferLength: check.buffer.length,
				diskLength: check.disk?.length ?? null,
				exactDiskMatch: check.buffer === check.disk,
			});
			this.divergenceArbitrationRetryAfter.delete(path);
			this.settledBufferPass.add(path);
			return true;
		}

		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext || ytext.toJSON() === check.buffer) {
			// The gate's read was stale (or the note finished loading while we
			// awaited). This is the row that used to import the previous note's
			// content into a healthy note's Y.Text; now it costs one disk read
			// and a rebind, and the Y.Text is not touched at all.
			this.trace?.("editor", "binding-divergence-cleared-by-settle", {
				path,
				leafId,
				settledBufferLength: check.buffer.length,
				crdtLength: ytext?.toJSON().length ?? null,
			});
			this.divergenceArbitrationRetryAfter.delete(path);
			return true;
		}

		const arbiter = this.resolveDivergenceForBind;
		if (!arbiter) return false;

		const crdtContent = ytext.toJSON();
		this.trace?.("editor", "binding-divergence-arbitration-started", {
			path,
			leafId,
			bufferLength: check.buffer.length,
			crdtLength: crdtContent.length,
			// True when the buffer and the Y.Text differ ONLY in line endings:
			// a CRLF-on-disk note whose Y.Text kept CRLF, opened in a CodeMirror
			// that normalized the buffer to LF. That pair is genuinely unbindable
			// (offsets differ), so it arbitrates and converges the Y.Text to LF —
			// once per legacy note. Traced separately so a vault-wide one-time
			// normalization wave is visible as such rather than read as a wave of
			// real divergences.
			eolOnlyDivergence:
				normalizeEolForSettleCompare(crdtContent)
				=== normalizeEolForSettleCompare(check.buffer),
			// False on a CRLF vault even for a fully settled buffer. Recorded so
			// the settle guard's normalization is auditable from a trace.
			exactDiskMatch: check.buffer === check.disk,
		});
		this.log(`bind: arbitrating editor/CRDT divergence for "${path}" before binding`);

		let outcome: BindDivergenceOutcome = "declined";
		let error: unknown = null;
		try {
			outcome = await arbiter(path, check.buffer);
		} catch (err) {
			error = err;
			outcome = "declined";
		}
		return this.finishDivergenceArbitration(view, path, leafId, outcome, error);
	}

	/**
	 * Has the editor finished loading this path into its buffer?
	 *
	 * `view.file` is set before the editor document loads, so it answers "which
	 * file is this leaf for", never "what is in the buffer". Disk is the only
	 * cheap second opinion available at bind time. Compared modulo line endings
	 * because CodeMirror normalizes its document to "\n" — a raw compare would
	 * report every note in a CRLF vault as permanently unsettled and disable the
	 * guard vault-wide.
	 *
	 * The returned `buffer` is the EXACT buffer, read after the await. Callers
	 * pass that, never a normalized form, to anything that writes.
	 */
	private async checkBufferSettled(
		view: MarkdownView,
		path: string,
	): Promise<BufferSettleCheck> {
		const read = this.readDiskContent;
		if (!read) {
			return { status: "unavailable", buffer: "", disk: null, reason: "no-disk-reader" };
		}

		let disk: string | null;
		try {
			disk = await read(path);
		} catch {
			disk = null;
		}

		if (view.file?.path !== path) {
			return { status: "unavailable", buffer: "", disk, reason: "view-moved" };
		}

		let buffer: string;
		try {
			buffer = view.editor.getValue();
		} catch {
			return { status: "unavailable", buffer: "", disk, reason: "buffer-unreadable" };
		}

		if (disk === null) {
			// No file on disk yet — a note Obsidian has created but not flushed, or
			// a read that failed. Both resolve on their own within a tick or two, so
			// this is a short re-check rather than a decline.
			return { status: "unsettled", buffer, disk, reason: "disk-unreadable" };
		}

		if (normalizeEolForSettleCompare(buffer) === normalizeEolForSettleCompare(disk)) {
			return { status: "settled", buffer, disk, reason: "buffer-matches-disk" };
		}

		return { status: "unsettled", buffer, disk, reason: "buffer-differs-from-disk" };
	}

	/**
	 * Look again shortly, up to a bound, then fall through to the real backoff.
	 *
	 * Deliberately separate from DIVERGENCE_ARBITRATION_BACKOFF_MS: parking a
	 * still-loading leaf for 30 s would make an ordinary file open feel broken,
	 * and arming a failure backoff for a non-failure would hide the real one.
	 */
	private handleUnsettledBuffer(
		view: MarkdownView,
		path: string,
		deviceName: string,
		leafId: string,
		mode: BufferSettleMode,
		check: BufferSettleCheck,
	): void {
		const attempts = (this.unsettledBufferAttempts.get(path) ?? 0) + 1;
		this.unsettledBufferAttempts.set(path, attempts);

		if (attempts > UNSETTLED_BUFFER_MAX_RECHECKS) {
			this.unsettledBufferAttempts.delete(path);
			this.clearUnsettledBufferRecheck(path);
			this.divergenceArbitrationRetryAfter.set(
				path,
				Date.now() + DIVERGENCE_ARBITRATION_BACKOFF_MS,
			);
			// Distinct reason. "buffer-never-settled" is a leaf that never agreed
			// with disk — a note under continuous typing, or an adapter that keeps
			// disagreeing — and reads nothing like "arbiter-declined".
			this.trace?.("editor", "binding-divergence-declined", {
				path,
				leafId,
				mode,
				reason: "buffer-never-settled",
				attempts,
				bufferLength: check.buffer.length,
				diskLength: check.disk?.length ?? null,
				retryAfterMs: DIVERGENCE_ARBITRATION_BACKOFF_MS,
			});
			this.log(
				`bind: "${path}" left unbound — the editor buffer never settled against disk`,
			);
			return;
		}

		this.trace?.("editor", "binding-buffer-unsettled", {
			path,
			leafId,
			mode,
			attempts,
			reason: check.reason,
			bufferLength: check.buffer.length,
			diskLength: check.disk?.length ?? null,
		});

		if (this.pendingUnsettledRechecks.has(path)) return;
		const timer = window.setTimeout(() => {
			this.pendingUnsettledRechecks.delete(path);
			if (view.file?.path !== path) {
				this.unsettledBufferAttempts.delete(path);
				return;
			}
			this.bind(view, deviceName);
		}, UNSETTLED_BUFFER_RECHECK_DELAY_MS);
		this.pendingUnsettledRechecks.set(path, timer);
	}

	private clearUnsettledBufferRecheck(path: string): void {
		const timer = this.pendingUnsettledRechecks.get(path);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.pendingUnsettledRechecks.delete(path);
		}
		this.unsettledBufferAttempts.delete(path);
	}

	/**
	 * Land an arbitration result. Returns whether the caller should re-bind, and
	 * says yes only after re-verifying convergence ourselves — which is what
	 * bounds the recursion: bind() → arbitration → bind() can only happen when
	 * the buffer and the `Y.Text` now hold the same string, and in that state the
	 * gate above passes without arbitrating again.
	 *
	 * The in-flight marker is the caller's to clear (its `finally`), so this
	 * method must not re-enter bind() itself.
	 */
	private finishDivergenceArbitration(
		view: MarkdownView,
		path: string,
		leafId: string,
		outcome: BindDivergenceOutcome,
		error: unknown,
	): boolean {
		if (outcome !== "resolved") {
			this.divergenceArbitrationRetryAfter.set(
				path,
				Date.now() + DIVERGENCE_ARBITRATION_BACKOFF_MS,
			);
			this.trace?.("editor", "binding-divergence-declined", {
				path,
				leafId,
				reason: error ? "arbiter-threw" : "arbiter-declined",
				error: describeThrown(error),
				retryAfterMs: DIVERGENCE_ARBITRATION_BACKOFF_MS,
			});
			this.log(
				`bind: "${path}" left unbound — divergence arbitration declined ` +
				`(retry not before ${DIVERGENCE_ARBITRATION_BACKOFF_MS}ms)`,
			);
			return false;
		}

		// The view may have been closed or switched to another file while the
		// arbitration was running.
		if (view.file?.path !== path) {
			this.trace?.("editor", "binding-divergence-resolved-view-gone", {
				path,
				leafId,
				nowShowing: view.file?.path ?? null,
			});
			this.divergenceArbitrationRetryAfter.delete(path);
			return false;
		}

		// Independent convergence check. An arbiter that reports "resolved"
		// without converging must not be trusted into a rebind: bind() would
		// re-detect the divergence, start another arbitration, and loop.
		const ytext = this.vaultSync.getTextForPath(path);
		let converged: boolean;
		try {
			converged = !ytext || ytext.toJSON() === view.editor.getValue();
		} catch {
			converged = false;
		}
		if (!converged) {
			this.divergenceArbitrationRetryAfter.set(
				path,
				Date.now() + DIVERGENCE_ARBITRATION_BACKOFF_MS,
			);
			this.trace?.("editor", "binding-divergence-declined", {
				path,
				leafId,
				reason: "still-diverged-after-arbitration",
				retryAfterMs: DIVERGENCE_ARBITRATION_BACKOFF_MS,
			});
			return false;
		}

		this.divergenceArbitrationRetryAfter.delete(path);
		this.trace?.("editor", "binding-divergence-resolved", { path, leafId });
		return true;
	}

	/**
	 * Record what an out-of-scope teardown is about to drop.
	 *
	 * The trade is accepted — dropping unflushed editor→CRDT content is the
	 * point of excluding a path, the bytes are still on disk, and other devices
	 * keep the last-synced version — but it must be observable. Without this the
	 * only evidence a user's in-flight edit stopped propagating is the absence of
	 * a trace.
	 */
	private traceOutOfScopeTeardown(view: MarkdownView, path: string, action: string): void {
		if (!this.isBound(path)) return;
		const ytext = this.vaultSync.getTextForPath(path);
		let unflushedChars: number | null = null;
		try {
			const buffer = view.editor.getValue();
			const crdt = ytext?.toJSON() ?? null;
			unflushedChars = crdt === null || crdt === buffer ? 0 : buffer.length - crdt.length;
		} catch {
			// View mid-teardown: report "unknown" rather than abort the teardown.
		}
		this.trace?.("editor", "binding-out-of-scope-teardown", {
			path,
			action,
			unflushedChars,
			contentAtRisk: unflushedChars === null ? null : unflushedChars !== 0,
		});
		this.log(
			`${action}: tearing down out-of-scope binding for "${path}" — ` +
			`unflushed editor→CRDT content is dropped (still on disk)`,
		);
	}

	/**
	 * Update binding metadata after a batch rename. If any bound editor's
	 * tracked path was renamed, update the tracking. The yCollab binding
	 * itself doesn't need to change (stable file IDs), but our bookkeeping does.
	 */
	updatePathsAfterRename(renames: Map<string, string>): void {
		for (const [leafId, binding] of this.bindings) {
			const newPath = renames.get(binding.path);
			if (newPath) {
				this.log(`updatePaths: "${binding.path}" -> "${newPath}" (leaf=${leafId})`);
				binding.path = newPath;
			}
		}
	}

	getBindingDebugInfoForView(view: MarkdownView): BindingDebugInfo | null {
		const file = view.file;
		const leafId =
			view.leaf.id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) return null;

		const liveCm = this.getCmView(view);
		const liveCmId = liveCm ? this.getCmId(liveCm) : null;
		return {
			leafId,
			path: binding.path,
			fileId: binding.fileId,
			storedCmId: binding.cmId,
			liveCmId,
			cmMatches: liveCm === binding.cm,
			lastBoundAt: binding.lastBoundAt,
		};
	}

	getBindingDebugInfo(path: string): BindingDebugInfo | null {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path !== path) continue;
			return {
				leafId,
				path: binding.path,
				fileId: binding.fileId,
				storedCmId: binding.cmId,
				liveCmId: binding.cmId,
				cmMatches: true,
				lastBoundAt: binding.lastBoundAt,
			};
		}
		return null;
	}

	getBindingHealthForView(view: MarkdownView): BindingHealthStatus {
		const file = view.file;
		const leafId =
			view.leaf.id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) {
			return {
				bound: false,
				healthy: false,
				settling: false,
				issues: ["missing-binding"],
			};
		}

		const health = this.inspectBindingHealth(view, binding);
		return {
			bound: true,
			healthy: health.healthy,
			settling: health.settling,
			issues: health.issues,
		};
	}

	auditBindings(source: string): number {
		let triggered = 0;
		const snapshot = Array.from(this.bindings.entries());
		for (const [leafId, binding] of snapshot) {
			if (this.bindings.get(leafId) !== binding) continue;
			if (this.healthWorkInFlight.has(leafId)) continue;

			const health = this.inspectBindingHealth(binding.view, binding);
			if (health.healthy || health.settling) continue;
			if (!this.isAuditActionable(binding.view, health.issues)) continue;

			triggered += 1;
			this.maybeHealBinding(leafId, binding, source);
		}
		return triggered;
	}

	getLastEditorActivityForPath(path: string): number | null {
		let latest: number | null = null;
		for (const binding of this.bindings.values()) {
			if (binding.path !== path) continue;
			if (latest == null || binding.lastEditorChangeAtMs > latest) {
				latest = binding.lastEditorChangeAtMs;
			}
		}
		return latest;
	}

	getCollabDebugInfoForView(view: MarkdownView): CollabDebugInfo | null {
		const file = view.file;
		if (!file) return null;

		const leafId =
			view.leaf.id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			return {
				leafId,
				path: file.path,
				cmId: null,
				hasSyncFacet: false,
				awarenessMatchesProvider: null,
				yTextMatchesExpected: null,
				undoManagerMatchesFacet: null,
				facetFileId: null,
				expectedFileId: this.vaultSync.getFileId(file.path) ?? null,
				facetTextLength: null,
				cmDocLength: null,
			};
		}

		type SyncFacetLike = {
			ytext?: Y.Text;
			awareness?: unknown;
			undoManager?: Y.UndoManager;
		} | undefined;

		let syncFacet: SyncFacetLike;
		try {
			syncFacet = cm.state.facet(ySyncFacet);
		} catch {
			syncFacet = undefined;
		}

		const binding = this.bindings.get(leafId);
		const expectedText = this.vaultSync.getTextForPath(file.path);
		const expectedFileId =
			this.vaultSync.getFileId(file.path)
			?? (expectedText ? this.vaultSync.getFileIdForText(expectedText) : undefined)
			?? null;
		const facetText = syncFacet?.ytext ?? null;
		const facetFileId =
			facetText instanceof Y.Text
				? (this.vaultSync.getFileIdForText(facetText) ?? null)
				: null;

		const facetUndoManager =
			syncFacet && "undoManager" in syncFacet
				? (syncFacet.undoManager ?? null)
				: null;

		return {
			leafId,
			path: file.path,
			cmId: this.getCmId(cm),
			hasSyncFacet: !!syncFacet,
			awarenessMatchesProvider: syncFacet
				? syncFacet.awareness === this.vaultSync.provider.awareness
				: null,
			yTextMatchesExpected: syncFacet
				? (expectedText ? syncFacet.ytext === expectedText : false)
				: null,
			undoManagerMatchesFacet: syncFacet
				? ("undoManager" in syncFacet
					? (binding ? facetUndoManager === binding.undoManager : null)
					: null)
				: null,
			facetFileId,
			expectedFileId,
			facetTextLength:
				facetText instanceof Y.Text
						? facetText.toJSON().length
						: null,
			cmDocLength: cm.state.doc.length,
		};
	}

	clearLocalCursor(reason: string): void {
		try {
			this.vaultSync.provider.awareness.setLocalStateField("cursor", null);
			this.trace?.("editor", "cursor-cleared", { reason });
		} catch {
			// Provider may be disconnected
		}
	}

	/**
	 * Get the CM6 EditorView from a MarkdownView.
	 *
	 * Primary strategy is Obsidian's public `editorInfoField`, which every
	 * editor state carries and which names the view owning that editor. It is
	 * exact even when several editors share one container (embeds,
	 * plugin-injected editors) or the DOM was re-parented mid-switch.
	 *
	 * DOM containment over the CM6 views registered by our global ViewPlugin
	 * stays as the fallback. Both strategies use public API only.
	 *
	 * Resolution is fail-closed: while ownership is ambiguous we return null
	 * and let the caller retry rather than bind the wrong editor.
	 */
	private getCmView(view: MarkdownView): EditorView | null {
		const container = view.containerEl;
		if (!container) return null;

		const leafId =
			view.leaf.id ?? view.file?.path ?? null;
		if (leafId) {
			const existing = this.bindings.get(leafId);
			if (
				existing
				&& existing.cm.dom.isConnected
				&& container.contains(existing.cm.dom)
			) {
				return existing.cm;
			}
		}

		const infoMatches: EditorView[] = [];
		const matches: EditorView[] = [];
		const stale: EditorView[] = [];
		for (const cm of this.knownCmViews) {
			if (!cm.dom.isConnected) {
				stale.push(cm);
				continue;
			}
			if (this.cmBelongsToView(cm, view)) {
				infoMatches.push(cm);
			}
			if (container.contains(cm.dom)) {
				matches.push(cm);
			}
		}
		for (const cm of stale) {
			this.knownCmViews.delete(cm);
			this.cmToLeafId.delete(cm);
		}

		if (infoMatches.length === 1) {
			this.lastCmResolveFailure = null;
			return infoMatches[0]!;
		}
		if (infoMatches.length > 1) {
			const focusedInfoMatch = this.findFocusedCm(infoMatches);
			if (focusedInfoMatch) {
				this.lastCmResolveFailure = null;
				return focusedInfoMatch;
			}
		}

		if (matches.length === 0) {
			// knownCmViews only fills once our global ViewPlugin is constructed,
			// and that construction can lag the workspace event that triggered
			// bind(). Measured on a 121-note vault: the editor is already live
			// (view.editor.cm connected) while knownCmViews still holds 0-2
			// entries, so both the ownership and containment passes come up
			// empty and we burn the retry budget waiting for registration.
			// CodeMirror's public findFromDOM resolves the live EditorView
			// straight from this view's container, so the note binds on the
			// first attempt instead.
			// knownCmViews only ever holds connected views (disconnected ones are
			// pruned above), so the containment pass can never return a detached
			// editor. findFromDOM has no such invariant — on a closed leaf it
			// happily finds the dead EditorView still sitting in the detached
			// container — so re-establish the invariant explicitly.
			const fromDom = EditorView.findFromDOM(container);
			if (fromDom?.dom.isConnected) {
				this.registerKnownCmView(fromDom);
				this.lastCmResolveFailure = null;
				return fromDom;
			}
			this.lastCmResolveFailure = {
				reason: this.knownCmViews.size === 0
					? "no-known-cm-views"
					: "no-container-match",
				knownCmViews: this.knownCmViews.size,
				containerMatches: 0,
				infoMatches: infoMatches.length,
			};
			return null;
		}
		if (matches.length === 1) {
			this.lastCmResolveFailure = null;
			return matches[0]!;
		}

		const focused = this.findFocusedCm(matches);
		if (focused) {
			this.lastCmResolveFailure = null;
			return focused;
		}

		const ids = matches.map((cm) => this.getCmId(cm));
		this.lastCmResolveFailure = {
			reason: "ambiguous",
			knownCmViews: this.knownCmViews.size,
			containerMatches: matches.length,
			infoMatches: infoMatches.length,
		};
		this.trace?.("editor", "cm-resolution-ambiguous", {
			leafId: leafId ?? "unknown",
			path: view.file?.path ?? null,
			matches: ids,
		});
		this.log(
			`getCmView: ambiguous CM6 match for "${view.file?.path ?? "(unknown)"}" ` +
			`(leaf=${leafId ?? "unknown"}, matches=${ids.join(",")})`,
		);

		return null;
	}

	private warnCmDegraded(): void {
		if (this.cmDegradedWarned) return;
		this.cmDegradedWarned = true;
		new Notice(
			"YAOS: Could not resolve the active editor instance. " +
			"Live collaborative editing is unavailable. Background sync may still continue, " +
			"but live cursors and editor binding are degraded. Please check for a plugin update.",
			10000,
		);
		console.error(
			"[yaos] Critical: Could not locate CodeMirror 6 EditorView. Live binding disabled.",
		);
	}

	/**
	 * True when `cm` is the editor Obsidian associates with `view`, according
	 * to the public editorInfoField carried in the editor's state.
	 */
	private cmBelongsToView(cm: EditorView, view: MarkdownView): boolean {
		let info: MarkdownFileInfo | undefined;
		try {
			info = cm.state.field(editorInfoField, false);
		} catch {
			return false;
		}

		if (!info) return false;
		if (info === view) return true;
		// Some editors expose a separate MarkdownFileInfo for the same file.
		// Demand a live file plus a shared Editor before claiming ownership so
		// two fileless editors cannot resolve to each other.
		if (!view.file || info.file !== view.file) return false;
		return info.editor !== undefined && info.editor === view.editor;
	}

	private findFocusedCm(cms: EditorView[]): EditorView | null {
		const activeElement =
			typeof document !== "undefined" ? document.activeElement : null;
		const focused = cms.filter((cm) =>
			cm.hasFocus || (activeElement ? cm.dom.contains(activeElement) : false),
		);
		return focused.length === 1 ? focused[0]! : null;
	}

	private getCmId(cm: EditorView): string {
		const existing = this.cmIds.get(cm);
		if (existing) return existing;
		const cmId = `cm-${++this.cmCounter}`;
		this.cmIds.set(cm, cmId);
		return cmId;
	}

	private registerKnownCmView(cm: EditorView): void {
		this.knownCmViews.add(cm);
	}

	private unregisterKnownCmView(cm: EditorView): void {
		this.knownCmViews.delete(cm);
		this.cmToLeafId.delete(cm);
	}

	private inspectBindingHealth(
		view: MarkdownView,
		binding: EditorBinding,
	): BindingHealthCheck {
		if (this.bindingPropagationGate?.isPaused(binding.path)) {
			// Harness gate: treat as healthy so we don't auto-heal/rebind mid-scenario.
			return { healthy: true, settling: false, issues: [], deferredIssues: [] };
		}
		const issues: string[] = [];
		const deferredIssues: string[] = [];
		const file = view.file;
		const liveCm = this.getCmView(view);
		const collab = this.getCollabDebugInfoForView(view);
		const withinSettleWindow =
			Date.now() - binding.lastBoundAtMs < binding.settleWindowMs;

		if (!file) {
			issues.push("missing-file");
		} else if (binding.path !== file.path) {
			issues.push("path-changed");
		}

		if (!liveCm) {
			issues.push("missing-cm");
		} else if (liveCm !== binding.cm) {
			issues.push("cm-changed");
		}

		if (!collab) {
			issues.push("missing-collab-info");
		} else {
			if (!collab.hasSyncFacet) {
				if (withinSettleWindow) {
					deferredIssues.push("missing-sync-facet");
				} else {
					issues.push("missing-sync-facet");
				}
			}
			if (collab.awarenessMatchesProvider === false) {
				issues.push("awareness-mismatch");
			}
			if (collab.yTextMatchesExpected === false) {
				issues.push("ytext-mismatch");
			}
		}

		return {
			healthy: issues.length === 0,
			settling: issues.length === 0 && deferredIssues.length > 0,
			issues,
			deferredIssues,
		};
	}

	private handleLiveEditorUpdate(update: ViewUpdate): void {
		const match = this.findBindingForCm(update.view);
		if (!match) return;
		if (update.docChanged) {
			match.binding.lastEditorChangeAtMs = Date.now();
		}
		this.maybeHealBinding(match.leafId, match.binding, "live-update");
	}

	private maybeHealBinding(
		leafId: string,
		binding: EditorBinding,
		source: string,
	): void {
		if (this.healthWorkInFlight.has(leafId)) return;
		if (this.bindings.get(leafId) !== binding) return;
		if (this.bindingPropagationGate?.isPaused(binding.path)) return;

		const health = this.inspectBindingHealth(binding.view, binding);
		if (health.healthy || health.settling) return;
		if (source === "live-update") {
			this.scheduleHealthCheck(leafId, LIVE_UPDATE_HEALTH_RETRY_DELAY_MS, "live-update-deferred");
			return;
		}
		const onlyMissingSyncFacet =
			health.issues.length === 1 && health.issues[0] === "missing-sync-facet";
		if (onlyMissingSyncFacet && source !== "retry-health-check") {
			const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
			this.trace?.("editor", "binding-health-missing-sync-facet-deferred", {
				...traceDetails,
				action: "deferred",
			});
			const retryDelayMs = binding.settleWindowMs + POST_BIND_HEALTH_GRACE_MS;
			this.scheduleHealthCheck(leafId, retryDelayMs, "retry-health-check");
			return;
		}

		const issues = health.issues.join(",") || "unknown";
		const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
		this.healthWorkInFlight.add(leafId);
		this.trace?.("editor", "binding-health-failed", traceDetails);
		this.log(
			`binding-health-failed: "${binding.path}" ` +
			`(leaf=${leafId}, cm=${binding.cmId}, source=${source}, issues=${issues})`,
		);

		try {
			const repaired = this.repair(
				binding.view,
				this.lastDeviceName,
				`${source}:${issues}`,
			);
			if (!repaired) {
				this.rebind(binding.view, this.lastDeviceName, `${source}:${issues}`);
			}
			const latestBinding = this.bindings.get(leafId);
			const tombstoned = this.isHardTombstonedPath(binding.path);
			const postView = latestBinding?.view ?? binding.view;
			const postHealth = latestBinding
				? this.inspectBindingHealth(postView, latestBinding)
				: null;
			const restored =
				tombstoned
				|| (!!postHealth && (postHealth.healthy || postHealth.settling));
			if (!restored) {
				this.trace?.("editor", "binding-health-retry-scheduled", {
					...traceDetails,
					action: "retry-scheduled",
					post: this.getCollabDebugInfoForView(postView),
					postIssues: postHealth?.issues ?? ["missing-binding"],
				});
				const retryDelayMs =
					(latestBinding?.settleWindowMs ?? BASE_BINDING_SETTLE_WINDOW_MS)
					+ POST_BIND_HEALTH_GRACE_MS;
				this.scheduleHealthCheck(leafId, retryDelayMs, "retry-health-check");
				return;
			}
			this.trace?.("editor", "binding-health-restored", {
				...traceDetails,
				action: tombstoned
					? "unbound-tombstone"
					: (postHealth?.settling
						? "settling"
						: (repaired
							? (!latestBinding
								? "unbound"
								: (latestBinding.path === binding.path
									&& latestBinding.fileId === binding.fileId
									? "repair-only"
									: "rebound-target"))
							: "rebind")),
				postIssues: postHealth?.issues ?? [],
				post: this.getCollabDebugInfoForView(postView),
			});
		} finally {
			this.healthWorkInFlight.delete(leafId);
		}
	}

	private scheduleCmResolveRetry(
		view: MarkdownView,
		deviceName: string,
		leafId: string,
		source: string,
	): void {
		const attempts = (this.cmResolveAttempts.get(leafId) ?? 0) + 1;
		this.cmResolveAttempts.set(leafId, attempts);

		if (attempts > CM_RESOLVE_MAX_RETRIES) {
			this.warnCmDegraded();
			this.trace?.("editor", "cm-resolution-degraded", {
				leafId,
				path: view.file?.path ?? null,
				source,
				attempts,
				failure: this.lastCmResolveFailure,
			});
			return;
		}

		if (this.pendingCmResolveRetries.has(leafId)) {
			return;
		}

		const retryDelay = CM_RESOLVE_RETRY_DELAY_MS * attempts;
		const timer = window.setTimeout(() => {
			this.pendingCmResolveRetries.delete(leafId);
			this.bind(view, deviceName);
		}, retryDelay);
		this.pendingCmResolveRetries.set(leafId, timer);
	}

	private clearCmResolveRetry(leafId: string): void {
		const timer = this.pendingCmResolveRetries.get(leafId);
		if (timer) {
			window.clearTimeout(timer);
			this.pendingCmResolveRetries.delete(leafId);
		}
		this.cmResolveAttempts.delete(leafId);
	}

	private scheduleHealthCheck(
		leafId: string,
		delayMs: number,
		source: string,
	): void {
		this.clearScheduledHealthCheck(leafId);
		const timer = window.setTimeout(() => {
			this.pendingHealthChecks.delete(leafId);
			const binding = this.bindings.get(leafId);
			if (!binding) return;
			this.maybeHealBinding(leafId, binding, source);
		}, delayMs);
		this.pendingHealthChecks.set(leafId, timer);
	}

	private schedulePostBindHealthCheck(leafId: string, settleWindowMs: number): void {
		this.scheduleHealthCheck(
			leafId,
			settleWindowMs + POST_BIND_HEALTH_GRACE_MS,
			"post-bind-health",
		);
	}

	private clearScheduledHealthCheck(leafId: string): void {
		const timer = this.pendingHealthChecks.get(leafId);
		if (timer) {
			window.clearTimeout(timer);
			this.pendingHealthChecks.delete(leafId);
		}
	}

	private applyBinding(options: {
		action: "bind" | "repair";
		deviceName: string;
		view: MarkdownView;
		cm: EditorView;
		cmId: string;
		leafId: string;
		filePath: string;
		ytext: Y.Text;
		fileId?: string;
		existing?: EditorBinding;
		reason?: string;
	}): boolean {
		const {
			action,
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath,
			ytext,
			fileId,
			existing,
			reason,
		} = options;

		const undoManager = this.createUndoManager(ytext);

		this.vaultSync.provider.awareness.setLocalStateField("user", {
			name: deviceName,
			...deviceCursorColor(deviceName),
		});

		const collabExtension = this.buildCollabExtension(ytext, undoManager);

		try {
			this.clearLocalCursor(`${action}-pre-reconfigure`);
			cm.dispatch({
				effects: this.compartment.reconfigure(collabExtension),
			});
		} catch (err) {
			undoManager.destroy();
			this.log(
				`${action}: failed "${filePath}" ` +
				`(leaf=${leafId}, cm=${cmId}, reason=${reason ?? "n/a"}): ${String(err)}`,
			);
			return false;
		}

		existing?.undoManager.destroy();
		if (existing) {
			this.cmToLeafId.delete(existing.cm);
		}
		const boundAtMs = Date.now();
		const rapidSwitch =
			!!existing
			&& existing.path !== filePath
			&& boundAtMs - existing.lastBoundAtMs <= FAST_SWITCH_WINDOW_MS;
		const settleWindowMs = rapidSwitch
			? FAST_SWITCH_BINDING_SETTLE_WINDOW_MS
			: BASE_BINDING_SETTLE_WINDOW_MS;
		this.bindings.set(leafId, {
			view,
			path: filePath,
			ytext,
			undoManager,
			cm,
			cmId,
			fileId,
			lastBoundAt: new Date(boundAtMs).toISOString(),
			lastBoundAtMs: boundAtMs,
			lastEditorChangeAtMs: boundAtMs,
			settleWindowMs,
		});
		this.cmToLeafId.set(cm, leafId);
		this.schedulePostBindHealthCheck(leafId, settleWindowMs);
		this.trace?.("editor", "binding-applied", {
			action,
			leafId,
			path: filePath,
			cmId,
			fileId: fileId ?? null,
			reason: reason ?? null,
			settleWindowMs,
			rapidSwitch,
		});

		// Emit editor.repair.applied only for successful repair-action applications.
		if (action === "repair") {
			this.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.editorRepairApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path: filePath,
				data: {
					leafId,
					cmId,
					reason: reason ?? null,
					rapidSwitch,
				},
			});
		}

		const result = action === "repair" ? "repaired" : "bound";
		const reasonSuffix = reason ? `, reason=${reason}` : "";
		const settleSuffix = rapidSwitch
			? `, settleWindowMs=${settleWindowMs}, rapidSwitch=true`
			: `, settleWindowMs=${settleWindowMs}`;
		this.log(
			`${action}: ${result} "${filePath}" ` +
			`(leaf=${leafId}, cm=${cmId}${fileId ? `, fileId=${fileId}` : ""}${reasonSuffix}${settleSuffix})`,
		);
		return true;
	}

	private log(msg: string): void {
		this.trace?.("editor", msg);
		if (this.debug) {
			console.debug(`[yaos:editor] ${msg}`);
		}
	}

	private findBindingForCm(cm: EditorView): { leafId: string; binding: EditorBinding } | null {
		const leafId = this.cmToLeafId.get(cm);
		if (leafId) {
			const binding = this.bindings.get(leafId);
			if (binding && binding.cm === cm) {
				return { leafId, binding };
			}
		}

		for (const [fallbackLeafId, binding] of this.bindings) {
			if (binding.cm === cm) {
				this.cmToLeafId.set(cm, fallbackLeafId);
				return { leafId: fallbackLeafId, binding };
			}
		}

		return null;
	}

	private resolveBindingTarget(
		view: MarkdownView,
		deviceName: string,
		reason: string,
	): BindingTarget | null {
		const file = view.file;
		if (!file) return null;

		// Scope gate. This sits at the top deliberately, ABOVE the existingText
		// short circuit below, because the two cases leak in opposite directions
		// and both have to be refused:
		//
		//   already in the CRDT (excluded after it had synced) — binding would
		//     pipe remote edits straight into the editor buffer, which Obsidian
		//     then persists. That is the same overwrite DiskMirror now refuses,
		//     arriving by a route DiskMirror never sees.
		//
		//   not in the CRDT — ensureFile() below would ADMIT the file, seeded
		//     from the editor buffer. An excluded note would start syncing
		//     merely because the user opened it.
		//
		// This method is the sole door to ensureFile and the sole producer of
		// every BindingTarget, so one gate covers bind(), repair() and heal().
		// All three already handle a null target.
		if (!this.isMarkdownPathSyncable(file.path)) {
			this.trace?.("editor", "binding-blocked-out-of-scope", {
				path: file.path,
				reason,
			});
			return null;
		}

		const existingText = this.vaultSync.getTextForPath(file.path);
		if (existingText) {
			return {
				ytext: existingText,
				fileId:
					this.vaultSync.getFileId(file.path)
					?? this.vaultSync.getFileIdForText(existingText),
			};
		}

		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, reason);
			return null;
		}

		// Seeding a NEW Y.Text from the buffer. Same stale-read hazard as the
		// divergence gate, worse consequence: view.file updates before the editor
		// document loads, so an unguarded read here admits the note to the CRDT
		// holding the previous note's content (or ""), with no second side to
		// arbitrate against afterwards.
		//
		// bind() is the only caller that can reach this with a freshly opened,
		// still-loading leaf, and guardBindDivergence's "seed" branch has already
		// confirmed the buffer against disk before letting bind() through. repair()
		// only reaches resolveBindingTarget with an existing binding, which implies
		// a Y.Text already exists and this branch is not taken; heal() has no
		// production caller.
		const currentContent = view.editor.getValue();
		const ytext = this.vaultSync.ensureFile(file.path, currentContent, deviceName);
		if (!ytext) {
			if (this.isHardTombstonedPath(file.path)) {
				this.handleTombstonedBinding(view, `${reason}:ensureFile-null`);
			} else {
				this.log(`resolveBindingTarget: ensureFile returned null for "${file.path}" (reason=${reason})`);
				this.trace?.("editor", "binding-target-missing", {
					path: file.path,
					reason,
					leafId:
						view.leaf.id ?? file.path,
				});
			}
			return null;
		}

		return {
			ytext,
			fileId:
				this.vaultSync.getFileId(file.path)
				?? this.vaultSync.getFileIdForText(ytext),
		};
	}

	private isHardTombstonedPath(path: string): boolean {
		return (
			!this.vaultSync.getTextForPath(path)
			&& !this.vaultSync.isPendingRenameTarget(path)
			&& this.vaultSync.isMarkdownTombstoned(path)
		);
	}

	private handleTombstonedBinding(view: MarkdownView, reason: string): void {
		const file = view.file;
		if (!file) return;

		const leafId =
			view.leaf.id ?? file.path;
		const existing = this.bindings.get(leafId);
		this.trace?.("editor", "binding-blocked-tombstone", {
			path: file.path,
			leafId,
			reason,
			hadBinding: !!existing,
			pendingRenameTarget: this.vaultSync.isPendingRenameTarget(file.path),
		});
		this.log(
			`binding blocked by tombstone for "${file.path}" ` +
			`(leaf=${leafId}, reason=${reason})`,
		);
		if (existing) {
			this.unbind(view);
		}
	}

	private buildHealthTraceDetails(
		leafId: string,
		binding: EditorBinding,
		source: string,
		issues: string[],
	): Record<string, unknown> {
		const isActiveView =
			this.workspace.getActiveViewOfType(MarkdownView) === binding.view;
		return {
			leafId,
			path: binding.path,
			cmId: binding.cmId,
			source,
			issues,
			binding: this.getBindingDebugInfoForView(binding.view),
			collab: this.getCollabDebugInfoForView(binding.view),
			isActiveLeaf: isActiveView,
			documentHasFocus: typeof document !== "undefined" ? document.hasFocus() : null,
		};
	}

	private isAuditActionable(view: MarkdownView, issues: string[]): boolean {
		const file = view.file;
		if (!file) {
			return false;
		}

		const isActiveLeaf =
			this.workspace.getActiveViewOfType(MarkdownView) === view;
		if (isActiveLeaf) {
			return true;
		}

		return issues.some(
			(issue) =>
				issue !== "missing-file"
				&& issue !== "missing-collab-info",
		);
	}
}
