export function resolveProfile<T extends { id: string; name: string }>(
	profiles: readonly T[],
	selector: string,
): T {
	const idMatch = profiles.find((profile): boolean => profile.id === selector);
	if (idMatch) {
		return idMatch;
	}
	const nameMatches = profiles.filter(
		(profile): boolean => profile.name === selector,
	);
	if (nameMatches.length === 1) {
		return nameMatches[0];
	}
	if (nameMatches.length === 0) {
		throw new Error(
			`tcc-cli: Unknown profile: ${JSON.stringify(selector)}. Use "tcc-cli profiles list" to see available IDs and names.`,
		);
	}
	throw new Error(
		`tcc-cli: Ambiguous profile name: ${JSON.stringify(selector)}. Matching IDs: ${nameMatches.map((profile) => JSON.stringify(profile.id)).join(", ")}. Use an ID.`,
	);
}
