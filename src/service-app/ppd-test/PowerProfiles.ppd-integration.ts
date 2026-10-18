import "jasmine";
import * as dbus from "dbus-next";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../cli-app/cli";
import type { ProfileIO } from "../../cli-app/profile-io";
import { TccDBusController } from "../../common/classes/TccDBusController";
import type { ITccSettings } from "../../common/models/TccSettings";
import {
	POWER_PROFILE_HOLD_ACTION,
	POWER_PROFILE_SWITCH_ACTION,
	POWER_PROFILES_INTERFACE,
	POWER_PROFILES_NAME,
	TCC_INTERFACE,
	TCC_PATH,
} from "../classes/PowerProfilesService";
import {
	createPowerProfilesHarness,
	deferred,
	isPropertyChanged,
	PROFILE_IDS,
	providerProxies,
	testSettings,
	uniqueName,
	type PowerProfilesProxy,
	type PowerPropertiesProxy,
	type PowerProfilesIntegrationHarness,
	type Deferred,
} from "./provider-harness";

const ACCESS_DENIED = "org.freedesktop.DBus.Error.AccessDenied";

async function getActive(properties: PowerPropertiesProxy): Promise<string> {
	return (await properties.Get(POWER_PROFILES_INTERFACE, "ActiveProfile"))
		.value as string;
}

async function getHoldValues(
	properties: PowerPropertiesProxy,
): Promise<Array<Record<string, dbus.Variant>>> {
	return (await properties.Get(POWER_PROFILES_INTERFACE, "ActiveProfileHolds"))
		.value as Array<Record<string, dbus.Variant>>;
}

async function expectDbusError(
	operation: Promise<unknown>,
	expectedType: string,
): Promise<dbus.DBusError> {
	let received: unknown;
	try {
		await operation;
	} catch (error) {
		received = error;
	}
	expect(received).toBeDefined();
	expect((received as dbus.DBusError).type).toBe(expectedType);
	return received as dbus.DBusError;
}

function waitForPropertyChange(
	properties: PowerPropertiesProxy,
	predicate: (changed: Record<string, dbus.Variant>) => boolean,
	timeoutMs = 2500,
): Promise<Record<string, dbus.Variant>> {
	const waiter = deferred<Record<string, dbus.Variant>>();
	const timer = setTimeout(
		() => waiter.reject(new Error("Timed out waiting for PropertiesChanged")),
		timeoutMs,
	);
	properties.on("PropertiesChanged", (_interfaceName, changed) => {
		if (predicate(changed)) {
			clearTimeout(timer);
			waiter.resolve(changed);
		}
	});
	return waiter.promise;
}

function expectProfileRelease(
	client: dbus.MessageBus,
	profiles: PowerProfilesProxy,
): Promise<number> {
	const waiter = deferred<number>();
	profiles.on("ProfileReleased", () => undefined);
	const timer = setTimeout(
		() => waiter.reject(new Error("Timed out waiting for ProfileReleased")),
		2500,
	);
	const listener = (message: dbus.Message): void => {
		if (
			message.type === dbus.MessageType.SIGNAL &&
			message.path === "/org/freedesktop/UPower/PowerProfiles" &&
			message.interface === POWER_PROFILES_INTERFACE &&
			message.member === "ProfileReleased" &&
			message.signature === "u"
		) {
			clearTimeout(timer);
			client.removeListener("message", listener);
			waiter.resolve(message.body[0] as number);
		}
	};
	client.on("message", listener);
	return waiter.promise;
}

async function closeHarness(
	harness: PowerProfilesIntegrationHarness | undefined,
): Promise<void> {
	await harness?.close();
}

function privateSessionBusAddress(): string {
	const address = process.env.DBUS_SESSION_BUS_ADDRESS;
	if (address === undefined) {
		throw new Error(
			"The private-bus integration tests require dbus-run-session",
		);
	}
	return address;
}

