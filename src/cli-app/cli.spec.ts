import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigHandler } from '../common/classes/ConfigHandler';
import { TUXEDODevice } from '../common/models/DefaultProfiles';
import { defaultCustomProfile } from '../common/models/DefaultProfiles';
import type { ITccProfile } from '../common/models/TccProfile';

import type { CliClient } from './cli';
import { runCli } from './cli';
import type { ProfileIO } from './profile-io';

interface TestClientValues {
    init?: boolean | (() => Promise<boolean>);
    available?: boolean | (() => Promise<boolean>);
    version?: string;
    device?: string;
    profiles?: string;
    defaultProfiles?: string;
    defaultValuesProfile?: string;
    activeProfile?: string;
    setterResult?: boolean | undefined;
    rejectSetter?: boolean;
    rejectProfiles?: boolean;
    isX11?: number;
    fansOffAvailable?: boolean;
    fansMinSpeed?: number;
    odmNames?: string[];
    nvidiaAvailable?: boolean;
    nvidiaUnsupported?: boolean;
    nvidiaDefaultLimit?: number;
    nvidiaMaximumLimit?: number;
}

interface MemoryProfileIO extends ProfileIO {
    savedProfiles: string;
    saveCalls: number;
    readCalls: number;
    baseSelection?: (profiles: readonly { id: string; name: string }[]) => Promise<string | undefined>;
    editor?: (json: string) => Promise<string | undefined>;
}


function makeProfile(id: string, name: string): ITccProfile {
    const profile = structuredClone(defaultCustomProfile);
    profile.id = id;
    profile.name = name;
    profile.cpu.onlineCores = 8;
    profile.cpu.scalingMinFrequency = 400_000;
    profile.cpu.scalingMaxFrequency = 4_000_000;
    profile.odmProfile.name = 'Balanced';
    return profile;
}

const builtInProfile = makeProfile('builtin', 'Built-in');

function createMemoryProfileIO(savedProfiles = '[]'): MemoryProfileIO {
    const io: MemoryProfileIO = {
        savedProfiles,
        saveCalls: 0,
        readCalls: 0,
        async readSavedProfiles(): Promise<string> {
            io.readCalls += 1;
            return io.savedProfiles;
        },
        async saveProfiles(json: string): Promise<void> {
            io.saveCalls += 1;
            io.savedProfiles = json;
        },
        async selectBase(profiles): Promise<string | undefined> {
            return io.baseSelection ? io.baseSelection(profiles) : profiles[0]?.id;
        },
        async editProfile(json: string): Promise<string | undefined> {
            return io.editor ? io.editor(json) : json;
        },
        async readCpuCapabilities(): Promise<{
            energyPreferences?: string[];
            turboAvailable: boolean;
            reducedFrequency?: number;
        }> {
            return {
                energyPreferences: ['balance_performance', 'performance'],
                turboAvailable: true,
                reducedFrequency: 3_600_000,
            };
        },
    };
    return io;
}

async function execute(
    argv: string[],
    values: TestClientValues = {},
    profileIO: MemoryProfileIO = createMemoryProfileIO(),
): Promise<{ code: number; stdout: string; stderr: string; profileIO: MemoryProfileIO; activationCalls: number }> {
    let stdout = '';
    let stderr = '';
    let activationCalls = 0;
    const client = {
        init: async (): Promise<boolean> => typeof values.init === 'function' ? values.init() : values.init ?? true,
        dbusAvailable: async (): Promise<boolean> =>
            typeof values.available === 'function' ? values.available() : values.available ?? true,
        tccdVersion: async (): Promise<string> => values.version ?? 'test-version',
        getDeviceJSON: async (): Promise<string> => values.device ?? '1',
        getProfilesJSON: async (): Promise<string> => {
            if (values.rejectProfiles) {
                throw new Error('getter failed');
            }
            return values.profiles ?? '[]';
        },
        getActiveProfileJSON: async (): Promise<string> => values.activeProfile ?? '{"id":"office","name":"Office"}',
        getDefaultProfilesJSON: async (): Promise<string> =>
            values.defaultProfiles ?? JSON.stringify([builtInProfile]),
        getDefaultValuesProfileJSON: async (): Promise<string> => values.defaultValuesProfile ??
            JSON.stringify({ cpu: { onlineCores: 8, scalingMinFrequency: 400_000, scalingMaxFrequency: 4_000_000 } }),
        getIsX11: async (): Promise<number> => values.isX11 ?? 1,
        getDisplayModesJSON: async (): Promise<string> => JSON.stringify({
            displayName: 'test',
            activeMode: { xResolution: 1920, yResolution: 1080, refreshRates: [60] },
            displayModes: [{ xResolution: 1920, yResolution: 1080, refreshRates: [60] }],
        }),
        getFansOffAvailable: async (): Promise<boolean> => values.fansOffAvailable ?? true,
        getFansMinSpeed: async (): Promise<number> => values.fansMinSpeed ?? 20,
        odmProfilesAvailable: async (): Promise<string[]> => values.odmNames ?? ['Balanced'],
        odmPowerLimits: async (): Promise<Array<{ min: number; max: number; current: number; descriptor: string }>> => [
            { min: 20, max: 80, current: 50, descriptor: 'test' },
        ],
        getNVIDIAPowerCTRLAvailable: async (): Promise<boolean> => values.nvidiaAvailable ?? true,
        getNVIDIAPowerCTRLDefaultPowerLimit: async (): Promise<number> => values.nvidiaDefaultLimit ?? 100,
        getNVIDIAPowerCTRLMaxPowerLimit: async (): Promise<number> => values.nvidiaMaximumLimit ?? 200,
        getIsUnsupportedConfigurableTGPDevice: async (): Promise<boolean> => values.nvidiaUnsupported ?? false,
        setTempProfileById: async (id: string): Promise<boolean> => {
            activationCalls += 1;
            if (values.rejectSetter) {
                throw new Error('setter failed');
            }
            if (!Object.prototype.hasOwnProperty.call(values, 'activeProfile') &&
                (!Object.prototype.hasOwnProperty.call(values, 'setterResult') || values.setterResult === true)) {
                const selected = (JSON.parse(values.profiles ?? '[]') as Array<{ id: string; name: string }>)
                    .find((profile): boolean => profile.id === id);
                if (selected) {
                    values.activeProfile = JSON.stringify(selected);
                }
            }
            return Object.prototype.hasOwnProperty.call(values, 'setterResult')
                ? values.setterResult as boolean
                : true;
        },
        disconnect: (): void => undefined,
    } as CliClient;
    const code = await runCli(argv, {
        createClient: (): CliClient => client,
        createProfileIO: (): ProfileIO => profileIO,
        stdout: (text: string): void => { stdout += text; },
        stderr: (text: string): void => { stderr += text; },
    });
    return { code, stdout, stderr, profileIO, activationCalls };
}

