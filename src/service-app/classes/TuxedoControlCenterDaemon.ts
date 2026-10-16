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

import { E_ALREADY_LOCKED, Mutex, tryAcquire } from "async-mutex";
import { SIGTERM } from "node:constants";
import * as os from "node:os";
import * as dbus from "dbus-next";
import * as fs from "node:fs";
import { AvailabilityService } from "../../common/classes/availability.service";
import { determineState } from "../../common/classes/StateUtils";
import { ConfigHandler } from "../../common/classes/ConfigHandler";
import { CpuController } from "../../common/classes/CpuController";
import { DMIController } from "../../common/classes/DMIController";
import { ScalingDriver } from "../../common/classes/LogicalCpuController";
import { TccPaths } from "../../common/classes/TccPaths";
import {
	defaultCustomProfile,
	TUXEDODevice,
} from "../../common/models/DefaultProfiles";
import {
	customFanPreset,
	type ITccFanProfile,
} from "../../common/models/TccFanTable";
import {
	FrequencyConfig,
	generateProfileId,
	type ITccProfile,
} from "../../common/models/TccProfile";
import {
	type ITccSettings,
	ProfileStates,
} from "../../common/models/TccSettings";
import { PowerProfilesConfig } from "../../common/classes/PowerProfilesConfig";
import type { WebcamPreset } from "../../common/models/TccWebcamSettings";
import {
	ModuleInfo,
	type TDPInfo,
	TuxedoIOAPI,
} from "../../native-lib/TuxedoIOAPI";
import { ChargingWorker } from "./ChargingWorker";
import { CpuPowerWorker } from "./CpuPowerWorker";
import { CpuWorker } from "./CpuWorker";
import type { DaemonWorker } from "./DaemonWorker";
import { DisplayBacklightWorker } from "./DisplayBacklightWorker";
import { DisplayRefreshRateWorker } from "./DisplayRefreshRateWorker";
import { FanControlWorker } from "./FanControlWorker";
import { GpuInfoWorker } from "./GpuInfoWorker";
import { KeyboardBacklightListener } from "./KeyboardBacklightListener";
import { NVIDIAPowerCTRLListener } from "./NVIDIAPowerCTRLListener";
import { ODMPowerLimitWorker } from "./ODMPowerLimitWorker";
import { ODMProfileWorker } from "./ODMProfileWorker";
import { PrimeWorker } from "./PrimeWorker";
import { SingleProcess } from "./SingleProcess";
import { StateSwitcherWorker } from "./StateSwitcherWorker";
import { ProfileSelection } from "./ProfileSelection";
import { TccDBusData } from "./TccDBusInterface";
import { TccDBusService } from "./TccDBusService";
import { WebcamWorker } from "./WebcamWorker";
import { TCC_INTERFACE, TCC_NAME, TCC_PATH } from "./PowerProfilesService";
import { YCbCr420WorkaroundWorker } from "./YCbCr420WorkaroundWorker";

const tccPackage: any = require("../../package.json");

export class TuxedoControlCenterDaemon extends SingleProcess {
	static readonly CMD_RESTART_SERVICE: string =
		"systemctl restart tccd.service";
	static readonly CMD_START_SERVICE: string = "systemctl start tccd.service";
	static readonly CMD_STOP_SERVICE: string = "systemctl stop tccd.service";

	public config: ConfigHandler;

	public settings: ITccSettings;
	public customProfiles: ITccProfile[];
	public fanTables: ITccFanProfile[];

	public dbusData: TccDBusData = new TccDBusData();

	public activeProfile: ITccProfile;

	private workers: DaemonWorker[] = [];
	private profileMutex: Mutex = new Mutex();
	private profileSelection: ProfileSelection;
	private listeners: (KeyboardBacklightListener | NVIDIAPowerCTRLListener)[] =
		[];

	protected started: boolean = false;

	private stateWorker: StateSwitcherWorker;
	private chargingWorker: ChargingWorker;
	private displayWorker: DisplayRefreshRateWorker;
	private configurationReloadRejected: boolean = false;
	private tccDBusService?: TccDBusService;

	constructor() {
		super(TccPaths.PID_FILE);
		this.config = new ConfigHandler(
			TccPaths.SETTINGS_FILE,
			TccPaths.PROFILES_FILE,
			TccPaths.WEBCAM_FILE,
			TccPaths.V4L2_NAMES_FILE,
			TccPaths.FANTABLES_FILE,
		);
	}

	async main(): Promise<void> {
		if (process.argv.includes("--version")) {
			this.logLine(
				`TUXEDO Control Center v${tccPackage.version} node: ${process.version} arch:${os.arch()}`,
			);
			process.exit();
		}

		// Only allow to continue if root
		if (process.geteuid() !== 0) {
			throw Error("Not root, bye");
		}

		// Check arguments, start, stop, restart config files etc..
		// todo: do error handling inside catchError
		await this.handleArgumentProgramFlow().catch(
			async (err: unknown): Promise<void> =>
				await this.catchError(err as Error),
		);

		this.displayWorker = new DisplayRefreshRateWorker(this);
		this.loadConfigsAndProfiles();
		await this.setupSignalHandling();

		this.dbusData.tccdVersion = tccPackage.version;
		this.stateWorker = new StateSwitcherWorker(this);
		this.chargingWorker = new ChargingWorker(this);
		this.workers.push(this.chargingWorker);
		this.workers.push(this.stateWorker);
		this.workers.push(new DisplayBacklightWorker(this));
		this.workers.push(new CpuWorker(this));
		this.workers.push(new WebcamWorker(this));
		this.workers.push(new FanControlWorker(this, this.identifyDevice()));
		this.workers.push(new YCbCr420WorkaroundWorker(this));
		this.workers.push(new GpuInfoWorker(this, new AvailabilityService()));
		this.workers.push(new CpuPowerWorker(this));
		this.workers.push(new PrimeWorker(this));
		this.tccDBusService = new TccDBusService(this, this.dbusData);
		this.workers.push(this.tccDBusService);
		this.workers.push(new ODMProfileWorker(this));
		this.workers.push(new ODMPowerLimitWorker(this));
		this.workers.push(this.displayWorker); // todo: why not "new DisplayRefreshRateWorker(this)"?

		this.listeners.push(new KeyboardBacklightListener(this));
		this.listeners.push(new NVIDIAPowerCTRLListener(this));
		await this.initializeProfileSelection();

		await this.startWorkers();

		this.started = true;
		this.logLine("TuxedoControlCenterDaemon: Daemon started");

		// Start continuous work for each worker with individual interval
		for (const worker of this.workers) {
			worker.timer = setInterval(async (): Promise<void> => {
				try {
					if (this.isProfileEffector(worker) || worker === this.displayWorker) {
						await tryAcquire(this.profileMutex).runExclusive(
							async (): Promise<void> => {
								await worker.work();
							},
						);
					} else {
						await worker.work();
					}
				} catch (err: unknown) {
					if (err === E_ALREADY_LOCKED) {
						return;
					}
					console.error(
						`TuxedoControlCenterDaemon: Failed executing onWork() of ${worker.name} => ${err}`,
					);
				}
			}, worker.timeout);
		}
	}

