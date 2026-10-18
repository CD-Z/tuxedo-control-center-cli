import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runMissingBusCommand(args: string[]): Promise<ChildResult> {
	const directory = await mkdtemp(join(tmpdir(), "tcc-cli-process-"));
	const child = spawn(
		process.execPath,
		["--import", "tsx", resolve("src/cli-app/main.ts"), ...args],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(directory, "bus")}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string): void => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string): void => {
		stderr += chunk;
	});

	const timeout = setTimeout((): void => {
		child.kill("SIGKILL");
	}, 5000);
	try {
		const code = await new Promise<number | null>(
			(resolveExit, reject): void => {
				child.once("error", reject);
				child.once("close", resolveExit);
			},
		);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timeout);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
		await rm(directory, { recursive: true, force: true });
	}
}

describe("CLI process connection failure", (): void => {
	it("reports a missing system bus before reading, prompting, editing, or saving", async (): Promise<void> => {
		for (const args of [
			["status"],
			["profiles", "activate", "office"],
			["profiles", "activate", "Quiet profile"],
			["profiles", "show", "office"],
			["profiles", "show", "Quiet profile"],
			["profiles", "create", "Test", "--base", "office"],
			["profiles", "create", "Test", "--base", "Quiet profile"],
			["profiles", "edit", "office", "--brightness", "60"],
			["profiles", "edit", "Quiet profile", "--brightness", "60"],
		]) {
			const result = await runMissingBusCommand(args);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"tcc-cli: Cannot connect to tccd. Ensure tccd is running.",
			);
			expect(result.stderr).not.toMatch(
				/Base number|Profile editor|Cannot read saved profiles/i,
			);
			expect(result.stderr).not.toMatch(
				/Unhandled|uncaught|node:events|^\s+at /im,
			);
		}
	}, 15000);

	it("handles root, group, and leaf help before contacting an unavailable bus", async (): Promise<void> => {
		for (const [args, expectedText] of [
			[["--help"], "Usage: tcc-cli <command>"],
			[["profiles", "--help"], "Usage: tcc-cli profiles <command>"],
			[["profiles", "create", "--help"], "profiles create <name>"],
			[["profiles", "edit", "--help"], "profiles edit <profile>"],
			[["profiles", "show", "--help"], "profiles show <profile>"],
			[["ppd", "--help"], "Usage: tcc-cli ppd <command>"],
			[["ppd", "-h"], "Usage: tcc-cli ppd <command>"],
			[["ppd", "status", "--help"], "Usage: tcc-cli ppd status"],
			[["ppd", "status", "-h"], "Usage: tcc-cli ppd status"],
			[["ppd", "enable", "--help"], "Usage: tcc-cli ppd enable"],
			[["ppd", "enable", "-h"], "Usage: tcc-cli ppd enable"],
			[["ppd", "configure", "--help"], "Usage: tcc-cli ppd configure"],
			[["ppd", "configure", "-h"], "Usage: tcc-cli ppd configure"],
			[["ppd", "disable", "--help"], "Usage: tcc-cli ppd disable"],
			[["ppd", "disable", "-h"], "Usage: tcc-cli ppd disable"],
			[["profiles", "activate", "--help"], "profiles activate <profile>"],
		] as const) {
			const result = await runMissingBusCommand([...args]);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(expectedText);
		}
	}, 15000);

	it("reports valid ppd commands as unavailable when tccd cannot be reached", async (): Promise<void> => {
		for (const args of [
			["ppd", "status"],
			["ppd", "enable"],
			["ppd", "enable", "--power-saver", "office"],
			["ppd", "configure", "--ac=balanced"],
			["ppd", "disable"],
		]) {
			const result = await runMissingBusCommand(args);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"tcc-cli: Cannot connect to tccd. Ensure tccd is running.",
			);
			expect(result.stderr).not.toMatch(
				/Unhandled|uncaught|node:events|^\s+at /im,
			);
		}
	}, 15000);

	it("rejects invalid ppd arguments before contacting an unavailable bus", async (): Promise<void> => {
		for (const args of [
			["ppd", "unknown"],
			["ppd", "status", "--verbose"],
			["ppd", "disable", "--ac", "balanced"],
			["ppd", "enable", "--power-saver"],
			["ppd", "enable", "--power-saver="],
			["ppd", "enable", "--power-saver", "office", "--power-saver", "balanced"],
			["ppd", "enable", "--ac", "not-a-standard"],
			["ppd", "enable", "--balanced", "none"],
			["ppd", "configure"],
		]) {
			const result = await runMissingBusCommand(args);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("tcc-cli:");
			expect(result.stderr).not.toContain("tcc-cli: Cannot connect to tccd.");
			expect(result.stderr).not.toMatch(
				/Unhandled|uncaught|node:events|^\s+at /im,
			);
		}
	}, 20000);

	it("rejects bad setting values and syntax before contacting an unavailable bus", async (): Promise<void> => {
		const cases: Array<{ args: string[]; expected: string }> = [
			{
				args: [
					"profiles",
					"create",
					"Test",
					"--base",
					"builtin",
					"--cpu-cores",
					"0",
				],
				expected:
					'tcc-cli: Invalid value for --cpu-cores: "0". Expected a positive integer or "all".',
			},
			{
				args: ["profiles", "create", "Test", "--brightness"],
				expected: `tcc-cli: Missing value for --brightness.${String.fromCharCode(10)}Run "tcc-cli profiles create --help" for usage.`,
			},
			{
				args: [
					"profiles",
					"create",
					"Test",
					"--editor",
					"--description",
					"bad",
				],
				expected: `tcc-cli: --editor cannot be combined with setting flags.${String.fromCharCode(10)}Run "tcc-cli profiles create --help" for usage.`,
			},
		];
		for (const { args, expected } of cases) {
			const result = await runMissingBusCommand(args);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(`${expected}${String.fromCharCode(10)}`);
			expect(result.stderr).not.toContain("tcc-cli: Cannot connect to tccd.");
			expect(result.stderr).not.toContain("Usage:");
			expect(result.stderr).not.toMatch(
				/Unhandled|uncaught|node:events|^\s+at /im,
			);
		}
	}, 15000);
});
