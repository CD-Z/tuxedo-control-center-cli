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

import { randomUUID } from 'node:crypto';
import * as dbus from 'dbus-next';

const POLKIT_SERVICE = 'org.freedesktop.PolicyKit1';
const POLKIT_PATH = '/org/freedesktop/PolicyKit1/Authority';
const POLKIT_INTERFACE = 'org.freedesktop.PolicyKit1.Authority';

export interface DBusAuthorizationBus {
    call(message: dbus.Message): Promise<dbus.Message | null>;
}

export type DBusAuthorizationFailure = 'access-denied';

export class DBusAuthorizationError extends Error {
    public constructor(
        public readonly code: DBusAuthorizationFailure,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'DBusAuthorizationError';
    }
}

/**
 * Checks Polkit policy against the authenticated unique bus name. Caller identity
 * is never reconstructed from a PID, UID, or application-provided value.
 */
export class DBusAuthorization {
    private cancellationSequence = 0;

    public constructor(
        private readonly bus: DBusAuthorizationBus,
        private readonly timeoutMs: number = 10_000,
    ) {
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw new RangeError('Polkit authorization timeout must be positive');
        }
    }

    public async check(sender: string, action: string, signal?: AbortSignal): Promise<void> {
        if (!/^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(sender) || action.length === 0) {
            throw new DBusAuthorizationError('access-denied', 'The caller could not be authorized');
        }
        if (signal?.aborted) {
            throw new DBusAuthorizationError('access-denied', 'Authorization was cancelled');
        }

        const cancellationId = this.nextCancellationId();
        let timeout: NodeJS.Timeout | undefined;
        let abortHandler: (() => void) | undefined;
        let interrupted = false;
        const authorization = this.checkAuthorization(sender, action, cancellationId);
        const { promise: interruptedPromise, reject: rejectInterruption } = Promise.withResolvers<never>();
        timeout = setTimeout(() => {
            interrupted = true;
            rejectInterruption(new DBusAuthorizationError('access-denied', 'Authorization timed out'));
        }, this.timeoutMs);
        if (signal !== undefined) {
            abortHandler = (): void => {
                interrupted = true;
                rejectInterruption(new DBusAuthorizationError('access-denied', 'Authorization was cancelled'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        try {
            await Promise.race([authorization, interruptedPromise]);
        } catch (error) {
            if (error instanceof DBusAuthorizationError) {
                throw error;
            }
            throw new DBusAuthorizationError('access-denied', 'Polkit authorization failed', error);
        } finally {
            clearTimeout(timeout);
            if (signal !== undefined && abortHandler !== undefined) {
                signal.removeEventListener('abort', abortHandler);
            }
            if (interrupted) {
                this.cancelCheck(cancellationId);
            }
        }
    }

    private async checkAuthorization(sender: string, action: string, cancellationId: string): Promise<void> {
        const subject: [string, Record<string, dbus.Variant<string>>] = [
            'system-bus-name',
            { name: new dbus.Variant('s', sender) },
        ];
        let reply: dbus.Message | null;
        try {
            reply = await this.bus.call(
                new dbus.Message({
                    destination: POLKIT_SERVICE,
                    path: POLKIT_PATH,
                    interface: POLKIT_INTERFACE,
                    member: 'CheckAuthorization',
                    signature: '(sa{sv})sa{ss}us',
                    body: [subject, action, {}, 0, cancellationId],
                }),
            );
        } catch (error) {
            throw new DBusAuthorizationError('access-denied', 'Polkit authorization is unavailable', error);
        }

        if (
            reply === null ||
            reply.type !== dbus.MessageType.METHOD_RETURN ||
            reply.signature !== '(bba{ss})' ||
            reply.body.length !== 1 ||
            !Array.isArray(reply.body[0]) ||
            reply.body[0].length !== 3 ||
            typeof reply.body[0][0] !== 'boolean' ||
            typeof reply.body[0][1] !== 'boolean' ||
            reply.body[0][2] === null ||
            typeof reply.body[0][2] !== 'object' ||
            Array.isArray(reply.body[0][2])
        ) {
            throw new DBusAuthorizationError('access-denied', 'Polkit returned an invalid authorization response');
        }
        if (reply.body[0][0] !== true) {
            throw new DBusAuthorizationError('access-denied', 'The caller is not authorized for this operation');
        }
    }

    private cancelCheck(cancellationId: string): void {
        void this.bus
            .call(
                new dbus.Message({
                    destination: POLKIT_SERVICE,
                    path: POLKIT_PATH,
                    interface: POLKIT_INTERFACE,
                    member: 'CancelCheckAuthorization',
                    signature: 's',
                    body: [cancellationId],
                }),
            )
            .catch(() => undefined);
    }

    private nextCancellationId(): string {
        this.cancellationSequence = (this.cancellationSequence + 1) >>> 0;
        return `${randomUUID()}-${this.cancellationSequence}`;
    }
}
