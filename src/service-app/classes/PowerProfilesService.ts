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

import * as dbus from "dbus-next";
import type {
	ResolvedPowerProfiles,
	StandardProfile,
} from "../../common/models/PowerProfiles";
import type { ITccSettings } from "../../common/models/TccSettings";
import type {
	DBusAuthorization,
	DBusAuthorizationBus,
} from "./DBusAuthorization";
import type { ProfileSelectionPersistence } from "./ProfileSelection";

export const POWER_PROFILES_NAME = "org.freedesktop.UPower.PowerProfiles";
export const POWER_PROFILES_PATH = "/org/freedesktop/UPower/PowerProfiles";
export const POWER_PROFILES_INTERFACE = "org.freedesktop.UPower.PowerProfiles";
export const TCC_NAME = "com.tuxedocomputers.tccd";
export const TCC_PATH = "/com/tuxedocomputers/tccd";
export const TCC_INTERFACE = "com.tuxedocomputers.tccd";
export const POWER_PROFILE_SWITCH_ACTION =
	"org.freedesktop.UPower.PowerProfiles.switch-profile";
export const POWER_PROFILE_HOLD_ACTION =
	"org.freedesktop.UPower.PowerProfiles.hold-profile";
export const POWER_PROFILE_CONFIGURE_ACTION =
	"org.freedesktop.UPower.PowerProfiles.configure-action";
export const TCC_PROFILE_SWITCH_ACTION =
	"com.tuxedocomputers.tccd.switch-profile";

const DBUS_INTERFACE = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const NAME_OWNER_CHANGED_MATCH =
	"type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_HOLD_REASON_BYTES = 4096;
const MAX_APPLICATION_ID_BYTES = 255;
const MAX_HOLDS_PER_SENDER = 32;
const MAX_HOLDS_TOTAL = 256;
const MAX_PENDING_PER_SENDER = 8;
const MAX_PENDING_TOTAL = 128;
const MAX_SAFE_ERROR_BYTES = 512;
const NO_REPLY_EXPECTED = 1;
const PROFILE_ORDER: StandardProfile[] = [
	"power-saver",
	"balanced",
	"performance",
];
const PROPERTY_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
	Profiles: "aa{sv}",
	ActiveProfile: "s",
	PerformanceInhibited: "s",
	PerformanceDegraded: "s",
	ActiveProfileHolds: "aa{sv}",
	Actions: "as",
	ActionsInfo: "aa{sv}",
	Version: "s",
});

// dbus-next's declarations type this first argument as a string, but the runtime expects a Message.
const newErrorReply = dbus.Message.newError as unknown as (
	message: dbus.Message,
	errorName: string,
	errorText: string,
) => dbus.Message;

export interface PowerProfilesBus extends DBusAuthorizationBus {
	readonly name?: string | null;
	addMethodHandler(handler: (message: dbus.Message) => boolean): void;
	removeMethodHandler(handler: (message: dbus.Message) => boolean): void;
	requestName(name: string, flags: number): Promise<number>;
	releaseName(name: string): Promise<number>;
	export(path: string, iface: dbus.interface.Interface): void;
	unexport(path: string, iface: dbus.interface.Interface): void;
	send(message: dbus.Message): void;
	on(event: "message", listener: (message: dbus.Message) => void): this;
	on(event: "error", listener: (error: unknown) => void): this;
	removeListener(
		event: "message",
		listener: (message: dbus.Message) => void,
	): this;
	removeListener(event: "error", listener: (error: unknown) => void): this;
}

export interface PowerProfilesSelector {
	readonly available: boolean;
	readonly settings?: ITccSettings;
	readonly mappings: ResolvedPowerProfiles;
	readonly activeStandardProfile?: StandardProfile;
	readonly activeProfileHolds: Array<{
		applicationId: string;
		profile: "power-saver" | "performance";
		reason: string;
	}>;
	selectTccProfile(
		id: string,
		persistence: ProfileSelectionPersistence,
	): Promise<void>;
	holdProfile(
		owner: string,
		profile: string,
		reason: string,
		applicationId: string,
	): Promise<number>;
	releaseProfile(owner: string, cookie: number): Promise<void>;
	disconnect(owner: string): Promise<void>;
}

export interface PowerProfilesBackend {
	selectTccProfileByName(name: string, persistence: "temporary"): Promise<void>;
	replaceProfileConfiguration(
		settingsJSON: string,
		profilesJSON: string,
	): Promise<boolean>;
}

export interface PowerProfilesAuthorizer {
	check(sender: string, action: string, signal?: AbortSignal): Promise<void>;
}

export interface PowerProfilesServiceOptions {
	bus: PowerProfilesBus;
	selector: PowerProfilesSelector;
	authorization: PowerProfilesAuthorizer | DBusAuthorization;
	backend: PowerProfilesBackend;
	packageVersion: string;
	log?: (message: string) => void;
}

interface DbusReply {
	signature: string;
	body: unknown[];
}

interface PendingRequest {
	controller: AbortController;
}

class PowerProfilesMessageError extends Error {
	public constructor(
		public readonly nameOnBus: string,
		message: string,
	) {
		super(message);
		this.name = "PowerProfilesMessageError";
	}
}

export class PowerProfilesService {
	private readonly bus: PowerProfilesBus;
	private readonly selector: PowerProfilesSelector;
	private readonly authorization: PowerProfilesAuthorizer;
	private readonly backend: PowerProfilesBackend;
	private readonly version: string;
	private readonly log: (message: string) => void;
	private readonly interface: PowerProfilesInterface;
	private readonly holdOwners = new Map<number, string>();
	private readonly pendingHoldsByOwner = new Map<string, number>();
	private pendingHoldCount = 0;
	private readonly pendingByOwner = new Map<string, Set<PendingRequest>>();
	private pendingCount = 0;
	private readonly inFlight = new Set<Promise<void>>();
	private readonly messageHandler = (message: dbus.Message): boolean =>
		this.handleMessage(message);
	private readonly busMessageHandler = (message: dbus.Message): void =>
		this.handleBusMessage(message);
	private readonly busErrorHandler = (error: unknown): void =>
		this.handleBusError(error);
	private started = false;
	private stopping = false;
	private providerNameRequested = false;
	private providerOwned = false;
	private providerExported = false;
	private providerUniqueName?: string;
	private tccUniqueName?: string;
	private propertySignalQueued = false;
	private providerRefresh?: Promise<void>;
	private providerRefreshAgain = false;
	private readonly releasedBeforeRegistration = new Set<number>();

