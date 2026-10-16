import { defaultFanProfiles } from '../common/models/TccFanTable';

export type ProfileParseResult =
    | { kind: 'unhandled' }
    | { kind: 'invalid' }
    | { kind: 'help'; command: 'show' | 'create' | 'edit' }
    | { kind: 'show'; id: string }
    | { kind: 'create'; name: string; baseId?: string; editor: boolean; settings: ReadonlyMap<string, string> }
    | { kind: 'edit'; id: string; editor: boolean; settings: ReadonlyMap<string, string> };

type ProfileCommand = 'show' | 'create' | 'edit';
type SettingSpec = {
    command: 'create' | 'edit' | 'both';
    validate(value: string): boolean;
};

const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const fanProfileNames = new Set(defaultFanProfiles.map((profile) => profile.name).filter((name): name is string => typeof name === 'string'));

function numericValue(value: string): number | undefined {
    if (!decimalPattern.test(value)) {
        return undefined;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
}

function integerInRange(value: string, minimum: number, maximum: number): boolean {
    const numeric = numericValue(value);
    return numeric !== undefined && Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum;
}

function positiveInteger(value: string): boolean {
    const numeric = numericValue(value);
    return numeric !== undefined && Number.isInteger(numeric) && numeric > 0;
}

function nonempty(value: string): boolean {
    return value.length > 0;
}

const settings: Readonly<Record<string, SettingSpec>> = {
    '--name': { command: 'edit', validate: (value) => value.length >= 1 && value.length <= 50 },
    '--description': { command: 'both', validate: (value) => value.length <= 200 },
    '--brightness': {
        command: 'both',
        validate: (value) => value === 'unchanged' || integerInRange(value, 0, 100),
    },
    '--refresh-rate': {
        command: 'both',
        validate: (value) => value === 'unchanged' || (numericValue(value) !== undefined && Number(value) > 0),
    },
    '--webcam': { command: 'both', validate: (value) => value === 'on' || value === 'off' },
    '--cpu-cores': { command: 'both', validate: (value) => value === 'all' || positiveInteger(value) },
    '--cpu-min-frequency': { command: 'both', validate: (value) => value === 'default' || positiveInteger(value) },
    '--cpu-max-frequency': {
        command: 'both',
        validate: (value) => value === 'max' || value === 'reduced' || positiveInteger(value),
    },
    '--cpu-max-performance': { command: 'both', validate: (value) => value === 'on' || value === 'off' },
    '--cpu-energy-preference': { command: 'both', validate: nonempty },
    '--cpu-turbo': { command: 'both', validate: (value) => value === 'on' || value === 'off' },
    '--fan-profile': { command: 'both', validate: (value) => fanProfileNames.has(value) },
    '--fan-min-speed': { command: 'both', validate: (value) => integerInRange(value, 0, 100) },
    '--fan-max-speed': { command: 'both', validate: (value) => integerInRange(value, 0, 100) },
    '--fan-offset': { command: 'both', validate: (value) => integerInRange(value, -100, 100) },
    '--odm-profile': { command: 'both', validate: nonempty },
    '--nvidia-power-offset': { command: 'both', validate: (value) => integerInRange(value, 0, Number.MAX_VALUE) },
};

function isProfileCommand(value: string | undefined): value is ProfileCommand {
    return value === 'show' || value === 'create' || value === 'edit';
}

function isValidIdentifier(value: string): boolean {
    return value.length > 0 && !value.startsWith('-');
}

function isValidCreateName(value: string): boolean {
    return isValidIdentifier(value) && value.length <= 50;
}

/** Parses only the new profile-management command forms. */
export function parseProfileCommand(argv: readonly string[]): ProfileParseResult {
    if (argv[0] !== 'profiles' || !isProfileCommand(argv[1])) {
        return { kind: 'unhandled' };
    }

    const command = argv[1];
    if (argv.slice(2).includes('--help')) {
        return { kind: 'help', command };
    }

    if (command === 'show') {
        if (argv.length !== 3 || !isValidIdentifier(argv[2])) {
            return { kind: 'invalid' };
        }
        return { kind: 'show', id: argv[2] };
    }

    const isCreate = command === 'create';
    const subject = argv[2];
    if (subject === undefined || (isCreate ? !isValidCreateName(subject) : !isValidIdentifier(subject))) {
        return { kind: 'invalid' };
    }

    let baseId: string | undefined;
    let editor = false;
    const parsedSettings = new Map<string, string>();
    for (let index = 3; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--editor') {
            if (editor) {
                return { kind: 'invalid' };
            }
            editor = true;
            continue;
        }

        const equalsIndex = token.indexOf('=');
        const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
        const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
        if (option === '--base') {
            if (!isCreate || baseId !== undefined || (inlineValue !== undefined && !isValidIdentifier(inlineValue))) {
                return { kind: 'invalid' };
            }
            if (inlineValue !== undefined) {
                baseId = inlineValue;
            } else {
                const value = argv[index + 1];
                if (value === undefined || value.startsWith('--') || !isValidIdentifier(value)) {
                    return { kind: 'invalid' };
                }
                baseId = value;
                index += 1;
            }
            continue;
        }

        const spec = settings[option];
        if (!spec || (spec.command !== 'both' && spec.command !== command) || parsedSettings.has(option.slice(2))) {
            return { kind: 'invalid' };
        }
        let value = inlineValue;
        if (value === undefined) {
            value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) {
                return { kind: 'invalid' };
            }
            index += 1;
        }
        if (!spec.validate(value)) {
            return { kind: 'invalid' };
        }
        parsedSettings.set(option.slice(2), value);
    }

    if ((editor && parsedSettings.size > 0) || (!isCreate && !editor && parsedSettings.size === 0)) {
        return { kind: 'invalid' };
    }

    if (isCreate) {
        return { kind: 'create', name: subject, ...(baseId === undefined ? {} : { baseId }), editor, settings: parsedSettings };
    }
    return { kind: 'edit', id: subject, editor, settings: parsedSettings };
}
