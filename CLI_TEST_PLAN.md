# CLI test plan

## Purpose

Verify that the CLI can inspect daemon profiles, create and edit saved profiles, and temporarily select a profile on a TUXEDO laptop. Temporary selection may apply hardware settings through tccd. Saved-profile writes use the installed privileged helper and may trigger a daemon reload that reapplies the current profile.

## Before testing

- Use a TUXEDO laptop with the project checkout and dependencies installed.
- Run commands from the repository root. Do not use `sudo` for CLI checks.
- Do not start, stop, or restart `tccd` for this test.
- Check whether the daemon is already running with `systemctl is-active tccd`. If it is not active, record that state and skip live-daemon tests.
- Keep AC/battery state stable during profile activation checks.
- Record the laptop model, distribution, Node.js version and daemon state. Do not include serial numbers or other identifying hardware data.

## Build and automated tests

Run:

```sh
npm run build-cli
npm run build-electron
npm run test-common && npm run test-service-app && npm run test-cli
```

Pass criteria: builds exit successfully and each test suite reports no failed specs.

## Help and argument handling

Run:

```sh
npm run start-cli -- --help
npm run start-cli -- profiles show --help
npm run start-cli -- profiles create --help
npm run start-cli -- profiles edit --help
npm run start-cli -- profiles list extra
npm run start-cli -- profiles activate
npm run start-cli -- profiles create Test --brightness invalid
npm run start-cli -- profiles edit id --editor --description invalid
```

Pass criteria:

- Help exits 0 and lists all commands, including `profiles show`, `profiles create`, and `profiles edit`.
- `profiles show --help`, `profiles create --help`, and `profiles edit --help` exit 0 without connecting or opening an editor.
- Invalid command forms and setting values exit 2, print usage to stderr and do not connect to tccd.
- `npm run` may print its own banners. For exact CLI streams and exit codes, use the compiled entry directly as shown in the unavailable-daemon check.

## Live reads

Run these only if `tccd` was already active before testing:

```sh
npm run start-cli -- status
npm run start-cli -- profiles list
npm run start-cli -- profiles current
```

Each command should exit 0 with empty CLI stderr. `status` shows the daemon version, device and active profile. `profiles list` prints all IDs and names in daemon order. `profiles current` shows the active ID and name.

## Temporary profile activation

Only proceed if at least one existing alternate profile has settings you are comfortable applying. Record the current active ID first:

```sh
npm run start-cli -- profiles current
```

Choose a different existing ID from `profiles list`, then run:

```sh
npm run start-cli -- profiles activate "<chosen-id>"
npm run start-cli -- profiles current
npm run start-cli -- status
```

Expect `Activated temporary profile: <name> [<id>]`, then the chosen ID in `profiles current` and `status`. No elevation prompt should appear. The selection does not change saved AC/battery assignments. A daemon restart, power-state change, or changed saved mapping can clear it.

Restore the original active profile by activating the ID recorded before the check:

```sh
npm run start-cli -- profiles activate "<original-id>"
npm run start-cli -- profiles current
```

This restores the active profile, but the current API does not expose or restore whether the daemon was previously using an automatic or temporary selection. Do not restart services or edit saved profiles/configuration. If no safe alternate exists, record activation as unverified.

## Saved profile inspection and editing

Use a running compatible daemon and an installed profile helper. Do not run the CLI as root. Use one writer at a time, since the helper replaces the full profile list and cannot detect a GUI save that races during authentication.

Inspect a built-in or saved custom profile by its exact ID:

```sh
npm run start-cli -- profiles show "<profile-id>"
```

Built-in output contains daemon-resolved defaults. Custom output reflects the saved JSON, including omitted dynamic CPU defaults. Built-ins are read-only.

For a safe write check, first record `profiles current` and the saved AC/battery profile assignments in the GUI. Choose an existing base whose settings are safe for the current power state, then create a clone with a harmless description change:

```sh
npm run start-cli -- profiles create "CLI test clone" --base "<base-id>" --description "CLI test"
npm run start-cli -- profiles show "<new-id>"
npm run start-cli -- profiles edit "<new-id>" --description "Edited by CLI test"
npm run start-cli -- profiles show "<new-id>"
```

Creating a profile does not activate it or change saved AC/battery assignments. Profile saves may prompt for administrator authentication. A daemon reload after any save may reapply the current profile to hardware, so keep power state stable and watch the device during the check. Do not use a setting change unless it is comfortable for the current test conditions.

To check the editor, edit only the test clone:

```sh
npm run start-cli -- profiles edit "<new-id>" --editor
```

Set `EDITOR` to an editor command that waits until the file is saved and closed, such as `code --wait`. Confirm the description and JSON with `profiles show` and GUI inspection. Remove the test clone through the GUI after testing if desired. Do not run concurrent CLI and GUI saves.

If no compatible daemon, installed helper, authentication agent, or safe profile is available, record the relevant write or hardware behavior as unverified. Never invoke the installed helper directly or run the entire CLI with `sudo`.

Automated CLI coverage also exercises named setting boundaries, malformed editor JSON, cancellation, target conflicts, helper rejection and false-success readback. A private D-Bus/PTy smoke should verify that create does not activate the clone, numbered base selection chooses the requested profile, cancellation leaves the saved file unchanged, and `ConfigHandler.readProfiles()` preserves an accepted custom curve and TDP document.

## Isolated missing-bus regression

This overrides the system bus address for one CLI process only. Run the compiled Node entry directly to avoid npm banners:

```sh
missing_bus_dir=$(mktemp -d)
DBUS_SYSTEM_BUS_ADDRESS="unix:path=$missing_bus_dir/bus" node dist/tuxedo-control-center/cli-app/cli-app/main.js status
DBUS_SYSTEM_BUS_ADDRESS="unix:path=$missing_bus_dir/bus" node dist/tuxedo-control-center/cli-app/cli-app/main.js profiles show missing
DBUS_SYSTEM_BUS_ADDRESS="unix:path=$missing_bus_dir/bus" node dist/tuxedo-control-center/cli-app/cli-app/main.js profiles create Test --base missing
DBUS_SYSTEM_BUS_ADDRESS="unix:path=$missing_bus_dir/bus" node dist/tuxedo-control-center/cli-app/cli-app/main.js profiles edit missing --brightness 60
DBUS_SYSTEM_BUS_ADDRESS="unix:path=$missing_bus_dir/bus" node dist/tuxedo-control-center/cli-app/cli-app/main.js profiles create Test --brightness invalid
rm -r "$missing_bus_dir"
```

The status and profile show/create/edit commands should each exit 1 with empty stdout and `tcc-cli: Cannot connect to tccd. Ensure tccd is running.` on stderr. The invalid setting form should exit 2 before connecting. The real daemon state must remain unchanged.

## Results

| Check | Result | Notes |
| --- | --- | --- |
| Laptop model / distribution |  |  |
| Node.js version |  |  |
| `tccd` state before testing |  |  |
| CLI build and automated tests |  |  |
| Help and invalid arguments |  |  |
| Live status and profile reads |  |  |
| Temporary activation and restoration |  |  |
| Saved-profile inspection and writes |  |  |
| Editor and PTY cancellation |  |  |
| Private D-Bus / migration smoke |  |  |
| Hardware changes and daemon reload |  |  |
| Isolated missing-bus case |  |  |
