import * as dbus from 'dbus-next';
import { defaultSettings, ProfileStates, type ITccSettings } from '../../common/models/TccSettings';
import type { ITccProfile } from '../../common/models/TccProfile';
import { PowerProfilesConfig } from '../../common/classes/PowerProfilesConfig';
import { DBusAuthorization } from '../classes/DBusAuthorization';
import { ProfileSelection } from '../classes/ProfileSelection';
import type { PowerProfilesBackend, PowerProfilesBus } from '../classes/PowerProfilesService';
import {
    POWER_PROFILES_INTERFACE,
    POWER_PROFILES_NAME,
    POWER_PROFILES_PATH,
    PowerProfilesService,
    TCC_INTERFACE,
    TCC_NAME,
    TCC_PATH,
} from '../classes/PowerProfilesService';

export const PROFILE_IDS = {
    'power-saver': 'test-power-saver',
    balanced: 'test-balanced',
    performance: 'test-performance',
    alternate: 'test-alternate',
} as const;

export interface TestProfile extends ITccProfile {
    id: string;
    name: string;
}

export interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

export function testProfiles(): TestProfile[] {
    return [
        { id: PROFILE_IDS['power-saver'], name: 'Quiet profile' },
        { id: PROFILE_IDS.balanced, name: 'Everyday profile' },
        { id: PROFILE_IDS.performance, name: 'Fast profile' },
        { id: PROFILE_IDS.alternate, name: 'Alternate profile' },
    ] as unknown as TestProfile[];
}

export function testSettings(): ITccSettings {
    return {
        ...structuredClone(defaultSettings),
        stateMap: {
            [ProfileStates.AC]: PROFILE_IDS.balanced,
            [ProfileStates.BAT]: PROFILE_IDS['power-saver'],
        },
        ppd: {
            enabled: true,
            profiles: {
                'power-saver': PROFILE_IDS['power-saver'],
                balanced: PROFILE_IDS.balanced,
                performance: PROFILE_IDS.performance,
            },
        },
    };
}

export interface AuthorizationCall {
    sender: string;
    action: string;
}

export interface ConfigurationReplacement {
    settingsJSON: string;
    profilesJSON: string;
}

export interface PolkitSubject {
    sender: string;
    subjectType: string;
    action: string;
    flags: number;
}

const POLKIT_NAME = 'org.freedesktop.PolicyKit1';
const POLKIT_PATH = '/org/freedesktop/PolicyKit1/Authority';
const POLKIT_INTERFACE = 'org.freedesktop.PolicyKit1.Authority';

class FakePolkitAuthority extends dbus.interface.Interface {
    public constructor(
        private readonly authorizationCalls: AuthorizationCall[],
        private readonly subjects: PolkitSubject[],
        private readonly deniedSenders: Set<string>,
    ) {
        super(POLKIT_INTERFACE);
    }

    public CheckAuthorization(
        subject: [string, Record<string, dbus.Variant>],
        action: string,
        _details: Record<string, string>,
        flags: number,
        _cancellationId: string,
    ): [boolean, boolean, Record<string, string>] {
        const sender = subject[1].name?.value as string;
        this.authorizationCalls.push({ sender, action });
        this.subjects.push({ sender, subjectType: subject[0], action, flags });
        return [!this.deniedSenders.has(sender), false, {}];
    }
}

FakePolkitAuthority.configureMembers({
    methods: {
        CheckAuthorization: {
            inSignature: '(sa{sv})sa{ss}us',
            outSignature: '(bba{ss})',
        },
    },
});

class FakeTccInterface extends dbus.interface.Interface {
    public constructor(private readonly selector: ProfileSelection) {
        super(TCC_INTERFACE);
    }

    public dbusAvailable(): boolean {
        return true;
    }

    public GetProfilesJSON(): string {
        return JSON.stringify(this.selector.profiles);
    }
    public GetSettingsJSON(): string {
        const settings = this.selector.settings;
        if (settings === undefined) {
            throw new Error('TCC settings are unavailable before selector initialization');
        }
        return JSON.stringify(settings);
    }

    public GetActiveProfileJSON(): string {
        return JSON.stringify(this.selector.activeProfile);
    }

