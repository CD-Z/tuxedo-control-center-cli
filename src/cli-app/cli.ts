import { isDeepStrictEqual } from "node:util";
import type { TccDBusController } from "../common/classes/TccDBusController";
import { TUXEDODevice } from "../common/models/DefaultProfiles";
import { generateProfileId } from "../common/models/TccProfile";
import type { ITccProfile } from "../common/models/TccProfile";
import {
	applyProfileSettings,
	validateChangedSettings,
	validateProfileDocument,
	validateSavedProfiles,
} from "./profile-settings";
import type { SavedProfile } from "./profile-settings";
import { parseProfileCommand } from "./profile-options";
import type { ProfileParseResult } from "./profile-options";
import type { ProfileIO } from "./profile-io";
import { getHelpTopic, renderHelp } from "./cli-help";
import { resolveProfile } from "./profile-selector";
import { parsePpdCommand, runPpdCommand } from "./ppd";

export type CliClient = Pick<
	TccDBusController,
	| "init"
	| "dbusAvailable"
	| "tccdVersion"
	| "getDeviceJSON"
	| "getProfilesJSON"
	| "getSettingsJSON"
	| "getPowerProfilesRuntimeState"
	| "getActiveProfileJSON"
	| "getDefaultProfilesJSON"
	| "getDefaultValuesProfileJSON"
	| "getIsX11"
	| "getDisplayModesJSON"
	| "getFansOffAvailable"
	| "getFansMinSpeed"
	| "odmProfilesAvailable"
	| "odmPowerLimits"
	| "getNVIDIAPowerCTRLAvailable"
	| "getNVIDIAPowerCTRLDefaultPowerLimit"
	| "getNVIDIAPowerCTRLMaxPowerLimit"
	| "getIsUnsupportedConfigurableTGPDevice"
	| "setTempProfileById"
	| "disconnect"
>;

export interface CliDependencies {
	createClient(): CliClient;
	createProfileIO(): ProfileIO;
	stdout(text: string): void;
	stderr(text: string): void;
}

function helpHint(argv: readonly string[]): string {
	if (argv[0] === "status") {
		return 'Run "tcc-cli status --help" for usage.';
	}
	if (argv[0] === "ppd") {
		if (["status", "enable", "disable", "configure"].includes(argv[1] ?? "")) {
			return `Run "tcc-cli ppd ${argv[1]} --help" for usage.`;
		}
		return 'Run "tcc-cli ppd --help" for usage.';
	}
	if (argv[0] === "profiles") {
		if (
			["list", "current", "activate", "show", "create", "edit"].includes(
				argv[1] ?? "",
			)
		) {
			return `Run "tcc-cli profiles ${argv[1]} --help" for usage.`;
		}
		return 'Run "tcc-cli profiles --help" for usage.';
	}
	return 'Run "tcc-cli --help" for usage.';
}

function syntaxFailure(
	reason: string,
	argv: readonly string[],
	stderr: (text: string) => void,
): number {
	stderr(`tcc-cli: ${reason}\n${helpHint(argv)}`);
	return 2;
}

function invalid(field: string): Error {
	return new Error(`tcc-cli: tccd returned invalid ${field} data.`);
}

function parseProfiles(
	json: string | undefined,
	field: "profile list" | "active profile",
): ITccProfile[] | ITccProfile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json as string) as unknown;
	} catch {
		throw invalid(field);
	}

	if (field === "profile list") {
		if (!Array.isArray(parsed) || !parsed.every(isDisplayableProfile)) {
			throw invalid(field);
		}
		return parsed as ITccProfile[];
	}
	if (!isDisplayableProfile(parsed)) {
		throw invalid(field);
	}
	return parsed as ITccProfile;
}

function isDisplayableProfile(profile: unknown): profile is ITccProfile {
	return (
		profile !== null &&
		typeof profile === "object" &&
		!Array.isArray(profile) &&
		"id" in profile &&
		typeof profile.id === "string" &&
		profile.id.length > 0 &&
		"name" in profile &&
		typeof profile.name === "string"
	);
}

function displayProfile(profile: ITccProfile): string {
	return `${profile.id}\t${profile.name}\n`;
}

function parseUniqueProfileList(json: string | undefined): ITccProfile[] {
	const profiles = parseProfiles(json, "profile list") as ITccProfile[];
	const ids = new Set<string>();
	for (const profile of profiles) {
		if (ids.has(profile.id)) {
			throw invalid("profile list");
		}
		ids.add(profile.id);
	}
	return profiles;
}

