#!/usr/bin/env bun
import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	DESKTOP_PROTOCOL_VERSION,
	type RpcResponse,
} from "../../../packages/desktop-protocol/src/index.ts";
import {
	type ElectronBuilderPlatform,
	type LocalRuntimeVerification,
	type RuntimeArchitecture,
	verifyPackagedLocalRuntime,
} from "./local-runtime-artifacts";

const COMMAND_TIMEOUT_MS = 30_000;
const SERVICE_TIMEOUT_MS = 30_000;

interface SmokeCheck {
	name: string;
	elapsedMs: number;
	detail: Record<string, boolean | number | string>;
}

interface SmokeEvidence {
	schemaVersion: 1;
	createdAt: string;
	host: { platform: NodeJS.Platform; arch: string };
	target: string;
	appOutDir?: string;
	result: "passed" | "failed";
	checks: SmokeCheck[];
	error?: string;
}

interface ReadyMessage {
	type: "local_service_ready";
	protocolVersion: number;
	host: "127.0.0.1";
	port: number;
}

interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

function readOption(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

function targetPlatform(value?: string): ElectronBuilderPlatform {
	if (value === "darwin" || value === "linux" || value === "win32")
		return value;
	throw new Error(`必须提供受支持的 --platform，实际：${value ?? "未提供"}`);
}

function targetArchitecture(value?: string): RuntimeArchitecture {
	if (value === "arm64" || value === "x64") return value;
	throw new Error(`必须提供受支持的 --arch，实际：${value ?? "未提供"}`);
}

export function findPackagedAppOutDir(
	outRoot: string,
	platform: ElectronBuilderPlatform,
	productName = "Xcodes",
): string {
	const candidates = readdirSync(outRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(outRoot, entry.name))
		.filter((candidate) => {
			const resources =
				platform === "darwin"
					? join(candidate, `${productName}.app`, "Contents", "Resources")
					: join(candidate, "resources");
			try {
				return statSync(resources).isDirectory();
			} catch {
				return false;
			}
		});
	if (candidates.length !== 1) {
		throw new Error(
			`目录包定位失败：${outRoot} 内应恰有 1 个 ${platform} 目录包，实际 ${candidates.length} 个`,
		);
	}
	const candidate = candidates[0];
	if (!candidate) throw new Error("目录包定位结果为空");
	return candidate;
}

export function parseReadyLine(line: string): ReadyMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const ready = value as Record<string, unknown>;
	if (
		ready.type !== "local_service_ready" ||
		ready.protocolVersion !== DESKTOP_PROTOCOL_VERSION ||
		ready.host !== "127.0.0.1" ||
		!Number.isInteger(ready.port) ||
		Number(ready.port) < 1 ||
		Number(ready.port) > 65_535
	)
		return null;
	return ready as unknown as ReadyMessage;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fileDigest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCommand(
	command: string,
	args: string[],
	environment?: Record<string, string>,
): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...(environment ? { env: environment } : {}),
		timeout: COMMAND_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${basename(command)} ${args.join(" ")} 退出码 ${result.status ?? "unknown"}：${result.stderr.trim()}`,
		);
	}
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) {
			throw new Error(`进程 ${pid} 在 ${timeoutMs}ms 内未退出`);
		}
		await Bun.sleep(50);
	}
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// 状态检查和发信号之间进程可能已经退出。
	}
}

export async function stopProcessByPid(pid: number): Promise<void> {
	if (!isProcessAlive(pid)) return;
	signalProcess(pid, "SIGTERM");
	await waitForPidExit(pid, 5_000).catch(async () => {
		if (isProcessAlive(pid)) signalProcess(pid, "SIGKILL");
		await waitForPidExit(pid, 5_000);
	});
}

function waitForExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolveExit, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(`进程 ${child.pid ?? "unknown"} 在 ${timeoutMs}ms 内未退出`),
			);
		}, timeoutMs);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			resolveExit({ code, signal });
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			child.off("exit", onExit);
			child.off("error", onError);
		};
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function waitForReady(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<ReadyMessage> {
	return new Promise((resolveReady, reject) => {
		let pending = "";
		let stderr = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`Local Service 在 ${timeoutMs}ms 内未输出 ready；stderr=${stderr.slice(-2_000)}`,
				),
			);
		}, timeoutMs);
		const onStdout = (chunk: Buffer) => {
			pending += chunk.toString("utf8");
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const ready = parseReadyLine(line);
				if (!ready) continue;
				cleanup();
				resolveReady(ready);
				return;
			}
		};
		const onStderr = (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(
				new Error(
					`Local Service 在 ready 前退出：code=${code}, signal=${signal}, stderr=${stderr}`,
				),
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout.off("data", onStdout);
			child.stderr.off("data", onStderr);
			child.off("exit", onExit);
			child.off("error", onError);
		};
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

async function rpc(
	ready: ReadyMessage,
	token: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(`http://${ready.host}:${ready.port}/v1/rpc`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ id: randomUUID(), method, params }),
	});
	const payload = (await response.json()) as RpcResponse;
	if (!response.ok || !payload.ok) {
		const detail = payload.ok
			? `HTTP ${response.status}`
			: `${payload.error.code}: ${payload.error.message}`;
		throw new Error(`${method} 失败：${detail}`);
	}
	return payload.result;
}

