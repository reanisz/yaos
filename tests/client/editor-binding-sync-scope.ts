/**
 * EditorBindingManager sync-scope guard regression.
 *
 * # The bug
 *
 * `bind()` gated only on `.md`, never on exclusion. That left the open-file
 * route past every guard DiskMirror and BlobSyncManager have, and it leaked in
 * BOTH directions:
 *
 *   inbound  — an excluded note that had already synced kept a live y-codemirror
 *              binding, so remote edits landed in the editor buffer and Obsidian
 *              persisted them. The same overwrite DiskMirror refuses, arriving
 *              by a route DiskMirror never sees.
 *
 *   outbound — `resolveBindingTarget` calls `vaultSync.ensureFile()` for a path
 *              with no Y.Text yet. Opening an excluded note therefore ADMITTED
 *              it to the CRDT, seeded from the editor buffer. An excluded note
 *              started syncing merely because the user looked at it.
 *
 * # Why the gate is in resolveBindingTarget
 *
 * It is the sole door to `ensureFile` and the sole producer of every
 * `BindingTarget`, so one gate covers `bind()`, `repair()` and `heal()` — all
 * three already handle a null target. A gate in `bind()` alone would leave
 * `repair` and `heal` able to seed the CRDT. `bind()` keeps a second, cheap
 * check purely to short-circuit early and log where a reader will look.
 *
 * The gate sits ABOVE the `existingText` short circuit, because the inbound
 * case (already in the CRDT) never reaches `ensureFile` and would otherwise
 * bind normally.
 *
 * # Orchestrator behaviour this suite also pins
 *
 *   - `validateOpenBindings` must SKIP out-of-scope views before counting them
 *     as touched. An out-of-scope view is legitimately unbound, not broken; read
 *     as a fault it produces a bind→refuse→count loop on every validate pass,
 *     forever.
 *   - `onSyncScopeChanged` unbinds views that just left scope and binds views
 *     that just entered. Without it a file already open and bound when the user
 *     adds an exclude pattern keeps its live CRDT binding until it is closed.
 */

import { EditorView } from "@codemirror/view";
import { MarkdownView, type TFile, type Workspace, type WorkspaceLeaf } from "obsidian";
import * as Y from "yjs";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import { EditorWorkspaceOrchestrator } from "../../src/runtime/editorWorkspaceOrchestrator";
import type { DiskMirror } from "../../src/sync/diskMirror";
import type { VaultSyncSettings } from "../../src/settings";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("editor-binding-sync-scope");

const IN_SCOPE = "notes/keep.md";
const EXCLUDED = "archive/old.md";

function archiveExcluded(path: string): boolean {
	return !path.startsWith("archive/");
}

interface Harness {
	manager: EditorBindingManager;
	ensureFileCalls: string[];
	traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }>;
	doc: Y.Doc;
	/** Paths that already have a Y.Text, i.e. were synced before being excluded. */
	texts: Map<string, Y.Text>;
}

function makeHarness(opts: { existing?: string[] } = {}): Harness {
	const doc = new Y.Doc();
	const texts = new Map<string, Y.Text>();
	for (const path of opts.existing ?? []) texts.set(path, doc.getText(path));

	const ensureFileCalls: string[] = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const vaultSync = partialOf<VaultSync>({
		getTextForPath: (path: string) => texts.get(path) ?? null,
		getFileId: () => undefined,
		getFileIdForText: () => undefined,
		// Reached by isHardTombstonedPath on the not-yet-in-CRDT path.
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		ensureFile: (path: string) => {
			ensureFileCalls.push(path);
			const t = doc.getText(path);
			texts.set(path, t);
			return t;
		},
	});

	const manager = new EditorBindingManager(
		vaultSync,
		partialOf<Workspace>({ getActiveViewOfType: () => null }),
		false,
		(source, msg, details) => traces.push({ source, msg, details }),
		undefined,
		undefined,
		archiveExcluded,
	);

	return { manager, ensureFileCalls, traces, doc, texts };
}

function makeView(path: string, content = "editor content"): MarkdownView {
	// `leaf` is dereferenced for its id by repair()/bind() before either reaches
	// the scope gate, so it has to exist or the test fails on the fixture rather
	// than on the behaviour under test. `id` itself is left unset: production
	// falls back to the file path, which is the identity these tests want.
	return partialOf<MarkdownView>({
		file: partialOf<TFile>({ path }),
		leaf: partialOf<WorkspaceLeaf>({}),
		editor: partialOf<MarkdownView["editor"]>({ getValue: () => content }),
	});
}

function eq(actual: unknown, expected: unknown, msg: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	s.check(a === e, a === e ? msg : `${msg}\n        expected=${e}\n        actual=${a}`);
}

// ── Test 1: the outbound leak — opening an excluded note must not admit it ───

