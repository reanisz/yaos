import type { App, PluginManifest } from "obsidian";
import { runSmokeInstallCalendar } from "../../src/sync/settingsSync/obsidianPluginInstall";
import { suite } from "../harness.ts";

const s = suite("obsidian-plugin-install");

const MANIFEST: PluginManifest = {
	id: "calendar",
	name: "Calendar",
	author: "Liam Cain",
	version: "1.5.10",
	minAppVersion: "0.9.11",
	description: "Calendar view of your daily notes",
};

type FakePlugins = NonNullable<App["plugins"]>;

function fakeApp(plugins: Partial<FakePlugins>): App {
	return {
		plugins: {
			installPlugin: async () => undefined,
			enablePluginAndSave: async () => true,
			setEnable: async () => undefined,
			isEnabled: () => true,
			manifests: {},
			enabledPlugins: new Set<string>(),
			...plugins,
		},
	} as App;
}

const lookups = {
	lookupCatalog: async () => ({
		id: "calendar",
		repo: "liamcain/obsidian-calendar-plugin",
	}),
	lookupManifest: async () => MANIFEST,
};

s.test("installs then enables when Calendar is missing", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		installPlugin: async (repo, version, manifest) => {
			calls.push(`install:${repo}:${version}:${manifest.id}`);
		},
		enablePluginAndSave: async (id) => {
			calls.push(`enable:${id}`);
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "installed", "missing Calendar is installed");
	s.check(result.kind === "installed" && result.version === "1.5.10", "installed version comes from the catalog manifest");
	s.check(result.kind === "installed" && result.enabled, "Calendar is enabled after install");
	s.check(
		calls.join(",") === "install:liamcain/obsidian-calendar-plugin:1.5.10:calendar,enable:calendar",
		"enable runs after install, not before",
	);
});

s.test("does not enable before a failed install", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		installPlugin: async () => {
			calls.push("install");
			throw new Error("github 404");
		},
		enablePluginAndSave: async () => {
			calls.push("enable");
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "failed", "install throw is a failed result");
	s.check(calls.join(",") === "install", "enable is not called after install throws");
});

s.test("skips when Calendar is already at the resolved version and enabled", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		manifests: { calendar: { ...MANIFEST } },
		enabledPlugins: new Set(["calendar"]),
		installPlugin: async () => {
			calls.push("install");
		},
		enablePluginAndSave: async () => {
			calls.push("enable");
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "skipped", "already-current Calendar is skipped");
	s.check(calls.length === 0, "already-current Calendar does not call install or enable");
});

s.test("enables only when the folder already matches the pinned version", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		manifests: { calendar: { ...MANIFEST } },
		enabledPlugins: new Set(),
		installPlugin: async () => {
			calls.push("install");
		},
		enablePluginAndSave: async (id) => {
			calls.push(`enable:${id}`);
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "installed" && result.enabled, "installed-but-disabled Calendar is enabled");
	s.check(calls.join(",") === "enable:calendar", "matching version does not re-download");
});

s.test("refuses when community plugins are restricted", async () => {
	const app = fakeApp({
		isEnabled: () => false,
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "failed", "restricted mode fails closed");
	s.check(
		result.kind === "failed" && result.reason.includes("Restricted"),
		"restricted-mode reason tells the user to turn it off",
	);
});

s.test("refuses when installPlugin is missing", async () => {
	const app = fakeApp({
		installPlugin: undefined,
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "failed", "missing install API fails closed");
	s.check(
		result.kind === "failed" && result.reason.includes("does not expose"),
		"missing API reason names the undocumented seam",
	);
});

await s.done();