    public SetTempProfileById(_id: string): boolean {
        throw new dbus.DBusError(
            'org.freedesktop.DBus.Error.AccessDenied',
            'Caller-aware selection must use the raw dispatcher',
        );
    }
}

FakeTccInterface.configureMembers({
    methods: {
        dbusAvailable: { outSignature: 'b' },
        GetProfilesJSON: { outSignature: 's' },
        GetSettingsJSON: { outSignature: 's' },
        GetActiveProfileJSON: { outSignature: 's' },
        SetTempProfileById: { inSignature: 's', outSignature: 'b' },
    },
});

export interface PowerProfilesIntegrationHarness {
    readonly bus: dbus.MessageBus;
    readonly selector: ProfileSelection;
    readonly service: PowerProfilesService;
    readonly authorizationCalls: AuthorizationCall[];
    readonly appliedProfiles: string[];
    readonly persistedSettings: ITccSettings[];
    readonly configurationReplacements: ConfigurationReplacement[];
    readonly logs: string[];
    readonly clients: Set<dbus.MessageBus>;
    openClient(): Promise<dbus.MessageBus>;
    deny(sender: string): void;
    failProfile(id: string | undefined): void;
    gateProfile(id: string | undefined, gate?: Promise<void>): void;
    close(): Promise<void>;
    readonly polkitSubjects: PolkitSubject[];
}

export interface IntegrationHarnessOptions {
    busAddress?: string;
    claimTccName?: boolean;
    initialSettings?: ITccSettings;
    persistConfiguration?: (settingsJSON: string, profilesJSON: string) => Promise<boolean>;
}

export async function openBus(busAddress?: string): Promise<dbus.MessageBus> {
    const bus = dbus.sessionBus(busAddress === undefined ? {} : { busAddress });
    await new Promise<void>((resolve, reject) => {
        bus.once('connect', resolve);
        bus.once('error', reject);
    });
    return bus;
}

export function uniqueName(bus: dbus.MessageBus): string {
    const name = (bus as dbus.MessageBus & { name?: string }).name;
    if (typeof name !== 'string' || !name.startsWith(':')) {
        throw new Error('D-Bus connection did not receive a unique name');
    }
    return name;
}

