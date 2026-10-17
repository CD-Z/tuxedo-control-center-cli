/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 *
 * TUXEDO Control Center is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TUXEDO Control Center is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with TUXEDO Control Center.  If not, see <https://www.gnu.org/licenses/>.
 */

import 'jasmine';
import type { ITccProfile } from '../../common/models/TccProfile';
import { defaultSettings, ProfileStates, type ITccSettings } from '../../common/models/TccSettings';
import type { ResolvedPowerProfiles } from '../../common/models/PowerProfiles';
import { ProfileSelection } from './ProfileSelection';

const ids = {
    saver: 'saver-id',
    saverAlternate: 'saver-alternate-id',
    balanced: 'balanced-id',
    performance: 'performance-id',
    performanceAlternate: 'performance-alternate-id',
};

function makeProfile(id: string): ITccProfile {
    return {
        id,
        name: id,
        description: '',
        display: {},
        cpu: {},
        webcam: {},
        fan: {},
        odmProfile: {},
        odmPowerLimits: {},
        nvidiaPowerCTRLProfile: {},
    } as unknown as ITccProfile;
}

type PowerProfileOverrides = NonNullable<ITccSettings['ppd']>['profiles'];

interface SelectionHarness {
    selector: ProfileSelection;
    settings: ITccSettings;
    profiles: ITccProfile[];
    applied: string[];
    persisted: ITccSettings[];
    released: Array<{ owner: string; cookie: number }>;
    withdrawn: unknown[];
    published: string[];
    setPowerState(state: ProfileStates): void;
}

function makeSettings(
    ac = ids.balanced,
    battery = ids.saver,
    enabled = true,
    profiles?: PowerProfileOverrides,
): ITccSettings {
    return {
        ...defaultSettings,
        stateMap: { power_ac: ac, power_bat: battery },
        keyboardBacklightStates: [],
        ppd: { enabled, profiles },
    };
}

function makeHarness(
    settings = makeSettings(),
    options: {
        powerState?: ProfileStates;
        apply?: (profileId: string, settings: ITccSettings) => Promise<void> | void;
        persist?: (settings: ITccSettings) => Promise<void> | void;
    } = {},
): SelectionHarness {
    let powerState = options.powerState ?? ProfileStates.AC;
    const applied: string[] = [];
    const persisted: ITccSettings[] = [];
    const released: Array<{ owner: string; cookie: number }> = [];
    const published: string[] = [];
    const withdrawn: unknown[] = [];
    const profiles = [
        makeProfile(ids.saver),
        makeProfile(ids.saverAlternate),
        makeProfile(ids.balanced),
        makeProfile(ids.performance),
        makeProfile(ids.performanceAlternate),
    ];

    const selector = new ProfileSelection({
        catalog: (customProfiles) => customProfiles,
        resolveMappings: (candidateSettings) => {
            if (!candidateSettings.ppd?.enabled) {
                return {};
            }
            const overrides = candidateSettings.ppd.profiles ?? {};
            const mappings: ResolvedPowerProfiles = {
                'power-saver': overrides['power-saver'] ?? ids.saver,
                balanced: overrides.balanced ?? ids.balanced,
            };
            const performance = overrides.performance ?? ids.performance;
            if (performance !== null) {
                mappings.performance = performance;
            }
            return mappings;
        },
        powerSource: () => powerState,
        applyProfile: async (profile, settings) => {
            applied.push(profile.id);
            await options.apply?.(profile.id, settings);
        },
        persistSettings: async (candidate) => {
            await options.persist?.(candidate);
            persisted.push(candidate);
        },
        publishProfile: (profile) => {
            published.push(profile.id);
        },
        notifyProfileReleased: (owner, cookie) => {
            released.push({ owner, cookie });
        },
        onWithdraw: (reason) => {
            withdrawn.push(reason);
        },
    });

    return {
        selector,
        settings,
        profiles,
        applied,
        persisted,
        released,
        withdrawn,
        published,
        setPowerState: (state) => {
            powerState = state;
        },
    };
}

async function start(harness: SelectionHarness): Promise<void> {
    await harness.selector.reload(harness.settings, harness.profiles);
}

