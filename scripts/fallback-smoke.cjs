const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const {
  fallbackReason,
  scriptedAssistantResponse
} = require('../electron/scripted-fallback.cjs');

delete process.env.ATLAS_LLM_API_KEY;
delete process.env.ATLAS_OPENAI_API_KEY;
const { runBrowserAgent } = require('../electron/browser-agent.cjs');

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:9335/json/version');
      if (response.ok) return;
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Fallback Chromium CDP did not become ready.');
}

const pageServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><html><head><title>Fallback fixture</title></head><body><input aria-label="Task name"><button onclick="document.querySelector(\'#result\').textContent=\'done:\'+document.querySelector(\'input\').value">Run</button><div id="result"></div></body></html>');
});

async function main() {
  const assistant = scriptedAssistantResponse({
    prompt: 'Summarize this page',
    pageContext: JSON.stringify({
      title: 'Atlas notes',
      url: 'https://example.test/atlas',
      text: 'Atlas combines browsing with an assistant. It keeps page context in a side panel. Agent mode can act on visible controls.'
    })
  }, fallbackReason({ status: 429 }));
  if (!assistant.fallback || assistant.reason !== 'credits' || !assistant.text.includes('Atlas combines browsing')) {
    throw new Error(`Unexpected assistant fallback: ${JSON.stringify(assistant)}`);
  }

  await listen(pageServer, 4312);
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fallback-smoke-'));
  const browserProcess = spawn(process.env.ATLAS_CHROMIUM_PATH || '/usr/bin/chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9335',
    `--user-data-dir=${profileDirectory}`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitForCdp();
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9335');
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:4312', { waitUntil: 'domcontentloaded' });
      const events = [];
      const result = await runBrowserAgent({
        goal: 'Enter atlas and run the task.',
        preferredUrl: 'http://127.0.0.1:4312/',
        port: 9335,
        onProgress: (event) => events.push(event)
      });
      const pageResult = await page.locator('#result').innerText();
      if (result.state !== 'complete' || !result.scripted || pageResult !== 'done:atlas') {
        throw new Error(`Unexpected scripted agent result: ${JSON.stringify({ result, pageResult })}`);
      }
      if (!events.some((event) => event.scripted)) throw new Error('Fallback progress was not marked as scripted.');
      console.log(JSON.stringify({
        assistant_mode: assistant.mode,
        assistant_reason: assistant.reason,
        agent_state: result.state,
        agent_scripted: result.scripted,
        page_result: pageResult,
        steps: result.step
      }));
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    browserProcess.kill();
    fs.rmSync(profileDirectory, { recursive: true, force: true });
    pageServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
