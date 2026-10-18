# Power Profiles support

[README](README.md)

This branch's `tccd` can provide the standard `org.freedesktop.UPower.PowerProfiles` interface. It maps `power-saver`, `balanced`, and optionally `performance` to TCC profiles. The provider runs inside this branch's daemon. It is not a bundled standalone `power-profiles-daemon`.

This is an opt-in, system-changing daemon setup, separate from the README's CLI-only workflow for systems that already use the official installation. Building the CLI or copying provider policies does not add provider implementation to an upstream baseline daemon.

## Build the daemon and CLI

Build on x86_64 Linux with Node.js 24, npm, Git, Python, a C/C++ compiler and `make`, and libudev headers and linker support. Live hardware use also requires the external TUXEDO drivers. DKMS is external to this repository and is not rebuilt here. See [`package.json`](package.json), [`binding.gyp`](binding.gyp), and the [Arch package recipe](packaging/arch/PKGBUILD) for the build configuration and packaging prerequisites.

**Warning:** `build-headless` deletes the generated `dist`, `build`, and `usr` directories. From the checkout root as your normal user, run:

```sh
npm ci --ignore-scripts
npm run build-headless
dist/tuxedo-control-center/data/service/tccd --version
```

The headless build compiles the native addon and bundles the daemon and CLI. It does not build the GUI. It produces `dist/tuxedo-control-center/data/service/tccd` and `dist/tuxedo-control-center/data/cli/tcc-cli.cjs`. The version command exits without starting daemon workers. These commands do not install or activate anything. The headless output alone is insufficient for PPD support. Install the provider policies separately using the package procedure below.

## Install on Arch Linux

This route uses the repository's included x86_64 [`packaging/arch/PKGBUILD`](packaging/arch/PKGBUILD). It builds two packages and replaces the official TCC package, including its GUI. The core package conflicts with `tuxedo-control-center`; the PPD package conflicts with `power-profiles-daemon`, `tlp-pd`, `tuned-ppd`, and `tuxedo-power-profiles-adapter-git`.

Review the package-manager transaction before accepting it. Keep access to your previous packages and back up existing `/etc/tcc` configuration before choosing this replacement workflow. Do not force file overwrites or remove competing packages blindly. This package route owns the installed system files instead of manually overwriting files from the official package.

From the checkout root, make an archive of committed `HEAD`. The version `3.0.10` must match `pkgver` in the linked recipe. `git archive` does not include uncommitted edits.

```sh
git archive --format=tar --prefix=tuxedo-control-center-cli-3.0.10/ HEAD \
  | gzip > packaging/arch/tuxedo-control-center-cli-3.0.10.tar.gz
cd packaging/arch
makepkg -si
```

Run `makepkg` as your normal user. It asks for elevation to install dependencies and packages. The recipe rebuilds from the archive rather than using a previous local build. Install both `tuxedo-control-center-cli` and `tuxedo-control-center-cli-ppd`. The recipe supplies the build and runtime dependency lists. At runtime, the system also needs a usable system bus, Polkit, and an authentication agent.

The packages install the daemon at `/opt/tuxedo-control-center/resources/dist/tuxedo-control-center/data/service/tccd` and the launcher at `/usr/bin/tcc-cli`. They also install `tccd.service`, `tccd-sleep.service`, and TCC's D-Bus and Polkit files. The PPD package installs `org.freedesktop.UPower.PowerProfiles.service` under `/usr/share/dbus-1/system-services`, its `.conf` under `/usr/share/dbus-1/system.d`, and its `.policy` under `/usr/share/polkit-1/actions`. See the recipe for the complete install manifest.

`npm run build-headless` is available independently, but this repository has no equivalent headless installer for other distributions. The full Electron package builder and a manual copy-over are not documented here as verified headless PPD installation routes.

## Start the daemon and enable the provider

Restarting this branch's root daemon and changing PPD settings can apply hardware settings. After both packages are installed, reload systemd and start the installed daemon:

