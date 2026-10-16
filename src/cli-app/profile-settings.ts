import { manageCriticalTemperature, interpolatePointsArray } from '../common/classes/FanUtils';
import { isDeepStrictEqual } from 'node:util';
import type { IDisplayFreqRes, IDisplayMode } from '../common/models/DisplayFreqRes';
import { defaultFanProfiles } from '../common/models/TccFanTable';
import type { ITccFanTableEntry } from '../common/models/TccFanTable';
import { FrequencyConfig, type ITccProfile } from '../common/models/TccProfile';
import type { CliClient } from './cli';
import type { ProfileIO } from './profile-io';

type OptionalCpuDefaults = 'onlineCores' | 'scalingMinFrequency' | 'scalingMaxFrequency';
type SavedProfileCpu = Omit<ITccProfile['cpu'], OptionalCpuDefaults> &
    Partial<Pick<ITccProfile['cpu'], OptionalCpuDefaults>>;
type SavedODMProfile = Omit<ITccProfile['odmProfile'], 'name'> & Partial<Pick<ITccProfile['odmProfile'], 'name'>>;

export type SavedProfile = Omit<ITccProfile, 'cpu' | 'odmProfile'> & {
    cpu: SavedProfileCpu;
    odmProfile: SavedODMProfile;
};

type JsonObject = Record<string, unknown>;

const profileErrorPrefix = 'tcc-cli: Invalid profile setting: ';
const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const knownFanProfiles = defaultFanProfiles
    .map((profile): string | undefined => profile.name)
    .filter((name): name is string => typeof name === 'string');

function invalid(path: string, reason: string): never {
    throw new Error(`${profileErrorPrefix}${path}: ${reason.replace(/[.]+$/, '')}.`);
}

function isPlainObject(value: unknown): value is JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function objectAt(value: unknown, path: string): JsonObject {
    if (!isPlainObject(value)) {
        return invalid(path, 'must be a plain object');
    }
    return value;
}

function stringAt(value: unknown, path: string): string {
    if (typeof value !== 'string') {
        return invalid(path, 'must be a string');
    }
    return value;
}

function nonemptyStringAt(value: unknown, path: string): string {
    const result: string = stringAt(value, path);
    if (result.length === 0) {
        return invalid(path, 'must not be empty');
    }
    return result;
}

function booleanAt(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
        return invalid(path, 'must be a boolean');
    }
    return value;
}

function finiteNumberAt(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return invalid(path, 'must be a finite number');
    }
    return value;
}

function integerAt(value: unknown, path: string): number {
    const result: number = finiteNumberAt(value, path);
    if (!Number.isInteger(result)) {
        return invalid(path, 'must be an integer');
    }
    return result;
}

function integerInRange(value: unknown, path: string, minimum: number, maximum: number): number {
    const result: number = integerAt(value, path);
    if (result < minimum || result > maximum) {
        return invalid(path, `must be between ${minimum} and ${maximum}`);
    }
    return result;
}

function positiveInteger(value: unknown, path: string): number {
    const result: number = integerAt(value, path);
    if (result <= 0) {
        return invalid(path, 'must be a positive integer');
    }
    return result;
}

function positiveOrMinusOne(value: unknown, path: string, integer: boolean): number {
    const result: number = integer ? integerAt(value, path) : finiteNumberAt(value, path);
    if (result !== -1 && result <= 0) {
        return invalid(path, 'must be positive or -1');
    }
    return result;
}

function required(object: JsonObject, key: string, path: string): unknown {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
        return invalid(path, 'is required');
    }
    return object[key];
}

function validateFanTable(value: unknown, path: string): ITccFanTableEntry[] {
    if (!Array.isArray(value) || value.length < 9) {
        return invalid(path, 'must contain at least nine entries');
    }
    const points: ITccFanTableEntry[] = [];
    let previousTemp = -1;
    let previousSpeed = -1;
    for (let index = 0; index < value.length; index += 1) {
        const entryPath: string = `${path}[${index}]`;
        const entry: JsonObject = objectAt(value[index], entryPath);
        const temp: number = integerInRange(required(entry, 'temp', `${entryPath}.temp`), `${entryPath}.temp`, 0, 100);
        const speed: number = integerInRange(required(entry, 'speed', `${entryPath}.speed`), `${entryPath}.speed`, 0, 100);
        if (temp <= previousTemp) {
            return invalid(`${entryPath}.temp`, 'must be strictly greater than the previous temperature');
        }
        if (speed < previousSpeed) {
            return invalid(`${entryPath}.speed`, 'must not be lower than the previous speed');
        }
        points.push({ temp, speed });
        previousTemp = temp;
        previousSpeed = speed;
    }
    return points;
}

function interpolatedSpeed(points: readonly ITccFanTableEntry[], temperature: number): number {
    const first: ITccFanTableEntry = points[0];
    const last: ITccFanTableEntry = points[points.length - 1];
    if (temperature <= first.temp) {
        return first.speed;
    }
    if (temperature >= last.temp) {
        return last.speed;
    }
    const upperIndex: number = points.findIndex((point): boolean => point.temp >= temperature);
    const lower: ITccFanTableEntry = points[upperIndex - 1];
    const upper: ITccFanTableEntry = points[upperIndex];
    const slope: number = (upper.speed - lower.speed) / (upper.temp - lower.temp);
    const intercept: number = lower.speed - slope * lower.temp;
    return Math.round(slope * temperature + intercept);
}