	public async startWorkers(): Promise<void> {
		for (const worker of this.workers) {
			if (this.isProfileEffector(worker)) {
				continue;
			}
			try {
				worker.updateProfile(this.getCurrentProfile());
				await worker.start();
			} catch (err: unknown) {
				console.error(
					`TuxedoControlCenterDaemon: Failed executing onStart => ${err}`,
				);
			}
		}
	}
	private async initializeProfileSelection(): Promise<void> {
		const device = this.identifyDevice();
		const builtInIds = new Set(
			this.config.getDefaultProfiles(device).map((profile) => profile.id),
		);
		this.profileSelection = new ProfileSelection({
			catalog: (customProfiles) =>
				this.config.getDefaultProfiles(device).concat(customProfiles),
			resolveMappings: (settings, catalog) =>
				PowerProfilesConfig.resolve(
					settings,
					catalog.filter((profile) => !builtInIds.has(profile.id)),
					device,
					this.config,
				),
			powerSource: determineState,
			applyProfile: (profile) => this.applyProfileWithinTransition(profile),
			persistSettings: async (settings) => {
				await this.config.writeSettingsAsync(settings);
				this.settings = settings;
				this.dbusData.settingsJSON = JSON.stringify(settings);
			},
			publishProfile: (profile) => {
				this.activeProfile = profile;
				this.updateDBusActiveProfileData();
				this.tccDBusService?.notifyPowerProfilesPropertiesChanged();
			},
			notifyProfileReleased: (owner, cookie) => {
				this.tccDBusService?.emitProfileReleased(owner, cookie);
			},
			onWithdraw: async ({ operation, cause, rollbackError }) => {
				this.logLine(
					`Power profile provider withdrawn after ${operation}: ${String(cause)}${rollbackError === undefined ? "" : `; rollback: ${String(rollbackError)}`}`,
				);
				await this.refreshPowerProfilesProvider();
			},
			mutex: this.profileMutex,
		});
		try {
			await this.profileSelection.reload(this.settings, this.customProfiles);
		} catch (err: unknown) {
			this.logLine(
				`Initial profile application failed; provider remains unavailable: ${String(err)}`,
			);
		}
	}
	private isProfileEffector(worker: DaemonWorker): boolean {
		return (
			worker instanceof DisplayBacklightWorker ||
			worker instanceof CpuWorker ||
			worker instanceof WebcamWorker ||
			worker instanceof FanControlWorker ||
			worker instanceof ODMProfileWorker ||
			worker instanceof ODMPowerLimitWorker
		);
	}

	public async triggerStateCheck(reset: boolean = false): Promise<void> {
		if (this.stateWorker === undefined) {
			return;
		}
		if (reset) {
			this.stateWorker.reapplyProfile();
		}
		await this.stateWorker.work();
	}
	public async selectTccProfile(
		id: string,
		persistence: "temporary" | "current-power-state",
	): Promise<void> {
		if (this.profileSelection === undefined) {
			const profile = this.getProfileById(id);
			if (profile === undefined) {
				throw new Error(`Unknown TCC profile ID '${id}'`);
			}
			await this.applyProfile(profile);
			return;
		}
		await this.profileSelection.selectTccProfile(id, persistence);
	}
	public async selectTccProfileByName(name: string): Promise<void> {
		const matches = this.getAllProfiles().filter(
			(profile) => profile.name === name,
		);
		if (matches.length !== 1) {
			throw new Error(`TCC profile name '${name}' is missing or ambiguous`);
		}
		await this.selectTccProfile(matches[0].id, "temporary");
	}

	public async powerStateChanged(
		state: ProfileStates,
		assignmentChanged: boolean = false,
	): Promise<void> {
		if (this.profileSelection === undefined) {
			return;
		}
		if (assignmentChanged) {
			await this.profileSelection.reload(this.settings, this.customProfiles);
		} else {
			await this.profileSelection.powerStateChanged(state);
		}
	}
	public async reapplyProfile(): Promise<void> {
		if (this.profileSelection !== undefined) {
			await this.profileSelection.reload(this.settings, this.customProfiles);
		} else if (this.activeProfile !== undefined) {
			await this.applyProfile(this.activeProfile);
		}
	}

	public getChargingWorker(): ChargingWorker {
		return this.chargingWorker;
	}

	public getProfileSelection(): ProfileSelection {
		if (this.profileSelection === undefined) {
			throw new Error("Profile selection has not been initialized");
		}
		return this.profileSelection;
	}

	public async replaceProfileConfiguration(
		settingsJSON: string,
		profilesJSON: string,
	): Promise<boolean> {
		if (this.profileSelection === undefined) {
			return false;
		}
		if (settingsJSON === "" && profilesJSON === "") {
			return true;
		}

		let candidateSettings: ITccSettings | undefined;
		let candidateProfiles: ITccProfile[] | undefined;
		try {
			if (settingsJSON !== "") {
				candidateSettings = JSON.parse(settingsJSON) as ITccSettings;
				if (
					candidateSettings === null ||
					typeof candidateSettings !== "object" ||
					Array.isArray(candidateSettings)
				) {
					return false;
				}
			}
			if (profilesJSON !== "") {
				const parsedProfiles = JSON.parse(profilesJSON) as ITccProfile[];
				if (!Array.isArray(parsedProfiles)) {
					return false;
				}
				candidateProfiles = parsedProfiles.map(
					this.fillDeviceSpecificDefaults,
					this,
				);
			}
		} catch (err: unknown) {
			this.logLine(`Rejected D-Bus configuration replacement: ${String(err)}`);
			return false;
		}

		try {
			await this.profileSelection.updateConfiguration(
				candidateSettings,
				candidateProfiles,
				async (settings, profiles): Promise<void> => {
					await this.config.writeSettingsAndProfilesAsync(
						settingsJSON === "" ? undefined : settings,
						profilesJSON === "" ? undefined : profiles,
					);
					this.settings = settings;
					this.customProfiles = profiles;
					this.configurationReloadRejected = false;
					this.dbusData.settingsJSON = JSON.stringify(settings);
					this.dbusData.customProfilesJSON = JSON.stringify(profiles);
					const defaults = this.config
						.getDefaultProfiles(this.identifyDevice())
						.map(this.fillDeviceSpecificDefaults, this);
					this.dbusData.defaultProfilesJSON = JSON.stringify(defaults);
					this.dbusData.profilesJSON = JSON.stringify(
						defaults.concat(profiles),
					);
				},
			);
			return true;
		} catch (err: unknown) {
			this.logLine(`Configuration replacement failed: ${String(err)}`);
			return false;
		}
	}

	public async refreshPowerProfilesProvider(): Promise<void> {
		await this.tccDBusService?.refreshPowerProfilesProvider();
	}

	public async catchError(err: Error): Promise<void> {
		this.logLine("Tccd Exception");
		const errorLine: string = `${err.name}: ${err.message}`;
		this.logLine(errorLine);
		if (err.stack !== undefined) {
			this.logLine(err.stack);
		}
		if (this.started) {
			await this.onExit();
		}
		process.exit();
	}

	public async onExit(): Promise<void> {
		for (const worker of this.workers) {
			clearInterval(worker.timer);
		}

		for (const worker of this.workers) {
			try {
				await worker.exit();
			} catch (err: unknown) {
				console.error(
					`TuxedoControlCenterDaemon: Failed executing onExit() => ${err}`,
				);
			}
		}
	}

