import { TccDBusController } from '../common/classes/TccDBusController';
import { runCli } from './cli';

void runCli(process.argv.slice(2), {
    createClient: (): TccDBusController => new TccDBusController(),
    stdout: (text: string): void => { process.stdout.write(text); },
    stderr: (text: string): void => { process.stderr.write(`${text}\n`); },
}).then((exitCode: number): void => {
    process.exitCode = exitCode;
}).catch((error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tcc-cli: ${message}\n`);
    process.exitCode = 1;
});
