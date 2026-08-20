import type { PluginManifest } from "obsidian";

/**
 * Catalog-pinned community plugin. Synced as intent, not as file bytes.
 * See docs/rfcs/settings-sync.md.
 */
export type PluginIntent = {
	id: string;
	repo: string;
	version: string;
	enabled: boolean;
};

export type PluginInstallCapability = {
	installPlugin: boolean;
	enablePluginAndSave: boolean;
	setEnable: boolean;
	communityEnabled: boolean;
};

export type PlannedPluginApply =
	| { kind: "unsupported-api"; missing: string[] }
	| { kind: "restricted" }
	| { kind: "unknown-id" }
	| { kind: "desktop-only" }
	| { kind: "min-app-version"; minAppVersion: string; apiVersion: string }
	| { kind: "already-current"; enabled: boolean }
	| { kind: "install-then-enable" }
	| { kind: "install-only" }
	| { kind: "enable-only" };

export function detectPluginInstallCapability(input: {
	installPlugin?: unknown;
	enablePluginAndSave?: unknown;
	setEnable?: unknown;
	isEnabled?: unknown;
}): PluginInstallCapability {
	return {
		installPlugin: typeof input.installPlugin === "function",
		enablePluginAndSave: typeof input.enablePluginAndSave === "function",
		setEnable: typeof input.setEnable === "function",
		communityEnabled: typeof input.isEnabled === "function"
			? input.isEnabled() === true
			: false,
	};
}

export function planPluginApply(input: {
	intent: PluginIntent;
	capability: PluginInstallCapability;
	installedVersion: string | null;
	alreadyEnabled: boolean;
	manifest: Pick<PluginManifest, "id" | "minAppVersion" | "isDesktopOnly"> | null;
	isMobile: boolean;
	apiVersion: string;
}): PlannedPluginApply {
	const missing: string[] = [];
	if (!input.capability.installPlugin) missing.push("installPlugin");
	if (input.intent.enabled && !input.capability.enablePluginAndSave) {
		missing.push("enablePluginAndSave");
	}
	if (missing.length > 0) return { kind: "unsupported-api", missing };

	if (!input.capability.communityEnabled) return { kind: "restricted" };

	if (!input.manifest || input.manifest.id !== input.intent.id) {
		return { kind: "unknown-id" };
	}

	if (input.isMobile && input.manifest.isDesktopOnly) {
		return { kind: "desktop-only" };
	}

	const minAppVersion = input.manifest.minAppVersion;
	if (minAppVersion && compareDottedVersion(input.apiVersion, minAppVersion) < 0) {
		return {
			kind: "min-app-version",
			minAppVersion,
			apiVersion: input.apiVersion,
		};
	}

	const versionMatches = input.installedVersion === input.intent.version;
	if (versionMatches) {
		if (input.intent.enabled && !input.alreadyEnabled) return { kind: "enable-only" };
		return { kind: "already-current", enabled: input.alreadyEnabled };
	}

	return input.intent.enabled ? { kind: "install-then-enable" } : { kind: "install-only" };
}

/** Dotted numeric compare. Incomparable strings sort as older so we refuse. */
export function compareDottedVersion(left: string, right: string): number {
	const leftParts = parseDotted(left);
	const rightParts = parseDotted(right);
	if (!leftParts || !rightParts) return -1;
	const max = Math.max(leftParts.length, rightParts.length);
	for (let i = 0; i < max; i++) {
		const l = leftParts[i] ?? 0;
		const r = rightParts[i] ?? 0;
		if (l < r) return -1;
		if (l > r) return 1;
	}
	return 0;
}

function parseDotted(version: string): number[] | null {
	const normalized = version.trim();
	if (!/^\d+(\.\d+){0,3}$/.test(normalized)) return null;
	return normalized.split(".").map((part) => Number(part));
}
