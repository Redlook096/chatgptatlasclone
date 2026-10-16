const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const projectRoot = path.resolve(__dirname, '..');
const binary = process.env.ATLAS_ELECTRON_BINARY || path.join(projectRoot, 'dist', 'linux-unpacked', 'atlas-desk');
const port = Number(process.env.ATLAS_BROWSER_SMOKE_PORT || 9344);
fs.mkdirSync(path.join(projectRoot, 'artifacts', 'screenshots'), { recursive: true });

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

async function webviewState(page) {
  return page.locator('.web-page-shell.active webview').evaluate((view) => ({
    url: typeof view.getURL === 'function' ? view.getURL() : view.getAttribute('src'),
    title: typeof view.getTitle === 'function' ? view.getTitle() : '',
    loading: typeof view.isLoading === 'function' ? view.isLoading() : false
  }));
}

async function waitForWebview(page, predicate, attempts = 150) {
  let state;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await webviewState(page);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`Webview did not reach the expected state: ${JSON.stringify(state)}`);
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error('Electron CDP did not become ready.');
}

async function waitForAppPage(browser) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'));
    if (page) {
      await page.locator('.atlas-app').waitFor({ state: 'visible', timeout: 10000 });
      return page;
    }
    await delay(100);
  }
  throw new Error('Atlas renderer did not appear.');
}

async function main() {
  const fixtureServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    if (request.url === '/popup') {
      response.end('<!doctype html><title>Popup target</title><h1>Opened in an Atlas tab</h1>');
      return;
    }
    response.end('<!doctype html><title>Popup fixture</title><a id="open-popup" target="_blank" href="/popup">Open popup</a>');
  });
  await listen(fixtureServer, 4313);
  const child = spawn(binary, ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu'], {
    cwd: projectRoot,
    env: { ...process.env, ATLAS_CDP_PORT: String(port), ATLAS_LLM_API_KEY: '', ATLAS_OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

  let browser;
  try {
    await waitForCdp();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitForAppPage(browser);
    await page.locator('#address-field').fill('OpenAI ChatGPT Atlas');
    await page.locator('#address-field').press('Enter');
    await page.locator('webview').waitFor({ state: 'attached', timeout: 10000 });

    const webState = await waitForWebview(page, (state) => /google\.[^/]+\/(search|sorry)|consent\.google\./i.test(state.url) && !state.loading);

    await page.getByRole('button', { name: 'Ask ChatGPT' }).click();
    await page.locator('.side-chat textarea').fill('Summarize this page');
    await page.locator('.side-chat textarea').press('Enter');
    await page.locator('.side-message.assistant').filter({ hasText: 'scripted mode' }).waitFor({ state: 'visible', timeout: 10000 });
    const sidebarStyle = await page.locator('.side-message.assistant').evaluate((element) => ({ fontSize: getComputedStyle(element).fontSize, composerBorder: getComputedStyle(document.querySelector('.side-composer')).borderTopWidth }));
    if (sidebarStyle.fontSize !== '11.5px' || sidebarStyle.composerBorder !== '1px') throw new Error(`Packaged sidebar styling mismatch: ${JSON.stringify(sidebarStyle)}`);
    await page.screenshot({ path: path.join(projectRoot, 'artifacts', 'screenshots', 'electron-sidebar.png') });
    await page.locator('.side-chat-header button').first().click();
    await page.locator('.side-chat').waitFor({ state: 'detached', timeout: 2000 });

    await page.locator('#address-field').fill('Atlas second browser query');
    await page.locator('#address-field').press('Enter');
    const secondSearch = await waitForWebview(page, (state) => /q=Atlas(?:%20|\+)second(?:%20|\+)browser(?:%20|\+)query/i.test(state.url) && !state.loading);
    await page.getByTitle('Back').click();
    const backState = await waitForWebview(page, (state) => /q=OpenAI(?:%20|\+)ChatGPT(?:%20|\+)Atlas/i.test(state.url) && !state.loading);
    await page.getByTitle('Forward').click();
    await waitForWebview(page, (state) => /q=Atlas(?:%20|\+)second(?:%20|\+)browser(?:%20|\+)query/i.test(state.url) && !state.loading);
    await page.getByTitle('Reload').click();
    await waitForWebview(page, (state) => /q=Atlas(?:%20|\+)second(?:%20|\+)browser(?:%20|\+)query/i.test(state.url) && !state.loading);

    const firstTabId = await page.locator('.browser-tab.active').getAttribute('style');
    await page.locator('.add-tab').click();
    await page.locator('.browser-tab').first().click();
    const preservedUrl = await page.locator('.web-page-shell.active webview').evaluate((view) => view.getURL());
    if (!/google\./i.test(preservedUrl)) throw new Error(`Switching tabs did not preserve the webview: ${preservedUrl}`);

    await page.locator('#address-field').fill('http://127.0.0.1:4313');
    await page.locator('#address-field').press('Enter');
    await waitForWebview(page, (state) => state.url === 'http://127.0.0.1:4313/' && !state.loading);
    const tabsBeforePopup = await page.locator('.browser-tab').count();
    await page.locator('.web-page-shell.active webview').evaluate((view) => view.executeJavaScript("document.querySelector('#open-popup').click()", true));
    await page.waitForFunction((count) => document.querySelectorAll('.browser-tab').length === count + 1, tabsBeforePopup);
    const popupState = await waitForWebview(page, (state) => state.url === 'http://127.0.0.1:4313/popup' && !state.loading);

    const orderBefore = await page.locator('.browser-tab').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId));
    await page.locator('.browser-tab').first().dragTo(page.locator('.browser-tab').last());
    await page.waitForTimeout(350);
    const orderAfter = await page.locator('.browser-tab').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId));
    if (orderAfter.at(-1) !== orderBefore[0]) throw new Error(`Electron tab drag failed: ${JSON.stringify({ orderBefore, orderAfter })}`);

    await page.locator('.browser-tab.active').click({ button: 'right' });
    await page.getByRole('button', { name: 'Add tab to new group' }).click();
    await page.getByLabel('Tab group name').fill('Shopping');
    await page.keyboard.press('Escape');
    await page.locator('.tab-group-label').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(projectRoot, 'artifacts', 'screenshots', 'electron-browser.png') });

    console.log(JSON.stringify({
      google_url: backState.url,
      google_title: webState.title,
      second_search: secondSearch.url,
      tabs: await page.locator('.browser-tab').count(),
      preserved_webview: true,
      back_forward_reload: true,
      sidebar_page_chat: true,
      sidebar_atlas_layout: sidebarStyle,
      sidebar_closed: true,
      popup_tab: popupState.title,
      tab_identity: Boolean(firstTabId),
      tab_dragging: true,
      tab_grouping: await page.locator('.tab-group-label').count() === 1,
      screenshot: 'artifacts/screenshots/electron-browser.png'
    }));
  } catch (error) {
    if (childOutput.trim()) console.error(childOutput.trim());
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      delay(1500).then(() => child.kill('SIGKILL'))
    ]);
    fixtureServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
