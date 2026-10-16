import type { TccDBusController } from '../common/classes/TccDBusController';
import { TUXEDODevice } from '../common/models/DefaultProfiles';
import type { ITccProfile } from '../common/models/TccProfile';

export type ReadOnlyClient = Pick<
    TccDBusController,
    'init' | 'dbusAvailable' | 'tccdVersion' | 'getDeviceJSON' | 'getProfilesJSON' | 'getActiveProfileJSON' | 'disconnect'
>;

export interface CliDependencies {
    createClient(): ReadOnlyClient;
    stdout(text: string): void;
    stderr(text: string): void;
}

const usage = [
    'Usage: tcc-cli <command>',
    'Commands:',
    '  status          Show daemon and active profile status',
    '  profiles list   List available profiles',
    '  profiles current  Show the active profile',
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

async function connect(client: ReadOnlyClient): Promise<void> {
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

    const command = argv.length === 1 && argv[0] === 'status'
        ? 'status'
        : argv.length === 2 && argv[0] === 'profiles' && argv[1] === 'list'
            ? 'profiles-list'
            : argv.length === 2 && argv[0] === 'profiles' && argv[1] === 'current'
                ? 'profiles-current'
                : undefined;

    if (!command) {
        dependencies.stderr(`tcc-cli: Invalid command.\n${usage}`);
        return 2;
    }

    let client: ReadOnlyClient | undefined;
    try {
        client = dependencies.createClient();
        await connect(client);

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
