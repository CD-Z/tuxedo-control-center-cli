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

import { Component, type OnDestroy, type OnInit } from '@angular/core';
import type {
    IPowerProfilesConfig,
    PowerProfilesRuntimeState,
    ResolvedPowerProfiles,
    StandardProfile,
} from '../../../common/models/PowerProfiles';
import { PowerProfilesConfig } from '../../../common/classes/PowerProfilesConfig';
import type { ITccProfile } from '../../../common/models/TccProfile';
import type { ITccSettings } from '../../../common/models/TccSettings';
// biome-ignore lint: injection token
import { ConfigService } from '../config.service';
// biome-ignore lint: injection token
import { TccDBusClientService } from '../tcc-dbus-client.service';
// biome-ignore lint: injection token
import { UtilsService } from '../utils.service';
import { Subscription } from 'rxjs';

interface MappingProfileOption {
    kind: 'profile';
    id: string;
    profile?: ITccProfile;
    unavailable: boolean;
}

type MappingChoice = { kind: 'automatic' } | { kind: 'none' } | MappingProfileOption;

type AssignmentState = 'power_ac' | 'power_bat';

interface AssignmentOption {
    id: string;
    profile?: ITccProfile;
    invalid: boolean;
    missing: boolean;
}

interface PowerProfilesDraft {
    ppd: IPowerProfilesConfig;
    power_ac: string;
    power_bat: string;
}

@Component({
    selector: 'app-power-profiles-settings',
    templateUrl: './power-profiles-settings.component.html',
    styleUrls: ['./power-profiles-settings.component.scss'],
    standalone: false,
})
export class PowerProfilesSettingsComponent implements OnInit, OnDestroy {
    public readonly automaticChoice: MappingChoice = { kind: 'automatic' };
    public readonly noneChoice: MappingChoice = { kind: 'none' };

    public catalog: ITccProfile[] = [];
    public draftPpd: IPowerProfilesConfig = { enabled: false };
    public draftAssignments: Pick<PowerProfilesDraft, 'power_ac' | 'power_bat'> = { power_ac: '', power_bat: '' };
    public mappingOptions: Record<StandardProfile, MappingProfileOption[]> = {
        'power-saver': [],
        balanced: [],
        performance: [],
    };
    public assignmentOptions: Record<AssignmentState, AssignmentOption[]> = { power_ac: [], power_bat: [] };
    public invalidAssignments: Record<AssignmentState, boolean> = { power_ac: false, power_bat: false };
    public resolvedMappings: ResolvedPowerProfiles = {};
    public validationError: string | null = null;
    public runtimeState: PowerProfilesRuntimeState | undefined;
    public runtimeLoading: boolean = false;
    public runtimeUnavailable: boolean = false;
    public isSaving: boolean = false;
    public isDirty: boolean = false;
    public saveStatus: 'saved' | 'save-failed' | 'adoption-unverified' | 'adoption-mismatch' | null = null;

    private savedSettings: ITccSettings | undefined;
    private baselineSnapshot: string = '';
    private subscriptions: Subscription = new Subscription();
    private destroyed: boolean = false;
    private runtimeRequestId: number = 0;
    private runtimeRefreshQueue: Promise<void> = Promise.resolve();

    constructor(
        private config: ConfigService,
        private dbus: TccDBusClientService,
        private utils: UtilsService,
    ) {}

    public ngOnInit(): void {
        this.catalog = this.config.getAllProfiles() ?? [];
        this.resetDraft(this.config.getSettings());

        this.subscriptions.add(
            this.config.observeSettings.subscribe((settings: ITccSettings): void => {
                this.onAuthoritativeSettings(settings);
            }),
        );
        this.subscriptions.add(
            this.dbus.defaultProfiles.subscribe((): void => {
                this.refreshCatalog();
            }),
        );
        this.subscriptions.add(
            this.dbus.customProfiles.subscribe((): void => {
                this.refreshCatalog();
            }),
        );

        void this.refreshRuntimeState();
    }