	public constructor(options: PowerProfilesServiceOptions) {
		this.bus = options.bus;
		this.selector = options.selector;
		this.authorization = options.authorization;
		this.backend = options.backend;
		this.version = `tcc-${options.packageVersion}`;
		this.log =
			options.log ?? ((message: string): void => console.error(message));
		this.interface = new PowerProfilesInterface(this);
	}

	/** Installs authorization dispatch even when optional PPD mode is disabled. */
	public async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.started = true;
		this.stopping = false;
		this.bus.addMethodHandler(this.messageHandler);
		this.bus.on("message", this.busMessageHandler);
		this.bus.on("error", this.busErrorHandler);
		try {
			await this.callBusDaemon("AddMatch", "s", [NAME_OWNER_CHANGED_MATCH]);
			await this.rememberTccOwner();
			await this.refreshProvider();
		} catch (error) {
			this.bus.removeMethodHandler(this.messageHandler);
			this.bus.removeListener("message", this.busMessageHandler);
			this.bus.removeListener("error", this.busErrorHandler);
			this.started = false;
			throw error;
		}
	}

	public refreshProvider(): Promise<void> {
		if (!this.started || this.stopping) {
			return Promise.resolve();
		}
		if (this.providerRefresh !== undefined) {
			this.providerRefreshAgain = true;
			return this.providerRefresh;
		}

		const refresh = (async (): Promise<void> => {
			do {
				this.providerRefreshAgain = false;
				await this.refreshProviderOnce();
			} while (this.providerRefreshAgain && this.started && !this.stopping);
		})();
		this.providerRefresh = refresh;
		void refresh.then(
			() => this.finishProviderRefresh(refresh),
			() => this.finishProviderRefresh(refresh),
		);
		return refresh;
	}

	private finishProviderRefresh(refresh: Promise<void>): void {
		if (this.providerRefresh !== refresh) {
			return;
		}
		this.providerRefresh = undefined;
		if (this.providerRefreshAgain && this.started && !this.stopping) {
			this.providerRefreshAgain = false;
			void this.refreshProvider().catch((error: unknown) => {
				this.logOwnershipFailure(error);
			});
		}
	}

	private async refreshProviderOnce(): Promise<void> {
		if (!this.started || this.stopping) {
			return;
		}
		if (!this.providerConfigured()) {
			await this.withdrawProvider();
			return;
		}
		if (this.providerOwned) {
			return;
		}

		try {
			const uniqueName = this.bus.name;
			if (typeof uniqueName !== "string" || !isUniqueName(uniqueName)) {
				throw new Error("The bus connection has no authenticated unique name");
			}
			const requestResult = await this.bus.requestName(
				POWER_PROFILES_NAME,
				dbus.NameFlag.DO_NOT_QUEUE,
			);
			if (requestResult !== dbus.RequestNameReply.PRIMARY_OWNER) {
				await this.withdrawProvider();
				this.logOwnershipFailure(
					`RequestName returned ${requestResult}, not PRIMARY_OWNER`,
				);
				return;
			}

			this.providerNameRequested = true;
			if (this.stopping || !this.started) {
				await this.withdrawProvider();
				return;
			}
			if ((await this.getNameOwner(POWER_PROFILES_NAME)) !== uniqueName) {
				throw new Error("The provider name is not owned by this connection");
			}
			if (!this.providerOwned) {
				this.acceptProviderNameOwner(uniqueName);
			}
			if (
				!this.providerOwned ||
				!this.providerExported ||
				!this.providerConfigured()
			) {
				throw new Error("The provider object could not be made available");
			}
		} catch (error) {
			await this.withdrawProvider();
			this.logOwnershipFailure(error);
		}
	}

	/**
	 * Removes optional PPD ownership after active work finishes. Selector callbacks
	 * should target ProfileReleased through emitProfileReleased before shutdown.
	 */
	public async stop(): Promise<void> {
		if (!this.started) {
			return;
		}
		this.stopping = true;
		this.bus.removeMethodHandler(this.messageHandler);
		this.bus.removeListener("message", this.busMessageHandler);
		this.bus.removeListener("error", this.busErrorHandler);
		this.abortPendingMutations();
		const pending = [...this.inFlight];
		if (this.providerRefresh !== undefined) {
			pending.push(this.providerRefresh);
		}
		await Promise.allSettled(pending);
		for (const [cookie, owner] of this.holdOwners) {
			this.sendProfileReleasedSignal(owner, cookie);
		}
		this.holdOwners.clear();
		this.releasedBeforeRegistration.clear();
		await this.withdrawProvider();
		try {
			await this.callBusDaemon("RemoveMatch", "s", [NAME_OWNER_CHANGED_MATCH]);
		} catch {
			// The bus may already be disconnected during shutdown.
		}
		this.started = false;
	}

	/** Callback for ProfileSelection's notifyProfileReleased dependency. */
	public emitProfileReleased(owner: string, cookie: number): void {
		if (this.holdOwners.get(cookie) === owner) {
			this.holdOwners.delete(cookie);
			this.sendProfileReleasedSignal(owner, cookie);
		} else if (this.pendingHoldsByOwner.has(owner)) {
			this.releasedBeforeRegistration.add(cookie);
			this.notifyPropertiesChanged();
			return;
		} else {
			this.sendProfileReleasedSignal(owner, cookie);
		}
		this.notifyPropertiesChanged();
	}

	/** Callback for ProfileSelection's publishProfile dependency and accepted reloads. */
	public notifyPropertiesChanged(): void {
		if (this.propertySignalQueued || !this.providerAcceptingCalls()) {
			return;
		}
		this.propertySignalQueued = true;
		queueMicrotask(() => {
			this.propertySignalQueued = false;
			if (!this.providerAcceptingCalls()) {
				return;
			}
			const values = this.propertyValues();
			const changed: Record<string, dbus.Variant> = {};
			for (const [name, signature] of Object.entries(PROPERTY_SIGNATURES)) {
				changed[name] = new dbus.Variant(signature, values[name]);
			}
			try {
				this.bus.send(
					dbus.Message.newSignal(
						POWER_PROFILES_PATH,
						PROPERTIES_INTERFACE,
						"PropertiesChanged",
						"sa{sv}as",
						[POWER_PROFILES_INTERFACE, changed, []],
					),
				);
			} catch (error) {
				this.log(
					`PropertiesChanged signal could not be sent: ${safeError(error)}`,
				);
			}
		});
	}

	public get providerIsOwned(): boolean {
		return this.providerOwned && this.providerConfigured();
	}
	public get versionProperty(): string {
		return this.version;
	}

	public get profilesProperty(): Array<Record<string, dbus.Variant>> {
		const mappings = this.selector.mappings;
		return PROFILE_ORDER.filter(
			(profile) => mappings[profile] !== undefined,
		).map((profile) => ({
			Profile: new dbus.Variant("s", profile),
			Driver: new dbus.Variant("s", "tcc"),
		}));
	}

	public get activeProfileProperty(): string {
		const active = this.selector.activeStandardProfile;
		if (active === undefined || this.selector.mappings[active] === undefined) {
			throw new dbus.DBusError(
				"org.freedesktop.DBus.Error.Failed",
				"No committed power profile is available",
			);
		}
		return active;
	}

	public get activeProfileHoldsProperty(): Array<Record<string, dbus.Variant>> {
		return this.selector.activeProfileHolds.map((hold) => ({
			ApplicationId: new dbus.Variant("s", hold.applicationId),
			Profile: new dbus.Variant("s", hold.profile),
			Reason: new dbus.Variant("s", hold.reason),
		}));
	}

	public propertyValues(): Record<string, unknown> {
		return {
			Profiles: this.profilesProperty,
			ActiveProfile: this.activeProfileProperty,
			PerformanceInhibited: "",
			PerformanceDegraded: "",
			ActiveProfileHolds: this.activeProfileHoldsProperty,
			Actions: [],
			ActionsInfo: [],
			Version: this.version,
		};
	}

	private handleMessage(message: dbus.Message): boolean {
		if (message.type !== dbus.MessageType.METHOD_CALL) {
			return false;
		}
		if (this.targetsTcc(message) && this.isTccMutation(message)) {
			this.consume(message, () => this.dispatchTccMutation(message));
			return true;
		}
		if (this.targetsProvider(message)) {
			this.consume(message, () => this.dispatchProviderRequest(message));
			return true;
		}
		return false;
	}

	private consume(
		message: dbus.Message,
		operation: () => Promise<DbusReply>,
	): void {
		let replyAttempted = false;
		const request = operation()
			.then((reply) => {
				if (this.noReplyExpected(message)) {
					return;
				}
				replyAttempted = true;
				try {
					this.bus.send(
						dbus.Message.newMethodReturn(message, reply.signature, reply.body),
					);
				} catch {
					this.log("D-Bus method reply could not be sent");
				}
			})
			.catch((error: unknown) => {
				if (this.noReplyExpected(message) || replyAttempted) {
					return;
				}
				replyAttempted = true;
				const [name, text] = this.errorReply(error);
				try {
					this.bus.send(newErrorReply(message, name, text));
				} catch {
					this.log("D-Bus method error reply could not be sent");
				}
			})
			.finally(() => {
				this.inFlight.delete(request);
			});
		this.inFlight.add(request);
	}

	private async dispatchProviderRequest(
		message: dbus.Message,
	): Promise<DbusReply> {
		if (this.stopping && this.isProviderMutation(message)) {
			throw failed("The service is shutting down");
		}
		if (!this.providerAcceptingCalls()) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownObject",
				"The power profiles object is not available",
			);
		}
		await this.assertProviderNameOwner();
		if (message.interface === PROPERTIES_INTERFACE) {
			return this.dispatchProperties(message);
		}
		if (message.interface !== POWER_PROFILES_INTERFACE) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownMethod",
				`Method '${message.member}' does not exist on this object`,
			);
		}

		switch (message.member) {
			case "HoldProfile":
				return this.dispatchHold(message);
			case "ReleaseProfile":
				return this.dispatchRelease(message);
			case "SetActionEnabled":
				return this.dispatchSetActionEnabled(message);
			default:
				throw new PowerProfilesMessageError(
					"org.freedesktop.DBus.Error.UnknownMethod",
					`Method '${message.member}' is not supported`,
				);
		}
	}

	private dispatchProperties(message: dbus.Message): Promise<DbusReply> {
		switch (message.member) {
			case "Get": {
				this.requireSignature(message, "ss", 2);
				const [interfaceName, propertyName] = message.body as string[];
				if (
					typeof interfaceName !== "string" ||
					typeof propertyName !== "string"
				) {
					throw invalidArgs("Properties.Get expects two strings");
				}
				this.requirePowerProfilesInterface(interfaceName);
				const signature = Object.hasOwn(PROPERTY_SIGNATURES, propertyName)
					? PROPERTY_SIGNATURES[propertyName]
					: undefined;
				if (signature === undefined) {
					throw new PowerProfilesMessageError(
						"org.freedesktop.DBus.Error.UnknownProperty",
						`Property '${propertyName}' does not exist`,
					);
				}
				const value = this.getProperty(propertyName);
				return Promise.resolve({
					signature: "v",
					body: [new dbus.Variant(signature, value)],
				});
			}
			case "GetAll": {
				this.requireSignature(message, "s", 1);
				const [interfaceName] = message.body as string[];
				this.requirePowerProfilesInterface(interfaceName);
				const values = this.propertyValues();
				const result: Record<string, dbus.Variant> = {};
				for (const [name, signature] of Object.entries(PROPERTY_SIGNATURES)) {
					result[name] = new dbus.Variant(signature, values[name]);
				}
				return Promise.resolve({ signature: "a{sv}", body: [result] });
			}
			case "Set":
				return this.dispatchPropertySet(message);
			default:
				throw new PowerProfilesMessageError(
					"org.freedesktop.DBus.Error.UnknownMethod",
					`Properties method '${message.member}' is not supported`,
				);
		}
	}

	private async dispatchPropertySet(message: dbus.Message): Promise<DbusReply> {
		this.requireSignature(message, "ssv", 3);
		const [interfaceName, propertyName, variant] = message.body as [
			string,
			string,
			dbus.Variant,
		];
		this.requirePowerProfilesInterface(interfaceName);
		const signature = Object.hasOwn(PROPERTY_SIGNATURES, propertyName)
			? PROPERTY_SIGNATURES[propertyName]
			: undefined;
		if (signature === undefined) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownProperty",
				`Property '${propertyName}' does not exist`,
			);
		}
		if (propertyName !== "ActiveProfile") {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.PropertyReadOnly",
				`Property '${propertyName}' is read-only`,
			);
		}
		if (
			!isVariant(variant) ||
			variant.signature !== signature ||
			typeof variant.value !== "string"
		) {
			throw invalidArgs("ActiveProfile must be a string variant");
		}
		const standard = requireStandardProfile(variant.value);
		if (this.selector.mappings[standard] === undefined) {
			throw failed(`Power profile '${standard}' is unavailable`);
		}
		const sender = this.requireSender(message);
		const previousProfile = this.selector.activeStandardProfile;
		await this.authorizedMutation(
			sender,
			POWER_PROFILE_SWITCH_ACTION,
			async () => {
				const currentMappedId = this.selector.mappings[standard];
				if (currentMappedId === undefined) {
					throw failed(`Power profile '${standard}' is unavailable`);
				}
				await this.selector.selectTccProfile(
					currentMappedId,
					"current-power-state",
				);
			},
		);
		if (previousProfile !== this.selector.activeStandardProfile) {
			this.notifyPropertiesChanged();
		}
		return { signature: "", body: [] };
	}

	private async dispatchHold(message: dbus.Message): Promise<DbusReply> {
		this.requireSignature(message, "sss", 3);
		const [profile, reason, applicationId] = message.body as string[];
		if (
			typeof profile !== "string" ||
			typeof reason !== "string" ||
			typeof applicationId !== "string"
		) {
			throw invalidArgs("HoldProfile expects three strings");
		}
		if (Buffer.byteLength(reason, "utf8") > MAX_HOLD_REASON_BYTES) {
			throw invalidArgs(
				`Hold reason exceeds ${MAX_HOLD_REASON_BYTES} UTF-8 bytes`,
			);
		}
		if (Buffer.byteLength(applicationId, "utf8") > MAX_APPLICATION_ID_BYTES) {
			throw invalidArgs(
				`Application ID exceeds ${MAX_APPLICATION_ID_BYTES} UTF-8 bytes`,
			);
		}
		if (profile !== "power-saver" && profile !== "performance") {
			throw invalidArgs(`Profile '${profile}' cannot be held`);
		}
		const sender = this.requireSender(message);
		this.reserveHoldSlot(sender);
		let cookie = 0;
		try {
			await this.authorizedMutation(
				sender,
				POWER_PROFILE_HOLD_ACTION,
				async () => {
					cookie = await this.selector.holdProfile(
						sender,
						profile,
						reason,
						applicationId,
					);
					try {
						await this.ensureSenderConnected(sender);
					} catch (error) {
						try {
							await this.selector.disconnect(sender);
						} catch {
							// Cleanup is best-effort after the holder disconnects.
						}
						throw error;
					}
				},
			);
			if (!this.providerOwned || !this.providerConfigured()) {
				try {
					await this.selector.disconnect(sender);
				} catch {
					// A withdrawn provider cannot publish this hold.
				}
				throw failed("The power profiles provider is no longer available");
			}
			if (this.releasedBeforeRegistration.delete(cookie)) {
				throw failed(
					"The profile hold was released before its cookie was returned",
				);
			}
			if (!Number.isInteger(cookie) || cookie < 1 || cookie > 0xffffffff) {
				throw failed("The profile selector returned an invalid hold cookie");
			}
			this.holdOwners.set(cookie, sender);
			this.notifyPropertiesChanged();
			return { signature: "u", body: [cookie] };
		} catch (error) {
			if (cookie !== 0) {
				this.releasedBeforeRegistration.delete(cookie);
			}
			throw error;
		} finally {
			this.releaseHoldSlot(sender);
		}
	}

	private async dispatchRelease(message: dbus.Message): Promise<DbusReply> {
		this.requireSignature(message, "u", 1);
		const [cookie] = message.body as number[];
		if (!Number.isInteger(cookie) || cookie < 1 || cookie > 0xffffffff) {
			throw invalidArgs("ReleaseProfile expects a nonzero uint32 cookie");
		}
		const sender = this.requireSender(message);
		const owner = this.holdOwners.get(cookie);
		if (owner === undefined) {
			throw invalidArgs(`Unknown profile hold cookie '${cookie}'`);
		}
		if (owner !== sender) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.AccessDenied",
				"A profile hold can only be released by its owner",
			);
		}

		try {
			await this.withPending(sender, async (signal) => {
				await this.ensureSenderConnected(sender);
				if (signal.aborted || this.stopping) {
					throw failed("The service is shutting down");
				}
				await this.selector.releaseProfile(sender, cookie);
			});
		} finally {
			this.notifyPropertiesChanged();
		}
		this.holdOwners.delete(cookie);
		return { signature: "", body: [] };
	}

	private async dispatchSetActionEnabled(
		message: dbus.Message,
	): Promise<DbusReply> {
		this.requireSignature(message, "sb", 2);
		const [action, enabled] = message.body as [string, boolean];
		if (typeof action !== "string" || typeof enabled !== "boolean") {
			throw invalidArgs("SetActionEnabled expects a string and a boolean");
		}
		await this.authorizedMutation(
			this.requireSender(message),
			POWER_PROFILE_CONFIGURE_ACTION,
			async () => undefined,
		);
		throw invalidArgs(`Unknown action '${action}'`);
	}

	private async dispatchTccMutation(message: dbus.Message): Promise<DbusReply> {
		if (message.interface !== TCC_INTERFACE) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownMethod",
				`Method '${message.member}' is not available`,
			);
		}
		switch (message.member) {
			case "SetTempProfile":
			case "SetTempProfileById": {
				this.requireSignature(message, "s", 1);
				const [profile] = message.body as string[];
				if (typeof profile !== "string") {
					throw invalidArgs(`${message.member} expects a string`);
				}
				const sender = this.requireSender(message);
				const action = this.selector.settings?.ppd?.enabled
					? POWER_PROFILE_SWITCH_ACTION
					: TCC_PROFILE_SWITCH_ACTION;
				const previousProfile = this.selector.activeStandardProfile;
				await this.authorizedMutation(sender, action, async () => {
					if (message.member === "SetTempProfileById") {
						await this.selector.selectTccProfile(profile, "temporary");
					} else {
						await this.backend.selectTccProfileByName(profile, "temporary");
					}
				});
				if (previousProfile !== this.selector.activeStandardProfile) {
					this.notifyPropertiesChanged();
				}
				return { signature: "b", body: [true] };
			}
			case "ReplaceProfileConfiguration": {
				this.requireSignature(message, "ss", 2);
				const [settingsJSON, profilesJSON] = message.body as string[];
				if (
					typeof settingsJSON !== "string" ||
					typeof profilesJSON !== "string"
				) {
					throw invalidArgs("ReplaceProfileConfiguration expects two strings");
				}
				if (
					Buffer.byteLength(settingsJSON, "utf8") > MAX_JSON_BYTES ||
					Buffer.byteLength(profilesJSON, "utf8") > MAX_JSON_BYTES
				) {
					throw invalidArgs("Configuration JSON payload exceeds 1 MiB");
				}
				for (const value of [settingsJSON, profilesJSON]) {
					if (value.length > 0) {
						try {
							JSON.parse(value);
						} catch {
							throw invalidArgs("Configuration payload is not valid JSON");
						}
					}
				}
				const sender = this.requireSender(message);
				await this.withPending(sender, async (signal) => {
					await this.ensureSenderConnected(sender);
					if (signal.aborted || this.stopping) {
						throw failed("The service is shutting down");
					}
					if ((await this.getConnectionUid(sender)) !== 0) {
						throw new PowerProfilesMessageError(
							"org.freedesktop.DBus.Error.AccessDenied",
							"Only root may replace TCC configuration",
						);
					}
					if (signal.aborted || this.stopping) {
						throw failed("The service is shutting down");
					}
					const accepted = await this.backend.replaceProfileConfiguration(
						settingsJSON,
						profilesJSON,
					);
					if (accepted !== true) {
						throw failed("TCC rejected the profile configuration");
					}
				});
				await this.refreshProvider();
				this.notifyPropertiesChanged();
				return { signature: "b", body: [true] };
			}
			default:
				throw new PowerProfilesMessageError(
					"org.freedesktop.DBus.Error.UnknownMethod",
					`Method '${message.member}' is not available`,
				);
		}
	}

	private async authorizedMutation(
		sender: string,
		action: string,
		operation: () => Promise<void>,
	): Promise<void> {
		await this.withPending(sender, async (signal) => {
			try {
				await this.authorization.check(sender, action, signal);
			} catch (error) {
				if (signal.aborted || this.stopping) {
					throw failed(
						"Authorization was cancelled because the caller disconnected or the service is shutting down",
					);
				}
				throw error;
			}
			await this.ensureSenderConnected(sender);
			if (signal.aborted || this.stopping) {
				throw failed("The caller disconnected before the operation began");
			}
			await operation();
		});
	}

	private async withPending<T>(
		sender: string,
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (this.stopping) {
			throw failed("The service is shutting down");
		}
		let requests = this.pendingByOwner.get(sender);
		if (requests === undefined) {
			requests = new Set<PendingRequest>();
		}
		if (
			requests.size >= MAX_PENDING_PER_SENDER ||
			this.pendingCount >= MAX_PENDING_TOTAL
		) {
			throw limitsExceeded("Too many pending profile operations");
		}
		this.pendingByOwner.set(sender, requests);
		const request: PendingRequest = { controller: new AbortController() };
		requests.add(request);
		this.pendingCount++;
		try {
			return await operation(request.controller.signal);
		} finally {
			this.pendingCount--;
			requests.delete(request);
			if (requests.size === 0) {
				this.pendingByOwner.delete(sender);
			}
		}
	}

	private async ensureSenderConnected(sender: string): Promise<void> {
		try {
			const owner = await this.getNameOwner(sender);
			if (owner !== sender) {
				throw new Error("The sender no longer owns its unique bus name");
			}
		} catch {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.AccessDenied",
				"The caller disconnected before authorization completed",
			);
		}
	}

	private async getConnectionUid(sender: string): Promise<number> {
		let reply: dbus.Message | null;
		try {
			reply = await this.callBusDaemon(
				"GetConnectionUnixUser",
				"s",
				[sender],
				"u",
			);
		} catch (error) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.AccessDenied",
				`Could not authenticate the caller's Unix user (${safeError(error)})`,
			);
		}
		if (
			reply.type !== dbus.MessageType.METHOD_RETURN ||
			reply.signature !== "u" ||
			!Number.isInteger(reply.body[0]) ||
			(reply.body[0] as number) < 0 ||
			(reply.body[0] as number) > 0xffffffff
		) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.AccessDenied",
				"The bus did not return a valid Unix UID",
			);
		}
		return reply.body[0] as number;
	}

	private async callBusDaemon(
		member: string,
		signature: string,
		body: unknown[],
		expectedSignature = "",
	): Promise<dbus.Message> {
		const reply = await this.bus.call(
			new dbus.Message({
				destination: DBUS_INTERFACE,
				path: DBUS_PATH,
				interface: DBUS_INTERFACE,
				member,
				signature,
				body,
			}),
		);
		if (
			reply === null ||
			reply.type !== dbus.MessageType.METHOD_RETURN ||
			reply.signature !== expectedSignature
		) {
			throw new Error(`The bus daemon did not answer ${member} successfully`);
		}
		return reply;
	}

	private async getNameOwner(name: string): Promise<string> {
		const reply = await this.callBusDaemon("GetNameOwner", "s", [name], "s");
		const owner = reply.body[0];
		if (typeof owner !== "string" || !owner.startsWith(":")) {
			throw new Error("The bus daemon returned an invalid name owner");
		}
		return owner;
	}

	private async rememberTccOwner(): Promise<void> {
		try {
			this.tccUniqueName = await this.getNameOwner(TCC_NAME);
		} catch {
			this.tccUniqueName = undefined;
		}
	}

	private handleBusMessage(message: dbus.Message): void {
		if (
			message.type !== dbus.MessageType.SIGNAL ||
			message.sender !== DBUS_INTERFACE ||
			message.path !== DBUS_PATH ||
			message.interface !== DBUS_INTERFACE ||
			message.member !== "NameOwnerChanged" ||
			message.signature !== "sss" ||
			message.body.length !== 3
		) {
			return;
		}
		const [name, oldOwner, newOwner] = message.body as string[];
		if (name === POWER_PROFILES_NAME) {
			if (
				newOwner === this.bus.name &&
				!this.stopping &&
				this.providerConfigured()
			) {
				// NameOwnerChanged arrives before activation calls queued for this name.
				this.acceptProviderNameOwner(newOwner);
			} else if (
				this.providerNameRequested &&
				newOwner !== this.providerUniqueName
			) {
				const wasOwned = this.providerOwned;
				this.providerNameRequested = false;
				this.providerOwned = false;
				this.providerUniqueName = undefined;
				this.unexportProvider();
				if (wasOwned) {
					this.abortPendingMutations();
					this.cleanupAllHolds();
				}
			}
			return;
		}
		if (name === TCC_NAME) {
			this.tccUniqueName = newOwner.length > 0 ? newOwner : undefined;
			return;
		}
		if (name.startsWith(":") && oldOwner === name && newOwner.length === 0) {
			this.handleOwnerDisconnected(name);
		}
	}
	private acceptProviderNameOwner(uniqueName: string): void {
		if (
			!this.started ||
			this.stopping ||
			!this.providerConfigured() ||
			!isUniqueName(uniqueName) ||
			uniqueName !== this.bus.name
		) {
			return;
		}
		this.providerNameRequested = true;
		this.providerUniqueName = uniqueName;
		if (!this.providerExported) {
			try {
				this.bus.export(POWER_PROFILES_PATH, this.interface);
				this.providerExported = true;
			} catch (error) {
				this.providerOwned = false;
				this.logOwnershipFailure(error);
				return;
			}
		}
		this.providerOwned = true;
	}
	private abortPendingMutations(): void {
		for (const requests of this.pendingByOwner.values()) {
			for (const request of requests) {
				request.controller.abort();
			}
		}
	}
	private handleBusError(error: unknown): void {
		if (!this.started || this.stopping) {
			return;
		}
		this.stopping = true;
		this.abortPendingMutations();
		this.providerNameRequested = false;
		this.providerOwned = false;
		this.providerUniqueName = undefined;
		this.unexportProvider();
		this.log(`D-Bus connection failed: ${safeError(error)}`);
		this.cleanupAllHolds();
	}

	private handleOwnerDisconnected(owner: string): void {
		for (const request of this.pendingByOwner.get(owner) ?? []) {
			request.controller.abort();
		}
		const cleanup = this.selector
			.disconnect(owner)
			.catch((error: unknown) => {
				this.log(
					`Profile hold cleanup for '${owner}' failed: ${safeError(error)}`,
				);
			})
			.finally(() => {
				for (const [cookie, holdOwner] of this.holdOwners) {
					if (holdOwner === owner) {
						this.holdOwners.delete(cookie);
					}
				}
				this.notifyPropertiesChanged();
			});
		this.track(cleanup);
	}

	private cleanupAllHolds(): void {
		const owners = new Set([
			...this.holdOwners.values(),
			...this.pendingByOwner.keys(),
		]);
		for (const owner of owners) {
			this.handleOwnerDisconnected(owner);
		}
		if (owners.size === 0) {
			this.holdOwners.clear();
		}
	}

	private track(request: Promise<void>): void {
		this.inFlight.add(request);
		void request.finally(() => this.inFlight.delete(request));
	}

	private targetsProvider(message: dbus.Message): boolean {
		return (
			message.path === POWER_PROFILES_PATH &&
			(message.interface === POWER_PROFILES_INTERFACE ||
				message.interface === PROPERTIES_INTERFACE) &&
			this.isTargetName(
				message.destination,
				POWER_PROFILES_NAME,
				this.providerUniqueName,
			)
		);
	}
	private reserveHoldSlot(owner: string): void {
		let liveCount = 0;
		for (const holdOwner of this.holdOwners.values()) {
			if (holdOwner === owner) {
				liveCount++;
			}
		}
		const reservedCount = this.pendingHoldsByOwner.get(owner) ?? 0;
		if (liveCount + reservedCount >= MAX_HOLDS_PER_SENDER) {
			throw limitsExceeded(
				`A sender may hold at most ${MAX_HOLDS_PER_SENDER} profiles`,
			);
		}
		if (this.holdOwners.size + this.pendingHoldCount >= MAX_HOLDS_TOTAL) {
			throw limitsExceeded(
				`The daemon may hold at most ${MAX_HOLDS_TOTAL} profiles`,
			);
		}
		this.pendingHoldsByOwner.set(owner, reservedCount + 1);
		this.pendingHoldCount++;
	}

	private releaseHoldSlot(owner: string): void {
		const reservations = this.pendingHoldsByOwner.get(owner) ?? 0;
		if (reservations <= 1) {
			this.pendingHoldsByOwner.delete(owner);
		} else {
			this.pendingHoldsByOwner.set(owner, reservations - 1);
		}
		this.pendingHoldCount--;
	}

	private targetsTcc(message: dbus.Message): boolean {
		return (
			message.path === TCC_PATH &&
			this.isTargetName(message.destination, TCC_NAME, this.tccUniqueName)
		);
	}

	private isTargetName(
		destination: string | undefined,
		wellKnownName: string,
		uniqueName: string | undefined,
	): boolean {
		return (
			destination === wellKnownName ||
			(uniqueName !== undefined && destination === uniqueName) ||
			destination?.startsWith(":") === true
		);
	}

	private isTccMutation(message: dbus.Message): boolean {
		return (
			message.interface === TCC_INTERFACE &&
			(message.member === "SetTempProfile" ||
				message.member === "SetTempProfileById" ||
				message.member === "ReplaceProfileConfiguration")
		);
	}
	private isProviderMutation(message: dbus.Message): boolean {
		if (message.interface === POWER_PROFILES_INTERFACE) {
			return (
				message.member === "HoldProfile" ||
				message.member === "ReleaseProfile" ||
				message.member === "SetActionEnabled"
			);
		}
		return (
			message.interface === PROPERTIES_INTERFACE && message.member === "Set"
		);
	}

	private providerConfigured(): boolean {
		return (
			this.selector.available &&
			this.selector.settings?.ppd?.enabled === true &&
			this.selector.activeStandardProfile !== undefined
		);
	}

	private providerAcceptingCalls(): boolean {
		return (
			this.started &&
			!this.stopping &&
			this.providerOwned &&
			this.providerExported &&
			this.providerConfigured()
		);
	}
	private async assertProviderNameOwner(): Promise<void> {
		if (!this.providerConfigured()) {
			await this.withdrawProvider();
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownObject",
				"The power profiles object is not available",
			);
		}
		const expectedOwner = this.providerUniqueName;
		let actualOwner: string | undefined;
		try {
			actualOwner = await this.getNameOwner(POWER_PROFILES_NAME);
		} catch {
			actualOwner = undefined;
		}
		if (
			expectedOwner !== undefined &&
			expectedOwner === actualOwner &&
			this.providerAcceptingCalls()
		) {
			return;
		}
		this.logOwnershipFailure("The provider no longer owns its well-known name");
		await this.withdrawProvider();
		this.abortPendingMutations();
		this.cleanupAllHolds();
		throw new PowerProfilesMessageError(
			"org.freedesktop.DBus.Error.UnknownObject",
			"The power profiles object is not available",
		);
	}

	private unexportProvider(): void {
		if (!this.providerExported) {
			return;
		}
		try {
			this.bus.unexport(POWER_PROFILES_PATH, this.interface);
		} catch {
			// Keep ownership and handler state consistent during bus teardown.
		}
		this.providerExported = false;
	}

	private async withdrawProvider(): Promise<void> {
		const heldName = this.providerNameRequested || this.providerOwned;
		this.providerNameRequested = false;
		this.providerOwned = false;
		this.providerUniqueName = undefined;
		this.unexportProvider();
		if (heldName) {
			try {
				await this.bus.releaseName(POWER_PROFILES_NAME);
			} catch {
				this.log(
					`Power Profiles provider name release failed for '${POWER_PROFILES_NAME}'`,
				);
			}
		}
	}

	private logOwnershipFailure(detail: unknown): void {
		this.log(
			`Power Profiles provider disabled: ${safeError(detail)}. Resolve any overlapping power-profile provider before retrying; TCC does not stop other managers.`,
		);
	}

	private sendProfileReleasedSignal(owner: string, cookie: number): void {
		if (!this.providerOwned || !isUniqueName(owner)) {
			return;
		}
		const signal = dbus.Message.newSignal(
			POWER_PROFILES_PATH,
			POWER_PROFILES_INTERFACE,
			"ProfileReleased",
			"u",
			[cookie],
		);
		signal.destination = owner;
		try {
			this.bus.send(signal);
		} catch {
			// Delivery to a disconnected unique name is best-effort.
		}
	}

	private getProperty(name: string): unknown {
		if (!Object.hasOwn(PROPERTY_SIGNATURES, name)) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownProperty",
				`Property '${name}' does not exist`,
			);
		}
		return this.propertyValues()[name];
	}

	private requirePowerProfilesInterface(interfaceName: string): void {
		if (interfaceName !== POWER_PROFILES_INTERFACE) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.UnknownProperty",
				`Interface '${interfaceName}' has no supported properties here`,
			);
		}
	}

	private requireSignature(
		message: dbus.Message,
		signature: string,
		argumentCount: number,
	): void {
		if (
			message.signature !== signature ||
			!Array.isArray(message.body) ||
			message.body.length !== argumentCount
		) {
			throw invalidArgs(
				`Invalid signature for ${message.interface}.${message.member}`,
			);
		}
	}

	private requireSender(message: dbus.Message): string {
		if (typeof message.sender !== "string" || !isUniqueName(message.sender)) {
			throw new PowerProfilesMessageError(
				"org.freedesktop.DBus.Error.AccessDenied",
				"The caller has no authenticated unique bus name",
			);
		}
		return message.sender;
	}

	private noReplyExpected(message: dbus.Message): boolean {
		return ((message.flags ?? 0) & NO_REPLY_EXPECTED) !== 0;
	}

	private errorReply(error: unknown): [string, string] {
		if (error instanceof PowerProfilesMessageError) {
			return [error.nameOnBus, bounded(error.message)];
		}
		if (error instanceof dbus.DBusError) {
			return [error.type, bounded(error.text)];
		}
		if (isServiceError(error)) {
			const names: Record<string, string> = {
				"invalid-args": "org.freedesktop.DBus.Error.InvalidArgs",
				"access-denied": "org.freedesktop.DBus.Error.AccessDenied",
				"limits-exceeded": "org.freedesktop.DBus.Error.LimitsExceeded",
				failed: "org.freedesktop.DBus.Error.Failed",
				withdrawn: "org.freedesktop.DBus.Error.Failed",
			};
			return [
				names[error.code] ?? "org.freedesktop.DBus.Error.Failed",
				bounded(error.message),
			];
		}
		return [
			"org.freedesktop.DBus.Error.Failed",
			"The operation could not be completed",
		];
	}
}

