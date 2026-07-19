const port = process.env.CDP_PORT || '9432';
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

const firstLevel = Number(process.env.FIRST_LEVEL || 1);
const lastLevel = Number(process.env.LAST_LEVEL || 20);
const expression = `(async () => {
	const base = [
		{ frame: -1, input: 'U' },
		{ frame: 0, input: 'R' },
		{ frame: 120, input: 'L' },
		{ frame: 240, input: 'R' },
		{ frame: 300, input: '.' }
	];
	const settings = {
		target: 'cp',
		targetCP: 1,
		finishCP: 7,
		maxFrames: 360,
		minFrame: 100,
		maxFrame: 0,
		mutRange: 8,
		mutStep: 1,
		warmup: 0
	};
	const results = [];
	for (let level = ${firstLevel}; level <= ${lastLevel}; level += 1) {
		try {
		const result = await new Promise((resolve, reject) => {
			const worker = new Worker('/game/bruteforce-worker.js?sim=1&v=classify-' + level + '-' + Date.now());
			const timer = setTimeout(() => {
				worker.terminate();
				reject(new Error('level ' + level + ' timeout'));
			}, 60000);
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
						maxTrials: 5
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
					reject(new Error('level ' + level + ': ' + message.error));
				}
			};
			worker.onerror = (event) => {
				clearTimeout(timer);
				worker.terminate();
				reject(new Error('level ' + level + ': ' + event.message));
			};
		});
		results.push({
			level,
			mode: result && result.mode,
			validated: result && result.optimizerValidated,
			fallback: result && result.optimizerFallbackReason,
			wasmFallback: result && result.wasmFallbackReason,
			trials: result && result.trials,
			rate: result && result.rate,
			reached: result && result.lastReached,
			score: result && result.lastScore
		});
		} catch (error) {
			results.push({ level, error: String(error && error.message ? error.message : error) });
		}
	}
	return results;
})()`;

const response = await call('Runtime.evaluate', {
	expression,
	awaitPromise: true,
	returnByValue: true
});
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
console.log(JSON.stringify(response.result.value, null, 2));
socket.close();
