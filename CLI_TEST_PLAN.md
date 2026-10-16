# CLI test plan

## Purpose

Verify that the CLI can inspect the running `tccd` service and temporarily select an existing profile on a TUXEDO laptop. Profile selection can cause tccd to apply hardware settings. The CLI does not start or stop services, request elevated privileges, or change saved profile assignments.

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
npm run start-cli -- profiles list extra
npm run start-cli -- profiles activate
```

Pass criteria:

- Help exits 0, prints `status`, `profiles list`, `profiles current`, and `profiles activate <id>`, and does not require a running daemon.
- Both invalid commands exit 2, print usage to stderr and do not connect to tccd.
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

## Isolated missing-bus regression

This overrides the system bus address for one CLI process only. Run the compiled Node entry directly to avoid npm banners:

```sh
DBUS_SYSTEM_BUS_ADDRESS=unix:path=/tmp/tcc-cli-test-missing-bus node dist/tuxedo-control-center/cli-app/cli-app/main.js status
```

Pass criteria: exit 1, empty stdout, stderr contains `tcc-cli: Cannot connect to tccd. Ensure tccd is running.`, and stderr has no unhandled event or Node stack trace. The real daemon state must remain unchanged.

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
| Isolated missing-bus case |  |  |
