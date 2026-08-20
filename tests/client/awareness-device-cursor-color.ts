/**
 * Awareness cursor colour test.
 *
 * Contract: the colour a device publishes into awareness (`user.color` /
 * `user.colorLight`, read by y-codemirror.next to paint remote carets and
 * selections) is derived from the device name, so two devices editing the same
 * note render as two distinguishable carets, and one device renders the same
 * colour across reloads.
 */

import { deviceCursorColor } from "../../src/utils/deviceCursorColor";
import { suite } from "../harness.ts";

const s = suite("awareness-device-cursor-color");

const HSL = /^hsl\((\d{1,3}), 72%, 52%\)$/;
const HSLA = /^hsla\((\d{1,3}), 72%, 52%, 0\.2\)$/;

s.test("shape is a legacy-syntax hsl/hsla pair", () => {
	const { color, colorLight } = deviceCursorColor("My laptop");
	if (!HSL.test(color)) throw new Error(`color not legacy hsl(): ${color}`);
	if (!HSLA.test(colorLight)) throw new Error(`colorLight not legacy hsla(): ${colorLight}`);
	if (HSL.exec(color)![1] !== HSLA.exec(colorLight)![1]) {
		throw new Error("caret and selection hues differ");
	}
});

s.test("same device name is stable across calls", () => {
	const a = deviceCursorColor("iPad");
	const b = deviceCursorColor("iPad");
	if (a.color !== b.color || a.colorLight !== b.colorLight) {
		throw new Error(`unstable colour: ${a.color} then ${b.color}`);
	}
});

s.test("realistic device names do not all collapse to one hue", () => {
	// The generated fallback shape is `device-<base36 ts>`; the rest are the
	// kind of names the settings field actually receives.
	const names = [
		"My laptop", "iPad", "Android", "desktop-linux", "holyqa-pc",
		"device-mmhns1xg", "device-mmkp74h1", "second", "oldclient-v1sim",
	];
	const hues = new Set(names.map((n) => deviceCursorColor(n).color));
	// Collisions are permitted by design; a single bucket for nine names is not.
	if (hues.size < names.length - 1) {
		throw new Error(`only ${hues.size} distinct colours for ${names.length} devices`);
	}
});

s.test("the two devices in a pairing run differ", () => {
	const desktop = deviceCursorColor("desktop-linux");
	const mobile = deviceCursorColor("Android");
	if (desktop.color === mobile.color) {
		throw new Error(`paired devices share a caret colour: ${desktop.color}`);
	}
});

s.test("an empty device name still yields a usable colour", () => {
	const { color, colorLight } = deviceCursorColor("");
	if (!HSL.test(color) || !HSLA.test(colorLight)) {
		throw new Error(`unusable colour for empty name: ${color} / ${colorLight}`);
	}
});

await s.done();
