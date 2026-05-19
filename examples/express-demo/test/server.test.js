'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/server');

const app = createApp();

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('GET /hello/:name echoes the name', async () => {
  const res = await request(app).get('/hello/world');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { greeting: 'hello, world' });
});

test('unknown routes 404', async () => {
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
});
