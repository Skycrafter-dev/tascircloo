import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) throw new Error('page missing');

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

function call(method, params = {}, timeout = 180000) {
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

const base = [
  { frame: 0, input: 'U' },
  { frame: 0, input: 'L' },
  { frame: 6, input: 'R' },
  { frame: 47, input: 'L' },
  { frame: 88, input: 'LR' },
  { frame: 93, input: 'R' },
  { frame: 139, input: 'L' },
  { frame: 181, input: 'R' },
  { frame: 252, input: 'LR' },
  { frame: 262, input: 'L' },
  { frame: 324, input: 'R' },
  { frame: 387, input: 'L' },
  { frame: 440, input: 'R' },
  { frame: 450, input: 'L' },
  { frame: 481, input: 'R' },
  { frame: 572, input: '.' },
  { frame: 574, input: 'L' }
];
const options = {
  level: 13,
  target: 'cp',
  targetCP: 3,
  finishCP: 3,
  minCheckpoint: 2,
  maxFrames: 930,
  warmup: 0,
  seed: 0,
  minFrame: 550,
  maxFrame: 660,
  snapshotStride: 32
};

const expression = `(async () => {
  const worker = new Worker('/game/bruteforce-worker.js?sim=1&debugWasm=1&v=trial-' + Date.now());
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('trial timeout'));
    }, 150000);
    let exactResult = null;
    const runParity = () => worker.postMessage({
      source: 'circloo-tas-app',
      type: 'RUN_WASM_PARITY',
      base: ${JSON.stringify(base)},
      candidates: [${JSON.stringify(base)}],
      options: ${JSON.stringify(options)},
      settings: ${JSON.stringify({
        target: 'cp',
        targetCP: 3,
        finishCP: 3,
        minCheckpoint: 2,
        maxFrames: 930,
        minFrame: 550,
        maxFrame: 660,
        addMaxInputs: 4,
        removeMaxInputs: 2,
        alterMaxInputs: 6,
        alterTimeDifference: 11,
        warmup: 0
      })},
      verifyEveryFrame: true,
      findFirstDivergence: true,
      divergenceStartFrame: 550,
      divergenceEndFrame: 929
    });
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'BRUTEFORCE_READY') {
        worker.postMessage({
          source: 'circloo-tas-app',
          type: 'RUN_TRIAL',
          script: ${JSON.stringify(base)},
          options: ${JSON.stringify(options)}
        });
      } else if (message.type === 'TRIAL_RESULT') {
        exactResult = message.result;
        runParity();
      } else if (message.type === 'WASM_PARITY_RESULT') {
        clearTimeout(timer);
        worker.terminate();
        resolve({ exactResult, parityResult: message });
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
})()`;

const response = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
});
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
const payload = response.result.value;
const exactResult = payload && payload.exactResult;
const result = payload && payload.parityResult;
const passed = !!(
  exactResult &&
  exactResult.reached === true &&
  Number(exactResult.cp) >= 3 &&
  result &&
  result.validated === true &&
  result.checked === 1 &&
  result.stateMismatchCount === 0 &&
  result.firstFrameMismatch == null &&
  result.firstMismatch == null
);
console.log(JSON.stringify({
  passed,
  exactReached: exactResult && exactResult.reached,
  exactCheckpoint: exactResult && exactResult.cp,
  exactScore: exactResult && exactResult.score,
  exactTimes: exactResult && exactResult.times,
  validated: result && result.validated,
  reason: result && result.reason,
  checked: result && result.checked,
  stateMismatchCount: result && result.stateMismatchCount,
  frameChecked: result && result.frameChecked,
  referenceFrameCount: result && result.referenceFrameCount,
  firstFrameMismatch: result && result.firstFrameMismatch,
  firstMismatch: result && result.firstMismatch,
  modelDebug: result && result.modelDebug
}, null, 2));
socket.close();
if (!passed) process.exitCode = 1;
