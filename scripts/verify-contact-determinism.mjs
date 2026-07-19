import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const gameBundle = await readFile('static/game/html5game_a5/circloo.js', 'utf8');
const gameHtml = await readFile('static/game/index.html', 'utf8');
const worker = await readFile('static/game/bruteforce-worker.js', 'utf8');

// Box2D broadphase pair callbacks may arrive in either orientation. Contact
// construction must canonicalize the two endpoints before filtering, factory
// selection, manifold creation, or list insertion.
assert.match(gameBundle, /_xE1\.prototype=\{__tasCompare:function/);
assert.match(gameBundle, /__tasEndpoint:function\(_a\)/);
assert.match(gameBundle, /if\(this\.__tasCompare\(__tasA,__tasB\)>0\)/);
assert.match(gameBundle, /_67\.__tasContactKey=__tasKey/);

// Solver traversal must also have a unique key for every fixture child. Body
// IDs alone are insufficient because one body can own multiple simultaneous
// contacts and stable Array.sort would otherwise retain broadphase order.
assert.match(gameBundle, /__tasSortContacts:function\(\)\{var _a=function\(_b,_c\)/);
assert.match(gameBundle, /__tasFixtureOrder/);
assert.match(gameBundle, /__tasContactKey\?_b\.__tasContactKey/);
assert.match(gameBundle, /this\._eC1\._Sy1\(\);this\.__tasSortContacts\(\)/);

// Both visible and worker runtimes must load the patched bundle rather than a
// stale cached revision.
assert.match(gameHtml, /html5game_a5\/circloo\.js\?v=11/);
assert.match(worker, /html5game_a5\/circloo\.js\?v=7/);

console.log('Contact determinism patch verified');
