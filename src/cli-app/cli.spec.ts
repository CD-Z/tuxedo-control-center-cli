import type { CliClient } from './cli';
import { runCli } from './cli';

interface TestClientValues {
    init?: boolean | (() => Promise<boolean>);
    available?: boolean | (() => Promise<boolean>);
    version?: string;
    device?: string;
    profiles?: string;
    activeProfile?: string;
    setterResult?: boolean | undefined;
    rejectSetter?: boolean;
    rejectProfiles?: boolean;
}

async function execute(argv: string[], values: TestClientValues = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
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
        setTempProfileById: async (id: string): Promise<boolean> => {
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
        stdout: (text: string): void => { stdout += text; },
        stderr: (text: string): void => { stderr += text; },
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

    it('prints help without constructing a client', async (): Promise<void> => {
        let stdout = '';
        const code = await runCli(['--help'], {
            createClient: (): CliClient => { throw new Error('client must not be created'); },
            stdout: (text: string): void => { stdout += text; },
            stderr: (): void => undefined,
        });
        expect(code).toBe(0);
        expect(stdout).toContain('profiles list');
        expect(stdout).toContain('profiles current');
        expect(stdout).toContain('status');
        expect(stdout).toContain('profiles activate <id>');
        expect(stdout).toContain('Temporarily');
    });

    it('rejects invalid arguments without constructing a client', async (): Promise<void> => {
        let stderr = '';
        const code = await runCli(['profiles', 'list', 'extra'], {
            createClient: (): CliClient => { throw new Error('client must not be created'); },
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
                stdout: (): void => undefined,
                stderr: (text: string): void => { stderr += text; },
            });
            expect(code).toBe(2);
            expect(stderr).toContain('Invalid command');
        }
    });
});
