/**
 * Bind-time divergence arbitration.
 *
 * # The bug this suite exists for
 *
 * y-codemirror performs NO initial sync. `YSyncPluginValue`'s constructor only
 * registers an observer; `update()` maps CodeMirror change offsets straight
 * into the `Y.Text` (`ytext.insert(fromA + adj, …)`). `applyBinding` attaches
 * yCollab to whatever buffer the view is holding, with no content comparison.
 *
 * So: edit a note on disk while the plugin is unloaded, leave it open in a
 * leaf, start the plugin. Startup reconcile DEFERS open files
 * (planClosedFileReconcile Rule 2, "open-or-bound"), then `onReconciled` →
 * `reconcileOpenEditors` / `validateOpenBindings` binds the deferred, diverged
 * buffer. Every keystroke after that lands at a semantically wrong offset in
 * the shared document, in BOTH directions, and the corruption replicates.
 *
 * # Why declining is not enough
 *
 * An open-but-unbound diverged note is not a safe resting state:
 *
 *   - reconcile defers on open-ness ALONE (`isOpenOrBound`), so it never
 *     arbitrates the path;
 *   - the default `externalEditPolicy: "always"` has the next autosave
 *     diff-merge the buffer into the CRDT, silently dropping the remote-only
 *     edits;
 *   - DiskMirror force-writes CRDT content over the diverged disk file once the
 *     leaf stops being the active view, and the `getLastEditorActivityForPath`
 *     guard that would hold that back iterates BINDINGS, so it is dead for an
 *     unbound path.
 *
 * Divergence must be RESOLVED, then bound. That is what `bind()` now does, via
 * an injected arbiter implemented in the reconciliation controller.
 *
 * # What is real here and what is not
 *
 * Real: `EditorBindingManager`, `EditorWorkspaceOrchestrator`,
 * `ReconciliationController.resolveEditorDivergenceForBind`, `Y.Doc`,
 * `Y.Text`, `Awareness`, `yCollab` extension construction, the real
 * three-way `decideClosedFileConflict`, the real `conflictArtifactPath`.
 *
 * Modelled: the CodeMirror `EditorView` (no DOM in Node, so no real CM6), and
 * therefore the keystroke. `applyKeystrokeLikeYCollab` below is the exact
 * operation y-codemirror performs on a local insertion — an offset-indexed
 * `ytext.insert` with no content comparison — which is the whole mechanism of
 * the bug.
 */

import { EditorView } from "@codemirror/view";
import type { EditorState, Text } from "@codemirror/state";
import { MarkdownView, type App, type TFile, type Vault, type Workspace, type WorkspaceLeaf } from "obsidian";
import { readFileSync } from "node:fs";
// The runtime `obsidian` module IS this file (JITI_ALIAS maps it), but the
// TYPES come from the real obsidian .d.ts, which knows nothing about the
// mock's recording. Import it under its own name to reach `Notice.shown`.
import { Notice as RecordingNotice } from "../mocks/obsidian.ts";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { EditorBindingManager, type BindDivergenceArbiter } from "../../src/sync/editorBinding";
import { EditorWorkspaceOrchestrator } from "../../src/runtime/editorWorkspaceOrchestrator";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import { contentBaselineHash, type DiskIndex } from "../../src/sync/diskIndex";
import type { DiskMirror } from "../../src/sync/diskMirror";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { VaultSyncSettings } from "../../src/settings";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import { partialOf, fixtureOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("editor-binding-divergence-bind");

const PATH = "notes/offline.md";
/** The note the leaf was showing BEFORE it switched to PATH. */
const PREV = "notes/previous.md";
/** A path with no Y.Text, for the seed-from-buffer branch. */
const FRESH = "notes/fresh.md";
const DEVICE = "laptop";
/**
 * A stable leaf id. Load-bearing: without it `bind()` keys bindings by
 * `view.file.path`, so a same-leaf P -> Q switch would look like two unrelated
 * leaves and the file-switch teardown under test would never be reached.
 */
const LEAF_ID = "leaf-1";

/** Content the CRDT and the disk baseline agreed on before the plugin unloaded. */
const BASE = "# Offline note\n\nfirst paragraph\n";
/** The same note after the user edited it on disk with the plugin unloaded. */
const LOCAL_EDIT = "# Offline note\n\nfirst paragraph\nsecond paragraph typed offline\n";
/** The same note after a remote device changed it. */
const REMOTE_EDIT = "# Offline note\n\nfirst paragraph edited elsewhere\n";
/** Content of the note the leaf was showing before the switch. */
const PREV_CONTENT = "# Previous note\n\nsomething else entirely, and longer\n";

function eq(actual: unknown, expected: unknown, msg: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	s.check(a === e, a === e ? msg : `${msg}\n        expected=${e}\n        actual=${a}`);
}

/**
 * What y-codemirror does to the shared document when the user types.
 *
 * `YSyncPluginValue.update()` walks the CodeMirror change set and calls
 * `ytext.insert(fromA + adj, inserted)` — the BUFFER's offset, applied to the
 * `Y.Text`, with no check that the two hold the same string. Binding a diverged
 * pair is therefore not "eventually consistent later"; it is a wrong-offset
 * write on the very next keypress.
 */
function applyKeystrokeLikeYCollab(ytext: Y.Text, bufferOffset: number, typed: string): void {
	ytext.insert(bufferOffset, typed);
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 2000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => { setTimeout(resolve, 5); });
	}
	return s.check(false, `timed out waiting for: ${label}`);
}

interface HarnessOptions {
	/**
	 * Content seeded into the Y.Text, per path. A bare string is shorthand for
	 * `{ [PATH]: value }`. A path absent from this map has NO Y.Text — the
	 * seed-from-buffer branch.
	 */
	crdt: string | Record<string, string>;
	/** Content the open editor buffer holds at construction. */
	buffer: string;
	/**
	 * Content the vault reader returns, per path. Defaults to
	 * `{ [PATH]: opts.buffer }` — i.e. "the buffer is the settled content of the
	 * file", which is what every pre-existing test in this suite assumed
	 * implicitly. A path absent from this map reads as "no such file".
	 */
	disk?: Record<string, string>;
	/**
	 * Content whose hash becomes the disk-index baseline, per path. A bare string
	 * is shorthand for `{ [PATH]: value }`. A path absent from the map has no
	 * baseline entry at all — the "missing-baseline" branch, which is the ROUTINE
	 * state (contentHash is only written at settle points), not an edge.
	 */
	baseline?: string | Record<string, string>;
	/** Replace the controller-backed arbiter (failure-path tests). */
	arbiter?: BindDivergenceArbiter;
	/** Live sync-scope predicate; mutable through `harness.setScope`. */
	inScope?: boolean;
	/** Path the view reports at construction. Defaults to PATH. */
	file?: string;
	/**
	 * Construct the manager WITHOUT the disk reader, as the harness did before
	 * the settled-buffer guard existed. Used to pin that an unwired reader
	 * declines rather than trusts the buffer.
	 */
	noDiskReader?: boolean;
	/**
	 * Runs inside the disk read, i.e. DURING the async phase of the settle
	 * check. The seam for "the editor finished loading while we were awaiting",
	 * which is the common benign outcome of a stale gate read.
	 */
	duringDiskRead?: () => void;
}