	private async handleArgumentProgramFlow(): Promise<void> {
		if (process.argv.includes("--start")) {
			// Start daemon as this process
			if (!(await this.start())) {
				throw Error("Couldn't start daemon. It is probably already running");
			} else {
				this.logLine(
					`Starting daemon v${tccPackage.version} (node: ${process.version} arch: ${os.arch()})`,
				);
				const modInfo = new ModuleInfo();
				if (TuxedoIOAPI.wmiAvailable()) {
					TuxedoIOAPI.getModuleInfo(modInfo);
					this.logLine(
						`tuxedo-io ver ${modInfo.version} [ interface: ${modInfo.activeInterface} ]`,
					);
				}
			}
		} else if (process.argv.includes("--stop")) {
			// Signal running process to stop
			this.logLine("Stopping daemon..");
			if (await this.stop()) {
				this.logLine("Daemon is stopped");
				process.exit(0);
			} else {
				throw Error("Failed to stop daemon");
			}
		} else if (
			process.argv.includes("--new_settings") ||
			process.argv.includes("--new_profiles") ||
			process.argv.includes("--new_webcam")
		) {
			const settingsPath = this.getPathArgument("--new_settings");
			const profilesPath = this.getPathArgument("--new_profiles");
			if (settingsPath !== "" || profilesPath !== "") {
				const forwarded = await this.forwardConfigurationToRunningDaemon(
					settingsPath,
					profilesPath,
				);
				if (!forwarded) {
					const configPair = await this.saveNewConfigurationPair(
						this.identifyDevice(),
					);
					if (!configPair.accepted) {
						process.exit(1);
					}
				}
			}
			const webcamSaved = this.saveNewConfig<WebcamPreset[]>(
				"--new_webcam",
				this.config.pathWebcam,
				this.config.webcamFileMod,
			);

			if (webcamSaved) {
				const pidNumber = this.readPid();
				if (!Number.isNaN(pidNumber)) {
					process.kill(pidNumber, "SIGHUP");
				}
			}
			process.exit(0);
		} else {
			throw Error("No argument specified");
		}
	}

	public loadConfigsAndProfiles(): boolean {
		const dev: TUXEDODevice = this.identifyDevice();
		this.dbusData.device = JSON.stringify(dev);
		const aq: boolean = this.deviceHasAquaris(dev);
		this.dbusData.deviceHasAquaris = aq;
		this.dbusData.isUnsupportedConfigurableTGPDevice =
			this.getIsUnsupportedConfigurableTGPDevice();

		let stagedSettings: ITccSettings | undefined;
		let stagedProfiles: ITccProfile[] | undefined;
		let canPersistConfigChanges: boolean = true;
		try {
			const candidate = this.readPowerProfilesCandidate(dev);
			stagedSettings = candidate?.settings;
			stagedProfiles = candidate?.profiles;
		} catch (err: unknown) {
			this.configurationReloadRejected = true;
			this.logLine(
				`Power-profiles-daemon configuration rejected: ${String(err)}`,
			);
			if (this.settings !== undefined) {
				return false;
			}

			// Keep an invalid first-start candidate on disk and use safe TCC defaults
			// in memory until the administrator fixes it.
			this.settings = this.config.getDefaultSettings(dev);
			this.customProfiles = this.config.getDefaultCustomProfiles(dev);
			canPersistConfigChanges = false;
		}
		if (canPersistConfigChanges) {
			this.configurationReloadRejected = false;
			if (stagedSettings?.ppd?.enabled && stagedProfiles !== undefined) {
				this.config.writeProfiles(stagedProfiles);
			}
			this.readOrCreateConfigurationFiles(dev, stagedSettings, stagedProfiles);
		}
		// Fill exported profile lists (for GUI)
		const defaultProfilesFilled: ITccProfile[] = this.config
			.getDefaultProfiles(dev)
			.map(this.fillDeviceSpecificDefaults, this);
		let customProfilesFilled: ITccProfile[] = this.customProfiles.map(
			this.fillDeviceSpecificDefaults,
			this,
		);

		const defaultValuesProfileFilled: ITccProfile =
			this.fillDeviceSpecificDefaults(
				JSON.parse(JSON.stringify(defaultCustomProfile)),
			);

		// Make sure assigned states and assigned profiles exist, otherwise fill with defaults
		let settingsChanged: boolean = false;
		let needsTuxedoDefault: boolean = false;
		for (const stateId of this.settings.ppd?.enabled
			? []
			: Object.keys(ProfileStates)) {
			const stateDescriptor: ProfileStates = ProfileStates[stateId];
			if (
				!Object.hasOwn(this.settings.stateMap, stateDescriptor) ||
				defaultProfilesFilled
					.concat(customProfilesFilled)
					.find(
						(p: ITccProfile): boolean =>
							p.id === this.settings.stateMap[stateDescriptor],
					) === undefined
			) {
				// Attempt to find by name
				const profileByName: ITccProfile = defaultProfilesFilled
					.concat(customProfilesFilled)
					.find(
						(p: ITccProfile): boolean =>
							p.name === this.settings.stateMap[stateDescriptor],
					);
				if (profileByName !== undefined) {
					console.log(
						`TuxedoControlCenterDaemon: Missing state id assignment for '${stateId}' but found profile by name '${profileByName.name}'`,
					);
					this.settings.stateMap[stateDescriptor] = profileByName.id;
				} else {
					// Otherwise default to default values profile
					console.log(
						`TuxedoControlCenterDaemon: Missing state id assignment for '${stateId}' default to '${defaultValuesProfileFilled.id}'`,
					);
					this.settings.stateMap[stateDescriptor] =
						defaultValuesProfileFilled.id;
					needsTuxedoDefault = true;
				}
				settingsChanged = true;
			}
		}
		if (settingsChanged) {
			// Add default values profile if not existing
			if (needsTuxedoDefault) {
				if (
					customProfilesFilled.find(
						(p: ITccProfile): boolean => p.id === defaultValuesProfileFilled.id,
					) === undefined
				) {
					customProfilesFilled = [defaultValuesProfileFilled].concat(
						customProfilesFilled,
					);
					this.customProfiles = customProfilesFilled;
					if (canPersistConfigChanges) {
						this.config.writeProfiles(this.customProfiles);
						console.log(
							`TuxedoControlCenterDaemon: Added '${defaultValuesProfileFilled.name}' to profiles`,
						);
					}
				}
			}

			// Write updated settings
			if (canPersistConfigChanges) {
				this.config.writeSettings(this.settings);
				console.log("TuxedoControlCenterDaemon: Saved updated settings");
			}
		}

		const allProfilesFilled: ITccProfile[] =
			defaultProfilesFilled.concat(customProfilesFilled);
		this.dbusData.profilesJSON = JSON.stringify(allProfilesFilled);
		this.dbusData.defaultProfilesJSON = JSON.stringify(defaultProfilesFilled);
		this.dbusData.customProfilesJSON = JSON.stringify(customProfilesFilled);
		this.dbusData.defaultValuesProfileJSON = JSON.stringify(
			defaultValuesProfileFilled,
		);
		this.dbusData.settingsJSON = JSON.stringify(this.settings);

		// Initialize or update active profile
		if (this.getCurrentProfile() === undefined) {
			// Fallback
			this.activeProfile = this.getDefaultProfile();
		} else {
			const activeProfileId: string = this.activeProfile.id;
			const activeProfileName: string = this.activeProfile.name;
			let foundSameProfile: boolean =
				this.setCurrentProfileById(activeProfileId);
			if (!foundSameProfile) {
				console.log(
					`TuxedoControlCenterDaemon: loadConfigsAndProfiles: profile by id not found: ${activeProfileId}`,
				);
				foundSameProfile = this.setCurrentProfileByName(activeProfileName);
			}
			if (!foundSameProfile) {
				console.log(
					`TuxedoControlCenterDaemon: loadConfigsAndProfiles: profile by name not found: ${activeProfileName}`,
				);
				// Fallback
				this.activeProfile = this.getDefaultProfile();
			}
		}
		return true;
	}