s.section("Test 1: resolveBindingTarget — an excluded note is never admitted to the CRDT");
{
	const h = makeHarness();

	const target = h.manager["resolveBindingTarget"](makeView(EXCLUDED), "device", "bind");

	s.check(target === null, "no binding target produced for an excluded path");
	eq(h.ensureFileCalls, [], "ensureFile never called — the note is not admitted to the CRDT");
	s.check(!h.texts.has(EXCLUDED), "no Y.Text now exists for the excluded path");

	// Control: the same call for an in-scope path DOES admit and bind.
	const ok = h.manager["resolveBindingTarget"](makeView(IN_SCOPE), "device", "bind");
	s.check(ok !== null, "control: in-scope path produces a binding target");
	eq(h.ensureFileCalls, [IN_SCOPE], "control: in-scope path IS admitted via ensureFile");

	h.doc.destroy();
}

// ── Test 2: the inbound leak — already-synced excluded note must not bind ────

s.section("Test 2: resolveBindingTarget — an already-synced excluded note still refuses");
{
	// This is the case the `existingText` short circuit would have let through:
	// the note is already in the CRDT because it synced before being excluded,
	// so ensureFile is never reached and a gate placed lower would miss it.
	const h = makeHarness({ existing: [EXCLUDED, IN_SCOPE] });

	const target = h.manager["resolveBindingTarget"](makeView(EXCLUDED), "device", "bind");
	s.check(target === null, "excluded path with an existing Y.Text still refuses to bind");

	const ok = h.manager["resolveBindingTarget"](makeView(IN_SCOPE), "device", "bind");
	s.check(ok !== null, "control: in-scope path with an existing Y.Text binds");

	h.doc.destroy();
}

// ── Test 3: repair and heal are covered by the same gate ────────────────────

s.section("Test 3: repair and heal go through the same gate, so neither can seed the CRDT");
{
	// A gate in bind() alone would leave these two able to call ensureFile.
	const h = makeHarness();
	const cm = partialOf<EditorView>({ state: undefined as never });
	// Both methods short-circuit on "no CM EditorView" BEFORE they reach the
	// gate — repair even returns true there, to mean "retry scheduled". Without
	// a CM view the assertions below would pass or fail for that reason instead
	// of for the scope refusal, so give them one.
	h.manager["getCmView"] = () => cm;

	const excludedView = makeView(EXCLUDED);

	// repair() ALSO has a second path that never reaches the gate: with no
	// tracked binding for the leaf it delegates to bind() and returns whether a
	// binding appeared. That returns false for an excluded path — but via
	// bind()'s own gate, not resolveBindingTarget's. Asserting on it would have
	// been vacuous for this test's purpose, which review caught. Seed a binding
	// so repair takes the branch that actually consults resolveBindingTarget.
	// Keyed by the file path, because makeView leaves `leaf.id` unset and
	// production falls back to it. `undoManager` and `cm.dispatch` are the two
	// members unbindByPath reaches on a binding.
	const cmWithDispatch = Object.assign(cm, { dispatch: () => {} });
	h.manager["bindings"].set(EXCLUDED, {
		path: EXCLUDED,
		cm: cmWithDispatch,
		undoManager: { destroy: () => {} },
	} as never);

	s.check(
		h.manager.repair(excludedView, "device", "test") === true,
		"repair reports handled — the refusal is deliberate, not a failure to retry",
	);
	s.check(
		!h.manager.isBound(EXCLUDED),
		"and it TEARS DOWN the out-of-scope binding rather than leaving yCollab attached",
	);
	// heal() takes the same null-target branch. Its return code is incidental —
	// what matters is that it neither binds nor admits.
	h.manager.heal(makeView(EXCLUDED), "device", "test");
	s.check(!h.manager.isBound(EXCLUDED), "heal leaves the excluded path unbound");
	eq(h.ensureFileCalls, [], "neither repair nor heal admitted the note to the CRDT");

	h.doc.destroy();
}

// ── Test 4: the refusal is traced ───────────────────────────────────────────

s.section("Test 4: the refusal leaves evidence");
{
	const h = makeHarness();
	h.manager["resolveBindingTarget"](makeView(EXCLUDED), "device", "bind");

	const blocked = h.traces.filter((t) => t.msg === "binding-blocked-out-of-scope");
	s.check(blocked.length === 1, "exactly one binding-blocked-out-of-scope trace");
	eq(blocked[0]?.details?.path, EXCLUDED, "trace carries the excluded path");

	h.doc.destroy();
}

// ── Test 5: bind() short-circuits without touching the CM view ──────────────