    public ngOnDestroy(): void {
        this.destroyed = true;
        this.runtimeRequestId++;
        this.subscriptions.unsubscribe();
    }

    public get savedEnabled(): boolean {
        return this.savedSettings?.ppd?.enabled === true;
    }

    public selectedMapping(profile: StandardProfile): MappingChoice {
        const configured = this.draftPpd.profiles?.[profile];
        if (configured === undefined) {
            return this.automaticChoice;
        }
        if (configured === null) {
            return this.noneChoice;
        }
        return (
            this.mappingOptions[profile].find((option: MappingProfileOption): boolean => option.id === configured) ?? {
                kind: 'profile',
                id: configured,
                unavailable: true,
            }
        );
    }

    public compareMappingChoice(left: MappingChoice | null, right: MappingChoice | null): boolean {
        if (left === right) {
            return true;
        }
        if (left === null || right === null || left.kind !== right.kind) {
            return false;
        }
        return left.kind !== 'profile' || (right.kind === 'profile' && left.id === right.id);
    }

    public setEnabled(enabled: boolean): void {
        if (this.isSaving || this.draftPpd.enabled === enabled) {
            return;
        }
        this.draftPpd = { ...this.draftPpd, enabled };
        this.saveStatus = null;
        this.updateDirty();
        this.updateValidationAndChoices();
    }

    public setMapping(profile: StandardProfile, choice: MappingChoice): void {
        if (this.isSaving || choice === undefined) {
            return;
        }

        const profiles = { ...(this.draftPpd.profiles ?? {}) };
        if (choice.kind === 'automatic') {
            delete profiles[profile];
        } else if (choice.kind === 'none') {
            if (profile !== 'performance') {
                return;
            }
            profiles.performance = null;
        } else {
            profiles[profile] = choice.id;
        }

        this.draftPpd = { ...this.draftPpd };
        if (Object.keys(profiles).length > 0) {
            this.draftPpd.profiles = profiles;
        } else {
            delete this.draftPpd.profiles;
        }
        this.saveStatus = null;
        this.updateDirty();
        this.updateValidationAndChoices();
    }

    public setAssignment(state: AssignmentState, profileId: string): void {
        if (this.isSaving || this.draftAssignments[state] === profileId) {
            return;
        }
        this.draftAssignments = { ...this.draftAssignments, [state]: profileId };
        this.saveStatus = null;
        this.updateDirty();
        this.updateValidationAndChoices();
    }

    public async refreshRuntimeState(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        const requestId: number = ++this.runtimeRequestId;
        this.runtimeLoading = true;
        this.runtimeUnavailable = false;

        const runRefresh = async (): Promise<void> => {
            if (this.destroyed || requestId !== this.runtimeRequestId) {
                return;
            }
            try {
                const state: PowerProfilesRuntimeState = await window.dbusAPI.getPowerProfilesRuntimeState();
                if (!state) {
                    throw new Error('Power Profiles runtime state is unavailable.');
                }
                if (this.destroyed || requestId !== this.runtimeRequestId) {
                    return;
                }
                this.runtimeState = state;
                this.runtimeUnavailable = false;
            } catch {
                if (this.destroyed || requestId !== this.runtimeRequestId) {
                    return;
                }
                this.runtimeState = undefined;
                this.runtimeUnavailable = true;
            } finally {
                if (!this.destroyed && requestId === this.runtimeRequestId) {
                    this.runtimeLoading = false;
                }
            }
        };

        const queued: Promise<void> = this.runtimeRefreshQueue.then(runRefresh, runRefresh);
        this.runtimeRefreshQueue = queued;
        await queued;
    }

