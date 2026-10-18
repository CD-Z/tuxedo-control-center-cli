import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import { TccPaths } from '../common/classes/TccPaths';

export interface ProfileIO {
    readSavedProfiles(): Promise<string>;
    saveProfiles(json: string): Promise<void>;
    saveSettings(json: string): Promise<void>;
    selectBase(profiles: readonly { id: string; name: string }[]): Promise<string | undefined>;
    editProfile(json: string): Promise<string | undefined>;
    readCpuCapabilities(): Promise<{
        energyPreferences?: string[];
        turboAvailable: boolean;
        reducedFrequency?: number;
    }>;
}

export interface ProfileIOOptions {
    profilesPath?: string;
    settingsPath?: string;
    helperPath?: string;
}

interface ChildResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
    interrupted: boolean;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cliError(message: string): Error {
    return new Error(`tcc-cli: ${message}`);
}

function waitForChild(child: ChildProcess): Promise<ChildResult> {
    const { promise, resolve } = Promise.withResolvers<ChildResult>();
    let interrupted = false;
    let spawnError: Error | undefined;
    const onSigint = (): void => {
        interrupted = true;
        if (child.exitCode === null && child.signalCode === null) {
            try {
                child.kill('SIGINT');
            } catch {
                // The child can exit between checking its state and forwarding SIGINT.
            }
        }
    };

    process.on('SIGINT', onSigint);
    child.once('error', (error: Error): void => {
        spawnError = error;
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null): void => {
        process.removeListener('SIGINT', onSigint);
        resolve({ code, signal, error: spawnError, interrupted });
    });
    return promise;
}

async function makePrivateDirectory(prefix: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
        await fs.chmod(directory, 0o700);
        return directory;
    } catch (error: unknown) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
    }
}

function parseJson(json: string, purpose: string): unknown {
    try {
        return JSON.parse(json) as unknown;
    } catch (error: unknown) {
        throw cliError(`${purpose}: ${errorMessage(error)}.`);
    }
}

type SaveKind = 'profile' | 'settings';

function confirmationFailure(kind: SaveKind, reason: string, helperWasRun: boolean): Error {
    const fileName = kind === 'profile' ? 'profiles' : 'settings';
    const changedNote = helperWasRun ? `; the ${fileName} file may already have changed` : '';
    return cliError(`Could not confirm ${kind} save: ${reason}${changedNote}.`);
}

