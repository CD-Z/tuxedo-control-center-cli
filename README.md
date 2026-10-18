# TUXEDO Control Center

The TUXEDO Control Center (short: TCC) gives TUXEDO laptop users full control over their hardware like CPU cores, fan speed and more. \
To get a more detailed description of features, plans and the ideas behind please check our press release ([english](https://www.tuxedocomputers.com/en/Infos/News/Everything-under-control-with-the-TUXEDO-Control-Center.tuxedo) | [german](https://www.tuxedocomputers.com/de/Infos/News/Alles-unter-Kontrolle-mit-dem-TUXEDO-Control-Center_1.tuxedo)) and info pages ([english](https://www.tuxedocomputers.com/en/TUXEDO-Control-Center.tuxedo#) | [german](https://www.tuxedocomputers.com/de/TUXEDO-Control-Center.tuxedo)).

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

## Existing installation

This guide is for systems that already have the official TUXEDO Control Center, its running `tccd` daemon, and the TUXEDO DKMS drivers installed. Keep those packages in place. This repository adds a separately built CLI; it does not replace or rebuild the installed GUI, daemon, or drivers.

## Build the CLI

This checkout requires Node.js 24 or newer, npm, and Git. Your existing official packages provide the hardware drivers, daemon, and system integration. The CLI build does not need libudev headers, Python, or native compilation tools.

```sh
git clone https://github.com/CD-Z/tuxedo-control-center-cli.git
cd tuxedo-control-center-cli
npm ci --ignore-scripts
npm run build-cli
npm run start-cli -- --help
```

`npm ci --ignore-scripts` skips the Electron install hook. `build-cli` compiles only the checkout CLI. It does not install anything under `/opt`, `/usr`, or `/etc`. Run these examples from this checkout as your normal user.

## Use the installed daemon

Check that the official daemon is active without changing its service state:

```sh
systemctl is-active tccd.service
```

The following read-only CLI commands use the installed daemon. Every non-help command requires a reachable daemon. If it is not running, use the official package's service troubleshooting rather than starting, restarting, or reinstalling services from this guide. `status` reports the installed daemon's version, not a daemon built by this checkout.

```sh
npm run start-cli -- status
npm run start-cli -- profiles list
npm run start-cli -- profiles current
npm run start-cli -- profiles show "<profile-id-or-name>"
npm run start-cli -- profiles --help
```

Use IDs or names from your profile list. The placeholder text is not a literal profile ID. Exact IDs take precedence over names; names must match uniquely and are case-sensitive.

**The next commands can change hardware settings or write saved profiles.** Use the installed GUI if you want to change saved AC or battery assignments. `profiles activate` selects a profile temporarily and does not change those saved assignments. Built-in profiles are read-only. Creating a profile makes a custom clone and does not activate it.

```sh
npm run start-cli -- profiles activate "<profile-id-or-name>"
npm run start-cli -- profiles create "Work profile" --base "<base-profile-id>"
npm run start-cli -- profiles edit "<custom-profile-id>" --description "Updated description"
npm run start-cli -- profiles create --help
npm run start-cli -- profiles edit --help
```

Profile creation and editing read `/etc/tcc/profiles` and replace the full saved profile list through the installed official `tccd --new_profiles` helper using Polkit. These writes may cause the daemon to reapply hardware settings. They require readable saved profiles, the helper at its fixed installed path (`/opt/tuxedo-control-center/resources/dist/tuxedo-control-center/data/service/tccd`), and an available authentication agent. Run the CLI without `sudo`, and use only one GUI or CLI configuration writer at a time. If a write fails, use the official package's troubleshooting rather than editing system files or changing their permissions.

## Power Profiles support

The branch can provide the standard Power Profiles interface from `tccd`. It is optional and requires the provider-enabled daemon and system integration described in the [Power Profiles guide](POWER_PROFILES.md).

The guide covers building and installing the daemon, enabling the provider, and using the `ppd` CLI. The CLI-only workflow above does not install or activate this provider.

## Compatibility with official packages

This guidance is scoped to upstream baseline `00560d6da2ae7bc9b6c2f3fec9ca07dc5cd50395`, not every future official release. The profile and status workflows above use interfaces and helper support present in that baseline, but they have not been live-tested against every released package.

This branch's optional Power Profiles provider needs daemon changes that are absent from that baseline. Installing this CLI, drivers, or provider policy files cannot add that daemon support. DKMS is external to this repository and is not modified here. Keep the installed official GUI, daemon, and drivers for this workflow. See [Power Profiles guide](POWER_PROFILES.md) for the separate opt-in daemon replacement procedure and provider diagnostics. Do not use `ppd enable`, `ppd configure`, or `ppd disable` against baseline `00560d6da2ae7bc9b6c2f3fec9ca07dc5cd50395`; accepting settings does not add provider implementation.

Command exit status is 0 for command or help success, 2 for syntax errors, and 1 for validation, connection, authentication, or execution failures. Use leaf-command help for syntax. For daemon failures, inspect `/var/log/tccd/log`. A package version number alone does not establish that a newer daemon or provider is present.

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