interface Harness {
	doc: Y.Doc;
	/** The Y.Text for PATH. Empty when PATH was not seeded into the CRDT. */
	ytext: Y.Text;
	textFor(path: string): Y.Text;
	/** Whether vaultSync reports a Y.Text for the path at all. */
	crdtHas(path: string): boolean;
	manager: EditorBindingManager;
	orchestrator: EditorWorkspaceOrchestrator;
	controller: ReconciliationController;
	view: MarkdownView;
	leafId: string;
	/** Current editor buffer. Updated by `editor.setValue`. */
	buffer(): string;
	/**
	 * Set the buffer WITHOUT touching disk. This is the lag the incident turned
	 * on: `view.file` is already Q while `getValue()` still answers with P's
	 * content, or "".
	 */
	setBuffer(next: string): void;
	setDisk(path: string, content: string): void;
	/** Set buffer and disk together: the buffer as settled content of its file. */
	settleBuffer(next: string): void;
	/**
	 * Point the view at another file WITHOUT touching the buffer — exactly what
	 * Obsidian does on a file open or a same-leaf switch. `view.file` updates
	 * before the editor document loads.
	 */
	openFile(path: string): void;
	diskReads(): string[];
	/** path → content, for every vaultSync.ensureFile the manager performed. */
	seeded: Map<string, string>;
	traces: Array<{ msg: string; details?: Record<string, unknown> }>;
	logs: string[];
	/** path → content, for every file the conflict-artifact writer created. */
	createdFiles: Map<string, string>;
	openedPaths: string[];
	cmLookups(): number;
	setCmResolvable(resolvable: boolean): void;
	/** Swap in a second EditorView, as a workspace re-layout would. */
	useSecondCm(): void;
	/**
	 * The Y.Text the leaf's binding is currently attached to, or null when the
	 * compartment is empty.
	 */
	boundYText(): Y.Text | null;
	/**
	 * Install the ySyncFacet inspectBindingHealth reads. A facet whose `ytext`
	 * is not the path's Y.Text produces the "ytext-mismatch" issue, which is an
	 * immediate unhealthy verdict rather than a settle-window deferral.
	 */
	setSyncFacet(facet: { ytext: Y.Text; awareness: unknown } | undefined): void;
	/**
	 * Make the next `times` compartment dispatches throw, so applyBinding
	 * reports failure. A count rather than a flag because the repair-failure
	 * route needs exactly the repair's dispatch to fail and the re-attach's to
	 * succeed — otherwise "not bound" would be true for the wrong reason.
	 */
	failNextDispatches(times: number): void;
	setScope(inScope: boolean): void;
	dispose(): void;
}

function toPathMap(
	value: string | Record<string, string> | undefined,
	defaultPath: string,
): Record<string, string> {
	if (value === undefined) return {};
	if (typeof value === "string") return { [defaultPath]: value };
	return { ...value };
}