    public async apply(): Promise<void> {
        if (this.isSaving) {
            return;
        }

        const latestSettings: ITccSettings | undefined = this.config.getSettings() ?? this.savedSettings;
        if (latestSettings === undefined) {
            return;
        }

        this.updateValidationAndChoices();
        if (this.draftPpd.enabled && this.validationError !== null) {
            return;
        }

        const candidate: ITccSettings = this.createCandidate(latestSettings);
        this.saveStatus = null;
        this.isSaving = true;

        const previousPageDisabled: boolean = this.utils.pageDisabled;
        this.utils.pageDisabled = true;
        try {
            let written: boolean = false;
            try {
                written = await this.config.saveSettings(candidate);
            } catch {
                written = false;
            }

            if (this.destroyed) {
                return;
            }
            if (!written) {
                this.saveStatus = 'save-failed';
                return;
            }

            try {
                const adoptedSettings: ITccSettings = await this.dbus.refreshSettings();
                if (this.destroyed) {
                    return;
                }
                const adopted: boolean = this.settingsMatch(candidate, adoptedSettings);
                this.resetDraft(adoptedSettings);
                this.saveStatus = adopted ? 'saved' : 'adoption-mismatch';
            } catch {
                if (this.destroyed) {
                    return;
                }
                this.saveStatus = 'adoption-unverified';
            }

            await this.refreshRuntimeState();
        } finally {
            this.utils.pageDisabled = previousPageDisabled;
            if (!this.destroyed) {
                this.isSaving = false;
            }
        }
    }

    public discard(): void {
        if (this.isSaving) {
            return;
        }
        this.resetDraft(this.savedSettings);
        this.saveStatus = null;
    }

    private onAuthoritativeSettings(settings: ITccSettings): void {
        if (settings === undefined) {
            return;
        }
        if (!this.isDirty && !this.isSaving) {
            this.resetDraft(settings);
            return;
        }
        this.savedSettings = this.cloneSettings(settings);
        if (this.isSaving) {
            return;
        }
        this.baselineSnapshot = this.snapshot({
            ppd: settings.ppd ?? { enabled: false },
            power_ac: settings.stateMap.power_ac,
            power_bat: settings.stateMap.power_bat,
        });
        this.updateDirty();
    }

    private refreshCatalog(): void {
        this.catalog = this.config.getAllProfiles() ?? [];
        if (!this.isDirty && !this.isSaving) {
            this.resetDraft(this.config.getSettings() ?? this.savedSettings);
        } else {
            this.updateValidationAndChoices();
        }
    }

    private resetDraft(settings: ITccSettings | undefined): void {
        this.savedSettings = settings === undefined ? undefined : this.cloneSettings(settings);
        this.draftPpd = settings?.ppd === undefined ? { enabled: false } : this.clonePpd(settings.ppd);
        this.draftAssignments = {
            power_ac: settings?.stateMap?.power_ac ?? '',
            power_bat: settings?.stateMap?.power_bat ?? '',
        };
        this.baselineSnapshot = this.snapshot({
            ppd: this.draftPpd,
            power_ac: this.draftAssignments.power_ac,
            power_bat: this.draftAssignments.power_bat,
        });
        this.isDirty = false;
        this.saveStatus = null;
        this.updateValidationAndChoices();
    }

    private updateDirty(): void {
        this.isDirty =
            this.snapshot({
                ppd: this.draftPpd,
                power_ac: this.draftAssignments.power_ac,
                power_bat: this.draftAssignments.power_bat,
            }) !== this.baselineSnapshot;
    }

    private snapshot(draft: PowerProfilesDraft): string {
        return JSON.stringify({
            enabled: draft.ppd.enabled,
            power_saver: draft.ppd.profiles?.['power-saver'],
            balanced: draft.ppd.profiles?.balanced,
            performance: draft.ppd.profiles?.performance,
            power_ac: draft.power_ac,
            power_bat: draft.power_bat,
        });
    }

