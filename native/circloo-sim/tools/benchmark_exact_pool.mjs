const port = process.env.CDP_PORT || '9440';
const durationMs = Number(process.env.DURATION_MS || 70000);
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
await call('Page.enable');
await call('Page.navigate', { url: `http://127.0.0.1:4175/?wasm-pool=${Date.now()}` });
await new Promise((resolve) => setTimeout(resolve, 2500));

const script = `-1 U
0 L
26 LR
28 R
36 .
39 R
91 LR
92 L
143 LR
146 R
230 L
243 LR
245 L
344 R
345 .
347 R
352 .
357 R
455 LR
456 L
468 LR
471 R
480 .
487 L`;

const expression = `(async () => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const labels = [...document.querySelectorAll('.settings-grid label')];
	const control = (prefix) => labels.find((label) => label.textContent.trim().toLowerCase().startsWith(prefix.toLowerCase()))?.querySelector('input,select');
	const update = (element, value) => {
		if (!element) throw new Error('missing control ' + value);
		element.value = String(value);
		element.dispatchEvent(new Event('input', { bubbles: true }));
		element.dispatchEvent(new Event('change', { bubbles: true }));
	};
	const textarea = document.querySelector('textarea[aria-label="TAS script"]');
	if (!textarea) throw new Error('script editor missing');
	textarea.value = ${JSON.stringify(script)};
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	update(control('Level'), 1);
	update(control('Target'), 'finish');
	update(control('Finish CPs'), 7);
	update(control('Max frames'), 660);
	update(control('Modify from'), 300);
	update(control('Modify through'), 0);
	update(control('Mutation'), 8);
	update(control('Step'), 1);
	update(control('Warmup'), 0);
	await wait(100);
	const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Bruteforce');
	if (!button) throw new Error('bruteforce button missing');
	button.click();
	const samples = [];
	const start = performance.now();
	while (performance.now() - start < ${durationMs}) {
		await wait(2000);
		samples.push({
			elapsedMs: Math.round(performance.now() - start),
			stats: document.querySelector('.bruteforce-stats')?.innerText || '',
			error: document.querySelector('.error-bar')?.textContent || ''
		});
		if (samples.at(-1).error) break;
	}
	const stop = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Bruteforcing');
	stop?.click();
	await wait(250);
	return {
		hardwareConcurrency: navigator.hardwareConcurrency,
		samples,
		finalStats: document.querySelector('.bruteforce-stats')?.innerText || '',
		finalError: document.querySelector('.error-bar')?.textContent || ''
	};
})()`;

const response = await call(
	'Runtime.evaluate',
	{ expression, awaitPromise: true, returnByValue: true },
	durationMs + 180000
);
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
console.log(JSON.stringify(response.result.value, null, 2));
socket.close();