async function makeHarness(opts: HarnessOptions): Promise<Harness> {
	const doc = new Y.Doc();

	const crdtSeed = toPathMap(opts.crdt, PATH);
	const crdtPaths = new Set(Object.keys(crdtSeed));
	for (const [path, content] of Object.entries(crdtSeed)) {
		if (content) doc.getText(path).insert(0, content);
	}

	let buffer = opts.buffer;
	let inScope = opts.inScope ?? true;
	let cmResolvable = true;
	let cmLookups = 0;
	let filePath = opts.file ?? PATH;

	const disk = new Map<string, string>(
		Object.entries(opts.disk ?? { [PATH]: opts.buffer }),
	);
	const diskReads: string[] = [];
	const seeded = new Map<string, string>();

	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	const logs: string[] = [];
	const createdFiles = new Map<string, string>();
	const openedPaths: string[] = [];

	const leaf = partialOf<WorkspaceLeaf>({ id: LEAF_ID });
	const view = fixtureOf<MarkdownView>(MarkdownView, {
		file: partialOf<TFile>({ path: filePath }),
		leaf,
		editor: partialOf<MarkdownView["editor"]>({
			getValue: () => buffer,
			setValue: (next: string) => { buffer = next; },
		}),
	});
	leaf.view = view;

	const workspace = partialOf<Workspace>({
		iterateAllLeaves: (cb: (l: WorkspaceLeaf) => void) => { cb(leaf); },
		getActiveViewOfType: () => null,
	});

	const app = partialOf<App>({
		workspace,
		vault: partialOf<Vault>({
			getAbstractFileByPath: (path: string) =>
				createdFiles.has(path) ? partialOf<TFile>({ path }) : null,
			create: async (path: string, content: string) => {
				createdFiles.set(path, content);
				return partialOf<TFile>({ path });
			},
		}),
	});

	const awareness = new Awareness(doc);
	const vaultSync = partialOf<VaultSync>({
		getTextForPath: (path: string) => (crdtPaths.has(path) ? doc.getText(path) : null),
		getFileId: () => undefined,
		getFileIdForText: () => undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		ensureFile: (path: string, content: string) => {
			seeded.set(path, content);
			crdtPaths.add(path);
			const text = doc.getText(path);
			if (content && text.length === 0) text.insert(0, content);
			return text;
		},
		provider: partialOf<VaultSync["provider"]>({ awareness }),
	});

	const diskMirror = partialOf<DiskMirror>({
		notifyFileOpened: (path: string) => { openedPaths.push(path); },
		notifyFileClosed: () => {},
		flushOpenPath: async () => {},
		recordPreservedUnresolved: () => {},
	});

	let diskIndex: DiskIndex = {};
	for (const [path, content] of Object.entries(toPathMap(opts.baseline, PATH))) {
		diskIndex[path] = {
			mtime: 1,
			size: content.length,
			contentHash: await contentBaselineHash(content),
		};
	}

	const controller = new ReconciliationController({
		app,
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: DEVICE }),
		getRuntimeConfig: () => partialOf<RuntimeConfig>({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}),
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror,
		getBlobSync: () => null,
		getEditorBindings: () => manager,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => inScope,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (_source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: (message: string) => { logs.push(message); },
	});

	const arbiter: BindDivergenceArbiter = opts.arbiter
		?? ((path, bufferContent) => controller.resolveEditorDivergenceForBind(path, bufferContent));

	const readDiskContent = opts.noDiskReader
		? undefined
		: async (path: string): Promise<string | null> => {
			diskReads.push(path);
			opts.duringDiskRead?.();
			return disk.get(path) ?? null;
		};

	const manager = new EditorBindingManager(
		vaultSync,
		workspace,
		false,
		(_source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ msg, details });
		},
		undefined,
		undefined,
		(path: string) => (path === PATH ? inScope : true),
		arbiter,
		readDiskContent,
	);

	// No DOM in Node, so CodeMirror cannot resolve a real EditorView from the
	// container. Every other suite in this area does the same: hand bind() the
	// view it would have found.
	//
	// Two of them, because the re-attach route bind() takes when getCmView
	// resolves a DIFFERENT EditorView than the one the binding holds is one of
	// the paths under test. `syncFacet` and `dispatchThrows` drive the health
	// verdict and the repair outcome respectively — see Test 9.
	let syncFacet: unknown = undefined;
	let dispatchFailuresLeft = 0;
	const makeCm = (): EditorView => {
		const cm = partialOf<EditorView>({
			state: partialOf<EditorState>({
				// inspectBindingHealth reads the sync facet (inside try/catch) and
				// the doc length (not). Both have to answer without a real CM6.
				facet: () => syncFacet as never,
				doc: partialOf<Text>({ length: 0 }),
			}),
		});
		return Object.assign(cm, {
			dispatch: () => {
				if (dispatchFailuresLeft > 0) {
					dispatchFailuresLeft -= 1;
					throw new Error("view is detached");
				}
			},
		});
	};
	const cmA = makeCm();
	const cmB = makeCm();
	let activeCm = cmA;
	manager["getCmView"] = () => {
		cmLookups += 1;
		return cmResolvable ? activeCm : null;
	};

	const orchestrator = new EditorWorkspaceOrchestrator({
		app,
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: DEVICE }),
		getEditorBindings: () => manager,
		getDiskMirror: () => diskMirror,
		isMarkdownPathSyncable: (path: string) => (path === PATH ? inScope : true),
		maybeImportDeferredClosedOnlyPath: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: (message: string) => { logs.push(message); },
	});

	return {
		doc,
		ytext: doc.getText(PATH),
		textFor: (path: string) => doc.getText(path),
		crdtHas: (path: string) => crdtPaths.has(path),
		manager,
		orchestrator,
		controller,
		view,
		leafId: LEAF_ID,
		buffer: () => buffer,
		setBuffer: (next: string) => { buffer = next; },
		setDisk: (path: string, content: string) => { disk.set(path, content); },
		settleBuffer: (next: string) => {
			buffer = next;
			disk.set(filePath, next);
		},
		openFile: (path: string) => {
			filePath = path;
			// Mutating in place, not replacing the TFile: Obsidian reuses the view
			// and the manager only ever reads `view.file.path`. The buffer is
			// deliberately left alone — that IS the bug's precondition.
			(view.file as { path: string }).path = path;
		},
		diskReads: () => [...diskReads],
		seeded,
		traces,
		logs,
		createdFiles,
		openedPaths,
		cmLookups: () => cmLookups,
		setCmResolvable: (resolvable: boolean) => { cmResolvable = resolvable; },
		useSecondCm: () => { activeCm = cmB; },
		boundYText: () => {
			return manager["bindings"].get(LEAF_ID)?.ytext ?? null;
		},
		setSyncFacet: (facet) => { syncFacet = facet; },
		failNextDispatches: (times: number) => { dispatchFailuresLeft = times; },
		setScope: (next: boolean) => { inScope = next; },
		dispose: () => {
			manager.unbindAll();
			awareness.destroy();
			doc.destroy();
		},
	};
}

/**
 * What y-codemirror does when Obsidian loads a DIFFERENT file's content into a
 * CodeMirror that still has yCollab attached: `YSyncPluginValue.update()` maps
 * the whole-document replacement straight into whatever `Y.Text` the binding
 * holds. No content comparison, no identity check against `view.file`.
 *
 * Routed through the manager's live binding on purpose. With the compartment
 * emptied on the file switch there is no binding, the fill is inert, and the
 * previous note's `Y.Text` is untouched — which is the assertion. With the
 * teardown skipped, the fill lands in the PREVIOUS file's `Y.Text` and that
 * note becomes the new file's content.
 */
function modelObsidianFileLoad(h: Harness, nextContent: string): void {
	const bound = h.boundYText();
	h.setBuffer(nextContent);
	if (!bound) return;
	bound.delete(0, bound.length);
	bound.insert(0, nextContent);
}

// ── Test 1: the repro ───────────────────────────────────────────────────────

s.section("Test 1: REPRO — a note edited on disk while unloaded converges, then binds");
s.test("startup reconcile binds the deferred buffer only after arbitration", async () => {
	// The user's exact scenario. CRDT holds BASE, and the disk-index baseline
	// also holds BASE — nothing remote changed while the plugin was down. The
	// buffer holds LOCAL_EDIT, the offline edit Obsidian reopened the note with.
	// crdtHash == baselineHash, so this is "only local changed": the buffer is
	// imported, no conflict artifact, nothing lost.
	const h = await makeHarness({ crdt: BASE, buffer: LOCAL_EDIT, baseline: BASE });

	// This is the production startup path: onReconciled → reconcileOpenEditors
	// (bindView) → validateOpenBindings.
	h.orchestrator.onReconciled("startup");

	// bind() must NOT have attached yCollab synchronously.
	s.check(!h.manager.isBound(PATH), "the diverged buffer is not bound on the first pass");
	eq(h.openedPaths, [PATH], "trackOpenFile still ran — the path is in DiskMirror's openPaths");

	await waitFor(() => h.manager.isBound(PATH), "the path to bind after arbitration");

	eq(h.ytext.toJSON(), LOCAL_EDIT, "the Y.Text converged to the editor buffer");
	eq(h.buffer(), LOCAL_EDIT, "the buffer the user is looking at is untouched");
	s.check(h.manager.isBound(PATH), "and only then is the view bound");
	eq(h.createdFiles.size, 0, "no conflict artifact: only one side had changed");

	// The payoff. yCollab maps a buffer offset straight into the Y.Text.
	const offset = LOCAL_EDIT.length;
	const typed = "and then a third\n";
	h.setBuffer(LOCAL_EDIT + typed);
	applyKeystrokeLikeYCollab(h.ytext, offset, typed);
	eq(
		h.ytext.toJSON(),
		h.buffer(),
		"a keystroke at a buffer offset lands at the same place in the shared document",
	);

	h.dispose();
});

