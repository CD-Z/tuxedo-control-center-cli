import { profileSettingOptions } from "./profile-options";
import type { SettingSpec } from "./profile-options";

export type CliHelpTopic =
	| "root"
	| "profiles"
	| "ppd"
	| "status"
	| "profiles-list"
	| "profiles-current"
	| "profiles-activate"
	| "profiles-show"
	| "profiles-create"
	| "profiles-edit"
	| "ppd-status"
	| "ppd-enable"
	| "ppd-configure"
	| "ppd-disable";

const helpFlags: Readonly<Record<string, true>> = {
	"--help": true,
	"-h": true,
};
const profileTopics: Readonly<Record<string, CliHelpTopic>> = {
	list: "profiles-list",
	current: "profiles-current",
	activate: "profiles-activate",
	show: "profiles-show",
	create: "profiles-create",
	edit: "profiles-edit",
};
const ppdTopics: Readonly<Record<string, CliHelpTopic>> = {
	status: "ppd-status",
	enable: "ppd-enable",
	configure: "ppd-configure",
	disable: "ppd-disable",
};

function isHelpFlag(value: string | undefined): boolean {
	return value !== undefined && helpFlags[value] === true;
}

function isValidHelpSubject(value: string | undefined): value is string {
	return value !== undefined && value.length > 0 && !value.startsWith("-");
}

