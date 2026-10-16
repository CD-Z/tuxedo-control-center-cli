import { isDeepStrictEqual } from 'node:util';
import type { TccDBusController } from '../common/classes/TccDBusController';
import { TUXEDODevice } from '../common/models/DefaultProfiles';
import { generateProfileId } from '../common/models/TccProfile';
import type { ITccProfile } from '../common/models/TccProfile';
import { applyProfileSettings, validateChangedSettings, validateProfileDocument, validateSavedProfiles } from './profile-settings';
import type { SavedProfile } from './profile-settings';
import { parseProfileCommand } from './profile-options';
import type { ProfileParseResult } from './profile-options';
import type { ProfileIO } from './profile-io';

export type CliClient = Pick<
    TccDBusController,
    | 'init'
    | 'dbusAvailable'
    | 'tccdVersion'
    | 'getDeviceJSON'
    | 'getProfilesJSON'
    | 'getActiveProfileJSON'
    | 'getDefaultProfilesJSON'
    | 'getDefaultValuesProfileJSON'
    | 'getIsX11'
    | 'getDisplayModesJSON'
    | 'getFansOffAvailable'
    | 'getFansMinSpeed'
    | 'odmProfilesAvailable'
    | 'odmPowerLimits'
    | 'getNVIDIAPowerCTRLAvailable'
    | 'getNVIDIAPowerCTRLDefaultPowerLimit'
    | 'getNVIDIAPowerCTRLMaxPowerLimit'
    | 'getIsUnsupportedConfigurableTGPDevice'
    | 'setTempProfileById'
    | 'disconnect'
>;

export interface CliDependencies {
    createClient(): CliClient;
    createProfileIO(): ProfileIO;
    stdout(text: string): void;
    stderr(text: string): void;
}

const profileHelp = [
    'Profile commands:',
    '  profiles show <id>',
    '  profiles create <name> [--base <id>] [setting flags | --editor]',
    '  profiles edit <id> [setting flags | --editor]',
    '  --base accepts an exact profile ID; without it, create prompts for a base on a terminal.',
    '  Setting flags: --name, --description, --brightness, --refresh-rate, --webcam, --cpu-cores,',
    '    --cpu-min-frequency, --cpu-max-frequency, --cpu-max-performance, --cpu-energy-preference,',
    '    --cpu-turbo, --fan-profile, --fan-min-speed, --fan-max-speed, --fan-offset, --odm-profile,',
    '    --nvidia-power-offset. --editor cannot be combined with setting flags.',
    '  Custom profiles show their saved JSON. Built-in profiles show daemon-resolved defaults.',
    '  Profile saves use the privileged helper and may require polkit authentication.',
    '  The helper replaces the complete profile list. Use one writer at a time. Concurrent GUI and CLI saves',
    '  are not transactional, and a daemon reload after any save may reapply the current profile to hardware.',
    '  Creating a profile does not activate it or change saved AC/battery mappings.',
].join('\n') + '\n';

const usage = [
    'Usage: tcc-cli <command>',
    'Commands:',
    '  status          Show daemon and active profile status',
    '  profiles list   List available profiles',
    '  profiles current  Show the active profile',
    '  profiles activate <id>  Temporarily activate an existing profile',
    '  profiles show <id>  Show a saved or built-in profile',
    '  profiles create <name> [--base <id>] [setting flags | --editor]',
    '  profiles edit <id> [setting flags | --editor]',
    '  Temporary selection can apply hardware settings through tccd, does not change saved power-state assignments, and may be cleared by a daemon restart, power-state change, or changed saved mapping.',
    '',
    profileHelp.trimEnd(),
].join('\n') + '\n';



function invalid(field: string): Error {
    return new Error(`tcc-cli: tccd returned invalid ${field} data.`);
}

function parseProfiles(json: string | undefined, field: 'profile list' | 'active profile'): ITccProfile[] | ITccProfile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json as string) as unknown;
    } catch {
        throw invalid(field);
    }

    if (field === 'profile list') {
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
        typeof profile === 'object' &&
        !Array.isArray(profile) &&
        'id' in profile &&
        typeof profile.id === 'string' &&
        profile.id.length > 0 &&
        'name' in profile &&
        typeof profile.name === 'string'
    );
}

function displayProfile(profile: ITccProfile): string {
    return `${profile.id}\t${profile.name}\n`;
}

function parseUniqueProfileList(json: string | undefined): ITccProfile[] {
    const profiles = parseProfiles(json, 'profile list') as ITccProfile[];
    const ids = new Set<string>();
    for (const profile of profiles) {
        if (ids.has(profile.id)) {
            throw invalid('profile list');
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
        throw invalid('profile list');
    }
    return profiles as SavedProfile[];
}

function profileIds(profiles: readonly { id: string }[]): Set<string> {
    return new Set(profiles.map((profile): string => profile.id));
}

function rawProfileReadError(error: unknown): Error {
    const message = errorText(error);
    if (message.startsWith('tcc-cli: Cannot read saved profiles:')) {
        return error instanceof Error ? error : new Error(message);
    }
    const prefix = 'tcc-cli: ';
    const reason = (message.startsWith(prefix) ? message.slice(prefix.length) : message).replace(/[.]+$/, '');
    return new Error(`tcc-cli: Cannot read saved profiles: ${reason}.`);
}

async function readSavedProfiles(io: ProfileIO, defaultIds: ReadonlySet<string>): Promise<SavedProfile[]> {
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
        throw invalidSetting('profile', 'editor returned invalid JSON');
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
        throw invalidSetting('id', 'cannot be changed');
    }
    return edited;
}