// ── Test 2: pure remote catch-up ────────────────────────────────────────────

s.section("Test 2: buffer at baseline, CRDT ahead — the buffer is replaced, then bound");
s.test("pure remote catch-up replaces the buffer from the Y.Text", async () => {
	// bufferHash == baselineHash and the CRDT moved: nothing local is at stake,
	// so the buffer is overwritten from the Y.Text. Cursor reset is accepted —
	// see replaceOpenBuffersFromCrdt.
	const h = await makeHarness({ crdt: REMOTE_EDIT, buffer: BASE, baseline: BASE });

	h.orchestrator.onReconciled("startup");
	await waitFor(() => h.manager.isBound(PATH), "the path to bind after arbitration");

	eq(h.buffer(), REMOTE_EDIT, "the buffer was replaced from the CRDT");
	eq(h.ytext.toJSON(), REMOTE_EDIT, "the Y.Text is untouched — it was already the authority");
	eq(h.createdFiles.size, 0, "no conflict artifact: only the CRDT had changed");
	s.check(h.manager.isBound(PATH), "the view is bound");

	h.dispose();
});

// ── Test 3: both sides changed ──────────────────────────────────────────────

s.section("Test 3: both sides changed — the CRDT side is preserved as an artifact");
s.test("both-changed preserves the CRDT content and keeps the buffer", async () => {
	const before = RecordingNotice.shown.length;
	const h = await makeHarness({ crdt: REMOTE_EDIT, buffer: LOCAL_EDIT, baseline: BASE });

	h.orchestrator.onReconciled("startup");
	await waitFor(() => h.manager.isBound(PATH), "the path to bind after arbitration");

	eq(h.createdFiles.size, 1, "exactly one conflict artifact was written");
	const [conflictPath, conflictContent] = [...h.createdFiles.entries()][0] ?? ["", ""];
	eq(conflictContent, REMOTE_EDIT, "the artifact holds the CRDT side, which the buffer displaced");

	// Naming comes from the real conflictArtifactPath — not re-derived here. The
	// timestamp inside it is second-resolution, so compare everything up to it.
	const expected = h.controller["conflictArtifactPath"](PATH, "crdt");
	const stableStart = expected.slice(0, expected.indexOf(DEVICE) + DEVICE.length);
	s.check(
		conflictPath.startsWith(stableStart) && conflictPath.endsWith(".md"),
		`artifact is named by conflictArtifactPath (got "${conflictPath}", pattern "${stableStart}…md")`,
	);

	eq(h.ytext.toJSON(), LOCAL_EDIT, "the buffer wins the file — the user is looking at it");
	eq(h.buffer(), LOCAL_EDIT, "the buffer is untouched");
	s.check(h.manager.isBound(PATH), "the view is bound once the two sides agree");

	const notices = RecordingNotice.shown.slice(before);
	s.check(
		notices.some((n) => n.message.includes("offline.md") || n.message.includes("offline")),
		`the user is told a competing version was preserved (notices: ${JSON.stringify(notices)})`,
	);

	h.dispose();
});

// ── Test 4: no baseline at all ──────────────────────────────────────────────

s.section("Test 4: missing baseline — same treatment, and the deviation is deliberate");
s.test("missing baseline preserves the CRDT side rather than defaulting to it", async () => {
	// decideClosedFileConflict's missing-baseline branch defaults to "CRDT wins"
	// with no mtime evidence. At BIND time there is evidence it never has: the
	// user has this note open in front of them. So the visible buffer wins the
	// file and the remote side is preserved beside it — documented in
	// resolveEditorDivergenceForBind.
	const h = await makeHarness({ crdt: REMOTE_EDIT, buffer: LOCAL_EDIT });

	h.orchestrator.onReconciled("startup");
	await waitFor(() => h.manager.isBound(PATH), "the path to bind after arbitration");

	eq(h.createdFiles.size, 1, "a conflict artifact was written");
	eq([...h.createdFiles.values()][0], REMOTE_EDIT, "it holds the CRDT side");
	eq(h.ytext.toJSON(), LOCAL_EDIT, "the buffer wins, NOT the pure planner's crdt default");
	eq(h.buffer(), LOCAL_EDIT, "the buffer is untouched");

	const decisions = h.traces.filter((t) => t.msg === "bind-divergence-arbitration");
	eq(decisions[0]?.details?.reason, "missing-baseline", "the decision is traced as missing-baseline");

	h.dispose();
});

// ── Test 5: arbitration fails ───────────────────────────────────────────────

s.section("Test 5: a failing arbitration declines, backs off, and does not loop");
s.test("a declining arbiter leaves the path unbound, tracked, and un-retried", async () => {
	let calls = 0;
	const h = await makeHarness({
		crdt: REMOTE_EDIT,
		buffer: LOCAL_EDIT,
		baseline: BASE,
		arbiter: async () => { calls += 1; return "declined"; },
	});

	h.orchestrator.onReconciled("startup-1");
	await waitFor(
		() => h.traces.some((t) => t.msg === "binding-divergence-declined"),
		"the decline to be traced",
	);

	s.check(!h.manager.isBound(PATH), "not bound");
	s.check(
		h.manager.getBindingHealthForView(h.view).bound === false,
		"no yCollab attached — the manager holds no binding for the view",
	);
	eq(h.ytext.toJSON(), REMOTE_EDIT, "the CRDT is left exactly as it was");
	eq(h.openedPaths, [PATH], "trackOpenFile happened, so remote writes take the open-file deferral");
	eq(calls, 1, "one arbitration attempt");

	// A second reconcile sweep — the shape that would otherwise re-arbitrate a
	// persistently failing path on every pass, forever, each attempt doing I/O.
	h.orchestrator.onReconciled("startup-2");
	await new Promise((resolve) => { setTimeout(resolve, 30); });
	eq(calls, 1, "the backoff window suppresses re-arbitration on the next sweep");
	s.check(
		h.traces.some((t) => t.msg === "binding-divergence-arbitration-skipped"
			&& t.details?.reason === "backoff"),
		"and the suppression is traced with its reason",
	);

	h.dispose();
});

