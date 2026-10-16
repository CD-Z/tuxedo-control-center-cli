import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileIO } from './profile-io';

let testDirectory: string;
let binaryDirectory: string;
let originalPath: string | undefined;
let originalTmpdir: string | undefined;
let originalEditor: string | undefined;
let originalTarget: string | undefined;
let originalStageCapture: string | undefined;
let originalStageModeCapture: string | undefined;
let originalEditorCapture: string | undefined;

async function writeExecutable(filePath: string, body: string): Promise<void> {
    await fs.writeFile(filePath, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o700 });
    await fs.chmod(filePath, 0o700);
}

async function installFakePkexec(): Promise<void> {
    await writeExecutable(path.join(binaryDirectory, 'pkexec'), 'exec "$@"');
    process.env.PATH = `${binaryDirectory}${path.delimiter}${originalPath ?? ''}`;
}

async function expectMissing(filePath: string): Promise<void> {
    let exists = true;
    try {
        await fs.stat(filePath);
    } catch {
        exists = false;
    }
    expect(exists).toBeFalse();
}

beforeEach(async (): Promise<void> => {
    originalPath = process.env.PATH;
    originalTmpdir = process.env.TMPDIR;
    originalEditor = process.env.EDITOR;
    originalTarget = process.env.PROFILE_TARGET;
    originalStageCapture = process.env.STAGE_CAPTURE;
    originalStageModeCapture = process.env.STAGE_MODE_CAPTURE;
    originalEditorCapture = process.env.EDITOR_CAPTURE;

    testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tcc-cli-profile-io-test-'));
    binaryDirectory = path.join(testDirectory, 'bin');
    await fs.mkdir(binaryDirectory);
    process.env.TMPDIR = testDirectory;
});

afterEach(async (): Promise<void> => {
    const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    };
    restore('PATH', originalPath);
    restore('TMPDIR', originalTmpdir);
    restore('EDITOR', originalEditor);
    restore('PROFILE_TARGET', originalTarget);
    restore('STAGE_CAPTURE', originalStageCapture);
    restore('STAGE_MODE_CAPTURE', originalStageModeCapture);
    restore('EDITOR_CAPTURE', originalEditorCapture);
    await fs.rm(testDirectory, { recursive: true, force: true });
});

