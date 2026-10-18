/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 */

export type StandardProfile = 'power-saver' | 'balanced' | 'performance';
export type PowerProfilesRuntimeState =
    | { state: 'active'; activeProfile: StandardProfile }
    | { state: 'inactive' }
    | { state: 'other-provider'; owner: string; pid?: number; unit?: string };

export interface IPowerProfilesConfig {
    enabled: boolean;
    profiles?: {
        'power-saver'?: string;
        balanced?: string;
        performance?: string | null;
    };
}

export type ResolvedPowerProfiles = Partial<Record<StandardProfile, string>>;