describe('runCli', (): void => {
    it('prints daemon status and renders device ID zero as UNKNOWN', async (): Promise<void> => {
        const result = await execute(['status'], { device: '0' });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
            'Daemon: available\nVersion: test-version\nDevice: UNKNOWN\nActive profile: Office [office]\n',
        );
        expect(result.stderr).toBe('');
    });
    it('prints unknown numeric device IDs unchanged', async (): Promise<void> => {
        const result = await execute(['status'], { device: '987654' });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Device: 987654\n');
        expect(result.stderr).toBe('');
    });


    it('lists profiles in daemon order with their original names', async (): Promise<void> => {
        const result = await execute(['profiles', 'list'], {
            profiles: '[{"id":"quiet","name":"Quiet mode"},{"id":"custom-1","name":"My setup"}]',
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('ID\tNAME\nquiet\tQuiet mode\ncustom-1\tMy setup\n');
        expect(result.stderr).toBe('');
    });

    it('prints the active profile row', async (): Promise<void> => {
        const result = await execute(['profiles', 'current']);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('ID\tNAME\noffice\tOffice\n');
    });
    it('activates an exact profile ID and prints canonical readback data', async (): Promise<void> => {
        const result = await execute(['profiles', 'activate', 'office'], {
            profiles: '[{"id":"office","name":"Canonical Office"},{"id":"quiet","name":"Quiet"}]',
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('Activated temporary profile: Canonical Office [office]\n');
        expect(result.stderr).toBe('');
    });
    it('matches profile IDs exactly even when names are duplicated', async (): Promise<void> => {
        const result = await execute(['profiles', 'activate', 'Second'], {
            profiles: '[{"id":"First","name":"Shared"},{"id":"Second","name":"Shared"}]',
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('Activated temporary profile: Shared [Second]\n');
    });


    it('does not select an unknown profile ID', async (): Promise<void> => {
        const result = await execute(['profiles', 'activate', 'missing'], {
            profiles: '[{"id":"office","name":"Office"}]',
        });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: Unknown profile ID: missing.');
    });

    it('rejects an empty list as an unknown ID and malformed activation profile lists as invalid data', async (): Promise<void> => {
        const empty = await execute(['profiles', 'activate', 'office'], { profiles: '[]' });
        expect(empty.code).toBe(1);
        expect(empty.stdout).toBe('');
        expect(empty.stderr).toBe('tcc-cli: Unknown profile ID: office.');
        for (const profiles of ['{', '[{"id":"","name":"Broken"}]']) {
            const result = await execute(['profiles', 'activate', 'office'], { profiles });
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('tcc-cli: tccd returned invalid profile list data.');
        }
    });

    it('reports rejected, failed, or unconfirmed activation without success output', async (): Promise<void> => {
        const cases: Array<[TestClientValues, string]> = [
            [{ profiles: '[{"id":"office","name":"Office"}]', setterResult: false }, 'tcc-cli: tccd rejected profile activation: office.'],
            [{ profiles: '[{"id":"office","name":"Office"}]', setterResult: undefined }, 'tcc-cli: tccd rejected profile activation: office.'],
            [{ profiles: '[{"id":"office","name":"Office"}]', rejectSetter: true }, 'tcc-cli: setter failed'],
            [{ profiles: '[{"id":"office","name":"Office"}]', activeProfile: '{}' }, 'tcc-cli: tccd returned invalid active profile data.'],
            [{ profiles: '[{"id":"office","name":"Office"}]', activeProfile: '{"id":"quiet","name":"Quiet"}' }, 'tcc-cli: tccd did not activate profile: office.'],
        ];
        for (const [values, message] of cases) {
            const result = await execute(['profiles', 'activate', 'office'], values);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(message);
        }
    });

    it('prints only the header for a valid empty profile list', async (): Promise<void> => {
        const result = await execute(['profiles', 'list'], { profiles: '[]' });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('ID\tNAME\n');
    });

    it('rejects malformed profile JSON without partial output', async (): Promise<void> => {
        const result = await execute(['profiles', 'list'], { profiles: '{' });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: tccd returned invalid profile list data.');
    });

    it('rejects profiles without a displayable ID and name', async (): Promise<void> => {
        const result = await execute(['profiles', 'list'], { profiles: '[{"id":"","name":"Broken"}]' });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: tccd returned invalid profile list data.');
    });

    it('rejects empty active-profile data', async (): Promise<void> => {
        const result = await execute(['profiles', 'current'], { activeProfile: '{}' });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: tccd returned invalid active profile data.');
    });

    it('reports failed initialization and unavailable daemon', async (): Promise<void> => {
        for (const values of [{ init: false }, { available: false }]) {
            const result = await execute(['status'], values);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('tcc-cli: Cannot connect to tccd. Ensure tccd is running.');
        }
    });

    it('reports rejected getters without printing a successful result', async (): Promise<void> => {
        const result = await execute(['profiles', 'list'], { rejectProfiles: true });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: getter failed');
    });

    it('rejects invalid status fields', async (): Promise<void> => {
        for (const [values, field] of [
            [{ version: '' }, 'version'],
            [{ device: '"not-a-number"' }, 'device'],
            [{ activeProfile: '[]' }, 'active profile'],
        ] as const) {
            const result = await execute(['status'], values);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(`tcc-cli: tccd returned invalid ${field} data.`);
        }
    });

    it('creates an exact-base clone and merges it into the saved list without activating it', async (): Promise<void> => {
        const base = makeProfile('base "id" with spaces', 'Same "name"');
        const unrelated = JSON.parse(JSON.stringify(makeProfile('other id', 'Other'))) as Record<string, unknown>;
        unrelated['futureSetting'] = { keep: true };
        const initial = [base, unrelated];
        const io = createMemoryProfileIO(JSON.stringify(initial));
        const values = { profiles: JSON.stringify([builtInProfile, base]) };
        const result = await execute(['profiles', 'create', 'Same "name"', '--base', base.id], values, io);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toMatch(/^Created profile: Same "name" \[.+\]\n$/);
        expect(result.activationCalls).toBe(0);
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved.length).toBe(3);
        expect(saved[0]).toEqual(initial[0]);
        expect(saved[1]).toEqual(unrelated);
        expect(saved[2]['id']).not.toBe(base.id);
        expect(saved[2]['name']).toBe('Same "name"');
        expect(saved[2]['display']).toEqual(base.display);
        expect(io.saveCalls).toBe(1);
    });
    it('uses a built-in as an exact base and rejects ambiguous daemon lists', async (): Promise<void> => {
        const io = createMemoryProfileIO();
        const created = await execute(
            ['profiles', 'create', 'Built-in copy', '--base', 'builtin'],
            { profiles: JSON.stringify([builtInProfile]) },
            io,
        );
        expect(created.code).toBe(0);
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['id']).not.toBe(builtInProfile.id);
        expect(saved[0]['name']).toBe('Built-in copy');
        expect(saved[0]['cpu']).toEqual(builtInProfile.cpu);

        const duplicateIO = createMemoryProfileIO();
        const duplicate = await execute(
            ['profiles', 'create', 'Copy', '--base', 'builtin'],
            { profiles: JSON.stringify([builtInProfile, builtInProfile]) },
            duplicateIO,
        );
        expect(duplicate.code).toBe(1);
        expect(duplicate.stderr).toBe('tcc-cli: tccd returned invalid profile list data.');
        expect(duplicateIO.saveCalls).toBe(0);
    });


    it('requires an explicit base off-terminal and uses or cancels the selected base', async (): Promise<void> => {
        const first = makeProfile('first', 'First');
        const second = makeProfile('second', 'Second');
        first.fan.offsetFanspeed = 12;
        second.fan.offsetFanspeed = 34;
        const profiles = JSON.stringify([first, second]);

        const noninteractiveIO = createMemoryProfileIO();
        noninteractiveIO.baseSelection = async (): Promise<string | undefined> => {
            throw new Error('tcc-cli: --base is required without an interactive terminal.');
        };
        const noninteractive = await execute(['profiles', 'create', 'Copy'], { profiles }, noninteractiveIO);
        expect(noninteractive.code).toBe(1);
        expect(noninteractive.stderr).toBe('tcc-cli: --base is required without an interactive terminal.');
        expect(noninteractiveIO.saveCalls).toBe(0);

        const selectedIO = createMemoryProfileIO();
        selectedIO.baseSelection = async (choices): Promise<string | undefined> => choices[1]?.id;
        const selected = await execute(['profiles', 'create', 'Copy'], { profiles }, selectedIO);
        expect(selected.code).toBe(0);
        const selectedProfiles = JSON.parse(selectedIO.savedProfiles) as Array<Record<string, unknown>>;
        expect((selectedProfiles[0]['fan'] as Record<string, unknown>)['offsetFanspeed']).toBe(34);

        const cancelledIO = createMemoryProfileIO();
        cancelledIO.baseSelection = async (): Promise<string | undefined> => undefined;
        const cancelled = await execute(['profiles', 'create', 'Copy'], { profiles }, cancelledIO);
        expect(cancelled.code).toBe(1);
        expect(cancelled.stdout).toBe('');
        expect(cancelled.stderr).toBe('tcc-cli: Profile operation cancelled.');
        expect(cancelledIO.saveCalls).toBe(0);
    });

    it('shows built-ins from the daemon and custom profiles from the raw saved document', async (): Promise<void> => {
        const raw = JSON.parse(JSON.stringify(makeProfile('custom with spaces', 'Custom'))) as Record<string, unknown>;
        const cpu = raw['cpu'] as Record<string, unknown>;
        delete cpu['onlineCores'];
        delete cpu['scalingMinFrequency'];
        raw['futureSetting'] = { mode: 'untouched' };
        const io = createMemoryProfileIO(JSON.stringify([raw]));
        const builtIn = await execute(['profiles', 'show', 'builtin'], {}, io);
        expect(builtIn.code).toBe(0);
        expect(builtIn.stdout).toBe(`${JSON.stringify(builtInProfile, null, 2)}\n`);
        expect(io.readCalls).toBe(0);

        const custom = await execute(['profiles', 'show', 'custom with spaces'], {}, io);
        expect(custom.code).toBe(0);
        const shown = JSON.parse(custom.stdout) as Record<string, unknown>;
        expect(shown['id']).toBe('custom with spaces');
        expect(shown['futureSetting']).toEqual({ mode: 'untouched' });
        expect(Object.prototype.hasOwnProperty.call(shown['cpu'], 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(shown['cpu'], 'scalingMinFrequency')).toBe(false);
        expect(custom.stdout.endsWith('\n')).toBe(true);
    });
    it('reports unknown custom IDs after inspecting the raw saved list', async (): Promise<void> => {
        const io = createMemoryProfileIO('[]');
        const result = await execute(['profiles', 'show', 'missing'], {}, io);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: Unknown profile ID: missing.');
        expect(io.readCalls).toBe(1);
        expect(io.saveCalls).toBe(0);
    });


    it('rejects built-in edits and unknown custom IDs without writing', async (): Promise<void> => {
        for (const [id, expected] of [
            ['builtin', 'tcc-cli: Built-in profile is read-only: builtin. Create a profile with --base builtin instead.'],
            ['missing', 'tcc-cli: Unknown profile ID: missing.'],
        ] as const) {
            const io = createMemoryProfileIO('[]');
            const result = await execute(['profiles', 'edit', id, '--description', 'changed'], {}, io);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(expected);
            expect(io.saveCalls).toBe(0);
            expect(io.readCalls).toBe(id === 'builtin' ? 0 : 1);
        }
    });

    it('applies named settings to only their stored fields and preserves zero values', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const io = createMemoryProfileIO();
        const result = await execute([
            'profiles', 'create', 'Configured', '--base=base',
            '--brightness=0', '--refresh-rate', '60', '--webcam', 'off',
            '--cpu-cores', '2', '--cpu-min-frequency', '600000', '--cpu-max-frequency', '3500000',
            '--cpu-max-performance', 'off', '--cpu-energy-preference', 'performance', '--cpu-turbo', 'off',
            '--fan-min-speed', '0', '--nvidia-power-offset', '0',
        ], { profiles: JSON.stringify([base]) }, io);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        const created = saved[0];
        expect((created['display'] as Record<string, unknown>)['brightness']).toBe(0);
        expect((created['display'] as Record<string, unknown>)['useBrightness']).toBe(true);
        expect((created['display'] as Record<string, unknown>)['useRefRate']).toBe(true);
        expect((created['webcam'] as Record<string, unknown>)['status']).toBe(false);
        expect((created['webcam'] as Record<string, unknown>)['useStatus']).toBe(true);
        const cpu = created['cpu'] as Record<string, unknown>;
        expect(cpu['onlineCores']).toBe(2);
        expect(cpu['scalingMinFrequency']).toBe(600_000);
        expect(cpu['scalingMaxFrequency']).toBe(3_500_000);
        expect(cpu['energyPerformancePreference']).toBe('performance');
        expect(cpu['noTurbo']).toBe(true);
        expect((created['fan'] as Record<string, unknown>)['minimumFanspeed']).toBe(0);
        expect((created['nvidiaPowerCTRLProfile'] as Record<string, unknown>)['cTGPOffset']).toBe(0);
    });

    it('resolves all/default/max dynamically and stores reduced maximum frequency as -1', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const allIO = createMemoryProfileIO();
        const allResult = await execute([
            'profiles', 'create', 'Dynamic', '--base', 'base',
            '--cpu-cores', 'all', '--cpu-min-frequency', 'default', '--cpu-max-frequency', 'max',
        ], { profiles: JSON.stringify([base]) }, allIO);
        expect(allResult.code).toBe(0);
        const dynamic = JSON.parse(allIO.savedProfiles) as Array<Record<string, unknown>>;
        const dynamicCpu = dynamic[0]['cpu'] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(dynamicCpu, 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(dynamicCpu, 'scalingMinFrequency')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(dynamicCpu, 'scalingMaxFrequency')).toBe(false);

        const reducedIO = createMemoryProfileIO();
        const reduced = await execute([
            'profiles', 'create', 'Reduced', '--base', 'base', '--cpu-max-frequency', 'reduced',
        ], { profiles: JSON.stringify([base]) }, reducedIO);
        expect(reduced.code).toBe(0);
        expect(
            ((JSON.parse(reducedIO.savedProfiles) as Array<Record<string, unknown>>)[0]['cpu'] as Record<string, unknown>)
            ['scalingMaxFrequency'],
        ).toBe(-1);
    });

    it('validates minimum and maximum frequency after applying either flag order', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        for (const settings of [
            ['--cpu-min-frequency', '600000', '--cpu-max-frequency', '3500000'],
            ['--cpu-max-frequency', '3500000', '--cpu-min-frequency', '600000'],
        ]) {
            const io = createMemoryProfileIO();
            const result = await execute(
                ['profiles', 'create', 'Pair', '--base', 'base', ...settings],
                { profiles: JSON.stringify([base]) },
                io,
            );
            expect(result.code).toBe(0);
            const cpu = (JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>)[0]['cpu'] as Record<string, unknown>;
            expect(cpu['scalingMinFrequency']).toBe(600_000);
            expect(cpu['scalingMaxFrequency']).toBe(3_500_000);
        }
    });
    it('rejects inverted frequencies and settings outside device capabilities without saving', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const invertedIO = createMemoryProfileIO();
        const inverted = await execute([
            'profiles', 'create', 'Inverted', '--base', 'base',
            '--cpu-min-frequency', '3900000', '--cpu-max-frequency', '3500000',
        ], { profiles: JSON.stringify([base]) }, invertedIO);
        expect(inverted.code).toBe(1);
        expect(inverted.stdout).toBe('');
        expect(inverted.stderr).toContain('tcc-cli: Invalid profile setting: cpu.scalingMinFrequency:');
        expect(invertedIO.saveCalls).toBe(0);

        const capabilityFailures: Array<{
            args: string[];
            values: TestClientValues;
            expectedPath: string;
        }> = [
                {
                    args: ['--refresh-rate', '60'],
                    values: { isX11: 0 },
                    expectedPath: 'display.refreshRate',
                },
                {
                    args: ['--fan-min-speed', '0'],
                    values: { fansOffAvailable: false },
                    expectedPath: 'fan.minimumFanspeed',
                },
                {
                    args: ['--odm-profile', 'Unavailable'],
                    values: { odmNames: ['Balanced'] },
                    expectedPath: 'odmProfile.name',
                },
                {
                    args: ['--nvidia-power-offset', '101'],
                    values: {},
                    expectedPath: 'nvidiaPowerCTRLProfile.cTGPOffset',
                },
            ];
        for (const { args, values, expectedPath } of capabilityFailures) {
            const io = createMemoryProfileIO();
            const result = await execute(
                ['profiles', 'create', 'Unsupported', '--base', 'base', ...args],
                { ...values, profiles: JSON.stringify([base]) },
                io,
            );
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain(`tcc-cli: Invalid profile setting: ${expectedPath}:`);
            expect(io.saveCalls).toBe(0);
        }
    });


    it('rejects dormant CPU and Custom fan controls unless the same command enables them', async (): Promise<void> => {
        const maxPerfBase = makeProfile('base', 'Base');
        maxPerfBase.cpu.useMaxPerfGov = true;
        const rejected = await execute(
            ['profiles', 'create', 'Rejected', '--base', 'base', '--cpu-min-frequency', '500000'],
            { profiles: JSON.stringify([maxPerfBase]) },
        );
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).toBe('');
        expect(rejected.stderr).toContain('tcc-cli: Invalid profile setting: cpu.scalingMinFrequency:');

        const enabled = await execute([
            'profiles', 'create', 'Enabled', '--base', 'base', '--cpu-max-performance', 'off',
            '--cpu-min-frequency', '500000', '--cpu-energy-preference', 'performance',
        ], { profiles: JSON.stringify([maxPerfBase]) });
        expect(enabled.code).toBe(0);

        const customBase = makeProfile('custom-base', 'Custom base');
        const customConflict = await execute([
            'profiles', 'create', 'Custom', '--base', 'custom-base',
            '--fan-profile', 'Custom', '--fan-min-speed', '30',
        ], { profiles: JSON.stringify([customBase]) });
        expect(customConflict.code).toBe(1);
        expect(customConflict.stdout).toBe('');
        expect(customConflict.stderr).toContain('tcc-cli: Invalid profile setting: fan.minimumFanspeed:');
    });

    it('edits only a changed raw target and preserves concurrent unrelated profile changes', async (): Promise<void> => {
        const target = JSON.parse(JSON.stringify(makeProfile('target', 'Target'))) as Record<string, unknown>;
        const targetCpu = target['cpu'] as Record<string, unknown>;
        delete targetCpu['onlineCores'];
        delete targetCpu['scalingMinFrequency'];
        target['futureSetting'] = { keep: 'raw value' };
        const other = makeProfile('other', 'Other');
        const io = createMemoryProfileIO(JSON.stringify([target, other]));
        io.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            edited['description'] = 'Updated description';
            const latest = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
            latest[1]['description'] = 'Concurrent unrelated update';
            io.savedProfiles = JSON.stringify(latest);
            return JSON.stringify(edited);
        };
        const result = await execute(['profiles', 'edit', 'target', '--editor'], {}, io);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('Updated profile: Target [target]\n');
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['description']).toBe('Updated description');
        expect(saved[0]['futureSetting']).toEqual({ keep: 'raw value' });
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'scalingMinFrequency')).toBe(false);
        expect(saved[1]['description']).toBe('Concurrent unrelated update');
        expect(io.saveCalls).toBe(1);
    });

    it('skips saves for unchanged edits and rejects editor ID changes or target conflicts', async (): Promise<void> => {
        const target = makeProfile('target', 'Target');
        const noChangeIO = createMemoryProfileIO(JSON.stringify([target]));
        const noChange = await execute(['profiles', 'edit', 'target', '--editor'], {}, noChangeIO);
        expect(noChange.code).toBe(0);
        expect(noChange.stdout).toBe('No changes to profile: Target [target]\n');
        expect(noChangeIO.saveCalls).toBe(0);

        const changedIdIO = createMemoryProfileIO(JSON.stringify([target]));
        changedIdIO.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            edited['id'] = 'new-id';
            return JSON.stringify(edited);
        };
        const changedId = await execute(['profiles', 'edit', 'target', '--editor'], {}, changedIdIO);
        expect(changedId.code).toBe(1);
        expect(changedId.stdout).toBe('');
        expect(changedId.stderr).toBe('tcc-cli: Invalid profile setting: id: cannot be changed.');
        expect(changedIdIO.saveCalls).toBe(0);

        const invalidJsonIO = createMemoryProfileIO(JSON.stringify([target]));
        invalidJsonIO.editor = async (): Promise<string> => '{';
        const invalidJson = await execute(['profiles', 'edit', 'target', '--editor'], {}, invalidJsonIO);
        expect(invalidJson.code).toBe(1);
        expect(invalidJson.stdout).toBe('');
        expect(invalidJson.stderr).toBe(
            'tcc-cli: Invalid profile setting: profile: editor returned invalid JSON.',
        );
        expect(invalidJsonIO.saveCalls).toBe(0);

        const cancelledIO = createMemoryProfileIO(JSON.stringify([target]));
        cancelledIO.editor = async (): Promise<undefined> => undefined;
        const cancelled = await execute(['profiles', 'edit', 'target', '--editor'], {}, cancelledIO);
        expect(cancelled.code).toBe(1);
        expect(cancelled.stdout).toBe('');
        expect(cancelled.stderr).toBe('tcc-cli: Profile operation cancelled.');
        expect(cancelledIO.saveCalls).toBe(0);

        const conflictIO = createMemoryProfileIO(JSON.stringify([target]));
        conflictIO.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            edited['description'] = 'Editor change';
            const latest = JSON.parse(conflictIO.savedProfiles) as Array<Record<string, unknown>>;
            latest[0]['description'] = 'Concurrent target change';
            conflictIO.savedProfiles = JSON.stringify(latest);
            return JSON.stringify(edited);
        };
        const conflict = await execute(['profiles', 'edit', 'target', '--editor'], {}, conflictIO);
        expect(conflict.code).toBe(1);
        expect(conflict.stdout).toBe('');
        expect(conflict.stderr).toBe('tcc-cli: Profile changed while editing: target. Run the command again.');
        expect(conflictIO.saveCalls).toBe(0);
    });
    it('rejects short editor fan curves and invalid or unsupported TDP values before saving', async (): Promise<void> => {
        const target = makeProfile('target', 'Target');
        const shortCurveIO = createMemoryProfileIO(JSON.stringify([target]));
        shortCurveIO.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            const fan = edited['fan'] as Record<string, unknown>;
            const curve = fan['customFanCurve'] as Record<string, unknown>;
            curve['tableCPU'] = (curve['tableCPU'] as unknown[]).slice(0, 2);
            return JSON.stringify(edited);
        };
        const shortCurve = await execute(['profiles', 'edit', 'target', '--editor'], {}, shortCurveIO);
        expect(shortCurve.code).toBe(1);
        expect(shortCurve.stdout).toBe('');
        expect(shortCurve.stderr).toContain(
            'tcc-cli: Invalid profile setting: fan.customFanCurve.tableCPU: must contain at least nine entries.',
        );
        expect(shortCurveIO.saveCalls).toBe(0);

        const decreasingTdpIO = createMemoryProfileIO(JSON.stringify([target]));
        decreasingTdpIO.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            const limits = edited['odmPowerLimits'] as Record<string, unknown>;
            limits['tdpValues'] = [60, 40];
            return JSON.stringify(edited);
        };
        const decreasingTdp = await execute(['profiles', 'edit', 'target', '--editor'], {}, decreasingTdpIO);
        expect(decreasingTdp.code).toBe(1);
        expect(decreasingTdp.stdout).toBe('');
        expect(decreasingTdp.stderr).toContain(
            'tcc-cli: Invalid profile setting: odmPowerLimits.tdpValues[1]: must not be lower than the previous TDP value.',
        );
        expect(decreasingTdpIO.saveCalls).toBe(0);

        const unsupportedTdpIO = createMemoryProfileIO(JSON.stringify([target]));
        unsupportedTdpIO.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            const limits = edited['odmPowerLimits'] as Record<string, unknown>;
            limits['tdpValues'] = [40, 50];
            return JSON.stringify(edited);
        };
        const unsupportedTdp = await execute(['profiles', 'edit', 'target', '--editor'], {}, unsupportedTdpIO);
        expect(unsupportedTdp.code).toBe(1);
        expect(unsupportedTdp.stdout).toBe('');
        expect(unsupportedTdp.stderr).toContain(
            'tcc-cli: Invalid profile setting: odmPowerLimits.tdpValues: must contain one value for each runtime TDP descriptor.',
        );
        expect(unsupportedTdpIO.saveCalls).toBe(0);
    });


    it('round-trips an accepted custom fan curve and TDP document through ConfigHandler', async (): Promise<void> => {
        const directory = await mkdtemp(join(tmpdir(), 'tcc-cli-profile-roundtrip-'));
        const profilesPath = join(directory, 'profiles.json');
        try {
            const target = makeProfile('target', 'Target');
            const io = createMemoryProfileIO(JSON.stringify([target]));
            const temperatures = [20, 30, 40, 50, 60, 70, 80, 90, 100];
            const curve = temperatures.map((temp, index) => ({
                temp,
                speed: index < 6 ? 0 : index === 6 ? 30 : 40,
            }));
            io.editor = async (json): Promise<string> => {
                const edited = JSON.parse(json) as Record<string, unknown>;
                const fan = edited['fan'] as Record<string, unknown>;
                const customFanCurve = fan['customFanCurve'] as Record<string, unknown>;
                fan['fanProfile'] = 'Custom';
                customFanCurve['tableCPU'] = curve;
                customFanCurve['tableGPU'] = curve;
                (edited['odmPowerLimits'] as Record<string, unknown>)['tdpValues'] = [50];
                return JSON.stringify(edited);
            };
            io.saveProfiles = async (json): Promise<void> => {
                io.saveCalls += 1;
                io.savedProfiles = json;
                await writeFile(profilesPath, json, 'utf8');
            };

            const result = await execute(['profiles', 'edit', 'target', '--editor'], {}, io);
            expect(result.code).toBe(0);
            expect(result.stderr).toBe('');
            const beforeMigration = JSON.parse(await readFile(profilesPath, 'utf8')) as unknown;
            const handler = new ConfigHandler(
                join(directory, 'settings'),
                profilesPath,
                join(directory, 'webcam'),
                join(directory, 'v4l2-names'),
                join(directory, 'fan-tables'),
            );
            handler.readProfiles(TUXEDODevice.UNKNOWN, profilesPath);
            const afterMigration = JSON.parse(await readFile(profilesPath, 'utf8')) as unknown;
            expect(afterMigration).toEqual(beforeMigration);
            expect(result.profileIO.saveCalls).toBe(1);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('rejects malformed, duplicate, or built-in-colliding saved lists without replacing them', async (): Promise<void> => {
        const rawInputs = [
            '{',
            JSON.stringify([makeProfile('duplicate', 'One'), makeProfile('duplicate', 'Two')]),
            JSON.stringify([builtInProfile]),
        ];
        for (const raw of rawInputs) {
            const io = createMemoryProfileIO(raw);
            const result = await execute(['profiles', 'show', 'custom'], {}, io);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toMatch(/^tcc-cli: Cannot read saved profiles:/);
            expect(io.saveCalls).toBe(0);
        }
    });
    it('reports raw-file read failures without converting them into an empty-list save', async (): Promise<void> => {
        const io = createMemoryProfileIO();
        io.readSavedProfiles = async (): Promise<string> => {
            throw new Error('permission denied');
        };
        const result = await execute(['profiles', 'show', 'custom'], {}, io);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: Cannot read saved profiles: permission denied.');
        expect(io.saveCalls).toBe(0);
    });


    it('prints help without constructing a client', async (): Promise<void> => {
        let stdout = '';
        const code = await runCli(['--help'], {
            createClient: (): CliClient => { throw new Error('client must not be created'); },
            createProfileIO: (): ProfileIO => { throw new Error('profile I/O must not be created'); },
            stdout: (text: string): void => { stdout += text; },
            stderr: (): void => undefined,
        });
        expect(code).toBe(0);
        expect(stdout).toContain('profiles list');
        expect(stdout).toContain('profiles current');
        expect(stdout).toContain('status');
        expect(stdout).toContain('profiles activate <id>');
        expect(stdout).toContain('profiles show <id>');
        expect(stdout).toContain('profiles create <name>');
        expect(stdout).toContain('Temporarily');
        expect(stdout).toContain('polkit authentication');
        expect(stdout).toContain('one writer at a time');
        expect(stdout).toContain('may reapply the current profile to hardware');
        expect(stdout).toContain('does not activate it or change saved AC/battery mappings');
    });

    it('prints all new command help without connecting or creating profile I/O', async (): Promise<void> => {
        for (const argv of [
            ['profiles', 'show', '--help'],
            ['profiles', 'create', '--help'],
            ['profiles', 'edit', '--help'],
        ]) {
            let stdout = '';
            const code = await runCli(argv, {
                createClient: (): CliClient => { throw new Error('client must not be created'); },
                createProfileIO: (): ProfileIO => { throw new Error('profile I/O must not be created'); },
                stdout: (text: string): void => { stdout += text; },
                stderr: (): void => undefined,
            });
            expect(code).toBe(0);
            expect(stdout).toContain('Custom profiles show their saved JSON');
            expect(stdout).toContain('Built-in profiles show daemon-resolved defaults');
            expect(stdout).toContain('polkit authentication');
            expect(stdout).toContain('not transactional');
            expect(stdout).toContain('does not activate it or change saved AC/battery mappings');
        }
    });

    it('rejects invalid new command forms before constructing a client or profile adapter', async (): Promise<void> => {
        for (const argv of [
            ['profiles', 'show'],
            ['profiles', 'show', 'id', 'extra'],
            ['profiles', 'create'],
            ['profiles', 'create', '--name', 'New'],
            ['profiles', 'create', 'New', '--name', 'Other'],
            ['profiles', 'create', 'New', '--brightness'],
            ['profiles', 'create', 'New', '--brightness=1.5'],
            ['profiles', 'create', 'New', '--brightness', '50', '--brightness', '60'],
            ['profiles', 'create', 'New', '--unknown', 'x'],
            ['profiles', 'create', 'New', '--base', 'base', '--editor', '--description', 'x'],
            ['profiles', 'edit', 'id'],
            ['profiles', 'edit', 'id', '--base', 'base', '--description', 'x'],
            ['profiles', 'edit', 'id', '--description'],
            ['profiles', 'create', 'New', '--base'],
            ['profiles', 'create', 'New', '--base', 'first', '--base', 'second'],
        ]) {
            let stderr = '';
            const code = await runCli(argv, {
                createClient: (): CliClient => { throw new Error('client must not be created'); },
                createProfileIO: (): ProfileIO => { throw new Error('profile I/O must not be created'); },
                stdout: (): void => undefined,
                stderr: (text: string): void => { stderr += text; },
            });
            expect(code).toBe(2);
            expect(stderr).toContain('Invalid command');
        }
    });

    it('rejects invalid arguments without constructing a client', async (): Promise<void> => {
        let stderr = '';
        const code = await runCli(['profiles', 'list', 'extra'], {
            createClient: (): CliClient => { throw new Error('client must not be created'); },
            createProfileIO: (): ProfileIO => { throw new Error('profile I/O must not be created'); },
            stdout: (): void => undefined,
            stderr: (text: string): void => { stderr += text; },
        });
        expect(code).toBe(2);
        expect(stderr).toContain('Usage:');
        expect(stderr).toContain('Invalid command');
    });
    it('rejects missing, empty, option-like, and extra activation arguments before client creation', async (): Promise<void> => {
        for (const argv of [
            ['profiles', 'activate'],
            ['profiles', 'activate', ''],
            ['profiles', 'activate', '--all'],
            ['profiles', 'activate', 'office', 'extra'],
        ]) {
            let stderr = '';
            const code = await runCli(argv, {
                createClient: (): CliClient => { throw new Error('client must not be created'); },
                createProfileIO: (): ProfileIO => { throw new Error('profile I/O must not be created'); },
                stdout: (): void => undefined,
                stderr: (text: string): void => { stderr += text; },
            });
            expect(code).toBe(2);
            expect(stderr).toContain('Invalid command');
        }
    });
});
