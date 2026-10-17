import { profileSettingOptions } from './profile-options';
import type { SettingSpec } from './profile-options';

export type CliHelpTopic =
    | 'root'
    | 'profiles'
    | 'status'
    | 'profiles-list'
    | 'profiles-current'
    | 'profiles-activate'
    | 'profiles-show'
    | 'profiles-create'
    | 'profiles-edit';

const helpFlags: Readonly<Record<string, true>> = { '--help': true, '-h': true };
const profileTopics: Readonly<Record<string, CliHelpTopic>> = {
    list: 'profiles-list',
    current: 'profiles-current',
    activate: 'profiles-activate',
    show: 'profiles-show',
    create: 'profiles-create',
    edit: 'profiles-edit',
};

function isHelpFlag(value: string | undefined): boolean {
    return value !== undefined && helpFlags[value] === true;
}

function isValidHelpSubject(value: string | undefined): value is string {
    return value !== undefined && value.length > 0 && !value.startsWith('-');
}

export function getHelpTopic(argv: readonly string[]): CliHelpTopic | undefined {
    if (argv.length === 0 || (argv.length === 1 && (argv[0] === 'help' || isHelpFlag(argv[0])))) {
        return 'root';
    }
    if (argv[0] === 'status' && argv.length === 2 && isHelpFlag(argv[1])) {
        return 'status';
    }
    if (argv[0] !== 'profiles') {
        return undefined;
    }
    if (argv.length === 1 || (argv.length === 2 && isHelpFlag(argv[1]))) {
        return 'profiles';
    }

    const topic = Object.prototype.hasOwnProperty.call(profileTopics, argv[1]) ? profileTopics[argv[1]] : undefined;
    if (!topic) {
        return undefined;
    }
    if (argv.length === 3 && isHelpFlag(argv[2])) {
        return topic;
    }
    if (
        argv.length === 4 &&
        topic !== 'profiles-list' &&
        topic !== 'profiles-current' &&
        isValidHelpSubject(argv[2]) &&
        isHelpFlag(argv[3])
    ) {
        return topic;
    }
    return undefined;
}

interface HelpRow {
    label: string;
    description: string;
}

function wrap(text: string, width: number, indent: string): string[] {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    const lines: string[] = [];
    let line = indent;
    for (const word of words) {
        if (line.length > indent.length && line.length + 1 + word.length <= width) {
            line += ` ${word}`;
        } else if (line.length === indent.length) {
            line += word;
        } else {
            lines.push(line);
            line = `${indent}${word}`;
        }
    }
    if (line.length > indent.length) {
        lines.push(line);
    }
    return lines;
}

function renderRows(rows: readonly HelpRow[]): string[] {
    const indent = '  ';
    const labelWidth = Math.max(...rows.map((row) => row.label.length));
    const descriptionColumn = indent.length + labelWidth + 2;
    const lines: string[] = [];

    for (const row of rows) {
        if (80 - descriptionColumn < 24) {
            lines.push(`${indent}${row.label}`);
            lines.push(...wrap(row.description, 80, '    '));
            continue;
        }
        const descriptionIndent = ' '.repeat(descriptionColumn);
        lines.push(
            ...wrap(row.description, 80, descriptionIndent).map((line, index) =>
                index === 0 ? `${indent}${row.label.padEnd(labelWidth)}  ${line.slice(descriptionColumn)}` : line,
            ),
        );
    }
    return lines;
}

function renderProse(text: string): string[] {
    return wrap(text, 80, '');
}

function renderSettings(command: 'create' | 'edit'): HelpRow[] {
    const rows: HelpRow[] = Object.entries(profileSettingOptions)
        .filter(([, spec]: [string, SettingSpec]) => spec.command === 'both' || spec.command === command)
        .map(([option, spec]: [string, SettingSpec]) => ({
            label: `${option} ${spec.valueLabel}`,
            description: spec.description,
        }));
    rows.unshift({
        label: '--editor',
        description: 'Open $EDITOR to edit the full profile JSON.',
    });
    if (command === 'create') {
        rows.unshift({
            label: '--base <profile>',
            description: 'Clone a profile as the starting point.',
        });
    }
    return rows;
}

