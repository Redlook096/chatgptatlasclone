const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

process.env.ATLAS_LLM_API_KEY = 'local-test-key';
process.env.ATLAS_LLM_BASE_URL = 'http://127.0.0.1:4311/v1';
process.env.ATLAS_LLM_MODEL = 'local-test-model';

const { runBrowserAgent } = require('../electron/browser-agent.cjs');

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:9334/json/version');
      if (response.ok) return;
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chromium CDP did not become ready.');
}

const pageServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><html><body><input aria-label="Task name"><button onclick="document.querySelector(\'#result\').textContent=\'done:\'+document.querySelector(\'input\').value">Run</button><div id="result"></div></body></html>');
});

let modelCall = 0;
const modelServer = http.createServer((_request, response) => {
  modelCall += 1;
  const actions = [
    { action: 'fill', target: 0, value: 'atlas', reason: 'Fill the task name.', summary: '' },
    { action: 'click', target: 1, value: '', reason: 'Run the task.', summary: '' },
    { action: 'finish', target: 0, value: '', reason: 'The result is visible.', summary: 'Task completed.' }
  ];
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ output_text: JSON.stringify(actions[Math.min(modelCall - 1, actions.length - 1)]) }));
});

async function main() {
await listen(pageServer, 4310);
await listen(modelServer, 4311);

const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-agent-smoke-'));
const browserProcess = spawn(process.env.ATLAS_CHROMIUM_PATH || '/usr/bin/chromium', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9334',
  `--user-data-dir=${profileDirectory}`,
  'about:blank'
], { stdio: 'ignore' });

await waitForCdp();
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');

try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4310', { waitUntil: 'domcontentloaded' });
  const events = [];
  const result = await runBrowserAgent({
    goal: 'Enter atlas and run the task.',
    preferredUrl: 'http://127.0.0.1:4310/',
    port: 9334,
    onProgress: (event) => {
      events.push(event);
      console.log(JSON.stringify({ progress: event.state, step: event.step, action: event.action || null }));
    }
  });
  const pageResult = await page.locator('#result').innerText();
  const cursorEvents = events.filter((event) => event.state === 'acting' && ['fill', 'click'].includes(event.action));
  if (result.state !== 'complete' || pageResult !== 'done:atlas') {
    throw new Error(`Unexpected agent result: ${JSON.stringify({ result, pageResult })}`);
  }
  if (cursorEvents.length !== 2 || cursorEvents.some((event) => !Number.isFinite(event.cursor?.x) || !Number.isFinite(event.cursor?.y))) {
    throw new Error(`Agent target cursor coordinates were missing: ${JSON.stringify(cursorEvents)}`);
  }
  console.log(JSON.stringify({ state: result.state, page_result: pageResult, model_calls: modelCall, progress_events: events.length, cursor_targets: cursorEvents.map((event) => event.cursor) }));
} finally {
  await browser.close().catch(() => {});
  browserProcess.kill();
  fs.rmSync(profileDirectory, { recursive: true, force: true });
  pageServer.close();
  modelServer.close();
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