async function runProfileCommand(
    command: Exclude<ProfileParseResult, { kind: 'unhandled' | 'invalid' | 'help' }>,
    client: CliClient,
    io: ProfileIO,
    stdout: (text: string) => void,
): Promise<void> {
    const builtIns = parseDefaultProfiles(await client.getDefaultProfilesJSON());
    const defaultIds = profileIds(builtIns);
    if (command.kind === 'show') {
        const builtIn = builtIns.find((profile): boolean => profile.id === command.id);
        if (builtIn) {
            stdout(`${JSON.stringify(builtIn, null, 2)}\n`);
            return;
        }
        const savedProfiles = await readSavedProfiles(io, defaultIds);
        const saved = savedProfiles.find((profile): boolean => profile.id === command.id);
        if (!saved) {
            throw new Error(`tcc-cli: Unknown profile ID: ${command.id}.`);
        }
        stdout(`${JSON.stringify(saved, null, 2)}\n`);
        return;
    }

    if (command.kind === 'edit' && defaultIds.has(command.id)) {
        throw new Error(
            `tcc-cli: Built-in profile is read-only: ${command.id}. Create a profile with --base ${command.id} instead.`,
        );
    }

    const daemonProfiles = command.kind === 'create'
        ? parseUniqueProfileList(await client.getProfilesJSON())
        : undefined;
    const initialSavedProfiles = await readSavedProfiles(io, defaultIds);
    const before = command.kind === 'edit'
        ? initialSavedProfiles.find((profile): boolean => profile.id === command.id)
        : undefined;
    if (command.kind === 'edit' && !before) {
        throw new Error(`tcc-cli: Unknown profile ID: ${command.id}.`);
    }

    let draft: SavedProfile;
    let baseline: SavedProfile;
    let targetId: string;
    if (command.kind === 'create') {
        const profiles = daemonProfiles as ITccProfile[];
        let baseId = command.baseId;
        if (baseId === undefined) {
            baseId = await io.selectBase(profiles.map(({ id, name }) => ({ id, name })));
            if (baseId === undefined) {
                throw new Error('tcc-cli: Profile operation cancelled.');
            }
        }
        const base = profiles.find((profile): boolean => profile.id === baseId);
        if (!base) {
            throw new Error(`tcc-cli: Unknown profile ID: ${baseId}.`);
        }
        validateProfileDocument(base);
        targetId = generateProfileId();
        const existingIds = new Set<string>([
            ...profileIds(profiles),
            ...profileIds(initialSavedProfiles),
            ...defaultIds,
        ]);
        if (existingIds.has(targetId)) {
            throw invalidSetting('id', 'generated profile ID already exists');
        }
        draft = structuredClone(base) as SavedProfile;
        draft.id = targetId;
        draft.name = command.name;
        baseline = structuredClone(draft) as SavedProfile;
        if (command.editor) {
            const edited = await editedDraft(io, draft, targetId);
            if (edited === undefined) {
                throw new Error('tcc-cli: Profile operation cancelled.');
            }
            draft = edited;
        } else {
            applyProfileSettings(draft, command.settings);
        }
    } else {
        const original = before as SavedProfile;
        targetId = command.id;
        baseline = structuredClone(original) as SavedProfile;
        draft = structuredClone(original) as SavedProfile;
        if (command.editor) {
            const edited = await editedDraft(io, draft, targetId);
            if (edited === undefined) {
                throw new Error('tcc-cli: Profile operation cancelled.');
            }
            draft = edited;
        } else {
            applyProfileSettings(draft, command.settings);
        }
    }

    await validateChangedSettings(baseline, draft, command.settings, client, io);
    if (command.kind === 'edit' && isDeepStrictEqual(before, draft)) {
        stdout(`No changes to profile: ${draft.name} [${draft.id}]\n`);
        return;
    }

    const latestSavedProfiles = await readSavedProfiles(io, defaultIds);
    if (command.kind === 'edit') {
        const latestIndex = latestSavedProfiles.findIndex((profile): boolean => profile.id === command.id);
        if (
            latestIndex === -1 ||
            !isDeepStrictEqual(latestSavedProfiles[latestIndex], before)
        ) {
            throw new Error(`tcc-cli: Profile changed while editing: ${command.id}. Run the command again.`);
        }
        latestSavedProfiles[latestIndex] = draft;
    } else {
        const latestIds = new Set<string>([
            ...profileIds(latestSavedProfiles),
            ...defaultIds,
            ...profileIds(daemonProfiles as ITccProfile[]),
        ]);
        if (latestIds.has(draft.id)) {
            throw invalidSetting('id', 'generated profile ID already exists');
        }
        latestSavedProfiles.push(draft);
    }
    validateSavedProfiles(latestSavedProfiles, defaultIds);
    await io.saveProfiles(`${JSON.stringify(latestSavedProfiles, null, 2)}\n`);
    stdout(
        `${command.kind === 'create' ? 'Created' : 'Updated'} profile: ${draft.name} [${draft.id}]\n`,
    );
}

