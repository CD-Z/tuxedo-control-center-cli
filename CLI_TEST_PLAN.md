# CLI test plan

Verify the CLI's read-only status and profile commands, saved profile writes, temporary profile selection, and Power Profiles provider lifecycle. The default build and automated checks must not install artifacts, connect to the host system bus, invoke the installed helper, or change the running daemon's settings or hardware. Live daemon changes below are optional and require the machine owner's explicit consent. Temporary selection can apply hardware settings and may require authorization.

Profile selectors accept an exact TCC profile ID or a unique, case-sensitive name. Exact IDs take precedence. The CLI normally runs as the logged-in user. Saved profile and settings changes use the installed privileged helper and Polkit, not a root-run CLI. Profile data lives in `/etc/tcc/profiles`; settings, including `ppd` mappings and AC/battery assignments, live in `/etc/tcc/settings`. Each write replaces its full file or settings snapshot, so do not write through the GUI and CLI at the same time.

## Before testing

- Use a checkout with dependencies installed and run commands from the repository root.
- Do not use `sudo` for CLI checks. Do not start, stop, restart, install, or reconfigure the host's `tccd` service or system bus.
- Automated provider integration uses a private D-Bus session, fake hardware, and temporary settings files. It does not contact the installed daemon.
- The missing-bus checks below override `DBUS_SYSTEM_BUS_ADDRESS` for each child process with a socket under a temporary directory.
- Live daemon reads and writes are separate from automated verification. Do not run the optional live-write sections without explicit consent and a safe recovery plan.
- Record the laptop model, distribution, Node.js version, and whether `tccd` was already active. Do not record serial numbers or other identifying hardware data.

## Build and automated tests

Run the headless build and test suites from the checkout:

```sh
npm run build-headless
npm run build-electron
npx tsc -p ./src/service-app --noEmit

dist/tuxedo-control-center/data/service/tccd --version
node dist/tuxedo-control-center/data/cli/tcc-cli.cjs --help
node dist/tuxedo-control-center/data/cli/tcc-cli.cjs ppd --help
node dist/tuxedo-control-center/data/cli/tcc-cli.cjs ppd enable --help
node dist/tuxedo-control-center/data/cli/tcc-cli.cjs ppd configure --help

npm run test-common
npm run test-service-app
npm run test-cli
npm run test-ppd-integration
```

`build-headless` cleans generated `dist`, `build`, and `usr` directories, compiles the native module, daemon, and CLI bundle, and does not install them. The daemon `--version` check exits before starting workers. Do not use these generated paths to store files you need.

Pass criteria are successful builds and zero failed specs in each runnable suite. Help exits 0 without a daemon connection. The CLI suites verify syntax errors return 2 before connection and operational failures return 1. A command succeeds with exit 0. The private-bus integration suite must pass its lifecycle and subprocess checks. These checks do not prove real hardware behavior or cross-UID authorization.

### Offline help and syntax checks

The process tests run the CLI against an unavailable bus. They verify root, group, and leaf help before connection, including both help spellings. To smoke-test the compiled bundle with no access to the host bus, run:

```sh
missing_bus_dir=$(mktemp -d)
trap 'rm -rf "$missing_bus_dir"' EXIT
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$missing_bus_dir/bus"
cli=dist/tuxedo-control-center/data/cli/tcc-cli.cjs

for option in --help -h; do
    node "$cli" "$option"
    node "$cli" ppd "$option"
    for command in status enable configure disable; do
        node "$cli" ppd "$command" "$option"
    done
done
```

Help exits 0 with no CLI stderr. `ppd`, `ppd --help`, and `ppd -h` show group help. Every `ppd` leaf accepts `--help` and `-h` without reading settings, creating a helper, connecting to D-Bus, or prompting for authorization.

Use an unavailable socket to check static syntax rejection before connection. Each command below should exit 2, with no connection error or help screen:

```sh
node "$cli" ppd configure
node "$cli" ppd status --ac balanced
node "$cli" ppd disable --battery balanced
node "$cli" ppd enable --ac turbo
node "$cli" ppd enable --power-saver
node "$cli" ppd enable --power-saver none
node "$cli" ppd enable --balanced __office__ --balanced __office__
node "$cli" ppd enable --unknown value
node "$cli" ppd enable extra
```

