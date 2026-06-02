'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { safeResolve, hostAllowed } = require('../dev.js');

const ROOT = path.resolve('/proj');

/* ===================== path safety ===================== */
test('safeResolve maps normal paths inside the root', () => {
  assert.equal(safeResolve(ROOT, '/'), path.join(ROOT, 'index.html'));
  assert.equal(safeResolve(ROOT, '/index.html'), path.join(ROOT, 'index.html'));
  assert.equal(safeResolve(ROOT, '/app-logic.js'), path.join(ROOT, 'app-logic.js'));
  assert.equal(safeResolve(ROOT, '/icons/icon-192.png'), path.join(ROOT, 'icons', 'icon-192.png'));
  assert.equal(safeResolve(ROOT, '/sub/'), path.join(ROOT, 'sub', 'index.html'));
  assert.equal(safeResolve(ROOT, '/app-logic.js?v=2'), path.join(ROOT, 'app-logic.js')); // query stripped
});

test('safeResolve rejects traversal, dotfiles, and null bytes', () => {
  assert.equal(safeResolve(ROOT, '/../etc/passwd'), null);
  assert.equal(safeResolve(ROOT, '/../../secret'), null);
  assert.equal(safeResolve(ROOT, '/%2e%2e/%2e%2e/etc/passwd'), null);  // encoded ../
  assert.equal(safeResolve(ROOT, '/icons/../../etc/passwd'), null);
  assert.equal(safeResolve(ROOT, '/.git/config'), null);
  assert.equal(safeResolve(ROOT, '/.env'), null);
  assert.equal(safeResolve(ROOT, '/sub/.hidden'), null);              // dotfile in subdir
  assert.equal(safeResolve(ROOT, '/foo%00.js'), null);                // encoded null byte
  assert.equal(safeResolve(ROOT, '/%ZZ'), null);                      // malformed encoding
  assert.equal(safeResolve(ROOT, 42), null);                          // non-string
});

/* ===================== host allowlist (anti DNS-rebinding) ===================== */
test('hostAllowed enforces the localhost/LAN allowlist', () => {
  const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '192.168.1.50']);
  assert.equal(hostAllowed('localhost:8000', allowed), true);
  assert.equal(hostAllowed('127.0.0.1:8000', allowed), true);
  assert.equal(hostAllowed('[::1]:8000', allowed), true);
  assert.equal(hostAllowed('192.168.1.50:8000', allowed), true);
  assert.equal(hostAllowed('LOCALHOST:8000', allowed), true);         // case-insensitive
  assert.equal(hostAllowed('evil.com', allowed), false);              // DNS-rebinding attempt
  assert.equal(hostAllowed('attacker.example:8000', allowed), false);
  assert.equal(hostAllowed('192.168.1.99:8000', allowed), false);     // other LAN host not bound
  assert.equal(hostAllowed('', allowed), false);
  assert.equal(hostAllowed(undefined, allowed), false);
});