class PowerProfilesInterface extends dbus.interface.Interface {
	public constructor(private readonly service: PowerProfilesService) {
		super(POWER_PROFILES_INTERFACE);
	}

	public get Profiles(): Array<Record<string, dbus.Variant>> {
		return this.service.profilesProperty;
	}

	public get ActiveProfile(): string {
		return this.service.activeProfileProperty;
	}

	public set ActiveProfile(_value: string) {
		throw new dbus.DBusError(
			"org.freedesktop.DBus.Error.Failed",
			"ActiveProfile writes require caller-aware dispatch",
		);
	}

	public get PerformanceInhibited(): string {
		return "";
	}

	public get PerformanceDegraded(): string {
		return "";
	}

	public get ActiveProfileHolds(): Array<Record<string, dbus.Variant>> {
		return this.service.activeProfileHoldsProperty;
	}

	public get Actions(): string[] {
		return [];
	}

	public get ActionsInfo(): Array<Record<string, dbus.Variant>> {
		return [];
	}

	public get Version(): string {
		return this.service.versionProperty;
	}

	public HoldProfile(
		_profile: string,
		_reason: string,
		_applicationId: string,
	): number {
		throw new dbus.DBusError(
			"org.freedesktop.DBus.Error.Failed",
			"HoldProfile requires caller-aware dispatch",
		);
	}