These cover a missing configure option, options on status and disable, unsupported assignment names, missing and reserved mapping values, duplicate and unknown options, and extra positional arguments. A syntactically valid command still needs a compatible daemon and should fail with exit 1 when it cannot connect.

The process suite also retains profile syntax checks for invalid setting values, missing values, incompatible editor options, extra positional arguments, and `profiles activate` without a selector. Syntax failures exit 2 with one nearest-help hint and do not print a help screen.

## Private-bus Power Profiles lifecycle

Run `npm run test-ppd-integration` after `npm run build-headless`. The suite includes subprocess checks that prefer the existing compiled CLI bundle, so rebuild first to avoid exercising a stale bundle.

The integration test must use the real `runCli` and `TccDBusController` against a private D-Bus session. It injects only the settings writer, uses fake hardware, persists test settings under a temporary directory, and restores the bus environment and files in cleanup. It must cover:

- Start with disabled settings and explicit test mappings. Enable with AC and battery assignments, confirm TCC owns the modern provider name, and verify the settings and applied TCC profile.
- Change the power-saver mapping and AC assignment together. Confirm the provider's `ActiveProfile`, persisted assignment, and applied TCC profile agree.
- Disable the provider. Confirm TCC releases the name and `enabled` becomes false while mappings, assignments, profiles, and unrelated settings remain unchanged.
- Reject invalid, duplicate, missing, or unavailable mappings and an unmapped retained assignment without changing disk, selector state, or hardware application records.
- Configure while disabled, then enable. Confirm a retained temporary TCC selection outside the candidate mapping can cause daemon rejection without a false saved-success result.
- Let a separate private-bus client own the standard name first. Confirm enable/configure reports saved settings with exit 1, status reports `other-provider`, the competing owner keeps the name, and TCC does not stop it or retry. After the competing client releases the name, an explicit enable rerun may acquire it.
- Run the compiled CLI status command against active and disabled harnesses.

This suite does not authenticate through the real Polkit helper, prove cross-UID permissions, or apply settings to real hardware. The injected writer exercises the daemon's real configuration refresh with temporary persistence only.

The separate policy suite starts a private system-type D-Bus daemon and tests the shipped bus policies. It requires root to run its root-only cases. Only if authorized root execution is available, run it once with:

```sh
sudo npm run test-ppd-policy -- --random=true --seed=89116
```

Require all specs to execute with zero failures. Pending root-only specs are unverified, not passing. Do not run the CLI itself with `sudo`, and do not retry after a failed root authentication prompt.

## Isolated missing-bus behavior

The process suite creates and removes its own missing socket. To smoke-test the compiled CLI directly, use the `missing_bus_dir` and `cli` variables from the offline check above. Each command is a separate process and cannot fall back to the host system bus:

```sh
node "$cli" ppd status
node "$cli" ppd enable
node "$cli" ppd configure --balanced default
node "$cli" ppd configure --performance=none
node "$cli" ppd disable
```

Each valid command should exit 1 with empty stdout and `tcc-cli: Cannot connect to tccd. Ensure tccd is running.` on stderr. This includes valid `enable` without options, which is allowed when the stored settings already satisfy the invariants. No settings or hardware state should change.

Compare with invalid syntax while the same missing bus is set:

```sh
node "$cli" ppd configure
node "$cli" ppd enable --ac unsupported
```

Both should exit 2 before attempting a connection. Help should exit 0. The missing-bus directory is removed by the shell trap when the session ends.

## Optional live daemon reads

These reads are not part of automated verification. Run them only if `tccd` was already active before testing. Do not start, stop, or restart it:

```sh
systemctl is-active tccd.service
tcc-cli --help
tcc-cli status
tcc-cli profiles list
tcc-cli profiles current
tcc-cli ppd status
```

Successful commands exit 0. `profiles list` reports profile IDs and names; `profiles current` reports the active profile. `ppd status` shows configured enablement separately from provider runtime state, saved AC/battery assignments, and mapping information. A foreign provider's active profile is not evidence that TCC owns the standard D-Bus name.

