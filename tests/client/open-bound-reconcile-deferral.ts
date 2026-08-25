/**
 * Controller and workspace-lifecycle proof for open/bound reconciliation.
 *
 * The former regression lived in ReconciliationController wiring, not in the
 * pure closed-file planner. This test drives authoritative updatedOnDisk input
 * through runReconciliation(), then through EditorWorkspaceOrchestrator's
 * real tab-close callback.
 */

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import { EditorWorkspaceOrchestrator } from "../../src/runtime/editorWorkspaceOrchestrator";
import { PRODUCT_EVENT_KIND } from "../../src/observability/productEventKinds";
import { suite, until } from "../harness.ts";

const s = suite("open-bound-reconcile-deferral");

function assertEqual<T>(actual: T, expected: T, message: string): void {
	s.check(actual === expected, `${message} (expected=${String(expected)}, actual=${String(actual)})`);
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
	await until(predicate, { timeoutMs: 400, intervalMs: 10, message: description });
}

const path = "QA-closure/open-bound-deferral.md";
const baseline = "BASELINE";
const external = "EXTERNAL-DISK-EDIT";
let diskContent = external;
let open = true;
let bound = true;
let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {};
let flushWriteCalls = 0;
const lifecycleOrder: string[] = [];
const pathEvents: Array<{ kind: string; path: string; data: Record<string, unknown> }> = [];
const traces: Array<{ event: string; details: Record<string, unknown> | undefined }> = [];

const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
file.path = path;
file.stat = { ctime: 1, mtime: 1, size: diskContent.length };

// `new MarkdownView()` needs a WorkspaceLeaf this fixture has no way to build,
// and the deferral paths under test only read `view.file` and
// `view.editor.getValue()` — so the view is a prototype instance (instanceof
// still holds for the runtime mock) carrying exactly those two members.
const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
	file,
	editor: { getValue: (): string => baseline },
});

const doc = new Y.Doc();
const ytext = doc.getText("content");
ytext.insert(0, baseline);

const editorBindings = {
	isBound: (candidate: string) => bound && candidate === path,
	bind: () => {},
	clearLocalCursor: () => {},
	auditBindings: () => 0,
	pruneOrphanedBindings: () => 0,
	notify: () => {},
};

const app = {
	vault: {
		getMarkdownFiles: () => [file],
		read: async (candidate: TFile & { path: string }) => {
			if (candidate.path !== path) throw new Error(`unexpected read: ${candidate.path}`);
			return diskContent;
		},
		adapter: {
			stat: async (candidatePath: string) => candidatePath === path
				? { mtime: 1, size: diskContent.length }
				: null,
		},
		getAbstractFileByPath: (candidatePath: string) => candidatePath === path ? file : null,
	},
	workspace: {
		iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => {
			if (open) callback({ view });
		},
		getActiveViewOfType: () => open ? view : null,
	},
};

const vaultSync = {
	connected: true,
	providerSynced: true,
	getActiveMarkdownPaths: () => [path],
	getTextForPath: (candidatePath: string) => candidatePath === path ? ytext : null,
	getFileIdForText: () => "file-id-open-bound",
	getSafeReconcileMode: () => "authoritative" as const,
	reconcileVault: () => ({
		createdOnDisk: [],
		updatedOnDisk: [path],
		seededToCrdt: [],
		untracked: [],
		skipped: 0,
		tombstonedDiskConflicts: [],
	}),
	runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	serverAckTracker: {
		withActiveOpId: (_opId: string | undefined, callback: () => void) => callback(),
	},
};

const diskMirror = {
	flushWrite: async () => { flushWriteCalls++; },
	flushOpenPath: async () => {},
	shouldSuppressModify: async () => false,
	isPreservedUnresolved: () => false,
	clearPreservedUnresolved: () => {},
	notifyFileOpened: () => {},
	notifyFileClosed: () => { lifecycleOrder.push("notifyFileClosed"); },
};

