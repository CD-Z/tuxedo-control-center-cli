import { isDeepStrictEqual } from 'node:util';
import { PowerProfilesConfig } from '../common/classes/PowerProfilesConfig';
import type { ITccProfile } from '../common/models/TccProfile';
import type { ITccSettings } from '../common/models/TccSettings';
import type { PowerProfilesRuntimeState, StandardProfile } from '../common/models/PowerProfiles';
import { resolveProfile } from './profile-selector';
import type { CliClient, CliDependencies } from './cli';

export type PpdCommand =
    | { kind: 'status' }
    | { kind: 'disable' }
    | {
          kind: 'enable' | 'configure';
          mappings: Partial<Record<StandardProfile, string>>;
          ac?: StandardProfile;
          battery?: StandardProfile;
      };
export type PpdParseResult = PpdCommand | { kind: 'unhandled' } | { kind: 'invalid'; message: string };

const mappingOptions: Readonly<Record<string, StandardProfile>> = {
    '--power-saver': 'power-saver',
    '--balanced': 'balanced',
    '--performance': 'performance',
};
const assignmentOptions: Readonly<Record<string, 'ac' | 'battery'>> = {
    '--ac': 'ac',
    '--battery': 'battery',
};
const standards = new Set<StandardProfile>(['power-saver', 'balanced', 'performance']);

export function parsePpdCommand(argv: readonly string[]): PpdParseResult {
    if (argv[0] !== 'ppd') return { kind: 'unhandled' };
    if (argv.length === 1) return { kind: 'invalid', message: 'tcc-cli: Missing ppd command.' };
    const kind = argv[1];
    if (kind !== 'status' && kind !== 'enable' && kind !== 'disable' && kind !== 'configure') {
        return {
            kind: 'invalid',
            message: `tcc-cli: Unknown ppd command: ${JSON.stringify(kind)}.`,
        };
    }
    if (kind === 'status' || kind === 'disable') {
        if (argv.length !== 2)
            return {
                kind: 'invalid',
                message: `tcc-cli: ${kind} does not accept options or arguments.`,
            };
        return { kind };
    }
    const mappings: Partial<Record<StandardProfile, string>> = {};
    const assignments: Partial<Record<'ac' | 'battery', StandardProfile>> = {};
    const seen = new Set<string>();
    for (let i = 2; i < argv.length; i++) {
        const token = argv[i];
        const equal = token.indexOf('=');
        const option = equal < 0 ? token : token.slice(0, equal);
        if (!(option in mappingOptions) && !(option in assignmentOptions)) {
            return {
                kind: 'invalid',
                message: `tcc-cli: Unknown ppd option: ${JSON.stringify(token)}.`,
            };
        }
        if (seen.has(option))
            return {
                kind: 'invalid',
                message: `tcc-cli: Repeated option: ${option}.`,
            };
        seen.add(option);
        const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
        if (value === undefined || value.length === 0 || value.startsWith('--')) {
            return {
                kind: 'invalid',
                message: `tcc-cli: Missing value for ${option}.`,
            };
        }
        if (option in mappingOptions) {
            const standard = mappingOptions[option];
            if (value === 'none' && standard !== 'performance') {
                return {
                    kind: 'invalid',
                    message: `tcc-cli: "none" is only valid for --performance.`,
                };
            }
            mappings[standard] = value;
        } else {
            if (!standards.has(value as StandardProfile)) {
                return {
                    kind: 'invalid',
                    message: `tcc-cli: Invalid standard profile for ${option}: ${JSON.stringify(value)}.`,
                };
            }
            assignments[assignmentOptions[option]] = value as StandardProfile;
        }
    }
    if (kind === 'configure' && seen.size === 0)
        return {
            kind: 'invalid',
            message: 'tcc-cli: configure requires at least one option.',
        };
    return {
        kind,
        mappings,
        ...(assignments.ac === undefined ? {} : { ac: assignments.ac }),
        ...(assignments.battery === undefined ? {} : { battery: assignments.battery }),
    };
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsedSettings(json: string | undefined): ITccSettings {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json as string) as unknown;
    } catch {
        throw new Error('tcc-cli: tccd returned invalid settings data.');
    }
    if (
        !record(parsed) ||
        !record(parsed.stateMap) ||
        typeof parsed.stateMap.power_ac !== 'string' ||
        typeof parsed.stateMap.power_bat !== 'string'
    ) {
        throw new Error('tcc-cli: tccd returned invalid settings data.');
    }
    if (parsed.ppd !== undefined && !record(parsed.ppd))
        throw new Error('tcc-cli: tccd returned invalid power-profiles settings.');
    if (record(parsed.ppd) && parsed.ppd.profiles !== undefined && !record(parsed.ppd.profiles)) {
        throw new Error('tcc-cli: tccd returned invalid power-profile mappings.');
    }
    return parsed as unknown as ITccSettings;
}

