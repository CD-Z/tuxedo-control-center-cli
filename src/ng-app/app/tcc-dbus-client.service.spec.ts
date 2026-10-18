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

import { defaultSettings } from '../../common/models/TccSettings';
import type { ITccSettings } from '../../common/models/TccSettings';
import type { IDbusClientAPI } from '../../e-app/preloadAPIs/DbusClientAPI';
import { TccDBusClientService } from './tcc-dbus-client.service';
import type { UtilsService } from './utils.service';

describe('TccDBusClientService.refreshSettings', (): void => {
    let service: TccDBusClientService;
    let dbusAvailable: jasmine.Spy;
    let getSettingsJSON: jasmine.Spy;

    const makeSettings = (powerAc: string): ITccSettings => ({
        ...defaultSettings,
        stateMap: { power_ac: powerAc, power_bat: 'battery-profile' },
    });

    beforeEach((): void => {
        dbusAvailable = jasmine.createSpy('dbusAvailable').and.resolveTo(false);
        getSettingsJSON = jasmine.createSpy('getSettingsJSON').and.resolveTo(undefined);
        window.dbusAPI = {
            dbusAvailable,
            getSettingsJSON,
            getDeviceJSON: jasmine.createSpy('getDeviceJSON').and.resolveTo('{}'),
        } as unknown as IDbusClientAPI;
        service = new TccDBusClientService({} as UtilsService);
    });

    afterEach((): void => {
        service.ngOnDestroy();
    });

    it('returns and publishes a fresh authoritative settings read', async (): Promise<void> => {
        const freshSettings: ITccSettings = makeSettings('fresh-ac-profile');
        dbusAvailable.and.resolveTo(true);
        getSettingsJSON.and.resolveTo(JSON.stringify(freshSettings));

        const result: ITccSettings = await service.refreshSettings();

        expect(result).toEqual(freshSettings);
        expect(service.settings.value).toEqual(freshSettings);
        expect(dbusAvailable).toHaveBeenCalled();
        expect(getSettingsJSON).toHaveBeenCalled();
    });

    it('rejects unavailable or malformed authoritative data instead of returning cached settings', async (): Promise<void> => {
        const previouslyCached: ITccSettings = makeSettings('cached-ac-profile');
        service.settings.next(previouslyCached);

        dbusAvailable.and.resolveTo(false);
        await expectAsync(service.refreshSettings()).toBeRejected();
        expect(service.settings.value).toEqual(previouslyCached);

        dbusAvailable.and.resolveTo(true);
        for (const invalidValue of [
            undefined,
            '',
            '{',
            'null',
            '[]',
            '{}',
            JSON.stringify({ ...makeSettings('bad'), stateMap: {} }),
        ]) {
            getSettingsJSON.and.resolveTo(invalidValue);
            await expectAsync(service.refreshSettings()).toBeRejected();
            expect(service.settings.value).toEqual(previouslyCached);
        }
    });

    it('rejects a present Power Profiles config without a boolean enabled field', async (): Promise<void> => {
        dbusAvailable.and.resolveTo(true);
        getSettingsJSON.and.resolveTo(
            JSON.stringify({
                ...makeSettings('ac'),
                ppd: { profiles: { balanced: 'profile-a' } },
            }),
        );

        await expectAsync(service.refreshSettings()).toBeRejected();
    });
});
