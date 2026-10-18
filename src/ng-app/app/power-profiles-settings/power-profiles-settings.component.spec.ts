/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 */

import { CommonModule } from '@angular/common';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import type { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonHarness } from '@angular/material/button/testing';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatCheckboxHarness } from '@angular/material/checkbox/testing';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatOptionHarness } from '@angular/material/core/testing';
import { MatSelectHarness } from '@angular/material/select/testing';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { BehaviorSubject, Subject } from 'rxjs';
import { PowerProfilesConfig } from '../../../common/classes/PowerProfilesConfig';
import { DefaultProfileIDs } from '../../../common/models/DefaultProfiles';
import type { PowerProfilesRuntimeState } from '../../../common/models/PowerProfiles';
import { defaultCustomProfile } from '../../../common/models/DefaultProfiles';
import type { ITccProfile } from '../../../common/models/TccProfile';
import { defaultSettings, type ITccSettings } from '../../../common/models/TccSettings';
import { ConfigService } from '../config.service';
import { TccDBusClientService } from '../tcc-dbus-client.service';
import { UtilsService } from '../utils.service';
import { PowerProfilesSettingsComponent } from './power-profiles-settings.component';

describe('PowerProfilesSettingsComponent', (): void => {
    let fixture: ComponentFixture<PowerProfilesSettingsComponent>;
    let component: PowerProfilesSettingsComponent;
    let loader: HarnessLoader;
    let getSettings: jasmine.Spy;
    let getAllProfiles: jasmine.Spy;
    let saveSettings: jasmine.Spy;
    let refreshSettings: jasmine.Spy;
    let runtimeState: jasmine.Spy;
    let settingsSubject: Subject<ITccSettings>;
    let defaultProfiles: BehaviorSubject<ITccProfile[]>;
    let customProfiles: BehaviorSubject<ITccProfile[]>;
    let utils: UtilsService;
    let catalog: ITccProfile[];
    let authoritativeSettings: ITccSettings;
    let writerResult: boolean;
    let adoptWriterCandidate: boolean;
    let refreshSettingsFailure: boolean;
    let refreshSettingsOverride: ITccSettings | undefined;
    let submittedCandidates: ITccSettings[];
    let originalDbusApi: typeof window.dbusAPI;

    const builtInProfileIds: string[] = [
        DefaultProfileIDs.MaxEnergySave,
        DefaultProfileIDs.Office,
        DefaultProfileIDs.HighPerformance,
    ];

    const makeProfile = (id: string, name: string): ITccProfile => ({
        ...structuredClone(defaultCustomProfile),
        id,
        name,
    });

    const defaultCatalog = (): ITccProfile[] => [
        makeProfile(DefaultProfileIDs.MaxEnergySave, 'Automatic saver'),
        makeProfile(DefaultProfileIDs.Office, 'Automatic balanced'),
        makeProfile(DefaultProfileIDs.HighPerformance, 'Automatic performance'),
        makeProfile('default', 'Shared name'),
        makeProfile('none', 'Shared name'),
        makeProfile('mapped-saver', 'Mapped saver'),
        makeProfile('mapped-balanced', 'Mapped balanced'),
        makeProfile('alternate-saver', 'Alternate saver'),
        makeProfile('custom-id', 'Custom profile'),
    ];

    const makeSettings = (ppd?: ITccSettings['ppd']): ITccSettings => ({
        ...structuredClone(defaultSettings),
        fahrenheit: true,
        stateMap: {
            power_ac: DefaultProfileIDs.MaxEnergySave,
            power_bat: DefaultProfileIDs.Office,
        },
        shutdownTime: '22:15',
        chargingProfile: 'stationary',
        ycbcr420Workaround: [{ connector: 'HDMI-1', enabled: true }],
        ppd,
    });

    const cloneSettings = (settings: ITccSettings): ITccSettings => structuredClone(settings);

    const setCatalog = (next: ITccProfile[]): void => {
        catalog = next;
        defaultProfiles.next(next.filter((profile: ITccProfile): boolean => builtInProfileIds.includes(profile.id)));
        customProfiles.next(next.filter((profile: ITccProfile): boolean => !builtInProfileIds.includes(profile.id)));
    };

    const createFixture = async (waitForStability: boolean = true): Promise<void> => {
        fixture = TestBed.createComponent(PowerProfilesSettingsComponent);
        component = fixture.componentInstance;
        loader = TestbedHarnessEnvironment.loader(fixture);
        fixture.detectChanges();
        if (waitForStability) {
            await fixture.whenStable();
            fixture.detectChanges();
        }
    };

    const checkbox = async (): Promise<MatCheckboxHarness> =>
        loader.getHarness(MatCheckboxHarness.with({ label: 'Enabled' }));

    const selectHarness = async (label: string): Promise<MatSelectHarness> =>
        loader.getHarness(MatSelectHarness.with({ label }));

    const optionsFor = async (label: string): Promise<{ options: MatOptionHarness[]; texts: string[] }> => {
        const select = await selectHarness(label);
        await select.open();
        const options = await select.getOptions();
        const texts: string[] = await Promise.all(
            options.map((option: MatOptionHarness): Promise<string> => option.getText()),
        );
        return {
            options,
            texts: texts.map((text: string): string => text.replace(/\s+/g, ' ').trim()),
        };
    };

    const choose = async (label: string, optionText: string): Promise<void> => {
        const { options, texts } = await optionsFor(label);
        const index: number = texts.findIndex((text: string): boolean => text === optionText);
        expect(index)
            .withContext(`Missing option "${optionText}" from ${label}: ${texts.join(', ')}`)
            .toBeGreaterThanOrEqual(0);
        await options[index].click();
        fixture.detectChanges();
    };

    const clickApply = async (): Promise<void> => {
        await (await loader.getHarness(MatButtonHarness.with({ text: 'Apply' }))).click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    };

    const textContent = (): string => fixture.nativeElement.textContent.replace(/\s+/g, ' ').trim();

    beforeEach(async (): Promise<void> => {
        catalog = defaultCatalog();
        authoritativeSettings = makeSettings();
        writerResult = true;
        adoptWriterCandidate = true;
        refreshSettingsFailure = false;
        refreshSettingsOverride = undefined;
        submittedCandidates = [];
        settingsSubject = new Subject<ITccSettings>();
        defaultProfiles = new BehaviorSubject<ITccProfile[]>(
            catalog.filter((profile: ITccProfile): boolean => builtInProfileIds.includes(profile.id)),
        );
        customProfiles = new BehaviorSubject<ITccProfile[]>(
            catalog.filter((profile: ITccProfile): boolean => !builtInProfileIds.includes(profile.id)),
        );
        utils = { pageDisabled: false } as UtilsService;
        originalDbusApi = window.dbusAPI;

        getSettings = jasmine.createSpy('getSettings').and.callFake((): ITccSettings => authoritativeSettings);
        getAllProfiles = jasmine.createSpy('getAllProfiles').and.callFake((): ITccProfile[] => catalog);
        saveSettings = jasmine
            .createSpy('saveSettings')
            .and.callFake(async (candidate: ITccSettings): Promise<boolean> => {
                expect(utils.pageDisabled).toBeTrue();
                submittedCandidates.push(cloneSettings(candidate));
                if (writerResult && adoptWriterCandidate) {
                    authoritativeSettings = cloneSettings(candidate);
                }
                return writerResult;
            });
        refreshSettings = jasmine.createSpy('refreshSettings').and.callFake(async (): Promise<ITccSettings> => {
            if (refreshSettingsFailure) {
                throw new Error('settings read failed');
            }
            authoritativeSettings = cloneSettings(refreshSettingsOverride ?? authoritativeSettings);
            settingsSubject.next(authoritativeSettings);
            return cloneSettings(authoritativeSettings);
        });
        runtimeState = jasmine
            .createSpy('getPowerProfilesRuntimeState')
            .and.resolveTo({ state: 'inactive' } satisfies PowerProfilesRuntimeState);

        const configFake = {
            getSettings,
            getAllProfiles,
            saveSettings,
            observeSettings: settingsSubject.asObservable(),
        } as unknown as ConfigService;
        const dbusFake = {
            defaultProfiles,
            customProfiles,
            refreshSettings,
        } as unknown as TccDBusClientService;
        window.dbusAPI = {
            getPowerProfilesRuntimeState: runtimeState,
        } as unknown as typeof window.dbusAPI;

        await TestBed.configureTestingModule({
            declarations: [PowerProfilesSettingsComponent],
            imports: [
                CommonModule,
                MatButtonModule,
                MatCheckboxModule,
                MatFormFieldModule,
                MatProgressSpinnerModule,
                MatSelectModule,
                NoopAnimationsModule,
            ],
            providers: [
                { provide: ConfigService, useValue: configFake },
                { provide: TccDBusClientService, useValue: dbusFake },
                { provide: UtilsService, useValue: utils },
            ],
        }).compileComponents();
    });

    afterEach((): void => {
        fixture?.destroy();
        window.dbusAPI = originalDbusApi;
    });

    it('starts disabled without saved ppd settings and resolves automatic defaults through the shared resolver', async (): Promise<void> => {
        authoritativeSettings = makeSettings();
        delete authoritativeSettings.ppd;
        authoritativeSettings.stateMap.power_ac = DefaultProfileIDs.MaxEnergySave;
        authoritativeSettings.stateMap.power_bat = DefaultProfileIDs.Office;
        await createFixture();

        expect(await (await checkbox()).isChecked()).toBeFalse();
        expect(await (await selectHarness('Power saver')).getValueText()).toBe('Automatic (default)');
        expect(await (await selectHarness('Balanced')).getValueText()).toBe('Automatic (default)');
        expect(await (await selectHarness('Performance')).getValueText()).toBe('Automatic (default)');

        await (await checkbox()).check();
        fixture.detectChanges();
        expect(component.resolvedMappings).toEqual(PowerProfilesConfig.resolveMappings(undefined, catalog));
        expect(component.invalidAssignments.power_ac).toBeFalse();
        await choose('Power saver', 'Mapped saver [mapped-saver]');
        expect(component.draftPpd.profiles?.['power-saver']).toBe('mapped-saver');
        await choose('Power saver', 'Automatic (default)');
        expect(component.draftPpd.profiles?.['power-saver']).toBeUndefined();
        expect(component.resolvedMappings['power-saver']).toBe(DefaultProfileIDs.MaxEnergySave);
        expect(component.invalidAssignments.power_bat).toBeFalse();

        const saverOptions = await optionsFor('Power saver');
        expect(saverOptions.texts).not.toContain('None');
        const performanceOptions = await optionsFor('Performance');
        expect(performanceOptions.texts).toContain('None');
    });

    it('submits exact IDs for duplicate names and keeps the real none ID distinct from the performance None choice', async (): Promise<void> => {
        const customBefore: ITccProfile[] = customProfiles.value.map((profile: ITccProfile): ITccProfile =>
            structuredClone(profile),
        );
        await createFixture();
        const disabledAssignments = await optionsFor('AC profile assignment');
        expect(disabledAssignments.texts).toContain('Custom profile [custom-id]');
        const selectedAssignment: number = disabledAssignments.texts.findIndex(
            (text: string): boolean => text === `Automatic saver [${DefaultProfileIDs.MaxEnergySave}]`,
        );
        expect(selectedAssignment).toBeGreaterThanOrEqual(0);
        await disabledAssignments.options[selectedAssignment].click();
        fixture.detectChanges();

        await (await checkbox()).check();
        await choose('Power saver', 'Shared name [default]');
        await choose('Balanced', 'Shared name [none]');
        await choose('Performance', 'None');
        await choose('AC profile assignment', 'Shared name [default]');
        await choose('Battery profile assignment', 'Shared name [none]');

        utils.pageDisabled = true;
        await clickApply();
        expect(runtimeState).toHaveBeenCalledTimes(2);

        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(submittedCandidates).toHaveSize(1);
        const candidate: ITccSettings = submittedCandidates[0];
        expect(candidate.ppd).toEqual({
            enabled: true,
            profiles: {
                'power-saver': 'default',
                balanced: 'none',
                performance: null,
            },
        });
        expect(candidate.stateMap).toEqual({
            power_ac: 'default',
            power_bat: 'none',
        });
        expect(candidate.fahrenheit).toBeTrue();
        expect(candidate.shutdownTime).toBe('22:15');
        expect(candidate.chargingProfile).toBe('stationary');
        expect(candidate.ycbcr420Workaround).toEqual([{ connector: 'HDMI-1', enabled: true }]);
        expect(customProfiles.value).toEqual(customBefore);
        expect(utils.pageDisabled).toBeTrue();
        expect(textContent()).toContain('Power Profiles settings were saved and adopted.');
    });

    it('blocks required defaults and duplicate mapping targets without calling the writer', async (): Promise<void> => {
        setCatalog([makeProfile('profile-one', 'Profile one'), makeProfile('profile-two', 'Profile two')]);
        authoritativeSettings = makeSettings();
        await createFixture();

        await (await checkbox()).check();
        expect(textContent()).toContain("Required TCC profile for 'power-saver' is unavailable");
        await clickApply();
        expect(saveSettings).not.toHaveBeenCalled();

        await choose('Power saver', 'Profile one [profile-one]');
        await choose('Balanced', 'Profile one [profile-one]');
        await choose('Performance', 'None');
        expect(textContent()).toContain('Power profile mappings must target distinct TCC profile IDs');
        await clickApply();
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('does not remap assignments when a mapping changes and keeps an unmapped assignment visible until repaired', async (): Promise<void> => {
        authoritativeSettings = makeSettings({
            enabled: true,
            profiles: {
                'power-saver': 'mapped-saver',
                balanced: 'mapped-balanced',
                performance: null,
            },
        });
        authoritativeSettings.stateMap.power_ac = 'mapped-saver';
        authoritativeSettings.stateMap.power_bat = 'mapped-balanced';
        await createFixture();

        await choose('Power saver', 'Alternate saver [alternate-saver]');
        expect(component.draftAssignments.power_ac).toBe('mapped-saver');
        expect(component.invalidAssignments.power_ac).toBeTrue();
        expect(textContent()).toContain('(not mapped)');
        expect(textContent()).toContain('Saved power_ac assignment is not mapped by power-profiles-daemon');

        await choose('AC profile assignment', 'Alternate saver [alternate-saver]');
        expect(component.invalidAssignments.power_ac).toBeFalse();
        expect(component.validationError).toBeNull();
    });

    it('allows disabling an invalid stored configuration and retains its mappings and assignments', async (): Promise<void> => {
        const invalidPpd = {
            enabled: true,
            profiles: {
                'power-saver': 'gone-saver',
                balanced: 'gone-balanced',
                performance: 'gone-performance',
            },
        };
        authoritativeSettings = makeSettings(invalidPpd);
        authoritativeSettings.stateMap.power_ac = 'old-ac';
        authoritativeSettings.stateMap.power_bat = 'old-battery';
        await createFixture();

        expect(component.validationError).toContain('Unknown TCC profile ID');
        await (await checkbox()).uncheck();
        expect(component.validationError).toBeNull();
        expect(textContent()).toContain('Unavailable saved assignment [old-ac]');
        await clickApply();

        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(submittedCandidates[0].ppd).toEqual({
            enabled: false,
            profiles: invalidPpd.profiles,
        });
        expect(submittedCandidates[0].stateMap).toEqual({
            power_ac: 'old-ac',
            power_bat: 'old-battery',
        });
    });

    it('keeps a draft after a false privileged write and shows the save error without changing saved status', async (): Promise<void> => {
        writerResult = false;
        await createFixture();
        await (await checkbox()).check();
        await clickApply();

        expect(component.draftPpd.enabled).toBeTrue();
        expect(component.savedEnabled).toBeFalse();
        expect(authoritativeSettings.ppd).toBeUndefined();
        expect(authoritativeSettings.stateMap.power_ac).toBe(DefaultProfileIDs.MaxEnergySave);
        expect(textContent()).toContain(
            'Power Profiles settings could not be saved. Authentication may have been cancelled or the daemon rejected the configuration.',
        );
        expect(refreshSettings).not.toHaveBeenCalled();
        expect(utils.pageDisabled).toBeFalse();
    });

    it('restores pageDisabled and preserves the draft after a rejected write', async (): Promise<void> => {
        saveSettings.and.callFake(async (): Promise<boolean> => {
            expect(utils.pageDisabled).toBeTrue();
            throw new Error('writer rejected');
        });
        utils.pageDisabled = true;
        await createFixture();
        await (await checkbox()).check();
        await clickApply();

        expect(component.draftPpd.enabled).toBeTrue();
        expect(component.savedEnabled).toBeFalse();
        expect(utils.pageDisabled).toBeTrue();
        expect(textContent()).toContain('Power Profiles settings could not be saved.');
    });
    it('keeps other settings disabled until authoritative refresh completes', async (): Promise<void> => {
        const refreshReply = Promise.withResolvers<ITccSettings>();
        const refreshStarted = Promise.withResolvers<void>();
        refreshSettings.and.callFake((): Promise<ITccSettings> => {
            refreshStarted.resolve();
            return refreshReply.promise;
        });
        await createFixture();
        await (await checkbox()).check();

        const applying = component.apply();
        await refreshStarted.promise;
        expect(utils.pageDisabled).toBeTrue();
        await component.apply();
        expect(saveSettings).toHaveBeenCalledTimes(1);

        refreshReply.resolve(submittedCandidates[0]);
        await applying;
        expect(utils.pageDisabled).toBeFalse();
    });

    it('blocks a second Apply while the privileged write is pending', async (): Promise<void> => {
        const writerReply = Promise.withResolvers<boolean>();
        saveSettings.and.returnValue(writerReply.promise);
        await createFixture();
        await (await checkbox()).check();

        const applying = component.apply();
        await Promise.resolve();
        fixture.detectChanges();
        expect(component.isSaving).toBeTrue();
        expect(await (await loader.getHarness(MatButtonHarness.with({ text: 'Saving…' }))).isDisabled()).toBeTrue();
        await component.apply();
        expect(saveSettings).toHaveBeenCalledTimes(1);

        writerReply.resolve(false);
        await applying;
        expect(component.isSaving).toBeFalse();
    });

    it('shows adopted foreign owner details, including an unavailable unit when absent', async (): Promise<void> => {
        runtimeState.and.resolveTo({
            state: 'other-provider',
            owner: ':1.42',
            pid: 912,
            unit: 'power-profiles-daemon.service',
        } satisfies PowerProfilesRuntimeState);
        await createFixture();
        await (await checkbox()).check();
        await clickApply();

        expect(component.savedEnabled).toBeTrue();
        expect(textContent()).toContain('Settings remain saved, but the TCC Power Profiles provider is not active.');
        expect(textContent()).toContain(':1.42');
        expect(textContent()).toContain('912');
        expect(textContent()).toContain('power-profiles-daemon.service');

        runtimeState.and.resolveTo({
            state: 'other-provider',
            owner: ':1.77',
        } satisfies PowerProfilesRuntimeState);
        await (await loader.getHarness(MatButtonHarness.with({ text: 'Refresh' }))).click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(textContent()).toContain(':1.77');
        expect(textContent()).toContain('Unavailable');
    });

    it('shows a runtime-query rejection as unavailable rather than inactive', async (): Promise<void> => {
        runtimeState.and.callFake((): Promise<PowerProfilesRuntimeState> =>
            Promise.reject(new Error('runtime unavailable')),
        );
        await createFixture();

        expect(textContent()).toContain('Power Profiles runtime status is unavailable.');
        expect(textContent()).not.toContain('No power-profile provider is active.');
    });
    it('shows the active standard mode while TCC is disabled and Discard restores the saved draft', async (): Promise<void> => {
        runtimeState.and.resolveTo({
            state: 'active',
            activeProfile: 'performance',
        } satisfies PowerProfilesRuntimeState);
        await createFixture();
        expect(textContent()).toContain('Active standard mode:');
        expect(textContent()).toContain('Performance');
        expect(textContent()).toContain('A power-profile provider is active while the TCC provider is disabled.');

        await (await checkbox()).check();
        await (await loader.getHarness(MatButtonHarness.with({ text: 'Discard' }))).click();
        fixture.detectChanges();
        expect(await (await checkbox()).isChecked()).toBeFalse();
        expect(component.isDirty).toBeFalse();
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('distinguishes adoption mismatch from an unverifiable read and from writer failure', async (): Promise<void> => {
        await createFixture();
        await (await checkbox()).check();
        const mismatched = makeSettings({ enabled: false });
        refreshSettingsOverride = mismatched;
        await clickApply();
        expect(textContent()).toContain(
            'Settings were written, but the daemon did not adopt the requested Power Profiles configuration.',
        );
        expect(textContent()).not.toContain('Power Profiles settings could not be saved.');

        refreshSettingsOverride = undefined;
        refreshSettingsFailure = true;
        await (await checkbox()).check();
        await clickApply();
        expect(textContent()).toContain('Settings were written, but adoption could not be verified.');
        expect(textContent()).not.toContain('Power Profiles settings could not be saved.');
    });

    it('refreshes pristine drafts, preserves dirty choices, and applies against the latest unrelated settings', async (): Promise<void> => {
        authoritativeSettings = makeSettings({
            enabled: true,
            profiles: {
                'power-saver': 'mapped-saver',
                balanced: 'mapped-balanced',
                performance: null,
            },
        });
        authoritativeSettings.stateMap = {
            power_ac: 'mapped-balanced',
            power_bat: 'mapped-saver',
        };
        await createFixture();

        const pristineUpdate = makeSettings({
            enabled: true,
            profiles: {
                'power-saver': 'mapped-saver',
                balanced: 'mapped-balanced',
                performance: null,
            },
        });
        pristineUpdate.stateMap = {
            power_ac: 'mapped-saver',
            power_bat: 'mapped-balanced',
        };
        authoritativeSettings = cloneSettings(pristineUpdate);
        settingsSubject.next(authoritativeSettings);
        fixture.detectChanges();
        expect(component.draftAssignments.power_ac).toBe('mapped-saver');

        await choose('AC profile assignment', 'Mapped balanced [mapped-balanced]');
        const newerSettings = cloneSettings(pristineUpdate);
        newerSettings.fahrenheit = false;
        newerSettings.shutdownTime = '06:30';
        newerSettings.chargingPriority = 'performance';
        newerSettings.stateMap.power_ac = 'mapped-saver';
        authoritativeSettings = newerSettings;
        settingsSubject.next(authoritativeSettings);
        fixture.detectChanges();
        expect(component.draftAssignments.power_ac).toBe('mapped-balanced');

        await clickApply();
        expect(submittedCandidates).toHaveSize(1);
        expect(submittedCandidates[0].stateMap.power_ac).toBe('mapped-balanced');
        expect(submittedCandidates[0].stateMap.power_bat).toBe('mapped-balanced');
        expect(submittedCandidates[0].fahrenheit).toBeFalse();
        expect(submittedCandidates[0].shutdownTime).toBe('06:30');
        expect(submittedCandidates[0].chargingPriority).toBe('performance');
    });

    it('serializes runtime refreshes and uses the newest result', async (): Promise<void> => {
        const firstReply = Promise.withResolvers<PowerProfilesRuntimeState>();
        const secondReply = Promise.withResolvers<PowerProfilesRuntimeState>();
        const secondCall = Promise.withResolvers<void>();
        runtimeState.and.callFake((): Promise<PowerProfilesRuntimeState> => {
            if (runtimeState.calls.count() === 1) {
                return firstReply.promise;
            }
            secondCall.resolve();
            return secondReply.promise;
        });
        await createFixture(false);
        await Promise.resolve();
        expect(runtimeState).toHaveBeenCalledTimes(1);

        const secondRefresh = component.refreshRuntimeState();
        expect(runtimeState).toHaveBeenCalledTimes(1);
        firstReply.resolve({ state: 'inactive' });
        await secondCall.promise;
        expect(runtimeState).toHaveBeenCalledTimes(2);
        secondReply.resolve({ state: 'active', activeProfile: 'balanced' });
        await secondRefresh;

        expect(component.runtimeState).toEqual({
            state: 'active',
            activeProfile: 'balanced',
        });
        fixture.detectChanges();
        expect(textContent()).toContain('Balanced');
    });

    it('ignores a checked settings reply after the panel is destroyed', async (): Promise<void> => {
        const refreshReply = Promise.withResolvers<ITccSettings>();
        refreshSettings.and.returnValue(refreshReply.promise);
        await createFixture();
        await (await checkbox()).check();

        const applying = component.apply();
        await Promise.resolve();
        await Promise.resolve();
        expect(refreshSettings).toHaveBeenCalledTimes(1);
        fixture.destroy();
        const previousSavedEnabled: boolean = component.savedEnabled;
        refreshReply.resolve(makeSettings({ enabled: true }));
        await applying;
        expect(component.savedEnabled).toBe(previousSavedEnabled);
    });
});
