import type { Plugin, PluginManifest } from "obsidian";

/**
 * Obsidian runtime members that the shipped API surface (obsidian.d.ts) does
 * not declare.
 *
 * WHY THIS FILE EXISTS: the product legitimately depends on a leaf identity
 * member that the public typings omit. Declaring it once here states the
 * assumption in one place, keeps the property optional where the runtime does
 * not guarantee it, and lets tsc check every read.
 */
declare module "obsidian" {
	interface WorkspaceLeaf {
		/**
		 * Obsidian's per-leaf identity, used for workspace serialisation. It is
		 * present on every real leaf but absent on hand-built leaf objects, so
		 * it is declared optional: callers must supply a fallback identity
		 * (they all fall back to the file path).
		 */
		readonly id?: string;
	}

	/**
	 * Community-plugin manager. Official `obsidian.d.ts` does not declare
	 * install / enable-and-save. These members exist on desktop 1.12.7
	 * (CDP probe, 2026-08-15) and are the seam `settingsSync` will call.
	 * Every field is optional: an Obsidian bump that removes one becomes a
	 * named miss rather than a TypeError in the apply path.
	 *
	 * See docs/rfcs/settings-sync.md.
	 */
	interface App {
		readonly plugins?: CommunityPluginsManager;
	}

	interface CommunityPluginsManager {
		readonly manifests?: Record<string, PluginManifest & { dir?: string }>;
		readonly plugins?: Record<string, Plugin>;
		readonly enabledPlugins?: Set<string>;
		installPlugin?(repo: string, version: string, manifest: PluginManifest): Promise<void>;
		enablePluginAndSave?(id: string): Promise<boolean>;
		enablePlugin?(id: string): Promise<boolean>;
		setEnable?(enabled: boolean): Promise<void>;
		isEnabled?(): boolean;
		uninstallPlugin?(id: string): Promise<void>;
	}
}
