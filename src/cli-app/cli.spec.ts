import type { PowerProfilesRuntimeState } from '../common/models/PowerProfiles';
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
    settings?: string;
    adoptedSettings?: string;
    runtimeState?: PowerProfilesRuntimeState;
    rejectProfiles?: boolean;
    rejectSetter?: boolean;
    setterResult?: boolean | undefined;
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
    savedSettings: string;
    saveSettingsCalls: number;
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
        savedSettings: '',
        saveSettingsCalls: 0,
        async readSavedProfiles(): Promise<string> {
            io.readCalls += 1;
            return io.savedProfiles;
        },
        async saveProfiles(json: string): Promise<void> {
            io.saveCalls += 1;
            io.savedProfiles = json;
        },
        async saveSettings(json: string): Promise<void> {
            io.saveSettingsCalls += 1;
            io.savedSettings = json;
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
): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    profileIO: MemoryProfileIO;
    activationCalls: number;
}> {
    let stdout = '';
    let stderr = '';
    let activationCalls = 0;
    const client = {
        init: async (): Promise<boolean> => (typeof values.init === 'function' ? values.init() : (values.init ?? true)),
        dbusAvailable: async (): Promise<boolean> =>
            typeof values.available === 'function' ? values.available() : (values.available ?? true),
        tccdVersion: async (): Promise<string> => values.version ?? 'test-version',
        getDeviceJSON: async (): Promise<string> => values.device ?? '1',
        getProfilesJSON: async (): Promise<string> => {
            if (values.rejectProfiles) {
                throw new Error('getter failed');
            }
            return values.profiles ?? '[]';
        },
        getSettingsJSON: async (): Promise<string> =>
            values.adoptedSettings ??
            values.settings ??
            JSON.stringify({
                stateMap: { power_ac: 'builtin', power_bat: 'builtin' },
                ppd: { enabled: false },
            }),
        getPowerProfilesRuntimeState: async () => values.runtimeState ?? { state: 'inactive' },
        getActiveProfileJSON: async (): Promise<string> => values.activeProfile ?? '{"id":"office","name":"Office"}',
        getDefaultProfilesJSON: async (): Promise<string> => values.defaultProfiles ?? JSON.stringify([builtInProfile]),
        getDefaultValuesProfileJSON: async (): Promise<string> =>
            values.defaultValuesProfile ??
            JSON.stringify({
                cpu: {
                    onlineCores: 8,
                    scalingMinFrequency: 400_000,
                    scalingMaxFrequency: 4_000_000,
                },
            }),
        getIsX11: async (): Promise<number> => values.isX11 ?? 1,
        getDisplayModesJSON: async (): Promise<string> =>
            JSON.stringify({
                displayName: 'test',
                activeMode: {
                    xResolution: 1920,
                    yResolution: 1080,
                    refreshRates: [60],
                },
                displayModes: [
                    {
                        xResolution: 1920,
                        yResolution: 1080,
                        refreshRates: [60],
                    },
                ],
            }),
        getFansOffAvailable: async (): Promise<boolean> => values.fansOffAvailable ?? true,
        getFansMinSpeed: async (): Promise<number> => values.fansMinSpeed ?? 20,
        odmProfilesAvailable: async (): Promise<string[]> => values.odmNames ?? ['Balanced'],
        odmPowerLimits: async (): Promise<
            Array<{
                min: number;
                max: number;
                current: number;
                descriptor: string;
            }>
        > => [{ min: 20, max: 80, current: 50, descriptor: 'test' }],
        getNVIDIAPowerCTRLAvailable: async (): Promise<boolean> => values.nvidiaAvailable ?? true,
        getNVIDIAPowerCTRLDefaultPowerLimit: async (): Promise<number> => values.nvidiaDefaultLimit ?? 100,
        getNVIDIAPowerCTRLMaxPowerLimit: async (): Promise<number> => values.nvidiaMaximumLimit ?? 200,
        getIsUnsupportedConfigurableTGPDevice: async (): Promise<boolean> => values.nvidiaUnsupported ?? false,
        setTempProfileById: async (id: string): Promise<boolean> => {
            activationCalls += 1;
            if (values.rejectSetter) {
                throw new Error('setter failed');
            }
            if (
                !Object.prototype.hasOwnProperty.call(values, 'activeProfile') &&
                (!Object.prototype.hasOwnProperty.call(values, 'setterResult') || values.setterResult === true)
            ) {
                const selected = (
                    JSON.parse(values.profiles ?? '[]') as Array<{
                        id: string;
                        name: string;
                    }>
                ).find((profile): boolean => profile.id === id);
                if (selected) {
                    values.activeProfile = JSON.stringify(selected);
                }
            }
            return Object.prototype.hasOwnProperty.call(values, 'setterResult')
                ? (values.setterResult as boolean)
                : true;
        },
        disconnect: (): void => undefined,
    } as CliClient;
    const code = await runCli(argv, {
        createClient: (): CliClient => client,
        createProfileIO: (): ProfileIO => ({
            ...profileIO,
            saveSettings: async (json: string): Promise<void> => {
                await profileIO.saveSettings(json);
                values.settings = json;
            },
        }),
        stdout: (text: string): void => {
            stdout += text;
        },
        stderr: (text: string): void => {
            stderr += text;
        },
    });
    return { code, stdout, stderr, profileIO, activationCalls };
}

