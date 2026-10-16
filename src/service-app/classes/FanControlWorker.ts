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

import type { TUXEDODevice } from '../../common/models/DefaultProfiles';
import { FanData } from '../../common/models/IFanData';
import type { ITccProfile } from '../../common/models/TccProfile';
import type { ITccFanProfile, ITccFanTableEntry } from '../../common/models/TccFanTable';
import { ModuleInfo, TuxedoIOAPI } from '../../native-lib/TuxedoIOAPI';
import { DaemonWorker } from './DaemonWorker';
import type { FanControlBaseClass } from './FanControlBaseClass';
import type { FanControlLogic } from './FanControlLogic';
import { FanControlPwm } from './FanControlPwm';
import { FanControlTuxedoIO } from './FanControlTuxedoIO';
import { FanControlTuxi } from './FanControlTuxi';
import { getCurrentCustomProfile } from './FanControlUtils';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class FanControlWorker extends DaemonWorker {
    private fanApi: FanControlBaseClass;
    private mapStatus: boolean = false;

    private fanReadAvailable: boolean;
    private fanWriteAvailable: boolean;

    public previousCustomCurve: {
        tableCPU: ITccFanTableEntry[];
        tableGPU: ITccFanTableEntry[];
    } = {
        tableCPU: [],
        tableGPU: [],
    };
    private previousTempValues: Map<number, number> = new Map();
    private retryFanInitCounter: number = 5;
    private dbusData: {
        fans: {
            temp: { timestamp: number; temp: number };
            speed: { timestamp: number; speed: number };
        }[];
    } = {
        fans: Array.from(
            { length: 3 },
            (): {
                temp: { timestamp: number; temp: number };
                speed: { timestamp: number; speed: number };
            } => ({
                temp: {
                    timestamp: -1,
                    temp: -1,
                },
                speed: {
                    timestamp: -1,
                    speed: -1,
                },
            }),
        ),
    };
    private tuxedoDevice: TUXEDODevice;
    private fanCheckCounter: number = 0;
    private isUniwill: boolean = false;

    private nrTempsAvailable: number;

    constructor(tccd: TuxedoControlCenterDaemon, tuxedoDevice: TUXEDODevice) {
        super(1000, 'FanControlWorker', tccd);
        this.tuxedoDevice = tuxedoDevice;
        this.updateDbusData();
    }

    public async onStart(retry?: boolean): Promise<void> {
        if (retry !== true) {
            this.retryFanInitCounter = 5;
        }
        const profile: ITccProfile = this.activeProfile;

        if (!this.fanApi) {
            const fanControlClasses: {
                class: FanControlTuxi | FanControlPwm | FanControlTuxedoIO;
                name: string;
            }[] = [
                { class: new FanControlTuxi(this.tccd, this.tuxedoDevice), name: 'tuxi' },
                { class: new FanControlPwm(this.tccd), name: 'pwm' },
                { class: new FanControlTuxedoIO(this.tccd), name: 'tuxedo-io' },
            ];

            for (const { class: fanClass, name } of fanControlClasses) {
                this.fanApi = fanClass;
                if (await this.initializeFanControl(this.fanApi, profile, name)) {
                    if (name === 'tuxedo-io') {
                        this.setActiveInterface();
                    }
                    await this.checkFanControlAvailable(this.tccd.settings.fanControlEnabled, profile);
                    return;
                }
            }

            this.fanApi = null;
            console.log('FanControlWorker: onStart: Fan API not available');
            return;
        }

        await this.initializeFanControl(this.fanApi, profile, undefined, true);
        await this.checkFanControlAvailable(this.tccd.settings.fanControlEnabled, profile);
    }

    private setActiveInterface() {
        // todo: tuxedo-drivers currently has 2 issues
        // - ec does set a different fan speed after one or more hours
        // - fan speed does change after writing a value
        // writing fan speed with tccd worker for all uniwill devices as a temporary solution, but
        // increasing the usage of tuxedo-drivers can increase cpu usage

        const modInfo = new ModuleInfo();

        if (TuxedoIOAPI.wmiAvailable()) {
            const status = TuxedoIOAPI.getModuleInfo(modInfo);

            if (!status) {
                console.error('FanControlWorker: setActiveInterface failed');
                return;
            }

            this.isUniwill = modInfo.activeInterface === 'uniwill';
        } else {
            console.error('FanControlWorker: setActiveInterface: wmi not available');
        }
    }

    public async onWork(): Promise<void> {
        try {
            await this.checkFanApiAvailable();
            if (!this.fanApi) {
                return;
            }

            const profile: ITccProfile = this.activeProfile;
            const fanControlEnabled: boolean = this.tccd.settings.fanControlEnabled;
            const sensorCollection: boolean = this.tccd.dbusData.sensorDataCollectionStatus;

            if (this.fanReadAvailable) {
                await this.checkFanControlAvailable(fanControlEnabled, profile);

                if (this.fanApi && this.mapStatus && (fanControlEnabled || sensorCollection)) {
                    await this.updateFanControlValues(fanControlEnabled, profile);
                }
            }

            // Re-check in case of late detected temperature sensors, mainly affects logic mapping CPU/GPU
            if (this.fanCheckCounter < 20) {
                this.nrTempsAvailable = await this.fanApi.getNumberTempsAvailable();
                if (this.nrTempsAvailable !== 0) {
                    const currentFanProfile: ITccFanProfile = await this.resolveFanProfile(profile);
                    await this.initializeFanControlApi(this.tccd.settings.fanControlEnabled, true, currentFanProfile);
                    await this.setFanProfile(profile, currentFanProfile);
                }
                this.fanCheckCounter += 1;
            }
        } catch (err: unknown) {
            console.log(`FanControlWorker: onWork failed => ${err}`);
        }
    }

    public async onExit(): Promise<void> {
        await this.fanApi.exit();
    }

    private async initializeFanControl(
        fanApiInstance: FanControlBaseClass,
        profile: ITccProfile,
        name?: string,
        resetFanMap: boolean = false,
    ): Promise<boolean> {
        [this.fanReadAvailable, this.fanWriteAvailable] = await fanApiInstance.checkAvailable();
        if (this.fanReadAvailable) {
            if (name) {
                console.log(`FanControlWorker: initializeFanControl: ${name} available`);
            }
            const currentFanProfile: ITccFanProfile = await this.resolveFanProfile(profile);
            await this.initializeFanControlApi(this.tccd.settings.fanControlEnabled, resetFanMap, currentFanProfile);
            await this.setFanProfile(profile, currentFanProfile);
            const numberFans: number = await fanApiInstance.getNumberFans();

            if (numberFans === 1) {
                console.log(`FanControlWorker: initializeFanControl: Detected ${numberFans} fan`);
            } else {
                console.log(`FanControlWorker: initializeFanControl: Detected ${numberFans} fans`);
            }
            return true;
        }
        return false;
    }

    private async setPreviousFans(): Promise<void> {
        const numberInterfaces: number = await this.fanApi.getNumberFanInterfaces();

        for (let i: number = 0; i <= numberInterfaces; i++) {
            this.previousTempValues.set(i, -1);
        }
    }

    private async checkFanApiAvailable(): Promise<void> {
        const fanApiUnavailable: boolean = this.fanApi === undefined || this.fanApi === null;
        if (fanApiUnavailable && this.retryFanInitCounter > 0) {
            console.log('FanControlWorker: checkFanApiAvailable: Fan API not defined, retrying initialization');
            this.retryFanInitCounter = this.retryFanInitCounter - 1;
            await this.onStart(true);
            return;
        }

        if (fanApiUnavailable && this.retryFanInitCounter === 0) {
            console.log('FanControlWorker: checkFanApiAvailable: Fan API initialization failed');
            this.retryFanInitCounter = this.retryFanInitCounter - 1;
        }
    }

    private async checkFanControlAvailable(fanControlEnabled: boolean, profile: ITccProfile): Promise<void> {
        if (this.fanApi && this.fanReadAvailable) {
            if (this.mapStatus === false) {
                console.log('FanControlWorker: checkFanControlAvailable: No fans found, retrying initialization');
                const currentFanProfile: ITccFanProfile = await this.resolveFanProfile(profile);
                await this.initializeFanControlApi(fanControlEnabled, true, currentFanProfile);
                await this.setFanProfile(profile, currentFanProfile);

                const numberFans: number = await this.fanApi.getNumberFans();
                if (numberFans === 1) {
                    console.log(`FanControlWorker: checkFanControlAvailable: Detected ${numberFans} fan`);
                } else {
                    console.log(`FanControlWorker: checkFanControlAvailable: Detected ${numberFans} fans`);
                }
            }
        }
    }

    private async initializeFanControlApi(
        fanControlEnabled: boolean,
        resetFanMap: boolean,
        currentFanProfile: ITccFanProfile,
    ): Promise<void> {
        await this.fanApi.initFanControl(this.fanWriteAvailable, fanControlEnabled);
        const numberInterfaces: number = await this.fanApi.getNumberFanInterfaces();

        this.nrTempsAvailable = await this.fanApi.getNumberTempsAvailable();
        // If temperature sensors are available before logic mapping skip any re-checks
        if (this.nrTempsAvailable !== 0) {
            this.fanCheckCounter = Number.MAX_VALUE;
        }

        if (numberInterfaces) {
            this.mapStatus = await this.fanApi.mapLogicToFans(numberInterfaces, resetFanMap, currentFanProfile);
            await this.setPreviousFans();
            return;
        }
        console.log('FanControlWorker: initializeFanControlApi: No fan interfaces found');
    }

    public async isEqual(first: ITccFanProfile, second: ITccFanProfile): Promise<boolean> {
        return JSON.stringify(first) === JSON.stringify(second);
    }

    private async resolveFanProfile(profile: ITccProfile): Promise<ITccFanProfile> {
        return profile.fan.fanProfile === 'Custom'
            ? await getCurrentCustomProfile(profile)
            : this.tccd.getCurrentFanProfile(profile);
    }

    private async setFanProfile(profile: ITccProfile, currentFanProfile: ITccFanProfile): Promise<void> {
        console.log('FanControlWorker: setFanProfile: Setting fan profile');
        await this.fanApi.setFanProfileValues(profile, currentFanProfile);
    }

    private async updateTempLogic(fans: Map<number, FanControlLogic>, fanNumber: number) {
        const fanIndex = fanNumber - 1;
        const fanLogic = fans.get(fanNumber);
        let temp;
        // Only get temp for fan when a corresponding sensor exists
        if (fanNumber <= this.nrTempsAvailable) {
            temp = await this.getTemperature(fanIndex);
        } else {
            temp = 0;
        }
        fanLogic.reportTemperature(temp);
        return { fanLogic, fanIndex, temp };
    }

    private async setFansWithMaxSpeed(fans: Map<number, FanControlLogic>) {
        const fanNumbers = Array.from(fans.keys());

        const fanInformationArray: {
            fanLogic: FanControlLogic;
            fanIndex: number;
            temp: number;
        }[] = await Promise.all(
            fanNumbers.map(async (fanNumber: number) => {
                return await this.updateTempLogic(fans, fanNumber);
            }),
        );

        const speedArray: number[] = fanInformationArray.map(({ fanLogic }) => fanLogic.getSpeedPercent());
        const maxSpeed = Math.max(...speedArray);

        await Promise.all(
            fanInformationArray.map(async ({ fanLogic, fanIndex, temp }) => {
                await this.updateFanDbusData(fanIndex, fanLogic, maxSpeed, temp);
            }),
        );
    }

    private async updateFanControlValues(fanControlEnabled: boolean, profile: ITccProfile): Promise<void> {
        const fans: Map<number, FanControlLogic> = await this.fanApi.getFans();

        if (fans.size === 0) {
            console.log('FanControlWorker: updateFanControlValues: No fans found, retrying initialization');
            const currentFanProfile: ITccFanProfile = await this.resolveFanProfile(profile);
            await this.initializeFanControlApi(fanControlEnabled, true, currentFanProfile);
            await this.setFanProfile(profile, currentFanProfile);
            return;
        }

        await this.fanApi.clearTempValues();
        await this.setFansWithMaxSpeed(fans);
    }

    private async writeFanSpeed(fanLogic: FanControlLogic, fanIndex: number, calculatedSpeed: number): Promise<void> {
        if (!fanLogic) return;

        if (this.tccd.settings.fanControlEnabled) {
            if (
                (this.isUniwill && calculatedSpeed > -1) ||
                (this.previousTempValues.get(fanIndex) !== calculatedSpeed && calculatedSpeed > -1)
            ) {
                await this.fanApi.writeFanSpeed(fanIndex, calculatedSpeed);
                this.previousTempValues.set(fanIndex, calculatedSpeed);
            }
        }
    }

    private async updateFanDbusData(
        fanIndex: number,
        fanLogic: FanControlLogic,
        calculatedSpeed: number,
        temperature: number,
    ): Promise<void> {
        if (temperature > -1) {
            if (this.fanWriteAvailable) {
                await this.writeFanSpeed(fanLogic, fanIndex, calculatedSpeed);
            }

            if (this.tccd.dbusData.sensorDataCollectionStatus) {
                const currentSpeedPercent: number = await this.fanApi.getFanSpeedPercent(fanIndex);

                await this.setFanDbusData(fanIndex, temperature, currentSpeedPercent);
            } else {
                await this.setFanDbusData(fanIndex, temperature, -1);
            }
        } else {
            console.log('FanControlWorker: updateFanDbusData: Invalid temperature');
        }
    }

    private async getTemperature(fanIndex: number): Promise<number> {
        return this.tccd.settings.fanControlEnabled || this.tccd.dbusData.sensorDataCollectionStatus
            ? await this.fanApi.getFanTemperature(fanIndex)
            : -1;
    }

    private async setFanDbusData(fanIndex: number, currentFanTemp: number, currentSpeedPercent: number): Promise<void> {
        this.dbusData.fans[fanIndex].temp = {
            timestamp: Date.now(),
            temp: currentFanTemp,
        };
        this.dbusData.fans[fanIndex].speed = {
            timestamp: Date.now(),
            speed: currentSpeedPercent,
        };
        this.updateDbusData();
    }

    private updateDbusData(): void {
        const cpu = new FanData(
            this.dbusData.fans[0].temp.timestamp,
            this.dbusData.fans[0].speed.speed,
            this.dbusData.fans[0].temp.temp,
        );
        const gpu1 = new FanData(
            this.dbusData.fans[1].temp.timestamp,
            this.dbusData.fans[1].speed.speed,
            this.dbusData.fans[1].temp.temp,
        );
        const gpu2 = new FanData(
            this.dbusData.fans[2].temp.timestamp,
            this.dbusData.fans[2].speed.speed,
            this.dbusData.fans[2].temp.temp,
        );
        const fanData: { cpu: FanData; gpu1: FanData; gpu2: FanData } = {
            cpu: cpu,
            gpu1: gpu1,
            gpu2: gpu2,
        };
        this.tccd.dbusData.fanData = JSON.stringify(fanData);
    }
}