	private syncOutputPortsSetting(): boolean {
		let missingSetting: boolean = false;

		const outputPorts: string[][] = TuxedoIOAPI.getOutputPorts();
		// Delete additional cards from settings
		if (this.settings.ycbcr420Workaround?.length > outputPorts?.length) {
			this.logLine(
				`TuxedoControlCenterDaemon: Additional ycbcr420Workaround card in settings (${this.settings.ycbcr420Workaround?.length} > ${outputPorts?.length})`,
			);
			this.settings.ycbcr420Workaround = this.settings.ycbcr420Workaround.slice(
				0,
				outputPorts?.length,
			);
			missingSetting = true;
		}
		for (let card: number = 0; card < outputPorts?.length; card++) {
			// Add card to settings if missing
			if (this.settings.ycbcr420Workaround?.length <= card) {
				this.logLine(
					`TuxedoControlCenterDaemon: Missing ycbcr420Workaround card "${card}" in settings`,
				);
				this.settings.ycbcr420Workaround[card] = {};
				missingSetting = true;
			}
			// Delete additional ports from settings
			if (this.settings.ycbcr420Workaround[card] !== undefined) {
				for (const settingsPort in this.settings.ycbcr420Workaround[card]) {
					let stillAvailable: boolean = false;
					for (const port of outputPorts[card]) {
						if (settingsPort === port) {
							stillAvailable = true;
						}
					}
					if (!stillAvailable) {
						this.logLine(
							`TuxedoControlCenterDaemon: Additional ycbcr420Workaround port "${settingsPort}" with card "${card}" in settings`,
						);
						delete this.settings.ycbcr420Workaround[card][settingsPort];
						missingSetting = true;
					}
				}
			}
			// Add port to settings if missing
			if (outputPorts[card] !== undefined) {
				for (const port of outputPorts[card]) {
					if (this.settings.ycbcr420Workaround[card][port] === undefined) {
						this.logLine(
							`TuxedoControlCenterDaemon: Missing ycbcr420Workaround port "${port}" with card "${card}" in settings`,
						);
						this.settings.ycbcr420Workaround[card][port] = false;
						missingSetting = true;
					}
				}
			}
		}

		return missingSetting;
	}

	private readPowerProfilesCandidate(
		device: TUXEDODevice,
	): { settings: ITccSettings; profiles?: ITccProfile[] } | undefined {
		let settings: ITccSettings;
		try {
			settings = this.config.readSettings();
		} catch (err: unknown) {
			if (this.settings?.ppd?.enabled) {
				throw new Error(
					`Could not read settings candidate '${this.config.pathSettings}': ${String(err)}`,
				);
			}
			return undefined;
		}
		if (!settings.ppd?.enabled) {
			return { settings };
		}

		const profiles = this.config.readProfiles(
			device,
			this.config.pathProfiles,
			false,
		);
		PowerProfilesConfig.resolve(settings, profiles, device, this.config);
		return { settings, profiles };
	}