// ── Test 6: the async CM-resolve retry cannot sneak past the guard ──────────

s.section("Test 6: scheduleCmResolveRetry cannot attach a diverged buffer");
s.test("a retry firing after the pair diverges still refuses to bind", async () => {
	// The retry timer re-enters bind(), not applyBinding — this pins that. Start
	// converged so bind() gets past the guard and schedules a CM-resolve retry,
	// then diverge the pair while the timer is pending (a remote update landing
	// in the Y.Text is exactly this shape), then let the timer fire.
	//
	// The arbiter here never settles, so "did the retry attach yCollab to the
	// diverged buffer?" is answerable without racing a resolution: if the guard
	// were absent the retry would bind immediately, and with the guard the path
	// stays unbound for as long as arbitration is outstanding.
	let arbitrationCalls = 0;
	const h = await makeHarness({
		crdt: BASE,
		buffer: BASE,
		baseline: BASE,
		arbiter: () => {
			arbitrationCalls += 1;
			return new Promise<"resolved" | "declined">(() => {});
		},
	});
	h.setCmResolvable(false);

	h.manager.bind(h.view, DEVICE);
	s.check(!h.manager.isBound(PATH), "no CM view yet, so nothing is bound");
	s.check(h.manager["pendingCmResolveRetries"].size === 1, "a CM-resolve retry is pending");
	eq(arbitrationCalls, 0, "and nothing was arbitrated — the pair agreed at that point");

	// Remote edit arrives while the retry is in flight, and the CM view becomes
	// resolvable. Nothing between here and the timer fires compares content.
	h.ytext.delete(0, h.ytext.length);
	h.ytext.insert(0, REMOTE_EDIT);
	h.setCmResolvable(true);

	await waitFor(
		() => h.manager["pendingCmResolveRetries"].size === 0,
		"the CM-resolve retry to fire",
	);
	// The hand-off is async now: the settled-buffer check reads disk before
	// anything reaches the arbiter.
	await waitFor(
		() => h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"the settled-buffer check to clear and arbitration to start",
	);

	s.check(
		!h.manager.isBound(PATH),
		"the retry re-entered bind() and the divergence guard refused it",
	);
	eq(arbitrationCalls, 1, "the retry handed the path to arbitration instead of attaching yCollab");
	s.check(
		h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"and the hand-off is traced",
	);

	// Concurrent sweeps while one arbitration is outstanding must not start a
	// second one, and must not bind in the meantime.
	h.orchestrator.onReconciled("sweep-during-arbitration");
	eq(arbitrationCalls, 1, "a sweep during an in-flight arbitration does not start another");
	s.check(!h.manager.isBound(PATH), "and still does not bind");
	s.check(
		h.traces.some((t) => t.msg === "binding-divergence-arbitration-skipped"
			&& t.details?.reason === "in-flight"),
		"the skip is traced as in-flight",
	);

	h.dispose();
});

// ── Test 7: R3 — the out-of-scope teardown is observable ────────────────────

s.section("Test 7: an out-of-scope teardown records the content it drops");
s.test("bind() traces potential unflushed-content loss before unbinding", async () => {
	const h = await makeHarness({ crdt: BASE, buffer: BASE, baseline: BASE });

	h.manager.bind(h.view, DEVICE);
	s.check(h.manager.isBound(PATH), "precondition: the in-scope path is bound");

	// The user types, and then excludes the path before the edit reaches the
	// CRDT. Those bytes are on disk and other devices keep the last-synced
	// version — the trade is accepted, but it must not be silent.
	h.setBuffer(LOCAL_EDIT);
	h.setScope(false);
	h.manager.bind(h.view, DEVICE);

	const teardown = h.traces.filter((t) => t.msg === "binding-out-of-scope-teardown");
	s.check(teardown.length === 1, "exactly one binding-out-of-scope-teardown trace");
	eq(teardown[0]?.details?.path, PATH, "it names the path");
	eq(teardown[0]?.details?.contentAtRisk, true, "and reports that unflushed content was dropped");
	s.check(!h.manager.isBound(PATH), "the binding is torn down");

	h.dispose();
});

// ── Test 8: R2 — the settings sweep is gated on reconcile ───────────────────

s.section("Test 8: onSyncScopeChanged is called only after reconcile has finished");
{
	// applyRuntimeSettings runs on every settings save, including saves that
	// happen while startup reconcile is still in flight. Every OTHER bind
	// trigger in main.ts — layout-change, active-leaf-change, file-open, the
	// status tick — is gated on `reconciliationController.isReconciled`; this
	// one has to be too, or a settings save binds open editors before reconcile
	// has decided who wins on each path.
	//
	// Asserted against the source because the call site is in main.ts, which
	// needs a live Obsidian Plugin to instantiate. Same technique as
	// disk-mirror-origin-classification's call-site scan.
	const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
	const callIndex = mainSource.indexOf("onSyncScopeChanged(reason)");
	s.check(callIndex > 0, "the onSyncScopeChanged call site is still in main.ts");
	const preceding = mainSource.slice(Math.max(0, callIndex - 400), callIndex);
	s.check(
		/if\s*\(\s*this\.reconciliationController\?\.isReconciled\s*\)\s*\{[^}]*$/.test(preceding),
		"the call sits inside an isReconciled gate",
	);
}

// ── Test 9: the re-attach routes past an existing binding ──────────────────

s.section("Test 9: re-attaching over an existing binding is gated too");

