/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 *
 * TUXEDO Control Center is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TUXEDO Control Center is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with TUXEDO Control Center.  If not, see <https://www.gnu.org/licenses/>.
 */

import "jasmine";
import * as dbus from "dbus-next";
import type { ITccSettings } from "../../common/models/TccSettings";
import type {
	PowerProfilesAuthorizer,
	PowerProfilesBackend,
	PowerProfilesBus,
	PowerProfilesSelector,
} from "./PowerProfilesService";
import {
	POWER_PROFILE_CONFIGURE_ACTION,
	POWER_PROFILE_HOLD_ACTION,
	POWER_PROFILE_SWITCH_ACTION,
	POWER_PROFILES_INTERFACE,
	POWER_PROFILES_NAME,
	POWER_PROFILES_PATH,
	PowerProfilesService,
	TCC_INTERFACE,
	TCC_NAME,
	TCC_PATH,
	TCC_PROFILE_SWITCH_ACTION,
} from "./PowerProfilesService";
import { DBusAuthorizationError } from "./DBusAuthorization";

interface TestHold {
	owner: string;
	profile: "power-saver" | "performance";
	reason: string;
	applicationId: string;
	cookie: number;
}

class FakeBus implements PowerProfilesBus {
	public readonly name = ":1.1";
	public readonly sent: dbus.Message[] = [];
	public readonly methodHandlers: Array<(message: dbus.Message) => boolean> =
		[];
	public providerNameOwner?: string;
	public requestNameResult = dbus.RequestNameReply.PRIMARY_OWNER;
	public connectionUid = 1000;
	public providerRequestFlags?: number;
	public requestNameCalls = 0;
	private nextSerial = 1;
	private readonly messageListeners = new Set<
		(message: dbus.Message) => void
	>();
	private readonly errorListeners = new Set<(error: unknown) => void>();
	private readonly replyWaiters = new Map<
		number,
		(message: dbus.Message) => void
	>();
	private readonly repliesBySerial = new Map<number, dbus.Message>();
	public exportedPath?: string;
	public exportedInterface?: dbus.interface.Interface;

	public async call(message: dbus.Message): Promise<dbus.Message | null> {
		switch (message.member) {
			case "AddMatch":
			case "RemoveMatch":
				return this.methodReturn(message, "", []);
			case "GetNameOwner": {
				const [name] = message.body as string[];
				if (name === POWER_PROFILES_NAME) {
					return this.methodReturn("s", [this.providerNameOwner ?? this.name]);
				}
				if (name === TCC_NAME) {
					return this.methodReturn("s", [this.name]);
				}
				if (name.startsWith(":")) {
					return this.methodReturn("s", [name]);
				}
				return new dbus.Message({
					type: dbus.MessageType.ERROR,
					replySerial: "1",
					errorName: "org.freedesktop.DBus.Error.NameHasNoOwner",
					signature: "s",
					body: ["Name has no owner"],
				});
			}
			case "GetConnectionUnixUser":
				return this.methodReturn("u", [this.connectionUid]);
			default:
				throw new Error(`Unexpected bus daemon call '${message.member}'`);
		}
	}

	public async requestName(_name: string, flags: number): Promise<number> {
		this.requestNameCalls++;
		this.providerRequestFlags = flags;
		if (this.requestNameResult === dbus.RequestNameReply.PRIMARY_OWNER) {
			this.providerNameOwner = this.name;
			const acquired = dbus.Message.newSignal(
				"/org/freedesktop/DBus",
				"org.freedesktop.DBus",
				"NameOwnerChanged",
				"sss",
				[POWER_PROFILES_NAME, "", this.name],
			);
			acquired.sender = "org.freedesktop.DBus";
			this.emitIncomingSignal(acquired);
			if (this.exportedInterface === undefined) {
				throw new Error("NameOwnerChanged did not export the provider");
			}
		}
		return this.requestNameResult;
	}

	public async releaseName(_name: string): Promise<number> {
		return 1;
	}

	public export(path: string, iface: dbus.interface.Interface): void {
		this.exportedPath = path;
		this.exportedInterface = iface;
	}