	public ReleaseProfile(_cookie: number): void {
		throw new dbus.DBusError(
			"org.freedesktop.DBus.Error.Failed",
			"ReleaseProfile requires caller-aware dispatch",
		);
	}

	public SetActionEnabled(_action: string, _enabled: boolean): void {
		throw new dbus.DBusError(
			"org.freedesktop.DBus.Error.Failed",
			"SetActionEnabled requires caller-aware dispatch",
		);
	}

	public ProfileReleased(_cookie: number): void {
		// The service sends targeted signals through MessageBus, not this broadcast hook.
	}
}

PowerProfilesInterface.configureMembers({
	properties: {
		Profiles: { signature: "aa{sv}", access: "read" },
		ActiveProfile: { signature: "s", access: "readwrite" },
		PerformanceInhibited: { signature: "s", access: "read" },
		PerformanceDegraded: { signature: "s", access: "read" },
		ActiveProfileHolds: { signature: "aa{sv}", access: "read" },
		Actions: { signature: "as", access: "read" },
		ActionsInfo: { signature: "aa{sv}", access: "read" },
		Version: { signature: "s", access: "read" },
	},
	methods: {
		HoldProfile: { inSignature: "sss", outSignature: "u" },
		ReleaseProfile: { inSignature: "u", outSignature: "" },
		SetActionEnabled: { inSignature: "sb", outSignature: "" },
	},
	signals: {
		ProfileReleased: { signature: "u" },
	},
});