async function saveThroughHelper(
    json: string,
    kind: SaveKind,
    targetPath: string,
    helperPath: string,
): Promise<void> {
    const fileName = kind === 'profile' ? 'profiles' : 'settings';
    const expectedData = parseJson(json, `Invalid ${kind} data`);
    let helperStat: Stats;
    try {
        helperStat = await fs.stat(helperPath);
        await fs.access(helperPath, constants.X_OK);
    } catch {
        throw cliError(`Installed ${kind} helper is missing or not executable: ${helperPath}.`);
    }
    if (!helperStat.isFile()) {
        throw cliError(`Installed ${kind} helper is missing or not executable: ${helperPath}.`);
    }

    let temporaryDirectory: string;
    try {
        temporaryDirectory = await makePrivateDirectory(`tcc-cli-${fileName}-`);
    } catch (error: unknown) {
        throw cliError(`Could not stage ${fileName} for saving: ${errorMessage(error)}.`);
    }

    try {
        const stagingPath = path.join(temporaryDirectory, `${fileName}.json`);
        try {
            await fs.writeFile(stagingPath, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await fs.chmod(stagingPath, 0o600);
        } catch (error: unknown) {
            throw cliError(`Could not stage ${fileName} for saving: ${errorMessage(error)}.`);
        }

        const helperOption = kind === 'profile' ? '--new_profiles' : '--new_settings';
        let child: ChildProcess;
        try {
            child = spawn('pkexec', [helperPath, helperOption, stagingPath], {
                stdio: ['inherit', 'pipe', 'inherit'],
            });
        } catch (error: unknown) {
            throw confirmationFailure(kind, `could not start pkexec: ${errorMessage(error)}`, false);
        }
        child.stdout?.resume();
        const helperResult = await waitForChild(child);
        if (helperResult.error) {
            throw confirmationFailure(kind, `could not start pkexec: ${errorMessage(helperResult.error)}`, false);
        }
        if (helperResult.code !== 0) {
            const result = helperResult.signal
                ? `pkexec exited after signal ${helperResult.signal}`
                : `pkexec exited with status ${helperResult.code ?? 'unknown'}`;
            throw confirmationFailure(kind, result, true);
        }

        let savedData: unknown;
        try {
            const savedJson = await fs.readFile(targetPath, 'utf8');
            savedData = JSON.parse(savedJson) as unknown;
        } catch (error: unknown) {
            throw confirmationFailure(kind, `could not read saved ${fileName}: ${errorMessage(error)}`, true);
        }
        if (!isDeepStrictEqual(savedData, expectedData)) {
            throw confirmationFailure(kind, `saved ${kind} data does not match the requested ${fileName}`, true);
        }
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
}

export function createProfileIO(options: ProfileIOOptions = {}): ProfileIO {
    const profilesPath = options.profilesPath ?? TccPaths.PROFILES_FILE;
    const settingsPath = options.settingsPath ?? TccPaths.SETTINGS_FILE;
    const helperPath = options.helperPath ?? TccPaths.TCCD_EXEC_FILE;
    return {
        async readSavedProfiles(): Promise<string> {
            try {
                return await fs.readFile(profilesPath, 'utf8');
            } catch (error: unknown) {
                throw cliError(`Cannot read saved profiles: ${errorMessage(error)}.`);
            }
        },

        async saveProfiles(json: string): Promise<void> {
            await saveThroughHelper(json, 'profile', profilesPath, helperPath);
        },

        async saveSettings(json: string): Promise<void> {
            await saveThroughHelper(json, 'settings', settingsPath, helperPath);
        },

        async selectBase(profiles: readonly { id: string; name: string }[]): Promise<string | undefined> {
            if (!process.stdin.isTTY || !process.stderr.isTTY) {
                throw cliError('--base is required without an interactive terminal.');
            }
            if (profiles.length === 0) {
                throw cliError('No profiles are available to use as a base.');
            }

            for (let index = 0; index < profiles.length; index += 1) {
                const profile = profiles[index];
                process.stderr.write(`${index + 1}. ${JSON.stringify(profile.name)} [${JSON.stringify(profile.id)}]\n`);
            }

            const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
            const abortController = new AbortController();
            const cancelPrompt = (): void => abortController.abort();
            readline.on('SIGINT', cancelPrompt);
            readline.once('close', cancelPrompt);
            process.on('SIGINT', cancelPrompt);
            try {
                while (true) {
                    let answer: string;
                    try {
                        answer = await readline.question('Base number (blank to cancel): ', {
                            signal: abortController.signal,
                        });
                    } catch (error: unknown) {
                        if (abortController.signal.aborted) {
                            return undefined;
                        }
                        throw error;
                    }
                    const selection = answer.trim();
                    if (selection === '') {
                        return undefined;
                    }
                    const number = /^[0-9]+$/.test(selection) ? Number(selection) : Number.NaN;
                    if (Number.isSafeInteger(number) && number >= 1 && number <= profiles.length) {
                        return profiles[number - 1].id;
                    }
                    process.stderr.write(`Invalid selection. Choose a number from 1 to ${profiles.length}.\n`);
                }
            } finally {
                process.removeListener('SIGINT', cancelPrompt);
                readline.removeListener('SIGINT', cancelPrompt);
                readline.removeListener('close', cancelPrompt);
                readline.close();
            }
        },

        async editProfile(json: string): Promise<string | undefined> {
            const initialValue = parseJson(json, 'Invalid profile JSON for editor');
            const editorCommand = process.env.EDITOR;
            if (!editorCommand || editorCommand.trim().length === 0) {
                throw cliError('$EDITOR is not set.');
            }

            const temporaryDirectory = await makePrivateDirectory('tcc-cli-editor-');
            try {
                const absoluteFilePath = path.resolve(temporaryDirectory, 'profile.json');
                try {
                    await fs.writeFile(absoluteFilePath, `${JSON.stringify(initialValue, null, 2)}\n`, {
                        encoding: 'utf8',
                        mode: 0o600,
                        flag: 'wx',
                    });
                    await fs.chmod(absoluteFilePath, 0o600);
                } catch (error: unknown) {
                    throw cliError(`Could not prepare profile editor file: ${errorMessage(error)}.`);
                }

                const child = spawn('/bin/sh', ['-c', `${editorCommand} "$1"`, 'tcc-cli-editor', absoluteFilePath], {
                    stdio: 'inherit',
                });
                const result = await waitForChild(child);
                if (result.interrupted) {
                    return undefined;
                }
                if (result.error) {
                    throw cliError(`Could not start profile editor: ${errorMessage(result.error)}.`);
                }
                if (result.code !== 0) {
                    const exit = result.signal
                        ? `signal ${result.signal}`
                        : `status ${result.code ?? 'unknown'}`;
                    throw cliError(`Profile editor exited with ${exit}.`);
                }

                try {
                    return await fs.readFile(absoluteFilePath, 'utf8');
                } catch (error: unknown) {
                    throw cliError(`Could not read profile editor file: ${errorMessage(error)}.`);
                }
            } finally {
                await fs.rm(temporaryDirectory, { recursive: true, force: true });
            }
        },

        async readCpuCapabilities(): Promise<{
            energyPreferences?: string[];
            turboAvailable: boolean;
            reducedFrequency?: number;
        }> {
            const [{ CpuController }, { ScalingDriver }] = await Promise.all([
                import('../common/classes/CpuController'),
                import('../common/classes/LogicalCpuController'),
            ]);
            const controller = new CpuController('/sys/devices/system/cpu');
            const coreZero = controller.cores.find((core): boolean => core.coreIndex === 0);
            if (!coreZero) {
                throw cliError('CPU core zero capabilities are unavailable.');
            }

            let energyPreferences: string[] | undefined;
            const preferenceProperty = coreZero.energyPerformanceAvailablePreferences;
            if (preferenceProperty.isAvailable()) {
                energyPreferences = preferenceProperty.readValue();
            }

            let reducedFrequency: number | undefined;
            if (coreZero.cpuinfoMaxFreq.isAvailable()) {
                if (
                    controller.boost.isAvailable() &&
                    coreZero.scalingDriver.isAvailable() &&
                    coreZero.scalingDriver.readValue() === ScalingDriver.acpi_cpufreq
                ) {
                    reducedFrequency = coreZero.cpuinfoMaxFreq.readValue();
                } else {
                    reducedFrequency = coreZero.getReducedAvailableFreq();
                }
            }

            return {
                energyPreferences,
                turboAvailable: controller.intelPstate.noTurbo.isAvailable(),
                reducedFrequency,
            };
        },
    };
}
