import { defaultFanProfiles } from '../common/models/TccFanTable';

export type ProfileParseResult =
    | { kind: 'unhandled' }
    | { kind: 'invalid'; message: string }
    | { kind: 'show'; selector: string }
    | { kind: 'create'; name: string; baseSelector?: string; editor: boolean; settings: ReadonlyMap<string, string> }
    | { kind: 'edit'; selector: string; editor: boolean; settings: ReadonlyMap<string, string> };

type ProfileCommand = 'show' | 'create' | 'edit';
export type SettingSpec = {
    command: 'create' | 'edit' | 'both';
    valueLabel: string;
    description: string;
    expected: string;
    validate(value: string): boolean;
};

const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

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

const fanProfileNames = [
    ...new Set(
        defaultFanProfiles.map((profile) => profile.name).filter((name): name is string => typeof name === 'string'),
    ),
];

export const profileSettingOptions: Readonly<Record<string, SettingSpec>> = {
    '--name': {
        command: 'edit',
        valueLabel: '<name>',
        description: 'Rename the custom profile.',
        expected: '1 to 50 characters',
        validate: (value) => value.length >= 1 && value.length <= 50,
    },
    '--description': {
        command: 'both',
        valueLabel: '<text>',
        description: 'Set the profile description.',
        expected: '0 to 200 characters',
        validate: (value) => value.length <= 200,
    },
    '--brightness': {
        command: 'both',
        valueLabel: '<0-100|unchanged>',
        description: 'Set display brightness as a percentage.',
        expected: 'an integer from 0 to 100 or "unchanged"',
        validate: (value) => value === 'unchanged' || integerInRange(value, 0, 100),
    },
    '--refresh-rate': {
        command: 'both',
        valueLabel: '<Hz|unchanged>',
        description: 'Set the display refresh rate in Hz.',
        expected: 'a positive finite number of Hz or "unchanged"',
        validate: (value) => value === 'unchanged' || (numericValue(value) !== undefined && Number(value) > 0),
    },
    '--webcam': {
        command: 'both',
        valueLabel: '<on|off>',
        description: 'Enable or disable the webcam.',
        expected: '"on" or "off"',
        validate: (value) => value === 'on' || value === 'off',
    },
    '--cpu-cores': {
        command: 'both',
        valueLabel: '<count|all>',
        description: 'Set the number of online CPU cores.',
        expected: 'a positive integer or "all"',
        validate: (value) => value === 'all' || positiveInteger(value),
    },
    '--cpu-min-frequency': {
        command: 'both',
        valueLabel: '<kHz|default>',
        description: 'Set the minimum CPU frequency in kHz.',
        expected: 'a positive integer in kHz or "default"',
        validate: (value) => value === 'default' || positiveInteger(value),
    },
    '--cpu-max-frequency': {
        command: 'both',
        valueLabel: '<kHz|max|reduced>',
        description: 'Set the maximum CPU frequency in kHz.',
        expected: 'a positive integer in kHz, "max", or "reduced"',
        validate: (value) => value === 'max' || value === 'reduced' || positiveInteger(value),
    },
    '--cpu-max-performance': {
        command: 'both',
        valueLabel: '<on|off>',
        description: 'Enable or disable maximum CPU performance mode.',
        expected: '"on" or "off"',
        validate: (value) => value === 'on' || value === 'off',
    },
    '--cpu-energy-preference': {
        command: 'both',
        valueLabel: '<name>',
        description: 'Set the CPU energy-performance preference.',
        expected: 'a nonempty string',
        validate: nonempty,
    },
    '--cpu-turbo': {
        command: 'both',
        valueLabel: '<on|off>',
        description: 'Enable or disable CPU turbo.',
        expected: '"on" or "off"',
        validate: (value) => value === 'on' || value === 'off',
    },
    '--fan-profile': {
        command: 'both',
        valueLabel: '<name>',
        description: 'Choose a fan profile preset.',
        expected: `one of ${fanProfileNames.map((name) => JSON.stringify(name)).join(', ')}`,
        validate: (value) => fanProfileNames.includes(value),
    },
    '--fan-min-speed': {
        command: 'both',
        valueLabel: '<0-100>',
        description: 'Set minimum fan speed as a percentage.',
        expected: 'an integer from 0 to 100',
        validate: (value) => integerInRange(value, 0, 100),
    },
    '--fan-max-speed': {
        command: 'both',
        valueLabel: '<0-100>',
        description: 'Set maximum fan speed as a percentage.',
        expected: 'an integer from 0 to 100',
        validate: (value) => integerInRange(value, 0, 100),
    },
    '--fan-offset': {
        command: 'both',
        valueLabel: '<-100-100>',
        description: 'Set the fan speed offset as a percentage.',
        expected: 'an integer from -100 to 100',
        validate: (value) => integerInRange(value, -100, 100),
    },
    '--odm-profile': {
        command: 'both',
        valueLabel: '<name>',
        description: 'Choose a device-specific power profile.',
        expected: 'a nonempty string',
        validate: nonempty,
    },
    '--nvidia-power-offset': {
        command: 'both',
        valueLabel: '<watts>',
        description: 'Set the NVIDIA GPU power offset in watts.',
        expected: 'a nonnegative integer in watts',
        validate: (value) => integerInRange(value, 0, Number.MAX_VALUE),
    },
};