const controller = new ReconciliationController({
	app: app as never,
	getSettings: () => ({ deviceName: "closure-test" }) as never,
	getRuntimeConfig: () => ({
		maxFileSizeBytes: 0,
		maxFileSizeKB: 0,
		excludePatterns: [],
		externalEditPolicy: "closed-only",
	}) as never,
	getVaultSync: () => vaultSync as never,
	getDiskMirror: () => diskMirror as never,
	getBlobSync: () => null,
	getEditorBindings: () => editorBindings as never,
	getDiskIndex: () => diskIndex,
	setDiskIndex: (next) => { diskIndex = next; },
	isMarkdownPathSyncable: () => true,
	shouldBlockFrontmatterIngest: () => false,
	refreshServerCapabilities: async () => {},
	validateOpenEditorBindings: () => {},
	onReconciled: () => {},
	getAwaitingFirstProviderSyncAfterStartup: () => false,
	setAwaitingFirstProviderSyncAfterStartup: () => {},
	saveDiskIndex: async () => {},
	refreshStatusBar: () => {},
	trace: (_source, event, details) => traces.push({ event, details }),
	scheduleTraceStateSnapshot: () => {},
	log: () => {},
	recordFlightEvent: () => {},
	recordFlightPathEvent: (event) => {
		pathEvents.push({
			kind: event.kind,
			path: event.path,
			data: (event.data ?? {}) as Record<string, unknown>,
		});
	},
});

s.section("Test 1: authoritative open/bound update defers without a flush");
await controller.runReconciliation("authoritative");

assertEqual(flushWriteCalls, 0, "authoritative reconcile does not flush the open/bound path");
assertEqual(ytext.toString(), baseline, "authoritative reconcile leaves CRDT unchanged while deferred");

const deferred = pathEvents.filter((event) => event.kind === PRODUCT_EVENT_KIND.reconcileFileDeferred);
assertEqual(deferred.length, 1, "exactly one reconcile.file.deferred event emitted");
assertEqual(deferred[0]?.path, path, "deferred event records the updated path");
assertEqual(deferred[0]?.data.reason, "open-or-bound", "deferred event records its reason");
assertEqual(deferred[0]?.data.isOpenInEditor, true, "deferred event records open editor state");
assertEqual(deferred[0]?.data.isBound, true, "deferred event records bound state");

s.section("Test 2: real workspace close lifecycle imports the deferred closed-only edit");
const workspace = new EditorWorkspaceOrchestrator({
	app: app as never,
	getSettings: () => ({ deviceName: "closure-test" }) as never,
	getEditorBindings: () => editorBindings as never,
	getDiskMirror: () => diskMirror as never,
	isMarkdownPathSyncable: () => true,
	maybeImportDeferredClosedOnlyPath: (candidatePath, reason) => {
		lifecycleOrder.push(`deferImport:${reason}`);
		controller.maybeImportDeferredClosedOnlyPath(candidatePath, reason);
	},
	scheduleTraceStateSnapshot: () => {},
	log: () => {},
});

// Track the live view using the orchestrator's production onFileOpen path.
workspace.onFileOpen(path);
open = false;
bound = false;
workspace.onLayoutChange();

await waitFor(() => ytext.toString() === external, "closed-only deferred disk import");
assertEqual(lifecycleOrder[0], "notifyFileClosed", "workspace closes DiskMirror observer before requesting deferred import");
assertEqual(lifecycleOrder[1], "deferImport:layout-change", "workspace requests deferred import on layout-close lifecycle");
assertEqual(ytext.toString(), external, "post-close CRDT converges to the external disk content");
assertEqual(flushWriteCalls, 0, "post-close import remains disk-to-CRDT; it does not overwrite disk");
s.check(
	traces.some((entry) => entry.event === "closed-only-deferred-import-queued" && entry.details?.path === path),
	"controller records the deferred closed-only import lifecycle trace",
);
s.check(
	pathEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.crdtFileUpdated && event.path === path),
	"post-close import emits a CRDT update event",
);
await s.done();