function isUniqueName(name: string): boolean {
	return /^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(name);
}

function isVariant(value: unknown): value is dbus.Variant {
	return (
		value !== null &&
		typeof value === "object" &&
		"signature" in value &&
		"value" in value
	);
}

function requireStandardProfile(value: string): StandardProfile {
	if ((PROFILE_ORDER as string[]).includes(value)) {
		return value as StandardProfile;
	}
	throw failed(`Unknown power profile '${value}'`);
}

function invalidArgs(message: string): PowerProfilesMessageError {
	return new PowerProfilesMessageError(
		"org.freedesktop.DBus.Error.InvalidArgs",
		message,
	);
}

function limitsExceeded(message: string): PowerProfilesMessageError {
	return new PowerProfilesMessageError(
		"org.freedesktop.DBus.Error.LimitsExceeded",
		message,
	);
}

function failed(message: string): PowerProfilesMessageError {
	return new PowerProfilesMessageError(
		"org.freedesktop.DBus.Error.Failed",
		message,
	);
}

function bounded(message: string): string {
	const bytes = Buffer.from(message, "utf8");
	if (bytes.byteLength <= MAX_SAFE_ERROR_BYTES) {
		return message;
	}
	return bytes.subarray(0, MAX_SAFE_ERROR_BYTES).toString("utf8");
}

function safeError(value: unknown): string {
	if (value instanceof Error && value.message.length > 0) {
		return bounded(value.message);
	}
	if (typeof value === "string" && value.length > 0) {
		return bounded(value);
	}
	return "unknown error";
}

function isServiceError(
	value: unknown,
): value is Error & { code: string; message: string } {
	return (
		value instanceof Error && "code" in value && typeof value.code === "string"
	);
}
