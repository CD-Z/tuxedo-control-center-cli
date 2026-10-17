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

import { Mutex } from 'async-mutex';
import type { ITccProfile } from '../../common/models/TccProfile';
import type { ResolvedPowerProfiles, StandardProfile } from '../../common/models/PowerProfiles';
import { ProfileStates, type ITccSettings } from '../../common/models/TccSettings';

export type ProfileSelectionPersistence = 'temporary' | 'current-power-state';

export interface ProfileSelectionHold {
    applicationId: string;
    profile: 'power-saver' | 'performance';
    reason: string;
}

export interface ProfileSelectionWithdrawal {
    operation: string;
    cause: unknown;
    rollbackError?: unknown;
}

export interface ProfileSelectionDependencies {
    /** Returns the full built-in and custom catalog for the supplied custom profiles. */
    catalog(profiles: readonly ITccProfile[]): readonly ITccProfile[];
    /** Resolves standard IDs from already-validated settings and the full catalog. */
    resolveMappings(settings: ITccSettings, catalog: readonly ITccProfile[]): ResolvedPowerProfiles;
    /** Supplies the initial AC/battery state. Later changes use powerStateChanged. */
    powerSource(): ProfileStates;
    /** Applies one profile with its settings; the caller must not reacquire the transition mutex. */
    applyProfile(profile: ITccProfile, settings: ITccSettings): Promise<void>;
    /** Publishes the active profile only after hardware and persistence commit. */
    publishProfile?(profile: ITccProfile): void;
    /** Atomically persists settings, or rejects without changing the stored snapshot. */
    persistSettings(settings: ITccSettings): Promise<void>;
    /** Sends ProfileReleased to one owner. Delivery is best-effort. */
    notifyProfileReleased(owner: string, cookie: number): Promise<void> | void;
    /** Withdraws the provider when the applied profile can no longer be trusted. */
    onWithdraw(reason: ProfileSelectionWithdrawal): Promise<void> | void;
    /** Share the daemon's profile-transition mutex when one already exists. */
    mutex?: Mutex;
}

export type ProfileSelectionErrorCode = 'invalid-args' | 'access-denied' | 'limits-exceeded' | 'failed' | 'withdrawn';

export class ProfileSelectionError extends Error {
    public constructor(
        public readonly code: ProfileSelectionErrorCode,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ProfileSelectionError';
    }
}

interface HeldProfile {
    owner: string;
    profile: 'power-saver' | 'performance';
    reason: string;
    applicationId: string;
}

const standardProfiles: StandardProfile[] = ['power-saver', 'balanced', 'performance'];
const heldProfiles: Partial<Record<StandardProfile, true>> = {
    'power-saver': true,
    performance: true,
};
const maxCookie = 0xffffffff;

function cloneValue<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneValue(entry)) as T;
    }
    if (value !== null && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            result[key] = cloneValue((value as Record<string, unknown>)[key]);
        }
        return result as T;
    }
    return value;
}

function isProfileState(state: ProfileStates): boolean {
    return state === ProfileStates.AC || state === ProfileStates.BAT;
}

function isStandardProfile(value: string): value is StandardProfile {
    return standardProfiles.includes(value as StandardProfile);
}

export class ProfileSelection {
    private readonly mutex: Mutex;
    private readonly disconnectingOwners = new Map<string, number>();
    private readonly dependencies: ProfileSelectionDependencies;
    private settingsSnapshot?: ITccSettings;
    private profilesById: Map<string, ITccProfile> = new Map();
    private sourceProfiles: ITccProfile[] = [];
    private resolvedMappings: ResolvedPowerProfiles = {};
    private holds: Map<number, HeldProfile> = new Map();
    private temporaryTccId?: string;
    private activeSnapshot?: ITccProfile;
    private currentPowerState: ProfileStates;
    private nextCookie = 1;
    private initialized = false;
    private withdrawn = false;

    public constructor(dependencies: ProfileSelectionDependencies) {
        this.dependencies = dependencies;
        this.mutex = dependencies.mutex ?? new Mutex();
        this.currentPowerState = dependencies.powerSource();
        if (!isProfileState(this.currentPowerState)) {
            throw new ProfileSelectionError('invalid-args', `Unsupported power state '${this.currentPowerState}'`);
        }
    }

    /** The last successfully applied profile, never an in-flight candidate. */
    public get activeProfile(): ITccProfile | undefined {
        if (this.withdrawn || this.activeSnapshot === undefined) {
            return undefined;
        }
        return cloneValue(this.activeSnapshot);
    }

