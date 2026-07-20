import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const runCount = Math.max(2, Number(process.env.RUNS || 3));
const maxTrials = Math.max(1, Number(process.env.TRIALS || 2000));
const workerId = Math.max(0, Number(process.env.WORKER_ID || 7));

const base = [
  [-1, 'U'], [0, 'L'], [26, 'LR'], [28, 'R'], [36, '.'], [39, 'R'],
  [91, 'LR'], [92, 'L'], [143, 'LR'], [146, 'R'], [230, 'L'], [243, 'LR'],
  [245, 'L'], [344, 'R'], [345, '.'], [347, 'R'], [352, '.'], [357, 'R'],
  [455, 'LR'], [456, 'L'], [468, 'LR'], [471, 'R'], [480, '.'], [487, 'L']
].map(([frame, input]) => ({ frame, input }));
const settings = {
  target: 'finish',
  targetCP: 7,
  finishCP: 7,
  maxFrames: 660,
  minFrame: 300,
  maxFrame: 0,
  addMaxInputs: 1, removeMaxInputs: 1, alterMaxInputs: 1, alterTimeDifference: 8,
  warmup: 0
};

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
function call(method, params = {}, timeout = 300000) {
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
  const runs = [];
  for (let run = 0; run < ${runCount}; run += 1) {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker('/game/bruteforce-worker.js?sim=1&v=repeatability-' + run + '-' + Date.now());
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('worker timeout on run ' + run));
      }, 240000);
      let latest = null;
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === 'BRUTEFORCE_READY') {
          worker.postMessage({
            source: 'circloo-tas-app',
            type: 'START_BRUTEFORCE',
            base: ${JSON.stringify(base)},
            level: 1,
            settings: ${JSON.stringify(settings)},
            workerId: ${workerId},
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
    runs.push({
      trials: result.trials,
      bestScore: result.bestScore,
      bestScript: result.bestScript,
      bestTimes: result.bestTimes,
      improvements: result.improvements,
      verified: result.verified,
      mode: result.mode,
      optimizerValidated: result.optimizerValidated,
      optimizerFallbackReason: result.optimizerFallbackReason
    });
  }
  return runs;
})()`;
const response = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
});
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
const runs = response.result.value;
const canonical = JSON.stringify(runs[0]);
const identical = runs.every((run) => JSON.stringify(run) === canonical);
console.log(JSON.stringify({ runCount, maxTrials, workerId, identical, runs }, null, 2));
socket.close();
if (!identical) process.exitCode = 1;