function isProfileCommand(value: string | undefined): value is ProfileCommand {
    return value === 'show' || value === 'create' || value === 'edit';
}

function isValidIdentifier(value: string): boolean {
    return value.length > 0 && !value.startsWith('-');
}

function syntaxError(command: ProfileCommand, reason: string): ProfileParseResult {
    return {
        kind: 'invalid',
        message: `tcc-cli: ${reason}\nRun "tcc-cli profiles ${command} --help" for usage.`,
    };
}

function invalidValue(label: string, value: string, expected: string): ProfileParseResult {
    return {
        kind: 'invalid',
        message: `tcc-cli: Invalid value for ${label}: ${JSON.stringify(value)}. Expected ${expected}.`,
    };
}

function missingSubject(command: ProfileCommand): ProfileParseResult {
    return syntaxError(command, `Missing required argument: ${command === 'create' ? '<name>' : '<profile>'}.`);
}

/** Parses only the profile-management command forms. */
export function parseProfileCommand(argv: readonly string[]): ProfileParseResult {
    if (argv[0] !== 'profiles' || !isProfileCommand(argv[1])) {
        return { kind: 'unhandled' };
    }

    const command = argv[1];
    const isCreate = command === 'create';
    const subject = argv[2];
    if (subject === undefined || subject.startsWith('--')) {
        return missingSubject(command);
    }
    if (command === 'show') {
        if (!isValidIdentifier(subject)) {
            return missingSubject(command);
        }
        if (argv.length > 3) {
            return syntaxError(command, `Unexpected argument: ${JSON.stringify(argv[3])}.`);
        }
        return { kind: 'show', selector: subject };
    }
    if (isCreate && subject.length === 0) {
        return invalidValue('<name>', subject, '1 to 50 characters');
    }
    if (isCreate && subject.length > 50) {
        return invalidValue('<name>', subject, '1 to 50 characters');
    }
    if (!isValidIdentifier(subject)) {
        return missingSubject(command);
    }

    let baseSelector: string | undefined;
    let editor = false;
    const parsedSettings = new Map<string, string>();
    const seenOptions = new Set<string>();
    for (let index = 3; index < argv.length; index += 1) {
        const token = argv[index];
        const equalsIndex = token.indexOf('=');
        const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
        const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

        if (option === '--editor') {
            if (seenOptions.has(option)) {
                return syntaxError(command, `Repeated option: ${option}.`);
            }
            if (inlineValue !== undefined) {
                return syntaxError(command, `Unexpected argument: ${JSON.stringify(inlineValue)}.`);
            }
            seenOptions.add(option);
            editor = true;
            continue;
        }

        if (option === '--base') {
            if (!isCreate) {
                return syntaxError(command, '--base is only available for profiles create.');
            }
            if (seenOptions.has(option)) {
                return syntaxError(command, `Repeated option: ${option}.`);
            }
            seenOptions.add(option);
            const value = inlineValue ?? argv[index + 1];
            if (value === undefined || value.length === 0 || (inlineValue === undefined && value.startsWith('-'))) {
                return syntaxError(command, 'Missing value for --base.');
            }
            if (!isValidIdentifier(value)) {
                return syntaxError(command, `Unexpected argument: ${JSON.stringify(value)}.`);
            }
            baseSelector = value;
            if (inlineValue === undefined) {
                index += 1;
            }
            continue;
        }

        if (option === '--name' && command !== 'edit') {
            return syntaxError(command, '--name is only available for profiles edit.');
        }
        const spec = profileSettingOptions[option];
        if (!spec) {
            if (token.startsWith('-')) {
                return syntaxError(command, `Unknown option: ${option}.`);
            }
            return syntaxError(command, `Unexpected argument: ${JSON.stringify(token)}.`);
        }
        if (spec.command !== 'both' && spec.command !== command) {
            return syntaxError(command, `${option} is only available for profiles ${spec.command}.`);
        }
        if (seenOptions.has(option)) {
            return syntaxError(command, `Repeated option: ${option}.`);
        }
        seenOptions.add(option);

        let value = inlineValue;
        if (value === undefined) {
            value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) {
                return syntaxError(command, `Missing value for ${option}.`);
            }
            index += 1;
        }
        if (!spec.validate(value)) {
            return invalidValue(option, value, spec.expected);
        }
        parsedSettings.set(option.slice(2), value);
    }

    if (editor && parsedSettings.size > 0) {
        return syntaxError(command, '--editor cannot be combined with setting flags.');
    }
    if (!isCreate && !editor && parsedSettings.size === 0) {
        return syntaxError(command, 'Missing required option: a setting flag or --editor.');
    }

    if (isCreate) {
        return {
            kind: 'create',
            name: subject,
            ...(baseSelector === undefined ? {} : { baseSelector }),
            editor,
            settings: parsedSettings,
        };
    }
    return { kind: 'edit', selector: subject, editor, settings: parsedSettings };
}
