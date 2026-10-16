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

import * as dbus from 'dbus-next';
import { TuxedoIOAPI } from '../../native-lib/TuxedoIOAPI';
import { DaemonWorker } from './DaemonWorker';
import { type TccDBusData, TccDBusInterface, TccDBusOptions } from './TccDBusInterface';
import { DBusAuthorization } from './DBusAuthorization';
import { type PowerProfilesBus, PowerProfilesService } from './PowerProfilesService';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class TccDBusService extends DaemonWorker {
    private interface: TccDBusInterface;
    private readonly path: string = '/com/tuxedocomputers/tccd';

    private bus: dbus.MessageBus;

    private started: boolean = false;
    private powerProfilesService?: PowerProfilesService;

    constructor(
        tccd: TuxedoControlCenterDaemon,
        private dbusData: TccDBusData,
    ) {
        super(1500, 'TccDbusServiceWorker', tccd);
        this.dbusData.dbusAvailable = true;

        const options: TccDBusOptions = new TccDBusOptions();
        options.chargingWorker = this.tccd.getChargingWorker();

        try {
            this.bus = dbus.systemBus();
            this.interface = new TccDBusInterface(dbusData, options);
        } catch (err: unknown) {
            console.error(`TccDBusService: Error initializing DBus service => ${err}`);
        }
    }

    public async onStart(): Promise<void> {
        if (this.started) {
            return;
        }
        try {
            const result = await this.bus.requestName('com.tuxedocomputers.tccd', dbus.NameFlag.DO_NOT_QUEUE);
            if (result !== dbus.RequestNameReply.PRIMARY_OWNER && result !== dbus.RequestNameReply.ALREADY_OWNER) {
                throw new Error(`TCC D-Bus name is already owned (result ${result})`);
            }
            this.bus.export(this.path, this.interface);
            this.started = true;
            this.powerProfilesService = new PowerProfilesService({
                bus: this.bus as PowerProfilesBus,
                selector: this.tccd.getProfileSelection(),
                authorization: new DBusAuthorization(this.bus),
                backend: {
                    selectTccProfileByName: async (name: string, _persistence: 'temporary'): Promise<void> => {
                        await this.tccd.selectTccProfileByName(name);
                    },
                    replaceProfileConfiguration: async (settingsJSON: string, profilesJSON: string): Promise<boolean> =>
                        await this.tccd.replaceProfileConfiguration(settingsJSON, profilesJSON),
                },
                packageVersion: this.dbusData.tccdVersion,
                log: (message) => console.error(`PowerProfilesService: ${message}`),
            });
            try {
                await this.powerProfilesService.start();
            } catch (err: unknown) {
                console.error(`PowerProfilesService: Failed to start => ${err}`);
            }
        } catch (err: unknown) {
            console.error(`TccDBusService: Failed to own or export service => ${err}`);
        }
    }

    public async onWork(): Promise<void> {
        // Make sure wmiAvailability info is updated. Is done here until it gets its own worker.
        this.dbusData.tuxedoWmiAvailable = TuxedoIOAPI.wmiAvailable();

        if (this.dbusData.modeReapplyPending) {
            this.interface.ModeReapplyPendingChanged();
        }
    }

    public async refreshPowerProfilesProvider(): Promise<void> {
        await this.powerProfilesService?.refreshProvider();
    }
    public notifyPowerProfilesPropertiesChanged(): void {
        this.powerProfilesService?.notifyPropertiesChanged();
    }

    public emitProfileReleased(owner: string, cookie: number): void {
        this.powerProfilesService?.emitProfileReleased(owner, cookie);
    }

    public async onExit(): Promise<void> {
        await this.powerProfilesService?.stop();
        this.dbusData.dbusAvailable = false;
        try {
            if (this.started) {
                this.bus.unexport(this.path, this.interface);
            }
            await this.bus.releaseName('com.tuxedocomputers.tccd');
        } catch (err: unknown) {
            console.error(`TccDBusService: onExit failed => ${err}`);
        }
        this.bus.disconnect();
        this.started = false;
    }
}