	public unexport(path: string, iface: dbus.interface.Interface): void {
		if (path === this.exportedPath && iface === this.exportedInterface) {
			this.exportedPath = undefined;
			this.exportedInterface = undefined;
		}
	}

	public send(message: dbus.Message): void {
		this.sent.push(message);
		if (
			(message.type === dbus.MessageType.METHOD_RETURN ||
				message.type === dbus.MessageType.ERROR) &&
			message.replySerial !== undefined
		) {
			const serial = Number(message.replySerial);
			this.repliesBySerial.set(serial, message);
			this.replyWaiters.get(serial)?.(message);
			this.replyWaiters.delete(serial);
		}
	}

	public addMethodHandler(handler: (message: dbus.Message) => boolean): void {
		this.methodHandlers.push(handler);
	}

	public removeMethodHandler(
		handler: (message: dbus.Message) => boolean,
	): void {
		const index = this.methodHandlers.indexOf(handler);
		if (index >= 0) {
			this.methodHandlers.splice(index, 1);
		}
	}

	public on(event: "message", listener: (message: dbus.Message) => void): this;
	public on(event: "error", listener: (error: unknown) => void): this;
	public on(
		event: "message" | "error",
		listener: ((message: dbus.Message) => void) | ((error: unknown) => void),
	): this {
		if (event === "message") {
			this.messageListeners.add(listener as (message: dbus.Message) => void);
		} else {
			this.errorListeners.add(listener as (error: unknown) => void);
		}
		return this;
	}

	public removeListener(
		event: "message",
		listener: (message: dbus.Message) => void,
	): this;
	public removeListener(
		event: "error",
		listener: (error: unknown) => void,
	): this;
	public removeListener(
		event: "message" | "error",
		listener: ((message: dbus.Message) => void) | ((error: unknown) => void),
	): this {
		if (event === "message") {
			this.messageListeners.delete(listener as (message: dbus.Message) => void);
		} else {
			this.errorListeners.delete(listener as (error: unknown) => void);
		}
		return this;
	}

	public incoming(message: dbus.Message): boolean {
		for (const handler of this.methodHandlers) {
			if (handler(message)) {
				return true;
			}
		}
		return false;
	}

	public emitIncomingSignal(message: dbus.Message): void {
		for (const listener of this.messageListeners) {
			listener(message);
		}
	}

	public waitForReply(serial: number): Promise<dbus.Message> {
		const existing = this.repliesBySerial.get(serial);
		if (existing !== undefined) {
			return Promise.resolve(existing);
		}
		const { promise, resolve } = Promise.withResolvers<dbus.Message>();
		this.replyWaiters.set(serial, resolve);
		return promise;
	}

	public makeRequest(options: {
		destination: string;
		path: string;
		interface: string;
		member: string;
		signature?: string;
		body?: unknown[];
		sender?: string;
		flags?: number;
	}): dbus.Message {
		return new dbus.Message({
			...options,
			type: dbus.MessageType.METHOD_CALL,
			serial: this.nextSerial++,
			sender: options.sender ?? ":1.5",
			signature: options.signature ?? "",
			body: options.body ?? [],
		});
	}

	private methodReturn(
		request: dbus.Message,
		signature: string,
		body: unknown[],
	): dbus.Message;
	private methodReturn(signature: string, body: unknown[]): dbus.Message;
	private methodReturn(
		requestOrSignature: dbus.Message | string,
		signatureOrBody: string | unknown[],
		maybeBody?: unknown[],
	): dbus.Message {
		const request =
			requestOrSignature instanceof dbus.Message
				? requestOrSignature
				: undefined;
		const signature =
			typeof requestOrSignature === "string"
				? requestOrSignature
				: (signatureOrBody as string);
		const body = Array.isArray(signatureOrBody)
			? signatureOrBody
			: (maybeBody ?? []);
		return new dbus.Message({
			type: dbus.MessageType.METHOD_RETURN,
			replySerial: String(request?.serial ?? 1),
			signature,
			body,
		});
	}
}