function catalogProfiles(json: string | undefined): ITccProfile[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json as string) as unknown;
    } catch {
        throw new Error('tcc-cli: tccd returned invalid profile list data.');
    }
    if (
        !Array.isArray(parsed) ||
        !parsed.every(
            (profile) =>
                record(profile) &&
                typeof profile.id === 'string' &&
                profile.id.length > 0 &&
                typeof profile.name === 'string',
        )
    ) {
        throw new Error('tcc-cli: tccd returned invalid profile list data.');
    }
    const ids = new Set<string>();
    for (const profile of parsed as ITccProfile[]) {
        if (ids.has(profile.id)) throw new Error(`tcc-cli: tccd returned duplicate profile ID: ${profile.id}.`);
        ids.add(profile.id);
    }
    return parsed as ITccProfile[];
}

function settingsAndPpd(settings: ITccSettings): {
    settings: ITccSettings;
    ppd: NonNullable<ITccSettings['ppd']>;
} {
    if (settings.ppd === undefined) settings.ppd = { enabled: false };
    if (typeof settings.ppd.enabled !== 'boolean') throw new Error('tcc-cli: Invalid power-profiles enabled setting.');
    if (settings.ppd.profiles !== undefined) {
        if (!record(settings.ppd.profiles)) throw new Error('tcc-cli: Invalid power-profile mappings.');
        for (const [key, value] of Object.entries(settings.ppd.profiles)) {
            if (
                !standards.has(key as StandardProfile) ||
                (typeof value !== 'string' && !(key === 'performance' && value === null)) ||
                (typeof value === 'string' && value.length === 0)
            ) {
                throw new Error('tcc-cli: Invalid power-profile mappings.');
            }
        }
    }
    return { settings, ppd: settings.ppd };
}

function profileName(profiles: readonly ITccProfile[], id: string): string {
    return profiles.find((profile) => profile.id === id)?.name ?? 'unavailable';
}

function formatProviderConflict(state: Extract<PowerProfilesRuntimeState, { state: 'other-provider' }>): string[] {
    return [
        'Conflict: org.freedesktop.UPower.PowerProfiles is owned by another provider.',
        `Competing D-Bus owner: ${JSON.stringify(state.owner)}`,
        ...(state.pid === undefined ? [] : [`Competing PID: ${state.pid}`]),
        ...(state.unit === undefined
            ? [
                  'Competing unit: unavailable',
                  `Inspect the owner with busctl --system status ${JSON.stringify(state.owner)}.`,
              ]
            : [`Competing unit: ${JSON.stringify(state.unit)}`]),
    ];
}

async function showStatus(client: CliClient, stdout: (text: string) => void): Promise<void> {
    const settings = parsedSettings(await client.getSettingsJSON());
    const profiles = catalogProfiles(await client.getProfilesJSON());
    const { ppd } = settingsAndPpd(settings);
    const state = await client.getPowerProfilesRuntimeState();
    let mappings: Partial<Record<StandardProfile, string>> = {};
    if (ppd.enabled) mappings = PowerProfilesConfig.resolveCatalog(settings as unknown as ITccSettings, profiles);
    const standardsInOrder: StandardProfile[] = ['power-saver', 'balanced', 'performance'];
    const lines = [
        `Enabled: ${ppd.enabled ? 'yes' : 'no'}`,
        `Provider: ${state.state}`,
        ...(state.state === 'other-provider' ? formatProviderConflict(state) : []),
        `Active profile: ${state.state === 'active' ? state.activeProfile : 'unavailable'}`,
        `Saved AC: ${settings.stateMap.power_ac}`,
        `Saved battery: ${settings.stateMap.power_bat}`,
        'STANDARD\tID\tNAME',
    ];
    for (const standard of standardsInOrder) {
        let id = mappings[standard];
        if (!ppd.enabled) {
            const overrides = ppd.profiles;
            const value = overrides?.[standard];
            id = value === null ? undefined : typeof value === 'string' ? value : undefined;
            if (value === undefined) {
                lines.push(`${standard}\tdefault\tdefault`);
                continue;
            }
            if (value === null) {
                lines.push(`${standard}\tnone\tnone`);
                continue;
            }
        }
        lines.push(
            `${standard}\t${id ?? 'unavailable'}\t${id === undefined ? 'unavailable' : profileName(profiles, id)}`,
        );
    }
    stdout(`${lines.join('\n')}\n`);
}

