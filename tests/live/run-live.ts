import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../harness.ts";

const HOST = "http://127.0.0.1:8787";
const VAULT_ID = `yaos-integration-${Date.now().toString(36)}`;
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");

// Loader flags every spawned suite needs. tests/live/*.ts are TypeScript, so
// bare `node` cannot load them; this is the same loader tests/run-suites.mjs
// uses for the regression buckets, which keeps the two entry points on one
// dialect.
//
// JITI_ALIAS is deliberately NOT mirrored from tests/run-suites.mjs. None of
// its four entries applies to a live suite: they import only yjs,
// y-partyserver/provider, ws and src/sync/schema.ts (which is Obsidian-free),
// so the `obsidian` and `@shared` aliases would be dead; the `partyserver`
// mock must never be substituted into a suite whose whole point is talking to
// a real Worker; and "yjs" already resolves to the single root copy here
// (verified — no "Yjs was already imported" warning from a child).
const NODE_TS = ["--import", "jiti/register"];

/**
 * One `wrangler dev` process, its captured output and its scratch state.
 *
 * The driver runs two of these back to back (see main()), so everything that
 * used to be a local of main() — the persist directory, the exit promise, the
 * ring buffer of child output — is owned here instead of being re-derived.
 */
interface WranglerInstance {
	/** Temp `--persist-to` directory; removed by shutdown(). */
	readonly persistDir: string;
	/** True once the child process has exited, for whatever reason. */
	hasExited(): boolean;
	/** Last ~8KB of the child's combined stdout/stderr. */
	capturedOutput(): string;
	/** SIGTERM the child, wait for it to go, then delete the persist dir. */
	shutdown(): Promise<void>;
}

/**
 * Boot `wrangler dev` on 127.0.0.1:8787 with a fresh persist directory.
 *
 * `syncToken` is the difference between the first two phases:
 *   - a string puts SYNC_TOKEN in the child environment, so the server comes up
 *     in env mode (claimed, authMode "env") exactly as it always has;
 *   - `null` guarantees the variable is ABSENT, so the server comes up
 *     unclaimed and the claim flow is reachable.
 *
 * Phase 3 uses `null` as well, and adds YAOS_STRICT_PERMISSIONS through
 * `extraArgs`. The deletion matters even more there: strict mode is fail-closed
 * against a SYNC_TOKEN it finds, so an inherited one would not change the
 * server's behaviour but WOULD emit a warning the suite does not expect, and it
 * would make the "no token leaked" assertion meaningless.
 */
function startWrangler(options: {
	readonly syncToken: string | null;
	readonly extraArgs?: readonly string[];
}): WranglerInstance {
	const persistDir = mkdtempSync(join(tmpdir(), "yaos-wrangler-"));

	// CLOUDFLARE_INCLUDE_PROCESS_ENV=true copies this process's environment into
	// the Worker's `env` — that is how SYNC_TOKEN reaches the server at all. The
	// same mechanism means an inherited SYNC_TOKEN (a developer's shell, a CI
	// secret) would silently flip a claim-mode phase into env mode and make its
	// whole point unobservable.
	//
	// Copy first, `delete` second. The two obvious alternatives are worse:
	// mutating `process.env` directly does not remove anything — it is a magic
	// object that stringifies, so `process.env.SYNC_TOKEN = undefined` stores the
	// four-letter string "undefined" and the server would treat THAT as its token
	// (measured, not assumed); and a spread with `SYNC_TOKEN: undefined` leaves an
	// own key whose omission from the child depends on child_process skipping
	// undefined values, which it does today and does not document. `delete` on a
	// plain copy leaves no key at all, which is the property we actually want.
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	childEnv.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
	childEnv.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
	if (options.syncToken === null) {
		delete childEnv.SYNC_TOKEN;
	} else {
		childEnv.SYNC_TOKEN = options.syncToken;
	}

	const wrangler = spawn(
		WRANGLER_BIN,
		[
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			"8787",
			"--local-protocol",
			"http",
			"--persist-to",
			persistDir,
			"--log-level",
			"error",
			...(options.extraArgs ?? []),
		],
		{
			cwd: resolve("server"),
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv,
		},
	);

	let exited = false;
	const wranglerExit = new Promise<void>((resolvePromise) => {
		wrangler.once("exit", () => {
			exited = true;
			resolvePromise();
		});
	});

	let output = "";
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 8_000) {
			output = output.slice(-8_000);
		}
	};
	if (!wrangler.stdout || !wrangler.stderr) {
		throw new Error("wrangler dev did not expose piped stdout/stderr");
	}
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);

	return {
		persistDir,
		hasExited: () => exited,
		capturedOutput: () => output,
		async shutdown(): Promise<void> {
			if (wrangler.exitCode === null) {
				wrangler.kill("SIGTERM");
			}
			await wranglerExit;
			rmSync(persistDir, { recursive: true, force: true });
		},
	};
}