interface Harness {
	bus: FakeBus;
	service: PowerProfilesService;
	selector: PowerProfilesSelector;
	authorizationCalls: Array<{ sender: string; action: string }>;
	selected: Array<{ id: string; persistence: string }>;
	namedSelections: Array<{ name: string; persistence: string }>;
	configurationWrites: Array<{ settingsJSON: string; profilesJSON: string }>;
	holds: TestHold[];
	setAuthorized(authorized: boolean): void;
	setAuthorizationGate(gate: Promise<void> | undefined): void;
	setCancelNextHold(): void;
}

async function makeHarness(
	enabled = true,
	requestNameResult = dbus.RequestNameReply.PRIMARY_OWNER,
): Promise<Harness> {
	const bus = new FakeBus();
	bus.requestNameResult = requestNameResult;
	if (requestNameResult !== dbus.RequestNameReply.PRIMARY_OWNER) {
		bus.providerNameOwner = ":9.9";
	}
	const selected: Array<{ id: string; persistence: string }> = [];
	const namedSelections: Array<{ name: string; persistence: string }> = [];
	const configurationWrites: Array<{
		settingsJSON: string;
		profilesJSON: string;
	}> = [];
	const holds: TestHold[] = [];
	const authorizationCalls: Array<{ sender: string; action: string }> = [];
	let authorized = true;
	let authorizationGate: Promise<void> | undefined;
	let active: "power-saver" | "balanced" | "performance" = "balanced";
	let nextCookie = 1;
	let cancelNextHold = false;
	let service: PowerProfilesService | undefined;
	const mappings = {
		"power-saver": "tcc-saver",
		balanced: "tcc-balanced",
		performance: "tcc-performance",
	} as const;
	const settings = {
		ppd: { enabled },
		stateMap: { power_ac: "tcc-balanced", power_bat: "tcc-saver" },
	} as unknown as ITccSettings;
	const selector: PowerProfilesSelector = {
		available: true,
		settings,
		mappings,
		get activeStandardProfile() {
			return active;
		},
		get activeProfileHolds() {
			return holds.map((hold) => ({
				applicationId: hold.applicationId,
				profile: hold.profile,
				reason: hold.reason,
			}));
		},
		async selectTccProfile(id, persistence) {
			selected.push({ id, persistence });
			for (const hold of [...holds]) {
				service?.emitProfileReleased(hold.owner, hold.cookie);
			}
			holds.length = 0;
			active = Object.entries(mappings).find(
				([, mappedId]) => mappedId === id,
			)?.[0] as "power-saver" | "balanced" | "performance";
		},
		async holdProfile(owner, profile, reason, applicationId) {
			if (profile !== "power-saver" && profile !== "performance") {
				throw new Error("Unsupported hold profile");
			}
			const cookie = nextCookie++;
			holds.push({ owner, profile, reason, applicationId, cookie });
			if (cancelNextHold) {
				cancelNextHold = false;
				holds.splice(
					holds.findIndex((hold) => hold.cookie === cookie),
					1,
				);
				service?.emitProfileReleased(owner, cookie);
			}
			active = holds.some((hold) => hold.profile === "power-saver")
				? "power-saver"
				: holds.some((hold) => hold.profile === "performance")
					? "performance"
					: "balanced";
			return cookie;
		},
		async releaseProfile(owner, cookie) {
			const index = holds.findIndex((hold) => hold.cookie === cookie);
			if (index < 0 || holds[index].owner !== owner) {
				throw new Error("Unknown profile hold");
			}
			const [released] = holds.splice(index, 1);
			service?.emitProfileReleased(released.owner, released.cookie);
			active = holds.some((hold) => hold.profile === "power-saver")
				? "power-saver"
				: holds.some((hold) => hold.profile === "performance")
					? "performance"
					: "balanced";
		},
		async disconnect(owner) {
			for (const hold of [...holds]) {
				if (hold.owner === owner) {
					holds.splice(holds.indexOf(hold), 1);
					service?.emitProfileReleased(owner, hold.cookie);
				}
			}
			active = holds.some((hold) => hold.profile === "power-saver")
				? "power-saver"
				: holds.some((hold) => hold.profile === "performance")
					? "performance"
					: "balanced";
		},
	};
	const authorization: PowerProfilesAuthorizer = {
		async check(sender, action, signal) {
			authorizationCalls.push({ sender, action });
			if (authorizationGate !== undefined) {
				await authorizationGate;
			}
			if (signal?.aborted || !authorized) {
				throw new DBusAuthorizationError("access-denied", "Denied in test");
			}
		},
	};
	const backend: PowerProfilesBackend = {
		async selectTccProfileByName(name, persistence) {
			namedSelections.push({ name, persistence });
		},
		async replaceProfileConfiguration(settingsJSON, profilesJSON) {
			configurationWrites.push({ settingsJSON, profilesJSON });
			return true;
		},
	};
	service = new PowerProfilesService({
		bus,
		selector,
		authorization,
		backend,
		packageVersion: "3.0.10",
		log: () => undefined,
	});
	await service.start();
	return {
		bus,
		service,
		selector,
		authorizationCalls,
		selected,
		namedSelections,
		configurationWrites,
		holds,
		setAuthorized(value) {
			authorized = value;
		},
		setAuthorizationGate(gate) {
			authorizationGate = gate;
		},
		setCancelNextHold() {
			cancelNextHold = true;
		},
	};
}

