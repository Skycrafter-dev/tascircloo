import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const firstLevel = Math.max(1, Number(process.env.FIRST_LEVEL || 1));
const lastLevel = Math.min(20, Number(process.env.LAST_LEVEL || 20));
const firstCheckpoint = Math.max(1, Number(process.env.FIRST_CP || 1));
const lastCheckpoint = Math.min(6, Number(process.env.LAST_CP || 6));

const base = [
  { frame: -1, input: 'U' },
  { frame: 0, input: 'R' },
  { frame: 16, input: 'L' },
  { frame: 32, input: 'R' }
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
function call(method, params = {}, timeout = 600000) {
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
  const rows = [];
  for (let level = ${firstLevel}; level <= ${lastLevel}; level += 1) {
    for (let targetCP = ${firstCheckpoint}; targetCP <= ${lastCheckpoint}; targetCP += 1) {
      const settings = {
        target: 'cp', targetCP, finishCP: 6, maxFrames: 48,
        minFrame: 0, maxFrame: 48, addMaxInputs: 1, removeMaxInputs: 1, alterMaxInputs: 1, alterTimeDifference: 8, warmup: 0
      };
      try {
        const result = await new Promise((resolve, reject) => {
          const worker = new Worker('/game/bruteforce-worker.js?sim=1&v=checkpoint-gate-' + level + '-' + targetCP + '-' + Date.now());
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('timeout'));
          }, 30000);
          let latest = null;
          worker.onmessage = (event) => {
            const message = event.data || {};
            if (message.type === 'BRUTEFORCE_READY') {
              worker.postMessage({
                source: 'circloo-tas-app', type: 'START_BRUTEFORCE',
                base: ${JSON.stringify(base)}, level, settings,
                workerId: level * 10 + targetCP, maxTrials: 2
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
        const validMode = result && (
          result.mode === 'full-runtime' ||
          result.optimizerValidated === true
        );
        rows.push({
          level, targetCP, ok: !!validMode,
          mode: result && result.mode,
          validated: result && result.optimizerValidated,
          fallback: result && result.optimizerFallbackReason,
          wasmFallback: result && result.wasmFallbackReason,
          trials: result && result.trials,
          verified: result && result.verified,
          bestReached: result && result.bestReached,
          bestScore: result && result.bestScore
        });
      } catch (error) {
        rows.push({ level, targetCP, ok: false, error: String(error && error.message ? error.message : error) });
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
console.log(JSON.stringify({
  combinations: rows.length,
  allPassed: failures.length === 0,
  modes,
  failures,
  rows
}, null, 2));
socket.close();
if (failures.length) process.exitCode = 1;