async function connect(client: CliClient): Promise<void> {
    if (!(await client.init()) || !(await client.dbusAvailable())) {
        throw new Error('tcc-cli: Cannot connect to tccd. Ensure tccd is running.');
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
    if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) {
        dependencies.stdout(usage);
        return 0;
    }

    const parsedProfileCommand = parseProfileCommand(argv);
    if (parsedProfileCommand.kind === 'help') {
        dependencies.stdout(profileHelp);
        return 0;
    }
    if (parsedProfileCommand.kind === 'invalid') {
        dependencies.stderr(`tcc-cli: Invalid command.\n${usage}`);
        return 2;
    }
    const profileCommand = parsedProfileCommand.kind === 'unhandled' ? undefined : parsedProfileCommand;
    const command = profileCommand
        ? 'profiles-management'
        : argv.length === 1 && argv[0] === 'status'
            ? 'status'
            : argv.length === 2 && argv[0] === 'profiles' && argv[1] === 'list'
                ? 'profiles-list'
                : argv.length === 2 && argv[0] === 'profiles' && argv[1] === 'current'
                    ? 'profiles-current'
                    : argv.length === 3 && argv[0] === 'profiles' && argv[1] === 'activate' &&
                        argv[2].length > 0 && !argv[2].startsWith('-')
                        ? 'profiles-activate'
                        : undefined;

    if (!command) {
        dependencies.stderr(`tcc-cli: Invalid command.\n${usage}`);
        return 2;
    }

    let client: CliClient | undefined;
    try {
        client = dependencies.createClient();
        await connect(client);

        if (profileCommand) {
            const io = dependencies.createProfileIO();
            await runProfileCommand(profileCommand, client, io, dependencies.stdout);
            return 0;
        }

        if (command === 'profiles-activate') {
            const profileId = argv[2];
            const profiles = parseProfiles(await client.getProfilesJSON(), 'profile list') as ITccProfile[];
            if (!profiles.some((profile): boolean => profile.id === profileId)) {
                throw new Error(`tcc-cli: Unknown profile ID: ${profileId}.`);
            }
            if (await client.setTempProfileById(profileId) !== true) {
                throw new Error(`tcc-cli: tccd rejected profile activation: ${profileId}.`);
            }
            const activeProfile = parseProfiles(await client.getActiveProfileJSON(), 'active profile') as ITccProfile;
            if (activeProfile.id !== profileId) {
                throw new Error(`tcc-cli: tccd did not activate profile: ${profileId}.`);
            }
            dependencies.stdout(`Activated temporary profile: ${activeProfile.name} [${activeProfile.id}]\n`);
            return 0;
        }

        if (command === 'profiles-list') {
            const profiles = parseProfiles(await client.getProfilesJSON(), 'profile list') as ITccProfile[];
            dependencies.stdout(`ID\tNAME\n${profiles.map(displayProfile).join('')}`);
            return 0;
        }

        if (command === 'profiles-current') {
            const profile = parseProfiles(await client.getActiveProfileJSON(), 'active profile') as ITccProfile;
            dependencies.stdout(`ID\tNAME\n${displayProfile(profile)}`);
            return 0;
        }

        const version = await client.tccdVersion();
        if (typeof version !== 'string' || version.length === 0) {
            throw invalid('version');
        }
        const deviceJSON = await client.getDeviceJSON();
        let device: unknown;
        try {
            device = JSON.parse(deviceJSON as string) as unknown;
        } catch {
            throw invalid('device');
        }
        if (typeof device !== 'number' || !Number.isFinite(device) || !Number.isInteger(device)) {
            throw invalid('device');
        }
        const deviceLabel = Object.prototype.hasOwnProperty.call(TUXEDODevice, device)
            ? TUXEDODevice[device]
            : String(device);
        const activeProfile = parseProfiles(await client.getActiveProfileJSON(), 'active profile') as ITccProfile;
        dependencies.stdout(
            `Daemon: available\nVersion: ${version}\nDevice: ${deviceLabel}\nActive profile: ${activeProfile.name} [${activeProfile.id}]\n`,
        );
        return 0;
    } catch (error: unknown) {
        const message = errorText(error);
        dependencies.stderr(message.startsWith('tcc-cli: ') ? message : `tcc-cli: ${message}`);
        return 1;
    } finally {
        client?.disconnect();
    }
}