describe('ProfileSelection', () => {
    it('keeps unrelated settings changes in later profile-selection writes', async () => {
        const harness = makeHarness();
        await start(harness);
        const changed = {
            ...harness.settings,
            stateMap: { ...harness.settings.stateMap },
            chargingProfile: 'balanced',
        };

        harness.selector.validateSettingsUpdate(changed);
        harness.selector.commitSettingsUpdate(changed);
        await harness.selector.selectTccProfile(ids.performance, 'current-power-state');

        expect(harness.persisted[harness.persisted.length - 1].chargingProfile).toBe('balanced');
        const invalidMapping = {
            ...changed,
            stateMap: { ...changed.stateMap, power_ac: ids.saver },
        };
        expect(() => harness.selector.validateSettingsUpdate(invalidMapping)).toThrow();
    });
    it('bases a partial configuration update on the latest committed snapshot', async () => {
        const harness = makeHarness();
        await start(harness);
        await harness.selector.selectTccProfile(ids.performance, 'current-power-state');
        let persistedSettings: ITccSettings | undefined;

        await harness.selector.updateConfiguration(undefined, harness.profiles, async (settings) => {
            persistedSettings = settings;
        });

        expect(persistedSettings?.stateMap.power_ac).toBe(ids.performance);
    });

    it('arbitrates holds by priority regardless of acquisition order', async () => {
        const first = makeHarness();
        await start(first);
        const performanceCookie = await first.selector.holdProfile(
            ':1.10',
            'performance',
            'compile',
            'org.example.compiler',
        );
        const saverCookie = await first.selector.holdProfile(
            ':1.11',
            'power-saver',
            'battery task',
            'org.example.task',
        );

        expect(performanceCookie).toBe(1);
        expect(saverCookie).toBe(2);
        await first.selector.releaseProfile(':1.11', saverCookie);
        await first.selector.releaseProfile(':1.10', performanceCookie);

        expect(first.applied).toEqual([ids.balanced, ids.performance, ids.saver, ids.performance, ids.balanced]);

        const reversed = makeHarness();
        await start(reversed);
        await reversed.selector.holdProfile(':1.20', 'power-saver', 'battery task', 'org.example.task');
        await reversed.selector.holdProfile(':1.21', 'performance', 'compile', 'org.example.compiler');
        expect(reversed.selector.activeProfileId).toBe(ids.saver);
        expect(reversed.selector.activeProfileHolds).toEqual([
            {
                applicationId: 'org.example.task',
                profile: 'power-saver',
                reason: 'battery task',
            },
            {
                applicationId: 'org.example.compiler',
                profile: 'performance',
                reason: 'compile',
            },
        ]);
    });

    it('leaves holds and persistence untouched when selection matches the effective ID', async () => {
        const harness = makeHarness();
        await start(harness);
        const cookie = await harness.selector.holdProfile(':1.30', 'performance', 'build', 'org.example.build');

        await harness.selector.selectTccProfile(ids.performance, 'current-power-state');

        expect(harness.selector.activeProfileHolds).toHaveSize(1);
        expect(harness.persisted).toHaveSize(0);
        expect(harness.applied).toEqual([ids.balanced, ids.performance]);
        await harness.selector.releaseProfile(':1.30', cookie);
    });

    it('reapplies the requested assignment after persistence rollback', async () => {
        let failPersistence = true;
        const harness = makeHarness(makeSettings(), {
            persist: () => {
                if (failPersistence) {
                    failPersistence = false;
                    throw new Error('settings write failed');
                }
            },
        });
        await start(harness);
        await harness.selector.holdProfile(':1.31', 'performance', 'build', 'org.example.build');

        await expectAsync(harness.selector.selectTccProfile(ids.saver, 'current-power-state')).toBeRejected();

        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.balanced);
        expect(harness.selector.activeProfileId).toBe(ids.performance);
        expect(harness.applied).toEqual([ids.balanced, ids.performance, ids.saver, ids.performance]);
        expect(harness.published[harness.published.length - 1]).toBe(ids.performance);

        await harness.selector.selectTccProfile(ids.balanced, 'current-power-state');

        expect(harness.selector.activeProfileId).toBe(ids.balanced);
        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.balanced);
        expect(harness.applied[harness.applied.length - 1]).toBe(ids.balanced);
        expect(harness.persisted).toHaveSize(1);
        expect(harness.published[harness.published.length - 1]).toBe(ids.balanced);
    });

    it('cancels and notifies holds before committing a differing manual selection', async () => {
        const harness = makeHarness();
        await start(harness);
        const cookie = await harness.selector.holdProfile(':1.40', 'performance', 'build', 'org.example.build');

        await harness.selector.selectTccProfile(ids.saver, 'current-power-state');

        expect(harness.released).toEqual([{ owner: ':1.40', cookie }]);
        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.selector.activeProfileId).toBe(ids.saver);
        expect(harness.persisted[0].stateMap.power_ac).toBe(ids.saver);
        expect(harness.persisted[0].stateMap.power_bat).toBe(ids.saver);
    });

    it('retains a hold across a power-source change and restores the new base', async () => {
        const harness = makeHarness();
        await start(harness);
        const cookie = await harness.selector.holdProfile(
            ':1.50',
            'performance',
            'interactive work',
            'org.example.work',
        );

        harness.setPowerState(ProfileStates.BAT);
        await harness.selector.powerStateChanged(ProfileStates.BAT);
        expect(harness.selector.activeProfileId).toBe(ids.performance);
        expect(harness.selector.activeProfileHolds).toHaveSize(1);
        expect(harness.applied).toEqual([ids.balanced, ids.performance]);

        await harness.selector.releaseProfile(':1.50', cookie);
        expect(harness.selector.activeProfileId).toBe(ids.saver);
        expect(harness.applied).toEqual([ids.balanced, ids.performance, ids.saver]);
    });

    it('clears temporary selection on a power-source change', async () => {
        const harness = makeHarness();
        await start(harness);
        await harness.selector.selectTccProfile(ids.performance, 'temporary');

        harness.setPowerState(ProfileStates.BAT);
        await harness.selector.powerStateChanged(ProfileStates.BAT);

        expect(harness.selector.activeProfileId).toBe(ids.saver);
    });
    it('keeps the old power source and temporary choice after a failed transition', async () => {
        let failBatteryApplication = true;
        const harness = makeHarness(makeSettings(), {
            apply: (profileId) => {
                if (failBatteryApplication && profileId === ids.saver) {
                    throw new Error('profile application failed');
                }
            },
        });
        await start(harness);
        await harness.selector.selectTccProfile(ids.performance, 'temporary');
        harness.setPowerState(ProfileStates.BAT);

        await expectAsync(harness.selector.powerStateChanged(ProfileStates.BAT)).toBeRejected();
        expect(harness.selector.activeProfileId).toBe(ids.performance);

        failBatteryApplication = false;
        await harness.selector.powerStateChanged(ProfileStates.BAT);
        expect(harness.selector.activeProfileId).toBe(ids.saver);
    });

    it('clears temporary selection when the current-state assignment changes', async () => {
        const harness = makeHarness();
        await start(harness);
        await harness.selector.selectTccProfile(ids.performance, 'temporary');

        const changed = makeSettings(ids.saver, ids.saver);
        await harness.selector.reload(changed, harness.profiles);

        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.saver);
        expect(harness.selector.activeProfileId).toBe(ids.saver);
    });

    it('preserves temporary selection when another assignment or setting changes', async () => {
        const harness = makeHarness();
        await start(harness);
        await harness.selector.selectTccProfile(ids.performance, 'temporary');

        const otherStateChanged = makeSettings(ids.balanced, ids.performance);
        await harness.selector.reload(otherStateChanged, harness.profiles);
        expect(harness.selector.activeProfileId).toBe(ids.performance);

        const unrelatedSettingChanged = {
            ...otherStateChanged,
            stateMap: { ...otherStateChanged.stateMap },
            chargingProfile: 'balanced',
        };
        await harness.selector.reload(unrelatedSettingChanged, harness.profiles);

        expect(harness.selector.settings?.stateMap.power_bat).toBe(ids.performance);
        expect(harness.selector.settings?.chargingProfile).toBe('balanced');
        expect(harness.selector.activeProfileId).toBe(ids.performance);
    });

    it('retains temporary selection when a reload fails', async () => {
        let failSaverApplication = true;
        const harness = makeHarness(makeSettings(), {
            apply: (profileId) => {
                if (failSaverApplication && profileId === ids.saver) {
                    failSaverApplication = false;
                    throw new Error('profile application failed');
                }
            },
        });
        await start(harness);
        await harness.selector.selectTccProfile(ids.performance, 'temporary');

        const changed = makeSettings(ids.saver, ids.saver);
        await expectAsync(harness.selector.reload(changed, harness.profiles)).toBeRejected();

        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.balanced);
        expect(harness.selector.activeProfileId).toBe(ids.performance);

        await harness.selector.reload(harness.settings, harness.profiles);
        expect(harness.selector.activeProfileId).toBe(ids.performance);
    });

    it('remaps held profiles only after the new mapping has applied', async () => {
        const harness = makeHarness();
        await start(harness);
        const cookie = await harness.selector.holdProfile(':1.60', 'performance', 'rendering', 'org.example.render');
        const remapped = makeSettings(ids.balanced, ids.saver, true, {
            performance: ids.performanceAlternate,
        });

        await harness.selector.reload(remapped, harness.profiles);

        expect(harness.applied.slice(-1)).toEqual([ids.performanceAlternate]);
        expect(harness.selector.activeProfileId).toBe(ids.performanceAlternate);
        expect(harness.selector.activeProfileHolds).toHaveSize(1);
        await harness.selector.releaseProfile(':1.60', cookie);
    });

    it('rejects an invalid reload without replacing committed state', async () => {
        const harness = makeHarness();
        await start(harness);
        const cookie = await harness.selector.holdProfile(':1.70', 'performance', 'rendering', 'org.example.render');
        const invalid = makeSettings(ids.balanced, ids.saver, true, {
            performance: 'deleted-profile-id',
        });

        await expectAsync(harness.selector.reload(invalid, harness.profiles)).toBeRejected();

        expect(harness.selector.activeProfileId).toBe(ids.performance);
        expect(harness.selector.activeProfileHolds).toHaveSize(1);
        expect(harness.applied).toEqual([ids.balanced, ids.performance]);
        await harness.selector.releaseProfile(':1.70', cookie);
    });

    it('does not publish a failed hold and rolls the applied profile back', async () => {
        let failPerformance = false;
        const harness = makeHarness(makeSettings(), {
            apply: (profileId) => {
                if (failPerformance && profileId === ids.performance) {
                    throw new Error('profile application failed');
                }
            },
        });
        await start(harness);
        failPerformance = true;

        await expectAsync(
            harness.selector.holdProfile(':1.80', 'performance', 'rendering', 'org.example.render'),
        ).toBeRejected();

        expect(harness.selector.activeProfileId).toBe(ids.balanced);
        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.selector.available).toBeTrue();
        expect(harness.applied).toEqual([ids.balanced, ids.performance, ids.balanced]);
    });

    it('withdraws after both candidate application and rollback fail', async () => {
        let fail = false;
        const harness = makeHarness(makeSettings(), {
            apply: (profileId) => {
                if (fail && profileId !== ids.saver) {
                    throw new Error(`failed ${profileId}`);
                }
            },
        });
        await start(harness);
        fail = true;

        await expectAsync(
            harness.selector.holdProfile(':1.90', 'performance', 'rendering', 'org.example.render'),
        ).toBeRejected();

        expect(harness.selector.available).toBeFalse();
        expect(harness.selector.activeProfileId).toBeUndefined();
        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.withdrawn).toHaveSize(1);
    });

    it('removes disconnected owners and restores the current base', async () => {
        const harness = makeHarness();
        await start(harness);
        const cookie = await harness.selector.holdProfile(':1.91', 'performance', 'rendering', 'org.example.render');

        await harness.selector.disconnect(':1.91');

        expect(harness.selector.activeProfileId).toBe(ids.balanced);
        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.released).toEqual([{ owner: ':1.91', cookie }]);
    });

    it('restores the pre-hold profile if its owner disconnects during application', async () => {
        let applicationStarted!: () => void;
        let finishApplication!: () => void;
        const started = new Promise<void>((resolve) => {
            applicationStarted = resolve;
        });
        const waitToFinish = new Promise<void>((resolve) => {
            finishApplication = resolve;
        });
        const owner = ':1.92';
        const harness = makeHarness(makeSettings(), {
            apply: async (profileId) => {
                if (profileId === ids.performance) {
                    applicationStarted();
                    await waitToFinish;
                }
            },
        });
        await start(harness);
        const pendingHold = harness.selector.holdProfile(owner, 'performance', 'rendering', 'org.example.render');
        await started;
        const disconnect = harness.selector.disconnect(owner);
        finishApplication();

        await expectAsync(pendingHold).toBeRejected();
        await disconnect;

        expect(harness.selector.activeProfileId).toBe(ids.balanced);
        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.applied).toEqual([ids.balanced, ids.performance, ids.balanced]);
    });

    it('rolls back an applied profile when settings persistence fails', async () => {
        const harness = makeHarness(makeSettings(), {
            persist: () => {
                throw new Error('settings write failed');
            },
        });
        await start(harness);
        const cookie = await harness.selector.holdProfile(':1.93', 'performance', 'rendering', 'org.example.render');

        await expectAsync(harness.selector.selectTccProfile(ids.saver, 'current-power-state')).toBeRejected();

        expect(harness.selector.activeProfileId).toBe(ids.performance);
        expect(harness.selector.activeProfileHolds).toEqual([]);
        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.balanced);
        expect(harness.persisted).toEqual([]);
        expect(harness.released).toEqual([{ owner: ':1.93', cookie }]);
        expect(harness.applied).toEqual([ids.balanced, ids.performance, ids.saver, ids.performance]);
    });

    it('applies candidate settings before persistence and commits them afterward', async () => {
        let effectorMode: 'manual' | 'automatic' = 'manual';
        let persistenceStarted!: () => void;
        let releasePersistence!: () => void;
        const persistenceStartedSignal = new Promise<void>((resolve) => {
            persistenceStarted = resolve;
        });
        const persistenceGate = new Promise<void>((resolve) => {
            releasePersistence = resolve;
        });
        const harness = makeHarness(makeSettings(), {
            apply: (_profileId, settings) => {
                effectorMode = settings.fanControlEnabled ? 'manual' : 'automatic';
            },
        });
        await start(harness);
        const candidate = {
            ...harness.settings,
            fanControlEnabled: false,
        };

        const reload = harness.selector.reload(candidate, harness.profiles, async () => {
            persistenceStarted();
            await persistenceGate;
        });
        await persistenceStartedSignal;

        expect(effectorMode).toBe('automatic');
        expect(harness.selector.settings?.fanControlEnabled).toBeTrue();
        expect(harness.selector.activeProfileId).toBe(ids.balanced);

        releasePersistence();
        await reload;

        expect(effectorMode).toBe('automatic');
        expect(harness.selector.settings?.fanControlEnabled).toBeFalse();
    });

    it('uses committed settings to restore hardware after candidate application fails', async () => {
        let failAutomaticApplication = true;
        let effectorMode: 'manual' | 'automatic' = 'manual';
        const settingsDuringApply: boolean[] = [];
        const harness = makeHarness(makeSettings(), {
            apply: (_profileId, settings) => {
                settingsDuringApply.push(settings.fanControlEnabled);
                effectorMode = settings.fanControlEnabled ? 'manual' : 'automatic';
                if (!settings.fanControlEnabled && failAutomaticApplication) {
                    failAutomaticApplication = false;
                    throw new Error('fan application failed');
                }
            },
        });
        await start(harness);
        const candidate = {
            ...harness.settings,
            fanControlEnabled: false,
        };

        await expectAsync(harness.selector.reload(candidate, harness.profiles)).toBeRejected();

        expect(settingsDuringApply).toEqual([true, false, true]);
        expect(effectorMode).toBe('manual');
        expect(harness.selector.activeProfileId).toBe(ids.balanced);
        expect(harness.selector.settings?.fanControlEnabled).toBeTrue();
        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.balanced);
    });

    it('uses committed settings to restore hardware after persistence fails', async () => {
        let effectorMode: 'manual' | 'automatic' = 'manual';
        const settingsDuringApply: boolean[] = [];
        const harness = makeHarness(makeSettings(), {
            apply: (_profileId, settings) => {
                settingsDuringApply.push(settings.fanControlEnabled);
                effectorMode = settings.fanControlEnabled ? 'manual' : 'automatic';
            },
        });
        await start(harness);
        const candidate = {
            ...harness.settings,
            fanControlEnabled: false,
        };

        await expectAsync(
            harness.selector.reload(candidate, harness.profiles, async () => {
                throw new Error('settings write failed');
            }),
        ).toBeRejected();

        expect(settingsDuringApply).toEqual([true, false, true]);
        expect(effectorMode).toBe('manual');
        expect(harness.selector.activeProfileId).toBe(ids.balanced);
        expect(harness.selector.settings?.fanControlEnabled).toBeTrue();
        expect(harness.selector.settings?.stateMap.power_ac).toBe(ids.balanced);
    });
});