export function getHelpTopic(
	argv: readonly string[],
): CliHelpTopic | undefined {
	if (
		argv.length === 0 ||
		(argv.length === 1 && (argv[0] === "help" || isHelpFlag(argv[0])))
	) {
		return "root";
	}
	if (argv[0] === "status" && argv.length === 2 && isHelpFlag(argv[1])) {
		return "status";
	}
	if (argv[0] === "ppd") {
		if (argv.length === 1 || (argv.length === 2 && isHelpFlag(argv[1]))) {
			return "ppd";
		}
		const topic = Object.prototype.hasOwnProperty.call(ppdTopics, argv[1])
			? ppdTopics[argv[1]]
			: undefined;
		if (topic && argv.length === 3 && isHelpFlag(argv[2])) {
			return topic;
		}
		return undefined;
	}
	if (argv[0] !== "profiles") {
		return undefined;
	}
	if (argv.length === 1 || (argv.length === 2 && isHelpFlag(argv[1]))) {
		return "profiles";
	}

	const topic = Object.prototype.hasOwnProperty.call(profileTopics, argv[1])
		? profileTopics[argv[1]]
		: undefined;
	if (!topic) {
		return undefined;
	}
	if (argv.length === 3 && isHelpFlag(argv[2])) {
		return topic;
	}
	if (
		argv.length === 4 &&
		topic !== "profiles-list" &&
		topic !== "profiles-current" &&
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
	const indent = "  ";
	const labelWidth = Math.max(...rows.map((row) => row.label.length));
	const descriptionColumn = indent.length + labelWidth + 2;
	const lines: string[] = [];

	for (const row of rows) {
		if (80 - descriptionColumn < 24) {
			lines.push(`${indent}${row.label}`);
			lines.push(...wrap(row.description, 80, "    "));
			continue;
		}
		const descriptionIndent = " ".repeat(descriptionColumn);
		lines.push(
			...wrap(row.description, 80, descriptionIndent).map((line, index) =>
				index === 0
					? `${indent}${row.label.padEnd(labelWidth)}  ${line.slice(descriptionColumn)}`
					: line,
			),
		);
	}
	return lines;
}

function renderProse(text: string): string[] {
	return wrap(text, 80, "");
}

function renderSettings(command: "create" | "edit"): HelpRow[] {
	const rows: HelpRow[] = Object.entries(profileSettingOptions)
		.filter(
			([, spec]: [string, SettingSpec]) =>
				spec.command === "both" || spec.command === command,
		)
		.map(([option, spec]: [string, SettingSpec]) => ({
			label: `${option} ${spec.valueLabel}`,
			description: spec.description,
		}));
	rows.unshift({
		label: "--editor",
		description: "Open $EDITOR to edit the full profile JSON.",
	});
	if (command === "create") {
		rows.unshift({
			label: "--base <profile>",
			description: "Clone a profile as the starting point.",
		});
	}
	return rows;
}

function writeNotes(command: "create" | "edit"): string[][] {
	const notes = [
		"--editor uses $EDITOR, cannot be combined with setting flags, and is how fan curves and TDP arrays are edited.",
		"Profile saves update the daemon configuration and may require polkit authentication through the privileged helper.",
		"A save replaces the full profile list. Use one writer at a time because concurrent GUI and CLI saves are not transactional.",
		"A configuration update may reapply the current profile to hardware. Saved AC/battery assignments do not change.",
	];
	if (command === "create") {
		notes.unshift(
			"Without --base, an interactive picker selects the base on a terminal. No base is selected implicitly off-terminal.",
			"Creating a profile does not activate the clone or make it a provider-mapped profile.",
		);
	} else {
		notes.unshift(
			"Built-in profiles are read-only. IDs cannot change, and at least one setting flag or --editor is required.",
		);
	}
	return notes.map(renderProse);
}

function renderRoot(): string {
	return (
		[
			"Usage: tcc-cli <command>",
			"",
			"Commands:",
			...renderRows([
				{
					label: "status",
					description: "Show daemon and active profile status.",
				},
				{
					label: "profiles",
					description: "Manage profile selection and custom profiles.",
				},
				{
					label: "ppd",
					description: "Configure the optional power-profiles provider.",
				},
			]),
			"",
			"Options:",
			...renderRows([
				{ label: "--help, -h", description: "Show help for a command." },
			]),
			"",
			'Run "tcc-cli <command> --help" for more information.',
		].join("\n") + "\n"
	);
}

function renderProfiles(): string {
	return (
		[
			"Usage: tcc-cli profiles <command>",
			"",
			"Commands:",
			...renderRows([
				{
					label: "list",
					description: "List IDs and names available from the daemon.",
				},
				{ label: "current", description: "Show the active profile." },
				{
					label: "activate <profile>",
					description: "Temporarily apply a profile to hardware.",
				},
				{
					label: "show <profile>",
					description: "Show saved custom or resolved built-in profile JSON.",
				},
				{
					label: "create <name>",
					description: "Create a custom profile from a base profile.",
				},
				{
					label: "edit <profile>",
					description: "Change a saved custom profile.",
				},
			]),
			"",
			"Use an exact ID or a unique, case-sensitive profile name. IDs take precedence.",
			"",
			'Run "tcc-cli profiles <command> --help" for more information.',
		].join("\n") + "\n"
	);
}

function renderPpd(): string {
	return (
		[
			"Usage: tcc-cli ppd <command>",
			"",
			"Commands:",
			...renderRows([
				{
					label: "status",
					description: "Show provider ownership and saved mappings.",
				},
				{
					label: "enable",
					description: "Enable the provider and optionally set mappings.",
				},
				{ label: "configure", description: "Change mappings or assignments." },
				{ label: "disable", description: "Withdraw TCC provider ownership." },
			]),
			"",
			'Run "tcc-cli ppd <command> --help" for command options.',
			"",
		].join("\n") + "\n"
	);
}

function renderLeaf(topic: Exclude<CliHelpTopic, "root" | "profiles">): string {
	if (topic === "status") {
		return [
			"Usage: tcc-cli status",
			"",
			"Show daemon availability, version, device, and active profile.",
			"This command only reads status data.",
			"",
		].join("\n");
	}
	if (topic === "ppd-status") {
		return [
			"Usage: tcc-cli ppd status",
			"",
			"Show configured enablement, runtime provider ownership, active standard profile,",
			"saved AC/battery assignments, and mappings. This command only reads state.",
			"A different provider can own the standard name even when TCC is configured enabled.",
			"Enabled settings do not guarantee an active provider. Missing provider policies or a competing provider can prevent TCC from owning the name; check tccd logs.",
			"",
		].join("\n");
	}
	if (topic === "ppd-disable") {
		return [
			"Usage: tcc-cli ppd disable",
			"",
			"Disable TCC provider mode while retaining mappings and saved assignments.",
			"This withdraws the provider name; it does not stop the tccd systemd service.",
			"A competing provider is never stopped or replaced.",
			"",
			...renderProse(
				"Configuration writes replace a full settings snapshot and may require administrator authentication through the installed helper. Use one GUI or CLI configuration writer at a time.",
			),
			"",
		].join("\n");
	}
	if (topic === "ppd-enable" || topic === "ppd-configure") {
		const enable = topic === "ppd-enable";
		const lines = [
			`Usage: tcc-cli ppd ${enable ? "enable" : "configure"} [options]`,
			"",
			...(enable
				? renderProse(
						"Enable the optional provider inside an already running tccd. This does not start or manage the systemd service.",
					)
				: renderProse(
						"Change provider mappings or saved AC/battery assignments without changing enablement.",
					)),
			...(enable
				? renderProse(
						"The optional provider policies must be installed, and another provider may already own the exclusive standard name. If settings save but TCC cannot acquire the name, the settings remain saved; check provider conflicts and /var/log/tccd/log.",
					)
				: []),
			"",
			"Options:",
			...renderRows([
				{
					label: "--power-saver <profile|default>",
					description: "Map power-saver, or remove its override with default.",
				},
				{
					label: "--balanced <profile|default>",
					description: "Map balanced, or remove its override with default.",
				},
				{
					label: "--performance <profile|default|none>",
					description:
						"Map performance, restore its default, or explicitly omit it.",
				},
				{
					label: "--ac <power-saver|balanced|performance>",
					description: "Set the saved AC assignment.",
				},
				{
					label: "--battery <power-saver|balanced|performance>",
					description: "Set the saved battery assignment.",
				},
			]),
			"",
			...renderProse(
				"Mapping values select an exact profile ID or a unique case-sensitive name. Exact IDs take precedence. Use an ID to select a profile literally named default or none. The reserved value none is valid only for --performance.",
			),
			"",
			...renderProse(
				"Power-saver and balanced mappings are required and all mapped profiles must be distinct. Performance is optional. Invalid mappings are rejected. Omitted assignments stay unchanged, so a mapping change can fail if a saved assignment no longer points to a mapped profile. Specify --ac and/or --battery to choose valid assignments; the CLI never remaps them automatically.",
			),
			"",
			...renderProse(
				"Changes may require administrator authentication through the installed helper. They replace a full settings snapshot, can apply hardware settings, and can invalidate temporary holds. Use one GUI or CLI configuration writer at a time.",
			),
			...renderProse(
				"Temporary holds belong to a client connection and clear when it disconnects or tccd stops or suspends.",
			),
			"",
			...renderProse(
				"A retained temporary TCC selection outside the new mappings can still make tccd reject the change. Activate an intended mapped TCC profile explicitly, then retry. The CLI does not clear the temporary selection for you.",
			),
			"",
			"Examples:",
			"  tcc-cli ppd enable \\",
			"    --power-saver __profile_max_energy_save__ \\",
			"    --balanced __office__ --performance none --ac balanced --battery power-saver",
			"  tcc-cli ppd configure \\",
			"    --power-saver __office__ --ac power-saver --battery balanced",
			"  tcc-cli ppd configure --performance default",
			"",
		];
		return lines.join("\n");
	}
	if (topic === "profiles-list") {
		return [
			"Usage: tcc-cli profiles list",
			"",
			"List the IDs and names of profiles reported by the daemon.",
			"This command only reads the profile list.",
			"",
		].join("\n");
	}
	if (topic === "profiles-current") {
		return [
			"Usage: tcc-cli profiles current",
			"",
			"Show the active profile ID and name.",
			"This command only reads the active profile.",
			"",
		].join("\n");
	}
	if (topic === "profiles-activate") {
		return [
			"Usage: tcc-cli profiles activate <profile>",
			"",
			"Temporarily apply a profile to hardware without changing saved assignments.",
			"",
			...renderProse(
				"Authorization may be required. A power-state change or another selection can replace the temporary choice, and provider holds can override it.",
			),
			"",
			...renderProse(
				"When power-profiles provider mode is enabled, only profiles mapped to a standard power profile can be activated.",
			),
			"",
		].join("\n");
	}
	if (topic === "profiles-show") {
		return [
			"Usage: tcc-cli profiles show <profile>",
			"",
			"Show a custom profile from its saved JSON. Built-in profiles show daemon-resolved JSON.",
			"",
		].join("\n");
	}

	const command = topic === "profiles-create" ? "create" : "edit";
	const usageLines =
		command === "create"
			? [
					"Usage: tcc-cli profiles create <name> [--base <profile>] [setting flags |",
					"       --editor]",
				]
			: ["Usage: tcc-cli profiles edit <profile> [setting flags | --editor]"];
	const description =
		command === "create"
			? "Create a custom profile by cloning an effective profile and saving the clone."
			: "Edit a saved custom profile. Built-in profiles are read-only.";
	const lines = [
		...usageLines,
		"",
		...renderProse(description),
		"",
		"Options:",
		...renderRows(renderSettings(command)),
		"",
	];
	for (const note of writeNotes(command)) {
		lines.push(...note, "");
	}
	return lines.join("\n").trimEnd() + "\n";
}

export function renderHelp(topic: CliHelpTopic): string {
	if (topic === "root") {
		return renderRoot();
	}
	if (topic === "profiles") {
		return renderProfiles();
	}
	if (topic === "ppd") {
		return renderPpd();
	}
	return renderLeaf(topic);
}