async function executeWithoutFactories(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(argv, {
        createClient: (): CliClient => {
            throw new Error('client must not be created');
        },
        createProfileIO: (): ProfileIO => {
            throw new Error('profile I/O must not be created');
        },
        stdout: (text: string): void => {
            stdout += text;
        },
        stderr: (text: string): void => {
            stderr += text;
        },
    });
    return { code, stdout, stderr };
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
    it('activates unique names by canonical ID and gives exact IDs precedence', async (): Promise<void> => {
        const named = await execute(['profiles', 'activate', 'Quiet "profile"'], {
            profiles: '[{"id":"quiet-id","name":"Quiet \\"profile\\""}]',
        });
        expect(named.code).toBe(0);
        expect(named.stdout).toBe('Activated temporary profile: Quiet "profile" [quiet-id]\n');
        expect(named.stderr).toBe('');

        const collision = await execute(['profiles', 'activate', 'shared'], {
            profiles: '[{"id":"shared","name":"First"},{"id":"second","name":"shared"}]',
        });
        expect(collision.code).toBe(0);
        expect(collision.stdout).toBe('Activated temporary profile: First [shared]\n');
    });

    it('rejects ambiguous, partial, and case-mismatched activation names without selecting', async (): Promise<void> => {
        const ambiguous = await execute(['profiles', 'activate', 'Shared'], {
            profiles: '[{"id":"one","name":"Shared"},{"id":"two","name":"Shared"}]',
        });
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stdout).toBe('');
        expect(ambiguous.stderr).toBe(
            'tcc-cli: Ambiguous profile name: "Shared". Matching IDs: "one", "two". Use an ID.',
        );
        expect(ambiguous.activationCalls).toBe(0);

        for (const selector of ['quiet profile', 'Quiet']) {
            const result = await execute(['profiles', 'activate', selector], {
                profiles: '[{"id":"quiet","name":"Quiet profile"}]',
            });
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(
                `tcc-cli: Unknown profile: ${JSON.stringify(selector)}. Use "tcc-cli profiles list" to see available IDs and names.`,
            );
            expect(result.activationCalls).toBe(0);
        }
    });

    it('reports unknown activation selectors without selecting a profile', async (): Promise<void> => {
        const result = await execute(['profiles', 'activate', 'missing'], {
            profiles: '[{"id":"office","name":"Office"}]',
        });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(
            'tcc-cli: Unknown profile: "missing". Use "tcc-cli profiles list" to see available IDs and names.',
        );
        expect(result.activationCalls).toBe(0);
    });

    it('rejects empty activation lists as unknown and malformed or duplicate IDs as invalid', async (): Promise<void> => {
        const empty = await execute(['profiles', 'activate', 'office'], {
            profiles: '[]',
        });
        expect(empty.code).toBe(1);
        expect(empty.stdout).toBe('');
        expect(empty.stderr).toBe(
            'tcc-cli: Unknown profile: "office". Use "tcc-cli profiles list" to see available IDs and names.',
        );
        for (const profiles of [
            '{',
            '[{"id":"","name":"Broken"}]',
            '[{"id":"same","name":"First"},{"id":"same","name":"Second"}]',
        ]) {
            const result = await execute(['profiles', 'activate', 'office'], {
                profiles,
            });
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('tcc-cli: tccd returned invalid profile list data.');
            expect(result.activationCalls).toBe(0);
        }
    });

    it('reports rejected, failed, or unconfirmed activation without success output', async (): Promise<void> => {
        const cases: Array<[TestClientValues, string]> = [
            [
                {
                    profiles: '[{"id":"office","name":"Office"}]',
                    setterResult: false,
                },
                'tcc-cli: tccd rejected profile activation: office.',
            ],
            [
                {
                    profiles: '[{"id":"office","name":"Office"}]',
                    setterResult: undefined,
                },
                'tcc-cli: tccd rejected profile activation: office.',
            ],
            [
                {
                    profiles: '[{"id":"office","name":"Office"}]',
                    rejectSetter: true,
                },
                'tcc-cli: setter failed',
            ],
            [
                {
                    profiles: '[{"id":"office","name":"Office"}]',
                    activeProfile: '{}',
                },
                'tcc-cli: tccd returned invalid active profile data.',
            ],
            [
                {
                    profiles: '[{"id":"office","name":"Office"}]',
                    activeProfile: '{"id":"quiet","name":"Quiet"}',
                },
                'tcc-cli: tccd did not activate profile: office.',
            ],
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
        const result = await execute(['profiles', 'list'], {
            profiles: '[{"id":"","name":"Broken"}]',
        });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('tcc-cli: tccd returned invalid profile list data.');
    });

    it('rejects empty active-profile data', async (): Promise<void> => {
        const result = await execute(['profiles', 'current'], {
            activeProfile: '{}',
        });
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
        const result = await execute(['profiles', 'list'], {
            rejectProfiles: true,
        });
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
    it('resolves create bases by exact unique name and keeps IDs ahead of names', async (): Promise<void> => {
        const first = makeProfile('Shared', 'First');
        const second = makeProfile('second', 'Shared');
        first.fan.offsetFanspeed = 11;
        second.fan.offsetFanspeed = 22;
        const profiles = JSON.stringify([first, second]);

        const exactIdIO = createMemoryProfileIO();
        const exactId = await execute(['profiles', 'create', 'ID wins', '--base', 'Shared'], { profiles }, exactIdIO);
        expect(exactId.code).toBe(0);
        const exactIdCopy = (JSON.parse(exactIdIO.savedProfiles) as Array<Record<string, unknown>>)[0];
        expect(exactIdCopy['name']).toBe('ID wins');
        expect((exactIdCopy['fan'] as Record<string, unknown>)['offsetFanspeed']).toBe(11);

        const namedBase = makeProfile('named-id', 'Quiet "base" with spaces');
        namedBase.cpu.onlineCores = 3;
        const namedIO = createMemoryProfileIO();
        const named = await execute(
            ['profiles', 'create', 'Name clone', '--base', 'Quiet "base" with spaces'],
            { profiles: JSON.stringify([builtInProfile, namedBase]) },
            namedIO,
        );
        expect(named.code).toBe(0);
        expect(named.activationCalls).toBe(0);
        const namedCopy = (JSON.parse(namedIO.savedProfiles) as Array<Record<string, unknown>>)[0];
        expect(namedCopy['name']).toBe('Name clone');
        expect((namedCopy['cpu'] as Record<string, unknown>)['onlineCores']).toBe(3);

        const ambiguousIO = createMemoryProfileIO();
        const ambiguous = await execute(
            ['profiles', 'create', 'Copy', '--base', 'Shared'],
            {
                profiles: JSON.stringify([makeProfile('one', 'Shared'), makeProfile('two', 'Shared')]),
            },
            ambiguousIO,
        );
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stdout).toBe('');
        expect(ambiguous.stderr).toBe(
            'tcc-cli: Ambiguous profile name: "Shared". Matching IDs: "one", "two". Use an ID.',
        );
        expect(ambiguousIO.saveCalls).toBe(0);

        for (const selector of ['shared', 'Shar']) {
            const io = createMemoryProfileIO();
            const result = await execute(
                ['profiles', 'create', 'Copy', '--base', selector],
                { profiles: JSON.stringify([makeProfile('one', 'Shared')]) },
                io,
            );
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(
                `tcc-cli: Unknown profile: ${JSON.stringify(selector)}. Use "tcc-cli profiles list" to see available IDs and names.`,
            );
            expect(io.saveCalls).toBe(0);
        }
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

    it('shows built-ins by ID and unique name and shows customs from raw saved JSON', async (): Promise<void> => {
        const raw = JSON.parse(JSON.stringify(makeProfile('custom with spaces', 'Custom'))) as Record<string, unknown>;
        const cpu = raw['cpu'] as Record<string, unknown>;
        delete cpu['onlineCores'];
        delete cpu['scalingMinFrequency'];
        delete cpu['scalingMaxFrequency'];
        raw['futureSetting'] = { mode: 'untouched' };
        const io = createMemoryProfileIO(JSON.stringify([raw]));
        const builtInById = await execute(['profiles', 'show', 'builtin'], {}, io);
        expect(builtInById.code).toBe(0);
        expect(builtInById.stdout).toBe(`${JSON.stringify(builtInProfile, null, 2)}\n`);
        expect(io.readCalls).toBe(0);

        const effective = makeProfile('custom with spaces', 'Effective custom');
        effective.cpu.onlineCores = 4;
        effective.cpu.scalingMinFrequency = 900_000;
        effective.cpu.scalingMaxFrequency = 3_900_000;
        const custom = await execute(['profiles', 'show', 'Custom'], { profiles: JSON.stringify([effective]) }, io);
        expect(custom.code).toBe(0);
        const shown = JSON.parse(custom.stdout) as Record<string, unknown>;
        expect(shown['id']).toBe('custom with spaces');
        expect(shown['name']).toBe('Custom');
        expect(shown['futureSetting']).toEqual({ mode: 'untouched' });
        expect(Object.prototype.hasOwnProperty.call(shown['cpu'], 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(shown['cpu'], 'scalingMinFrequency')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(shown['cpu'], 'scalingMaxFrequency')).toBe(false);
        expect(custom.stdout.endsWith('\n')).toBe(true);

        const builtInByName = await execute(['profiles', 'show', 'Built-in'], {}, io);
        expect(builtInByName.code).toBe(0);
        expect(builtInByName.stdout).toBe(`${JSON.stringify(builtInProfile, null, 2)}\n`);
        expect(io.readCalls).toBe(2);
    });

    it('rejects unknown, partial, and case-mismatched show/edit selectors', async (): Promise<void> => {
        const io = createMemoryProfileIO('[]');
        for (const selector of ['missing', 'built-in', 'Built']) {
            const expected = `tcc-cli: Unknown profile: ${JSON.stringify(selector)}. Use "tcc-cli profiles list" to see available IDs and names.`;
            const shown = await execute(['profiles', 'show', selector], {}, io);
            expect(shown.code).toBe(1);
            expect(shown.stdout).toBe('');
            expect(shown.stderr).toBe(expected);

            const edited = await execute(['profiles', 'edit', selector, '--description', 'changed'], {}, io);
            expect(edited.code).toBe(1);
            expect(edited.stdout).toBe('');
            expect(edited.stderr).toBe(expected);
        }
        expect(io.readCalls).toBe(6);
        expect(io.saveCalls).toBe(0);
    });

    it('rejects built-in/custom name collisions and gives exact custom IDs precedence', async (): Promise<void> => {
        const collision = makeProfile('custom-id', 'Built-in');
        const ambiguousIO = createMemoryProfileIO(JSON.stringify([collision]));
        for (const argv of [
            ['profiles', 'show', 'Built-in'],
            ['profiles', 'edit', 'Built-in', '--description', 'changed'],
        ]) {
            const result = await execute(argv, {}, ambiguousIO);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(
                'tcc-cli: Ambiguous profile name: "Built-in". Matching IDs: "builtin", "custom-id". Use an ID.',
            );
        }
        expect(ambiguousIO.saveCalls).toBe(0);

        const exact = JSON.parse(JSON.stringify(makeProfile('Built-in', 'Raw profile'))) as Record<string, unknown>;
        exact['futureSetting'] = 'raw custom';
        const exactIO = createMemoryProfileIO(JSON.stringify([exact]));
        const shown = await execute(['profiles', 'show', 'Built-in'], {}, exactIO);
        expect(shown.code).toBe(0);
        expect(JSON.parse(shown.stdout)).toEqual(exact);

        const edited = await execute(
            ['profiles', 'edit', 'Built-in', '--description', 'edited raw profile'],
            {},
            exactIO,
        );
        expect(edited.code).toBe(0);
        const saved = JSON.parse(exactIO.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['id']).toBe('Built-in');
        expect(saved[0]['name']).toBe('Raw profile');
        expect(saved[0]['description']).toBe('edited raw profile');
        expect(saved[0]['futureSetting']).toBe('raw custom');
    });

    it('lets an exact custom ID win over duplicate custom names for show and edit', async (): Promise<void> => {
        const first = makeProfile('Shared', 'Shared');
        const second = makeProfile('second', 'Shared');
        const io = createMemoryProfileIO(JSON.stringify([first, second]));
        const shown = await execute(['profiles', 'show', 'Shared'], {}, io);
        expect(shown.code).toBe(0);
        expect(JSON.parse(shown.stdout)['id']).toBe('Shared');

        const edited = await execute(['profiles', 'edit', 'Shared', '--description', 'only first changes'], {}, io);
        expect(edited.code).toBe(0);
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['id']).toBe('Shared');
        expect(saved[0]['description']).toBe('only first changes');
        expect(saved[1]).toEqual(second);
    });

    it('edits a unique custom name, renames it, and preserves its raw document', async (): Promise<void> => {
        const target = JSON.parse(JSON.stringify(makeProfile('stable-id', 'Original name'))) as Record<string, unknown>;
        delete (target['cpu'] as Record<string, unknown>)['onlineCores'];
        delete (target['cpu'] as Record<string, unknown>)['scalingMinFrequency'];
        target['futureSetting'] = { keep: true };
        const other = makeProfile('other-id', 'Other');
        const io = createMemoryProfileIO(JSON.stringify([target, other]));
        const result = await execute(['profiles', 'edit', 'Original name', '--name', 'Renamed name'], {}, io);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('Updated profile: Renamed name [stable-id]\n');
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['id']).toBe('stable-id');
        expect(saved[0]['name']).toBe('Renamed name');
        expect(saved[0]['futureSetting']).toEqual({ keep: true });
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'scalingMinFrequency')).toBe(false);
        expect(saved[1]).toEqual(other);
    });

    it('resolves editor edits once and preserves the raw target through a rename', async (): Promise<void> => {
        const target = JSON.parse(JSON.stringify(makeProfile('stable-id', 'Original name'))) as Record<string, unknown>;
        const targetCpu = target['cpu'] as Record<string, unknown>;
        delete targetCpu['onlineCores'];
        delete targetCpu['scalingMinFrequency'];
        delete targetCpu['scalingMaxFrequency'];
        target['futureSetting'] = { keep: 'raw' };
        const other = makeProfile('other-id', 'Other');
        const io = createMemoryProfileIO(JSON.stringify([target, other]));
        io.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            edited['name'] = 'Editor rename';
            edited['description'] = 'Edited by editor';
            return JSON.stringify(edited);
        };
        const result = await execute(['profiles', 'edit', 'Original name', '--editor'], {}, io);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('Updated profile: Editor rename [stable-id]\n');
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['id']).toBe('stable-id');
        expect(saved[0]['name']).toBe('Editor rename');
        expect(saved[0]['description']).toBe('Edited by editor');
        expect(saved[0]['futureSetting']).toEqual({ keep: 'raw' });
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'scalingMinFrequency')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(saved[0]['cpu'], 'scalingMaxFrequency')).toBe(false);
        expect(saved[1]).toEqual(other);
    });

    it('keeps editor-time target checks on the resolved ID', async (): Promise<void> => {
        for (const concurrentChange of ['rename', 'remove'] as const) {
            const target = makeProfile('stable-id', 'Original name');
            const io = createMemoryProfileIO(JSON.stringify([target]));
            io.editor = async (json): Promise<string> => {
                const edited = JSON.parse(json) as Record<string, unknown>;
                edited['description'] = 'Editor update';
                io.savedProfiles =
                    concurrentChange === 'remove' ? '[]' : JSON.stringify([{ ...target, name: 'Concurrent rename' }]);
                return JSON.stringify(edited);
            };
            const result = await execute(['profiles', 'edit', 'Original name', '--editor'], {}, io);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('tcc-cli: Profile changed while editing: stable-id. Run the command again.');
            expect(io.saveCalls).toBe(0);
        }

        const target = makeProfile('stable-id', 'Original name');
        const io = createMemoryProfileIO(JSON.stringify([target]));
        io.editor = async (json): Promise<string> => {
            const edited = JSON.parse(json) as Record<string, unknown>;
            edited['description'] = 'Edited target';
            const latest = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
            latest.push(makeProfile('new-same-name', 'Original name') as unknown as Record<string, unknown>);
            io.savedProfiles = JSON.stringify(latest);
            return JSON.stringify(edited);
        };
        const result = await execute(['profiles', 'edit', 'Original name', '--editor'], {}, io);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('Updated profile: Original name [stable-id]\n');
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        expect(saved[0]['id']).toBe('stable-id');
        expect(saved[0]['description']).toBe('Edited target');
        expect(saved[1]['id']).toBe('new-same-name');
        expect(saved[1]['name']).toBe('Original name');
    });

    it('rejects built-in edits by exact ID or unique name using the canonical built-in ID', async (): Promise<void> => {
        for (const [selector, reads] of [
            ['builtin', 0],
            ['Built-in', 1],
        ] as const) {
            const io = createMemoryProfileIO('[]');
            let editorCalls = 0;
            io.editor = async (json): Promise<string> => {
                editorCalls += 1;
                return json;
            };
            const result = await execute(['profiles', 'edit', selector, '--description', 'changed'], {}, io);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(
                'tcc-cli: Built-in profile is read-only: builtin. Create a profile with --base builtin instead.',
            );
            expect(io.readCalls).toBe(reads);
            expect(editorCalls).toBe(0);
            expect(io.saveCalls).toBe(0);
        }
    });

    it('applies named settings to only their stored fields and preserves zero values', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const io = createMemoryProfileIO();
        const result = await execute(
            [
                'profiles',
                'create',
                'Configured',
                '--base=base',
                '--description',
                '',
                '--brightness=0',
                '--refresh-rate',
                '60.0',
                '--webcam',
                'off',
                '--cpu-cores',
                '2',
                '--cpu-min-frequency',
                '600000',
                '--cpu-max-frequency',
                '3500000',
                '--cpu-max-performance',
                'off',
                '--cpu-energy-preference',
                'performance',
                '--cpu-turbo',
                'off',
                '--fan-min-speed',
                '0',
                '--fan-offset',
                '-12',
                '--nvidia-power-offset',
                '0',
            ],
            { profiles: JSON.stringify([base]) },
            io,
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        const saved = JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>;
        const created = saved[0];
        expect(created['description']).toBe('');
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
        expect((created['fan'] as Record<string, unknown>)['offsetFanspeed']).toBe(-12);
        expect((created['nvidiaPowerCTRLProfile'] as Record<string, unknown>)['cTGPOffset']).toBe(0);
    });

    it('resolves all/default/max dynamically and stores reduced maximum frequency as -1', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const allIO = createMemoryProfileIO();
        const allResult = await execute(
            [
                'profiles',
                'create',
                'Dynamic',
                '--base',
                'base',
                '--cpu-cores',
                'all',
                '--cpu-min-frequency',
                'default',
                '--cpu-max-frequency',
                'max',
            ],
            { profiles: JSON.stringify([base]) },
            allIO,
        );
        expect(allResult.code).toBe(0);
        const dynamic = JSON.parse(allIO.savedProfiles) as Array<Record<string, unknown>>;
        const dynamicCpu = dynamic[0]['cpu'] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(dynamicCpu, 'onlineCores')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(dynamicCpu, 'scalingMinFrequency')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(dynamicCpu, 'scalingMaxFrequency')).toBe(false);

        const reducedIO = createMemoryProfileIO();
        const reduced = await execute(
            ['profiles', 'create', 'Reduced', '--base', 'base', '--cpu-max-frequency', 'reduced'],
            { profiles: JSON.stringify([base]) },
            reducedIO,
        );
        expect(reduced.code).toBe(0);
        expect(
            (
                (JSON.parse(reducedIO.savedProfiles) as Array<Record<string, unknown>>)[0]['cpu'] as Record<
                    string,
                    unknown
                >
            )['scalingMaxFrequency'],
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
            const cpu = (JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>)[0]['cpu'] as Record<
                string,
                unknown
            >;
            expect(cpu['scalingMinFrequency']).toBe(600_000);
            expect(cpu['scalingMaxFrequency']).toBe(3_500_000);
        }
    });
    it('rejects inverted frequencies and settings outside device capabilities without saving', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const invertedIO = createMemoryProfileIO();
        const inverted = await execute(
            [
                'profiles',
                'create',
                'Inverted',
                '--base',
                'base',
                '--cpu-min-frequency',
                '3900000',
                '--cpu-max-frequency',
                '3500000',
            ],
            { profiles: JSON.stringify([base]) },
            invertedIO,
        );
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

        const enabled = await execute(
            [
                'profiles',
                'create',
                'Enabled',
                '--base',
                'base',
                '--cpu-max-performance',
                'off',
                '--cpu-min-frequency',
                '500000',
                '--cpu-energy-preference',
                'performance',
            ],
            { profiles: JSON.stringify([maxPerfBase]) },
        );
        expect(enabled.code).toBe(0);

        const customBase = makeProfile('custom-base', 'Custom base');
        const customConflict = await execute(
            [
                'profiles',
                'create',
                'Custom',
                '--base',
                'custom-base',
                '--fan-profile',
                'Custom',
                '--fan-min-speed',
                '30',
            ],
            { profiles: JSON.stringify([customBase]) },
        );
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
        expect(invalidJson.stderr).toBe('tcc-cli: Invalid profile setting: profile: editor returned invalid JSON.');
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

    it('requires readable raw customs to establish built-in name uniqueness', async (): Promise<void> => {
        const unreadable = createMemoryProfileIO();
        unreadable.readSavedProfiles = async (): Promise<string> => {
            unreadable.readCalls += 1;
            throw new Error('permission denied');
        };
        for (const argv of [
            ['profiles', 'show', 'Built-in'],
            ['profiles', 'edit', 'Built-in', '--description', 'changed'],
        ]) {
            const result = await execute(argv, {}, unreadable);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('tcc-cli: Cannot read saved profiles: permission denied.');
        }
        expect(unreadable.readCalls).toBe(2);
        expect(unreadable.saveCalls).toBe(0);

        const exactId = createMemoryProfileIO();
        exactId.readSavedProfiles = async (): Promise<string> => {
            exactId.readCalls += 1;
            throw new Error('permission denied');
        };
        const shown = await execute(['profiles', 'show', 'builtin'], {}, exactId);
        expect(shown.code).toBe(0);
        expect(shown.stdout).toBe(`${JSON.stringify(builtInProfile, null, 2)}\n`);
        const edited = await execute(['profiles', 'edit', 'builtin', '--description', 'changed'], {}, exactId);
        expect(edited.code).toBe(1);
        expect(edited.stderr).toBe(
            'tcc-cli: Built-in profile is read-only: builtin. Create a profile with --base builtin instead.',
        );
        expect(exactId.readCalls).toBe(0);
        expect(exactId.saveCalls).toBe(0);
    });

    it('routes root, group, leaf, and subject help without constructing dependencies', async (): Promise<void> => {
        const helpArguments = [
            [],
            ['help'],
            ['--help'],
            ['-h'],
            ['profiles'],
            ['profiles', '--help'],
            ['profiles', '-h'],
            ['status', '--help'],
            ['status', '-h'],
            ['ppd'],
            ['ppd', '--help'],
            ['ppd', '-h'],
            ...['status', 'enable', 'configure', 'disable'].flatMap((command) => [
                ['ppd', command, '--help'],
                ['ppd', command, '-h'],
            ]),
            ...['list', 'current', 'activate', 'show', 'create', 'edit'].flatMap((command) => [
                ['profiles', command, '--help'],
                ['profiles', command, '-h'],
            ]),
            ['profiles', 'activate', 'Quiet profile', '--help'],
            ['profiles', 'show', 'Quiet profile', '-h'],
            ['profiles', 'create', 'Quiet profile', '--help'],
            ['profiles', 'edit', 'Quiet profile', '-h'],
        ];

        for (const argv of helpArguments) {
            const result = await executeWithoutFactories(argv);
            expect(result.code).withContext(argv.join(' ')).toBe(0);
            expect(result.stderr).withContext(argv.join(' ')).toBe('');
            expect(result.stdout.endsWith('\n')).withContext(argv.join(' ')).toBe(true);
        }
    });

    it('reports static setting values without connecting or printing help', async (): Promise<void> => {
        const tooLong = 'x'.repeat(201);
        const tooLongName = 'x'.repeat(51);
        const cases: Array<{
            argv: string[];
            option: string;
            value: string;
            expected: string;
        }> = [
            {
                argv: ['profiles', 'create', 'Test', '--base', 'builtin', '--cpu-cores', '0'],
                option: '--cpu-cores',
                value: '0',
                expected: 'a positive integer or "all"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--cpu-cores', '-1'],
                option: '--cpu-cores',
                value: '-1',
                expected: 'a positive integer or "all"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--cpu-cores', '0.5'],
                option: '--cpu-cores',
                value: '0.5',
                expected: 'a positive integer or "all"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--cpu-cores', 'many'],
                option: '--cpu-cores',
                value: 'many',
                expected: 'a positive integer or "all"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--brightness', '101'],
                option: '--brightness',
                value: '101',
                expected: 'an integer from 0 to 100 or "unchanged"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--refresh-rate', 'Infinity'],
                option: '--refresh-rate',
                value: 'Infinity',
                expected: 'a positive finite number of Hz or "unchanged"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--webcam', 'yes'],
                option: '--webcam',
                value: 'yes',
                expected: '"on" or "off"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--cpu-min-frequency', 'max'],
                option: '--cpu-min-frequency',
                value: 'max',
                expected: 'a positive integer in kHz or "default"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--cpu-max-frequency', 'default'],
                option: '--cpu-max-frequency',
                value: 'default',
                expected: 'a positive integer in kHz, "max", or "reduced"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--cpu-energy-preference', ''],
                option: '--cpu-energy-preference',
                value: '',
                expected: 'a nonempty string',
            },
            {
                argv: ['profiles', 'create', 'Test', '--fan-profile', 'Missing preset'],
                option: '--fan-profile',
                value: 'Missing preset',
                expected: 'one of "Silent", "Quiet", "Balanced", "Cool", "Freezy", "Custom"',
            },
            {
                argv: ['profiles', 'create', 'Test', '--fan-min-speed', '101'],
                option: '--fan-min-speed',
                value: '101',
                expected: 'an integer from 0 to 100',
            },
            {
                argv: ['profiles', 'create', 'Test', '--fan-max-speed', '101'],
                option: '--fan-max-speed',
                value: '101',
                expected: 'an integer from 0 to 100',
            },
            {
                argv: ['profiles', 'create', 'Test', '--fan-offset', '101'],
                option: '--fan-offset',
                value: '101',
                expected: 'an integer from -100 to 100',
            },
            {
                argv: ['profiles', 'create', 'Test', '--nvidia-power-offset', '-1'],
                option: '--nvidia-power-offset',
                value: '-1',
                expected: 'a nonnegative integer in watts',
            },
            {
                argv: ['profiles', 'create', 'Test', '--odm-profile', ''],
                option: '--odm-profile',
                value: '',
                expected: 'a nonempty string',
            },
            {
                argv: ['profiles', 'create', ''],
                option: '<name>',
                value: '',
                expected: '1 to 50 characters',
            },
            {
                argv: ['profiles', 'create', tooLongName],
                option: '<name>',
                value: tooLongName,
                expected: '1 to 50 characters',
            },
            {
                argv: ['profiles', 'edit', 'target', '--name', tooLongName],
                option: '--name',
                value: tooLongName,
                expected: '1 to 50 characters',
            },
            {
                argv: ['profiles', 'create', 'Test', '--description', tooLong],
                option: '--description',
                value: tooLong,
                expected: '0 to 200 characters',
            },
        ];

        for (const { argv, option, value, expected } of cases) {
            const result = await executeWithoutFactories(argv);
            expect(result.code).withContext(argv.join(' ')).toBe(2);
            expect(result.stdout).withContext(argv.join(' ')).toBe('');
            expect(
                result.stderr.startsWith(`tcc-cli: Invalid value for ${option}: ${JSON.stringify(value)}. Expected `),
            )
                .withContext(argv.join(' '))
                .toBe(true);
            expect(result.stderr).withContext(argv.join(' ')).toContain(`Expected ${expected}.`);
            expect(result.stderr).withContext(argv.join(' ')).not.toContain('Usage:');
            expect(result.stderr).withContext(argv.join(' ')).not.toContain('Run "tcc-cli');
        }
    });

    it('reports syntax reasons and one nearest-help hint before constructing dependencies', async (): Promise<void> => {
        const cases: Array<{ argv: string[]; reason: string; hint: string }> = [
            {
                argv: ['profiles', 'show'],
                reason: 'Missing required argument: <profile>.',
                hint: 'profiles show',
            },
            {
                argv: ['profiles', 'show', 'id', 'extra'],
                reason: 'Unexpected argument: "extra".',
                hint: 'profiles show',
            },
            {
                argv: ['profiles', 'create'],
                reason: 'Missing required argument: <name>.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'create', 'Test', '--brightness'],
                reason: 'Missing value for --brightness.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'create', 'Test', '--unknown', 'x'],
                reason: 'Unknown option: --unknown.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'create', 'Test', '--brightness', '50', '--brightness', '60'],
                reason: 'Repeated option: --brightness.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'create', 'Test', '--base', 'base', '--editor', '--description', 'x'],
                reason: '--editor cannot be combined with setting flags.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'create', 'Test', '--name', 'New'],
                reason: '--name is only available for profiles edit.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'edit', 'id', '--base', 'base', '--description', 'x'],
                reason: '--base is only available for profiles create.',
                hint: 'profiles edit',
            },
            {
                argv: ['profiles', 'create', 'Test', '--base'],
                reason: 'Missing value for --base.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'create', 'Test', 'extra'],
                reason: 'Unexpected argument: "extra".',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'edit', 'id'],
                reason: 'Missing required option: a setting flag or --editor.',
                hint: 'profiles edit',
            },
            {
                argv: ['profiles', 'create', 'Test', '--description', '--help'],
                reason: 'Missing value for --description.',
                hint: 'profiles create',
            },
            {
                argv: ['profiles', 'activate'],
                reason: 'Missing required argument: <profile>.',
                hint: 'profiles activate',
            },
            {
                argv: ['profiles', 'activate', 'id', 'extra'],
                reason: 'Unexpected argument: "extra".',
                hint: 'profiles activate',
            },
            {
                argv: ['profiles', 'list', 'extra'],
                reason: 'Unexpected argument: "extra".',
                hint: 'profiles list',
            },
            {
                argv: ['status', 'extra'],
                reason: 'Unexpected argument: "extra".',
                hint: 'status',
            },
        ];

        for (const { argv, reason, hint } of cases) {
            const result = await executeWithoutFactories(argv);
            expect(result.code).withContext(argv.join(' ')).toBe(2);
            expect(result.stdout).withContext(argv.join(' ')).toBe('');
            expect(result.stderr)
                .withContext(argv.join(' '))
                .toBe(`tcc-cli: ${reason}\nRun "tcc-cli ${hint} --help" for usage.`);
        }
    });

    it('keeps help-like text literal when supplied inline', async (): Promise<void> => {
        const base = makeProfile('base', 'Base');
        const io = createMemoryProfileIO();
        const result = await execute(
            ['profiles', 'create', 'Help text', '--base', 'base', '--description=--help'],
            { profiles: JSON.stringify([base]) },
            io,
        );
        expect(result.code).toBe(0);
        expect((JSON.parse(io.savedProfiles) as Array<Record<string, unknown>>)[0]['description']).toBe('--help');

        const missing = await executeWithoutFactories(['profiles', 'create', 'Test', '--description', '--help']);
        expect(missing.code).toBe(2);
        expect(missing.stderr).toContain('Missing value for --description.');
        expect(missing.stdout).toBe('');
    });

    it('rejects invalid root and group shapes with only their nearest help hint', async (): Promise<void> => {
        for (const [argv, hint] of [
            [['not-a-command'], 'Run "tcc-cli --help" for usage.'],
            [['profiles', 'not-a-command'], 'Run "tcc-cli profiles --help" for usage.'],
            [['profiles', '__proto__', '--help'], 'Run "tcc-cli profiles --help" for usage.'],
        ] as const) {
            const result = await executeWithoutFactories([...argv]);
            expect(result.code).toBe(2);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe(`tcc-cli: Invalid command.\n${hint}`);
            expect(result.stderr).not.toContain('Usage: tcc-cli');
        }
    });

    it('configures ppd mappings and assignments in one settings replacement', async (): Promise<void> => {
        const profiles = [
            makeProfile('save-old', 'Save old'),
            makeProfile('save-new', 'Save new'),
            makeProfile('balanced-id', 'Balanced'),
            makeProfile('performance-id', 'Performance'),
        ];
        const settings = {
            stateMap: { power_ac: 'save-old', power_bat: 'balanced-id' },
            ppd: {
                enabled: false,
                profiles: {
                    'power-saver': 'save-old',
                    balanced: 'balanced-id',
                    performance: 'performance-id',
                },
            },
            unrelated: { retained: true },
        };
        const io = createMemoryProfileIO();
        const result = await execute(
            ['ppd', 'configure', '--power-saver', 'save-new', '--ac=power-saver'],
            {
                profiles: JSON.stringify(profiles),
                settings: JSON.stringify(settings),
                runtimeState: { state: 'inactive' },
            },
            io,
        );
        expect(result.code).toBe(0);
        expect(io.saveSettingsCalls).toBe(1);
        expect(io.saveCalls).toBe(0);
        const saved = JSON.parse(io.savedSettings) as typeof settings;
        expect(saved.stateMap).toEqual({
            power_ac: 'save-new',
            power_bat: 'balanced-id',
        });
        expect(saved.ppd.profiles['power-saver']).toBe('save-new');
        expect(saved.unrelated).toEqual({ retained: true });
    });
    it('reports competing Power Profiles identity in status and saved-settings failures', async (): Promise<void> => {
        const settings = {
            stateMap: { power_ac: 'balanced', power_bat: 'save' },
            ppd: {
                enabled: false,
                profiles: {
                    'power-saver': 'save',
                    balanced: 'balanced',
                    performance: 'performance',
                },
            },
        };
        const owner = ':1.33';
        const statusIO = createMemoryProfileIO();
        const status = await execute(
            ['ppd', 'status'],
            {
                profiles: JSON.stringify([
                    makeProfile('save', 'Save'),
                    makeProfile('balanced', 'Balanced'),
                    makeProfile('performance', 'Performance'),
                ]),
                settings: JSON.stringify(settings),
                runtimeState: {
                    state: 'other-provider',
                    owner,
                    pid: 1627,
                    unit: 'power-profiles-daemon.service',
                },
            },
            statusIO,
        );
        expect(status.code).toBe(0);
        expect(status.stdout).toContain('Provider: other-provider');
        expect(status.stdout).toContain('Conflict: org.freedesktop.UPower.PowerProfiles is owned by another provider.');
        expect(status.stdout).toContain(`Competing D-Bus owner: "${owner}"`);
        expect(status.stdout).toContain('Competing PID: 1627');
        expect(status.stdout).toContain('Competing unit: "power-profiles-daemon.service"');
        expect(statusIO.saveSettingsCalls).toBe(0);

        for (const command of [
            ['ppd', 'enable'],
            ['ppd', 'configure', '--performance', 'none'],
        ]) {
            const io = createMemoryProfileIO();
            const commandSettings = structuredClone(settings);
            if (command[1] === 'configure') {
                commandSettings.ppd.enabled = true;
            }
            const result = await execute(
                command,
                {
                    profiles: JSON.stringify([
                        makeProfile('save', 'Save'),
                        makeProfile('balanced', 'Balanced'),
                        makeProfile('performance', 'Performance'),
                    ]),
                    settings: JSON.stringify(commandSettings),
                    runtimeState: { state: 'other-provider', owner },
                },
                io,
            );
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('Settings remain saved');
            expect(result.stderr).toContain(`Competing D-Bus owner: "${owner}"`);
            expect(result.stderr).toContain('Competing unit: unavailable');
            expect(result.stderr).toContain(`busctl --system status ${JSON.stringify(owner)}`);
            expect(JSON.parse(io.savedSettings).ppd.enabled).toBe(true);
        }
    });

    it('keeps a known owner conflict visible when optional identity is unavailable', async (): Promise<void> => {
        const result = await execute(['ppd', 'status'], {
            runtimeState: {
                state: 'other-provider',
                owner: ':1.7\nInjected',
            },
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Competing D-Bus owner: ":1.7\\nInjected"');
        expect(result.stdout).toContain('Inspect the owner with busctl --system status ":1.7\\nInjected".');
        expect(result.stdout).toContain('Competing unit: unavailable');
        expect(result.stdout).toContain('is owned by another provider.');
    });

    it('validates ppd syntax before connecting and reports saved-but-inactive enablement', async (): Promise<void> => {
        for (const argv of [
            ['ppd', 'configure'],
            ['ppd', 'enable', '--performance', 'none', '--performance', 'default'],
            ['ppd', 'enable', '--ac', 'turbo'],
            ['ppd', 'disable', '--ac', 'balanced'],
        ]) {
            const result = await executeWithoutFactories(argv);
            expect(result.code).toBe(2);
            expect(result.stdout).toBe('');
        }
        const profiles = [
            makeProfile('save', 'Save'),
            makeProfile('balanced', 'Balanced'),
            makeProfile('performance', 'Performance'),
        ];
        const settings = {
            stateMap: { power_ac: 'balanced', power_bat: 'save' },
            ppd: {
                enabled: false,
                profiles: {
                    'power-saver': 'save',
                    balanced: 'balanced',
                    performance: 'performance',
                },
            },
        };
        const io = createMemoryProfileIO();
        const enabled = await execute(
            ['ppd', 'enable'],
            {
                profiles: JSON.stringify(profiles),
                settings: JSON.stringify(settings),
            },
            io,
        );
        expect(enabled.code).toBe(1);
        expect(enabled.stderr).toContain('Settings remain saved');
        expect(JSON.parse(io.savedSettings).ppd.enabled).toBe(true);
        const disabled = await execute(
            ['ppd', 'disable'],
            {
                profiles: '[]',
                settings: JSON.stringify({
                    stateMap: {
                        power_ac: 'missing',
                        power_bat: 'also-missing',
                    },
                    ppd: { enabled: true },
                }),
            },
            createMemoryProfileIO(),
        );
        expect(disabled.code).toBe(0);
    });

    it('uses exact IDs before names, rejects ambiguous names, and checks adopted settings', async (): Promise<void> => {
        const profiles = [
            makeProfile('save', 'Save'),
            makeProfile('balanced', 'Balanced'),
            makeProfile('performance', 'Performance'),
            makeProfile('id-priority', 'ID profile'),
            makeProfile('name-collision', 'id-priority'),
            makeProfile('alpha', 'Shared name'),
            makeProfile('beta', 'Shared name'),
        ];
        const settings = {
            stateMap: { power_ac: 'save', power_bat: 'balanced' },
            ppd: {
                enabled: false,
                profiles: {
                    'power-saver': 'save',
                    balanced: 'balanced',
                    performance: 'performance',
                },
            },
        };
        const selectedIO = createMemoryProfileIO();
        const selected = await execute(
            ['ppd', 'configure', '--power-saver', 'id-priority', '--ac', 'power-saver'],
            {
                profiles: JSON.stringify(profiles),
                settings: JSON.stringify(settings),
            },
            selectedIO,
        );
        expect(selected.code).toBe(0);
        expect(JSON.parse(selectedIO.savedSettings).ppd.profiles['power-saver']).toBe('id-priority');

        const ambiguousIO = createMemoryProfileIO();
        const ambiguous = await execute(
            ['ppd', 'configure', '--performance', 'Shared name'],
            {
                profiles: JSON.stringify(profiles),
                settings: JSON.stringify(settings),
            },
            ambiguousIO,
        );
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toContain('Ambiguous profile name');
        expect(ambiguousIO.saveSettingsCalls).toBe(0);

        const mismatchIO = createMemoryProfileIO();
        const mismatch = await execute(
            ['ppd', 'configure', '--performance', 'none'],
            {
                profiles: JSON.stringify(profiles),
                settings: JSON.stringify(settings),
                adoptedSettings: JSON.stringify(settings),
            },
            mismatchIO,
        );
        expect(mismatch.code).toBe(1);
        expect(mismatch.stdout).toBe('');
        expect(mismatch.stderr).toContain('did not adopt');
        expect(mismatchIO.saveSettingsCalls).toBe(1);
        expect(JSON.parse(mismatchIO.savedSettings).ppd.profiles.performance).toBeNull();
    });
});
