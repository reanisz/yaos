import { Notice, type App, type Plugin } from "obsidian";
import type { ConnectionController } from "./runtime/connectionController";
import type { SnapshotService } from "./snapshots/snapshotService";
import {
	confirmAndSmokeInstallCalendar,
	noticeForInstallResult,
} from "./sync/settingsSync/obsidianPluginInstall";
import type { ReconcileMode, VaultSync } from "./sync/vaultSync";

export interface CommandsRuntimeHost {
	getApp(): App;
	includeSettingsSyncSmoke(): boolean;
	getVaultSync(): VaultSync | null;
	getConnectionController(): ConnectionController | null;
	getSnapshotService(): SnapshotService | null;
	getUntrackedFileCount(): number;
	runReconciliation(mode: ReconcileMode): Promise<void>;
	runSchemaMigrationToV2(): void;
	importUntrackedFiles(): Promise<void>;
	clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed" | undefined>;
	resetLocalCache(): void;
	nuclearReset(): void;
}

export function registerCommands(
	registrar: Pick<Plugin, "addCommand">,
	host: CommandsRuntimeHost,
): void {
	registrar.addCommand({
		id: "reconnect",
		name: "Reconnect to sync server",
		callback: () => {
			if (host.getVaultSync()) {
				host.getConnectionController()?.reconnect("manual-command");
				new Notice("Reconnecting...");
			}
		},
	});

	registrar.addCommand({
		id: "force-reconcile",
		name: "Force reconcile vault with sync state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) return;
			const mode = vaultSync.getSafeReconcileMode();
			void host.runReconciliation(mode);
		},
	});

	registrar.addCommand({
		id: "migrate-schema-v2",
		name: "Migrate sync schema to v2",
		callback: () => {
			host.runSchemaMigrationToV2();
		},
	});

	registrar.addCommand({
		id: "import-untracked",
		name: "Import untracked files now",
		callback: () => {
			if (!host.getVaultSync()) {
				new Notice("Sync not initialized");
				return;
			}
			const count = host.getUntrackedFileCount();
			if (count === 0) {
				new Notice("No untracked files to import.");
				return;
			}
			void host.importUntrackedFiles().then(() => {
				new Notice(`Imported ${count} untracked file(s).`);
			});
		},
	});

	registrar.addCommand({
		id: "clear-local-server-receipt-state",
		name: "Clear local server-receipt state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) {
				new Notice("Sync not initialized");
				return;
			}
			void host.clearLocalServerReceiptState().then(
				(result) => new Notice(
					result === "cleared_persistent"
						? "Local server-receipt state cleared."
						: result === "cleared_memory_only"
							? "Local server-receipt state cleared for this session. Persistent receipt store is unavailable."
							: "Failed to clear local server-receipt state. Check console.",
					result === "cleared_persistent" ? 4000 : 7000,
				),
				() => new Notice("Failed to clear local server-receipt state. Check console.", 5000),
			);
		},
	});

	registrar.addCommand({
		id: "reset-cache",
		name: "Reset local cache (re-sync from server)",
		callback: () => {
			host.resetLocalCache();
		},
	});


	registrar.addCommand({
		id: "snapshot-now",
		name: "Take snapshot now",
		callback: async () => {
			await host.getSnapshotService()?.takeSnapshotNow();
		},
	});

	registrar.addCommand({
		id: "snapshot-list",
		name: "Browse and restore snapshots",
		callback: async () => {
			await host.getSnapshotService()?.showSnapshotList();
		},
	});

	registrar.addCommand({
		id: "snapshot-prune",
		name: "Cleanup old snapshots (apply retention policy)",
		callback: async () => {
			await host.getSnapshotService()?.pruneSnapshots();
		},
	});

	registrar.addCommand({
		id: "nuclear-reset",
		name: "Nuclear reset (wipe sync state and reseed from disk)",
		callback: () => {
			host.nuclearReset();
		},
	});

	if (host.includeSettingsSyncSmoke()) {
		registrar.addCommand({
			id: "smoke-install-calendar",
			name: "Smoke-install Calendar via Obsidian",
			callback: () => {
				void confirmAndSmokeInstallCalendar(host.getApp()).then(noticeForInstallResult);
			},
		});
	}
}
