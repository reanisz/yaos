#!/usr/bin/env bun
// Timeline extractor for one pathId from a boot-*.ndjson flight trace.
//
// Usage: bun run qa/repros/issue22b-loop-timeline.ts <ndjson> <pathId>
import fs from "node:fs";

import {
	fieldValue,
	loadTraceEvents,
	relativeSeconds,
	textField,
	usage,
} from "./traceEvents";

const [, , file, pathId] = process.argv;
if (!file || !pathId) {
	usage("issue22b-loop-timeline.ts");
}

const COLUMNS = [
	"+t",
	"seq",
	"kind",
	"reason",
	"diskLen",
	"crdtLen",
	"edEqDisk",
	"edEqCrdt",
	"action",
	"origin",
	"matches",
	"forceR",
	"diskMod",
	"size",
	"extra",
] as const;

type Column = (typeof COLUMNS)[number];
type Row = Record<Column, string>;

const events = loadTraceEvents(fs.readFileSync(file, "utf8"), pathId);
const t0 = events[0]?.ts ?? 0;

const rows: Row[] = events.map((ev) => {
	const d = ev.data;
	const isDiskModify = ev.kind === "disk.modify.observed";
	const row: Row = {
		"+t": relativeSeconds(ev.ts, t0),
		seq: ev.seq === undefined ? "" : String(ev.seq),
		kind: ev.kind ?? "",
		reason: fieldValue(d, "reason") ?? "",
		diskLen: fieldValue(d, "diskLength") ?? "",
		crdtLen: fieldValue(d, "crdtLength") ?? "",
		edEqDisk: fieldValue(d, "editorEqualsDisk") ?? "",
		edEqCrdt: fieldValue(d, "editorEqualsCrdt") ?? "",
		action: fieldValue(d, "action") ?? "",
		origin: fieldValue(d, "origin") ?? "",
		matches: fieldValue(d, "matchesExpected") ?? "",
		forceR: fieldValue(d, "forceReplaceApplied") ?? "",
		diskMod: isDiskModify ? "yes" : "",
		size: isDiskModify ? fieldValue(d, "size") ?? "" : "",
		extra: "",
	};
	if (ev.kind === "editor.repair.applied") {
		const leaf = textField(d, "leafId")?.slice(0, 8) ?? "";
		row.extra = `leaf=${leaf} cm=${fieldValue(d, "cmId") ?? ""} rapidSwitch=${fieldValue(d, "rapidSwitch") ?? ""}`;
	}
	if (ev.kind === "recovery.decision") {
		const rsh = textField(d, "recoveryStateHash")?.slice(0, 12) ?? "";
		row.extra = `disk=${textField(d, "diskFingerprintPrefix") ?? ""} crdt=${textField(d, "crdtFingerprintPrefix") ?? ""} rsh=${rsh}`;
	}
	if (isDiskModify) {
		row.extra = `size=${fieldValue(d, "size") ?? ""}`;
	}
	return row;
});

const widths: Record<string, number> = {};
for (const c of COLUMNS) widths[c] = c.length;
for (const r of rows) {
	for (const c of COLUMNS) {
		if (r[c].length > (widths[c] ?? 0)) widths[c] = r[c].length;
	}
}

console.log(COLUMNS.map((c) => c.padEnd(widths[c] ?? 0)).join("  "));
console.log(COLUMNS.map((c) => "-".repeat(widths[c] ?? 0)).join("  "));
for (const r of rows) {
	console.log(COLUMNS.map((c) => r[c].padEnd(widths[c] ?? 0)).join("  "));
}

console.log(`\nTotal events for pathId ${pathId}: ${events.length}`);