async function runTccCli(args: string[]): Promise<{
	status: number | null;
	stdout: string;
	stderr: string;
}> {
	const busAddress = privateSessionBusAddress();
	const bundle = resolve(
		process.cwd(),
		"dist/tuxedo-control-center/data/cli/tcc-cli.cjs",
	);
	const command = existsSync(bundle)
		? [bundle, ...args]
		: [
				"--import",
				"tsx",
				resolve(process.cwd(), "src/cli-app/main.ts"),
				...args,
			];
	const {
		promise,
		resolve: resolveResult,
		reject,
	} = Promise.withResolvers<{
		status: number | null;
		stdout: string;
		stderr: string;
	}>();
	const child = spawn(process.execPath, command, {
		cwd: process.cwd(),
		env: {
			...process.env,
			DBUS_SYSTEM_BUS_ADDRESS: busAddress,
		},
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 5000);
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.once("error", (error) => {
		clearTimeout(timer);
		reject(error);
	});
	child.once("close", (status) => {
		clearTimeout(timer);
		if (timedOut) {
			reject(
				new Error(
					`CLI child exceeded its 5-second deadline: ${args.join(" ")}`,
				),
			);
			return;
		}
		resolveResult({ status, stdout, stderr });
	});
	return promise;
}

interface TemporarySettingsFile {
	path: string;
	read(): Promise<ITccSettings>;
	close(): Promise<void>;
}

async function createTemporarySettingsFile(
	initial: ITccSettings,
): Promise<TemporarySettingsFile> {
	const directory = await mkdtemp(join(tmpdir(), "tcc-ppd-integration-"));
	const path = join(directory, "settings.json");
	try {
		await writeFile(path, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
	} catch (error: unknown) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return {
		path,
		async read(): Promise<ITccSettings> {
			return JSON.parse(await readFile(path, "utf8")) as ITccSettings;
		},
		async close(): Promise<void> {
			await rm(directory, { recursive: true, force: true });
		},
	};
}

interface PpdCliResult {
	status: number;
	stdout: string;
	stderr: string;
}

async function runPpdInProcess(
	harness: PowerProfilesIntegrationHarness,
	settingsPath: string,
	args: string[],
): Promise<PpdCliResult> {
	const busAddress = privateSessionBusAddress();
	const previousSystemBusAddress = process.env.DBUS_SYSTEM_BUS_ADDRESS;
	process.env.DBUS_SYSTEM_BUS_ADDRESS = busAddress;
	let stdout = "";
	let stderr = "";
	try {
		const status = await runCli(["ppd", ...args], {
			createClient: () => new TccDBusController(),
			createProfileIO: () =>
				({
					async saveSettings(json: string): Promise<void> {
						const candidate = JSON.parse(json) as ITccSettings;
						await harness.selector.updateConfiguration(
							candidate,
							undefined,
							async (acceptedSettings) => {
								await writeFile(
									settingsPath,
									`${JSON.stringify(acceptedSettings, null, 2)}\n`,
									"utf8",
								);
							},
						);
						await harness.service.refreshProvider();
					},
				}) as ProfileIO,
			stdout(text: string): void {
				stdout += text;
			},
			stderr(text: string): void {
				stderr += text;
			},
		});
		return { status, stdout, stderr };
	} finally {
		if (previousSystemBusAddress === undefined) {
			delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
		} else {
			process.env.DBUS_SYSTEM_BUS_ADDRESS = previousSystemBusAddress;
		}
	}
}

async function getPowerProfilesNameOwner(
	bus: dbus.MessageBus,
): Promise<string | undefined> {
	try {
		const reply = await bus.call(
			new dbus.Message({
				destination: "org.freedesktop.DBus",
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "GetNameOwner",
				signature: "s",
				body: [POWER_PROFILES_NAME],
			}),
		);
		if (
			reply === null ||
			reply.signature !== "s" ||
			reply.body.length !== 1 ||
			typeof reply.body[0] !== "string"
		) {
			throw new Error(
				"The private bus returned a malformed provider owner reply",
			);
		}
		return reply.body[0];
	} catch (error: unknown) {
		if (
			error instanceof dbus.DBusError &&
			error.type === "org.freedesktop.DBus.Error.NameHasNoOwner"
		) {
			return undefined;
		}
		throw error;
	}
}

describe("Power Profiles D-Bus integration", () => {
	it("serves the real modern object with typed discovery and waits for application before publishing a switch", async () => {
		const harness = await createPowerProfilesHarness();
		let readClient: dbus.MessageBus | undefined;
		let switchClient: dbus.MessageBus | undefined;
		let gate: Deferred<void> | undefined;
		try {
			readClient = await harness.openClient();
			switchClient = await harness.openClient();
			const propertySignals: dbus.Message[] = [];
			readClient.on("message", (message) => {
				if (
					message.type === dbus.MessageType.SIGNAL &&
					message.member === "PropertiesChanged"
				) {
					propertySignals.push(message);
				}
			});
			const readProxy = await providerProxies(readClient);
			const switchProxy = await providerProxies(switchClient);
			const introspection = await readClient.call(
				new dbus.Message({
					destination: "org.freedesktop.UPower.PowerProfiles",
					path: "/org/freedesktop/UPower/PowerProfiles",
					interface: "org.freedesktop.DBus.Introspectable",
					member: "Introspect",
				}),
			);
			expect(introspection?.signature).toBe("s");
			expect(introspection?.body[0]).toContain('name="HoldProfile"');
			expect(introspection?.body[0]).not.toContain("BatteryAware");
			const all = await readProxy.properties.GetAll(POWER_PROFILES_INTERFACE);
			expect(Object.keys(all)).toEqual([
				"Profiles",
				"ActiveProfile",
				"PerformanceInhibited",
				"PerformanceDegraded",
				"ActiveProfileHolds",
				"Actions",
				"ActionsInfo",
				"Version",
			]);
			expect(all.ActiveProfile.signature).toBe("s");
			expect(all.ActiveProfile.value).toBe("balanced");
			expect(all.Profiles.signature).toBe("aa{sv}");
			expect(all.Profiles.value).toEqual([
				{
					Profile: new dbus.Variant("s", "power-saver"),
					Driver: new dbus.Variant("s", "tcc"),
				},
				{
					Profile: new dbus.Variant("s", "balanced"),
					Driver: new dbus.Variant("s", "tcc"),
				},
				{
					Profile: new dbus.Variant("s", "performance"),
					Driver: new dbus.Variant("s", "tcc"),
				},
			]);
			expect(all.ActiveProfileHolds.signature).toBe("aa{sv}");
			expect(all.Actions.signature).toBe("as");
			expect(all.Actions.value).toEqual([]);
			expect(all.ActionsInfo.value).toEqual([]);
			expect(all.Version.value).toBe("tcc-integration");
			expect(all.PerformanceInhibited.value).toBe("");
			expect(all.PerformanceDegraded.value).toBe("");

			gate = deferred<void>();
			harness.gateProfile(PROFILE_IDS["power-saver"], gate.promise);
			const changed = waitForPropertyChange(readProxy.properties, (values) =>
				isPropertyChanged(
					values,
					"ActiveProfile",
					(value) => value === "power-saver",
				),
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			const switching = switchProxy.properties.Set(
				POWER_PROFILES_INTERFACE,
				"ActiveProfile",
				new dbus.Variant("s", "power-saver"),
			);
			await waitForAppliedProfile(
				harness.appliedProfiles,
				PROFILE_IDS["power-saver"],
			);
			expect(await getActive(readProxy.properties)).toBe("balanced");
			expect(harness.persistedSettings).toEqual([]);

			gate.resolve();
			await switching;
			const notification = await changed;
			const signal = propertySignals.find(
				(message) => message.interface === "org.freedesktop.DBus.Properties",
			);
			if (signal === undefined) {
				throw new Error("Expected a PropertiesChanged signal.");
			}
			expect(signal.signature).toBe("sa{sv}as");
			expect(signal.body[0]).toBe(POWER_PROFILES_INTERFACE);
			expect(
				(signal.body[1] as Record<string, dbus.Variant>).ActiveProfile
					.signature,
			).toBe("s");
			expect(
				(signal.body[1] as Record<string, dbus.Variant>).Actions.signature,
			).toBe("as");
			expect(signal.body[2]).toEqual([]);
			expect(notification.ActiveProfile.value).toBe("power-saver");
			expect(await getActive(readProxy.properties)).toBe("power-saver");
			expect(harness.appliedProfiles).toEqual([
				PROFILE_IDS.balanced,
				PROFILE_IDS["power-saver"],
			]);
			expect(harness.persistedSettings).toHaveSize(1);
			expect(harness.persistedSettings[0].stateMap.power_ac).toBe(
				PROFILE_IDS["power-saver"],
			);
			expect(harness.authorizationCalls).toContain({
				sender: uniqueName(switchClient),
				action: POWER_PROFILE_SWITCH_ACTION,
			});
			expect(harness.polkitSubjects).toContain({
				sender: uniqueName(switchClient),
				subjectType: "system-bus-name",
				action: POWER_PROFILE_SWITCH_ACTION,
				flags: 0,
			});
		} finally {
			gate?.resolve();
			await closeHarness(harness);
		}
	});

	it("arbitrates real cross-connection holds and sends ProfileReleased only to the holder", async () => {
		const harness = await createPowerProfilesHarness();
		try {
			const performanceClient = await harness.openClient();
			const saverClient = await harness.openClient();
			const observerClient = await harness.openClient();
			const performance = await providerProxies(performanceClient);
			const saver = await providerProxies(saverClient);
			const observer = await providerProxies(observerClient);
			observer.profiles.on("ProfileReleased", () => undefined);
			const saverReleased = expectProfileRelease(saverClient, saver.profiles);
			const observerSignals: number[] = [];
			observerClient.on("message", (message) => {
				if (
					message.type === dbus.MessageType.SIGNAL &&
					message.member === "ProfileReleased" &&
					message.signature === "u"
				) {
					observerSignals.push(message.body[0] as number);
				}
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 25));

			const performanceCookie = await performance.profiles.HoldProfile(
				"performance",
				"Keep a build responsive",
				"org.example.Builder",
			);
			expect(await getActive(performance.properties)).toBe("performance");
			expect(harness.appliedProfiles.at(-1)).toBe(PROFILE_IDS.performance);

			const saverCookie = await saver.profiles.HoldProfile(
				"power-saver",
				"Reduce power use",
				"org.example.Reader",
			);
			expect(await getActive(saver.properties)).toBe("power-saver");
			expect(harness.appliedProfiles.at(-1)).toBe(PROFILE_IDS["power-saver"]);
			const holds = await getHoldValues(observer.properties);
			expect(holds).toHaveSize(2);
			await expectDbusError(
				observer.profiles.ReleaseProfile(performanceCookie),
				ACCESS_DENIED,
			);
			expect(await getHoldValues(observer.properties)).toHaveSize(2);
			expect(holds.map((hold) => hold.Profile.value)).toEqual([
				"performance",
				"power-saver",
			]);
			expect(holds.map((hold) => hold.ApplicationId.value)).toEqual([
				"org.example.Builder",
				"org.example.Reader",
			]);
			expect(holds.map((hold) => hold.Reason.value)).toEqual([
				"Keep a build responsive",
				"Reduce power use",
			]);
			expect(
				holds.every(
					(hold) =>
						hold.Profile.signature === "s" &&
						hold.ApplicationId.signature === "s" &&
						hold.Reason.signature === "s",
				),
			).toBeTrue();

			await saver.profiles.ReleaseProfile(saverCookie);
			expect(await saverReleased).toBe(saverCookie);
			expect(await getActive(performance.properties)).toBe("performance");
			expect(await getHoldValues(observer.properties)).toEqual([
				{
					ApplicationId: new dbus.Variant("s", "org.example.Builder"),
					Profile: new dbus.Variant("s", "performance"),
					Reason: new dbus.Variant("s", "Keep a build responsive"),
				},
			]);
			expect(observerSignals).toEqual([]);

			const performanceReleased = expectProfileRelease(
				performanceClient,
				performance.profiles,
			);
			await performance.profiles.ReleaseProfile(performanceCookie);
			expect(await performanceReleased).toBe(performanceCookie);
			expect(observerSignals).toEqual([]);
			expect(await getActive(performance.properties)).toBe("balanced");
			expect(harness.appliedProfiles.slice(-4)).toEqual([
				PROFILE_IDS.performance,
				PROFILE_IDS["power-saver"],
				PROFILE_IDS.performance,
				PROFILE_IDS.balanced,
			]);
			expect(
				harness.authorizationCalls.filter(
					(call) => call.action === POWER_PROFILE_HOLD_ACTION,
				),
			).toEqual([
				{
					sender: uniqueName(performanceClient),
					action: POWER_PROFILE_HOLD_ACTION,
				},
				{ sender: uniqueName(saverClient), action: POWER_PROFILE_HOLD_ACTION },
			]);
		} finally {
			await closeHarness(harness);
		}
	});

	it("cancels a hold on a differing manual switch and rejects denied or invalid wire requests", async () => {
		const harness = await createPowerProfilesHarness();
		try {
			const owner = await harness.openClient();
			const deniedClient = await harness.openClient();
			const reader = await harness.openClient();
			const ownerProxy = await providerProxies(owner);
			const deniedProxy = await providerProxies(deniedClient);
			const readerProxy = await providerProxies(reader);
			const released = expectProfileRelease(owner, ownerProxy.profiles);
			const cookie = await ownerProxy.profiles.HoldProfile(
				"performance",
				"Rendering",
				"org.example.Renderer",
			);
			const beforeDenied = harness.appliedProfiles.length;
			harness.deny(uniqueName(deniedClient));

			await expectDbusError(
				deniedProxy.properties.Set(
					POWER_PROFILES_INTERFACE,
					"ActiveProfile",
					new dbus.Variant("s", "power-saver"),
				),
				ACCESS_DENIED,
			);
			expect(harness.appliedProfiles).toHaveSize(beforeDenied);
			expect(await getActive(readerProxy.properties)).toBe("performance");
			expect(harness.authorizationCalls).toContain({
				sender: uniqueName(deniedClient),
				action: POWER_PROFILE_SWITCH_ACTION,
			});

			const checksBeforeSameValue = harness.authorizationCalls.length;
			await expectDbusError(
				deniedProxy.profiles.HoldProfile(
					"balanced",
					"unsupported hold",
					"org.example.Reader",
				),
				"org.freedesktop.DBus.Error.InvalidArgs",
			);
			expect(harness.authorizationCalls.length).toBe(checksBeforeSameValue);
			await expectDbusError(
				readerProxy.properties.Get(POWER_PROFILES_INTERFACE, "BatteryAware"),
				"org.freedesktop.DBus.Error.UnknownProperty",
			);
			await expectDbusError(
				readerProxy.properties.Set(
					POWER_PROFILES_INTERFACE,
					"Version",
					new dbus.Variant("s", "forged"),
				),
				"org.freedesktop.DBus.Error.PropertyReadOnly",
			);
			await expectDbusError(
				readerProxy.properties.Get(POWER_PROFILES_INTERFACE, "NotAProperty"),
				"org.freedesktop.DBus.Error.UnknownProperty",
			);

			const changed = waitForPropertyChange(readerProxy.properties, (values) =>
				isPropertyChanged(
					values,
					"ActiveProfileHolds",
					(value) => Array.isArray(value) && value.length === 0,
				),
			);
			await readerProxy.properties.Set(
				POWER_PROFILES_INTERFACE,
				"ActiveProfile",
				new dbus.Variant("s", "power-saver"),
			);
			expect(await released).toBe(cookie);
			expect((await changed).ActiveProfile.value).toBe("power-saver");
			expect(await getActive(readerProxy.properties)).toBe("power-saver");
			expect(await getHoldValues(readerProxy.properties)).toEqual([]);
			expect(harness.persistedSettings.at(-1)?.stateMap.power_ac).toBe(
				PROFILE_IDS["power-saver"],
			);
		} finally {
			await closeHarness(harness);
		}
	});
	it("rolls back an application failure without publishing or persisting the candidate", async () => {
		const harness = await createPowerProfilesHarness();
		try {
			const client = await harness.openClient();
			const proxy = await providerProxies(client);
			harness.failProfile(PROFILE_IDS["power-saver"]);

			await expectDbusError(
				proxy.properties.Set(
					POWER_PROFILES_INTERFACE,
					"ActiveProfile",
					new dbus.Variant("s", "power-saver"),
				),
				"org.freedesktop.DBus.Error.Failed",
			);
			expect(await getActive(proxy.properties)).toBe("balanced");
			expect(harness.appliedProfiles).toEqual([
				PROFILE_IDS.balanced,
				PROFILE_IDS["power-saver"],
				PROFILE_IDS.balanced,
			]);
			expect(harness.persistedSettings).toEqual([]);
		} finally {
			await closeHarness(harness);
		}
	});

	it("removes a disconnected owner hold and restores the committed base profile", async () => {
		const harness = await createPowerProfilesHarness();
		try {
			const owner = await harness.openClient();
			const observer = await harness.openClient();
			const ownerProxy = await providerProxies(owner);
			const observerProxy = await providerProxies(observer);
			const cookie = await ownerProxy.profiles.HoldProfile(
				"performance",
				"Temporary work",
				"org.example.Worker",
			);
			expect(cookie).toBeGreaterThan(0);
			expect(await getActive(observerProxy.properties)).toBe("performance");
			const holdRemoval = waitForPropertyChange(
				observerProxy.properties,
				(changed) =>
					isPropertyChanged(
						changed,
						"ActiveProfileHolds",
						(value) => Array.isArray(value) && value.length === 0,
					),
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 25));

			owner.disconnect();
			harness.clients.delete(owner);
			const changed = await holdRemoval;
			expect(changed.ActiveProfileHolds.value as unknown[]).toEqual([]);
			expect(changed.ActiveProfile.value).toBe("balanced");
			expect(await getActive(observerProxy.properties)).toBe("balanced");
			expect(harness.appliedProfiles.slice(-2)).toEqual([
				PROFILE_IDS.performance,
				PROFILE_IDS.balanced,
			]);
		} finally {
			await closeHarness(harness);
		}
	});

	it("authorizes the TCC temporary setter on the same dispatcher when provider mode is enabled", async () => {
		const harness = await createPowerProfilesHarness({ claimTccName: true });
		try {
			const client = await harness.openClient();
			const method = new dbus.Message({
				destination: "com.tuxedocomputers.tccd",
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "SetTempProfileById",
				signature: "s",
				body: [PROFILE_IDS["power-saver"]],
			});
			const reply = await client.call(method);
			expect(reply?.type).toBe(dbus.MessageType.METHOD_RETURN);
			expect(reply?.signature).toBe("b");
			expect(reply?.body).toEqual([true]);
			expect(harness.authorizationCalls).toContain({
				sender: uniqueName(client),
				action: POWER_PROFILE_SWITCH_ACTION,
			});
			expect(harness.appliedProfiles.at(-1)).toBe(PROFILE_IDS["power-saver"]);

			harness.deny(uniqueName(client));
			const denied = new dbus.Message({
				destination: "com.tuxedocomputers.tccd",
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "SetTempProfileById",
				signature: "s",
				body: [PROFILE_IDS.performance],
			});
			await expectDbusError(
				client.call(denied) as Promise<dbus.Message>,
				ACCESS_DENIED,
			);
			expect(harness.appliedProfiles.at(-1)).toBe(PROFILE_IDS["power-saver"]);
		} finally {
			await closeHarness(harness);
		}
	});
	it("runs the CLI bundle against the daemon for discovery and temporary activation", async () => {
		const harness = await createPowerProfilesHarness({ claimTccName: true });
		try {
			const listing = await runTccCli(["profiles", "list"]);
			expect(listing.status).toBe(0, listing.stderr);
			expect(listing.stdout).toContain(
				`${PROFILE_IDS["power-saver"]}\tQuiet profile`,
			);
			expect(listing.stdout).toContain(
				`${PROFILE_IDS.balanced}\tEveryday profile`,
			);

			const activation = await runTccCli([
				"profiles",
				"activate",
				PROFILE_IDS["power-saver"],
			]);
			expect(activation.status).toBe(0, activation.stderr);
			expect(activation.stdout).toContain(
				`Activated temporary profile: Quiet profile [${PROFILE_IDS["power-saver"]}]`,
			);
			expect(harness.appliedProfiles.at(-1)).toBe(PROFILE_IDS["power-saver"]);
			expect(harness.persistedSettings).toEqual([]);
		} finally {
			await closeHarness(harness);
		}
	});
	it("activates a uniquely named profile through the provider dispatcher", async () => {
		const harness = await createPowerProfilesHarness({ claimTccName: true });
		try {
			const initialSettings = testSettings();
			const initialMapping = structuredClone(initialSettings.ppd?.profiles);
			expect(harness.selector.activeProfile?.id).toBe(PROFILE_IDS.balanced);

			const activation = await runTccCli([
				"profiles",
				"activate",
				"Quiet profile",
			]);
			expect(activation.status).toBe(0, activation.stderr);
			expect(activation.stdout).toContain(
				`Activated temporary profile: Quiet profile [${PROFILE_IDS["power-saver"]}]`,
			);
			expect(activation.stderr).toBe("");
			expect(harness.selector.activeProfile?.id).toBe(
				PROFILE_IDS["power-saver"],
			);
			expect(harness.appliedProfiles.at(-1)).toBe(PROFILE_IDS["power-saver"]);
			expect(harness.persistedSettings).toEqual([]);
			expect(harness.configurationReplacements).toEqual([]);
			expect(initialMapping).toEqual(testSettings().ppd?.profiles);
		} finally {
			await closeHarness(harness);
		}
	}, 15000);

	it("rejects a uniquely named profile that is not mapped by the provider", async () => {
		const harness = await createPowerProfilesHarness({ claimTccName: true });
		try {
			const activeBefore = harness.selector.activeProfile?.id;
			const candidateSettings = testSettings();
			candidateSettings.ppd!.profiles!.performance = null;
			await harness.selector.reload(
				candidateSettings,
				harness.selector.profiles,
			);
			const mappingsBefore = structuredClone(candidateSettings.ppd?.profiles);
			const activeAfterReload = harness.selector.activeProfile?.id;
			const appliedBefore = [...harness.appliedProfiles];

			const activation = await runTccCli([
				"profiles",
				"activate",
				"Fast profile",
			]);
			expect(activation.status).toBe(1);
			expect(activation.stdout).toBe("");
			expect(activation.stderr).not.toBe("");
			expect(harness.selector.activeProfile?.id).toBe(activeAfterReload);
			expect(harness.selector.activeProfile?.id).toBe(activeBefore);
			expect(harness.appliedProfiles).toEqual(appliedBefore);
			expect(harness.persistedSettings).toEqual([]);
			expect(harness.configurationReplacements).toEqual([]);
			expect(candidateSettings.ppd?.profiles).toEqual(mappingsBefore);
		} finally {
			await closeHarness(harness);
		}
	}, 15000);
	it("runs the ppd CLI lifecycle against the private bus and persists settings through the selector", async () => {
		const initialSettings = testSettings();
		const busAddress = privateSessionBusAddress();
		initialSettings.ppd!.enabled = false;
		initialSettings.fahrenheit = true;
		const settingsFile = await createTemporarySettingsFile(initialSettings);
		let harness: PowerProfilesIntegrationHarness | undefined;
		try {
			const activeHarness = await createPowerProfilesHarness({
				claimTccName: true,
				busAddress,
				initialSettings,
			});
			harness = activeHarness;
			const profilesBefore = structuredClone(activeHarness.selector.profiles);
			const configure = await runPpdInProcess(
				activeHarness,
				settingsFile.path,
				["configure", "--performance", "none"],
			);
			expect(configure.status).toBe(0, configure.stderr);
			const configuredWhileDisabled = await settingsFile.read();
			expect(configuredWhileDisabled.ppd?.enabled).toBeFalse();
			expect(configuredWhileDisabled.ppd?.profiles?.performance).toBeNull();
			expect(configuredWhileDisabled.stateMap).toEqual(
				initialSettings.stateMap,
			);
			expect(configuredWhileDisabled.fahrenheit).toBeTrue();
			expect(
				await getPowerProfilesNameOwner(activeHarness.bus),
			).toBeUndefined();

			const disabledStatus = await runTccCli(["ppd", "status"]);
			expect(disabledStatus.status).toBe(0, disabledStatus.stderr);
			expect(disabledStatus.stdout).toContain("Enabled: no");
			expect(disabledStatus.stdout).toContain("Provider: inactive");

			const enable = await runPpdInProcess(activeHarness, settingsFile.path, [
				"enable",
				"--power-saver",
				PROFILE_IDS["power-saver"],
				"--balanced",
				PROFILE_IDS.balanced,
				"--performance",
				PROFILE_IDS.performance,
				"--ac",
				"balanced",
				"--battery",
				"power-saver",
			]);
			expect(enable.status).toBe(0, enable.stderr);
			const enabledSettings = await settingsFile.read();
			expect(enabledSettings.ppd?.enabled).toBeTrue();
			expect(enabledSettings.ppd?.profiles).toEqual({
				"power-saver": PROFILE_IDS["power-saver"],
				balanced: PROFILE_IDS.balanced,
				performance: PROFILE_IDS.performance,
			});
			expect(enabledSettings.stateMap).toEqual({
				power_ac: PROFILE_IDS.balanced,
				power_bat: PROFILE_IDS["power-saver"],
			});
			expect(enabledSettings.fahrenheit).toBeTrue();
			expect(activeHarness.selector.settings).toEqual(enabledSettings);
			expect(await getPowerProfilesNameOwner(activeHarness.bus)).toBe(
				uniqueName(activeHarness.bus),
			);

			const providerClient = await activeHarness.openClient();
			const provider = await providerProxies(providerClient);
			expect(await getActive(provider.properties)).toBe("balanced");
			expect(activeHarness.appliedProfiles.at(-1)).toBe(PROFILE_IDS.balanced);
			const activeStatus = await runTccCli(["ppd", "status"]);
			expect(activeStatus.status).toBe(0, activeStatus.stderr);
			expect(activeStatus.stdout).toContain("Enabled: yes");
			expect(activeStatus.stdout).toContain("Provider: active");
			expect(activeStatus.stdout).toContain("Active profile: balanced");

			const invalidCommands = [
				["configure", "--power-saver", "not-a-profile"],
				["configure", "--balanced", PROFILE_IDS["power-saver"]],
				["configure", "--power-saver", "default"],
				["configure", "--performance", "none", "--ac", "performance"],
				["configure", "--power-saver", PROFILE_IDS.alternate],
			];
			const snapshot = async () => ({
				disk: await readFile(settingsFile.path, "utf8"),
				settings: activeHarness.selector.settings,
				activeProfile: activeHarness.selector.activeProfile,
				mappings: activeHarness.selector.mappings,
				profiles: activeHarness.selector.profiles,
				appliedProfiles: [...activeHarness.appliedProfiles],
			});
			for (const args of invalidCommands) {
				const before = await snapshot();
				const rejected = await runPpdInProcess(
					activeHarness,
					settingsFile.path,
					args,
				);
				expect(rejected.status).toBe(1, args.join(" "));
				expect(await snapshot()).toEqual(before);
			}

			const remap = await runPpdInProcess(activeHarness, settingsFile.path, [
				"configure",
				"--power-saver",
				PROFILE_IDS.alternate,
				"--ac",
				"power-saver",
				"--battery",
				"balanced",
			]);
			expect(remap.status).toBe(0, remap.stderr);
			const remappedSettings = await settingsFile.read();
			expect(remappedSettings.ppd?.profiles?.["power-saver"]).toBe(
				PROFILE_IDS.alternate,
			);
			expect(remappedSettings.stateMap.power_ac).toBe(PROFILE_IDS.alternate);
			expect(remappedSettings.stateMap.power_bat).toBe(PROFILE_IDS.balanced);
			expect(await getActive(provider.properties)).toBe("power-saver");
			expect(activeHarness.appliedProfiles.at(-1)).toBe(PROFILE_IDS.alternate);

			const beforeDisable = await settingsFile.read();
			const disable = await runPpdInProcess(activeHarness, settingsFile.path, [
				"disable",
			]);
			expect(disable.status).toBe(0, disable.stderr);
			const disabledSettings = await settingsFile.read();
			expect(disabledSettings.ppd?.enabled).toBeFalse();
			expect(disabledSettings.ppd?.profiles).toEqual(
				beforeDisable.ppd?.profiles,
			);
			expect(disabledSettings.stateMap).toEqual(beforeDisable.stateMap);
			expect(disabledSettings.fahrenheit).toBeTrue();
			expect(activeHarness.selector.settings).toEqual(disabledSettings);
			expect(activeHarness.selector.profiles).toEqual(profilesBefore);
			expect(activeHarness.configurationReplacements).toEqual([]);
			expect(
				await getPowerProfilesNameOwner(activeHarness.bus),
			).toBeUndefined();

			const finalStatus = await runTccCli(["ppd", "status"]);
			expect(finalStatus.status).toBe(0, finalStatus.stderr);
			expect(finalStatus.stdout).toContain("Enabled: no");
			expect(finalStatus.stdout).toContain("Provider: inactive");
		} finally {
			try {
				await closeHarness(harness);
			} finally {
				await settingsFile.close();
			}
		}
	});

	it("does not persist a mapping change rejected by a retained temporary selection", async () => {
		const initialSettings = testSettings();
		const busAddress = privateSessionBusAddress();
		const settingsFile = await createTemporarySettingsFile(initialSettings);
		let harness: PowerProfilesIntegrationHarness | undefined;
		try {
			const activeHarness = await createPowerProfilesHarness({
				claimTccName: true,
				initialSettings,
				busAddress,
			});
			harness = activeHarness;
			await activeHarness.selector.selectTccProfile(
				PROFILE_IDS.performance,
				"temporary",
			);
			const before = {
				disk: await readFile(settingsFile.path, "utf8"),
				settings: activeHarness.selector.settings,
				activeProfile: activeHarness.selector.activeProfile,
				mappings: activeHarness.selector.mappings,
				profiles: activeHarness.selector.profiles,
				appliedProfiles: [...activeHarness.appliedProfiles],
			};

			const rejected = await runPpdInProcess(activeHarness, settingsFile.path, [
				"configure",
				"--performance",
				"none",
			]);
			expect(rejected.status).toBe(1);
			expect(rejected.stdout).toBe("");
			expect(rejected.stderr.toLowerCase()).not.toContain("saved");
			expect({
				disk: await readFile(settingsFile.path, "utf8"),
				settings: activeHarness.selector.settings,
				activeProfile: activeHarness.selector.activeProfile,
				mappings: activeHarness.selector.mappings,
				profiles: activeHarness.selector.profiles,
				appliedProfiles: [...activeHarness.appliedProfiles],
			}).toEqual(before);
			expect(await getPowerProfilesNameOwner(activeHarness.bus)).toBe(
				uniqueName(activeHarness.bus),
			);
		} finally {
			try {
				await closeHarness(harness);
			} finally {
				await settingsFile.close();
			}
		}
	});

	it("keeps a competing provider owner and requires an explicit retry after it releases the name", async () => {
		const initialSettings = testSettings();
		const busAddress = privateSessionBusAddress();
		initialSettings.ppd!.enabled = false;
		const settingsFile = await createTemporarySettingsFile(initialSettings);
		let harness: PowerProfilesIntegrationHarness | undefined;
		let foreignOwner: dbus.MessageBus | undefined;
		try {
			const activeHarness = await createPowerProfilesHarness({
				claimTccName: true,
				busAddress,
				initialSettings,
			});
			harness = activeHarness;
			foreignOwner = await activeHarness.openClient();
			expect(
				await foreignOwner.requestName(
					POWER_PROFILES_NAME,
					dbus.NameFlag.DO_NOT_QUEUE,
				),
			).toBe(dbus.RequestNameReply.PRIMARY_OWNER);
			const foreignUniqueName = uniqueName(foreignOwner);

			const enable = await runPpdInProcess(activeHarness, settingsFile.path, [
				"enable",
				"--power-saver",
				PROFILE_IDS["power-saver"],
				"--balanced",
				PROFILE_IDS.balanced,
				"--performance",
				PROFILE_IDS.performance,
				"--ac",
				"balanced",
				"--battery",
				"power-saver",
			]);
			expect(enable.status).toBe(1);
			expect(enable.stderr).toContain("remain saved");
			expect(enable.stderr).toContain("other-provider");
			expect((await settingsFile.read()).ppd?.enabled).toBeTrue();
			expect(await getPowerProfilesNameOwner(activeHarness.bus)).toBe(
				foreignUniqueName,
			);

			const configure = await runPpdInProcess(
				activeHarness,
				settingsFile.path,
				["configure", "--performance", "none"],
			);
			expect(configure.status).toBe(1);
			expect(configure.stderr).toContain("remain saved");
			expect(configure.stderr).toContain("other-provider");
			expect((await settingsFile.read()).ppd?.profiles?.performance).toBeNull();
			expect(await getPowerProfilesNameOwner(activeHarness.bus)).toBe(
				foreignUniqueName,
			);

			const foreignStatus = await runPpdInProcess(
				activeHarness,
				settingsFile.path,
				["status"],
			);
			expect(foreignStatus.status).toBe(0, foreignStatus.stderr);
			expect(foreignStatus.stdout).toContain("Provider: other-provider");
			expect(foreignStatus.stdout).not.toContain("Provider: active");
			expect(await getPowerProfilesNameOwner(activeHarness.bus)).toBe(
				foreignUniqueName,
			);

			await foreignOwner.releaseName(POWER_PROFILES_NAME);
			expect(
				await getPowerProfilesNameOwner(activeHarness.bus),
			).toBeUndefined();
			const afterReleaseStatus = await runPpdInProcess(
				activeHarness,
				settingsFile.path,
				["status"],
			);
			expect(afterReleaseStatus.status).toBe(0, afterReleaseStatus.stderr);
			expect(afterReleaseStatus.stdout).toContain("Provider: inactive");
			expect(
				await getPowerProfilesNameOwner(activeHarness.bus),
			).toBeUndefined();

			const retry = await runPpdInProcess(activeHarness, settingsFile.path, [
				"enable",
			]);
			expect(retry.status).toBe(0, retry.stderr);
			expect(await getPowerProfilesNameOwner(activeHarness.bus)).toBe(
				uniqueName(activeHarness.bus),
			);
			expect((await settingsFile.read()).ppd?.enabled).toBeTrue();
		} finally {
			try {
				if (foreignOwner !== undefined) {
					foreignOwner.disconnect();
					harness?.clients.delete(foreignOwner);
				}
			} finally {
				try {
					await closeHarness(harness);
				} finally {
					await settingsFile.close();
				}
			}
		}
	});
});

async function waitForAppliedProfile(
	applied: string[],
	id: string,
	timeoutMs = 2500,
): Promise<void> {
	const expires = Date.now() + timeoutMs;
	while (!applied.includes(id) && Date.now() < expires) {
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	if (!applied.includes(id)) {
		throw new Error(`Profile '${id}' was not submitted to the backend`);
	}
}