function validateCustomCurveSafety(points: readonly ITccFanTableEntry[], path: string): void {
    if (points[0].temp > 20 || points[points.length - 1].temp < 100) {
        invalid(path, 'a Custom fan curve must cover temperatures from 20 through 100');
    }
    for (let temperature = 80; temperature <= 100; temperature += 1) {
        const speed: number = interpolatedSpeed(points, temperature);
        if (speed < manageCriticalTemperature(temperature, speed)) {
            invalid(path, `interpolated speed at ${temperature} degrees is below the required minimum`);
        }
    }
}

function validateDisplay(displayValue: unknown): void {
    const display: JsonObject = objectAt(displayValue, 'display');
    integerInRange(required(display, 'brightness', 'display.brightness'), 'display.brightness', 0, 100);
    booleanAt(required(display, 'useBrightness', 'display.useBrightness'), 'display.useBrightness');
    const refreshRate: number = positiveOrMinusOne(
        required(display, 'refreshRate', 'display.refreshRate'),
        'display.refreshRate',
        false,
    );
    const useRefRate: boolean = booleanAt(required(display, 'useRefRate', 'display.useRefRate'), 'display.useRefRate');
    if (refreshRate === -1 && useRefRate) {
        invalid('display.refreshRate', 'may be -1 only when display.useRefRate is false');
    }
    positiveOrMinusOne(required(display, 'xResolution', 'display.xResolution'), 'display.xResolution', true);
    positiveOrMinusOne(required(display, 'yResolution', 'display.yResolution'), 'display.yResolution', true);
    booleanAt(required(display, 'useResolution', 'display.useResolution'), 'display.useResolution');
}

function validateCpu(cpuValue: unknown): void {
    const cpu: JsonObject = objectAt(cpuValue, 'cpu');
    if (Object.prototype.hasOwnProperty.call(cpu, 'onlineCores')) {
        positiveInteger(cpu.onlineCores, 'cpu.onlineCores');
    }
    booleanAt(required(cpu, 'useMaxPerfGov', 'cpu.useMaxPerfGov'), 'cpu.useMaxPerfGov');
    if (Object.prototype.hasOwnProperty.call(cpu, 'scalingMinFrequency')) {
        positiveInteger(cpu.scalingMinFrequency, 'cpu.scalingMinFrequency');
    }
    if (Object.prototype.hasOwnProperty.call(cpu, 'scalingMaxFrequency')) {
        positiveOrMinusOne(cpu.scalingMaxFrequency, 'cpu.scalingMaxFrequency', true);
    }
    stringAt(required(cpu, 'governor', 'cpu.governor'), 'cpu.governor');
    stringAt(
        required(cpu, 'energyPerformancePreference', 'cpu.energyPerformancePreference'),
        'cpu.energyPerformancePreference',
    );
    booleanAt(required(cpu, 'noTurbo', 'cpu.noTurbo'), 'cpu.noTurbo');
}

function validateWebcam(webcamValue: unknown): void {
    const webcam: JsonObject = objectAt(webcamValue, 'webcam');
    booleanAt(required(webcam, 'status', 'webcam.status'), 'webcam.status');
    booleanAt(required(webcam, 'useStatus', 'webcam.useStatus'), 'webcam.useStatus');
}

function validateFan(fanValue: unknown): void {
    const fan: JsonObject = objectAt(fanValue, 'fan');
    booleanAt(required(fan, 'useControl', 'fan.useControl'), 'fan.useControl');
    stringAt(required(fan, 'fanProfile', 'fan.fanProfile'), 'fan.fanProfile');
    const minimum: number = integerInRange(
        required(fan, 'minimumFanspeed', 'fan.minimumFanspeed'),
        'fan.minimumFanspeed',
        0,
        100,
    );
    const maximum: number = integerInRange(
        required(fan, 'maximumFanspeed', 'fan.maximumFanspeed'),
        'fan.maximumFanspeed',
        0,
        100,
    );
    if (minimum > maximum) {
        invalid('fan.minimumFanspeed', 'must not exceed fan.maximumFanspeed');
    }
    integerInRange(required(fan, 'offsetFanspeed', 'fan.offsetFanspeed'), 'fan.offsetFanspeed', -100, 100);

    const curve: JsonObject = objectAt(required(fan, 'customFanCurve', 'fan.customFanCurve'), 'fan.customFanCurve');
    if (Object.prototype.hasOwnProperty.call(curve, 'name')) {
        stringAt(curve.name, 'fan.customFanCurve.name');
    }
    const cpuTable: ITccFanTableEntry[] = validateFanTable(
        required(curve, 'tableCPU', 'fan.customFanCurve.tableCPU'),
        'fan.customFanCurve.tableCPU',
    );
    const gpuTable: ITccFanTableEntry[] = validateFanTable(
        required(curve, 'tableGPU', 'fan.customFanCurve.tableGPU'),
        'fan.customFanCurve.tableGPU',
    );
    if (fan.fanProfile === 'Custom') {
        validateCustomCurveSafety(cpuTable, 'fan.customFanCurve.tableCPU');
        validateCustomCurveSafety(gpuTable, 'fan.customFanCurve.tableGPU');
    }
}

function validateODMProfile(value: unknown): void {
    const odmProfile: JsonObject = objectAt(value, 'odmProfile');
    if (Object.prototype.hasOwnProperty.call(odmProfile, 'name')) {
        stringAt(odmProfile.name, 'odmProfile.name');
    }
}

