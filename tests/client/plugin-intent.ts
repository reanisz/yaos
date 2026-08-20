import {
	compareDottedVersion,
	detectPluginInstallCapability,
	planPluginApply,
	type PluginInstallCapability,
	type PluginIntent,
} from "../../src/sync/settingsSync/pluginIntent";
import { suite } from "../harness.ts";

const s = suite("plugin-intent");

const CAPABLE: PluginInstallCapability = {
	installPlugin: true,
	enablePluginAndSave: true,
	setEnable: true,
	communityEnabled: true,
};

const CALENDAR: PluginIntent = {
	id: "calendar",
	repo: "liamcain/obsidian-calendar-plugin",
	version: "1.5.10",
	enabled: true,
};

const MANIFEST = {
	id: "calendar",
	minAppVersion: "0.9.11",
	isDesktopOnly: false as boolean | undefined,
};

s.section("capability detection");
{
	const cap = detectPluginInstallCapability({
		installPlugin: async () => undefined,
		enablePluginAndSave: async () => true,
		setEnable: async () => undefined,
		isEnabled: () => true,
	});
	s.check(cap.installPlugin, "installPlugin function is detected");
	s.check(cap.enablePluginAndSave, "enablePluginAndSave function is detected");
	s.check(cap.setEnable, "setEnable function is detected");
	s.check(cap.communityEnabled, "isEnabled() true means community plugins are on");

	const missing = detectPluginInstallCapability({});
	s.check(!missing.installPlugin, "missing installPlugin is false");
	s.check(!missing.communityEnabled, "missing isEnabled is not treated as enabled");
}

s.section("apply order gates");
{
	const noApi = planPluginApply({
		intent: CALENDAR,
		capability: { ...CAPABLE, installPlugin: false },
		installedVersion: null,
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(noApi.kind === "unsupported-api", "missing installPlugin is unsupported-api");

	const restricted = planPluginApply({
		intent: CALENDAR,
		capability: { ...CAPABLE, communityEnabled: false },
		installedVersion: null,
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(restricted.kind === "restricted", "restricted mode blocks apply");

	const unknown = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: { ...MANIFEST, id: "not-calendar" },
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(unknown.kind === "unknown-id", "manifest id mismatch is unknown-id");
}

s.section("desktop-only and minAppVersion");
{
	const desktopOnly = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: { ...MANIFEST, isDesktopOnly: true },
		isMobile: true,
		apiVersion: "1.12.7",
	});
	s.check(desktopOnly.kind === "desktop-only", "desktop-only plugin is skipped on mobile");

	const okOnDesktop = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: { ...MANIFEST, isDesktopOnly: true },
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(okOnDesktop.kind === "install-then-enable", "desktop-only plugin still installs on desktop");

	const tooOld = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: { ...MANIFEST, minAppVersion: "1.13.0" },
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(tooOld.kind === "min-app-version", "minAppVersion newer than apiVersion is refused");
}

s.section("install then enable, not the reverse");
{
	const fresh = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(fresh.kind === "install-then-enable", "missing folder with enabled intent is install-then-enable");

	const pin = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: "1.5.9",
		alreadyEnabled: true,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(pin.kind === "install-then-enable", "wrong installed version is re-pinned then enabled");

	const enableOnly = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: "1.5.10",
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(enableOnly.kind === "enable-only", "matching version, not yet enabled, is enable-only");

	const current = planPluginApply({
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: "1.5.10",
		alreadyEnabled: true,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(current.kind === "already-current", "matching version already enabled is already-current");

	const installOnly = planPluginApply({
		intent: { ...CALENDAR, enabled: false },
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	});
	s.check(installOnly.kind === "install-only", "disabled intent still downloads code");
}

s.section("dotted version compare");
{
	s.check(compareDottedVersion("1.12.7", "1.12.7") === 0, "equal versions compare 0");
	s.check(compareDottedVersion("1.12.7", "1.13.0") < 0, "1.12.7 is older than 1.13.0");
	s.check(compareDottedVersion("1.13.0", "1.12.7") > 0, "1.13.0 is newer than 1.12.7");
	s.check(compareDottedVersion("not-a-version", "1.0.0") < 0, "unparseable left side refuses as older");
}

await s.done();
