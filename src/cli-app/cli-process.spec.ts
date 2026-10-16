import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface ChildResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

async function runMissingBusCommand(args: string[]): Promise<ChildResult> {
    const directory = await mkdtemp(join(tmpdir(), 'tcc-cli-process-'));
    const child = spawn(process.execPath, [
        '--import', 'tsx', resolve('src/cli-app/main.ts'), ...args,
    ], {
        cwd: process.cwd(),
        env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(directory, 'bus')}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string): void => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string): void => { stderr += chunk; });

    const timeout = setTimeout((): void => { child.kill('SIGKILL'); }, 5000);
    try {
        const code = await new Promise<number | null>((resolveExit, reject): void => {
            child.once('error', reject);
            child.once('close', resolveExit);
        });
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        await rm(directory, { recursive: true, force: true });
    }
}

describe('CLI process connection failure', (): void => {
    it('reports a missing system bus without an unhandled error', async (): Promise<void> => {
        for (const args of [['status'], ['profiles', 'activate', 'office']]) {
            const result = await runMissingBusCommand(args);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('tcc-cli: Cannot connect to tccd. Ensure tccd is running.');
            expect(result.stderr).not.toMatch(/Unhandled|uncaught|node:events|^\s+at /im);
        }
    }, 15000);
});
