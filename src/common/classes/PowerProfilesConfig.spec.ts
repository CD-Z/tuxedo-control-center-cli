import 'jasmine';
import { ConfigHandler } from './ConfigHandler';
import { PowerProfilesConfig } from './PowerProfilesConfig';
import { DefaultProfileIDs, LegacyDefaultProfileIDs, TUXEDODevice } from '../models/DefaultProfiles';
import { defaultProfiles } from '../models/profiles/LegacyProfiles';
import type { ITccProfile } from '../models/TccProfile';
import { defaultSettings, type ITccSettings } from '../models/TccSettings';

describe('PowerProfilesConfig', (): void => {
    const config = new ConfigHandler('/tmp/settings', '/tmp/profiles', '/tmp/webcam', '/tmp/v4l2', '/tmp/fans');
    const settings = (): ITccSettings => ({
        ...JSON.parse(JSON.stringify(defaultSettings)),
        stateMap: {
            power_ac: DefaultProfileIDs.Office,
            power_bat: DefaultProfileIDs.MaxEnergySave,
        },
        ppd: { enabled: true },
    });

    it('resolves stable modern profile IDs and omits unavailable performance', (): void => {
        const resolved = PowerProfilesConfig.resolve(settings(), [], TUXEDODevice.POLARIS1XI02, config);
        expect(resolved).toEqual({
            'power-saver': DefaultProfileIDs.MaxEnergySave,
            balanced: DefaultProfileIDs.Office,
            performance: DefaultProfileIDs.HighPerformance,
        });
        const noPerformance = config.getDefaultProfiles(TUXEDODevice.IBPG8);
        expect(PowerProfilesConfig.resolve(settings(), [], TUXEDODevice.IBPG8, config).performance).toBeUndefined();
        expect(noPerformance.length).toBeGreaterThan(0);
    });

    it('uses legacy defaults when no modern device catalog exists', (): void => {
        const legacySettings = settings();
        legacySettings.stateMap = {
            power_ac: LegacyDefaultProfileIDs.Default,
            power_bat: LegacyDefaultProfileIDs.PowersaveExtreme,
        };
        expect(PowerProfilesConfig.resolve(legacySettings, [], TUXEDODevice.UNKNOWN, config)).toEqual({
            'power-saver': LegacyDefaultProfileIDs.PowersaveExtreme,
            balanced: LegacyDefaultProfileIDs.Default,
        });
    });

    it('accepts custom stable IDs and rejects ambiguous or invalid mappings', (): void => {
        const custom = JSON.parse(JSON.stringify(defaultProfiles[0])) as ITccProfile;
        custom.id = 'stable-custom-id';
        custom.name = 'Renamed profile';
        const modernCandidate = settings();
        modernCandidate.ppd.profiles = { 'power-saver': 'stable-custom-id' };
        modernCandidate.stateMap.power_bat = 'stable-custom-id';
        expect(
            PowerProfilesConfig.resolve(modernCandidate, [custom], TUXEDODevice.POLARIS1XI02, config)['power-saver'],
        ).toBe('stable-custom-id');
        modernCandidate.ppd.profiles = { balanced: 'missing-id' };
        expect(() =>
            PowerProfilesConfig.resolve(modernCandidate, [custom], TUXEDODevice.POLARIS1XI02, config),
        ).toThrow();
        modernCandidate.ppd.profiles = {
            balanced: DefaultProfileIDs.MaxEnergySave,
        };
        modernCandidate.stateMap.power_ac = DefaultProfileIDs.MaxEnergySave;
        expect(() =>
            PowerProfilesConfig.resolve(modernCandidate, [custom], TUXEDODevice.POLARIS1XI02, config),
        ).toThrow();
        modernCandidate.ppd.profiles = { balanced: 7 as unknown as string };
        expect(() =>
            PowerProfilesConfig.resolve(modernCandidate, [custom], TUXEDODevice.POLARIS1XI02, config),
        ).toThrowError(/Invalid override/);
    });

    it('resolves mappings independently of saved assignments', (): void => {
        const candidate = settings();
        const catalog = config.getDefaultProfiles(TUXEDODevice.POLARIS1XI02);
        candidate.stateMap.power_ac = 'unmapped-id';

        expect(PowerProfilesConfig.resolveMappings(candidate.ppd.profiles, catalog)).toEqual({
            'power-saver': DefaultProfileIDs.MaxEnergySave,
            balanced: DefaultProfileIDs.Office,
            performance: DefaultProfileIDs.HighPerformance,
        });
        expect(() => PowerProfilesConfig.resolveCatalog(candidate, catalog)).toThrowError(
            'Saved power_ac assignment is not mapped by power-profiles-daemon',
        );
    });
});
