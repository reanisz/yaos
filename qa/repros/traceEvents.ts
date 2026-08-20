/**
 * Shared NDJSON flight-trace reader for the Issue #22-B loop readers.
 *
 * A trace line is untrusted input: it is parsed as `unknown` and narrowed
 * field by field, so a malformed line degrades to a missing column instead of
 * a crash mid-report.
 */

export interface TraceEvent {
	readonly kind?: string;
	readonly pathId?: string;
	readonly seq?: number;
	readonly ts?: number;
	readonly data?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function textField(
	data: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = data?.[key];
	return typeof value === "string" ? value : undefined;
}

export function numberField(
	data: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = data?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Present-or-absent rendering: `0` and `false` print, `undefined` does not. */
export function fieldValue(
	data: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = data?.[key];
	return value === undefined ? undefined : String(value);
}

/** Reads one event, keeping only untyped-but-present fields we actually print. */
function parseEvent(line: string): TraceEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const record = asRecord(parsed);
	if (!record) return undefined;
	return {
		kind: textField(record, "kind"),
		pathId: textField(record, "pathId"),
		seq: numberField(record, "seq"),
		ts: numberField(record, "ts"),
		data: asRecord(record.data),
	};
}

/**
 * Parses an NDJSON trace, keeps the events for one pathId plus every event
 * that carries no pathId at all (session-scoped events such as
 * `provider.connected`), and orders them by the per-device `seq` counter.
 */
export function loadTraceEvents(ndjson: string, pathId: string): TraceEvent[] {
	const events: TraceEvent[] = [];
	for (const line of ndjson.split("\n")) {
		if (!line) continue;
		const ev = parseEvent(line);
		if (!ev) continue;
		if (ev.pathId && ev.pathId !== pathId) continue;
		events.push(ev);
	}
	return events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function relativeSeconds(ts: number | undefined, t0: number): string {
	return `${(((ts ?? 0) - t0) / 1000).toFixed(3)}s`;
}

export function usage(script: string): never {
	console.error(`usage: bun run qa/repros/${script} <ndjson> <pathId>`);
	process.exit(2);
}