async function invoke(
	bus: FakeBus,
	message: dbus.Message,
): Promise<dbus.Message> {
	const serial = message.serial;
	if (serial === null) {
		throw new Error("Test request needs a serial");
	}
	const response = bus.waitForReply(serial);
	if (!bus.incoming(message)) {
		throw new Error(
			`No raw handler consumed ${message.interface}.${message.member}`,
		);
	}
	return response;
}

async function expectError(
	bus: FakeBus,
	message: dbus.Message,
	name: string,
): Promise<dbus.Message> {
	const response = await invoke(bus, message);
	expect(response.type).toBe(dbus.MessageType.ERROR);
	expect(response.errorName).toBe(name);
	expect(
		Buffer.byteLength(String(response.body[0] ?? ""), "utf8"),
	).toBeLessThanOrEqual(512);
	expect(String(response.body[0] ?? "")).not.toContain("Error:");
	return response;
}

describe("PowerProfilesService", () => {
	it("declares the modern interface and returns correctly typed properties", async () => {
		const harness = await makeHarness();
		const iface = harness.bus.exportedInterface as unknown as {
			$name: string;
			$properties: Record<string, { signature: string; access: string }>;
			$methods: Record<string, { inSignature: string; outSignature: string }>;
			$signals: Record<string, { signature: string }>;
			$introspect(): {
				property?: Array<{ $: { name: string; type: string; access: string } }>;
				method?: Array<{
					$: { name: string };
					arg: Array<{ $: { direction: string; type: string } }>;
				}>;
				signal?: Array<{
					$: { name: string };
					arg: Array<{ $: { type: string } }>;
				}>;
			};
		};
		expect(harness.bus.exportedPath).toBe(POWER_PROFILES_PATH);
		expect(iface.$name).toBe(POWER_PROFILES_INTERFACE);
		expect(Object.keys(iface.$properties)).toEqual([
			"Profiles",
			"ActiveProfile",
			"PerformanceInhibited",
			"PerformanceDegraded",
			"ActiveProfileHolds",
			"Actions",
			"ActionsInfo",
			"Version",
		]);
		expect(iface.$properties.Profiles.signature).toBe("aa{sv}");
		expect(iface.$properties.ActiveProfile.signature).toBe("s");
		expect(iface.$properties.ActiveProfile.access).toBe("readwrite");
		expect(iface.$properties.BatteryAware).toBeUndefined();
		expect(iface.$methods.HoldProfile.inSignature).toBe("sss");
		expect(iface.$methods.HoldProfile.outSignature).toBe("u");
		expect(iface.$methods.ReleaseProfile.inSignature).toBe("u");
		expect(iface.$methods.SetActionEnabled.inSignature).toBe("sb");
		expect(iface.$signals.ProfileReleased.signature).toBe("u");
		const introspection = iface.$introspect();
		expect(introspection.property?.map((property) => property.$)).toEqual([
			{ name: "Profiles", type: "aa{sv}", access: "read" },
			{ name: "ActiveProfile", type: "s", access: "readwrite" },
			{ name: "PerformanceInhibited", type: "s", access: "read" },
			{ name: "PerformanceDegraded", type: "s", access: "read" },
			{ name: "ActiveProfileHolds", type: "aa{sv}", access: "read" },
			{ name: "Actions", type: "as", access: "read" },
			{ name: "ActionsInfo", type: "aa{sv}", access: "read" },
			{ name: "Version", type: "s", access: "read" },
		]);
		expect(introspection.method?.map((method) => method.$.name)).toEqual([
			"HoldProfile",
			"ReleaseProfile",
			"SetActionEnabled",
		]);
		expect(introspection.signal).toEqual([
			{ $: { name: "ProfileReleased" }, arg: [{ $: { type: "u" } }] },
		]);
		expect(harness.bus.providerRequestFlags).toBe(dbus.NameFlag.DO_NOT_QUEUE);

		const response = await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "GetAll",
				signature: "s",
				body: [POWER_PROFILES_INTERFACE],
			}),
		);
		expect(response.type).toBe(dbus.MessageType.METHOD_RETURN);
		expect(response.signature).toBe("a{sv}");
		const properties = response.body[0] as Record<string, dbus.Variant>;
		expect(Object.keys(properties)).toEqual(Object.keys(iface.$properties));
		expect(properties.ActiveProfile.signature).toBe("s");
		expect(properties.ActiveProfile.value).toBe("balanced");
		expect(properties.Profiles.signature).toBe("aa{sv}");
		expect(properties.Profiles.value).toEqual([
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
		expect(properties.PerformanceInhibited.value).toBe("");
		expect(properties.PerformanceDegraded.value).toBe("");
		expect(properties.ActiveProfileHolds.signature).toBe("aa{sv}");
		expect(properties.Actions.value).toEqual([]);
		expect(properties.ActionsInfo.value).toEqual([]);
		expect(properties.Version.value).toBe("tcc-3.0.10");
		await harness.service.stop();
	});

	it("authorizes ActiveProfile changes and emits a typed coherent snapshot", async () => {
		const harness = await makeHarness();
		const response = await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "Set",
				signature: "ssv",
				body: [
					POWER_PROFILES_INTERFACE,
					"ActiveProfile",
					new dbus.Variant("s", "power-saver"),
				],
			}),
		);
		expect(response.type).toBe(dbus.MessageType.METHOD_RETURN);
		expect(response.signature).toBe("");
		expect(harness.selected).toEqual([
			{ id: "tcc-saver", persistence: "current-power-state" },
		]);
		expect(harness.authorizationCalls).toEqual([
			{ sender: ":1.5", action: POWER_PROFILE_SWITCH_ACTION },
		]);
		const changed = harness.bus.sent.find(
			(message) => message.member === "PropertiesChanged",
		);
		expect(changed?.signature).toBe("sa{sv}as");
		const changedProperties = changed?.body[1] as Record<string, dbus.Variant>;
		expect(changed?.body[0]).toBe(POWER_PROFILES_INTERFACE);
		expect(changedProperties.ActiveProfile.signature).toBe("s");
		expect(changedProperties.ActiveProfile.value).toBe("power-saver");
		expect(changedProperties.Profiles.signature).toBe("aa{sv}");
		expect(changedProperties.Actions.signature).toBe("as");
		expect(changed?.body[2]).toEqual([]);
		await harness.service.stop();
	});

	it("keeps hold metadata private and targets ProfileReleased to its owner", async () => {
		const harness = await makeHarness();
		const holdReply = await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["performance", "compile", "org.example.Editor"],
				sender: ":1.5",
			}),
		);
		expect(holdReply.type).toBe(dbus.MessageType.METHOD_RETURN);
		expect(holdReply.signature).toBe("u");
		const cookie = holdReply.body[0] as number;
		expect(cookie).toBe(1);
		expect(harness.authorizationCalls[0]).toEqual({
			sender: ":1.5",
			action: POWER_PROFILE_HOLD_ACTION,
		});

		const wrongOwner = await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "ReleaseProfile",
				signature: "u",
				body: [cookie],
				sender: ":1.8",
			}),
			"org.freedesktop.DBus.Error.AccessDenied",
		);
		expect(wrongOwner.body[0]).not.toContain("stack");
		expect(harness.holds.length).toBe(1);
		const checksBeforeRelease = harness.authorizationCalls.length;
		const release = await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "ReleaseProfile",
				signature: "u",
				body: [cookie],
				sender: ":1.5",
			}),
		);
		expect(release.type).toBe(dbus.MessageType.METHOD_RETURN);
		expect(release.signature).toBe("");
		expect(harness.authorizationCalls.length).toBe(checksBeforeRelease);
		expect(harness.holds).toEqual([]);
		const released = harness.bus.sent.find(
			(message) => message.member === "ProfileReleased",
		);
		expect(released?.destination).toBe(":1.5");
		expect(released?.signature).toBe("u");
		expect(released?.body).toEqual([cookie]);
		await harness.service.stop();
	});

	it("does not publish a hold canceled before its cookie is returned", async () => {
		const harness = await makeHarness();
		harness.setCancelNextHold();
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["performance", "test", "org.example.Test"],
			}),
			"org.freedesktop.DBus.Error.Failed",
		);
		expect(harness.holds).toEqual([]);
		expect(
			harness.bus.sent.some((message) => message.member === "ProfileReleased"),
		).toBeFalse();
		await harness.service.stop();
	});

	it("limits pending authorizations per sender", async () => {
		const harness = await makeHarness();
		const gate = Promise.withResolvers<void>();
		harness.setAuthorizationGate(gate.promise);
		const pendingReplies: Array<Promise<dbus.Message>> = [];
		for (let index = 0; index < 8; index++) {
			const request = harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "test", "org.example.Test"],
				sender: ":1.5",
			});
			pendingReplies.push(harness.bus.waitForReply(Number(request.serial)));
			expect(harness.bus.incoming(request)).toBeTrue();
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(harness.authorizationCalls.length).toBe(8);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "test", "org.example.Test"],
				sender: ":1.5",
			}),
			"org.freedesktop.DBus.Error.LimitsExceeded",
		);
		gate.resolve();
		const replies = await Promise.all(pendingReplies);
		expect(
			replies.every((reply) => reply.type === dbus.MessageType.METHOD_RETURN),
		).toBeTrue();
		await harness.service.stop();
	});

	it("limits live holds per sender and across the provider", async () => {
		const harness = await makeHarness();
		for (let ownerIndex = 1; ownerIndex <= 8; ownerIndex++) {
			const sender = `:2.${ownerIndex}`;
			for (let holdIndex = 0; holdIndex < 32; holdIndex++) {
				const reply = await invoke(
					harness.bus,
					harness.bus.makeRequest({
						destination: POWER_PROFILES_NAME,
						path: POWER_PROFILES_PATH,
						interface: POWER_PROFILES_INTERFACE,
						member: "HoldProfile",
						signature: "sss",
						body: ["power-saver", "", ""],
						sender,
					}),
				);
				expect(reply.type).toBe(dbus.MessageType.METHOD_RETURN);
			}
		}

		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "", ""],
				sender: ":2.1",
			}),
			"org.freedesktop.DBus.Error.LimitsExceeded",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "", ""],
				sender: ":2.9",
			}),
			"org.freedesktop.DBus.Error.LimitsExceeded",
		);
		expect(harness.holds.length).toBe(256);
		expect(harness.authorizationCalls.length).toBe(256);
		await harness.service.stop();
	});

	it("returns strict protocol errors for unsupported or malformed properties and holds", async () => {
		const harness = await makeHarness();
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "ReleaseProfile",
				signature: "u",
				body: [0],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "ReleaseProfile",
				signature: "u",
				body: [99],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "Get",
				signature: "ss",
				body: [POWER_PROFILES_INTERFACE, "BatteryAware"],
			}),
			"org.freedesktop.DBus.Error.UnknownProperty",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "Get",
				signature: "ss",
				body: [POWER_PROFILES_INTERFACE, "toString"],
			}),
			"org.freedesktop.DBus.Error.UnknownProperty",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "Set",
				signature: "ssv",
				body: [
					POWER_PROFILES_INTERFACE,
					"Profiles",
					new dbus.Variant("aa{sv}", []),
				],
			}),
			"org.freedesktop.DBus.Error.PropertyReadOnly",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "ss",
				body: ["power-saver", "missing-application-string"],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["balanced", "reason", "application"],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "r".repeat(4097), "application"],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "", "é".repeat(128)],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "Set",
				signature: "ssv",
				body: [
					POWER_PROFILES_INTERFACE,
					"ActiveProfile",
					new dbus.Variant("s", "turbo"),
				],
			}),
			"org.freedesktop.DBus.Error.Failed",
		);
		expect(harness.authorizationCalls).toEqual([]);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "NoSuchMethod",
			}),
			"org.freedesktop.DBus.Error.UnknownMethod",
		);
		await harness.service.stop();
	});

	it("does not apply a selection after Polkit denial and authorizes empty action discovery", async () => {
		const harness = await makeHarness();
		harness.setAuthorized(false);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "Set",
				signature: "ssv",
				body: [
					POWER_PROFILES_INTERFACE,
					"ActiveProfile",
					new dbus.Variant("s", "performance"),
				],
			}),
			"org.freedesktop.DBus.Error.AccessDenied",
		);
		expect(harness.selected).toEqual([]);

		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "SetActionEnabled",
				signature: "sb",
				body: ["not-an-action", true],
			}),
			"org.freedesktop.DBus.Error.AccessDenied",
		);
		expect(harness.authorizationCalls[1].action).toBe(
			POWER_PROFILE_CONFIGURE_ACTION,
		);
		harness.setAuthorized(true);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "SetActionEnabled",
				signature: "sb",
				body: ["also-unknown", false],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		expect(harness.authorizationCalls[2].action).toBe(
			POWER_PROFILE_CONFIGURE_ACTION,
		);
		await harness.service.stop();
	});

	it("keeps TCC setters protected when PPD is disabled and rejects the hidden PPD object", async () => {
		const harness = await makeHarness(false);
		expect(harness.bus.requestNameCalls).toBe(0);
		expect(harness.bus.exportedInterface).toBeUndefined();
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: harness.bus.name,
				path: POWER_PROFILES_PATH,
				interface: "org.freedesktop.DBus.Properties",
				member: "GetAll",
				signature: "s",
				body: [POWER_PROFILES_INTERFACE],
			}),
			"org.freedesktop.DBus.Error.UnknownObject",
		);
		const response = await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: TCC_NAME,
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "SetTempProfileById",
				signature: "s",
				body: ["tcc-balanced"],
			}),
		);
		expect(response.type).toBe(dbus.MessageType.METHOD_RETURN);
		expect(response.signature).toBe("b");
		expect(response.body).toEqual([true]);
		expect(harness.authorizationCalls[0].action).toBe(
			TCC_PROFILE_SWITCH_ACTION,
		);
		expect(harness.selected).toEqual([
			{ id: "tcc-balanced", persistence: "temporary" },
		]);
		const namedResponse = await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: TCC_NAME,
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "SetTempProfile",
				signature: "s",
				body: ["Balanced"],
			}),
		);
		expect(namedResponse.signature).toBe("b");
		expect(namedResponse.body).toEqual([true]);
		expect(harness.namedSelections).toEqual([
			{ name: "Balanced", persistence: "temporary" },
		]);
		expect(harness.authorizationCalls[1].action).toBe(
			TCC_PROFILE_SWITCH_ACTION,
		);
		await harness.service.stop();
	});

	it("checks root by the bus daemon and forwards only bounded valid JSON", async () => {
		const harness = await makeHarness(false);
		const method = (): dbus.Message =>
			harness.bus.makeRequest({
				destination: TCC_NAME,
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "ReplaceProfileConfiguration",
				signature: "ss",
				body: ['{"ppd":{"enabled":false}}', ""],
			});
		await expectError(
			harness.bus,
			method(),
			"org.freedesktop.DBus.Error.AccessDenied",
		);
		expect(harness.configurationWrites).toEqual([]);

		harness.bus.connectionUid = 0;
		const accepted = await invoke(harness.bus, method());
		expect(accepted.type).toBe(dbus.MessageType.METHOD_RETURN);
		expect(accepted.signature).toBe("b");
		expect(accepted.body).toEqual([true]);
		expect(harness.configurationWrites).toEqual([
			{ settingsJSON: '{"ppd":{"enabled":false}}', profilesJSON: "" },
		]);

		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: TCC_NAME,
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "ReplaceProfileConfiguration",
				signature: "ss",
				body: ["{bad", ""],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: TCC_NAME,
				path: TCC_PATH,
				interface: TCC_INTERFACE,
				member: "ReplaceProfileConfiguration",
				signature: "ss",
				body: ["x".repeat(1024 * 1024 + 1), ""],
			}),
			"org.freedesktop.DBus.Error.InvalidArgs",
		);
		await harness.service.stop();
	});

	it("declines a competing provider without exporting or queueing", async () => {
		const harness = await makeHarness(true, dbus.RequestNameReply.EXISTS);
		expect(harness.bus.requestNameCalls).toBe(1);
		expect(harness.bus.providerRequestFlags).toBe(dbus.NameFlag.DO_NOT_QUEUE);
		expect(harness.bus.exportedInterface).toBeUndefined();
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: harness.bus.name,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "reason", "application"],
			}),
			"org.freedesktop.DBus.Error.UnknownObject",
		);
		await harness.service.stop();
	});

	it("withdraws the object and clears provider state after losing its name", async () => {
		const harness = await makeHarness();
		harness.bus.providerNameOwner = ":9.9";
		harness.bus.emitIncomingSignal(
			new dbus.Message({
				type: dbus.MessageType.SIGNAL,
				sender: "org.freedesktop.DBus",
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				signature: "sss",
				body: [POWER_PROFILES_NAME, harness.bus.name, ":9.9"],
			}),
		);
		expect(harness.bus.exportedInterface).toBeUndefined();
		expect(harness.service.providerIsOwned).toBeFalse();
		await expectError(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "test", "org.example.Test"],
			}),
			"org.freedesktop.DBus.Error.UnknownObject",
		);
		await harness.service.stop();
	});

	it("cleans a disconnected holder by unique bus name", async () => {
		const harness = await makeHarness();
		await invoke(
			harness.bus,
			harness.bus.makeRequest({
				destination: POWER_PROFILES_NAME,
				path: POWER_PROFILES_PATH,
				interface: POWER_PROFILES_INTERFACE,
				member: "HoldProfile",
				signature: "sss",
				body: ["power-saver", "test", "org.example.Test"],
				sender: ":1.5",
			}),
		);
		harness.bus.emitIncomingSignal(
			new dbus.Message({
				type: dbus.MessageType.SIGNAL,
				sender: "org.freedesktop.DBus",
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				signature: "sss",
				body: [":1.5", ":1.5", ""],
			}),
		);
		expect(harness.holds).toEqual([]);
		expect(
			harness.bus.sent.some(
				(message) =>
					message.member === "ProfileReleased" &&
					message.destination === ":1.5",
			),
		).toBeTrue();
		await harness.service.stop();
	});

	it("does not reply to NO_REPLY_EXPECTED calls", async () => {
		const harness = await makeHarness();
		const request = harness.bus.makeRequest({
			destination: POWER_PROFILES_NAME,
			path: POWER_PROFILES_PATH,
			interface: POWER_PROFILES_INTERFACE,
			member: "SetActionEnabled",
			signature: "sb",
			body: ["unknown", true],
			flags: 1,
		});
		expect(harness.bus.incoming(request)).toBeTrue();
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
		expect(
			harness.bus.sent.filter(
				(message) =>
					message.type === dbus.MessageType.METHOD_RETURN ||
					message.type === dbus.MessageType.ERROR,
			),
		).toEqual([]);
		await harness.service.stop();
	});
});
