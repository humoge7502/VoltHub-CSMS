// Simulator smoke: unit-tests OCPP message codec (no network).
'use strict';
const assert = require('assert');
const { call, result, parse } = require('@volthub/ocpp-messages');
const c = call('1', 'BootNotification', { chargePointModel: 'X' });
assert.equal(parse(c).action, 'BootNotification');
assert.equal(parse(result('1', { status: 'Accepted' })).kind, 'RESULT');
console.log('sim tests: 2 passed');
