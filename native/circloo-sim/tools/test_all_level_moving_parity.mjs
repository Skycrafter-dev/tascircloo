import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const firstLevel = Math.max(1, Number(process.env.FIRST_LEVEL || 1));
const lastLevel = Math.min(20, Number(process.env.LAST_LEVEL || 20));
const maxFrames = Math.max(120, Number(process.env.MAX_FRAMES || 930));
const minFrame = Math.max(0, Number(process.env.MIN_FRAME || 550));

const base = [
  [0, 'U'], [0, 'L'], [18, 'R'], [87, 'L'], [131, 'R'], [217, 'LR'],
  [224, 'L'], [296, 'R'], [330, 'L'], [449, 'R'], [455, 'LR'], [460, 'R'],
  [468, 'LR'], [471, 'R'], [525, 'L'], [600, 'R'], [605, '.'], [619, 'L'],
  [712, 'R'], [853, 'L']
].map(([frame, input]) => ({ frame, input }));

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) throw new Error('page target missing');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  pending.get(message.id)(message);
  pending.delete(message.id);
});
function call(method, params = {}, timeout = 1_200_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
await call('Runtime.enable');

const options = {
  target: 'point',
  pointX: 0,
  pointY: 0,
  pointMinFrame: minFrame,
  pointMaxFrame: maxFrames - 1,
  minCheckpoint: 0,
  maxFrames,
  warmup: 0,
  seed: 0,
  minFrame,
  maxFrame: maxFrames - 1,
  snapshotStride: 32
};
const settings = {
  ...options,
  addMaxInputs: 4,
  removeMaxInputs: 2,
  alterMaxInputs: 6,
  alterTimeDifference: 11
};

const expression = `(async () => {
  const rows = [];
  for (let level = ${firstLevel}; level <= ${lastLevel}; level += 1) {
    try {
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker('/game/bruteforce-worker.js?sim=1&debugWasm=1&v=moving-' + level + '-' + Date.now());
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error('timeout'));
        }, 180000);
        worker.onmessage = (event) => {
          const message = event.data || {};
          if (message.type === 'BRUTEFORCE_READY') {
            worker.postMessage({
              source: 'circloo-tas-app',
              type: 'RUN_WASM_PARITY',
              base: ${JSON.stringify(base)},
              candidates: [${JSON.stringify(base)}],
              options: { ...${JSON.stringify(options)}, level },
              settings: ${JSON.stringify(settings)},
              verifyEveryFrame: true,
              findFirstDivergence: true,
              divergenceStartFrame: ${minFrame},
              divergenceEndFrame: ${maxFrames - 1}
            });
          } else if (message.type === 'WASM_PARITY_RESULT') {
            clearTimeout(timer);
            worker.terminate();
            resolve(message);
          } else if (message.type === 'BRUTEFORCE_ERROR') {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(message.error));
          }
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.message));
        };
      });
      rows.push({
        level,
        ok: result.validated === true,
        reason: result.reason,
        checked: result.checked,
        frameChecked: result.frameChecked,
        referenceFrameCount: result.referenceFrameCount,
        firstFrameMismatch: result.firstFrameMismatch,
        firstMismatch: result.firstMismatch,
        modelDebug: result.modelDebug
      });
    } catch (error) {
      rows.push({ level, ok: false, error: String(error && error.message ? error.message : error) });
    }
  }
  return rows;
})()`;

const response = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
});
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
const rows = response.result.value;
const failures = rows.filter((row) => !row.ok);
console.log(JSON.stringify({
  combinations: rows.length,
  allPassed: failures.length === 0,
  failures,
  rows
}, null, 2));
socket.close();
if (failures.length) process.exitCode = 1;