function validateTdp(value: unknown): void {
    const powerLimits: JsonObject = objectAt(value, 'odmPowerLimits');
    const tdpValues: unknown = required(powerLimits, 'tdpValues', 'odmPowerLimits.tdpValues');
    if (!Array.isArray(tdpValues)) {
        invalid('odmPowerLimits.tdpValues', 'must be an array');
    }
    let previous = -Infinity;
    for (let index = 0; index < tdpValues.length; index += 1) {
        const path: string = `odmPowerLimits.tdpValues[${index}]`;
        const power: number = finiteNumberAt(tdpValues[index], path);
        if (power < 0) {
            invalid(path, 'must be nonnegative');
        }
        if (power < previous) {
            invalid(path, 'must not be lower than the previous TDP value');
        }
        previous = power;
    }
}

function validateNvidia(value: unknown): void {
    const nvidia: JsonObject = objectAt(value, 'nvidiaPowerCTRLProfile');
    const offset: number = integerAt(
        required(nvidia, 'cTGPOffset', 'nvidiaPowerCTRLProfile.cTGPOffset'),
        'nvidiaPowerCTRLProfile.cTGPOffset',
    );
    if (offset < 0) {
        invalid('nvidiaPowerCTRLProfile.cTGPOffset', 'must be nonnegative');
    }
}

export function validateProfileDocument(value: unknown): asserts value is SavedProfile {
    const profile: JsonObject = objectAt(value, 'profile');
    nonemptyStringAt(required(profile, 'id', 'id'), 'id');
    stringAt(required(profile, 'name', 'name'), 'name');
    stringAt(required(profile, 'description', 'description'), 'description');
    validateDisplay(required(profile, 'display', 'display'));
    validateCpu(required(profile, 'cpu', 'cpu'));
    validateWebcam(required(profile, 'webcam', 'webcam'));
    validateFan(required(profile, 'fan', 'fan'));
    validateODMProfile(required(profile, 'odmProfile', 'odmProfile'));
    validateTdp(required(profile, 'odmPowerLimits', 'odmPowerLimits'));
    validateNvidia(required(profile, 'nvidiaPowerCTRLProfile', 'nvidiaPowerCTRLProfile'));
}

export function validateSavedProfiles(value: unknown, defaultIds: ReadonlySet<string>): asserts value is SavedProfile[] {
    if (!Array.isArray(value)) {
        invalid('profiles', 'must be an array');
    }
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
        const path: string = `profiles[${index}].id`;
        const profile: unknown = value[index];
        validateProfileDocument(profile);
        const id: string = profile.id;
        if (seen.has(id)) {
            invalid(path, `duplicates profile ID ${JSON.stringify(id)}`);
        }
        if (defaultIds.has(id)) {
            invalid(path, `collides with built-in profile ID ${JSON.stringify(id)}`);
        }
        seen.add(id);
    }
}

function parseNumericToken(token: string, path: string): number {
    if (!numericPattern.test(token)) {
        return invalid(path, 'must be a complete decimal number');
    }
    const value: number = Number(token);
    if (!Number.isFinite(value)) {
        return invalid(path, 'must be a finite number');
    }
    return value;
}

function parseIntegerToken(token: string, path: string): number {
    const value: number = parseNumericToken(token, path);
    if (!Number.isInteger(value)) {
        return invalid(path, 'must be an integer');
    }
    return value;
}


function onOff(token: string, path: string): boolean {
    if (token === 'on') {
        return true;
    }
    if (token === 'off') {
        return false;
    }
    return invalid(path, 'must be "on" or "off"');
}

function setPercent(token: string, path: string): number {
    return integerInRange(parseIntegerToken(token, path), path, 0, 100);
}