export function isolatedCliEnvironment(
	root: string,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const essentialNames = [
		"ComSpec",
		"LANG",
		"LC_ALL",
		"PATH",
		"PATHEXT",
		"SHELL",
		"SystemRoot",
		"TEMP",
		"TMP",
		"WINDIR",
	] as const;
	const environment: Record<string, string> = {};
	for (const name of essentialNames) {
		const value = source[name];
		if (value) environment[name] = value;
	}
	return {
		...environment,
		HOME: root,
		USERPROFILE: root,
		CLAUDE_CONFIG_DIR: join(root, ".claude"),
		CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_ERROR_REPORTING: "1",
		DISABLE_TELEMETRY: "1",
	};
}

async function smokeService(
	runtime: LocalRuntimeVerification,
): Promise<Record<string, boolean | number | string>> {
	const isolatedRoot = mkdtempSync(join(tmpdir(), "xcodes-packaged-runtime-"));
	const token = randomUUID();
	const child = spawn(runtime.bunPath, [runtime.serviceEntry], {
		env: {
			...isolatedCliEnvironment(isolatedRoot),
			XCODES_LOCAL_SERVICE_TOKEN: token,
			XCODES_LOCAL_SERVICE_STATE_DIR: join(isolatedRoot, "service-state"),
		},
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let cliPid: number | null = null;
	try {
		const ready = await waitForReady(child, SERVICE_TIMEOUT_MS);
		const health = (await rpc(ready, token, "service.health")) as Record<
			string,
			unknown
		>;
		if (
			health.protocolVersion !== DESKTOP_PROTOCOL_VERSION ||
			typeof health.serviceVersion !== "string" ||
			health.shuttingDown !== false
		)
			throw new Error("Local Service health 响应不符合协议");

		const opened = (await rpc(ready, token, "session.open", {
			sessionId: randomUUID(),
			cwd: isolatedRoot,
			permissionMode: "default",
			cli: {
				command: runtime.bunPath,
				argv: [runtime.cliEntry, "--bare"],
				env: isolatedCliEnvironment(isolatedRoot),
			},
		})) as Record<string, unknown>;
		cliPid = typeof opened.pid === "number" ? opened.pid : null;
		if (!cliPid || !isProcessAlive(cliPid)) {
			throw new Error("Local Service 未启动可管理的包内 CLI 子进程");
		}

		const exitPromise = waitForExit(child, SERVICE_TIMEOUT_MS);
		await rpc(ready, token, "service.shutdown");
		const exited = await exitPromise;
		if (exited.code !== 0 || exited.signal !== null) {
			throw new Error(
				`Local Service 未正常退出：code=${exited.code}, signal=${exited.signal}`,
			);
		}
		const servicePid = child.pid;
		if (servicePid && isProcessAlive(servicePid))
			throw new Error("Local Service 退出后 PID 仍存活");
		if (isProcessAlive(cliPid))
			throw new Error("Local Service 退出后包内 CLI 子进程仍存活");
		return {
			protocolVersion: Number(health.protocolVersion),
			serviceVersion: String(health.serviceVersion),
			managedCliStarted: true,
			serviceExitCode: exited.code ?? -1,
			serviceExitSignal: exited.signal ?? "none",
			serviceAliveAfterExit: false,
			managedCliAliveAfterExit: false,
		};
	} finally {
		try {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await waitForExit(child, 5_000).catch(async () => {
					child.kill("SIGKILL");
					await waitForExit(child, 5_000);
				});
			}
		} finally {
			try {
				if (cliPid) await stopProcessByPid(cliPid);
			} finally {
				rmSync(isolatedRoot, { recursive: true, force: true });
			}
		}
	}
}

function recordCheck(
	checks: SmokeCheck[],
	name: string,
	startedAt: number,
	detail: SmokeCheck["detail"],
): void {
	checks.push({ name, elapsedMs: Date.now() - startedAt, detail });
}

async function runSmoke(
	appOutDir: string,
	platform: ElectronBuilderPlatform,
	arch: RuntimeArchitecture,
	productName: string,
): Promise<SmokeCheck[]> {
	if (process.platform !== platform || process.arch !== arch) {
		throw new Error(
			`可运行 smoke 必须在目标宿主执行：host=${process.platform}-${process.arch}, target=${platform}-${arch}`,
		);
	}
	const checks: SmokeCheck[] = [];
	const commandRoot = mkdtempSync(join(tmpdir(), "xcodes-packaged-help-"));
	const commandEnvironment = isolatedCliEnvironment(commandRoot);
	try {
		let startedAt = Date.now();
		const runtime = verifyPackagedLocalRuntime(
			appOutDir,
			platform,
			productName,
			arch,
		);
		recordCheck(checks, "static-integrity", startedAt, {
			cliJavaScriptFiles: runtime.cliJavaScriptFiles,
			bunSha256: fileDigest(runtime.bunPath),
			cliEntrySha256: fileDigest(runtime.cliEntry),
			serviceEntrySha256: fileDigest(runtime.serviceEntry),
		});

		startedAt = Date.now();
		const bunVersion = runCommand(runtime.bunPath, ["--version"]).stdout.trim();
		recordCheck(checks, "bundled-bun", startedAt, { version: bunVersion });

		startedAt = Date.now();
		const cliHelp = runCommand(
			runtime.bunPath,
			[runtime.cliEntry, "--help"],
			commandEnvironment,
		);
		recordCheck(checks, "execution-cli-help", startedAt, {
			status: cliHelp.status,
			outputBytes: Buffer.byteLength(`${cliHelp.stdout}${cliHelp.stderr}`),
		});

		startedAt = Date.now();
		const sessionHelp = runCommand(
			runtime.bunPath,
			[runtime.sessionCliEntry, "--help"],
			commandEnvironment,
		);
		if (
			!`${sessionHelp.stdout}\n${sessionHelp.stderr}`.includes(
				"Proma 会话渐进式读取 CLI",
			)
		) {
			throw new Error("会话辅助 CLI --help 缺少预期标识");
		}
		recordCheck(checks, "session-cli-help", startedAt, {
			status: sessionHelp.status,
			outputBytes: Buffer.byteLength(
				`${sessionHelp.stdout}${sessionHelp.stderr}`,
			),
		});

		startedAt = Date.now();
		recordCheck(
			checks,
			"local-service-managed-exit",
			startedAt,
			await smokeService(runtime),
		);
		return checks;
	} finally {
		rmSync(commandRoot, { recursive: true, force: true });
	}
}

export function resolveAppOutDir(
	explicitAppOutDir: string | undefined,
	outRoot: string | undefined,
	platform: ElectronBuilderPlatform,
	productName = "Xcodes",
): string {
	return explicitAppOutDir
		? resolve(explicitAppOutDir)
		: findPackagedAppOutDir(resolve(outRoot ?? ""), platform, productName);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const platform = targetPlatform(readOption(argv, "--platform"));
	const arch = targetArchitecture(readOption(argv, "--arch"));
	const productName = readOption(argv, "--product-name") ?? "Xcodes";
	const evidencePath = resolve(
		readOption(argv, "--evidence") ?? "packaged-runtime-smoke.json",
	);
	const evidence: SmokeEvidence = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		host: { platform: process.platform, arch: process.arch },
		target: `${platform}-${arch}`,
		result: "failed",
		checks: [],
	};
	try {
		const explicitAppOutDir = readOption(argv, "--app-out-dir");
		const outRoot = readOption(argv, "--out-root");
		const appOutDir = resolveAppOutDir(
			explicitAppOutDir,
			outRoot,
			platform,
			productName,
		);
		evidence.appOutDir = appOutDir;
		evidence.checks = await runSmoke(appOutDir, platform, arch, productName);
		evidence.result = "passed";
	} catch (error) {
		evidence.error = errorMessage(error);
	}
	mkdirSync(dirname(evidencePath), { recursive: true });
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(JSON.stringify(evidence, null, 2));
	if (evidence.result !== "passed") process.exitCode = 1;
}

if (import.meta.main) await main();
