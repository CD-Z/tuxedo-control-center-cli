import 'jasmine';
import * as dbus from 'dbus-next';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import {
    POWER_PROFILES_INTERFACE,
    POWER_PROFILES_NAME,
    POWER_PROFILES_PATH,
    TCC_INTERFACE,
    TCC_NAME,
    TCC_PATH,
} from '../classes/PowerProfilesService';
import { createPowerProfilesHarness, openBus, type PowerProfilesIntegrationHarness } from './provider-harness';

const ROOT = resolve(process.cwd());
const PPD_POLICY = resolve(ROOT, 'src/dist-data/org.freedesktop.UPower.PowerProfiles.conf');
const TCC_POLICY = resolve(ROOT, 'src/dist-data/com.tuxedocomputers.tccd.conf');

interface PrivateBus {
    address: string;
    directory: string;
    stop(): Promise<void>;
}

async function startPrivateSystemBus(includeTccPolicy: boolean): Promise<PrivateBus> {
    const directory = await mkdtemp(join(tmpdir(), 'tcc-ppd-policy-'));
    await chmod(directory, 0o755);
    const socket = join(directory, 'bus.sock');
    const configPath = join(directory, 'bus.conf');
    const policyIncludes = [PPD_POLICY, ...(includeTccPolicy ? [TCC_POLICY] : [])]
        .map((path) => `<include>${path}</include>`)
        .join('\n');
    const config = `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
    "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
    <type>system</type>
    <listen>unix:path=${socket}</listen>
    <auth>EXTERNAL</auth>
    <policy context="default">
        <!-- Keep the private bus defaults needed for ordinary system-bus clients. -->
        <allow user="*" />
        <deny own="*" />
        <deny send_type="method_call" />
        <allow send_type="signal" />
        <allow send_requested_reply="true" send_type="method_return" />
        <allow send_requested_reply="true" send_type="error" />
        <allow receive_type="method_call" />
        <allow receive_type="method_return" />
        <allow receive_type="error" />
        <allow receive_type="signal" />
        <allow send_destination="org.freedesktop.DBus" />
    </policy>
    <policy user="root">
        <allow own="org.freedesktop.PolicyKit1" />
        <allow send_destination="org.freedesktop.DBus" />
        <allow receive_sender="org.freedesktop.DBus" />
        <allow send_destination="org.freedesktop.PolicyKit1" />
        <allow receive_sender="org.freedesktop.PolicyKit1" />
    </policy>
    ${policyIncludes}
</busconfig>
`;
    await writeFile(configPath, config, { mode: 0o644 });

    const daemon = spawn(
        'dbus-daemon',
        ['--nofork', '--nopidfile', '--print-address=1', `--config-file=${configPath}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    daemon.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    const startup = new Promise<string>((resolveAddress, reject) => {
        let pending = '';
        daemon.stdout?.on('data', (chunk: Buffer) => {
            pending += chunk.toString();
            const lineEnd = pending.indexOf('\n');
            if (lineEnd >= 0) {
                resolveAddress(pending.slice(0, lineEnd).trim());
            }
        });
        daemon.once('error', reject);
        daemon.once('exit', (code, signal) => {
            reject(new Error(`Private dbus-daemon exited before startup (${code ?? signal}): ${stderr}`));
        });
    });
    let startupTimer: NodeJS.Timeout | undefined;
    let address: string;
    try {
        address = await Promise.race([
            startup,
            new Promise<string>((_resolve, reject) => {
                startupTimer = setTimeout(() => reject(new Error('Timed out starting the private dbus-daemon')), 5000);
            }),
        ]);
    } catch (error) {
        clearTimeout(startupTimer);
        if (daemon.pid !== undefined && daemon.exitCode === null && daemon.signalCode === null) {
            const stopped = once(daemon, 'exit');
            daemon.kill('SIGTERM');
            await stopped.catch(() => undefined);
        }
        await rm(directory, { recursive: true, force: true });
        throw error;
    } finally {
        clearTimeout(startupTimer);
    }
    if (!address.startsWith('unix:')) {
        daemon.kill('SIGTERM');
        await rm(directory, { recursive: true, force: true });
        throw new Error(`Private dbus-daemon returned an unexpected address '${address}'`);
    }

    return {
        address,
        directory,
        async stop() {
            if (daemon.exitCode === null && daemon.signalCode === null) {
                daemon.kill('SIGTERM');
                await once(daemon, 'exit');
            }
            await rm(directory, { recursive: true, force: true });
        },
    };
}

interface CommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

function runAsNobody(command: 'busctl' | 'dbus-send', args: string[]): Promise<CommandResult> {
    const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
    const child = spawn('runuser', ['-u', 'nobody', '--', command, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => {
        resolve({ status, stdout, stderr });
    });
    return promise;
}

function errorText(result: CommandResult): string {
    return `${result.stdout}\n${result.stderr}`;
}

function requireRoot(): void {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
        pending('This policy suite starts a private system-type D-Bus daemon and must run as root.');
    }
}

describe('Power Profiles system-bus policy integration', () => {
    it('loads the shipped provider policy and admits only the intended caller traffic', async () => {
        requireRoot();
        let privateBus: PrivateBus | undefined;
        let harness: PowerProfilesIntegrationHarness | undefined;
        try {
            privateBus = await startPrivateSystemBus(false);
            harness = await createPowerProfilesHarness({
                busAddress: privateBus.address,
            });
            expect(harness.service.providerIsOwned).toBeTrue();

            const deniedNameRequest = await runAsNobody('dbus-send', [
                `--bus=${privateBus.address}`,
                '--print-reply',
                '--type=method_call',
                '--reply-timeout=3000',
                '--dest=org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus.RequestName',
                `string:${POWER_PROFILES_NAME}`,
                'uint32:0',
            ]);
            expect(deniedNameRequest.status).not.toBe(0, errorText(deniedNameRequest));
            expect(deniedNameRequest.stderr).toContain('Error org.freedesktop.DBus.Error.AccessDenied:');

            const introspection = await runAsNobody('busctl', [
                `--address=${privateBus.address}`,
                'introspect',
                POWER_PROFILES_NAME,
                POWER_PROFILES_PATH,
            ]);
            expect(introspection.status).toBe(0, errorText(introspection));
            expect(errorText(introspection)).toContain(POWER_PROFILES_INTERFACE);

            const active = await runAsNobody('busctl', [
                `--address=${privateBus.address}`,
                'get-property',
                POWER_PROFILES_NAME,
                POWER_PROFILES_PATH,
                POWER_PROFILES_INTERFACE,
                'ActiveProfile',
            ]);
            expect(active.status).toBe(0, errorText(active));
            expect(errorText(active)).toContain('balanced');

            const unrelatedCall = await runAsNobody('dbus-send', [
                `--bus=${privateBus.address}`,
                '--print-reply',
                '--type=method_call',
                '--reply-timeout=3000',
                `--dest=${POWER_PROFILES_NAME}`,
                POWER_PROFILES_PATH,
                'org.example.Unrelated.Ping',
            ]);
            expect(unrelatedCall.status).not.toBe(0, errorText(unrelatedCall));
            expect(unrelatedCall.stderr).toContain('Error org.freedesktop.DBus.Error.AccessDenied:');

            const switchResult = await runAsNobody('busctl', [
                `--address=${privateBus.address}`,
                'set-property',
                POWER_PROFILES_NAME,
                POWER_PROFILES_PATH,
                POWER_PROFILES_INTERFACE,
                'ActiveProfile',
                's',
                'power-saver',
            ]);
            expect(switchResult.status).toBe(0, errorText(switchResult));
            expect(harness.appliedProfiles.at(-1)).toBe('test-power-saver');
            expect(harness.authorizationCalls.at(-1)?.action).toBe(
                'org.freedesktop.UPower.PowerProfiles.switch-profile',
            );
            expect(harness.authorizationCalls.at(-1)?.sender).toMatch(/^:[A-Za-z0-9_-]+\./);

            const reread = await runAsNobody('busctl', [
                `--address=${privateBus.address}`,
                'get-property',
                POWER_PROFILES_NAME,
                POWER_PROFILES_PATH,
                POWER_PROFILES_INTERFACE,
                'ActiveProfile',
            ]);
            expect(reread.status).toBe(0, errorText(reread));
            expect(errorText(reread)).toContain('power-saver');
        } finally {
            await harness?.close();
            await privateBus?.stop();
        }
    });

    it('keeps ReplaceProfileConfiguration root-only when both shipped transport policies are loaded', async () => {
        requireRoot();
        let privateBus: PrivateBus | undefined;
        let harness: PowerProfilesIntegrationHarness | undefined;
        let rootClient: dbus.MessageBus | undefined;
        let filesDirectory: string | undefined;
        try {
            privateBus = await startPrivateSystemBus(true);
            filesDirectory = await mkdtemp(join(tmpdir(), 'tcc-ppd-config-test-'));
            const settingsPath = join(filesDirectory, 'settings.json');
            const profilesPath = join(filesDirectory, 'profiles.json');
            const settingsJSON = '{"ppd":{"enabled":true}}';
            const profilesJSON = '[{"id":"test-profile"}]';
            harness = await createPowerProfilesHarness({
                busAddress: privateBus.address,
                claimTccName: true,
                async persistConfiguration(settings, profiles) {
                    JSON.parse(settings);
                    JSON.parse(profiles);
                    await writeFile(settingsPath, settings, { mode: 0o600 });
                    await writeFile(profilesPath, profiles, { mode: 0o600 });
                    return true;
                },
            });

            const nonRootReplacement = await runAsNobody('dbus-send', [
                `--bus=${privateBus.address}`,
                '--print-reply',
                '--type=method_call',
                '--reply-timeout=3000',
                `--dest=${TCC_NAME}`,
                TCC_PATH,
                `${TCC_INTERFACE}.ReplaceProfileConfiguration`,
                `string:${settingsJSON}`,
                `string:${profilesJSON}`,
            ]);
            expect(nonRootReplacement.status).not.toBe(0, errorText(nonRootReplacement));
            expect(nonRootReplacement.stderr).toContain('Error org.freedesktop.DBus.Error.AccessDenied:');
            await expectMissing(settingsPath);
            await expectMissing(profilesPath);
            expect(harness.configurationReplacements).toEqual([]);

            rootClient = await openBus(privateBus.address);
            const rootReply = await rootClient.call(
                new dbus.Message({
                    destination: TCC_NAME,
                    path: TCC_PATH,
                    interface: TCC_INTERFACE,
                    member: 'ReplaceProfileConfiguration',
                    signature: 'ss',
                    body: [settingsJSON, profilesJSON],
                }),
            );
            expect(rootReply?.type).toBe(dbus.MessageType.METHOD_RETURN);
            expect(rootReply?.signature).toBe('b');
            expect(rootReply?.body).toEqual([true]);
            expect(await readFile(settingsPath, 'utf8')).toBe(settingsJSON);
            expect(await readFile(profilesPath, 'utf8')).toBe(profilesJSON);
            expect(harness.configurationReplacements).toEqual([{ settingsJSON, profilesJSON }]);
        } finally {
            rootClient?.disconnect();
            await harness?.close();
            await privateBus?.stop();
            if (filesDirectory !== undefined) {
                await rm(filesDirectory, { recursive: true, force: true });
            }
        }
    });
});

async function expectMissing(path: string): Promise<void> {
    let error: unknown;
    try {
        await readFile(path);
    } catch (caught) {
        error = caught;
    }
    expect(error).toBeDefined();
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
}
