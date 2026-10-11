import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDDEN, hideCredentials } from '../src/credentials.js';

test('credentials in request headers are hidden, other headers stay', () => {
  const headers = ['authorization: Bearer eyJ.abc.def', 'Cookie: session=s3; theme=dark', 'set-cookie: sid=s4; Path=/', 'x-api-key: k5',
    'x-csrf-token: c6', 'proxy-authorization: Basic dXNlcjpwYXNz', 'content-type: application/json', 'referer: http://app/page'].join('\n');
  assert.equal(hideCredentials(headers), [`authorization: Bearer ${HIDDEN}`, `Cookie: ${HIDDEN}`, `set-cookie: ${HIDDEN}`, `x-api-key: ${HIDDEN}`,
    `x-csrf-token: ${HIDDEN}`, `proxy-authorization: Basic ${HIDDEN}`, 'content-type: application/json', 'referer: http://app/page'].join('\n'));
  // The indented sections of a request's full details.
  assert.equal(hideCredentials('  Request headers\n    authorization: Bearer x\n    accept: */*'), `  Request headers\n    authorization: Bearer ${HIDDEN}\n    accept: */*`);
});

test('token and password fields of JSON bodies are hidden', () => {
  assert.equal(hideCredentials('{"user":"sam","access_token":"a1","refreshToken":"r\\"2","expires_in":3600,"password":"p"}'),
    `{"user":"sam","access_token":"${HIDDEN}","refreshToken":"${HIDDEN}","expires_in":3600,"password":"${HIDDEN}"}`);
});

test('token, password and code parameters of URLs and forms are hidden', () => {
  assert.equal(hideCredentials('2. [GET] http://app/cb?code=c1&state=s&access_token=t1 => [200] OK'),
    `2. [GET] http://app/cb?code=${HIDDEN}&state=s&access_token=${HIDDEN} => [200] OK`);
  assert.equal(hideCredentials('user=sam&password=p1&remember=1'), `user=sam&password=${HIDDEN}&remember=1`);
  assert.equal(hideCredentials('zipcode=12345&page=2'), 'zipcode=12345&page=2');
});
