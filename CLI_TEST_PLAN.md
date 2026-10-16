# CLI test plan

## Purpose

Verify that the read-only TUXEDO Control Center CLI builds and can inspect the running `tccd` service on a TUXEDO laptop. The CLI must not start or stop services, request elevated privileges, or change profiles or hardware settings.

## Before testing

- Use a TUXEDO laptop with the project checkout and dependencies installed.
- Run the commands from the repository root.
- Do not use `sudo` for the CLI checks. Do not start, stop, or restart `tccd` for this test.
- Check whether the daemon is already running:

  ```sh
  systemctl is-active tccd
  ```

  If it is not `active`, skip the live-daemon cases. Record the state and do not start the service just for this test. The CLI error-path checks can still run.

- Record the laptop model, distribution, Node.js version, and daemon state in the results section. Avoid including serial numbers or other identifying hardware data.

## Build and automated test

From the repository root, run:

```sh
npm run build-cli
npm run test-cli
```

Pass criteria:

- `build-cli` exits successfully and emits `dist/tuxedo-control-center/cli-app/cli-app/main.js`.
- `test-cli` exits successfully with no failed specs.

## Help and argument handling

Run:

```sh
npm run start-cli -- --help
npm run start-cli -- profiles list extra
```

Pass criteria:

- Help exits with code `0`, prints usage and the `status`, `profiles list`, and `profiles current` commands to stdout, and does not require a running daemon.
- The extra-argument command exits with code `2`, prints an invalid-command usage error to stderr, and does not attempt a daemon connection.

## Live read-only inspection

Run these only if `tccd` was already active before testing:

```sh
npm run start-cli -- status
npm run start-cli -- profiles list
npm run start-cli -- profiles current
```

Pass criteria:

- Each command exits with code `0` and leaves stderr empty.
- `status` prints `Daemon: available`, a nonempty version, a device label, and `Active profile: <name> [<id>]`.
- `profiles list` prints the `ID\tNAME` header and one row per profile, in daemon order. IDs are nonempty, and names are the strings returned by the daemon.
- `profiles current` prints the active profile under the same header. Its ID and name match one row from `profiles list`.
- Names and IDs match the daemon's profile data. Built-in names may be untranslated.
- The CLI does not prompt for a password, request root privileges, or report that it changed a profile or hardware setting.

If the GUI is already open, its displayed active profile can be compared with `profiles current`. Do not open or change GUI settings solely for this check.

## Unavailable-daemon error path

This check overrides the bus address for this CLI process only. It must not affect the laptop's system bus or running services.

```sh
DBUS_SYSTEM_BUS_ADDRESS=unix:path=/tmp/tcc-cli-test-missing-bus npm run start-cli -- status
```

Pass criteria:

- The command exits with code `1`.
- Stdout is empty.
- Stderr contains `tcc-cli: Cannot connect to tccd. Ensure tccd is running.`
- The real `tccd` service state remains unchanged.

## Results

| Check | Result | Notes |
| --- | --- | --- |
| Laptop model / distribution |  |  |
| Node.js version |  |  |
| `tccd` state before testing |  |  |
| CLI build |  |  |
| CLI specs |  |  |
| Help and invalid arguments |  |  |
| Live `status` |  |  |
| Live `profiles list` |  |  |
| Live `profiles current` |  |  |
| Isolated unavailable-daemon case |  |  |