describe('createProfileIO', (): void => {
    it('reads the raw saved file without changing its representation', async (): Promise<void> => {
        const profilesPath = path.join(testDirectory, 'saved profiles.json');
        const original = '[ {"id":"custom","name":"Custom","extra":true} ]\n';
        await fs.writeFile(profilesPath, original, 'utf8');

        const io = createProfileIO({ profilesPath });
        expect(await io.readSavedProfiles()).toBe(original);

        await expectAsync(createProfileIO({ profilesPath: path.join(testDirectory, 'missing') }).readSavedProfiles())
            .toBeRejectedWithError(/^tcc-cli: Cannot read saved profiles:/);
    });

    it('runs an editor path with spaces and an argument, then removes its private files', async (): Promise<void> => {
        const editorPath = path.join(testDirectory, 'editor executable with spaces');
        const capturePath = path.join(testDirectory, 'editor-file-path.txt');
        process.env.EDITOR_CAPTURE = capturePath;
        await writeExecutable(
            editorPath,
            '[ "$1" = "--wait" ] || exit 4\n' +
            '[ "$(stat -c \'%a\' "$(dirname "$2")")" = "700" ] || exit 5\n' +
            '[ "$(stat -c \'%a\' "$2")" = "600" ] || exit 6\n' +
            'printf \'%s\\n\' "$2" > "$EDITOR_CAPTURE"\n' +
            'printf \'%s\' \'{"id":"custom","name":"Changed"}\' > "$2"',
        );
        process.env.EDITOR = `"${editorPath}" --wait`;

        const io = createProfileIO();
        const edited = await io.editProfile('{"id":"custom","name":"Original"}');
        expect(edited).toBe('{"id":"custom","name":"Changed"}');

        const editorFilePath = (await fs.readFile(capturePath, 'utf8')).trim();
        expect(path.isAbsolute(editorFilePath)).toBeTrue();
        await expectMissing(editorFilePath);
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-editor-'))).toEqual([]);
    });

    it('cleans the editor directory when the editor exits unsuccessfully', async (): Promise<void> => {
        const editorPath = path.join(testDirectory, 'failing-editor');
        await writeExecutable(editorPath, 'exit 17');
        process.env.EDITOR = editorPath;

        await expectAsync(createProfileIO().editProfile('{"id":"custom","name":"Original"}'))
            .toBeRejectedWithError('tcc-cli: Profile editor exited with status 17.');
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-editor-'))).toEqual([]);
    });
    it('does not return a deleted editor file and still removes the private directory', async (): Promise<void> => {
        const editorPath = path.join(testDirectory, 'deleting-editor');
        const capturePath = path.join(testDirectory, 'deleted-editor-file.txt');
        process.env.EDITOR_CAPTURE = capturePath;
        await writeExecutable(
            editorPath,
            'printf \'%s\\n\' "$1" > "$EDITOR_CAPTURE"\n' +
            'rm "$1"',
        );
        process.env.EDITOR = editorPath;

        await expectAsync(createProfileIO().editProfile('{"id":"custom","name":"Original"}'))
            .toBeRejectedWithError(/^tcc-cli: Could not read profile editor file:/);
        await expectMissing((await fs.readFile(capturePath, 'utf8')).trim());
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-editor-'))).toEqual([]);
    });

    it('reports a missing or non-executable installed helper before staging files', async (): Promise<void> => {
        const helperPath = path.join(testDirectory, 'non-executable helper');
        await fs.writeFile(helperPath, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o600 });

        await expectAsync(createProfileIO({ helperPath }).saveProfiles('[]'))
            .toBeRejectedWithError(`tcc-cli: Installed profile helper is missing or not executable: ${helperPath}.`);
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-profiles-'))).toEqual([]);
    });


    it('stages a private file for pkexec and confirms the persisted JSON', async (): Promise<void> => {
        await installFakePkexec();
        const profilesPath = path.join(testDirectory, 'saved profiles.json');
        const helperPath = path.join(testDirectory, 'installed profile helper');
        const stageCapture = path.join(testDirectory, 'stage-path.txt');
        const stageModeCapture = path.join(testDirectory, 'stage-mode.txt');
        const payload = '[{"id":"custom","name":"Custom","extra":{"enabled":true}}]\n';
        process.env.PROFILE_TARGET = profilesPath;
        process.env.STAGE_CAPTURE = stageCapture;
        process.env.STAGE_MODE_CAPTURE = stageModeCapture;
        await fs.writeFile(profilesPath, '[]', 'utf8');
        await writeExecutable(
            helperPath,
            '[ "$1" = "--new_profiles" ] || exit 3\n' +
            '[ "$(stat -c \'%a\' "$(dirname "$2")")" = "700" ] || exit 4\n' +
            '[ "$(stat -c \'%a\' "$2")" = "600" ] || exit 5\n' +
            'printf \'%s\\n\' "$2" > "$STAGE_CAPTURE"\n' +
            'stat -c \'%a\' "$2" > "$STAGE_MODE_CAPTURE"\n' +
            'cp "$2" "$PROFILE_TARGET"\n' +
            'printf \'helper banner\\n\'',
        );

        await createProfileIO({ profilesPath, helperPath }).saveProfiles(payload);

        expect(await fs.readFile(profilesPath, 'utf8')).toBe(payload);
        expect((await fs.readFile(stageModeCapture, 'utf8')).trim()).toBe('600');
        await expectMissing((await fs.readFile(stageCapture, 'utf8')).trim());
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-profiles-'))).toEqual([]);
    });

    it('rejects a zero helper exit without matching disk data and removes the staging file', async (): Promise<void> => {
        await installFakePkexec();
        const profilesPath = path.join(testDirectory, 'saved profiles.json');
        const helperPath = path.join(testDirectory, 'no-write helper');
        await fs.writeFile(profilesPath, '[]', 'utf8');
        await writeExecutable(helperPath, 'exit 0');

        await expectAsync(
            createProfileIO({ profilesPath, helperPath }).saveProfiles('[{"id":"custom","name":"Custom"}]'),
        ).toBeRejectedWithError(
            'tcc-cli: Could not confirm profile save: saved profile data does not match the requested profiles; the profiles file may already have changed.',
        );
        expect(await fs.readFile(profilesPath, 'utf8')).toBe('[]');
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-profiles-'))).toEqual([]);
    });

    it('reports pkexec cancellation without changing the saved file', async (): Promise<void> => {
        await installFakePkexec();
        const profilesPath = path.join(testDirectory, 'saved profiles.json');
        const helperPath = path.join(testDirectory, 'profile helper');
        await fs.writeFile(profilesPath, '[]', 'utf8');
        await writeExecutable(path.join(binaryDirectory, 'pkexec'), 'exit 126');
        await writeExecutable(helperPath, 'cp "$2" "$PROFILE_TARGET"');
        process.env.PROFILE_TARGET = profilesPath;

        await expectAsync(createProfileIO({ profilesPath, helperPath }).saveProfiles('[{"id":"custom"}]'))
            .toBeRejectedWithError(
                'tcc-cli: Could not confirm profile save: pkexec exited with status 126; the profiles file may already have changed.',
            );
        expect(await fs.readFile(profilesPath, 'utf8')).toBe('[]');
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-profiles-'))).toEqual([]);
    });

    it('reports a mismatching readback even when the helper changed the saved file', async (): Promise<void> => {
        await installFakePkexec();
        const profilesPath = path.join(testDirectory, 'saved profiles.json');
        const helperPath = path.join(testDirectory, 'mismatching helper');
        await fs.writeFile(profilesPath, '[]', 'utf8');
        process.env.PROFILE_TARGET = profilesPath;
        await writeExecutable(helperPath, 'printf \'[{"id":"other"}]\' > "$PROFILE_TARGET"\nexit 0');

        await expectAsync(createProfileIO({ profilesPath, helperPath }).saveProfiles('[{"id":"custom"}]'))
            .toBeRejectedWithError(
                'tcc-cli: Could not confirm profile save: saved profile data does not match the requested profiles; the profiles file may already have changed.',
            );
        expect(await fs.readFile(profilesPath, 'utf8')).toBe('[{"id":"other"}]');
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-profiles-'))).toEqual([]);
    });

    it('reports a helper that writes and then fails without rolling back disk changes', async (): Promise<void> => {
        await installFakePkexec();
        const profilesPath = path.join(testDirectory, 'saved profiles.json');
        const helperPath = path.join(testDirectory, 'write-then-fail helper');
        const payload = '[{"id":"custom","name":"Custom"}]';
        process.env.PROFILE_TARGET = profilesPath;
        await fs.writeFile(profilesPath, '[]', 'utf8');
        await writeExecutable(helperPath, 'cp "$2" "$PROFILE_TARGET"\nexit 17');

        await expectAsync(createProfileIO({ profilesPath, helperPath }).saveProfiles(payload))
            .toBeRejectedWithError(/Could not confirm profile save: pkexec exited with status 17; the profiles file may already have changed\./);
        expect(await fs.readFile(profilesPath, 'utf8')).toBe(payload);
        expect((await fs.readdir(testDirectory)).filter((entry): boolean => entry.startsWith('tcc-cli-profiles-'))).toEqual([]);
    });
});