export async function runPpdCommand(
    command: PpdCommand,
    client: CliClient,
    dependencies: Pick<CliDependencies, 'createProfileIO' | 'stdout'>,
): Promise<void> {
    if (command.kind === 'status') {
        await showStatus(client, dependencies.stdout);
        return;
    }
    const settings = parsedSettings(await client.getSettingsJSON());
    const profiles = catalogProfiles(await client.getProfilesJSON());
    const { ppd } = settingsAndPpd(settings);
    if (command.kind === 'disable') {
        ppd.enabled = false;
    } else {
        for (const [standard, selector] of Object.entries(command.mappings) as [StandardProfile, string][]) {
            const exactId = profiles.find((profile) => profile.id === selector);
            if (exactId) {
                ppd.profiles ??= {};
                ppd.profiles[standard] = exactId.id;
            } else if (selector === 'default') {
                delete ppd.profiles?.[standard];
            } else if (selector === 'none' && standard === 'performance') {
                ppd.profiles ??= {};
                ppd.profiles.performance = null;
            } else if (selector === 'none') {
                throw new Error(`tcc-cli: "none" is only valid for --performance unless it is an exact profile ID.`);
            } else {
                ppd.profiles ??= {};
                ppd.profiles[standard] = resolveProfile(profiles, selector).id;
            }
        }
        const resolved = PowerProfilesConfig.resolveMappings(ppd.profiles, profiles);
        if (command.ac !== undefined) {
            const id = resolved[command.ac];
            if (id === undefined)
                throw new Error(
                    `tcc-cli: No TCC mapping exists for ${command.ac}; set its mapping before assigning it.`,
                );
            settings.stateMap.power_ac = id;
        }
        if (command.battery !== undefined) {
            const id = resolved[command.battery];
            if (id === undefined)
                throw new Error(
                    `tcc-cli: No TCC mapping exists for ${command.battery}; set its mapping before assigning it.`,
                );
            settings.stateMap.power_bat = id;
        }
        const validating = {
            ...settings,
            ppd: { ...ppd, enabled: true },
        } as ITccSettings;
        try {
            PowerProfilesConfig.resolveCatalog(validating, profiles);
        } catch (error: unknown) {
            if (
                error instanceof Error &&
                (error.message.includes('Saved power_ac assignment') ||
                    error.message.includes('Saved power_bat assignment'))
            ) {
                throw new Error(
                    `tcc-cli: ${error.message}. Supply --ac and/or --battery to select mapped assignments.`,
                );
            }
            throw error;
        }
        if (command.kind === 'enable') ppd.enabled = true;
    }
    const io = dependencies.createProfileIO();
    await io.saveSettings(`${JSON.stringify(settings, null, 2)}\n`);
    const adopted = parsedSettings(await client.getSettingsJSON());
    if (
        !record(adopted.ppd) ||
        !isDeepStrictEqual(adopted.ppd, ppd) ||
        !isDeepStrictEqual(adopted.stateMap, settings.stateMap)
    ) {
        throw new Error(
            'tcc-cli: Settings were saved but tccd did not adopt the requested power-profiles configuration.',
        );
    }
    const state = await client.getPowerProfilesRuntimeState();
    if (ppd.enabled && state.state !== 'active') {
        const conflict = state.state === 'other-provider' ? `\n${formatProviderConflict(state).join('\n')}` : '';
        throw new Error(
            `tcc-cli: Settings remain saved, but the TCC provider is ${state.state}.${conflict}${conflict === '' ? ' Check provider policies, competing providers, and tccd logs.' : ''}`,
        );
    }
    if (command.kind === 'disable' && state.state === 'active') {
        throw new Error('tcc-cli: Settings were saved, but TCC still owns the provider name.');
    }
    dependencies.stdout(`Power-profiles settings ${ppd.enabled ? 'enabled' : 'disabled'}.\n`);
}
