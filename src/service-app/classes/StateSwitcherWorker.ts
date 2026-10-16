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

import { determineState } from '../../common/classes/StateUtils';
import type { ProfileStates } from '../../common/models/TccSettings';
import { DaemonWorker } from './DaemonWorker';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class StateSwitcherWorker extends DaemonWorker {
    private currentState: ProfileStates;
    private currentStateProfileId: string;

    private refreshProfile: boolean = false;

    constructor(tccd: TuxedoControlCenterDaemon) {
        super(2000, 'StateSwitcherWorker', tccd);
    }

    /** Reset state */
    public reset(): void {
        this.currentState = undefined;
    }

    /** Refresh profile application */
    public reapplyProfile(): void {
        this.refreshProfile = true;
    }

    public async onStart(): Promise<void> {
        const state = determineState();
        if (this.currentState !== undefined && state !== this.currentState) {
            await this.tccd.powerStateChanged(state);
        }
        this.currentState = state;
        this.currentStateProfileId = this.tccd.settings.stateMap[state];
    }

    public async onWork(): Promise<void> {
        const state = determineState();
        const profileId = this.tccd.settings.stateMap[state];
        const stateChanged = state !== this.currentState;
        const assignmentChanged = profileId !== this.currentStateProfileId;

        if (stateChanged) {
            await this.tccd.powerStateChanged(state);
        }
        if (assignmentChanged) {
            await this.tccd.powerStateChanged(state, true);
        }
        this.currentState = state;
        this.currentStateProfileId = profileId;

        if (this.refreshProfile) {
            await this.tccd.reapplyProfile();
            this.refreshProfile = false;
        }
    }

    public async onExit(): Promise<void> {
        // Do nothing
    }
}