function mutateSetting(draft: SavedProfile, key: string, token: string): void {
    switch (key) {
        case 'name':
            draft.name = token;
            return;
        case 'description':
            draft.description = token;
            return;
        case 'brightness':
            if (token === 'unchanged') {
                draft.display.useBrightness = false;
            } else {
                draft.display.brightness = setPercent(token, 'display.brightness');
                draft.display.useBrightness = true;
            }
            return;
        case 'refresh-rate':
            if (token === 'unchanged') {
                draft.display.useRefRate = false;
            } else {
                const refreshRate: number = parseNumericToken(token, 'display.refreshRate');
                if (refreshRate <= 0) {
                    invalid('display.refreshRate', 'must be positive');
                }
                draft.display.refreshRate = refreshRate;
                draft.display.useRefRate = true;
            }
            return;
        case 'webcam':
            if (token !== 'on' && token !== 'off') {
                invalid('webcam.status', 'must be "on" or "off"');
            }
            draft.webcam.status = token === 'on';
            draft.webcam.useStatus = true;
            return;
        case 'cpu-cores':
            if (token === 'all') {
                delete draft.cpu.onlineCores;
            } else {
                draft.cpu.onlineCores = positiveInteger(parseIntegerToken(token, 'cpu.onlineCores'), 'cpu.onlineCores');
            }
            return;
        case 'cpu-min-frequency':
            if (token === 'default') {
                delete draft.cpu.scalingMinFrequency;
            } else {
                draft.cpu.scalingMinFrequency = positiveInteger(
                    parseIntegerToken(token, 'cpu.scalingMinFrequency'),
                    'cpu.scalingMinFrequency',
                );
            }
            return;
        case 'cpu-max-frequency':
            if (token === 'max') {
                delete draft.cpu.scalingMaxFrequency;
            } else if (token === 'reduced') {
                draft.cpu.scalingMaxFrequency = FrequencyConfig.ReducedFrequency;
            } else {
                draft.cpu.scalingMaxFrequency = positiveInteger(
                    parseIntegerToken(token, 'cpu.scalingMaxFrequency'),
                    'cpu.scalingMaxFrequency',
                );
            }
            return;
        case 'cpu-max-performance':
            draft.cpu.useMaxPerfGov = onOff(token, 'cpu.useMaxPerfGov');
            return;
        case 'cpu-energy-preference':
            if (token.length === 0) {
                invalid('cpu.energyPerformancePreference', 'must not be empty');
            }
            draft.cpu.energyPerformancePreference = token;
            return;
        case 'cpu-turbo':
            draft.cpu.noTurbo = !onOff(token, 'cpu.noTurbo');
            return;
        case 'fan-profile':
            if (!knownFanProfiles.includes(token)) {
                invalid('fan.fanProfile', 'must match a named default fan profile');
            }
            draft.fan.fanProfile = token;
            return;
        case 'fan-min-speed':
            draft.fan.minimumFanspeed = setPercent(token, 'fan.minimumFanspeed');
            return;
        case 'fan-max-speed':
            draft.fan.maximumFanspeed = setPercent(token, 'fan.maximumFanspeed');
            return;
        case 'fan-offset':
            draft.fan.offsetFanspeed = integerInRange(
                parseIntegerToken(token, 'fan.offsetFanspeed'),
                'fan.offsetFanspeed',
                -100,
                100,
            );
            return;
        case 'odm-profile':
            if (token.length === 0) {
                invalid('odmProfile.name', 'must not be empty');
            }
            draft.odmProfile.name = token;
            return;
        case 'nvidia-power-offset':
            const offset: number = parseIntegerToken(token, 'nvidiaPowerCTRLProfile.cTGPOffset');
            if (offset < 0) {
                invalid('nvidiaPowerCTRLProfile.cTGPOffset', 'must be nonnegative');
            }
            draft.nvidiaPowerCTRLProfile.cTGPOffset = offset;
            return;
        default:
            invalid(key, 'is not a supported profile setting');
    }
}

export function applyProfileSettings(draft: SavedProfile, settings: ReadonlyMap<string, string>): void {
    for (const [key, token] of settings) {
        mutateSetting(draft, key, token);
    }
    validateProfileDocument(draft);
}

function hasOwn(object: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function fieldChanged(before: JsonObject, draft: JsonObject, key: string): boolean {
    const beforeHas: boolean = hasOwn(before, key);
    const draftHas: boolean = hasOwn(draft, key);
    return beforeHas !== draftHas || !isDeepStrictEqual(before[key], draft[key]);
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
        return error.message.replace(/[.]+$/, '');
    }
    return String(error).replace(/[.]+$/, '');
}

async function capability<T>(path: string, lookup: () => Promise<T>): Promise<T> {
    try {
        return await lookup();
    } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith(profileErrorPrefix)) {
            throw error;
        }
        invalid(path, `capability lookup failed: ${errorMessage(error)}`);
    }
}

async function readDefaultCpuValues(
    client: CliClient,
    path: string,
): Promise<JsonObject> {
    const json: string = await capability(path, async (): Promise<string> => {
        const result: string = await client.getDefaultValuesProfileJSON();
        if (typeof result !== 'string' || result.length === 0) {
            invalid(path, 'daemon returned no default-values profile');
        }
        return result;
    });
    let profile: unknown;
    try {
        profile = JSON.parse(json) as unknown;
    } catch {
        return invalid(path, 'daemon returned malformed default-values JSON');
    }
    if (!isPlainObject(profile) || !isPlainObject(profile.cpu)) {
        return invalid(path, 'daemon returned malformed default CPU values');
    }
    return profile.cpu;
}

function defaultPositiveInteger(cpu: JsonObject, key: string, path: string): number {
    return positiveInteger(cpu[key], path);
}

async function readCpuCapabilities(io: ProfileIO, path: string): Promise<{
    energyPreferences?: string[];
    turboAvailable: boolean;
    reducedFrequency?: number;
}> {
    const result = await capability(path, (): Promise<{
        energyPreferences?: string[];
        turboAvailable: boolean;
        reducedFrequency?: number;
    }> => io.readCpuCapabilities());
    if (!isPlainObject(result)) {
        return invalid(path, 'CPU capability data is malformed');
    }
    return result as {
        energyPreferences?: string[];
        turboAvailable: boolean;
        reducedFrequency?: number;
    };
}

function readRequiredEppList(capabilities: {
    energyPreferences?: string[];
    turboAvailable: boolean;
    reducedFrequency?: number;
}, path: string): string[] {
    if (!Array.isArray(capabilities.energyPreferences) || !capabilities.energyPreferences.every((value): boolean => typeof value === 'string')) {
        return invalid(path, 'CPU energy-preference capability data is unavailable or malformed');
    }
    return capabilities.energyPreferences;
}

function ensureChangedText(before: SavedProfile, draft: SavedProfile): void {
    if (before.id !== draft.id || before.name !== draft.name) {
        if (draft.name.length < 1 || draft.name.length > 50) {
            invalid('name', 'must contain between 1 and 50 characters when changed');
        }
    }
    if (before.description !== draft.description && draft.description.length > 200) {
        invalid('description', 'must contain no more than 200 characters when changed');
    }
}