s.test("repair fell through: the rebuilt binding is not attached to a diverged buffer", async () => {
	// The gate at the top of bind() skips its content check when the leaf
	// already holds a binding for the path — re-attaching the SAME pair cannot
	// change how offsets map. But bind() has a route that goes PAST an existing
	// binding and attaches yCollab afresh: repair() failed to re-apply, so
	// bind() rebuilds from scratch. Repair fires precisely in messy states, and
	// "the pair was already bound" says nothing about the buffer being attached
	// now. Without the second gate this route re-opens the whole bug.
	let arbitrationCalls = 0;
	const h = await makeHarness({
		crdt: BASE,
		buffer: BASE,
		baseline: BASE,
		arbiter: (path, bufferContent) => {
			arbitrationCalls += 1;
			return h.controller.resolveEditorDivergenceForBind(path, bufferContent);
		},
	});

	h.manager.bind(h.view, DEVICE);
	s.check(h.manager.isBound(PATH), "precondition: the converged pair is bound");
	eq(arbitrationCalls, 0, "precondition: nothing was arbitrated");

	// Degrade the binding's health so bind() takes the repair branch: a sync
	// facet pointing at some other Y.Text is the "ytext-mismatch" issue, which
	// is an immediate unhealthy verdict rather than a settle-window deferral.
	h.setSyncFacet({ ytext: h.doc.getText("some-other-file"), awareness: null });
	// ...and make that repair's single dispatch fail, so bind() falls through to
	// the rebuild rather than returning on a successful repair.
	h.failNextDispatches(1);
	// Meanwhile the buffer and the CRDT have drifted apart — settled apart: the
	// autosave already wrote the buffer to disk, so this is a real divergence and
	// not a still-loading leaf.
	h.settleBuffer(LOCAL_EDIT);

	h.manager.bind(h.view, DEVICE);

	s.check(
		!h.manager.isBound(PATH),
		"the rebuild did NOT attach yCollab to the diverged buffer",
	);
	eq(h.ytext.toJSON(), BASE, "and the Y.Text is untouched when bind() returns");

	// Convergence still happens; the gate delays the bind, it does not cancel it.
	h.setSyncFacet(undefined);
	await waitFor(
		() => arbitrationCalls === 1,
		"the settled-buffer check to clear and arbitration to start",
	);
	eq(arbitrationCalls, 1, "it routed through arbitration instead");
	await waitFor(() => h.manager.isBound(PATH), "the rebuilt binding to land after arbitration");
	eq(h.ytext.toJSON(), LOCAL_EDIT, "the Y.Text converged to the buffer before binding");

	h.dispose();
});

s.test("cm-changed: a re-attach to a different EditorView is gated too", async () => {
	// The other route past an existing binding: getCmView resolves a DIFFERENT
	// EditorView than the binding holds (workspace re-layout, popout move). The
	// old binding kept ITS buffer in step with the Y.Text; it says nothing about
	// this one.
	let arbitrationCalls = 0;
	const h = await makeHarness({
		crdt: BASE,
		buffer: BASE,
		baseline: BASE,
		arbiter: () => {
			arbitrationCalls += 1;
			return new Promise<"resolved" | "declined">(() => {});
		},
	});

	h.manager.bind(h.view, DEVICE);
	s.check(h.manager.isBound(PATH), "precondition: bound to the first EditorView");

	// A remote edit lands in the Y.Text while the leaf is re-laid-out.
	h.ytext.delete(0, h.ytext.length);
	h.ytext.insert(0, REMOTE_EDIT);
	h.useSecondCm();

	h.manager.bind(h.view, DEVICE);

	s.check(!h.manager.isBound(PATH), "the new EditorView is not attached to a diverged pair");
	await waitFor(
		() => arbitrationCalls === 1,
		"the settled-buffer check to clear and arbitration to start",
	);
	eq(arbitrationCalls, 1, "the divergence went to arbitration");
	s.check(
		h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"and the hand-off is traced",
	);

	h.dispose();
});

// ── Test 10: the stale-buffer incident ──────────────────────────────────────

s.section("Test 10: a buffer that still holds the PREVIOUS note is not authoritative");

s.test("opening a healthy note while the buffer lags imports nothing", async () => {
	// The production incident. `view.file` updates BEFORE the editor document
	// loads, so `view.editor.getValue()` at bind time can still return the
	// previously displayed file's content. The old gate read it with no
	// readiness check and handed it to the arbiter as the authoritative LOCAL
	// side of this note.
	//
	// The decision table then did the damage silently: this note is healthy
	// (crdtHash == baselineHash), so "only the local side changed" is the
	// verdict, and the arbiter imported the stale string into the note's Y.Text
	// via applyDiffToYText — no conflict artifact, no notice, replicated
	// everywhere. Traces showed it as an arbitration-started whose bufferLength
	// was the PREVIOUS note's length.
	const h = await makeHarness({
		crdt: { [PATH]: BASE, [PREV]: PREV_CONTENT },
		buffer: PREV_CONTENT,
		disk: { [PATH]: BASE, [PREV]: PREV_CONTENT },
		baseline: { [PATH]: BASE },
	});

	h.manager.bind(h.view, DEVICE);
	s.check(!h.manager.isBound(PATH), "not bound while the buffer still holds the previous note");

	await waitFor(
		() => h.traces.some((t) => t.msg === "binding-buffer-unsettled"),
		"the settled-buffer check to refuse the lagging buffer",
	);

	s.check(
		!h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"nothing reached the arbiter",
	);
	eq(h.ytext.toJSON(), BASE, "the opened note's Y.Text is untouched — no silent import");
	eq(h.textFor(PREV).toJSON(), PREV_CONTENT, "and the previous note's Y.Text is untouched");
	eq(h.createdFiles.size, 0, "no conflict artifact was written");

	// The unsettled state is not a failure, so it must NOT have armed the 30 s
	// arbitration backoff — that would make an ordinary file open feel broken.
	s.check(
		!h.traces.some((t) => t.msg === "binding-divergence-declined"),
		"and no decline was recorded: still loading is not failing",
	);

	// The editor finishes loading the file it already claimed to be showing.
	h.settleBuffer(BASE);
	await waitFor(() => h.manager.isBound(PATH), "the bind to complete once the buffer settles");

	eq(h.ytext.toJSON(), BASE, "the Y.Text was never written to at any point");
	eq(h.buffer(), BASE, "and the buffer holds its own file");
	s.check(
		!h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"the bind completed without ever arbitrating",
	);
	eq(h.createdFiles.size, 0, "and without writing a conflict artifact");

	h.dispose();
});

