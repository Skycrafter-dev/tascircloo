import fs from 'node:fs';
import process from 'node:process';

const path = process.argv[2] || new URL('../build/wasm/circloo-sim.wasm', import.meta.url);
const bytes = fs.readFileSync(path);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const expectedImports = new Set([
  'wasi_snapshot_preview1.fd_close',
  'wasi_snapshot_preview1.fd_seek',
  'wasi_snapshot_preview1.fd_write',
]);
for (const entry of imports) {
  const key = `${entry.module}.${entry.name}`;
  if (entry.kind !== 'function' || !expectedImports.has(key)) {
    throw new Error(`Unexpected Wasm import: ${JSON.stringify(entry)}`);
  }
}

const importCalls = { fd_close: 0, fd_seek: 0, fd_write: 0 };
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: {
    fd_close() { importCalls.fd_close++; return 0; },
    fd_seek() { importCalls.fd_seek++; return 0; },
    fd_write() { importCalls.fd_write++; return 0; },
  },
});
const exports = instance.exports;
if (exports.circloo_reference_self_test() !== 1) {
  throw new Error('Wasm reference self-test failed');
}
if (Object.values(importCalls).some((count) => count !== 0)) {
  throw new Error(`Wasm compatibility import was invoked: ${JSON.stringify(importCalls)}`);
}

const pointer = exports.circloo_result_ptr();
const view = new DataView(exports.memory.buffer, pointer, exports.circloo_result_size());
const checkpointFrames = [];
for (let index = 0; index < 8; index++) {
  checkpointFrames.push(view.getInt32(16 + index * 4, true));
}

const result = {
  frame: view.getInt32(0, true),
  checkpoint: view.getInt32(4, true),
  growthAlarm: view.getInt32(8, true),
  boundaryRadiusPixels: view.getInt32(12, true),
  checkpointFrames,
  x: view.getFloat64(48, true),
  y: view.getFloat64(56, true),
  vx: view.getFloat64(64, true),
  vy: view.getFloat64(72, true),
  angle: view.getFloat64(80, true),
  angularVelocity: view.getFloat64(88, true),
};

if (
  result.frame !== 658 ||
  result.checkpoint !== 7 ||
  result.growthAlarm !== -1 ||
  result.boundaryRadiusPixels !== 1400 ||
  result.checkpointFrames.slice(1).join(',') !== '64,93,156,245,376,463,658'
) {
  throw new Error(`Unexpected Wasm result: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify({
  byteLength: bytes.byteLength,
  imports,
  importCalls,
  result,
}, null, 2));