	private readOrCreateConfigurationFiles(
		device: TUXEDODevice,
		settingsCandidate?: ITccSettings,
		profilesCandidate?: ITccProfile[],
	): void {
		try {
			this.settings = settingsCandidate ?? this.config.readSettings();
			let missingSetting: boolean = false;

			// If settings are missing, attempt to recreate default
			// TODO purge settings no longer in ITccSettings
			if (this.settings.stateMap === undefined) {
				this.logLine("TuxedoControlCenterDaemon: Missing statemap");
				this.settings.stateMap =
					this.config.getDefaultSettings(device).stateMap;
				missingSetting = true;
			}
			if (this.settings.cpuSettingsEnabled === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing cpuSettingsEnabled setting",
				);
				this.settings.cpuSettingsEnabled =
					this.config.getDefaultSettings(device).cpuSettingsEnabled;
				missingSetting = true;
			}
			if (this.settings.fanControlEnabled === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing fanControlEnabled setting",
				);
				this.settings.fanControlEnabled =
					this.config.getDefaultSettings(device).fanControlEnabled;
				missingSetting = true;
			}
			if (this.settings.keyboardBacklightControlEnabled === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing keyboardBacklightControlEnabled setting",
				);
				this.settings.keyboardBacklightControlEnabled =
					this.config.getDefaultSettings(
						device,
					).keyboardBacklightControlEnabled;
				missingSetting = true;
			}
			if (this.settings.ycbcr420Workaround === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing ycbcr420Workaround setting",
				);
				this.settings.ycbcr420Workaround =
					this.config.getDefaultSettings(device).ycbcr420Workaround;
				missingSetting = true;
			}
			if (this.settings.chargingProfile === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing chargingProfile setting",
				);
				this.settings.chargingProfile =
					this.config.getDefaultSettings(device).chargingProfile;
				missingSetting = true;
			}
			if (this.settings.chargingPriority === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing chargingPriority setting",
				);
				this.settings.chargingPriority =
					this.config.getDefaultSettings(device).chargingPriority;
				missingSetting = true;
			}
			if (this.settings.keyboardBacklightStates === undefined) {
				this.logLine(
					"TuxedoControlCenterDaemon: Missing keyboardBacklightStates setting",
				);
				this.settings.keyboardBacklightStates =
					this.config.getDefaultSettings(device).keyboardBacklightStates;
				missingSetting = true;
			}
			missingSetting = this.syncOutputPortsSetting();

			if (missingSetting) {
				throw Error("TuxedoControlCenterDaemon: Missing setting");
			}
		} catch {
			// No settings available, create default settings
			try {
				if (this.settings === undefined) {
					this.settings = this.config.getDefaultSettings(device);
					this.syncOutputPortsSetting();
				}
				this.config.writeSettings(this.settings);
				this.logLine(
					`TuxedoControlCenterDaemon: Filled missing settings with default: "${this.config.pathSettings}"`,
				);
			} catch (err: unknown) {
				console.error(
					`TuxedoControlCenterDaemon: Failed to fill missing settings with default: ${this.config.pathSettings} => ${err}`,
				);
			}
		}

		if (profilesCandidate !== undefined) {
			this.customProfiles = profilesCandidate;
		} else {
			try {
				this.customProfiles = this.config.readProfiles(
					device,
					this.config.pathProfiles,
					!this.settings?.ppd?.enabled,
				);
			} catch {
				this.customProfiles = this.config.getDefaultCustomProfiles(device);
				if (!this.settings?.ppd?.enabled) {
					try {
						this.config.writeProfiles(this.customProfiles);
						this.logLine(
							`TuxedoControlCenterDaemon: Wrote default profiles: ${this.config.pathProfiles}`,
						);
					} catch (err: unknown) {
						console.error(
							`TuxedoControlCenterDaemon: Failed to write default profiles: ${this.config.pathProfiles} => ${err}`,
						);
					}
				}
			}
		}
	}

	private async setupSignalHandling(): Promise<void> {
		// Setup signal catching/handling
		// SIGINT is the normal exit signal that the service gets from itself
		process.on("SIGINT", async (): Promise<never> => {
			this.logLine("SIGINT - Exiting");
			await this.onExit();
			process.exit(0);
		});

		// Also stop on SIGTERM
		process.on("SIGTERM", async (): Promise<never> => {
			this.logLine("SIGTERM - Exiting");
			await this.onExit();
			process.exit(SIGTERM);
		});

		process.on("SIGHUP", async (): Promise<void> => {
			this.logLine("Reload configs");
			const previousSettings = this.config.copyConfig(this.settings);
			const previousProfiles = this.config.copyConfig(this.customProfiles);
			let accepted = false;
			try {
				await this.profileMutex.runExclusive(async (): Promise<void> => {
					if (!this.loadConfigsAndProfiles()) {
						return;
					}
					try {
						await this.profileSelection.reloadWithinTransition(
							this.settings,
							this.customProfiles,
						);
						accepted = true;
					} catch (error: unknown) {
						this.settings = previousSettings;
						this.customProfiles = previousProfiles;
						this.config.writeSettings(previousSettings);
						this.config.writeProfiles(previousProfiles);
						this.dbusData.settingsJSON = JSON.stringify(previousSettings);
						this.dbusData.customProfilesJSON = JSON.stringify(previousProfiles);
						this.dbusData.profilesJSON = JSON.stringify(
							this.config
								.getDefaultProfiles(this.identifyDevice())
								.concat(previousProfiles),
						);
						this.logLine(
							`Configuration reload was rolled back: ${String(error)}`,
						);
					}
				});
				if (accepted) {
					await this.refreshPowerProfilesProvider();
					await this.triggerStateCheck();
				}
			} catch (error: unknown) {
				this.logLine(`Configuration reload failed: ${String(error)}`);
			}
		});
	}

	private getIsUnsupportedConfigurableTGPDevice(): boolean {
		// Configurable TGP (cTGP) settings are not available for the IBP series
		// nvidia-smi tells otherwise, but they don't offically support it and using it results in undefined behaviour
		const dmi = new DMIController("/sys/class/dmi/id");
		const deviceName: string = dmi.productSKU.readValueNT();

		const unsupportedDevices: string[] = [
			"IBP14I06",
			"IBP1XI07MK1",
			"IBP1XI07MK2",
			"IBP1XI08MK1",
			"IBP14I08MK2",
			"IBP16I08MK2",
			"IBP14A09MK1 / IBP15A09MK1",
		]; // todo: check devices

		return unsupportedDevices.includes(deviceName);
	}

	private deviceHasAquaris(dev: TUXEDODevice): boolean {
		const dmi = new DMIController("/sys/class/dmi/id");
		const boardVendor: string = dmi.boardVendor.readValueNT();
		const chassisVendor: string = dmi.chassisVendor.readValueNT();
		const sysVendor: string = dmi.sysVendor.readValueNT();
		let showAquarisMenu: boolean;

		const isTuxedo: boolean =
			boardVendor?.toLowerCase().includes("tuxedo") ||
			chassisVendor?.toLowerCase().includes("tuxedo") ||
			sysVendor?.toLowerCase().includes("tuxedo");

		const aquarisDevices: TUXEDODevice[] = [
			TUXEDODevice.STELLARIS1XI04,
			TUXEDODevice.STEPOL1XA04,
			TUXEDODevice.STELLARIS1XI05,
			TUXEDODevice.STELLARIS16I06,
			TUXEDODevice.STELLARIS17I06,
			TUXEDODevice.STELLARIS16A07,
			TUXEDODevice.STELLARIS16I07,
			TUXEDODevice.STELLARIS16I08_IPS,
			TUXEDODevice.STELLARIS16I08_MLED,
			TUXEDODevice.STELLARIS16I08_OLED,
		];

		if (isTuxedo) {
			if (aquarisDevices.includes(dev)) {
				showAquarisMenu = true;
			} else {
				showAquarisMenu = false;
			}
		} else {
			showAquarisMenu = true;
		}
		return showAquarisMenu;
	}

	public identifyDevice(): TUXEDODevice {
		const dmi = new DMIController("/sys/class/dmi/id");
		const productSKU: string = dmi.productSKU.readValueNT();
		const modInfo = new ModuleInfo();
		TuxedoIOAPI.getModuleInfo(modInfo);

		const dmiSKUDeviceMap = new Map<string, TUXEDODevice>();
		dmiSKUDeviceMap.set("IBS1706", TUXEDODevice.IBP17G6);
		dmiSKUDeviceMap.set("IBP1XI08MK1", TUXEDODevice.IBPG8);
		dmiSKUDeviceMap.set("IBP1XI08MK2", TUXEDODevice.IBPG8);
		dmiSKUDeviceMap.set("IBP14I08MK2", TUXEDODevice.IBPG8);
		dmiSKUDeviceMap.set("IBP16I08MK2", TUXEDODevice.IBPG8);
		dmiSKUDeviceMap.set("OMNIA08IMK2", TUXEDODevice.IBPG8);
		dmiSKUDeviceMap.set("IBP14A10MK1 / IBP15A10MK1", TUXEDODevice.IBPG10AMD);
		dmiSKUDeviceMap.set("IIBP14A10MK1 / IBP15A10MK1", TUXEDODevice.IBPG10AMD);
		dmiSKUDeviceMap.set("IBP15I10MK1", TUXEDODevice.IBPG10INTEL);
		dmiSKUDeviceMap.set("IBM15A10", TUXEDODevice.IBM15A10);
		dmiSKUDeviceMap.set("IBM15I10", TUXEDODevice.IBM15I10);
		dmiSKUDeviceMap.set("IBM16A10", TUXEDODevice.IBM16A10);
		dmiSKUDeviceMap.set("POLARIS1XA02", TUXEDODevice.POLARIS1XA02);
		dmiSKUDeviceMap.set("POLARIS1XI02", TUXEDODevice.POLARIS1XI02);
		dmiSKUDeviceMap.set("POLARIS1XA03", TUXEDODevice.POLARIS1XA03);
		dmiSKUDeviceMap.set("POLARIS1XI03", TUXEDODevice.POLARIS1XI03);
		dmiSKUDeviceMap.set("STELLARIS1XA03", TUXEDODevice.STELLARIS1XA03);
		dmiSKUDeviceMap.set("STEPOL1XA04", TUXEDODevice.STEPOL1XA04);
		dmiSKUDeviceMap.set("STELLARIS1XI03", TUXEDODevice.STELLARIS1XI03);
		dmiSKUDeviceMap.set("STELLARIS1XI04", TUXEDODevice.STELLARIS1XI04);
		dmiSKUDeviceMap.set("PULSE1501", TUXEDODevice.PULSE1501);
		dmiSKUDeviceMap.set("PULSE1502", TUXEDODevice.PULSE1502);
		dmiSKUDeviceMap.set("PULSE1403", TUXEDODevice.PULSE1403);
		dmiSKUDeviceMap.set("PULSE1404", TUXEDODevice.PULSE1404);
		dmiSKUDeviceMap.set("STELLARIS1XI05", TUXEDODevice.STELLARIS1XI05);
		dmiSKUDeviceMap.set("POLARIS1XA05", TUXEDODevice.POLARIS1XA05);
		dmiSKUDeviceMap.set("STELLARIS1XA05", TUXEDODevice.STELLARIS1XA05);
		dmiSKUDeviceMap.set("STELLARIS16I06", TUXEDODevice.STELLARIS16I06);
		dmiSKUDeviceMap.set("STELLARIS17I06", TUXEDODevice.STELLARIS17I06);
		dmiSKUDeviceMap.set("STELLARIS16G8I-IPS", TUXEDODevice.STELLARIS16I08_IPS);
		dmiSKUDeviceMap.set(
			"STELLARIS16G8I-MLED",
			TUXEDODevice.STELLARIS16I08_MLED,
		);
		dmiSKUDeviceMap.set(
			"STELLARIS16G8I-OLED",
			TUXEDODevice.STELLARIS16I08_OLED,
		);
		dmiSKUDeviceMap.set("STELLSL15A06", TUXEDODevice.STELLSL15A06);
		dmiSKUDeviceMap.set("STELLSL15I06", TUXEDODevice.STELLSL15I06);
		dmiSKUDeviceMap.set("AURA14GEN3", TUXEDODevice.AURA14G3);
		dmiSKUDeviceMap.set("AURA15GEN3", TUXEDODevice.AURA15G3);
		dmiSKUDeviceMap.set("STELLARIS16A07", TUXEDODevice.STELLARIS16A07);
		dmiSKUDeviceMap.set("STELLARIS16I07", TUXEDODevice.STELLARIS16I07);
		dmiSKUDeviceMap.set("SIRIUS1601", TUXEDODevice.SIRIUS1601);
		dmiSKUDeviceMap.set("SIRIUS1602", TUXEDODevice.SIRIUS1602);
		dmiSKUDeviceMap.set("GEMINI17I04", TUXEDODevice.GEMINI17I04);
		dmiSKUDeviceMap.set("GEMINIGEN4I", TUXEDODevice.GEMINI17I04);
		dmiSKUDeviceMap.set("BA1510", TUXEDODevice.BA1510);

		const skuMatch: TUXEDODevice = dmiSKUDeviceMap.get(productSKU);

		if (skuMatch !== undefined) {
			return skuMatch;
		}

		const uwidDeviceMap = new Map<number, TUXEDODevice>();
		uwidDeviceMap.set(0x13, TUXEDODevice.IBP14G6_TUX);
		uwidDeviceMap.set(0x12, TUXEDODevice.IBP14G6_TRX);
		uwidDeviceMap.set(0x14, TUXEDODevice.IBP14G6_TQF);
		uwidDeviceMap.set(0x17, TUXEDODevice.IBP14G7_AQF_ARX);

		const uwidMatch: TUXEDODevice = uwidDeviceMap.get(
			Number.parseInt(modInfo.model, 10),
		);
		if (uwidMatch !== undefined) {
			return uwidMatch;
		}

		return TUXEDODevice.UNKNOWN;
	}

	private getDefaultProfile(): ITccProfile {
		// TODO, good reason why this is called all over again? just buffer variable, it doesn't change?
		const dev: TUXEDODevice = this.identifyDevice();
		return this.config.getDefaultProfiles(dev)[0];
	}

	private getAllProfiles(): ITccProfile[] {
		const dev: TUXEDODevice = this.identifyDevice();
		return this.config.getDefaultProfiles(dev).concat(this.customProfiles);
	}

	public getCurrentProfile(): ITccProfile {
		return this.activeProfile;
	}
	public getProfileById(id: string): ITccProfile | undefined {
		return this.getAllProfiles().find(
			(profile: ITccProfile): boolean => profile.id === id,
		);
	}
	public getProfileByName(name: string): ITccProfile | undefined {
		return this.getAllProfiles().find(
			(profile: ITccProfile): boolean => profile.name === name,
		);
	}

	public async applyProfile(profile: ITccProfile): Promise<void> {
		await this.profileMutex.runExclusive(async (): Promise<void> => {
			const previous = this.activeProfile;
			try {
				await this.applyProfileWithinTransition(profile);
				this.updateDBusActiveProfileData();
			} catch (applyError: unknown) {
				if (previous === undefined) {
					throw applyError;
				}
				try {
					await this.applyProfileWithinTransition(previous);
				} catch (rollbackError: unknown) {
					throw new Error(
						`Profile application and rollback failed: ${String(applyError)}; ${String(rollbackError)}`,
					);
				}
				throw applyError;
			}
		});
	}

	public async applyProfileWithinTransition(
		profile: ITccProfile,
	): Promise<void> {
		const previous = this.activeProfile;
		this.activeProfile = profile;
		try {
			await this.applyProfileEffectors(profile);
			for (const listener of this.listeners) {
				listener.onActiveProfileChanged(profile);
			}
		} catch (applyError: unknown) {
			this.activeProfile = previous;
			throw applyError;
		}
	}

	public async withCommittedProfile(
		operation: (profile: ITccProfile) => void,
	): Promise<void> {
		await this.profileMutex.runExclusive(async (): Promise<void> => {
			const profile = this.activeProfile;
			if (profile !== undefined) {
				operation(profile);
			}
		});
	}
	private async applyProfileEffectors(profile: ITccProfile): Promise<void> {
		for (const worker of this.workers) {
			if (this.isProfileEffector(worker)) {
				worker.updateProfile(profile);
				await worker.start();
			}
		}
	}

	public setCurrentProfileByName(profileName: string): boolean {
		this.activeProfile = this.getAllProfiles().find(
			(profile: ITccProfile): boolean => profile.name === profileName,
		);
		let result: boolean = true;
		if (this.activeProfile === undefined) {
			this.activeProfile = this.getDefaultProfile();
			result = false;
		}
		return result;
	}

	public setCurrentProfileById(id: string): boolean {
		this.activeProfile = this.getAllProfiles().find(
			(profile: ITccProfile): boolean => profile.id === id,
		);
		let result: boolean = true;
		if (this.activeProfile === undefined) {
			this.activeProfile = this.getDefaultProfile();
			result = false;
		}
		return result;
	}

	public getCurrentFanProfile(chosenProfile?: ITccProfile): ITccFanProfile {
		if (chosenProfile === undefined) {
			chosenProfile = this.getCurrentProfile();
		}
		// If no fanprofile is set in tcc profile, use fallback
		if (
			chosenProfile.fan === undefined ||
			chosenProfile.fan.fanProfile === undefined
		) {
			return this.getFallbackFanProfile();
		}

		// Attempt to find fan profile from tcc profile
		let chosenFanProfile: ITccFanProfile = this.config
			.getDefaultFanProfiles()
			.find(
				(fanProfile: ITccFanProfile): boolean =>
					fanProfile.name === chosenProfile.fan.fanProfile,
			);

		if (chosenFanProfile === undefined) {
			chosenFanProfile = this.getFallbackFanProfile();
		}

		return chosenFanProfile;
	}

	private getFallbackFanProfile(): ITccFanProfile {
		// Fallback to 'Balanced'
		let chosenFanProfile: ITccFanProfile = this.config
			.getDefaultFanProfiles()
			.find(
				(fanProfile: ITccProfile): boolean => fanProfile.name === "Balanced",
			);
		// Fallback to first in list
		if (chosenFanProfile === undefined) {
			chosenFanProfile = this.config.getDefaultFanProfiles()[0];
		}
		return chosenFanProfile;
	}

	public updateDBusActiveProfileData(): void {
		this.dbusData.activeProfileJSON = JSON.stringify(
			this.fillDeviceSpecificDefaults(this.getCurrentProfile()),
		);
	}

	// todo: function too long, could be splitted with cpu, display, webcam, fan, odm subfunctions
	private fillDeviceSpecificDefaults(inputProfile: ITccProfile): ITccProfile {
		const profile: ITccProfile = JSON.parse(JSON.stringify(inputProfile));
		const dev: TUXEDODevice = this.identifyDevice();

		if (profile.id === undefined) {
			profile.id = generateProfileId();
			console.log(
				`TuxedoControlCenterDaemon: fillDeviceSpecificDefaults: Generated id (${profile.id}) for ${profile.name}`,
			);
		}

		if (profile.description === "undefined") {
			profile.description = "";
		}

		const cpu: CpuController = new CpuController("/sys/devices/system/cpu");
		if (profile.cpu.onlineCores === undefined) {
			profile.cpu.onlineCores = cpu.cores?.length;
		}

		if (profile.cpu.useMaxPerfGov === undefined) {
			profile.cpu.useMaxPerfGov = false;
		}

		// Min and max range considering all cores
		// Takes into consideration that different cores can have different ranges
		let cpuInfoMinFreq = cpu.cores[0].cpuinfoMinFreq.readValueNT();
		let cpuInfoMaxFreq = cpu.cores[0].cpuinfoMaxFreq.readValueNT();

		for (const core of cpu.cores) {
			const coreMinFreq = core.cpuinfoMinFreq.readValueNT();
			const coreMaxFreq = core.cpuinfoMaxFreq.readValueNT();
			if (coreMinFreq !== undefined && coreMinFreq < cpuInfoMinFreq) {
				cpuInfoMinFreq = coreMinFreq;
			}
			if (coreMaxFreq !== undefined && coreMaxFreq > cpuInfoMaxFreq) {
				cpuInfoMaxFreq = coreMaxFreq;
			}
		}

		const minFreq = cpuInfoMinFreq;

		if (
			profile.cpu.scalingMinFrequency === undefined ||
			profile.cpu.scalingMinFrequency < minFreq
		) {
			profile.cpu.scalingMinFrequency = minFreq;
		}

		const scalingAvailableFrequencies =
			cpu.cores[0].scalingAvailableFrequencies.readValueNT();
		const scalingdriver = cpu.cores[0].scalingDriver.readValueNT();
		let maxFreq =
			scalingAvailableFrequencies !== undefined
				? scalingAvailableFrequencies[0]
				: cpuInfoMaxFreq;

		if (
			scalingdriver === ScalingDriver.intel_pstate &&
			dev === TUXEDODevice.GEMINI17I04
		) {
			// Workaround for not being able to activate turbo boost for profile generation
			maxFreq = 5800000;
		}
		const boost = cpu.boost.readValueNT();
		if (boost !== undefined && scalingdriver === ScalingDriver.acpi_cpufreq) {
			maxFreq += 1000000;
		}

		let reducedAvailableFreq: number;
		if (scalingdriver === ScalingDriver.acpi_cpufreq) {
			// Boost dependent reduced freq only for acpi_cpufreq
			reducedAvailableFreq =
				boost === undefined
					? cpu.cores[0].getReducedAvailableFreqNT()
					: cpuInfoMaxFreq;
		} else {
			reducedAvailableFreq = cpu.cores[0].getReducedAvailableFreqNT();
		}

		// Handle defaults
		if (profile.cpu.scalingMaxFrequency === undefined) {
			profile.cpu.scalingMaxFrequency = maxFreq;
		} else if (
			profile.cpu.scalingMaxFrequency === FrequencyConfig.ReducedFrequency
		) {
			profile.cpu.scalingMaxFrequency = reducedAvailableFreq;
		}
		// Enforce boundaries
		if (profile.cpu.scalingMaxFrequency < profile.cpu.scalingMinFrequency) {
			profile.cpu.scalingMaxFrequency = profile.cpu.scalingMinFrequency;
		} else if (profile.cpu.scalingMaxFrequency > maxFreq) {
			profile.cpu.scalingMaxFrequency = maxFreq;
		}

		if (profile.cpu.governor === undefined) {
			profile.cpu.governor = defaultCustomProfile.cpu.governor;
		}

		if (profile.cpu.energyPerformancePreference === undefined) {
			profile.cpu.energyPerformancePreference =
				defaultCustomProfile.cpu.energyPerformancePreference;
		}

		if (profile.cpu.noTurbo === undefined) {
			profile.cpu.noTurbo = defaultCustomProfile.cpu.noTurbo;
		}

		if (profile.display.useRefRate === undefined) {
			profile.display.useRefRate = false;
		}
		if (profile.display.useResolution === undefined) {
			profile.display.useResolution = false;
		}

		if (profile.display.refreshRate === undefined) {
			profile.display.refreshRate = -1;
		}
		if (profile.display.xResolution === undefined) {
			profile.display.xResolution = -1;
		}
		if (profile.display.yResolution === undefined) {
			profile.display.yResolution = -1;
		}

		if (profile.webcam === undefined) {
			profile.webcam = {
				useStatus: false,
				status: true,
			};
		}

		if (profile.webcam.useStatus === undefined) {
			profile.webcam.useStatus = false;
		}

		if (profile.webcam.status === undefined) {
			profile.webcam.status = true;
		}

		if (profile.fan === undefined) {
			profile.fan = {
				useControl: true,
				fanProfile: "Balanced",
				minimumFanspeed: 0,
				maximumFanspeed: 100,
				offsetFanspeed: 0,
				customFanCurve: customFanPreset,
			};
		} else {
			profile.fan.useControl = true;
			if (profile.fan.minimumFanspeed === undefined) {
				profile.fan.minimumFanspeed = 0;
			}
			if (profile.fan.maximumFanspeed === undefined) {
				profile.fan.maximumFanspeed = 100;
			}
			if (profile.fan.offsetFanspeed === undefined) {
				profile.fan.offsetFanspeed = 0;
			}
			if (profile.fan.customFanCurve === undefined) {
				profile.fan.customFanCurve = customFanPreset;
			}
		}

		const defaultODMProfileName: string =
			ODMProfileWorker.getDefaultODMPerformanceProfile(dev);
		const availableODMProfiles: string[] =
			ODMProfileWorker.getAvailableODMPerformanceProfiles(dev);
		if (
			profile.odmProfile === undefined ||
			!availableODMProfiles.includes(profile.odmProfile.name)
		) {
			profile.odmProfile = {
				name: defaultODMProfileName,
			};
		}

		if (profile.odmProfile.name === undefined) {
			profile.odmProfile.name = defaultODMProfileName;
		}

		const tdpInfo: TDPInfo[] = [];
		TuxedoIOAPI.getTDPInfo(tdpInfo);
		if (
			profile.odmPowerLimits === undefined ||
			profile.odmPowerLimits.tdpValues === undefined
		) {
			profile.odmPowerLimits = { tdpValues: [] };
		}

		const nrMissingValues: number =
			tdpInfo?.length - profile.odmPowerLimits.tdpValues?.length;
		if (nrMissingValues > 0) {
			profile.odmPowerLimits.tdpValues =
				profile.odmPowerLimits.tdpValues.concat(
					tdpInfo.slice(-nrMissingValues).map((e: TDPInfo): number => e.max),
				);
		}

		if (profile.nvidiaPowerCTRLProfile === undefined) {
			profile.nvidiaPowerCTRLProfile = { cTGPOffset: 0 };
		}

		if (profile.nvidiaPowerCTRLProfile.cTGPOffset === undefined) {
			profile.nvidiaPowerCTRLProfile.cTGPOffset = 0;
		}

		return profile;
	}

	private async forwardConfigurationToRunningDaemon(
		settingsPath: string,
		profilesPath: string,
	): Promise<boolean> {
		const bus = dbus.systemBus();
		try {
			const owner = await bus.call(
				new dbus.Message({
					destination: "org.freedesktop.DBus",
					path: "/org/freedesktop/DBus",
					interface: "org.freedesktop.DBus",
					member: "GetNameOwner",
					signature: "s",
					body: [TCC_NAME],
				}),
			);
			if (
				owner?.type === dbus.MessageType.ERROR &&
				owner.errorName === "org.freedesktop.DBus.Error.NameHasNoOwner"
			) {
				return false;
			}
			if (
				owner?.type !== dbus.MessageType.METHOD_RETURN ||
				owner.signature !== "s"
			) {
				throw new Error("Could not determine whether tccd owns its D-Bus name");
			}

			const settingsJSON =
				settingsPath === "" ? "" : fs.readFileSync(settingsPath, "utf8");
			const profilesJSON =
				profilesPath === "" ? "" : fs.readFileSync(profilesPath, "utf8");
			const reply = await bus.call(
				new dbus.Message({
					destination: TCC_NAME,
					path: TCC_PATH,
					interface: TCC_INTERFACE,
					member: "ReplaceProfileConfiguration",
					signature: "ss",
					body: [settingsJSON, profilesJSON],
				}),
			);
			if (
				reply?.type !== dbus.MessageType.METHOD_RETURN ||
				reply.signature !== "b" ||
				reply.body[0] !== true
			) {
				throw new Error(
					"The running daemon rejected the configuration replacement",
				);
			}
			return true;
		} finally {
			bus.disconnect();
		}
	}

	private async saveNewConfigurationPair(device: TUXEDODevice): Promise<{
		accepted: boolean;
		settingsSaved: boolean;
		profilesSaved: boolean;
	}> {
		const settingsPath = this.getPathArgument("--new_settings");
		const profilesPath = this.getPathArgument("--new_profiles");
		if (settingsPath === "" && profilesPath === "") {
			return { accepted: true, settingsSaved: false, profilesSaved: false };
		}

		let settingsCandidate: ITccSettings | undefined;
		let profilesCandidate: ITccProfile[] | undefined;
		try {
			if (settingsPath !== "") {
				settingsCandidate = this.config.readSettings(settingsPath);
			}
			if (profilesPath !== "") {
				profilesCandidate = this.config.readConfig<ITccProfile[]>(profilesPath);
			}

			let currentSettings = settingsCandidate;
			if (currentSettings === undefined) {
				try {
					currentSettings = this.config.readSettings();
				} catch {
					// No existing settings file means there is no enabled PPD config.
				}
			}
			if (currentSettings?.ppd?.enabled) {
				const candidateProfiles = this.config.readProfiles(
					device,
					profilesPath !== "" ? profilesPath : this.config.pathProfiles,
					false,
				);
				PowerProfilesConfig.resolve(
					currentSettings,
					candidateProfiles,
					device,
					this.config,
				);
				if (profilesPath !== "") {
					profilesCandidate = candidateProfiles;
				}
			}
		} catch (err: unknown) {
			console.error(
				`TuxedoControlCenterDaemon: Rejected configuration candidate => ${err}`,
			);
			return { accepted: false, settingsSaved: false, profilesSaved: false };
		}

		try {
			await this.config.writeSettingsAndProfilesAsync(
				settingsCandidate,
				profilesCandidate,
			);
		} catch (err: unknown) {
			console.error(
				`TuxedoControlCenterDaemon: Failed writing configuration candidate => ${err}`,
			);
			return { accepted: false, settingsSaved: false, profilesSaved: false };
		}

		return {
			accepted: true,
			settingsSaved: settingsCandidate !== undefined,
			profilesSaved: profilesCandidate !== undefined,
		};
	}

	/**
	 * Save config path from argument to the specified target location, basically copying the config.
	 *
	 * @param optionString      Command line option string that preced the source path
	 * @param targetConfigPath  Path to copy config to
	 * @param writeFileMode     Access rights for target file
	 *
	 * @returns True if file is correctly parsed and written, false otherwise
	 */
	private saveNewConfig<T>(
		optionString: string,
		targetConfigPath: string,
		writeFileMode: number,
	): boolean {
		const newConfigPath: string = this.getPathArgument(optionString);
		if (newConfigPath !== "") {
			try {
				const newConfig: T = this.config.readConfig<T>(newConfigPath);

				try {
					this.config.writeConfig<T>(newConfig, targetConfigPath, {
						mode: writeFileMode,
					});
				} catch (err: unknown) {
					console.error(
						`TuxedoControlCenterDaemon: Error on write option ${optionString} => ${err}`,
					);
					return false;
				}
			} catch (err: unknown) {
				console.error(
					`TuxedoControlCenterDaemon: Error on read option ${optionString}: with path ${newConfigPath} => ${err}`,
				);
				return false;
			}
			return true;
		} else {
			return false;
		}
	}

	public async updateSettings(
		mutator: (settings: ITccSettings) => void,
	): Promise<void> {
		await this.profileMutex.runExclusive(async (): Promise<void> => {
			if (this.configurationReloadRejected) {
				throw new Error(
					"Settings cannot be persisted until the rejected configuration is repaired",
				);
			}
			const candidate = JSON.parse(
				JSON.stringify(this.settings),
			) as ITccSettings;
			mutator(candidate);
			if (candidate.ppd?.enabled) {
				PowerProfilesConfig.resolve(
					candidate,
					this.customProfiles,
					this.identifyDevice(),
					this.config,
				);
			}
			const selection = this.profileSelection;
			if (selection?.isAvailable) {
				selection.validateSettingsUpdate(candidate);
			}
			await this.config.writeSettingsAsync(candidate);
			this.settings = candidate;
			if (selection?.isAvailable) {
				selection.commitSettingsUpdate(candidate);
			}
			this.dbusData.settingsJSON = JSON.stringify(candidate);
		});
	}

	/**
	 * Parse the command line arguments looking for a string and fetching the next argument
	 *
	 * @param optionString  Command line option string that preced the argument with
	 *                      the sought data
	 * @returns The argument following the argument matching optionString
	 */
	private getPathArgument(optionString: string): string {
		const newConfigIndex: number = process.argv.indexOf(optionString);
		const lastIndex: number = process.argv?.length - 1;
		// If option is set and there is an argument after the option
		if (newConfigIndex !== -1 && newConfigIndex + 1 <= lastIndex) {
			const newConfigPath: string = process.argv[newConfigIndex + 1];
			newConfigPath.replace("'", "");
			return newConfigPath.trim();
		} else {
			return "";
		}
	}

	/**
	 * Basic logging functionality
	 *
	 * @param text Text to log
	 */
	public logLine(text: string): void {
		console.log(text);
	}
}
