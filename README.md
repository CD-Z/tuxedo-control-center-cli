# TUXEDO Control Center

The TUXEDO Control Center (short: TCC) gives TUXEDO laptop users full control over their hardware like CPU cores, fan speed and more. \
To get a more detailed description of features, plans and the ideas behind please check our press release ([english](https://www.tuxedocomputers.com/en/Infos/News/Everything-under-control-with-the-TUXEDO-Control-Center.tuxedo) | [german](https://www.tuxedocomputers.com/de/Infos/News/Alles-unter-Kontrolle-mit-dem-TUXEDO-Control-Center_1.tuxedo)) and info pages ([english](https://www.tuxedocomputers.com/en/TUXEDO-Control-Center.tuxedo#) | [german](https://www.tuxedocomputers.com/de/TUXEDO-Control-Center.tuxedo)).

## Using it

Prebuilt packages are available through the TUXEDO repositories. See the [repository setup instructions](https://www.tuxedocomputers.com/en/Add-TUXEDO-software-package-sources.tuxedo).

Some hardware controls, such as fan control, need TUXEDO driver support. The Arch headless package lists `tuxedo-drivers-dkms` as an optional dependency.

## Project structure

```
tuxedo-control-center
|  README.md
|--src
|  |--ng-app            Angular GUI (aka electron renderer)
|  |--e-app             Electron main
|  |--service-app       Daemon part (Node 24)
|  |--cli-app           Command-line client
|  |--common            Common shared sources
|  |  |--classes
|  |  |--models
|  |--dist-data         Data needed for packaging
|--build-src            Source used for building
```

## Production use

### Runtime and build requirements

The headless daemon targets Linux x86_64. A source build needs Node.js 24 or newer, npm, native C/C++ build tools, Python, and libudev development headers. `rpm` is only relevant when building RPM packages, not when running TCC.

The Arch headless package lists `nodejs>=24`, `glibc`, `gcc-libs`, `systemd-libs`, `libxcrypt-compat`, `python`, `dbus`, `polkit`, `upower`, and `systemd` as runtime dependencies. Use the equivalent packages for your distribution. TUXEDO hardware support through `tuxedo-io` is optional and is supplied by `tuxedo-drivers-dkms`.

### Headless daemon and CLI

From the repository root, install JavaScript dependencies and build the headless artifacts:

```sh
npm ci --ignore-scripts
npm run build-headless
```

The `--ignore-scripts` option skips npm's Electron setup hook. The headless build still compiles the native module. Its only patch is Electron-specific. The build does not run Electron or Angular. It writes the daemon to `dist/tuxedo-control-center/data/service/tccd` and the bundled CLI to `dist/tuxedo-control-center/data/cli/tcc-cli.cjs`.

The build scripts that include `clean`, including `build-headless`, `build-prod`, and `build-debug`, remove generated `dist`, `build`, and `usr` directories before building. Do not keep generated files you need in those directories.

#### Manual installation

The following installs the headless build from the checkout. Run it from the repository root. Do not use this route to overwrite files owned by an installed TCC package. Choose one owner for these paths.

```sh
runtime=/opt/tuxedo-control-center/resources/dist/tuxedo-control-center/data

sudo install -Dm755 dist/tuxedo-control-center/data/service/tccd "$runtime/service/tccd"
sudo install -Dm755 dist/tuxedo-control-center/data/cli/tcc-cli.cjs "$runtime/cli/tcc-cli.cjs"
sudo install -Dm755 packaging/arch/tcc-cli /usr/bin/tcc-cli
sudo install -Dm755 src/cameractrls/cameractrls.py "$runtime/camera/cameractrls.py"
sudo install -Dm644 src/cameractrls/v4l2_kernel_names.json "$runtime/camera/v4l2_kernel_names.json"
sudo install -Dm644 src/dist-data/tccd.service /usr/lib/systemd/system/tccd.service
sudo install -Dm644 src/dist-data/tccd-sleep.service /usr/lib/systemd/system/tccd-sleep.service
sudo install -Dm644 src/dist-data/com.tuxedocomputers.tccd.conf /usr/share/dbus-1/system.d/com.tuxedocomputers.tccd.conf
sudo install -Dm644 src/dist-data/com.tuxedocomputers.tccd.policy /usr/share/polkit-1/actions/com.tuxedocomputers.tccd.policy
sudo install -Dm644 src/udev/99-webcam.rules /usr/lib/udev/rules.d/99-webcam.rules

sudo udevadm control --reload-rules
sudo systemctl daemon-reload
sudo systemctl enable tccd-sleep.service
sudo systemctl enable --now tccd.service

systemctl is-active tccd.service
tcc-cli status
tcc-cli --help
```

The service file and the installed Polkit helper annotation use the fixed daemon path under `/opt/tuxedo-control-center`. Keep the daemon at that path. Reloading udev rules does not trigger devices. Avoid a broad `udevadm trigger`, which can affect unrelated devices. The service controls real hardware, so use it only on a system where you are ready for TCC settings to take effect.

The Arch PKGBUILD defines the split packages `tuxedo-control-center-cli` and `tuxedo-control-center-cli-ppd`. Its source entry expects a local, versioned `tuxedo-control-center-cli-${pkgver}.tar.gz` archive with a top-level directory named `tuxedo-control-center-cli-${pkgver}`. The PKGBUILD does not describe a universal package installation command.

### Optional GUI build and packages

To build and launch the GUI from a checkout, use the regular npm install:

```sh
npm ci
npm run build-prod
npm run start
```

To make distribution packages, use `npm run pack-prod -- deb`, `npm run pack-prod -- rpm`, or `npm run pack-prod -- all`. Artifacts go to `dist/packages`. Install the selected artifact with your distribution's package manager. The installed GUI command is `tuxedo-control-center`, and the GUI package hooks manage `tccd`.

The full GUI build does not build or install `tcc-cli`. Its package hooks do not install the optional Power Profiles D-Bus and Polkit files described below. Do not assume those files are present after a GUI or manual core installation.

### CLI

All commands except help require a reachable, compatible, running `tccd`, including `ppd status`. The checkout CLI can connect to an installed daemon:

```sh
npm run build-cli
npm run start-cli -- --help
npm run start-cli -- status
npm run start-cli -- profiles list
npm run start-cli -- profiles current
npm run start-cli -- profiles show "<profile-id-or-name>"
npm run start-cli -- profiles create "Work profile" --base "<base-profile-id>"
npm run start-cli -- profiles edit "<custom-profile-id>" --description "Updated description"
npm run start-cli -- profiles activate "<profile-id-or-name>"
npm run start-cli -- ppd status
```

Profile selectors accept an exact TCC profile ID or a unique, case-sensitive name. An exact ID takes precedence when it also matches a name. `profiles activate` selects a profile temporarily. It does not change saved AC or battery assignments, and a daemon restart, power-state change, or changed mapping can clear the selection. A profile change can apply hardware settings and may require authorization.

Run the CLI as your normal user, not with `sudo`. The CLI uses the installed helper and Polkit for saved writes. Profile creation and editing write `/etc/tcc/profiles`; Power Profiles configuration writes `/etc/tcc/settings`. Each write replaces a complete file or settings snapshot, so do not save through the GUI and CLI at the same time. A write can require administrator authentication and may cause the daemon to apply settings to hardware.

Commands exit with 0 on success or help, 2 for syntax errors, and 1 for validation, connection, authorization, or execution failures.

### Power Profiles integration

TCC can provide the modern `org.freedesktop.UPower.PowerProfiles` D-Bus name at `/org/freedesktop/UPower/PowerProfiles`. It is disabled by default. `tcc-cli ppd enable` saves the setting and starts the optional provider inside an already running `tccd`; it does not start the systemd service. `tcc-cli ppd disable` withdraws TCC's provider but leaves `tccd` running.

Only one provider can own this D-Bus name at a time. The Arch optional package `tuxedo-control-center-cli-ppd` conflicts with `power-profiles-daemon`, `tlp-pd`, `tuned-ppd`, and `tuxedo-power-profiles-adapter-git`. Do not stop, mask, uninstall, or replace another provider automatically. Choose the provider through your distribution's package and service management first.

The optional package supplies three provider files. A manual install must install them explicitly:

```sh
sudo install -Dm644 src/dist-data/org.freedesktop.UPower.PowerProfiles.service /usr/share/dbus-1/system-services/org.freedesktop.UPower.PowerProfiles.service
sudo install -Dm644 src/dist-data/org.freedesktop.UPower.PowerProfiles.conf /usr/share/dbus-1/system.d/org.freedesktop.UPower.PowerProfiles.conf
sudo install -Dm644 src/dist-data/org.freedesktop.UPower.PowerProfiles.policy /usr/share/polkit-1/actions/org.freedesktop.UPower.PowerProfiles.policy
sudo busctl call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig
```

The activation file targets `tccd.service`; it does not launch the standalone `power-profiles-daemon` executable. Reload D-Bus configuration with the call above after installing the policy. Do not restart the system bus.

Start with `tcc-cli profiles list` and use profile IDs that exist on your device. This modern-device example maps two standard profiles, omits performance, and deliberately changes the saved AC assignment to balanced and the battery assignment to power-saver:

```sh
tcc-cli ppd enable --power-saver __profile_max_energy_save__ --balanced __office__ --performance none --ac balanced --battery power-saver
tcc-cli ppd status
```

Mappings store TCC profile IDs, not profile names. The CLI accepts an exact ID or a unique, case-sensitive name when selecting a mapping. Use the ID if a profile is named `default` or `none`, because those words have special meanings in mapping options.

Unspecified mapping options preserve their saved overrides. `default` removes an override and uses the device default. `none` is allowed only for `--performance` and stores `performance: null`. Power-saver and balanced mappings are required; performance is optional. Modern defaults use `__profile_max_energy_save__` for power-saver, `__office__` for balanced, and `__high_performance__` for performance when that profile exists. Legacy defaults use `__legacy_powersave_extreme__` for power-saver and `__legacy_default__` for balanced. A requested override must name an existing profile, and the mapped TCC IDs must be distinct.

Assignments are separate from mappings. Unless `--ac` or `--battery` is supplied, those saved assignments stay unchanged. Enabling is rejected if either saved assignment is not mapped. `ppd enable` without options is accepted only when the stored mappings and assignments already meet the validation rules. This matters because a fresh TCC settings file can assign a custom profile by default. Supply the assignments you want as part of the same `enable` command rather than relying on an implicit remap.

For example, replace power-saver with a custom profile ID, keep balanced on the device's office profile, restore the performance default, and explicitly set both assignments:

```sh
tcc-cli ppd configure --power-saver "<custom-profile-id>" --balanced __office__ --performance default --ac balanced --battery power-saver
```

`configure` preserves the current enabled state. Use `--performance default` to remove a saved performance override. A settings change is one full settings replacement, may require Polkit authentication through the installed helper, and may apply hardware settings or invalidate holds. Use one GUI or CLI settings writer at a time.

A retained temporary TCC profile selection outside the new mappings can make the daemon reject a settings replacement. TCC does not clear that selection automatically. Activate the intended mapped TCC profile with `tcc-cli profiles activate "<profile-id>"`, then retry the configuration.

Here is an illustrative fragment to merge into the full `/etc/tcc/settings` JSON. It is not a replacement settings file. Prefer the authorized CLI over hand-editing:

```json
{
  "ppd": {
    "enabled": true,
    "profiles": {
      "power-saver": "__profile_max_energy_save__",
      "balanced": "__office__",
      "performance": null
    }
  },
  "stateMap": {
    "power_ac": "__office__",
    "power_bat": "__profile_max_energy_save__"
  }
}
```

The IDs in this example are distinct, and both saved assignments refer to mapped IDs. `profiles activate` is a temporary TCC selection. Setting standard `ActiveProfile` through the Power Profiles interface instead changes the saved assignment for the current power state. Profile holds can override the effective selection. A hold belongs to its D-Bus connection and clears when that connection disconnects, or when TCC stops or suspends.

TCC does not bundle `powerprofilesctl`, the legacy power-profiles-daemon bus name, BatteryAware, or action drivers. Use `busctl` as an external client. A standard profile change may require Polkit authentication and can apply hardware settings. This call changes the saved assignment for the current power state:

```sh
busctl --system call org.freedesktop.UPower.PowerProfiles /org/freedesktop/UPower/PowerProfiles org.freedesktop.UPower.PowerProfiles SetActiveProfile s balanced
```

To inspect the standard interface without changing it, run:

```sh
busctl --system get-property org.freedesktop.UPower.PowerProfiles /org/freedesktop/UPower/PowerProfiles org.freedesktop.UPower.PowerProfiles ActiveProfile
tcc-cli ppd status
```


`tcc-cli ppd status` distinguishes configured enablement from runtime ownership. `Enabled: yes` with `Provider: inactive` or `Provider: other-provider` means TCC has not acquired the standard name. Another provider's `ActiveProfile` value is not proof that TCC owns the provider. If a write saves settings but the provider remains inactive or another provider owns the name, the settings remain saved. Check that the optional provider policies are installed, choose a provider without displacing one automatically, and inspect `/var/log/tccd/log`. `tcc-cli ppd disable` is the recovery command; it disables TCC's provider without stopping `tccd` or restarting D-Bus.

### Development setup

Install the build prerequisites above, then clone the repository and install dependencies:

```sh
git clone https://github.com/tuxedocomputers/tuxedo-control-center
cd tuxedo-control-center
npm ci
npm run build-debug
npm run start
```

`build-debug` builds the daemon, Electron app, and Angular app. Do not start a second daemon alongside an installed `tccd`; use the compatible installed service or follow the [headless installation procedure](#headless-daemon-and-cli). The build scripts clean generated output directories before building.

### NPM scripts

Run scripts with `npm run <script-name>`.

| Script | Description |
| --- | --- |
| `build-release` | Build and package a release version |
| `pack-prod -- deb` | Build and package the release `.deb` |
| `pack-prod -- rpm` | Build and package the release RPM |
| `pack-prod -- all` | Build and package both release targets |
| `pack-debug -- all\|deb\|rpm` | Build and package debug targets |
| `build-prod` | Build the production service, Electron app, and Angular app |
| `build-debug` | Build the debug service, Electron app, and Angular app |
| `build-headless` | Build the daemon and CLI bundle, including the native module, without Electron or Angular |
| `build-cli` | Compile the checkout CLI |
| `esbuild-cli` | Bundle the compiled CLI for installation |
| `start-cli -- <args>` | Run the checkout CLI against a compatible daemon |
| `start` | Launch the built Electron app |
| `start-watch` | Build and watch the Angular and Electron development targets |
| `tests` | Run the configured common, service, CLI, and AppStream tests |

### Debugging

Debugging of the Electron main and renderer processes is configured for VS Code in `.vscode/launch.json`.

## Screenshots
### English

<img src="screenshots/en/Systemmonitor_TCC.png" alt="Systemmonitor">
<img src="screenshots/en/DarkTheme_TCC.png" alt="Dark Theme">

<img src="screenshots/en/Tools_TCC.png" alt="Tools">

<img src="screenshots/en/Mains_Battery_TCC.png" alt="">

<img src="screenshots/en/Profiles_TCC.png" alt="Profiles">

<img src="screenshots/en/Profile_Settings_TCC.png" alt="Profile Settings">

<img src="screenshots/en/ControlCenter_TCC.png" alt="About">

### German
<img src="screenshots/de/Systemmonitor_TCC.png" alt="Systemmonitor">

<img src="screenshots/de/DarkTheme_TCC.png" alt="Dark Theme">

<img src="screenshots/de/Tools_TCC.png" alt="Tools">

<img src="screenshots/de/Akku_Netz_TCC.png" alt="">

<img src="screenshots/de/Profile_TCC.png" alt="Profile">

<img src="screenshots/de/Profil_Einstellungen_TCC.png" alt="Profil Einstellungen">

<img src="screenshots/de/ControlCenter_TCC.png" alt="">
