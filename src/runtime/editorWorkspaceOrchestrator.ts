import { type App, MarkdownView, type WorkspaceLeaf } from "obsidian";
import type { EditorBindingManager } from "../sync/editorBinding";
import type { DiskMirror } from "../sync/diskMirror";
import type { VaultSyncSettings } from "../settings";

interface EditorWorkspaceOrchestratorDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getEditorBindings(): EditorBindingManager | null;
	getDiskMirror(): DiskMirror | null;
	/** Live markdown sync-scope predicate, matching the one given to
	 *  EditorBindingManager and DiskMirror. */
	isMarkdownPathSyncable(path: string): boolean;
	maybeImportDeferredClosedOnlyPath(path: string, reason: string): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
}

export class EditorWorkspaceOrchestrator {
	private openFilePaths = new Set<string>();
	private activeMarkdownPath: string | null = null;

	constructor(private readonly deps: EditorWorkspaceOrchestratorDeps) {}

	get openFileCount(): number {
		return this.openFilePaths.size;
	}

	reset(): void {
		this.openFilePaths.clear();
		this.activeMarkdownPath = null;
	}

	onReconciled(reason: string): void {
		this.reconcileOpenEditors();
		this.validateOpenBindings(reason);
	}

	onLayoutChange(): void {
		this.deps.getEditorBindings()?.clearLocalCursor("layout-change");
		this.reconcileTrackedOpenFiles("layout-change");
		this.updateActiveMarkdownPath(
			this.getActiveMarkdownPath(),
			"layout-change-active-blur",
		);
		// Release bindings for leaves that are gone before auditing the rest,
		// so the audit never inspects a dead editor. Closing a tab is the only
		// lifecycle event with no other cleanup path.
		this.pruneOrphanedBindings("layout-change");
		const touched = this.auditBindings("layout-change");
		if (touched > 0) {
			this.deps.log(`Binding health audit (layout-change) — touched ${touched}`);
			this.deps.scheduleTraceStateSnapshot("binding-audit:layout-change");
		}
	}