export async function createPowerProfilesHarness(
    options: IntegrationHarnessOptions = {},
): Promise<PowerProfilesIntegrationHarness> {
    const bus = await openBus(options.busAddress);
    if (options.claimTccName) {
        const result = await bus.requestName(TCC_NAME, 0);
        if (result !== dbus.RequestNameReply.PRIMARY_OWNER) {
            bus.disconnect();
            throw new Error(`Could not own the TCC test name, RequestName returned ${result}`);
        }
    }

    const profiles = testProfiles();
    const settings = structuredClone(options.initialSettings ?? testSettings());
    const authorizationCalls: AuthorizationCall[] = [];
    const polkitSubjects: PolkitSubject[] = [];
    const appliedProfiles: string[] = [];
    const persistedSettings: ITccSettings[] = [];
    const configurationReplacements: ConfigurationReplacement[] = [];
    const logs: string[] = [];
    const deniedSenders = new Set<string>();
    const clients = new Set<dbus.MessageBus>();
    const polkitInterface = new FakePolkitAuthority(authorizationCalls, polkitSubjects, deniedSenders);
    const polkitNameResult = await bus.requestName(POLKIT_NAME, dbus.NameFlag.DO_NOT_QUEUE);
    if (polkitNameResult !== dbus.RequestNameReply.PRIMARY_OWNER) {
        bus.disconnect();
        throw new Error(`Could not own the fake Polkit name, RequestName returned ${polkitNameResult}`);
    }
    bus.export(POLKIT_PATH, polkitInterface);
    let service: PowerProfilesService | undefined;
    let failedProfileId: string | undefined;
    let gatedProfileId: string | undefined;
    let applicationGate: Promise<void> | undefined;

    const selector = new ProfileSelection({
        catalog: () => profiles,
        resolveMappings(candidateSettings, catalog) {
            return PowerProfilesConfig.resolveCatalog(candidateSettings, catalog);
        },
        powerSource: () => ProfileStates.AC,
        async applyProfile(profile) {
            appliedProfiles.push(profile.id);
            if (profile.id === gatedProfileId && applicationGate !== undefined) {
                await applicationGate;
            }
            if (profile.id === failedProfileId) {
                throw new Error(`Injected apply failure for ${profile.id}`);
            }
        },
        async persistSettings(candidate) {
            persistedSettings.push(structuredClone(candidate));
        },
        notifyProfileReleased(owner, cookie) {
            service?.emitProfileReleased(owner, cookie);
        },
        publishProfile() {
            service?.notifyPropertiesChanged();
        },
        onWithdraw(reason) {
            logs.push(`Selector withdrawn during ${reason.operation}`);
            void service?.refreshProvider();
        },
    });
    await selector.reload(settings, profiles);
    const tccInterface = options.claimTccName ? new FakeTccInterface(selector) : undefined;
    if (tccInterface !== undefined) {
        bus.export(TCC_PATH, tccInterface);
    }

    const authorization = new DBusAuthorization(bus);
    const backend: PowerProfilesBackend = {
        async selectTccProfileByName(name, persistence) {
            const matches = selector.profiles.filter((profile) => profile.name === name);
            if (matches.length !== 1) {
                throw new Error(`Expected one TCC profile named '${name}'`);
            }
            await selector.selectTccProfile(matches[0].id, persistence);
        },
        async replaceProfileConfiguration(settingsJSON, profilesJSON) {
            configurationReplacements.push({ settingsJSON, profilesJSON });
            if (options.persistConfiguration !== undefined) {
                return options.persistConfiguration(settingsJSON, profilesJSON);
            }
            return true;
        },
    };
    service = new PowerProfilesService({
        bus: bus as unknown as PowerProfilesBus,
        selector,
        authorization,
        backend,
        packageVersion: 'integration',
        log: (message) => logs.push(message),
    });
    await service.start();

    const harness: PowerProfilesIntegrationHarness = {
        bus,
        selector,
        service,
        authorizationCalls,
        polkitSubjects,
        appliedProfiles,
        persistedSettings,
        configurationReplacements,
        logs,
        clients,
        async openClient() {
            const client = await openBus(options.busAddress);
            clients.add(client);
            return client;
        },
        deny(sender) {
            deniedSenders.add(sender);
        },
        failProfile(id) {
            failedProfileId = id;
        },
        gateProfile(id, gate) {
            gatedProfileId = id;
            applicationGate = gate;
        },
        async close() {
            await service?.stop();
            for (const client of clients) {
                client.disconnect();
            }
            clients.clear();
            bus.unexport(POLKIT_PATH, polkitInterface);
            if (tccInterface !== undefined) {
                bus.unexport(TCC_PATH, tccInterface);
            }
            await bus.releaseName(POLKIT_NAME).catch(() => undefined);
            bus.disconnect();
        },
    };
    return harness;
}

export interface PowerPropertiesProxy extends dbus.ClientInterface {
    Get(interfaceName: string, propertyName: string): Promise<dbus.Variant>;
    GetAll(interfaceName: string): Promise<Record<string, dbus.Variant>>;
    Set(interfaceName: string, propertyName: string, value: dbus.Variant): Promise<null>;
    on(
        event: 'PropertiesChanged',
        listener: (interfaceName: string, changed: Record<string, dbus.Variant>, invalidated: string[]) => void,
    ): this;
}

export interface PowerProfilesProxy extends dbus.ClientInterface {
    HoldProfile(profile: string, reason: string, applicationId: string): Promise<number>;
    ReleaseProfile(cookie: number): Promise<null>;
    SetActionEnabled(action: string, enabled: boolean): Promise<null>;
    on(event: 'ProfileReleased', listener: (cookie: number) => void): this;
}

export async function providerProxies(client: dbus.MessageBus): Promise<{
    properties: PowerPropertiesProxy;
    profiles: PowerProfilesProxy;
}> {
    const object = await client.getProxyObject(POWER_PROFILES_NAME, POWER_PROFILES_PATH);
    return {
        properties: object.getInterface('org.freedesktop.DBus.Properties') as PowerPropertiesProxy,
        profiles: object.getInterface(POWER_PROFILES_INTERFACE) as PowerProfilesProxy,
    };
}

export function isPropertyChanged(
    changed: Record<string, dbus.Variant>,
    property: string,
    expected: (value: unknown) => boolean,
): boolean {
    const value = changed[property];
    return value !== undefined && expected(value.value);
}
