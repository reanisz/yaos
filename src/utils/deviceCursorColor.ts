import { fnv1a32 } from "./fnv1a";

/**
 * Awareness cursor colours, derived from the device name.
 *
 * y-codemirror.next renders every remote peer using the `user.color` /
 * `user.colorLight` fields that peer published into awareness. A single
 * hard-coded colour therefore paints every remote caret identically, which is
 * exactly the case multi-device editing needs to tell apart. Deriving the hue
 * from the device name keeps the colour stable across reloads and distinct
 * across devices without adding a setting, a migration, or any negotiation.
 *
 * FNV-1a is a fingerprint, not an identity: hue collisions between two device
 * names are possible and harmless — the caret label still carries the name.
 *
 * Legacy comma syntax (`hsl(h, s%, l%)`) is used deliberately: it is supported
 * by every WebView YAOS runs in, including older iOS/Android Obsidian builds.
 */
export interface DeviceCursorColor {
	/** Caret colour. */
	color: string;
	/** Selection-range fill; same hue, translucent. */
	colorLight: string;
}

const CURSOR_SATURATION_PCT = 72;
const CURSOR_LIGHTNESS_PCT = 52;
const SELECTION_ALPHA = 0.2;
const HUE_COUNT = 360;

export function deviceCursorColor(deviceName: string): DeviceCursorColor {
	const hue = fnv1a32(deviceName) % HUE_COUNT;
	const base = `${hue}, ${CURSOR_SATURATION_PCT}%, ${CURSOR_LIGHTNESS_PCT}%`;
	return {
		color: `hsl(${base})`,
		colorLight: `hsla(${base}, ${SELECTION_ALPHA})`,
	};
}