	/**
	 * Drop bindings whose leaf has left the workspace.
	 *
	 * Keys are derived exactly as EditorBindingManager.bind does — leaf id when
	 * Obsidian exposes one, file path otherwise — so a path-keyed binding is
	 * matched by a path-keyed live entry and never looks orphaned.
	 */
	pruneOrphanedBindings(reason: string): number {
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return 0;

		const liveLeafKeys = new Set<string>();
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			const leafId = "id" in leaf && typeof leaf.id === "string"
				? leaf.id
				: view.file?.path;
			if (leafId) liveLeafKeys.add(leafId);
		});

		const pruned = editorBindings.pruneOrphanedBindings(liveLeafKeys, reason);
		if (pruned > 0) {
			this.deps.log(`Pruned ${pruned} orphaned binding(s) (${reason})`);
			this.deps.scheduleTraceStateSnapshot(`binding-prune:${reason}`);
		}
		return pruned;
	}

	onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
		const nextPath = view?.file?.path ?? null;
		this.updateActiveMarkdownPath(nextPath, "active-leaf-change");
		this.reconcileTrackedOpenFiles("active-leaf-change");
		if (view) {
			this.bindView(view);
		}
	}

	onFileOpen(filePath: string | null): void {
		this.updateActiveMarkdownPath(filePath, "file-open-active-change");
		if (!filePath) return;
		const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === filePath) {
			this.bindView(view);
		}
	}

	onMarkdownDeleted(path: string): void {
		this.deps.getEditorBindings()?.unbindByPath(path);
		this.deps.getDiskMirror()?.notifyFileClosed(path);
		this.openFilePaths.delete(path);
	}

	onRenameBatchFlushed(renames: Map<string, string>): void {
		this.deps.getEditorBindings()?.updatePathsAfterRename(renames);
		for (const [oldPath, newPath] of renames) {
			if (this.activeMarkdownPath === oldPath) {
				this.activeMarkdownPath = newPath;
			}
			if (this.openFilePaths.has(oldPath)) {
				this.deps.getDiskMirror()?.notifyFileClosed(oldPath);
				this.openFilePaths.delete(oldPath);
				this.deps.getDiskMirror()?.notifyFileOpened(newPath);
				this.openFilePaths.add(newPath);
				this.deps.log(`Rename batch: moved observer "${oldPath}" -> "${newPath}"`);
			}
		}
	}

	validateOpenBindings(reason: string): void {
		let touched = 0;
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return;

		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}

			// An out-of-scope view is legitimately unbound, not broken. Without
			// this skip the loop below reads "not bound" as a fault, calls a
			// bind() that now refuses, and counts it as touched — on every
			// validate pass, forever, logging and snapshotting trace state each
			// time. Skipping before `touched` is incremented is what keeps a
			// deliberate refusal from reading as a repair loop.
			if (!this.deps.isMarkdownPathSyncable(leaf.view.file.path)) {
				return;
			}

			const binding = editorBindings.getBindingDebugInfoForView(leaf.view) ?? null;
			const health = editorBindings.getBindingHealthForView(leaf.view) ?? null;

			if (health?.bound && (health.healthy || health.settling)) {
				return;
			}

			touched += 1;
			if (!binding || !health?.bound) {
				editorBindings.bind(leaf.view, this.deps.getSettings().deviceName);
				return;
			}

			const repaired = editorBindings.repair(
				leaf.view,
				this.deps.getSettings().deviceName,
				`validate:${reason}`,
			);
			if (!repaired) {
				editorBindings.rebind(
					leaf.view,
					this.deps.getSettings().deviceName,
					`validate:${reason}`,
				);
			}
		});

		if (touched > 0) {
			this.deps.log(`Validated open bindings (${reason}) — touched ${touched}`);
			this.deps.scheduleTraceStateSnapshot(`validate-open-bindings:${reason}`);
		}
	}

	/**
	 * Re-apply sync scope to every open editor after the `Exclude paths` setting
	 * changes. Unbinds views that just left scope, binds views that just entered.
	 *
	 * The gates in EditorBindingManager only run when a binding is attempted, so
	 * a file already open and bound when the user adds an exclude pattern would
	 * keep its live CRDT binding until it was closed. This sweep is what makes
	 * the setting take effect on what is already on screen.
	 *
	 * Both directions in one pass: re-including a path would otherwise leave an
	 * open, untouched file unbound until the next leaf change happened to fire.
	 *
	 * Unbinding drops editor→CRDT content that has not been flushed yet. Those
	 * bytes are still on disk — Obsidian saves them normally — but other devices
	 * keep the last-synced version. That is the same trade the `in → out` rename
	 * makes in DiskMirror, and it is the point of excluding a path.
	 */
	onSyncScopeChanged(reason: string): void {
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return;

		let unbound = 0;
		let bound = 0;
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
			const path = leaf.view.file.path;
			if (!path.endsWith(".md")) return;

			const inScope = this.deps.isMarkdownPathSyncable(path);

			if (!inScope) {
				// Teardown is path-keyed on purpose: unbindByPath clears every leaf
				// showing the path in one call, so a second leaf on the same path
				// finds nothing left to do.
				if (editorBindings.isBound(path)) {
					editorBindings.unbindByPath(path);
					unbound += 1;
				}
				return;
			}

			// Binding is per-LEAF, so the check has to be too. isBound() is
			// path-keyed: with the same note open in two leaves it reports true
			// after the first bind, and the second leaf would silently stay
			// unbound.
			if (editorBindings.getBindingHealthForView(leaf.view)?.bound) return;

			this.bindView(leaf.view);

			// Count only if the bind actually took. bind() legitimately refuses
			// for reasons other than scope — a hard-tombstoned path, no resolvable
			// CM view — and applyRuntimeSettings runs on EVERY settings save, not
			// only on exclude-path changes. Counting the attempt would log and
			// snapshot trace state forever on an unrelated device-name edit: the
			// same false-repair-loop shape the skip in validateOpenBindings exists
			// to prevent.
			if (editorBindings.getBindingHealthForView(leaf.view)?.bound) {
				bound += 1;
			}
		});

		if (unbound > 0 || bound > 0) {
			this.deps.log(
				`Sync scope changed (${reason}) — unbound ${unbound}, bound ${bound}`,
			);
			this.deps.scheduleTraceStateSnapshot(`sync-scope-changed:${reason}`);
		}
	}

	auditBindings(reason: string): number {
		const touched = this.deps.getEditorBindings()?.auditBindings(reason) ?? 0;
		if (touched > 0) {
			this.deps.scheduleTraceStateSnapshot(`binding-audit:${reason}`);
		}
		return touched;
	}

	private reconcileOpenEditors(): void {
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.bindView(leaf.view);
			}
		});
		this.activeMarkdownPath = this.getActiveMarkdownPath();
	}

	private bindView(view: MarkdownView): void {
		this.deps.getEditorBindings()?.bind(view, this.deps.getSettings().deviceName);
		if (view.file) {
			this.trackOpenFile(view.file.path);
		}
	}

	private trackOpenFile(path: string): void {
		if (!this.openFilePaths.has(path)) {
			this.deps.getDiskMirror()?.notifyFileOpened(path);
			this.openFilePaths.add(path);
		}

		this.reconcileTrackedOpenFiles("track-open-file");
		this.deps.scheduleTraceStateSnapshot("track-open-file");
	}

	private reconcileTrackedOpenFiles(reason: string): void {
		const currentlyOpen = new Set<string>();
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				currentlyOpen.add(leaf.view.file.path);
			}
		});

		for (const tracked of this.openFilePaths) {
			if (!currentlyOpen.has(tracked)) {
				this.deps.getDiskMirror()?.notifyFileClosed(tracked);
				this.openFilePaths.delete(tracked);
				this.deps.log(`${reason}: closed observer for "${tracked}"`);
				this.deps.maybeImportDeferredClosedOnlyPath(tracked, reason);
			}
		}
	}

	private getActiveMarkdownPath(): string | null {
		const activeView = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path ?? null;
	}

	private updateActiveMarkdownPath(nextPath: string | null, reason: string): void {
		const previousPath = this.activeMarkdownPath;
		this.activeMarkdownPath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		this.deps.getEditorBindings()?.clearLocalCursor(reason);
		void this.deps.getDiskMirror()?.flushOpenPath(previousPath, reason);
	}
}
