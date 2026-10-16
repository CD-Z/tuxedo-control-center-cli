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

import 'jasmine';
import * as dbus from 'dbus-next';
import { DBusAuthorization, DBusAuthorizationError, type DBusAuthorizationBus } from './DBusAuthorization';

class FakeAuthorizationBus implements DBusAuthorizationBus {
    public readonly calls: dbus.Message[] = [];
    public response: dbus.Message | null = this.authorizationReply(true);
    public rejectCalls = false;
    public neverAnswerAuthorization = false;

    public async call(message: dbus.Message): Promise<dbus.Message | null> {
        this.calls.push(message);
        if (this.rejectCalls) {
            throw new Error('Polkit is not running');
        }
        if (this.neverAnswerAuthorization && message.member === 'CheckAuthorization') {
            const { promise } = Promise.withResolvers<dbus.Message | null>();
            return promise;
        }
        return this.response;
    }

    private authorizationReply(authorized: boolean): dbus.Message {
        return new dbus.Message({
            type: dbus.MessageType.METHOD_RETURN,
            replySerial: '1',
            signature: 'bba{ss}',
            body: [authorized, false, {}],
        });
    }
}

describe('DBusAuthorization', () => {
    it('checks the authenticated system-bus name with noninteractive Polkit flags', async () => {
        const bus = new FakeAuthorizationBus();
        const authorization = new DBusAuthorization(bus);

        await authorization.check(':1.42', 'org.freedesktop.UPower.PowerProfiles.switch-profile');

        const request = bus.calls[0];
        expect(request.destination).toBe('org.freedesktop.PolicyKit1');
        expect(request.path).toBe('/org/freedesktop/PolicyKit1/Authority');
        expect(request.interface).toBe('org.freedesktop.PolicyKit1.Authority');
        expect(request.member).toBe('CheckAuthorization');
        expect(request.signature).toBe('(sa{sv})sa{ss}us');
        expect(request.body[0][0]).toBe('system-bus-name');
        expect(request.body[0][1].name.signature).toBe('s');
        expect(request.body[0][1].name.value).toBe(':1.42');
        expect(request.body[1]).toBe('org.freedesktop.UPower.PowerProfiles.switch-profile');
        expect(request.body[2]).toEqual({});
        expect(request.body[3]).toBe(0);
        expect(typeof request.body[4]).toBe('string');
    });

    it('denies a Polkit rejection', async () => {
        const bus = new FakeAuthorizationBus();
        bus.response = new dbus.Message({
            type: dbus.MessageType.METHOD_RETURN,
            replySerial: '1',
            signature: 'bba{ss}',
            body: [false, true, {}],
        });
        const authorization = new DBusAuthorization(bus);

        let rejection: unknown;
        try {
            await authorization.check(':1.9', 'com.example.switch-profile');
        } catch (error) {
            rejection = error;
        }

        expect(rejection).toEqual(jasmine.any(DBusAuthorizationError));
        expect((rejection as DBusAuthorizationError).code).toBe('access-denied');
    });

    it('fails closed when Polkit cannot be reached', async () => {
        const bus = new FakeAuthorizationBus();
        bus.rejectCalls = true;
        const authorization = new DBusAuthorization(bus);

        let rejection: unknown;
        try {
            await authorization.check(':1.9', 'com.example.switch-profile');
        } catch (error) {
            rejection = error;
        }

        expect(rejection).toEqual(jasmine.any(DBusAuthorizationError));
        expect((rejection as DBusAuthorizationError).code).toBe('access-denied');
    });

    it('cancels timed-out and caller-cancelled checks', async () => {
        const timeoutBus = new FakeAuthorizationBus();
        timeoutBus.neverAnswerAuthorization = true;
        const timeoutAuthorization = new DBusAuthorization(timeoutBus, 5);
        let timeoutError: unknown;
        try {
            await timeoutAuthorization.check(':1.10', 'com.example.switch-profile');
        } catch (error) {
            timeoutError = error;
        }
        expect(timeoutError).toEqual(jasmine.any(DBusAuthorizationError));
        expect(timeoutBus.calls.some((call) => call.member === 'CancelCheckAuthorization')).toBeTrue();

        const abortBus = new FakeAuthorizationBus();
        abortBus.neverAnswerAuthorization = true;
        const abortAuthorization = new DBusAuthorization(abortBus);
        const controller = new AbortController();
        const pending = abortAuthorization.check(':1.11', 'com.example.hold-profile', controller.signal);
        controller.abort();
        let abortError: unknown;
        try {
            await pending;
        } catch (error) {
            abortError = error;
        }
        expect(abortError).toEqual(jasmine.any(DBusAuthorizationError));
        expect(abortBus.calls.some((call) => call.member === 'CancelCheckAuthorization')).toBeTrue();
    });

    it('rejects malformed caller identities before making a bus request', async () => {
        const bus = new FakeAuthorizationBus();
        const authorization = new DBusAuthorization(bus);
        let rejection: unknown;
        try {
            await authorization.check('not-a-unique-name', 'com.example.action');
        } catch (error) {
            rejection = error;
        }

        expect(rejection).toEqual(jasmine.any(DBusAuthorizationError));
        expect(bus.calls).toEqual([]);
    });
});