function requireProfileObject(profile: SavedProfile, key: 'cpu' | 'display' | 'fan' | 'odmProfile' | 'odmPowerLimits' | 'nvidiaPowerCTRLProfile'): JsonObject {
    return profile[key] as unknown as JsonObject;
}

function optionalNumericField(object: JsonObject, key: string): number | undefined {
    return hasOwn(object, key) ? object[key] as number : undefined;
}

function validateDefaultFrequencyPair(defaults: JsonObject): { minimum: number; maximum: number } {
    const minimum: number = defaultPositiveInteger(defaults, 'scalingMinFrequency', 'cpu.scalingMinFrequency');
    const maximum: number = defaultPositiveInteger(defaults, 'scalingMaxFrequency', 'cpu.scalingMaxFrequency');
    if (minimum > maximum) {
        invalid('cpu.scalingMinFrequency', 'daemon default minimum frequency exceeds its maximum frequency');
    }
    return { minimum, maximum };
}

async function validateCpuFrequencyGroup(
    draft: SavedProfile,
    settings: ReadonlyMap<string, string>,
    client: CliClient,
    io: ProfileIO,
    minimumChanged: boolean,
    maximumChanged: boolean,
): Promise<void> {
    const cpu: JsonObject = requireProfileObject(draft, 'cpu');
    const minimumExplicit: boolean = settings.has('cpu-min-frequency');
    const maximumExplicit: boolean = settings.has('cpu-max-frequency');
    if (draft.cpu.useMaxPerfGov && (minimumChanged || maximumChanged || minimumExplicit || maximumExplicit || settings.has('cpu-energy-preference'))) {
        const path: string = minimumExplicit || minimumChanged
            ? 'cpu.scalingMinFrequency'
            : maximumExplicit || maximumChanged
                ? 'cpu.scalingMaxFrequency'
                : 'cpu.energyPerformancePreference';
        invalid(path, 'cannot be changed while cpu.useMaxPerfGov is true');
    }

    const frequencyPath: string = minimumChanged || minimumExplicit
        ? 'cpu.scalingMinFrequency'
        : 'cpu.scalingMaxFrequency';
    const defaults: JsonObject = await readDefaultCpuValues(client, frequencyPath);
    const { minimum: defaultMinimum, maximum: defaultMaximum } = validateDefaultFrequencyPair(defaults);
    const minimumNeedsBounds: boolean = minimumChanged || minimumExplicit;
    const maximumNeedsBounds: boolean = maximumChanged || maximumExplicit;
    const storedMinimum: number | undefined = optionalNumericField(cpu, 'scalingMinFrequency');
    const effectiveMinimum: number = storedMinimum ?? defaultMinimum;
    if (minimumNeedsBounds && (effectiveMinimum < defaultMinimum || effectiveMinimum > defaultMaximum)) {
        invalid('cpu.scalingMinFrequency', `must be within the daemon default range ${defaultMinimum}..${defaultMaximum}`);
    }

    const storedMaximum: number | undefined = optionalNumericField(cpu, 'scalingMaxFrequency');
    let effectiveMaximum: number;
    if (storedMaximum === undefined) {
        effectiveMaximum = defaultMaximum;
    } else if (storedMaximum === FrequencyConfig.ReducedFrequency) {
        const capabilities = await readCpuCapabilities(io, 'cpu.scalingMaxFrequency');
        const reduced: unknown = capabilities.reducedFrequency;
        if (typeof reduced !== 'number' || !Number.isInteger(reduced) || reduced <= 0) {
            invalid('cpu.scalingMaxFrequency', 'reduced CPU frequency capability is unavailable or malformed');
        }
        effectiveMaximum = reduced;
    } else {
        effectiveMaximum = storedMaximum;
    }
    if (maximumNeedsBounds && (effectiveMaximum < defaultMinimum || effectiveMaximum > defaultMaximum)) {
        invalid('cpu.scalingMaxFrequency', `must be within the daemon default range ${defaultMinimum}..${defaultMaximum}`);
    }
    if (effectiveMinimum > effectiveMaximum) {
        const path: string = minimumChanged || minimumExplicit ? 'cpu.scalingMinFrequency' : 'cpu.scalingMaxFrequency';
        invalid(path, 'effective minimum frequency must not exceed effective maximum frequency');
    }
}

function readDisplayModes(value: unknown, path: string): IDisplayFreqRes {
    if (!isPlainObject(value)) {
        return invalid(path, 'daemon returned malformed display-mode data');
    }
    const display = value as unknown as IDisplayFreqRes;
    const activeMode: unknown = display.activeMode;
    const modes: unknown = display.displayModes;
    if (
        typeof display.displayName !== 'string' ||
        !isPlainObject(activeMode) ||
        !Array.isArray(modes)
    ) {
        return invalid(path, 'daemon returned malformed display-mode data');
    }
    const active = activeMode as unknown as IDisplayMode;
    if (
        !Number.isInteger(active.xResolution) || active.xResolution <= 0 ||
        !Number.isInteger(active.yResolution) || active.yResolution <= 0 ||
        !Array.isArray(active.refreshRates) ||
        !active.refreshRates.every((rate): boolean => typeof rate === 'number' && Number.isFinite(rate) && rate > 0)
    ) {
        return invalid(path, 'daemon returned malformed active display mode');
    }
    for (const mode of modes) {
        if (!isPlainObject(mode)) {
            return invalid(path, 'daemon returned malformed display mode');
        }
        const candidate = mode as unknown as IDisplayMode;
        if (
            !Number.isInteger(candidate.xResolution) || candidate.xResolution <= 0 ||
            !Number.isInteger(candidate.yResolution) || candidate.yResolution <= 0 ||
            !Array.isArray(candidate.refreshRates) ||
            !candidate.refreshRates.every((rate): boolean => typeof rate === 'number' && Number.isFinite(rate) && rate > 0)
        ) {
            return invalid(path, 'daemon returned malformed display mode');
        }
    }
    return display;
}

