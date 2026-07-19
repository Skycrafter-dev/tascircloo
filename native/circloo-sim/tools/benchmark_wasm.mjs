import fs from 'node:fs';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const path = process.argv[2] || new URL('../build/wasm/circloo-sim.wasm', import.meta.url);
const iterations = Math.max(1, Number(process.argv[3]) || 100);
const bytes = fs.readFileSync(path);
const module = new WebAssembly.Module(bytes);
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: {
    fd_close() { return 0; },
    fd_seek() { return 0; },
    fd_write() { return 0; },
  },
});

const run = instance.exports.circloo_reference_self_test;
for (let index = 0; index < 3; index++) {
  if (run() !== 1) throw new Error('Warm-up self-test failed');
}

const started = performance.now();
for (let index = 0; index < iterations; index++) {
  if (run() !== 1) throw new Error(`Self-test failed at iteration ${index}`);
}
const elapsedMs = performance.now() - started;

console.log(JSON.stringify({
  iterations,
  elapsedMs,
  simulationsPerSecond: iterations * 1000 / elapsedMs,
  physicsStepsPerSecond: iterations * 359 * 1000 / elapsedMs,
  wasmBytes: bytes.byteLength,
  memoryBytes: instance.exports.memory.buffer.byteLength,
}, null, 2));
