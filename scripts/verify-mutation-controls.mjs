import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const workerPath = 'static/game/bruteforce-worker.js';
let source = await readFile(workerPath, 'utf8');
source = source.replace(
  '\tinstallEnvironment();',
  '\tW.__testMutateScript = mutateScript;\n\treturn;'
);

const self = {
  location: { search: '?testMutations=1' },
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
vm.runInContext(source, context, { filename: workerPath });

const mutateScript = self.__testMutateScript;
assert.equal(typeof mutateScript, 'function');

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const base = [
  { frame: -1, input: 'U' },
  { frame: 0, input: 'L' },
  { frame: 20, input: 'R' },
  { frame: 40, input: 'LR' },
  { frame: 60, input: '.' },
  { frame: 80, input: 'L' }
];

for (let seed = 1; seed <= 300; seed++) {
  const disabled = mutateScript(base, {
    minFrame: 0,
    maxFrame: 100,
    addMaxInputs: 0,
    removeMaxInputs: 0,
    alterMaxInputs: 0,
    alterTimeDifference: 4
  }, rng(seed));
  assert.equal(JSON.stringify(disabled), JSON.stringify(base), `disabled seed ${seed}`);
}

for (const maximum of [1, 2, 3]) {
  const addValues = [0, 0.999, 0.1, 0, 0.3, 0.3, 0.5, 0.6];
  let addIndex = 0;
  const add = mutateScript(base, {
    minFrame: 0,
    maxFrame: 100,
    addMaxInputs: maximum,
    removeMaxInputs: 0,
    alterMaxInputs: 0,
    alterTimeDifference: 4
  }, () => addValues[addIndex++] ?? 0.9);
  assert.equal(add.length - base.length, maximum, `add cap ${maximum}`);

  const removeValues = [0, 0.999, 0.999, 0.999, 0.999];
  let removeIndex = 0;
  const remove = mutateScript(base, {
    minFrame: 0,
    maxFrame: 100,
    addMaxInputs: 0,
    removeMaxInputs: maximum,
    alterMaxInputs: 0,
    alterTimeDifference: 4
  }, () => removeValues[removeIndex++] ?? 0.999);
  assert.equal(base.length - remove.length, maximum, `remove cap ${maximum}`);
  assert.ok(remove.some((entry) => entry.input === 'U'), `unfreeze preserved ${maximum}`);

  const alterValues = [
    0, 0.999,
    0.999, 0.999, 0.999,
    0.1, 0.9, 0.1, 0.9,
    0.1, 0.9, 0.1, 0.9,
    0.1, 0.9, 0.1, 0.9
  ];
  let alterIndex = 0;
  const alter = mutateScript(base, {
    minFrame: 0,
    maxFrame: 100,
    addMaxInputs: 0,
    removeMaxInputs: 0,
    alterMaxInputs: maximum,
    alterTimeDifference: 4
  }, () => alterValues[alterIndex++] ?? 0.9);
  const original = base.filter((entry) => entry.input !== 'U');
  const after = alter.filter((entry) => entry.input !== 'U');
  const changed = after.filter((entry, entryIndex) =>
    entry.frame !== original[entryIndex].frame || entry.input !== original[entryIndex].input
  );
  assert.equal(changed.length, maximum, `alter cap ${maximum}`);
  for (let entryIndex = 0; entryIndex < after.length; entryIndex++) {
    assert.ok(
      Math.abs(after[entryIndex].frame - original[entryIndex].frame) <= 4,
      `time difference ${maximum}`
    );
  }
}

console.log('Mutation controls verified across 300 deterministic seeds');