async function validateRefreshRate(
    draft: SavedProfile,
    client: CliClient,
    explicitEnable: boolean,
): Promise<void> {
    const display: JsonObject = requireProfileObject(draft, 'display');
    if (!draft.display.useRefRate || !explicitEnable) {
        return;
    }
    const sessionType: number = await capability('display.refreshRate', (): Promise<number> => client.getIsX11());
    if (sessionType !== 1) {
        invalid('display.refreshRate', 'refresh-rate control requires an X11 session');
    }
    const json: string = await capability('display.refreshRate', async (): Promise<string> => {
        const result: string = await client.getDisplayModesJSON();
        if (typeof result !== 'string' || result.length === 0) {
            invalid('display.refreshRate', 'daemon returned no display-mode data');
        }
        return result;
    });
    let raw: unknown;
    try {
        raw = JSON.parse(json) as unknown;
    } catch {
        invalid('display.refreshRate', 'daemon returned malformed display-mode JSON');
    }
    const modes: IDisplayFreqRes = readDisplayModes(raw, 'display.refreshRate');
    const activeMode: IDisplayMode = modes.activeMode;
    const activeResolutionMode: IDisplayMode | undefined = modes.displayModes.find(
        (mode: IDisplayMode): boolean =>
            mode.xResolution === activeMode.xResolution && mode.yResolution === activeMode.yResolution,
    );
    const rates: number[] = activeResolutionMode?.refreshRates ?? [];
    if (!rates.includes(display.refreshRate as number)) {
        invalid('display.refreshRate', 'is not available for the active display resolution');
    }
}

async function validateFanSpeedCapabilities(
    draft: SavedProfile,
    client: CliClient,
    minimumChanged: boolean,
    maximumChanged: boolean,
): Promise<void> {
    const fan: JsonObject = requireProfileObject(draft, 'fan');
    let fansOff: boolean | undefined;
    let minimumSpeed: number | undefined;
    if (minimumChanged) {
        fansOff = await capability('fan.minimumFanspeed', (): Promise<boolean> => client.getFansOffAvailable());
    } else if (maximumChanged) {
        fansOff = await capability('fan.maximumFanspeed', (): Promise<boolean> => client.getFansOffAvailable());
    }
    if (typeof fansOff !== 'boolean') {
        invalid(minimumChanged ? 'fan.minimumFanspeed' : 'fan.maximumFanspeed', 'fan-off capability data is unavailable or malformed');
    }
    const minPath: string = minimumChanged ? 'fan.minimumFanspeed' : 'fan.maximumFanspeed';
    minimumSpeed = await capability(minPath, (): Promise<number> => client.getFansMinSpeed());
    if (typeof minimumSpeed !== 'number' || !Number.isInteger(minimumSpeed) || minimumSpeed < 0 || minimumSpeed > 100) {
        invalid(minPath, 'minimum fan-speed capability data is unavailable or malformed');
    }
    for (const [changed, key, path] of [
        [minimumChanged, 'minimumFanspeed', 'fan.minimumFanspeed'],
        [maximumChanged, 'maximumFanspeed', 'fan.maximumFanspeed'],
    ] as const) {
        if (!changed) {
            continue;
        }
        const speed: number = fan[key] as number;
        if (speed === 0 && fansOff !== true) {
            invalid(path, 'zero is not supported because the device cannot turn fans off');
        }
        if (speed > 0 && speed < minimumSpeed) {
            invalid(path, `must be at least the device minimum fan speed (${minimumSpeed})`);
        }
    }
}

async function validateTdpCapabilities(draft: SavedProfile, client: CliClient): Promise<void> {
    const descriptors: unknown = await capability('odmPowerLimits.tdpValues', (): Promise<unknown> => client.odmPowerLimits());
    if (!Array.isArray(descriptors)) {
        invalid('odmPowerLimits.tdpValues', 'runtime TDP descriptors are unavailable or malformed');
    }
    const values: number[] = draft.odmPowerLimits.tdpValues;
    if (descriptors.length !== values.length) {
        invalid('odmPowerLimits.tdpValues', 'must contain one value for each runtime TDP descriptor');
    }
    for (let index = 0; index < descriptors.length; index += 1) {
        const descriptor: JsonObject = objectAt(descriptors[index], `odmPowerLimits.tdpValues[${index}]`);
        const minimum: number = finiteNumberAt(descriptor.min, `odmPowerLimits.tdpValues[${index}]`);
        const maximum: number = finiteNumberAt(descriptor.max, `odmPowerLimits.tdpValues[${index}]`);
        if (minimum < 0 || maximum < minimum) {
            invalid(`odmPowerLimits.tdpValues[${index}]`, 'runtime TDP descriptor has invalid bounds');
        }
        if (values[index] < minimum || values[index] > maximum) {
            invalid(`odmPowerLimits.tdpValues[${index}]`, `must be within the runtime range ${minimum}..${maximum}`);
        }
    }
}

