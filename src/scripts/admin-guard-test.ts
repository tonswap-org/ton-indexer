import assert from 'node:assert/strict';
import { AdminGuard } from '../api/admin';
import { loadConfig } from '../config';

const config = { ...loadConfig(), adminEnabled: true, adminToken: 'secret' };
const guard = new AdminGuard(config);

const makeReq = (auth?: string) => ({ headers: { authorization: auth } }) as any;

assert.equal(guard.authorize(makeReq('Bearer secret')), true);
assert.equal(guard.authorize(makeReq('Bearer wrong')), false);
assert.equal(guard.authorize(makeReq('token secret')), false);
assert.equal(guard.authorize(makeReq()), false);

console.log('admin guard ok');
