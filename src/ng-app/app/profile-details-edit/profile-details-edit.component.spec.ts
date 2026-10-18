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

import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { defaultCustomProfile } from '../../../common/models/DefaultProfiles';
import type { IDisplayFreqRes } from '../../../common/models/DisplayFreqRes';
import type { IGeneralCPUInfo } from '../../../common/models/ICpuInfos';
import type { ITccProfile } from '../../../common/models/TccProfile';
import { defaultSettings, ProfileStates, type ITccSettings } from '../../../common/models/TccSettings';
import type { TDPInfo } from '../../../native-lib/TuxedoIOAPI';
import { AppModule } from '../app.module';
import { CompatibilityService } from '../compatibility.service';
import { ConfigService } from '../config.service';
import { type IStateInfo, StateService } from '../state.service';
import { SysFsService } from '../sys-fs.service';
import { TccDBusClientService } from '../tcc-dbus-client.service';
import { UtilsService } from '../utils.service';
import { ProfileDetailsEditComponent } from './profile-details-edit.component';

describe('ProfileDetailsEditComponent Power Profiles assignments', (): void => {
    let component: ProfileDetailsEditComponent;
    let fixture: ComponentFixture<ProfileDetailsEditComponent>;
    let config: jasmine.SpyObj<ConfigService>;
    let state: jasmine.SpyObj<StateService>;
    let writer: jasmine.Spy<(currentProfileId: string, profile: ITccProfile, states?: string[]) => Promise<boolean>>;
    let settings: ITccSettings;

    const editedProfile = (id: string): ITccProfile => ({
        ...structuredClone(defaultCustomProfile),
        id,
        name: 'Editable profile',
    });

    const makeSettings = (ac: string, battery: string): ITccSettings => ({
        ...defaultSettings,
        stateMap: { power_ac: ac, power_bat: battery },
        ppd: {
            enabled: true,
            profiles: { 'power-saver': 'mapped-saver', balanced: 'mapped-balanced', performance: null },
        },
    });

    beforeEach(async (): Promise<void> => {
        writer = jasmine
            .createSpy<(currentProfileId: string, profile: ITccProfile, states?: string[]) => Promise<boolean>>(
                'writeProfile',
            )
            .and.callFake(async (profileId: string, _profile: ITccProfile, states: string[] = []): Promise<boolean> => {
                for (const assignedState of states) {
                    if (assignedState === ProfileStates.AC) {
                        settings.stateMap.power_ac = profileId;
                    } else if (assignedState === ProfileStates.BAT) {
                        settings.stateMap.power_bat = profileId;
                    }
                }
                return true;
            });
        config = jasmine.createSpyObj<ConfigService>('ConfigService', [
            'getFanProfiles',
            'getCustomProfileById',
            'getSettings',
            'getAllProfiles',
            'writeProfile',
        ]);
        config.getFanProfiles.and.returnValue([]);
        config.getCustomProfileById.and.callFake((id: string) => editedProfile(id));
        config.getSettings.and.callFake(() => settings);
        config.getAllProfiles.and.callFake(() => [editedProfile('mapped-saver'), editedProfile('mapped-balanced')]);
        config.writeProfile.and.callFake(writer);

        state = jasmine.createSpyObj<StateService>('StateService', [
            'getProfileStates',
            'getStateInputs',
            'initializeProfileNames',
        ]);
        state.getProfileStates.and.returnValue([]);
        state.getStateInputs.and.returnValue([
            { value: ProfileStates.AC, label: 'AC', tooltip: '', icon: '' },
            { value: ProfileStates.BAT, label: 'Battery', tooltip: '', icon: '' },
        ] satisfies IStateInfo[]);

        const tccDBus: Partial<TccDBusClientService> = {
            odmProfilesAvailable: new BehaviorSubject<string[]>([]),
            fansMinSpeed: new BehaviorSubject<number>(undefined),
            fansOffAvailable: new BehaviorSubject<boolean>(undefined),
            odmPowerLimits: new BehaviorSubject<TDPInfo[]>([]),
            displayModes: new BehaviorSubject<IDisplayFreqRes>({
                displayName: 'Test display',
                activeMode: { refreshRates: [60], xResolution: 1920, yResolution: 1080 },
                displayModes: [],
            }),
            isX11: new BehaviorSubject<number>(-1),
            nvidiaPowerCTRLDefaultPowerLimit: new BehaviorSubject<number>(undefined),
            nvidiaPowerCTRLMaxPowerLimit: new BehaviorSubject<number>(undefined),
            nvidiaPowerCTRLAvailable: new BehaviorSubject<boolean>(false),
            isUnsupportedConfigurableTGPDevice: new BehaviorSubject<boolean>(true),
            displayBrightnessNotSupportedGnome: () => true,
        };
        const utils: Partial<UtilsService> = {
            pageDisabled: false,
            formatCpuFrequency: (frequency: number): string => String(frequency),
            setODMProfileNames: jasmine.createSpy('setODMProfileNames'),
            getODMProfileName: (name: string) => name,
        };
        const compatibility: Partial<CompatibilityService> = {
            uwLEDOnlyMode: false,
            getHasSystemProfileInfo: () => false,
            getSystemProfileInfo: () => undefined,
        };
        const sysfs: Partial<SysFsService> = { generalCpuInfo: new BehaviorSubject<IGeneralCPUInfo>(undefined) };

        await TestBed.configureTestingModule({ imports: [AppModule] })
            .overrideComponent(ProfileDetailsEditComponent, {
                set: {
                    template:
                        '<form (ngSubmit)="submitFormInput()"><label>State assignment<select aria-label="State assignment" [formControl]="selectStateControl" multiple><option value="power_ac">AC</option><option value="power_bat">Battery</option></select></label><button type="submit">Save</button><p role="alert" *ngIf="powerProfilesAssignmentError">{{ powerProfilesAssignmentError }}</p></form>',
                },
            })
            .overrideProvider(ConfigService, { useValue: config })
            .overrideProvider(StateService, { useValue: state })
            .overrideProvider(TccDBusClientService, { useValue: tccDBus })
            .overrideProvider(UtilsService, { useValue: utils })
            .overrideProvider(CompatibilityService, { useValue: compatibility })
            .overrideProvider(SysFsService, { useValue: sysfs })
            .compileComponents();
    });

    afterEach((): void => fixture?.destroy());

    const createEditor = (profileId: string, selectedStates: string[]): void => {
        fixture = TestBed.createComponent(ProfileDetailsEditComponent);
        component = fixture.componentInstance;
        component.profile = editedProfile(profileId);
        component.selectStateControl.setValue(selectedStates);
        component.selectStateControl.markAsDirty();
        fixture.detectChanges();
    };

    it('blocks an enabled provider assignment outside its mapped profile IDs and explains where to fix it', async (): Promise<void> => {
        settings = makeSettings('mapped-saver', 'mapped-balanced');
        createEditor('unmapped-profile', [ProfileStates.AC]);

        component.submitFormInput();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(writer).not.toHaveBeenCalled();
        expect(component.profileDirty).toBeTrue();
        expect(fixture.nativeElement.textContent).toMatch(/Global settings.*Power Profiles/s);
    });

    it('writes a mapped assignment while the provider is enabled and marks the editor pristine on success', async (): Promise<void> => {
        settings = makeSettings('mapped-saver', 'mapped-balanced');
        createEditor('mapped-saver', [ProfileStates.AC]);

        component.submitFormInput();
        await fixture.whenStable();

        expect(component.powerProfilesAssignmentError).toBeNull();
        expect(writer).toHaveBeenCalledOnceWith('mapped-saver', jasmine.any(Object), [ProfileStates.AC]);
        expect(settings.stateMap.power_ac).toBe('mapped-saver');
        expect(component.profileDirty).toBeFalse();
    });

    it('leaves ordinary profile assignment writes unchanged while the provider is disabled', async (): Promise<void> => {
        settings = { ...makeSettings('mapped-saver', 'mapped-balanced'), ppd: { enabled: false } };
        createEditor('unmapped-profile', [ProfileStates.AC]);

        component.submitFormInput();
        await fixture.whenStable();

        expect(writer).toHaveBeenCalledOnceWith('unmapped-profile', jasmine.any(Object), [ProfileStates.AC]);
        expect(settings.stateMap.power_ac).toBe('unmapped-profile');
    });
});