function parseDefaultProfiles(json: string | undefined): SavedProfile[] {
	const profiles = parseUniqueProfileList(json);
	try {
		validateSavedProfiles(profiles, new Set<string>());
	} catch {
		throw invalid("profile list");
	}
	return profiles as SavedProfile[];
}

function profileIds(profiles: readonly { id: string }[]): Set<string> {
	return new Set(profiles.map((profile): string => profile.id));
}

function rawProfileReadError(error: unknown): Error {
	const message = errorText(error);
	if (message.startsWith("tcc-cli: Cannot read saved profiles:")) {
		return error instanceof Error ? error : new Error(message);
	}
	const prefix = "tcc-cli: ";
	const reason = (
		message.startsWith(prefix) ? message.slice(prefix.length) : message
	).replace(/[.]+$/, "");
	return new Error(`tcc-cli: Cannot read saved profiles: ${reason}.`);
}

async function readSavedProfiles(
	io: ProfileIO,
	defaultIds: ReadonlySet<string>,
): Promise<SavedProfile[]> {
	try {
		const parsed: unknown = JSON.parse(await io.readSavedProfiles()) as unknown;
		validateSavedProfiles(parsed, defaultIds);
		return parsed;
	} catch (error: unknown) {
		throw rawProfileReadError(error);
	}
}

function invalidSetting(path: string, reason: string): Error {
	return new Error(`tcc-cli: Invalid profile setting: ${path}: ${reason}.`);
}

function parseEditedProfile(json: string): SavedProfile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json) as unknown;
	} catch {
		throw invalidSetting("profile", "editor returned invalid JSON");
	}
	validateProfileDocument(parsed);
	return parsed;
}

async function editedDraft(
	io: ProfileIO,
	draft: SavedProfile,
	expectedId: string,
): Promise<SavedProfile | undefined> {
	const result = await io.editProfile(`${JSON.stringify(draft, null, 2)}\n`);
	if (result === undefined) {
		return undefined;
	}
	const edited = parseEditedProfile(result);
	if (edited.id !== expectedId) {
		throw invalidSetting("id", "cannot be changed");
	}
	return edited;
}