function writeNotes(command: 'create' | 'edit'): string[][] {
    const notes = [
        '--editor uses $EDITOR, cannot be combined with setting flags, and is how fan curves and TDP arrays are edited.',
        'Profile saves update the daemon configuration and may require polkit authentication through the privileged helper.',
        'A save replaces the full profile list. Use one writer at a time because concurrent GUI and CLI saves are not transactional.',
        'A configuration update may reapply the current profile to hardware. Saved AC/battery assignments do not change.',
    ];
    if (command === 'create') {
        notes.unshift(
            'Without --base, an interactive picker selects the base on a terminal. No base is selected implicitly off-terminal.',
            'Creating a profile does not activate the clone or make it a provider-mapped profile.',
        );
    } else {
        notes.unshift(
            'Built-in profiles are read-only. IDs cannot change, and at least one setting flag or --editor is required.',
        );
    }
    return notes.map(renderProse);
}

function renderRoot(): string {
    return (
        [
            'Usage: tcc-cli <command>',
            '',
            'Commands:',
            ...renderRows([
                { label: 'status', description: 'Show daemon and active profile status.' },
                { label: 'profiles', description: 'Manage profile selection and custom profiles.' },
            ]),
            '',
            'Options:',
            ...renderRows([{ label: '--help, -h', description: 'Show help for a command.' }]),
            '',
            'Run "tcc-cli <command> --help" for more information.',
        ].join('\n') + '\n'
    );
}

function renderProfiles(): string {
    return (
        [
            'Usage: tcc-cli profiles <command>',
            '',
            'Commands:',
            ...renderRows([
                { label: 'list', description: 'List IDs and names available from the daemon.' },
                { label: 'current', description: 'Show the active profile.' },
                { label: 'activate <profile>', description: 'Temporarily apply a profile to hardware.' },
                { label: 'show <profile>', description: 'Show saved custom or resolved built-in profile JSON.' },
                { label: 'create <name>', description: 'Create a custom profile from a base profile.' },
                { label: 'edit <profile>', description: 'Change a saved custom profile.' },
            ]),
            '',
            'Use an exact ID or a unique, case-sensitive profile name. IDs take precedence.',
            '',
            'Run "tcc-cli profiles <command> --help" for more information.',
        ].join('\n') + '\n'
    );
}

function renderLeaf(topic: Exclude<CliHelpTopic, 'root' | 'profiles'>): string {
    if (topic === 'status') {
        return [
            'Usage: tcc-cli status',
            '',
            'Show daemon availability, version, device, and active profile.',
            'This command only reads status data.',
            '',
        ].join('\n');
    }
    if (topic === 'profiles-list') {
        return [
            'Usage: tcc-cli profiles list',
            '',
            'List the IDs and names of profiles reported by the daemon.',
            'This command only reads the profile list.',
            '',
        ].join('\n');
    }
    if (topic === 'profiles-current') {
        return [
            'Usage: tcc-cli profiles current',
            '',
            'Show the active profile ID and name.',
            'This command only reads the active profile.',
            '',
        ].join('\n');
    }
    if (topic === 'profiles-activate') {
        return [
            'Usage: tcc-cli profiles activate <profile>',
            '',
            'Temporarily apply a profile to hardware without changing saved assignments.',
            '',
            ...renderProse(
                'Authorization may be required. A power-state change or another selection can replace the temporary choice, and provider holds can override it.',
            ),
            '',
            ...renderProse(
                'When power-profiles provider mode is enabled, only profiles mapped to a standard power profile can be activated.',
            ),
            '',
        ].join('\n');
    }
    if (topic === 'profiles-show') {
        return [
            'Usage: tcc-cli profiles show <profile>',
            '',
            'Show a custom profile from its saved JSON. Built-in profiles show daemon-resolved JSON.',
            '',
        ].join('\n');
    }

    const command = topic === 'profiles-create' ? 'create' : 'edit';
    const usageLines =
        command === 'create'
            ? ['Usage: tcc-cli profiles create <name> [--base <profile>] [setting flags |', '       --editor]']
            : ['Usage: tcc-cli profiles edit <profile> [setting flags | --editor]'];
    const description =
        command === 'create'
            ? 'Create a custom profile by cloning an effective profile and saving the clone.'
            : 'Edit a saved custom profile. Built-in profiles are read-only.';
    const lines = [
        ...usageLines,
        '',
        ...renderProse(description),
        '',
        'Options:',
        ...renderRows(renderSettings(command)),
        '',
    ];
    for (const note of writeNotes(command)) {
        lines.push(...note, '');
    }
    return lines.join('\n').trimEnd() + '\n';
}

export function renderHelp(topic: CliHelpTopic): string {
    if (topic === 'root') {
        return renderRoot();
    }
    if (topic === 'profiles') {
        return renderProfiles();
    }
    return renderLeaf(topic);
}