async function validateNvidiaOffset(draft: SavedProfile, client: CliClient): Promise<void> {
    const available: boolean = await capability(
        'nvidiaPowerCTRLProfile.cTGPOffset',
        (): Promise<boolean> => client.getNVIDIAPowerCTRLAvailable(),
    );
    if (available !== true) {
        invalid('nvidiaPowerCTRLProfile.cTGPOffset', 'NVIDIA power control is unavailable');
    }
    const unsupported: boolean = await capability(
        'nvidiaPowerCTRLProfile.cTGPOffset',
        (): Promise<boolean> => client.getIsUnsupportedConfigurableTGPDevice(),
    );
    if (unsupported !== false) {
        invalid('nvidiaPowerCTRLProfile.cTGPOffset', 'the device does not support configurable NVIDIA power limits');
    }
    const defaultLimit: number = await capability(
        'nvidiaPowerCTRLProfile.cTGPOffset',
        (): Promise<number> => client.getNVIDIAPowerCTRLDefaultPowerLimit(),
    );
    const maximumLimit: number = await capability(
        'nvidiaPowerCTRLProfile.cTGPOffset',
        (): Promise<number> => client.getNVIDIAPowerCTRLMaxPowerLimit(),
    );
    if (
        typeof defaultLimit !== 'number' || !Number.isFinite(defaultLimit) || defaultLimit <= 0 ||
        typeof maximumLimit !== 'number' || !Number.isFinite(maximumLimit) || maximumLimit <= 0
    ) {
        invalid('nvidiaPowerCTRLProfile.cTGPOffset', 'default or maximum NVIDIA power limit is unavailable or malformed');
    }
    const maximumOffset: number = maximumLimit - defaultLimit;
    const offset: number = draft.nvidiaPowerCTRLProfile.cTGPOffset;
    if (maximumOffset < 0 || offset > maximumOffset) {
        invalid('nvidiaPowerCTRLProfile.cTGPOffset', `must be between 0 and ${Math.max(0, maximumOffset)} watts`);
    }
}

async function validateCustomCurveWithFanUtils(profile: SavedProfile): Promise<void> {
    if (profile.fan.fanProfile !== 'Custom') {
        return;
    }
    const curve: JsonObject = profile.fan.customFanCurve as unknown as JsonObject;
    for (const tableName of ['tableCPU', 'tableGPU'] as const) {
        const path: string = `fan.customFanCurve.${tableName}`;
        try {
            const points: ITccFanTableEntry[] = curve[tableName] as ITccFanTableEntry[];
            const interpolated: number[] = await interpolatePointsArray(points);
            for (let temperature = 80; temperature <= 100; temperature += 1) {
                if (interpolated[temperature] < manageCriticalTemperature(temperature, interpolated[temperature])) {
                    invalid(path, `interpolated speed at ${temperature} degrees is below the required minimum`);
                }
            }
        } catch (error: unknown) {
            if (error instanceof Error && error.message.startsWith(profileErrorPrefix)) {
                throw error;
            }
            invalid(path, `could not validate interpolated curve: ${errorMessage(error)}`);
        }
    }
}