async function runProfileCommand(
	command: Exclude<ProfileParseResult, { kind: "unhandled" | "invalid" }>,
	client: CliClient,
	io: ProfileIO,
	stdout: (text: string) => void,
): Promise<void> {
	const builtIns = parseDefaultProfiles(await client.getDefaultProfilesJSON());
	const defaultIds = profileIds(builtIns);
	if (command.kind === "show") {
		const builtInById = builtIns.find(
			(profile): boolean => profile.id === command.selector,
		);
		if (builtInById) {
			stdout(`${JSON.stringify(builtInById, null, 2)}\n`);
			return;
		}
		const savedProfiles = await readSavedProfiles(io, defaultIds);
		const selected = resolveProfile(
			[...builtIns, ...savedProfiles],
			command.selector,
		);
		stdout(`${JSON.stringify(selected, null, 2)}\n`);
		return;
	}

	if (command.kind === "edit" && defaultIds.has(command.selector)) {
		throw new Error(
			`tcc-cli: Built-in profile is read-only: ${command.selector}. Create a profile with --base ${command.selector} instead.`,
		);
	}

	const daemonProfiles =
		command.kind === "create"
			? parseUniqueProfileList(await client.getProfilesJSON())
			: undefined;
	const initialSavedProfiles = await readSavedProfiles(io, defaultIds);
	let before: SavedProfile | undefined;
	if (command.kind === "edit") {
		const selected = resolveProfile(
			[...builtIns, ...initialSavedProfiles],
			command.selector,
		);
		if (defaultIds.has(selected.id)) {
			throw new Error(
				`tcc-cli: Built-in profile is read-only: ${selected.id}. Create a profile with --base ${selected.id} instead.`,
			);
		}
		before = initialSavedProfiles.find(
			(profile): boolean => profile.id === selected.id,
		);
	}

	let draft: SavedProfile;
	let baseline: SavedProfile;
	let targetId: string;
	if (command.kind === "create") {
		const profiles = daemonProfiles as ITccProfile[];
		let base: ITccProfile | undefined;
		if (command.baseSelector === undefined) {
			const selectedId = await io.selectBase(
				profiles.map(({ id, name }) => ({ id, name })),
			);
			if (selectedId === undefined) {
				throw new Error("tcc-cli: Profile operation cancelled.");
			}
			base = profiles.find((profile): boolean => profile.id === selectedId);
			if (!base) {
				throw new Error(`tcc-cli: Unknown profile ID: ${selectedId}.`);
			}
		} else {
			base = resolveProfile(profiles, command.baseSelector);
		}
		validateProfileDocument(base);
		targetId = generateProfileId();
		const existingIds = new Set<string>([
			...profileIds(profiles),
			...profileIds(initialSavedProfiles),
			...defaultIds,
		]);
		if (existingIds.has(targetId)) {
			throw invalidSetting("id", "generated profile ID already exists");
		}
		draft = structuredClone(base) as SavedProfile;
		draft.id = targetId;
		draft.name = command.name;
		baseline = structuredClone(draft) as SavedProfile;
		if (command.editor) {
			const edited = await editedDraft(io, draft, targetId);
			if (edited === undefined) {
				throw new Error("tcc-cli: Profile operation cancelled.");
			}
			draft = edited;
		} else {
			applyProfileSettings(draft, command.settings);
		}
	} else {
		const original = before as SavedProfile;
		targetId = original.id;
		baseline = structuredClone(original) as SavedProfile;
		draft = structuredClone(original) as SavedProfile;
		if (command.editor) {
			const edited = await editedDraft(io, draft, targetId);
			if (edited === undefined) {
				throw new Error("tcc-cli: Profile operation cancelled.");
			}
			draft = edited;
		} else {
			applyProfileSettings(draft, command.settings);
		}
	}

	await validateChangedSettings(baseline, draft, command.settings, client, io);
	if (command.kind === "edit" && isDeepStrictEqual(before, draft)) {
		stdout(`No changes to profile: ${draft.name} [${draft.id}]\n`);
		return;
	}

	const latestSavedProfiles = await readSavedProfiles(io, defaultIds);
	if (command.kind === "edit") {
		const latestIndex = latestSavedProfiles.findIndex(
			(profile): boolean => profile.id === targetId,
		);
		if (
			latestIndex === -1 ||
			!isDeepStrictEqual(latestSavedProfiles[latestIndex], before)
		) {
			throw new Error(
				`tcc-cli: Profile changed while editing: ${targetId}. Run the command again.`,
			);
		}
		latestSavedProfiles[latestIndex] = draft;
	} else {
		const latestIds = new Set<string>([
			...profileIds(latestSavedProfiles),
			...defaultIds,
			...profileIds(daemonProfiles as ITccProfile[]),
		]);
		if (latestIds.has(draft.id)) {
			throw invalidSetting("id", "generated profile ID already exists");
		}
		latestSavedProfiles.push(draft);
	}
	validateSavedProfiles(latestSavedProfiles, defaultIds);
	await io.saveProfiles(`${JSON.stringify(latestSavedProfiles, null, 2)}\n`);
	stdout(
		`${command.kind === "create" ? "Created" : "Updated"} profile: ${draft.name} [${draft.id}]\n`,
	);
}

