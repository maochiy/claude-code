import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findPackagedAppOutDir,
	isolatedCliEnvironment,
	parseReadyLine,
	resolveAppOutDir,
	stopProcessByPid,
} from "./packaged-runtime-smoke";

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("目录包 Runtime smoke BDD", () => {
	test("从构建输出中只接受唯一的 macOS 目录包", () => {
		const root = mkdtempSync(join(tmpdir(), "xcodes-packaged-smoke-"));
		mkdirSync(join(root, "mac-arm64", "Xcodes.app", "Contents", "Resources"), {
			recursive: true,
		});
		mkdirSync(join(root, "unrelated"), { recursive: true });
		expect(findPackagedAppOutDir(root, "darwin")).toBe(join(root, "mac-arm64"));

		mkdirSync(join(root, "mac-copy", "Xcodes.app", "Contents", "Resources"), {
			recursive: true,
		});
		expect(() => findPackagedAppOutDir(root, "darwin")).toThrow("恰有 1 个");
	});

	test("只接受当前协议、loopback 和有效端口的 ready 握手", () => {
		expect(parseReadyLine("build log")).toBeNull();
		expect(
			parseReadyLine(
				JSON.stringify({
					type: "local_service_ready",
					protocolVersion: 1,
					host: "127.0.0.1",
					port: 49_152,
				}),
			),
		).toEqual({
			type: "local_service_ready",
			protocolVersion: 1,
			host: "127.0.0.1",
			port: 49_152,
		});
		expect(
			parseReadyLine(
				JSON.stringify({
					type: "local_service_ready",
					protocolVersion: 2,
					host: "127.0.0.1",
					port: 49_152,
				}),
			),
		).toBeNull();
		expect(
			parseReadyLine(
				JSON.stringify({
					type: "local_service_ready",
					protocolVersion: 1,
					host: "0.0.0.0",
					port: 49_152,
				}),
			),
		).toBeNull();
	});

	test("帮助命令环境只保留系统启动字段并隔离用户目录和凭据", () => {
		const environment = isolatedCliEnvironment("/tmp/isolated-help", {
			PATH: "/usr/bin",
			LANG: "zh_CN.UTF-8",
			ANTHROPIC_API_KEY: "must-not-pass",
			AWS_SECRET_ACCESS_KEY: "must-not-pass",
		});

		expect(environment.PATH).toBe("/usr/bin");
		expect(environment.LANG).toBe("zh_CN.UTF-8");
		expect(environment.HOME).toBe("/tmp/isolated-help");
		expect(environment.USERPROFILE).toBe("/tmp/isolated-help");
		expect(environment.CLAUDE_CONFIG_DIR).toBe("/tmp/isolated-help/.claude");
		expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
		expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	});

	test("显式目录包路径优先，不扫描 out 根目录", () => {
		const explicit = join(tmpdir(), "existing-app-out");
		expect(
			resolveAppOutDir(explicit, join(tmpdir(), "missing-out"), "darwin"),
		).toBe(explicit);
	});

	test("异常清理会终止仍存活的受管进程", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				stdio: "ignore",
			},
		);
		if (!child.pid) throw new Error("测试子进程启动失败");
		try {
			expect(processIsAlive(child.pid)).toBe(true);
			await stopProcessByPid(child.pid);
			expect(processIsAlive(child.pid)).toBe(false);
		} finally {
			if (processIsAlive(child.pid)) child.kill("SIGKILL");
		}
	});
});
