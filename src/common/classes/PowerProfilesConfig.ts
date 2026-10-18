/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 */

import { DefaultProfileIDs, LegacyDefaultProfileIDs, type TUXEDODevice } from '../models/DefaultProfiles';
import type { ITccProfile } from '../models/TccProfile';
import type { ITccSettings, ProfileStates } from '../models/TccSettings';
import type { IPowerProfilesConfig, ResolvedPowerProfiles, StandardProfile } from '../models/PowerProfiles';
import { ConfigHandler } from './ConfigHandler';

const supportedProfiles: readonly StandardProfile[] = ['power-saver', 'balanced', 'performance'];
const validProfiles: Set<string> = new Set(supportedProfiles);
const defaultProfiles: Record<StandardProfile, readonly string[]> = {
    'power-saver': [DefaultProfileIDs.MaxEnergySave, LegacyDefaultProfileIDs.PowersaveExtreme],
    balanced: [DefaultProfileIDs.Office, LegacyDefaultProfileIDs.Default],
    performance: [DefaultProfileIDs.HighPerformance],
};

export class PowerProfilesConfig {
    private static isEnabled(settings: ITccSettings): boolean {
        if (settings.ppd !== undefined && typeof settings.ppd.enabled !== 'boolean') {
            throw new Error('Power-profiles-daemon enabled must be a boolean');
        }
        return settings.ppd?.enabled === true;
    }

    public static resolve(
        settings: ITccSettings,
        profiles: ITccProfile[],
        device: TUXEDODevice,
        config: ConfigHandler,
    ): ResolvedPowerProfiles {
        if (!this.isEnabled(settings)) {
            return {};
        }
        return this.resolveCatalog(settings, config.getDefaultProfiles(device).concat(profiles));
    }

    public static resolveCatalog(
        settings: ITccSettings,
        catalog: readonly ITccProfile[],
    ): ResolvedPowerProfiles {
        if (!this.isEnabled(settings)) {
            return {};
        }
        const result = this.resolveMappings(settings.ppd?.profiles, catalog);
        const mappedIds = Object.values(result);
        for (const state of ['power_ac', 'power_bat'] as ProfileStates[]) {
            if (!mappedIds.includes(settings.stateMap?.[state])) {
                throw new Error(`Saved ${state} assignment is not mapped by power-profiles-daemon`);
            }
        }
        return result;
    }

    public static resolveMappings(
        overrides: IPowerProfilesConfig['profiles'],
        catalog: readonly ITccProfile[],
    ): ResolvedPowerProfiles {
        if (
            overrides !== undefined &&
            (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))
        ) {
            throw new Error('Power-profiles-daemon profiles must be an object');
        }

        const ids = new Map<string, ITccProfile>();
        for (const profile of catalog) {
            if (typeof profile.id !== 'string' || profile.id.length === 0 || ids.has(profile.id)) {
                throw new Error(`Invalid or duplicate TCC profile ID '${profile.id}'`);
            }
            ids.set(profile.id, profile);
        }

        const mappings = overrides ?? {};
        for (const key of Object.keys(mappings)) {
            if (!validProfiles.has(key)) {
                throw new Error(`Unknown power profile mapping '${key}'`);
            }
        }

        const resolveDefault = (profile: StandardProfile): string | undefined =>
            defaultProfiles[profile].find((id) => ids.has(id));

        const result: ResolvedPowerProfiles = {};
        for (const standard of supportedProfiles) {
            const override = mappings[standard];
            const hasOverride = Object.hasOwn(mappings, standard);
            if (hasOverride && typeof override !== 'string' && !(standard === 'performance' && override === null)) {
                throw new Error(`Invalid override for power profile '${standard}'`);
            }
            if (standard === 'performance' && override === null) {
                continue;
            }
            const id = hasOverride ? override : resolveDefault(standard);
            if (id === undefined) {
                if (standard === 'performance') {
                    continue;
                }
                throw new Error(`Required TCC profile for '${standard}' is unavailable`);
            }
            if (id.length === 0 || !ids.has(id)) {
                throw new Error(`Unknown TCC profile ID '${id}' for '${standard}'`);
            }
            result[standard] = id;
        }

        const mappedIds = Object.values(result);
        if (new Set(mappedIds).size !== mappedIds.length) {
            throw new Error('Power profile mappings must target distinct TCC profile IDs');
        }
        return result;
    }
}