s.section("Test 5: bind — an excluded view is refused before CM resolution");
{
	const h = makeHarness();
	let cmLookups = 0;
	h.manager["getCmView"] = () => { cmLookups += 1; return null; };

	h.manager.bind(makeView(EXCLUDED), "device");
	s.check(cmLookups === 0, "excluded path: no CM view lookup, no retry scheduled");
	s.check(!h.manager.isBound(EXCLUDED), "excluded path: not bound");

	h.manager.bind(makeView(IN_SCOPE), "device");
	s.check(cmLookups === 1, "control: in-scope path does reach CM resolution");

	h.doc.destroy();
}

// ── Test 6: validateOpenBindings does not treat a refusal as a repair loop ──

s.section("Test 6: validateOpenBindings — an out-of-scope view is skipped, not counted");
{
	// Without the skip this logs and snapshots trace state on every pass forever,
	// because bind() refuses and the view never becomes healthy.
	const bindCalls: string[] = [];
	const logs: string[] = [];
	const snapshots: string[] = [];

	const editorBindings = partialOf<EditorBindingManager>({
		getBindingDebugInfoForView: () => null,
		getBindingHealthForView: () => ({ bound: false, healthy: false, settling: false, issues: [] }),
		bind: (view: MarkdownView) => { bindCalls.push(view.file?.path ?? "?"); },
	});

	const leaves = [EXCLUDED, IN_SCOPE].map((path) =>
		partialOf<WorkspaceLeaf>({
			view: Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
				file: partialOf<TFile>({ path }),
			}),
		}),
	);

	const orchestrator = new EditorWorkspaceOrchestrator({
		app: partialOf<import("obsidian").App>({
			workspace: partialOf<Workspace>({
				iterateAllLeaves: (cb: (leaf: WorkspaceLeaf) => void) => { leaves.forEach(cb); },
			}),
		}),
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "device" }),
		getEditorBindings: () => editorBindings,
		getDiskMirror: () => null as DiskMirror | null,
		isMarkdownPathSyncable: archiveExcluded,
		maybeImportDeferredClosedOnlyPath: () => {},
		scheduleTraceStateSnapshot: (reason: string) => { snapshots.push(reason); },
		log: (message: string) => { logs.push(message); },
	});

	orchestrator.validateOpenBindings("test");

	eq(bindCalls, [IN_SCOPE], "only the in-scope view is bind()-ed");
	s.check(
		logs.some((l) => l.includes("touched 1")),
		`touched counts only the in-scope view (logs: ${JSON.stringify(logs)})`,
	);
	s.check(snapshots.length === 1, "one trace snapshot, not one per open view");
}

// ── Test 7: changing the setting re-applies scope to open editors ───────────

s.section("Test 7: onSyncScopeChanged — an already-bound view unbinds when it leaves scope");
{
	const unbound: string[] = [];
	const bound: string[] = [];
	let scope: (path: string) => boolean = () => true;

	const boundPaths = new Set([EXCLUDED, IN_SCOPE]);
	const editorBindings = partialOf<EditorBindingManager>({
		isBound: (path: string) => boundPaths.has(path),
		// Per-LEAF probe: onSyncScopeChanged uses this rather than the path-keyed
		// isBound so a note open in two leaves binds both, and so a bind is only
		// counted once it has actually taken.
		getBindingHealthForView: (view: MarkdownView) => ({
			bound: boundPaths.has(view.file?.path ?? "?"),
			healthy: true,
			settling: false,
			issues: [],
		}),
		unbindByPath: (path: string) => { unbound.push(path); boundPaths.delete(path); },
		bind: (view: MarkdownView) => {
			const p = view.file?.path ?? "?";
			bound.push(p);
			boundPaths.add(p);
		},
	});

	const leaves = [EXCLUDED, IN_SCOPE].map((path) =>
		partialOf<WorkspaceLeaf>({
			view: Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
				file: partialOf<TFile>({ path }),
			}),
		}),
	);

	const orchestrator = new EditorWorkspaceOrchestrator({
		app: partialOf<import("obsidian").App>({
			workspace: partialOf<Workspace>({
				iterateAllLeaves: (cb: (leaf: WorkspaceLeaf) => void) => { leaves.forEach(cb); },
			}),
		}),
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "device" }),
		getEditorBindings: () => editorBindings,
		getDiskMirror: () => null as DiskMirror | null,
		isMarkdownPathSyncable: (path: string) => scope(path),
		maybeImportDeferredClosedOnlyPath: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// Both bound while everything was in scope; the user now excludes archive/.
	scope = archiveExcluded;
	orchestrator.onSyncScopeChanged("settings-change");

	eq(unbound, [EXCLUDED], "the newly-excluded open file is unbound");
	eq(bound, [], "the in-scope file is left alone — it was already bound");

	// Re-including it binds it back without waiting for a leaf change.
	scope = () => true;
	orchestrator.onSyncScopeChanged("settings-change");
	eq(bound, [EXCLUDED], "re-including the path rebinds the still-open view");
}

await s.done();
