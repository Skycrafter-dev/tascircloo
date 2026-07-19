import { mkdirSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] || 9440);
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

function call(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 300_000);
		pending.set(id, (message) => {
			clearTimeout(timer);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		});
		socket.send(JSON.stringify({ id, method, params }));
	});
}

await call('Runtime.enable');
await call('Runtime.evaluate', {
	expression: `(() => {
		if (window.__circlooModelProbe) return true;
		const worker = new Worker('/game/bruteforce-worker.js?sim=1&models=' + Date.now());
		const queue = [];
		let ready = false;
		let active = null;
		function pump() {
			if (!ready || active || !queue.length) return;
			active = queue.shift();
			worker.postMessage({
				source: 'circloo-tas-app',
				type: 'INSPECT_COMPACT',
				script: [{ frame: -1, input: 'U' }, { frame: 0, input: '.' }],
				frame: 0,
				options: { level: active.level, seed: 0 }
			});
		}
		worker.onmessage = (event) => {
			const message = event.data || {};
			if (message.type === 'BRUTEFORCE_READY') {
				ready = true;
				pump();
				return;
			}
			if (message.type === 'COMPACT_INSPECTION' && active) {
				const item = active;
				active = null;
				item.resolve(message.result);
				pump();
				return;
			}
			if (message.type === 'BRUTEFORCE_ERROR' && active) {
				const item = active;
				active = null;
				item.reject(new Error(message.error));
				pump();
			}
		};
		window.__circlooModelProbe = {
			inspect(level) {
				return new Promise((resolve, reject) => {
					queue.push({ level, resolve, reject });
					pump();
				});
			},
			stop() {
				worker.terminate();
			}
		};
		return true;
	})()`,
	returnByValue: true
});

mkdirSync('/tmp/circloo-level-models', { recursive: true });
const summaries = [];
for (let level = 1; level <= 20; level += 1) {
	const result = await call('Runtime.evaluate', {
		expression: `window.__circlooModelProbe.inspect(${level})`,
		awaitPromise: true,
		returnByValue: true
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const model = result.result.value;
	writeFileSync(`/tmp/circloo-level-models/level-${level}.json`, JSON.stringify(model));

	const shapes = {};
	const objects = {};
	let fixtureCount = 0;
	for (const body of model.bodies || []) {
		objects[body.objectIndex] = (objects[body.objectIndex] || 0) + 1;
		for (const fixture of body.fixtures || []) {
			fixtureCount += 1;
			const key = String(fixture.shape?.type);
			shapes[key] = (shapes[key] || 0) + 1;
		}
	}
	const collectibleTypes = {};
	for (const collectible of model.collectibles || []) {
		collectibleTypes[collectible.type] = (collectibleTypes[collectible.type] || 0) + 1;
	}
	const summary = {
		level,
		frame: model.frame,
		cp: model.cp,
		bodies: model.bodies?.length || 0,
		fixtures: fixtureCount,
		shapes,
		objects,
		collectibles: model.collectibles?.length || 0,
		collectibleTypes
	};
	summaries.push(summary);
	console.log(JSON.stringify(summary));
}

await call('Runtime.evaluate', {
	expression: 'window.__circlooModelProbe.stop(); true',
	returnByValue: true
});
writeFileSync('/tmp/circloo-level-models/summary.json', JSON.stringify(summaries, null, 2));
socket.close();