async function connect(client: CliClient): Promise<void> {
	if (!(await client.init()) || !(await client.dbusAvailable())) {
		throw new Error("tcc-cli: Cannot connect to tccd. Ensure tccd is running.");
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runCli(
	argv: readonly string[],
	dependencies: CliDependencies,
): Promise<number> {
	const helpTopic = getHelpTopic(argv);
	if (helpTopic) {
		dependencies.stdout(renderHelp(helpTopic));
		return 0;
	}

	const parsedPpdCommand = parsePpdCommand(argv);
	if (parsedPpdCommand.kind === "invalid") {
		dependencies.stderr(`${parsedPpdCommand.message}\n${helpHint(argv)}`);
		return 2;
	}
	const ppdCommand =
		parsedPpdCommand.kind === "unhandled" ? undefined : parsedPpdCommand;
	const parsedProfileCommand = parseProfileCommand(argv);
	if (parsedProfileCommand.kind === "invalid") {
		dependencies.stderr(parsedProfileCommand.message);
		return 2;
	}
	const profileCommand =
		parsedProfileCommand.kind === "unhandled"
			? undefined
			: parsedProfileCommand;
	let command:
		| "profiles-management"
		| "status"
		| "profiles-list"
		| "profiles-current"
		| "profiles-activate"
		| "ppd"
		| undefined;
	if (ppdCommand) {
		command = "ppd";
	} else if (profileCommand) {
		command = "profiles-management";
	} else if (argv[0] === "status") {
		if (argv.length !== 1) {
			return syntaxFailure(
				`Unexpected argument: ${JSON.stringify(argv[1])}.`,
				argv,
				dependencies.stderr,
			);
		}
		command = "status";
	} else if (argv[0] === "profiles") {
		if (argv[1] === "list" || argv[1] === "current") {
			if (argv.length !== 2) {
				return syntaxFailure(
					`Unexpected argument: ${JSON.stringify(argv[2])}.`,
					argv,
					dependencies.stderr,
				);
			}
			command = argv[1] === "list" ? "profiles-list" : "profiles-current";
		} else if (argv[1] === "activate") {
			const selector = argv[2];
			if (
				selector === undefined ||
				selector.length === 0 ||
				selector.startsWith("-")
			) {
				return syntaxFailure(
					"Missing required argument: <profile>.",
					argv,
					dependencies.stderr,
				);
			}
			if (argv.length > 3) {
				return syntaxFailure(
					`Unexpected argument: ${JSON.stringify(argv[3])}.`,
					argv,
					dependencies.stderr,
				);
			}
			command = "profiles-activate";
		}
	}

	if (!command) {
		dependencies.stderr(
			`tcc-cli: Invalid command.${String.fromCharCode(10)}${helpHint(argv)}`,
		);
		return 2;
	}

	let client: CliClient | undefined;
	try {
		client = dependencies.createClient();
		await connect(client);

		if (command === "ppd" && ppdCommand) {
			await runPpdCommand(ppdCommand, client, dependencies);
			return 0;
		}
		if (profileCommand) {
			const io = dependencies.createProfileIO();
			await runProfileCommand(profileCommand, client, io, dependencies.stdout);
			return 0;
		}

		if (command === "profiles-activate") {
			const selector = argv[2] as string;
			const profiles = parseUniqueProfileList(await client.getProfilesJSON());
			const profileId = resolveProfile(profiles, selector).id;
			if ((await client.setTempProfileById(profileId)) !== true) {
				throw new Error(
					`tcc-cli: tccd rejected profile activation: ${profileId}.`,
				);
			}
			const activeProfile = parseProfiles(
				await client.getActiveProfileJSON(),
				"active profile",
			) as ITccProfile;
			if (activeProfile.id !== profileId) {
				throw new Error(
					`tcc-cli: tccd did not activate profile: ${profileId}.`,
				);
			}
			dependencies.stdout(
				`Activated temporary profile: ${activeProfile.name} [${activeProfile.id}]${String.fromCharCode(10)}`,
			);
			return 0;
		}

		if (command === "profiles-list") {
			const profiles = parseProfiles(
				await client.getProfilesJSON(),
				"profile list",
			) as ITccProfile[];
			dependencies.stdout(
				`ID${String.fromCharCode(9)}NAME${String.fromCharCode(10)}${profiles.map(displayProfile).join("")}`,
			);
			return 0;
		}

		if (command === "profiles-current") {
			const profile = parseProfiles(
				await client.getActiveProfileJSON(),
				"active profile",
			) as ITccProfile;
			dependencies.stdout(
				`ID${String.fromCharCode(9)}NAME${String.fromCharCode(10)}${displayProfile(profile)}`,
			);
			return 0;
		}

		const version = await client.tccdVersion();
		if (typeof version !== "string" || version.length === 0) {
			throw invalid("version");
		}
		const deviceJSON = await client.getDeviceJSON();
		let device: unknown;
		try {
			device = JSON.parse(deviceJSON as string) as unknown;
		} catch {
			throw invalid("device");
		}
		if (
			typeof device !== "number" ||
			!Number.isFinite(device) ||
			!Number.isInteger(device)
		) {
			throw invalid("device");
		}
		const deviceLabel = Object.prototype.hasOwnProperty.call(
			TUXEDODevice,
			device,
		)
			? TUXEDODevice[device]
			: String(device);
		const activeProfile = parseProfiles(
			await client.getActiveProfileJSON(),
			"active profile",
		) as ITccProfile;
		dependencies.stdout(
			`Daemon: available${String.fromCharCode(10)}Version: ${version}${String.fromCharCode(10)}Device: ${deviceLabel}${String.fromCharCode(10)}Active profile: ${activeProfile.name} [${activeProfile.id}]${String.fromCharCode(10)}`,
		);
		return 0;
	} catch (error: unknown) {
		const message = errorText(error);
		dependencies.stderr(
			message.startsWith("tcc-cli: ") ? message : `tcc-cli: ${message}`,
		);
		return 1;
	} finally {
		client?.disconnect();
	}
}