    private updateValidationAndChoices(): void {
        this.rebuildMappingOptions();
        this.resolvedMappings = {};
        this.validationError = null;

        if (this.draftPpd.enabled) {
            try {
                this.resolvedMappings = PowerProfilesConfig.resolveMappings(this.draftPpd.profiles, this.catalog);
                const settings: ITccSettings | undefined = this.config.getSettings() ?? this.savedSettings;
                if (settings !== undefined) {
                    PowerProfilesConfig.resolveCatalog(this.candidateForValidation(settings), this.catalog);
                }
            } catch (error: unknown) {
                this.validationError = error instanceof Error ? error.message : String(error);
            }
        }

        this.rebuildAssignmentOptions();
    }

    private rebuildMappingOptions(): void {
        const profilesFor = (profile: StandardProfile): MappingProfileOption[] => {
            const options: MappingProfileOption[] = this.catalog.map((entry: ITccProfile): MappingProfileOption => ({
                kind: 'profile',
                id: entry.id,
                profile: entry,
                unavailable: false,
            }));
            const configured = this.draftPpd.profiles?.[profile];
            if (
                typeof configured === 'string' &&
                !this.catalog.some((entry: ITccProfile): boolean => entry.id === configured)
            ) {
                options.push({ kind: 'profile', id: configured, unavailable: true });
            }
            return options;
        };

        this.mappingOptions = {
            'power-saver': profilesFor('power-saver'),
            balanced: profilesFor('balanced'),
            performance: profilesFor('performance'),
        };
    }

    private rebuildAssignmentOptions(): void {
        for (const state of ['power_ac', 'power_bat'] as AssignmentState[]) {
            const selected: string = this.draftAssignments[state];
            const allowedIds: Set<string> = new Set(
                this.draftPpd.enabled
                    ? Object.values(this.resolvedMappings)
                    : this.catalog.map((profile: ITccProfile): string => profile.id),
            );
            const ids: string[] = Array.from(allowedIds);
            if (selected.length > 0 && !allowedIds.has(selected)) {
                ids.push(selected);
            }
            this.assignmentOptions[state] = ids.map((id: string): AssignmentOption => {
                const profile: ITccProfile | undefined = this.catalog.find(
                    (entry: ITccProfile): boolean => entry.id === id,
                );
                const missing: boolean = profile === undefined;
                return {
                    id,
                    profile,
                    invalid: this.draftPpd.enabled && !allowedIds.has(id),
                    missing,
                };
            });
            this.invalidAssignments[state] = this.draftPpd.enabled && !allowedIds.has(selected);
        }
    }

    private candidateForValidation(settings: ITccSettings): ITccSettings {
        return {
            ...settings,
            ppd: this.clonePpd(this.draftPpd),
            stateMap: {
                ...settings.stateMap,
                power_ac: this.draftAssignments.power_ac,
                power_bat: this.draftAssignments.power_bat,
            },
        };
    }

    private createCandidate(settings: ITccSettings): ITccSettings {
        const candidate: ITccSettings = this.cloneSettings(settings);
        candidate.ppd = this.clonePpd(this.draftPpd);
        candidate.stateMap.power_ac = this.draftAssignments.power_ac;
        candidate.stateMap.power_bat = this.draftAssignments.power_bat;
        return candidate;
    }

    private settingsMatch(candidate: ITccSettings, actual: ITccSettings): boolean {
        if (candidate.ppd?.enabled !== actual.ppd?.enabled) {
            return false;
        }
        for (const profile of ['power-saver', 'balanced', 'performance'] as StandardProfile[]) {
            if (candidate.ppd?.profiles?.[profile] !== actual.ppd?.profiles?.[profile]) {
                return false;
            }
        }
        return (
            candidate.stateMap.power_ac === actual.stateMap.power_ac &&
            candidate.stateMap.power_bat === actual.stateMap.power_bat
        );
    }

    private clonePpd(ppd: IPowerProfilesConfig): IPowerProfilesConfig {
        return {
            ...ppd,
            ...(ppd.profiles === undefined ? {} : { profiles: { ...ppd.profiles } }),
        };
    }

    private cloneSettings(settings: ITccSettings): ITccSettings {
        return JSON.parse(JSON.stringify(settings)) as ITccSettings;
    }
}