s.test("opening a healthy note while the buffer is empty does not empty its Y.Text", async () => {
	// The silent-destruction row. An empty buffer is the other thing
	// `getValue()` returns before the document loads, and "" against a healthy
	// note (crdtHash == baselineHash) means the arbiter takes import-disk-to-crdt
	// and diffs the whole note away. No artifact, no notice, replicated.
	//
	// Every assertion below is load-bearing under ablation: remove the
	// settled-buffer guard and the Y.Text is "" by the second one.
	const h = await makeHarness({
		crdt: BASE,
		buffer: "",
		disk: { [PATH]: BASE },
		baseline: BASE,
	});

	h.manager.bind(h.view, DEVICE);
	s.check(!h.manager.isBound(PATH), "not bound while the buffer is empty");

	await waitFor(
		() => h.traces.some((t) => t.msg === "binding-buffer-unsettled"),
		"the settled-buffer check to refuse the empty buffer",
	);
	eq(h.ytext.toJSON(), BASE, "the note's Y.Text still holds its content");
	eq(h.createdFiles.size, 0, "and nothing was preserved as a conflict artifact either");
	s.check(
		!h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"nothing reached the arbiter",
	);

	h.settleBuffer(BASE);
	await waitFor(() => h.manager.isBound(PATH), "the bind to complete once the buffer settles");
	eq(h.ytext.toJSON(), BASE, "the Y.Text survived the whole open");

	h.dispose();
});

s.test("a buffer that finishes loading mid-check binds without arbitrating", async () => {
	// The common benign outcome of a stale gate read, and the reason the async
	// phase re-reads the buffer and re-tests divergence before touching the
	// arbiter: by the time the disk read returns, the editor has usually
	// finished loading and the buffer agrees with the Y.Text after all.
	let settle = (): void => {};
	const h = await makeHarness({
		crdt: BASE,
		buffer: PREV_CONTENT,
		disk: { [PATH]: BASE },
		baseline: BASE,
		duringDiskRead: () => { settle(); },
	});
	settle = () => { h.setBuffer(BASE); };

	h.manager.bind(h.view, DEVICE);
	s.check(!h.manager.isBound(PATH), "the stale read refuses the synchronous bind");

	await waitFor(() => h.manager.isBound(PATH), "the bind once the settle check re-reads");

	s.check(
		h.traces.some((t) => t.msg === "binding-divergence-cleared-by-settle"),
		"the re-check inside the async phase cleared the divergence",
	);
	s.check(
		!h.traces.some((t) => t.msg === "binding-divergence-arbitration-started"),
		"so nothing reached the arbiter",
	);
	eq(h.ytext.toJSON(), BASE, "and the Y.Text was never written");
	eq(h.createdFiles.size, 0, "no conflict artifact");

	h.dispose();
});

// ── Test 11: the same-leaf file switch ──────────────────────────────────────

s.section("Test 11: a refused bind never leaves the leaf attached to the previous file");
s.test("a same-leaf P -> Q switch detaches P even when Q is refused", async () => {
	// Bug B, and independent of the stale-buffer read. The divergence gate
	// shipped with its refusal ABOVE bind()'s `if (existing) this.unbind(view)`,
	// so a refused same-leaf switch returned with yCollab still attached to P's
	// Y.Text. Obsidian then loaded Q's content into that same CodeMirror, and
	// y-codemirror mapped the whole-document replacement into P's Y.Text: P's
	// note BECAME Q's content. No arbitration involved — the refusal alone did it.
	const h = await makeHarness({
		crdt: { [PREV]: PREV_CONTENT, [PATH]: BASE },
		buffer: PREV_CONTENT,
		disk: { [PREV]: PREV_CONTENT, [PATH]: BASE },
		baseline: { [PREV]: PREV_CONTENT, [PATH]: BASE },
		file: PREV,
	});

	h.manager.bind(h.view, DEVICE);
	s.check(h.manager.isBound(PREV), "precondition: the leaf is bound to the previous note");
	eq(h.boundYText()?.toJSON(), PREV_CONTENT, "precondition: attached to the previous note's Y.Text");

	// The switch. view.file updates first; the document has not loaded, so the
	// buffer still holds the previous note — which is what makes the gate refuse.
	h.openFile(PATH);
	h.manager.bind(h.view, DEVICE);

	s.check(
		h.traces.some((t) => t.msg === "binding-detached-on-file-switch"
			&& t.details?.from === PREV
			&& t.details?.to === PATH),
		"the file switch tore the previous binding down, above every early return",
	);
	s.check(!h.manager.isBound(PREV), "the previous note is no longer bound");
	s.check(!h.manager.isBound(PATH), "and the refused new path is not bound either");
	eq(h.boundYText(), null, "the leaf's compartment is empty");

	// Obsidian now fills the CodeMirror with the new file's content. With the
	// compartment empty this is inert; with the binding still attached it would
	// be replayed into the previous note's Y.Text.
	modelObsidianFileLoad(h, BASE);

	eq(h.textFor(PREV).toJSON(), PREV_CONTENT, "the previous note's Y.Text received NOTHING");
	eq(h.ytext.toJSON(), BASE, "and the new note's Y.Text is untouched too");

	h.dispose();
});

// ── Test 12: a buffer that never settles ────────────────────────────────────

s.section("Test 12: a buffer that never settles declines with its own reason");
s.test("the short re-check ladder is bounded, then hands over to the real backoff", async () => {
	// A note under continuous typing, or an adapter that keeps disagreeing.
	// The short ladder must not spin timers forever, and its decline must be
	// distinguishable from an arbiter that failed.
	let arbitrationCalls = 0;
	const h = await makeHarness({
		crdt: BASE,
		buffer: PREV_CONTENT,
		disk: { [PATH]: BASE },
		baseline: BASE,
		arbiter: async () => { arbitrationCalls += 1; return "resolved"; },
	});

	h.manager.bind(h.view, DEVICE);

	const declined = await waitFor(
		() => h.traces.some((t) => t.msg === "binding-divergence-declined"
			&& t.details?.reason === "buffer-never-settled"),
		"the decline once the re-check bound is spent",
		12_000,
	);

	if (declined) {
		eq(arbitrationCalls, 0, "nothing ever reached the arbiter");
		eq(h.ytext.toJSON(), BASE, "the Y.Text was never written");
		eq(h.createdFiles.size, 0, "no conflict artifact");
		s.check(!h.manager.isBound(PATH), "and nothing is bound");
		s.check(
			h.manager["pendingUnsettledRechecks"].size === 0,
			"no re-check timer is left running",
		);

		// The 30 s backoff is armed only NOW, at the end of the ladder — not on
		// the first unsettled read, which is an ordinary loading leaf.
		h.manager.bind(h.view, DEVICE);
		await new Promise((resolve) => { setTimeout(resolve, 30); });
		s.check(
			h.traces.some((t) => t.msg === "binding-divergence-arbitration-skipped"
				&& t.details?.reason === "backoff"),
			"a further sweep is suppressed by the arbitration backoff",
		);
	}

	h.dispose();
});