async function waitForWorker(wrangler: WranglerInstance): Promise<void> {
	const deadline = Date.now() + 15_000;
	const probeUrl = `${HOST}/api/capabilities`;

	while (Date.now() < deadline) {
		// A child that died (a bind failure on a port the previous phase has not
		// released, a bundling error) will never answer. Fail on that immediately
		// instead of burning the whole 15s window on a corpse.
		if (wrangler.hasExited()) {
			throw new Error("wrangler dev exited before it accepted a request");
		}
		try {
			const res = await fetch(probeUrl, { method: "GET" });
			if (res.status > 0) return;
		} catch {
			// Worker not accepting connections yet.
		}
		await sleep(250);
	}

	throw new Error("Timed out waiting for wrangler dev to accept requests");
}

/**
 * Spawn one suite and resolve only if it exits 0.
 *
 * `env` is passed whole rather than merged here: the two phases hand their
 * children deliberately different environments, and a merge in this function
 * is exactly where an inherited SYNC_TOKEN would sneak back into phase 2.
 */
function spawnSuite(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
	// Executor form, not `Promise.withResolvers`: tsconfig.tests.json pins `lib`
	// to ES2023 because package.json engines.node is ">=20", and withResolvers
	// is an ES2024 API absent from Node 20.
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(cmd, args, {
			cwd: resolve("."),
			stdio: "inherit",
			env,
		});

		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`${cmd} ${args.join(" ")} exited with ` +
					(signal ? `signal ${signal}` : `code ${code}`),
				),
			);
		});
		child.on("error", rejectPromise);
	});
}

/**
 * Phase-1 convention: every env-mode suite reads the operator credential from
 * SYNC_TOKEN and its room prefix from YAOS_TEST_VAULT_ID.
 */
function runCommand(
	cmd: string,
	args: string[],
	token: string,
	extraEnv: Record<string, string> = {},
): Promise<void> {
	return spawnSuite(cmd, args, {
		...process.env,
		YAOS_TEST_HOST: HOST,
		SYNC_TOKEN: token,
		YAOS_TEST_VAULT_ID: VAULT_ID,
		...extraEnv,
	});
}

/** The subset of `POST /claim`'s body this driver asserts on. */
interface ClaimResponse {
	readonly obsidianUrl?: unknown;
}

/** The subset of `GET /api/capabilities` this driver asserts on. */
interface Capabilities {
	readonly claimed?: unknown;
	readonly authMode?: unknown;
}

async function claimServer() {
	const token = randomBytes(32).toString("hex");
	const res = await fetch(`${HOST}/claim`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ token }),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`claim failed (${res.status}): ${text}`);
	}

	const payload = (await res.json()) as ClaimResponse | null;
	if (typeof payload?.obsidianUrl !== "string" || !payload.obsidianUrl.startsWith("obsidian://yaos?")) {
		throw new Error("claim response missing Obsidian setup URL");
	}

	const capabilities = (await fetch(`${HOST}/api/capabilities`).then((result) => result.json())) as Capabilities | null;
	if (capabilities?.claimed !== true || capabilities?.authMode !== "claim") {
		throw new Error("server did not enter claimed mode");
	}

	return token;
}

async function resolveAuthToken(defaultEnvToken: string): Promise<string> {
	const capabilitiesRes = await fetch(`${HOST}/api/capabilities`);
	if (!capabilitiesRes.ok) {
		throw new Error(`capabilities probe failed (${capabilitiesRes.status})`);
	}
	const capabilities = (await capabilitiesRes.json()) as Capabilities | null;
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	return await claimServer();
}

function dumpWranglerOutput(wrangler: WranglerInstance, phase: string): void {
	const output = wrangler.capturedOutput().trim();
	if (output) {
		console.error(`\n[wrangler output — ${phase}]`);
		console.error(output);
	}
}

/**
 * Phase 1 — env mode.
 *
 * Byte-for-byte the run this driver has always performed: SYNC_TOKEN in the
 * child environment, YAOS_TICKET_TTL_MS pinned to 8s so ws-ticket-reconnect can
 * observe an expiry in seconds, and the eight suites in their original order.
 */
async function runEnvModePhase(): Promise<void> {
	console.log("\n=== live phase 1/3: env mode (SYNC_TOKEN) ===");
	const envToken = randomBytes(32).toString("hex");
	const wrangler = startWrangler({
		syncToken: envToken,
		// Short ticket TTL for the ws-ticket-reconnect smoke test — allows
		// post-expiry reconnect to be exercised in seconds, not 5 minutes.
		extraArgs: ["--var", "YAOS_TICKET_TTL_MS:8000"],
	});

	try {
		await waitForWorker(wrangler);
		const token = await resolveAuthToken(envToken);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/schema-guard.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/provider-manual-connect.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/sync-client.ts",
			"smoke.md",
			"\n\nhello from worker integration pass 1",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/sync-client.ts",
			"smoke.md",
			"\n\nhello from worker integration pass 2",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/snapshots.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/hardening-worker.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/ws-ticket-reconnect.ts",
		], token);
		await runCommand("node", [
			...NODE_TS,
			"tests/live/ws-admission-protocol.ts",
		], token);
	} catch (err) {
		dumpWranglerOutput(wrangler, "phase 1, env mode");
		throw err;
	} finally {
		await wrangler.shutdown();
	}
}

