#!/usr/bin/env bun
// Summary timeline focused on the loop-relevant events for one pathId.
// Filters out server.receipt.candidate_captured noise.
//
// Usage: bun run qa/repros/issue22b-loop-summary.ts <ndjson> <pathId>
import fs from "node:fs";

import {
	type TraceEvent,
	fieldValue,
	loadTraceEvents,
	numberField,
	relativeSeconds,
	textField,
	usage,
} from "./traceEvents";

const [, , file, pathId] = process.argv;
if (!file || !pathId) {
	usage("issue22b-loop-summary.ts");
}

const KEEP: Record<string, true> = {
	"debug.trace.started": true,
	"provider.connected": true,
	"provider.sync.complete": true,
	"reconcile.start": true,
	"reconcile.complete": true,
	"reconcile.file.decision": true,
	"recovery.decision": true,
	"recovery.apply.start": true,
	"recovery.apply.done": true,
	"recovery.skipped": true,
	"recovery.quarantined": true,
	"recovery.loop.detected": true,
	"editor.repair.applied": true,
	"editor.heal.applied": true,
	"editor.bind": true,
	"disk.modify.observed": true,
	"disk.create.observed": true,
	"disk.write.ok": true,
	"disk.write.failed": true,
	"crdt.file.created": true,
	"delete.remote.observed": true,
};

const events = loadTraceEvents(fs.readFileSync(file, "utf8"), pathId)
	.filter((ev) => ev.kind !== undefined && KEEP[ev.kind] === true);

const t0 = events[0]?.ts ?? 0;

/**
 * Presence-vs-truthiness is deliberate and matches the original reader: text
 * fields are dropped when empty, numeric and boolean fields are printed
 * whenever they exist, including `0` and `false`.
 */
function fields(ev: TraceEvent): string {
	const d = ev.data;
	const parts: string[] = [];
	const truthy = (key: string, label: string, chars?: number): void => {
		const value = textField(d, key);
		if (value) parts.push(`${label}=${chars === undefined ? value : value.slice(0, chars)}`);
	};
	const present = (key: string, label: string, suffix = ""): void => {
		const value = fieldValue(d, key);
		if (value !== undefined) parts.push(`${label}=${value}${suffix}`);
	};

	truthy("reason", "reason");
	present("diskLength", "diskLen");
	present("crdtLength", "crdtLen");
	present("editorEqualsDisk", "edEqDisk");
	present("editorEqualsCrdt", "edEqCrdt");
	truthy("action", "action");
	truthy("origin", "origin");
	present("matchesExpected", "matches");
	present("forceReplaceApplied", "forceR");
	present("size", "size");
	truthy("crdtHash", "crdtH", 14);
	truthy("diskHash", "diskH", 14);
	truthy("originClass", "originClass");
	present("fileOpen", "fileOpen");
	truthy("diskFingerprintPrefix", "disk");
	truthy("crdtFingerprintPrefix", "crdt");
	truthy("recoveryStateHash", "rsh", 14);
	present("lockRemainingMs", "lock", "ms");
	present("idleMs", "idle", "ms");
	return parts.join(" ");
}

let prevDiskSize: number | null = null;
let prevCrdtLen: number | null = null;
for (const ev of events) {
	const seq = String(ev.seq ?? "").padStart(3);
	const t = relativeSeconds(ev.ts, t0).padStart(10);
	const k = (ev.kind ?? "").padEnd(28);
	let extra = fields(ev);

	// Annotate deltas
	if (ev.kind === "disk.modify.observed") {
		const size = numberField(ev.data, "size") ?? 0;
		if (prevDiskSize !== null) extra += `   Δdisk=+${size - prevDiskSize}`;
		prevDiskSize = size;
	}
	if (ev.kind === "recovery.decision") {
		const crdt = numberField(ev.data, "crdtLength") ?? 0;
		if (prevCrdtLen !== null) extra += `   ΔcrdtBetweenCycles=+${crdt - prevCrdtLen}`;
		prevCrdtLen = crdt;
	}

	console.log(`${t}  seq=${seq}  ${k} ${extra}`);
}
console.log(`\nTotal filtered events: ${events.length}`);