// ── Test 13: the seed path ──────────────────────────────────────────────────

s.section("Test 13: a note with no Y.Text is not seeded from an unsettled buffer");
s.test("ensureFile waits for the buffer to settle", async () => {
	// The pre-existing hazard at resolveBindingTarget. With no Y.Text there is
	// nothing to diverge from, so the old gate waved the path through — and
	// binding SEEDS the CRDT from `view.editor.getValue()`. A stale read there
	// admits the note holding the previous note's content, with no second side
	// to arbitrate against afterwards.
	const h = await makeHarness({
		crdt: {},
		buffer: PREV_CONTENT,
		disk: { [FRESH]: BASE },
		file: FRESH,
	});

	h.manager.bind(h.view, DEVICE);
	s.check(!h.manager.isBound(FRESH), "not bound while the buffer lags");
	eq(h.seeded.size, 0, "and ensureFile was NOT called with the previous note's content");

	await waitFor(
		() => h.traces.some((t) => t.msg === "binding-buffer-unsettled" && t.details?.mode === "seed"),
		"the seed-path settle check to refuse the lagging buffer",
	);
	eq(h.seeded.size, 0, "still nothing admitted to the CRDT");
	s.check(!h.crdtHas(FRESH), "the path has no Y.Text at all yet");

	h.settleBuffer(BASE);
	await waitFor(() => h.manager.isBound(FRESH), "the bind once the buffer settles");
	eq(h.seeded.get(FRESH), BASE, "the note entered the CRDT holding its OWN content");

	h.dispose();
});

// ── Test 14: CRLF vaults ────────────────────────────────────────────────────

s.section("Test 14: CRLF — the settle check normalizes, arbitration does not");

const CRLF_BASE = BASE.replace(/\n/g, "\r\n");

s.test("a settled CRLF note converges its Y.Text to the editor's LF form, once", async () => {
	// CodeMirror normalizes its document to "\n"; disk and the Y.Text seeded
	// from it keep CRLF. So on a CRLF vault the buffer NEVER equals disk byte
	// for byte, and a settled-buffer guard written as a raw compare would
	// silently disable itself for the whole vault. The guard normalizes for the
	// comparison only.
	//
	// The pair is then still genuinely diverged, and arbitration runs on EXACT
	// content — as it must: an LF buffer cannot safely bind to a CRLF Y.Text,
	// because every offset past the first line break differs. It converges the
	// Y.Text to LF once per legacy note. `eolOnlyDivergence` on the started
	// trace is what makes a vault-wide one-time normalization wave legible as
	// one, instead of reading as a wave of real divergences.
	const h = await makeHarness({
		crdt: { [PATH]: CRLF_BASE },
		buffer: BASE,
		disk: { [PATH]: CRLF_BASE },
		baseline: { [PATH]: CRLF_BASE },
	});

	h.manager.bind(h.view, DEVICE);
	s.check(!h.manager.isBound(PATH), "not bound synchronously — the pair genuinely differs");

	await waitFor(() => h.manager.isBound(PATH), "the CRLF note to converge and bind");

	eq(h.ytext.toJSON(), BASE, "the Y.Text converged to the editor's LF form");
	eq(h.buffer(), BASE, "the buffer is untouched");
	eq(h.createdFiles.size, 0, "crdt == baseline, so the import is silent: no artifact, no loss");

	const started = h.traces.find((t) => t.msg === "binding-divergence-arbitration-started");
	eq(started?.details?.eolOnlyDivergence, true, "traced as a line-ending-only divergence");
	eq(
		started?.details?.exactDiskMatch,
		false,
		"and recorded as having needed normalization to pass the settle check",
	);

	s.check(
		!h.traces.some((t) => t.msg === "binding-buffer-unsettled"),
		"the settle check passed first time: the normalized compare is what keeps it alive here",
	);

	h.dispose();
});

s.test("the CRLF note with no baseline writes one artifact and preserves both sides", async () => {
	// diskIndex baselines are commonly ABSENT — contentHash is only written at
	// settle points — so this row is routine, not an edge. On a CRLF vault it
	// means the one-time LF normalization of a legacy note also writes a
	// conflict artifact holding the CRLF text. That is accepted noise: nothing
	// is lost, both sides are on disk, and it fires at most once per note.
	const h = await makeHarness({
		crdt: { [PATH]: CRLF_BASE },
		buffer: BASE,
		disk: { [PATH]: CRLF_BASE },
	});

	h.manager.bind(h.view, DEVICE);
	await waitFor(() => h.manager.isBound(PATH), "the CRLF note to converge and bind");

	eq(h.ytext.toJSON(), BASE, "the Y.Text converged to LF");
	eq(h.createdFiles.size, 1, "exactly one artifact — the accepted one-time noise");
	eq([...h.createdFiles.values()][0], CRLF_BASE, "and it preserves the CRLF side verbatim");

	h.dispose();
});

// ── Test 15: no disk reader ─────────────────────────────────────────────────

s.section("Test 15: without a disk reader the guard cannot run, so bind declines");
s.test("an unwired settle check declines rather than trusting the buffer", async () => {
	// The safe direction. A manager constructed without the probe cannot tell a
	// loaded buffer from a lagging one, and "trust it" is precisely the
	// behaviour that shipped the incident.
	let arbitrationCalls = 0;
	const h = await makeHarness({
		crdt: BASE,
		buffer: LOCAL_EDIT,
		baseline: BASE,
		noDiskReader: true,
		arbiter: async () => { arbitrationCalls += 1; return "resolved"; },
	});

	h.manager.bind(h.view, DEVICE);
	await waitFor(
		() => h.traces.some((t) => t.msg === "binding-divergence-declined"
			&& String(t.details?.reason).startsWith("settle-check-unavailable")),
		"the decline for an unrunnable settle check",
	);

	eq(arbitrationCalls, 0, "nothing reached the arbiter");
	eq(h.ytext.toJSON(), BASE, "the Y.Text is untouched");
	s.check(!h.manager.isBound(PATH), "and nothing is bound");

	// The seed path keeps its pre-existing behaviour when the probe is absent —
	// the guard adds a refusal, it does not remove the ability to admit a new
	// note in a harness that never had the probe.
	h.dispose();
});


await s.done();