/**
 * Phase 2 — claim mode.
 *
 * Everything phase 1 cannot reach: a server that nobody has claimed yet, the
 * claim flow itself, and the per-vault access tokens that only exist in claim
 * mode (routes/vaultTokens.ts answers 409 under SYNC_TOKEN).
 *
 * The suite is handed NO credential. It reads YAOS_TEST_HOST, claims the
 * server itself and mints its own vault tokens — deliberately not threaded
 * through SYNC_TOKEN, which means "the global operator token" to every phase-1
 * suite and would be an outright trap carrying a vault-scoped one.
 */
async function runClaimModePhase(): Promise<void> {
	console.log("\n=== live phase 2/3: claim mode (unclaimed server, per-vault tokens) ===");
	const wrangler = startWrangler({ syncToken: null });

	const suiteEnv: NodeJS.ProcessEnv = { ...process.env, YAOS_TEST_HOST: HOST };
	// Same reasoning as the child environment in startWrangler: the suite asserts
	// that the server is unclaimed, and must not be handed a credential that
	// would let a future edit paper over a leak instead of reporting it.
	delete suiteEnv.SYNC_TOKEN;

	try {
		await waitForWorker(wrangler);
		await spawnSuite("node", [
			...NODE_TS,
			"tests/live/vault-tokens-live.ts",
		], suiteEnv);
	} catch (err) {
		dumpWranglerOutput(wrangler, "phase 2, claim mode");
		throw err;
	} finally {
		await wrangler.shutdown();
	}
}

/**
 * Phase 3 — strict permissions mode.
 *
 * A third `wrangler dev`, booted with YAOS_STRICT_PERMISSIONS and no
 * SYNC_TOKEN (the same env deletion phase 2 relies on), plus STUB Cloudflare
 * Access variables.
 *
 * WHY THE ACCESS VARIABLES ARE HERE AT ALL, given that no request in this phase
 * can produce a valid Access token: without them, every /admin path answers the
 * ordinary 404 and the phase could not tell "the admin surface refused me" from
 * "the admin surface does not exist on this build". With them, /admin answers
 * 401 and that distinction becomes observable. The values are syntactically
 * valid and functionally inert — a team domain nobody owns, and 64 hex zeros
 * for the AUD — so the Worker builds an AccessConfig and then refuses every
 * token, which is precisely the surface this phase measures. Note that the JWKS
 * URL is never fetched: a request with no header is refused before verification
 * even starts, so this phase makes no outbound network call.
 *
 * WHY THERE IS NO POSITIVE ISSUANCE PATH: see the long header comment in
 * tests/live/strict-permissions-live.ts. Short version: verifying an Access JWT
 * requires the team's real JWKS, the Worker fetches it itself, and there is no
 * injection seam across an HTTP boundary — so issuance is proven in-process by
 * tests/server/strict-permissions.ts against the REAL verifier and a real RSA
 * keypair, and this phase proves the refusals that only a real deployment can.
 *
 * The suite is handed NO credential, deliberately. In strict mode there is no
 * credential that would help, and threading one in through SYNC_TOKEN — which
 * means "the global operator token" to every phase-1 suite — would be an
 * outright trap here, where the global token is exactly what must not work.
 */
async function runStrictModePhase(): Promise<void> {
	console.log("\n=== live phase 3/3: strict permissions (no global token, claim closed) ===");
	const wrangler = startWrangler({
		syncToken: null,
		extraArgs: [
			"--var",
			"YAOS_STRICT_PERMISSIONS:1",
			// Inert but well-formed, so /admin exists to be refused.
			"--var",
			"YAOS_ACCESS_TEAM_DOMAIN:yaos-live-strict.cloudflareaccess.com",
			"--var",
			`YAOS_ACCESS_AUD:${"0".repeat(64)}`,
		],
	});

	const suiteEnv: NodeJS.ProcessEnv = { ...process.env, YAOS_TEST_HOST: HOST };
	// Same reasoning as phase 2: the suite asserts that no server-wide token
	// works, and must not be handed one that could paper over a leak.
	delete suiteEnv.SYNC_TOKEN;

	try {
		await waitForWorker(wrangler);
		await spawnSuite("node", [
			...NODE_TS,
			"tests/live/strict-permissions-live.ts",
		], suiteEnv);
	} catch (err) {
		dumpWranglerOutput(wrangler, "phase 3, strict permissions");
		throw err;
	} finally {
		await wrangler.shutdown();
	}
}

async function main() {
	// Sequential, and fail-fast. The three phases share port 8787, so each
	// cannot start until the previous wrangler has fully exited — that is what
	// the awaited shutdown() inside each phase's `finally` guarantees. Fail-fast
	// is deliberate on top of that: a phase-1 failure usually means the server
	// itself is broken, in which case the later phases' failures would be noise
	// on top of the real one. One phase runs, one exit code.
	await runEnvModePhase();
	// The listening socket is released as the process dies, but the release is
	// not synchronous with the exit event. Give the port a moment rather than
	// racing the next phase's bind against it.
	await sleep(1_000);
	await runClaimModePhase();
	await sleep(1_000);
	await runStrictModePhase();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