export async function validateChangedSettings(
    before: SavedProfile,
    draft: SavedProfile,
    settings: ReadonlyMap<string, string>,
    client: CliClient,
    io: ProfileIO,
): Promise<void> {
    validateProfileDocument(before);
    validateProfileDocument(draft);
    ensureChangedText(before, draft);
    await validateCustomCurveWithFanUtils(draft);

    const beforeCpu: JsonObject = requireProfileObject(before, 'cpu');
    const draftCpu: JsonObject = requireProfileObject(draft, 'cpu');
    const coresChanged: boolean = fieldChanged(beforeCpu, draftCpu, 'onlineCores');
    const minimumChanged: boolean = fieldChanged(beforeCpu, draftCpu, 'scalingMinFrequency');
    const maximumChanged: boolean = fieldChanged(beforeCpu, draftCpu, 'scalingMaxFrequency');
    const minimumExplicit: boolean = settings.has('cpu-min-frequency');
    const maximumExplicit: boolean = settings.has('cpu-max-frequency');
    const eppChanged: boolean = fieldChanged(beforeCpu, draftCpu, 'energyPerformancePreference');
    const turboChanged: boolean = fieldChanged(beforeCpu, draftCpu, 'noTurbo');

    const maxPerfConflict: boolean = draft.cpu.useMaxPerfGov && (
        minimumChanged || maximumChanged || eppChanged || minimumExplicit || maximumExplicit || settings.has('cpu-energy-preference')
    );
    if (maxPerfConflict) {
        const path: string = minimumExplicit || minimumChanged
            ? 'cpu.scalingMinFrequency'
            : maximumExplicit || maximumChanged
                ? 'cpu.scalingMaxFrequency'
                : 'cpu.energyPerformancePreference';
        invalid(path, 'cannot be changed while cpu.useMaxPerfGov is true');
    }

    const coresExplicit: boolean = settings.has('cpu-cores');
    if (coresChanged || coresExplicit) {
        const defaults: JsonObject = await readDefaultCpuValues(client, 'cpu.onlineCores');
        const deviceCores: number = defaultPositiveInteger(defaults, 'onlineCores', 'cpu.onlineCores');
        const requestedCores: number | undefined = optionalNumericField(draftCpu, 'onlineCores');
        if (requestedCores !== undefined && requestedCores > deviceCores) {
            invalid('cpu.onlineCores', `must not exceed the device core count (${deviceCores})`);
        }
    }

    if (minimumChanged || maximumChanged || minimumExplicit || maximumExplicit) {
        await validateCpuFrequencyGroup(draft, settings, client, io, minimumChanged, maximumChanged);
    }

    const needsCpuCapabilities: boolean = eppChanged || turboChanged || settings.has('cpu-energy-preference') || settings.has('cpu-turbo');
    if (needsCpuCapabilities) {
        const path: string = eppChanged || settings.has('cpu-energy-preference')
            ? 'cpu.energyPerformancePreference'
            : 'cpu.noTurbo';
        const capabilities = await readCpuCapabilities(io, path);
        if (eppChanged || settings.has('cpu-energy-preference')) {
            const preferences: string[] = readRequiredEppList(capabilities, 'cpu.energyPerformancePreference');
            if (!preferences.includes(draft.cpu.energyPerformancePreference)) {
                invalid('cpu.energyPerformancePreference', 'is not supported by this CPU');
            }
        }
        if (turboChanged || settings.has('cpu-turbo')) {
            if (typeof capabilities.turboAvailable !== 'boolean') {
                invalid('cpu.noTurbo', 'CPU turbo capability data is unavailable or malformed');
            }
            if (!capabilities.turboAvailable) {
                invalid('cpu.noTurbo', 'CPU turbo control is unavailable');
            }
        }
    }

    const beforeDisplay: JsonObject = requireProfileObject(before, 'display');
    const draftDisplay: JsonObject = requireProfileObject(draft, 'display');
    const refreshRateChanged: boolean = fieldChanged(beforeDisplay, draftDisplay, 'refreshRate');
    const useRefRateChanged: boolean = fieldChanged(beforeDisplay, draftDisplay, 'useRefRate');
    const refreshFlag: string | undefined = settings.get('refresh-rate');
    const refreshExplicitlyEnabled: boolean = settings.has('refresh-rate') && refreshFlag !== 'unchanged';
    await validateRefreshRate(
        draft,
        client,
        refreshExplicitlyEnabled || (draft.display.useRefRate && (refreshRateChanged || useRefRateChanged)),
    );

    const beforeFan: JsonObject = requireProfileObject(before, 'fan');
    const draftFan: JsonObject = requireProfileObject(draft, 'fan');
    const fanProfileChanged: boolean = fieldChanged(beforeFan, draftFan, 'fanProfile');
    const fanMinChanged: boolean = fieldChanged(beforeFan, draftFan, 'minimumFanspeed');
    const fanMaxChanged: boolean = fieldChanged(beforeFan, draftFan, 'maximumFanspeed');
    const fanOffsetChanged: boolean = fieldChanged(beforeFan, draftFan, 'offsetFanspeed');
    const fanMinExplicit: boolean = settings.has('fan-min-speed');
    const fanMaxExplicit: boolean = settings.has('fan-max-speed');
    const fanOffsetExplicit: boolean = settings.has('fan-offset');
    if ((fanProfileChanged || settings.has('fan-profile')) && !knownFanProfiles.includes(draft.fan.fanProfile)) {
        invalid('fan.fanProfile', 'must match a named default fan profile');
    }
    if (
        draft.fan.fanProfile === 'Custom' &&
        (fanMinChanged || fanMaxChanged || fanOffsetChanged || fanMinExplicit || fanMaxExplicit || fanOffsetExplicit)
    ) {
        const path: string = fanMinChanged || fanMinExplicit
            ? 'fan.minimumFanspeed'
            : fanMaxChanged || fanMaxExplicit
                ? 'fan.maximumFanspeed'
                : 'fan.offsetFanspeed';
        invalid(path, 'cannot be changed while fan.fanProfile is Custom');
    }
    if (fanMinChanged || fanMaxChanged || fanMinExplicit || fanMaxExplicit) {
        await validateFanSpeedCapabilities(
            draft,
            client,
            fanMinChanged || fanMinExplicit,
            fanMaxChanged || fanMaxExplicit,
        );
    }

    const beforeODM: JsonObject = requireProfileObject(before, 'odmProfile');
    const draftODM: JsonObject = requireProfileObject(draft, 'odmProfile');
    const odmNameChanged: boolean = fieldChanged(beforeODM, draftODM, 'name');
    if ((odmNameChanged || settings.has('odm-profile')) && draft.odmProfile.name !== undefined) {
        const available: unknown = await capability('odmProfile.name', (): Promise<unknown> => client.odmProfilesAvailable());
        if (!Array.isArray(available) || !available.every((name): boolean => typeof name === 'string')) {
            invalid('odmProfile.name', 'runtime ODM profile names are unavailable or malformed');
        }
        if (!available.includes(draft.odmProfile.name)) {
            invalid('odmProfile.name', 'is not available on this device');
        }
    }

    const beforePower: JsonObject = requireProfileObject(before, 'odmPowerLimits');
    const draftPower: JsonObject = requireProfileObject(draft, 'odmPowerLimits');
    if (fieldChanged(beforePower, draftPower, 'tdpValues')) {
        await validateTdpCapabilities(draft, client);
    }

    const beforeNvidia: JsonObject = requireProfileObject(before, 'nvidiaPowerCTRLProfile');
    const draftNvidia: JsonObject = requireProfileObject(draft, 'nvidiaPowerCTRLProfile');
    if (fieldChanged(beforeNvidia, draftNvidia, 'cTGPOffset') || settings.has('nvidia-power-offset')) {
        await validateNvidiaOffset(draft, client);
    }
}
