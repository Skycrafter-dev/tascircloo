import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const firstLevel = Math.max(1, Number(process.env.FIRST_LEVEL || 1));
const lastLevel = Math.min(20, Number(process.env.LAST_LEVEL || 20));
const maxTrials = Math.max(2, Number(process.env.TRIALS || 2));
const maxFrames = Math.max(360, Number(process.env.MAX_FRAMES || 360));
const targets = ['cp', 'finish', 'point'];

const base = [
  { frame: -1, input: 'U' },
  { frame: 0, input: 'R' },
  { frame: 120, input: 'L' },
  { frame: 240, input: 'R' },
  { frame: 300, input: '.' }
];

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

const expression = `(async () => {
  const base = ${JSON.stringify(base)};
  const targets = ${JSON.stringify(targets)};
  const rows = [];
  for (const target of targets) {
    const settings = {
      target,
      targetCP: 1,
      finishCP: 7,
      pointX: 1500,
      pointY: 1670,
      pointMinFrame: 100,
      pointMaxFrame: ${maxFrames - 1},
      minCheckpoint: 0,
      maxFrames: ${maxFrames},
      minFrame: 100,
      maxFrame: 0,
      addMaxInputs: 1,
      removeMaxInputs: 1,
      alterMaxInputs: 1,
      alterTimeDifference: 8,
      warmup: 0
    };
    for (let level = ${firstLevel}; level <= ${lastLevel}; level += 1) {
      try {
        const result = await new Promise((resolve, reject) => {
          const version = ['target-mode', target, level, Date.now(), Math.random()].join('-');
          const worker = new Worker('/game/bruteforce-worker.js?sim=1&v=' + version);
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('timeout'));
          }, 120000);
          let latest = null;
          worker.onmessage = (event) => {
            const message = event.data || {};
            if (message.type === 'BRUTEFORCE_READY') {
              worker.postMessage({
                source: 'circloo-tas-app',
                type: 'START_BRUTEFORCE',
                base,
                level,
                settings,
                workerId: level,
                maxTrials: ${maxTrials}
              });
            } else if (message.type === 'BRUTEFORCE_PROGRESS') {
              latest = message;
            } else if (message.type === 'BRUTEFORCE_STOPPED') {
              clearTimeout(timer);
              worker.terminate();
              resolve(latest);
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
        const ok = !!result &&
          result.mode === 'wasm-runtime' &&
          result.optimizerValidated === true &&
          !result.optimizerFallbackReason &&
          !result.wasmFallbackReason;
        rows.push({
          target,
          level,
          ok,
          mode: result && result.mode,
          validated: result && result.optimizerValidated,
          fallback: result && result.optimizerFallbackReason,
          wasmFallback: result && result.wasmFallbackReason,
          trials: result && result.trials
        });
      } catch (error) {
        rows.push({
          target,
          level,
          ok: false,
          error: String(error && error.message ? error.message : error)
        });
      }
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
const modes = {};
for (const row of rows) modes[row.mode || 'error'] = (modes[row.mode || 'error'] || 0) + 1;
const byTarget = Object.fromEntries(
  targets.map((target) => {
    const targetRows = rows.filter((row) => row.target === target);
    return [target, {
      combinations: targetRows.length,
      passed: targetRows.filter((row) => row.ok).length
    }];
  })
);

console.log(JSON.stringify({
  combinations: rows.length,
  allPassed: failures.length === 0,
  modes,
  byTarget,
  failures
}, null, 2));

socket.close();
if (failures.length) process.exitCode = 1;