    public get activeProfileId(): string | undefined {
        return this.activeProfile?.id;
    }

    public get activeStandardProfile(): StandardProfile | undefined {
        const activeId = this.activeProfileId;
        if (activeId === undefined) {
            return undefined;
        }
        return standardProfiles.find((standard) => this.resolvedMappings[standard] === activeId);
    }

    /** Includes losing holds, but omits owner names and cookies. */
    public get activeProfileHolds(): ProfileSelectionHold[] {
        return [...this.holds.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, hold]) => ({
                applicationId: hold.applicationId,
                profile: hold.profile,
                reason: hold.reason,
            }));
    }

    public get settings(): ITccSettings | undefined {
        return this.settingsSnapshot === undefined ? undefined : cloneValue(this.settingsSnapshot);
    }

    public get profiles(): ITccProfile[] {
        return [...this.profilesById.values()].map((profile) => cloneValue(profile));
    }

    public get mappings(): ResolvedPowerProfiles {
        return { ...this.resolvedMappings };
    }

    public get powerState(): ProfileStates {
        return this.currentPowerState;
    }

    public get available(): boolean {
        return this.initialized && !this.withdrawn;
    }

    public async selectTccProfile(id: string, persistence: ProfileSelectionPersistence): Promise<void> {
        return this.mutex.runExclusive(async () => {
            this.ensureAvailable();
            if (persistence !== 'temporary' && persistence !== 'current-power-state') {
                throw new ProfileSelectionError(
                    'invalid-args',
                    `Unsupported profile persistence mode '${persistence}'`,
                );
            }
            const settings = this.requireSettings();
            const profile = this.requireProfile(this.profilesById, id);
            if (settings.ppd?.enabled && !Object.values(this.resolvedMappings).includes(id)) {
                throw new ProfileSelectionError('invalid-args', `TCC profile '${id}' is not mapped to a power profile`);
            }

            if (id === this.effectiveProfileId() && id === this.activeSnapshot?.id) {
                return;
            }

            const previousApplied = this.activeSnapshot;
            const canceledHolds = [...this.holds.entries()];

            const candidateSettings = cloneValue(settings);
            let candidateTemporaryId: string | undefined;
            let persist: (() => Promise<void>) | undefined;
            if (persistence === 'current-power-state') {
                candidateSettings.stateMap[this.currentPowerState] = id;
                persist = () => this.dependencies.persistSettings(cloneValue(candidateSettings));
            } else {
                candidateTemporaryId = id;
            }

            try {
                await this.applyWithRollback(
                    profile,
                    previousApplied,
                    `Manual selection of TCC profile '${id}'`,
                    persist,
                    candidateSettings,
                );
            } catch (error) {
                if (!this.withdrawn) {
                    this.holds.clear();
                    await this.notifyReleased(canceledHolds);
                    if (previousApplied !== undefined) {
                        this.publishProfile(previousApplied);
                    }
                }
                throw error;
            }

            this.holds.clear();
            if (persistence === 'current-power-state') {
                this.settingsSnapshot = candidateSettings;
            }
            this.temporaryTccId = candidateTemporaryId;
            this.activeSnapshot = cloneValue(profile);
            await this.notifyReleased(canceledHolds);
            this.publishProfile(profile);
        });
    }

    public async holdProfile(owner: string, profile: string, reason: string, applicationId: string): Promise<number> {
        return this.mutex.runExclusive(async () => {
            this.ensureAvailable();
            if (this.isDisconnecting(owner)) {
                throw new ProfileSelectionError(
                    'access-denied',
                    'The hold owner disconnected before the hold was processed',
                );
            }
            if (!Object.hasOwn(heldProfiles, profile)) {
                throw new ProfileSelectionError('invalid-args', `Profile '${profile}' cannot be held`);
            }
            const standard = profile as 'power-saver' | 'performance';
            const mappedId = this.resolvedMappings[standard];
            if (mappedId === undefined) {
                throw new ProfileSelectionError('invalid-args', `Power profile '${standard}' is unavailable`);
            }
            const cookie = this.allocateCookie();
            const oldEffectiveId = this.effectiveProfileId();
            const oldEffectiveProfile = this.requireProfile(this.profilesById, oldEffectiveId);
            const candidateHolds = new Map(this.holds);
            candidateHolds.set(cookie, {
                owner,
                profile: standard,
                reason,
                applicationId,
            });
            const targetId = this.effectiveProfileId(this.requireSettings(), this.resolvedMappings, candidateHolds);
            const targetProfile = this.requireProfile(this.profilesById, targetId);
            let appliedCandidate = false;
            if (targetId !== oldEffectiveId) {
                if (this.isDisconnecting(owner)) {
                    throw new ProfileSelectionError(
                        'access-denied',
                        'The hold owner disconnected before application began',
                    );
                }
                await this.applyWithRollback(
                    targetProfile,
                    this.activeSnapshot,
                    `Hold for '${standard}' targeting TCC profile '${targetId}'`,
                );
                appliedCandidate = true;
            }

            if (this.isDisconnecting(owner)) {
                if (appliedCandidate) {
                    try {
                        await this.applyProfile(oldEffectiveProfile, this.requireSettings());
                        this.activeSnapshot = cloneValue(oldEffectiveProfile);
                    } catch (error) {
                        const cause = new ProfileSelectionError(
                            'failed',
                            'The hold owner disconnected during profile application',
                        );
                        await this.withdraw({
                            operation: `Restore profile '${oldEffectiveProfile.id}' after abandoned hold`,
                            cause,
                            rollbackError: error,
                        });
                        throw new ProfileSelectionError(
                            'failed',
                            `Could not restore TCC profile '${oldEffectiveProfile.id}' after the hold owner disconnected`,
                            error,
                        );
                    }
                }
                throw new ProfileSelectionError(
                    'failed',
                    'The hold owner disconnected before the hold could be committed',
                );
            }

            this.holds = candidateHolds;
            if (appliedCandidate) {
                this.activeSnapshot = cloneValue(targetProfile);
                this.publishProfile(targetProfile);
            }
            return cookie;
        });
    }

    public async releaseProfile(owner: string, cookie: number): Promise<void> {
        return this.mutex.runExclusive(async () => {
            this.ensureAvailable();
            const hold = this.holds.get(cookie);
            if (hold === undefined) {
                throw new ProfileSelectionError('invalid-args', `Unknown profile hold cookie '${cookie}'`);
            }
            if (hold.owner !== owner) {
                throw new ProfileSelectionError('access-denied', 'A profile hold can only be released by its owner');
            }

            const candidateHolds = new Map(this.holds);
            candidateHolds.delete(cookie);
            const targetId = this.effectiveProfileId(this.requireSettings(), this.resolvedMappings, candidateHolds);
            const targetProfile = this.requireProfile(this.profilesById, targetId);
            if (targetId !== this.activeSnapshot?.id) {
                await this.applyWithRollback(
                    targetProfile,
                    this.activeSnapshot,
                    `Release of cookie '${cookie}' restoring TCC profile '${targetId}'`,
                );
                this.activeSnapshot = cloneValue(targetProfile);
            }
            this.holds = candidateHolds;
            await this.notifyReleased([[cookie, hold]]);
            this.publishProfile(this.activeSnapshot ?? targetProfile);
        });
    }

    public async disconnect(owner: string): Promise<void> {
        this.markDisconnecting(owner);
        try {
            await this.mutex.runExclusive(async () => {
                if (!this.initialized || this.withdrawn) {
                    return;
                }
                const removed = [...this.holds.entries()].filter(([, hold]) => hold.owner === owner);
                if (removed.length === 0) {
                    return;
                }
                const candidateHolds = new Map(this.holds);
                for (const [cookie] of removed) {
                    candidateHolds.delete(cookie);
                }
                const targetId = this.effectiveProfileId(this.requireSettings(), this.resolvedMappings, candidateHolds);
                const targetProfile = this.requireProfile(this.profilesById, targetId);
                let applicationError: unknown;
                if (targetId !== this.activeSnapshot?.id) {
                    try {
                        await this.applyWithRollback(
                            targetProfile,
                            this.activeSnapshot,
                            `Disconnect cleanup restoring TCC profile '${targetId}'`,
                        );
                        this.activeSnapshot = cloneValue(targetProfile);
                    } catch (error) {
                        applicationError = error;
                    }
                }
                this.holds = candidateHolds;
                await this.notifyReleased(removed);
                this.publishProfile(this.activeSnapshot ?? targetProfile);
                if (applicationError !== undefined) {
                    throw applicationError;
                }
            });
        } finally {
            this.unmarkDisconnecting(owner);
        }
    }

    public async powerStateChanged(state: ProfileStates): Promise<void> {
        return this.mutex.runExclusive(async () => {
            this.ensureAvailable();
            if (!isProfileState(state)) {
                throw new ProfileSelectionError('invalid-args', `Unsupported power state '${state}'`);
            }
            if (state === this.currentPowerState) {
                return;
            }

            const previousEffectiveId = this.effectiveProfileId();
            const targetId = this.effectiveProfileId(
                this.requireSettings(),
                this.resolvedMappings,
                this.holds,
                state,
                null,
            );
            const targetProfile = this.requireProfile(this.profilesById, targetId);
            const previousApplied = this.activeSnapshot;

            if (targetId !== previousEffectiveId || targetId !== this.activeSnapshot?.id) {
                await this.applyWithRollback(
                    targetProfile,
                    previousApplied,
                    `Power-state change to '${state}' targeting TCC profile '${targetId}'`,
                );
                this.currentPowerState = state;
                this.temporaryTccId = undefined;
                this.activeSnapshot = cloneValue(targetProfile);
                this.publishProfile(targetProfile);
            } else {
                this.currentPowerState = state;
                this.temporaryTccId = undefined;
            }
        });
    }

    public async reload(settings: ITccSettings, profiles: ITccProfile[], persist?: () => Promise<void>): Promise<void> {
        return this.mutex.runExclusive(() => this.reloadWithinTransition(settings, profiles, persist));
    }

    public async reloadWithinTransition(
        settings: ITccSettings,
        profiles: ITccProfile[],
        persist?: () => Promise<void>,
    ): Promise<void> {
        const candidateSettings = cloneValue(settings);
        const candidateCatalog = this.buildCatalog(profiles);
        const candidateMappings = this.resolveMappings(candidateSettings, candidateCatalog);

        const previousAssignment = this.settingsSnapshot?.stateMap?.[this.currentPowerState];
        const candidateTemporaryId =
            candidateSettings.stateMap?.[this.currentPowerState] === previousAssignment
                ? this.temporaryTccId
                : undefined;
        if (candidateTemporaryId !== undefined) {
            this.requireProfile(candidateCatalog, candidateTemporaryId);
            if (candidateSettings.ppd?.enabled && !Object.values(candidateMappings).includes(candidateTemporaryId)) {
                throw new ProfileSelectionError(
                    'invalid-args',
                    `Temporary TCC profile '${candidateTemporaryId}' is not mapped to a power profile`,
                );
            }
        }

        const candidateHolds = new Map<number, HeldProfile>();
        const canceledHolds: Array<[number, HeldProfile]> = [];
        for (const [cookie, hold] of this.holds) {
            if (candidateMappings[hold.profile] === undefined) {
                canceledHolds.push([cookie, hold]);
            } else {
                candidateHolds.set(cookie, hold);
            }
        }
        const targetId = this.effectiveProfileId(
            candidateSettings,
            candidateMappings,
            candidateHolds,
            this.currentPowerState,
            candidateTemporaryId ?? null,
        );
        const targetProfile = this.requireProfile(candidateCatalog, targetId);
        const previousApplied = this.withdrawn ? undefined : this.activeSnapshot;

        await this.applyWithRollback(
            targetProfile,
            previousApplied,
            `Configuration reload targeting TCC profile '${targetId}'`,
            persist,
            candidateSettings,
        );

        this.settingsSnapshot = candidateSettings;
        this.profilesById = candidateCatalog;
        this.sourceProfiles = profiles.map((profile) => cloneValue(profile));
        this.resolvedMappings = candidateMappings;
        this.temporaryTccId = candidateTemporaryId;
        this.holds = candidateHolds;
        this.activeSnapshot = cloneValue(targetProfile);
        this.initialized = true;
        this.withdrawn = false;
        await this.notifyReleased(canceledHolds);
        this.publishProfile(targetProfile);
    }
    public async updateConfiguration(
        settings?: ITccSettings,
        profiles?: ITccProfile[],
        persist?: (settings: ITccSettings, profiles: ITccProfile[]) => Promise<void>,
    ): Promise<void> {
        return this.mutex.runExclusive(async () => {
            const candidateSettings = cloneValue(settings ?? this.requireSettings());
            const candidateProfiles = cloneValue(profiles ?? this.sourceProfiles);
            await this.reloadWithinTransition(
                candidateSettings,
                candidateProfiles,
                persist === undefined
                    ? undefined
                    : async (): Promise<void> => {
                          await persist(candidateSettings, candidateProfiles);
                      },
            );
        });
    }

    public get isAvailable(): boolean {
        return this.initialized && !this.withdrawn;
    }
    public validateSettingsUpdate(settings: ITccSettings): void {
        this.ensureAvailable();
        const candidate = cloneValue(settings);
        const candidateMappings = this.resolveMappings(candidate, this.profilesById);
        const current = this.requireSettings();
        if (
            candidate.stateMap.power_ac !== current.stateMap.power_ac ||
            candidate.stateMap.power_bat !== current.stateMap.power_bat ||
            standardProfiles.some((profile) => candidateMappings[profile] !== this.resolvedMappings[profile])
        ) {
            throw new ProfileSelectionError(
                'invalid-args',
                'Profile mappings and state assignments must be changed through selector reload',
            );
        }
    }

    public commitSettingsUpdate(settings: ITccSettings): void {
        this.settingsSnapshot = cloneValue(settings);
    }
    private buildCatalog(profiles: readonly ITccProfile[]): Map<string, ITccProfile> {
        const combined = this.dependencies.catalog(profiles.map((profile) => cloneValue(profile)));
        const result = new Map<string, ITccProfile>();
        for (const profile of combined) {
            if (
                profile === null ||
                typeof profile !== 'object' ||
                typeof profile.id !== 'string' ||
                profile.id.length === 0 ||
                result.has(profile.id)
            ) {
                throw new ProfileSelectionError('invalid-args', `Invalid or duplicate TCC profile ID '${profile?.id}'`);
            }
            result.set(profile.id, cloneValue(profile));
        }
        return result;
    }

    private resolveMappings(settings: ITccSettings, catalog: Map<string, ITccProfile>): ResolvedPowerProfiles {
        if (settings.ppd !== undefined && typeof settings.ppd.enabled !== 'boolean') {
            throw new ProfileSelectionError('invalid-args', 'Power-profiles-daemon enabled must be a boolean');
        }
        if (!settings.ppd?.enabled) {
            return {};
        }

        const resolved = this.dependencies.resolveMappings(
            cloneValue(settings),
            [...catalog.values()].map((profile) => cloneValue(profile)),
        );
        const mappings: ResolvedPowerProfiles = {};
        for (const key of Object.keys(resolved)) {
            if (!isStandardProfile(key)) {
                throw new ProfileSelectionError('invalid-args', `Unknown standard power profile '${key}'`);
            }
            const id = resolved[key];
            if (id === undefined || typeof id !== 'string' || id.length === 0) {
                throw new ProfileSelectionError('invalid-args', `Invalid TCC mapping for power profile '${key}'`);
            }
            if (!catalog.has(id)) {
                throw new ProfileSelectionError(
                    'invalid-args',
                    `Unknown TCC profile ID '${id}' for power profile '${key}'`,
                );
            }
            mappings[key] = id;
        }

        if (mappings['power-saver'] === undefined || mappings.balanced === undefined) {
            throw new ProfileSelectionError('invalid-args', 'Power-saver and balanced mappings are required');
        }
        const mappedIds = Object.values(mappings);
        if (new Set(mappedIds).size !== mappedIds.length) {
            throw new ProfileSelectionError(
                'invalid-args',
                'Standard power profiles must map to distinct TCC profile IDs',
            );
        }
        for (const state of [ProfileStates.AC, ProfileStates.BAT]) {
            const assignment = settings.stateMap?.[state];
            if (typeof assignment !== 'string' || !mappedIds.includes(assignment)) {
                throw new ProfileSelectionError(
                    'invalid-args',
                    `Saved ${state} assignment is not mapped by power-profiles-daemon`,
                );
            }
        }
        return mappings;
    }

    private effectiveProfileId(
        settings: ITccSettings = this.requireSettings(),
        mappings: ResolvedPowerProfiles = this.resolvedMappings,
        holds: Map<number, HeldProfile> = this.holds,
        state: ProfileStates = this.currentPowerState,
        temporaryId: string | null = this.temporaryTccId,
    ): string {
        for (const hold of holds.values()) {
            if (hold.profile === 'power-saver') {
                const id = mappings['power-saver'];
                if (id === undefined) {
                    throw new ProfileSelectionError('invalid-args', 'A power-saver hold has no configured TCC mapping');
                }
                return id;
            }
        }
        for (const hold of holds.values()) {
            if (hold.profile === 'performance') {
                const id = mappings.performance;
                if (id === undefined) {
                    throw new ProfileSelectionError('invalid-args', 'A performance hold has no configured TCC mapping');
                }
                return id;
            }
        }
        const id = (temporaryId === null ? undefined : temporaryId) ?? settings.stateMap?.[state];
        if (typeof id !== 'string' || id.length === 0) {
            throw new ProfileSelectionError('invalid-args', `No TCC profile is assigned for power state '${state}'`);
        }
        return id;
    }

    private requireProfile(catalog: Map<string, ITccProfile>, id: string | undefined): ITccProfile {
        if (typeof id !== 'string' || id.length === 0) {
            throw new ProfileSelectionError('invalid-args', 'A selected TCC profile ID is required');
        }
        const profile = catalog.get(id);
        if (profile === undefined) {
            throw new ProfileSelectionError('invalid-args', `TCC profile '${id}' is unavailable`);
        }
        return profile;
    }

    private requireSettings(): ITccSettings {
        if (this.settingsSnapshot === undefined) {
            throw new ProfileSelectionError('failed', 'Profile selection has not completed its initial reload');
        }
        return this.settingsSnapshot;
    }

    private ensureAvailable(): void {
        if (this.withdrawn) {
            throw new ProfileSelectionError('withdrawn', 'Profile selection is withdrawn after a failed restoration');
        }
        if (!this.initialized || this.settingsSnapshot === undefined) {
            throw new ProfileSelectionError('failed', 'Profile selection has not completed its initial reload');
        }
    }

    private allocateCookie(): number {
        if (this.nextCookie > maxCookie) {
            throw new ProfileSelectionError('limits-exceeded', 'Profile hold cookie space is exhausted');
        }
        return this.nextCookie++;
    }

    private async applyWithRollback(
        profile: ITccProfile,
        previous: ITccProfile | undefined,
        operation: string,
        afterApply?: () => Promise<void>,
        settings: ITccSettings = this.requireSettings(),
    ): Promise<void> {
        const rollbackSettings = this.settingsSnapshot ?? settings;
        try {
            await this.applyProfile(profile, settings);
            await afterApply?.();
        } catch (cause) {
            if (previous === undefined || this.withdrawn) {
                await this.withdraw({ operation, cause });
                throw new ProfileSelectionError(
                    'failed',
                    `${operation} failed and no prior applied profile is available for rollback`,
                    cause,
                );
            }
            try {
                await this.applyProfile(previous, rollbackSettings);
            } catch (rollbackError) {
                await this.withdraw({ operation, cause, rollbackError });
                throw new ProfileSelectionError(
                    'failed',
                    `${operation} failed and rollback to TCC profile '${previous.id}' also failed`,
                    cause,
                );
            }
            throw new ProfileSelectionError(
                'failed',
                `${operation} failed; TCC profile '${previous.id}' was restored`,
                cause,
            );
        }
    }

    private async applyProfile(profile: ITccProfile, settings: ITccSettings): Promise<void> {
        await this.dependencies.applyProfile(cloneValue(profile), cloneValue(settings));
    }
    private async withdraw(reason: ProfileSelectionWithdrawal): Promise<void> {
        if (this.withdrawn) {
            return;
        }
        this.withdrawn = true;
        this.activeSnapshot = undefined;
        const canceled = [...this.holds.entries()];
        this.holds.clear();
        await this.notifyReleased(canceled);
        try {
            await this.dependencies.onWithdraw(reason);
        } catch {
            // Provider withdrawal is best-effort, but local mutations stay blocked.
        }
    }

    private async notifyReleased(holds: Array<[number, HeldProfile]>): Promise<void> {
        for (const [cookie, hold] of holds) {
            try {
                await this.dependencies.notifyProfileReleased(hold.owner, cookie);
            } catch {
                // A disconnected holder cannot receive its targeted release signal.
            }
        }
    }
    private publishProfile(profile: ITccProfile): void {
        this.dependencies.publishProfile?.(cloneValue(profile));
    }

    private isDisconnecting(owner: string): boolean {
        return (this.disconnectingOwners.get(owner) ?? 0) > 0;
    }

    private markDisconnecting(owner: string): void {
        this.disconnectingOwners.set(owner, (this.disconnectingOwners.get(owner) ?? 0) + 1);
    }

    private unmarkDisconnecting(owner: string): void {
        const count = this.disconnectingOwners.get(owner) ?? 0;
        if (count <= 1) {
            this.disconnectingOwners.delete(owner);
        } else {
            this.disconnectingOwners.set(owner, count - 1);
        }
    }
}