```sh
sudo systemctl daemon-reload
sudo systemctl enable tccd.service tccd-sleep.service
sudo systemctl restart tccd.service
systemctl is-active tccd.service
```

The restart runs the installed daemon now, including when an older daemon was already running. `systemctl enable` is optional and only makes the units start at boot. `tccd-sleep.service` handles sleep and resume; it is not a second provider. The standard D-Bus activation entry targets `tccd.service`, so there is no separate provider-specific systemd service to start.

As a normal user, check profiles and provider status:

```sh
tcc-cli profiles list
tcc-cli ppd status
```

`active` means TCC owns the standard name and its active profile is readable. `inactive` means the name has no owner. `other-provider` means another provider owns it. If another provider owns the name, stop here and inspect the package and service situation. Do not stop or remove a competing provider as part of this procedure. `Enabled: yes` alone does not prove ownership or provider implementation.

**The next command replaces a full settings snapshot, may require authentication, can apply hardware settings, and changes saved AC/battery assignments.** Use actual, distinct profile IDs from `tcc-cli profiles list`; do not run the template unchanged:

```sh
tcc-cli ppd enable \
  --power-saver "<power-saver-profile-id>" \
  --balanced "<balanced-profile-id>" \
  --performance none --ac balanced --battery power-saver
tcc-cli ppd status
```

This example omits performance and assigns balanced on AC and power-saver on battery. Choose real mappings and desired assignments for your system. Power-saver and balanced mappings are required and all mapped profiles must be distinct. Performance is optional. Omitted assignments remain unchanged and must still refer to mapped profiles. Bare `ppd enable` works only if the existing mappings and assignments are valid. After successful acquisition, status should show `Enabled: yes` and `Provider: active`. The CLI does not start the service, repair assignments, or stop another provider.

## CLI reference

Run these help commands from the checkout root after building. They work offline. For the installed package, use `tcc-cli` in place of `npm run start-cli --`.

```sh
npm run start-cli -- ppd --help
npm run start-cli -- ppd status --help
npm run start-cli -- ppd enable --help
npm run start-cli -- ppd configure --help
npm run start-cli -- ppd disable --help
```

| Command | Behavior |
|---|---|
| `ppd status` | Read enablement, runtime ownership, assignments, and mappings. Requires a reachable daemon. |
| `ppd enable` | Save enablement and optional mappings or assignments inside an already running provider-enabled daemon. Does not start its service. |
| `ppd configure` | Change mappings or assignments without changing enablement. Requires at least one option. |
| `ppd disable` | Withdraw TCC's provider while retaining mappings and assignments. Does not stop the daemon or another provider. |

`--power-saver`, `--balanced`, and `--performance` select profiles by exact ID or unique, case-sensitive name. Exact IDs take precedence. Use IDs for profiles literally named `default` or `none`. The value `default` removes a mapping override; `none` omits only the performance mapping. Power-saver and balanced mappings are required, mapped profile IDs must be distinct, and performance is optional.

`--ac` and `--battery` accept standard mode names and change saved assignments. Omitted assignments stay unchanged and must still refer to mapped profiles. The CLI does not repair assignments automatically. `ppd configure` needs at least one option.

Writes run as your normal user through the installed helper and Polkit. They replace a full settings snapshot and can apply hardware settings. Use only one GUI or CLI settings writer at a time. Settings can remain saved if provider acquisition fails. Use `tcc-cli ppd status` and `/var/log/tccd/log` to diagnose policy, ownership, or invalid mappings. `ppd status` is a read-only reachable-daemon diagnostic, not proof that an upstream baseline daemon implements the provider.

A retained temporary selection that is not among the new mappings can cause the daemon to reject a write. Explicitly activate a mapped TCC profile before retrying. The CLI does not clear the temporary selection automatically. `tcc-cli ppd disable` withdraws this daemon's provider while leaving the daemon running; it does not restore a previous provider or undo saved assignments.
