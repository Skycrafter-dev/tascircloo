import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const workerPath = new URL('../static/game/bruteforce-worker.js', import.meta.url);
let source = await readFile(workerPath, 'utf8');
source = source.replace(
  '\tinstallEnvironment();',
  [
    '\tW.__testConditionsMet = conditionsMet;',
    '\tW.__testCheckpointAtScore = checkpointAtScore;',
    '\tW.__testMinimumCheckpoint = minimumCheckpoint;',
    '\treturn;'
  ].join('\n')
);

const self = {
  location: { search: '?testConditions=1' },
  setTimeout,
  clearTimeout,
  performance,
  Date,
  addEventListener() {},
  postMessage() {}
};

const context = vm.createContext({
  self,
  URLSearchParams,
  Map,
  Set,
  WeakMap,
  Promise,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  JSON,
  Date,
  Uint8Array,
  Float64Array,
  DataView,
  ArrayBuffer,
  WebAssembly,
  console,
  setTimeout,
  clearTimeout
});
vm.runInContext(source, context, { filename: workerPath.pathname });

const conditionsMet = self.__testConditionsMet;
const checkpointAtScore = self.__testCheckpointAtScore;
const minimumCheckpoint = self.__testMinimumCheckpoint;

assert.equal(typeof conditionsMet, 'function');
assert.equal(typeof checkpointAtScore, 'function');
assert.equal(typeof minimumCheckpoint, 'function');

assert.equal(minimumCheckpoint({ minCheckpoint: 2 }), 2);
assert.equal(minimumCheckpoint({ minCheckpoint: -4 }), 0);
assert.equal(minimumCheckpoint({}), 0);

assert.equal(checkpointAtScore({ scoreCheckpoint: 1, cp: 5 }), 1);
assert.equal(checkpointAtScore({ cp: 3 }), 3);

assert.equal(conditionsMet({ reached: true, scoreCheckpoint: 1, cp: 5 }, { minCheckpoint: 2 }), false);
assert.equal(conditionsMet({ reached: true, scoreCheckpoint: 2, cp: 2 }, { minCheckpoint: 2 }), true);
assert.equal(conditionsMet({ reached: true, cp: 2 }, { minCheckpoint: 2 }), true);
assert.equal(conditionsMet({ reached: false, scoreCheckpoint: 9, cp: 9 }, { minCheckpoint: 2 }), false);
assert.equal(conditionsMet({ reached: true, scoreCheckpoint: 0, cp: 0 }, { minCheckpoint: 0 }), true);

console.log('Bruteforce minimum-checkpoint condition verified');
