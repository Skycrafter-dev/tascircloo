import process from 'node:process';

const port = process.env.CDP_PORT || '9440';
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === 'page');
if (!page) throw new Error('No Chromium page found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 1;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  pending.get(message.id)(message);
  pending.delete(message.id);
};

function call(method, params = {}, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await call('Runtime.enable');

const script = `-65 U
0 L
20 R
71 L
102 R
111 L
113 R
132 L
189 R
197 L
211 R
237 L
250 .`;
const settings = {
  level: 12,
  target: 'cp',
  targetCP: 3,
  finishCP: 6,
  pointX: 1500,
  pointY: 1670,
  pointMinFrame: 0,
  pointMaxFrame: 315,
  minCheckpoint: 2,
  maxFrames: 315,
  minFrame: 300,
  maxFrame: 315,
  addMaxInputs: 4,
  removeMaxInputs: 2,
  alterMaxInputs: 8,
  alterTimeDifference: 11,
  warmup: 0,
  autoUseBest: true
};

await call('Runtime.evaluate', {
  expression: `(() => {
    localStorage.setItem('circloo-tas:script', ${JSON.stringify(script)});
    localStorage.setItem('circloo-tas:bruteforce-settings', ${JSON.stringify(JSON.stringify(settings))});
    localStorage.setItem('circloo-tas:game-speed', '10');
    return true;
  })()`,
  returnByValue: true
});
await call('Runtime.evaluate', {
  expression: 'location.reload(); true',
  returnByValue: true
});
let pageReady = false;
for (let attempt = 0; attempt < 600; attempt += 1) {
  try {
    const ready = await call('Runtime.evaluate', {
      expression: `(() =>
        document.readyState === 'complete' &&
        document.querySelector('textarea[aria-label="TAS script"]')?.value === ${JSON.stringify(script)} &&
        [...document.querySelectorAll('.bruteforce-settings .setting-label')].some(
          (label) => label.textContent?.trim() === 'Checkpoint'
        )
      )()`,
      returnByValue: true
    }, 5000);
    if (ready.result?.value === true) {
      pageReady = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!pageReady) throw new Error('Use Best test page did not hydrate with stored settings');

const expression = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, timeout = 60000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const value = predicate();
      if (value) return value;
      await sleep(25);
    }
    throw new Error('Use Best regression timed out');
  };

  await waitFor(() => document.querySelector('textarea[aria-label="TAS script"]'));
  const gameMessages = [];
  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.source !== 'circloo-tas-game') return;
    gameMessages.push(JSON.parse(JSON.stringify(message)));
    if (gameMessages.length > 5000) gameMessages.shift();
  });

  const button = (name) => [...document.querySelectorAll('button')].find(
    (candidate) => candidate.innerText.trim() === name
  );
  const runUseBest = async () => {
    const messageStart = gameMessages.length;
    button('Use Best').click();
    const ready = await waitFor(() => gameMessages.slice(messageStart).find(
      (message) => message.type === 'RUN_READY' && message.level === 12
    ));
    const readyIndex = gameMessages.indexOf(ready);
    const reached = await waitFor(() => gameMessages.slice(readyIndex + 1).find(
      (message) =>
        message.type === 'TELEMETRY' &&
        message.level === 12 &&
        Number(message.cpTimes?.[3]) === 314
    ));
    return {
      ready: { level: ready.level, frame: ready.frame, cp: ready.cp },
      reached: { level: reached.level, frame: reached.frame, cp: reached.cp, cpTimes: reached.cpTimes }
    };
  };

  const textarea = document.querySelector('textarea[aria-label="TAS script"]');
  await waitFor(() => [...document.querySelectorAll('.bruteforce-settings .setting-label')].some(
    (label) => label.textContent?.trim() === 'Checkpoint'
  ));
  if (textarea.value !== ${JSON.stringify(script)}) throw new Error('Stored script did not load');

  button('Bruteforce').click();
  await waitFor(() => document.body.innerText.includes('best 0:05.23 · F314'));
  button('Bruteforcing').click();
  await waitFor(() => !!button('Bruteforce'));

  const iframe = document.querySelector('iframe');
  await waitFor(() => typeof iframe?.contentWindow?.__circlooTasRequestReplay === 'function');
  const levelTenStart = gameMessages.length;
  iframe.contentWindow.__circlooTasRequestReplay(
    [{ frame: 0, input: 'L' }, { frame: 10, input: '.' }],
    { level: 10, seed: 0, requestId: 910001 }
  );
  const visibleBefore = await waitFor(() => gameMessages.slice(levelTenStart).find(
    (message) => message.type === 'RUN_READY' && message.requestId === 910001 && message.level === 10
  ));
  const first = await runUseBest();
  const second = await runUseBest();

  return {
    passed:
      document.body.innerText.includes('best 0:05.23 · F314') &&
      visibleBefore?.level === 10 &&
      first.ready.level === 12 &&
      Number(first.reached.cpTimes?.[1]) === 125 &&
      Number(first.reached.cpTimes?.[2]) === 197 &&
      Number(first.reached.cpTimes?.[3]) === 314 &&
      second.ready.level === 12 &&
      Number(second.reached.cpTimes?.[1]) === 125 &&
      Number(second.reached.cpTimes?.[2]) === 197 &&
      Number(second.reached.cpTimes?.[3]) === 314 &&
      textarea.value === ${JSON.stringify(script)},
    displayedBest: document.body.innerText.match(/best ([^\\n]+)/)?.[1] || null,
    visibleBefore: visibleBefore ? { level: visibleBefore.level, frame: visibleBefore.frame } : null,
    first,
    second,
    script: textarea.value
  };
})()`;

const result = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
});
socket.close();

if (result.exceptionDetails) {
  throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
}
const value = result.result?.value;
console.log(JSON.stringify(value, null, 2));
if (!value?.passed) process.exitCode = 1;
