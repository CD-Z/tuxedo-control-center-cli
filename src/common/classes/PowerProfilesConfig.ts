/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 */

import { DefaultProfileIDs, LegacyDefaultProfileIDs, type TUXEDODevice } from '../models/DefaultProfiles';
import type { ITccProfile } from '../models/TccProfile';
import type { ITccSettings, ProfileStates } from '../models/TccSettings';
import type { ResolvedPowerProfiles, StandardProfile } from '../models/PowerProfiles';
import { ConfigHandler } from './ConfigHandler';

const supportedProfiles: StandardProfile[] = ['power-saver', 'balanced', 'performance'];
const validProfiles: Set<string> = new Set(supportedProfiles);

export class PowerProfilesConfig {
    public static resolve(
        settings: ITccSettings,
        profiles: ITccProfile[],
        device: TUXEDODevice,
        config: ConfigHandler,
    ): ResolvedPowerProfiles {
        if (settings.ppd !== undefined && typeof settings.ppd.enabled !== 'boolean') {
            throw new Error('Power-profiles-daemon enabled must be a boolean');
        }
        if (!settings.ppd?.enabled) {
            return {};
        }

        if (
            settings.ppd.profiles !== undefined &&
            (typeof settings.ppd.profiles !== 'object' ||
                settings.ppd.profiles === null ||
                Array.isArray(settings.ppd.profiles))
        ) {
            throw new Error('Power-profiles-daemon profiles must be an object');
        }

        const catalog = config.getDefaultProfiles(device).concat(profiles);
        const ids = new Map<string, ITccProfile>();
        for (const profile of catalog) {
            if (typeof profile.id !== 'string' || profile.id.length === 0 || ids.has(profile.id)) {
                throw new Error(`Invalid or duplicate TCC profile ID '${profile.id}'`);
            }
            ids.set(profile.id, profile);
        }

        const overrides = settings.ppd.profiles ?? {};
        for (const key of Object.keys(overrides)) {
            if (!validProfiles.has(key)) {
                throw new Error(`Unknown power profile mapping '${key}'`);
            }
        }

        const resolveDefault = (profile: StandardProfile): string | undefined => {
            const defaults: Record<StandardProfile, string[]> = {
                'power-saver': [DefaultProfileIDs.MaxEnergySave, LegacyDefaultProfileIDs.PowersaveExtreme],
                balanced: [DefaultProfileIDs.Office, LegacyDefaultProfileIDs.Default],
                performance: [DefaultProfileIDs.HighPerformance],
            };
            return defaults[profile].find((id) => ids.has(id));
        };

        const result: ResolvedPowerProfiles = {};
        for (const standard of supportedProfiles) {
            const override = overrides[standard];
            const hasOverride = Object.hasOwn(overrides, standard);
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
        for (const state of ['power_ac', 'power_bat'] as ProfileStates[]) {
            if (!mappedIds.includes(settings.stateMap?.[state])) {
                throw new Error(`Saved ${state} assignment is not mapped by power-profiles-daemon`);
            }
        }
        return result;
    }
}
