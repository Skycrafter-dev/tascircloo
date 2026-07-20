import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const candidateCount = Math.max(1, Number(process.env.CANDIDATES || 128));
const seed = Number(process.env.SEED || 0x6c1c1001) >>> 0;

const base = [
  [-1, 'U'], [0, 'L'], [26, 'LR'], [28, 'R'], [36, '.'], [39, 'R'],
  [91, 'LR'], [92, 'L'], [143, 'LR'], [146, 'R'], [230, 'L'], [243, 'LR'],
  [245, 'L'], [344, 'R'], [345, '.'], [347, 'R'], [352, '.'], [357, 'R'],
  [455, 'LR'], [456, 'L'], [468, 'LR'], [471, 'R'], [480, '.'], [487, 'L']
].map(([frame, input]) => ({ frame, input }));

let randomState = seed || 1;
function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x100000000;
}
function integer(min, max) {
  return min + Math.floor(random() * (max - min + 1));
}
function choice(values) {
  return values[integer(0, values.length - 1)];
}

const inputs = ['.', 'L', 'R', 'LR'];
const candidates = [];
for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
  const candidate = base.map((entry) => ({ ...entry }));
  const operationCount = integer(1, 5);
  for (let operationIndex = 0; operationIndex < operationCount; operationIndex += 1) {
    const suffixIndices = candidate
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.frame >= 300 && entry.input !== 'U');
    const operation = integer(0, 3);
    if (operation === 0 && suffixIndices.length) {
      const selected = choice(suffixIndices);
      selected.entry.frame = Math.max(300, Math.min(659, selected.entry.frame + integer(-8, 8)));
    } else if (operation === 1 && suffixIndices.length) {
      const selected = choice(suffixIndices);
      const alternatives = inputs.filter((input) => input !== selected.entry.input);
      selected.entry.input = choice(alternatives);
    } else if (operation === 2 && suffixIndices.length > 1) {
      candidate.splice(choice(suffixIndices).index, 1);
    } else {
      candidate.push({ frame: integer(300, 659), input: choice(inputs) });
    }
  }
  candidates.push(candidate);
}

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

const options = {
  level: 1,
  target: 'finish',
  finishCP: 7,
  targetCP: 7,
  maxFrames: 660,
  warmup: 0,
  seed: 0,
  minFrame: 300,
  maxFrame: 659,
  snapshotStride: 32
};
const settings = {
  target: 'finish',
  finishCP: 7,
  targetCP: 7,
  maxFrames: 660,
  minFrame: 300,
  maxFrame: 659,
  addMaxInputs: 1, removeMaxInputs: 1, alterMaxInputs: 1, alterTimeDifference: 8,
  warmup: 0
};

const expression = `(async () => {
  const worker = new Worker('/game/bruteforce-worker.js?sim=1&debugWasm=1&v=parity-' + Date.now());
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('parity timeout'));
    }, 240000);
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'BRUTEFORCE_READY') {
        worker.postMessage({
          source: 'circloo-tas-app',
          type: 'RUN_WASM_PARITY',
          base: ${JSON.stringify(base)},
          candidates: ${JSON.stringify(candidates)},
          options: ${JSON.stringify(options)},
          settings: ${JSON.stringify(settings)},
          scoreOnly: ${process.env.SCORE_ONLY === '1' ? 'true' : 'false'},
          findFirstDivergence: ${process.env.FIND_DIVERGENCE === '1' ? 'true' : 'false'},
          divergenceStartFrame: ${Number(process.env.DIVERGENCE_START || 300)},
          divergenceEndFrame: ${Number(process.env.DIVERGENCE_END || 659)}
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
})()`;

const response = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
});
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
const result = response.result.value;
console.log(JSON.stringify({ seed, candidateCount, ...result }, null, 2));
socket.close();
if (!result?.validated || result.checked !== candidateCount) process.exitCode = 1;