## Optional live profile changes

Only perform these checks with the machine owner's explicit consent, a compatible active daemon, and profiles whose hardware settings are safe for the current power state. They can apply hardware settings. Keep AC/battery state stable and use one settings writer at a time.

For temporary selection, record the current ID and choose an existing, safe alternate from `profiles list`:

```sh
tcc-cli profiles current
tcc-cli profiles activate "<chosen-profile-id>"
tcc-cli profiles current
tcc-cli status
```

The active profile should change, but saved AC/battery assignments should not. Restore the original active ID recorded before the check:

```sh
tcc-cli profiles activate "<original-profile-id>"
tcc-cli profiles current
```

This restores the active profile, but does not restore whether the daemon had been using an automatic or temporary selection. Do not restart services or edit saved files. If no safe alternate exists, mark the check unverified.

For saved profile inspection, use a running compatible daemon and the installed helper. Built-in profiles are read-only. To test writes, first record the current active profile and assignments in the GUI. Clone a profile safe for the current power state, then edit only that clone:

```sh
tcc-cli profiles show "<base-profile-id>"
tcc-cli profiles create "CLI test clone" --base "<base-profile-id>" --description "CLI test"
tcc-cli profiles show "<new-profile-id>"
tcc-cli profiles edit "<new-profile-id>" --description "Edited by CLI test"
tcc-cli profiles show "<new-profile-id>"
```

Creating a profile does not activate it or change AC/battery assignments. Saved writes may prompt for administrator authentication. A daemon reload after a save may reapply the current profile to hardware. If testing the editor, set `EDITOR` to an editor command that waits for the file to close, such as `code --wait`, then edit only the test clone. Remove the clone through the GUI if desired. Do not run concurrent CLI and GUI saves. Never invoke the installed helper directly or run the CLI as root.

If the helper, authentication agent, or safe profile is unavailable, record the write or hardware behavior as unverified. Automated CLI coverage separately tests helper rejection, cancellation, staged-file cleanup, saved-data readback, and false-success failures using temporary files.

## Optional live Power Profiles writes

These changes persist settings and can change hardware behavior. Do not run them as part of build or automated verification. Proceed only with explicit machine-owner consent, a compatible running `tccd`, installed provider policies, no competing provider, and a way to restore the original settings. Record the current `ppd` mappings and enabled state plus both saved assignments with `tcc-cli ppd status`. Check `tcc-cli profiles list` and choose distinct existing profile IDs whose settings are safe. If you cannot restore the previous configuration, do not write.

This example deliberately changes both saved assignments. Replace the IDs with profiles that exist on the tested device:

```sh
tcc-cli ppd enable --power-saver "<power-saver-profile-id>" --balanced "<balanced-profile-id>" --performance none --ac balanced --battery power-saver
tcc-cli ppd status
tcc-cli ppd configure --power-saver "<safe-custom-profile-id>" --balanced "<balanced-profile-id>" --performance default --ac balanced --battery power-saver
tcc-cli ppd status
tcc-cli ppd disable
tcc-cli ppd status
```

`enable` turns on the provider inside the running daemon, not the systemd service. `configure` preserves the enabled state. `disable` withdraws TCC's provider but does not stop `tccd` and retains mappings and assignments. Restore the recorded settings with the normal authorized configuration process after the check. If a write reports exit 1 after saving because another provider owns the name or the provider is inactive, the settings remain saved; inspect status and `/var/log/tccd/log` rather than assuming the provider started. Do not stop, mask, uninstall, or replace a competing provider as part of this check.

## Results

| Check | Result | Notes |
| --- | --- | --- |
| Laptop model / distribution |  |  |
| Node.js version |  |  |
| `tccd` state before testing |  |  |
| Headless build and compile checks |  |  |
| Offline help and invalid arguments |  |  |
| CLI tests and missing-bus behavior |  |  |
| Private-bus provider lifecycle |  |  |
| Root-only private-bus policy tests |  |  |
| Live status and profile reads |  |  |
| Temporary activation and restoration |  |  |
| Saved profile inspection and writes |  |  |
| Live Power Profiles writes and restoration |  |  |
| Hardware changes |  |  |
