import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('artifacts/screenshots', { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.ATLAS_CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__atlasProgressListeners = [];
    Object.defineProperty(window, 'atlas', {
      value: {
        window: { minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {} },
        assistant: {
          status: async () => ({ configured: false, mode: 'scripted', model: 'Built-in scripted fallback', baseUrl: '' }),
          respond: async ({ prompt }) => ({ text: `Scripted UI reply for: ${prompt}`, fallback: true, mode: 'scripted', reason: 'no_key' })
        },
        browser: {
          runAgentTask: async () => ({ state: 'complete' }),
          stopAgentTask: async () => true,
          onAgentProgress: (listener) => {
            window.__atlasProgressListeners.push(listener);
            return () => { window.__atlasProgressListeners = window.__atlasProgressListeners.filter((item) => item !== listener); };
          },
          onTextSelected: () => () => {},
          onOpenTab: () => () => {}
        },
        openExternal: async () => true
      }
    });
  });
  await page.goto(process.env.ATLAS_PREVIEW_URL || 'http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.locator('.browser-top').waitFor({ state: 'visible' });
  await page.locator('.universal-box').waitFor({ state: 'visible' });

  await page.locator('.profile-button').click();
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.getByText('Scripted fallback ready').waitFor({ state: 'visible' });
  await page.locator('.settings-dialog header button').click();

  await page.locator('.universal-box input').fill('Create a short plan');
  await page.locator('.universal-box input').press('Enter');
  await page.getByText('Scripted UI reply for: Create a short plan').waitFor({ state: 'visible' });
  await page.locator('.add-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 2);
  const activeTabStyle = await page.locator('.browser-tab.active').evaluate((element) => {
    const style = getComputedStyle(element);
    return { radius: style.borderBottomLeftRadius, transition: style.transitionDuration };
  });
  if (activeTabStyle.radius === '0px' || !activeTabStyle.transition.includes('0.24s')) {
    throw new Error(`Active tab is missing detached rounded motion styling: ${JSON.stringify(activeTabStyle)}`);
  }

  await page.locator('#address-field').fill('OpenAI ChatGPT Atlas');
  await page.locator('#address-field').press('Enter');
  await page.locator('webview').waitFor({ state: 'attached' });
  const searchSource = await page.locator('webview').getAttribute('src');
  if (!searchSource?.startsWith('https://www.google.com/search?q=')) throw new Error(`Address search did not use Google: ${searchSource}`);
  await page.getByRole('button', { name: 'Ask ChatGPT' }).click();
  await page.locator('.side-chat').waitFor({ state: 'visible' });
  const sidebarAnimation = await page.locator('.side-chat').evaluate((element) => getComputedStyle(element).animationName);
  if (sidebarAnimation !== 'side-in') throw new Error(`Sidebar opening animation is missing: ${sidebarAnimation}`);
  await page.locator('.side-chat-header button').first().click();
  await page.locator('.side-chat.closing').waitFor({ state: 'attached' });
  await page.locator('.side-chat').waitFor({ state: 'detached' });

  await page.locator('.add-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 3);
  const dragOrderBefore = await page.locator('.browser-tab').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId));
  await page.locator('.browser-tab').first().dragTo(page.locator('.browser-tab').last());
  await page.waitForTimeout(350);
  const dragOrderAfter = await page.locator('.browser-tab').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId));
  if (dragOrderAfter.at(-1) !== dragOrderBefore[0]) throw new Error(`Tab drag did not reorder tabs: ${JSON.stringify({ dragOrderBefore, dragOrderAfter })}`);

  await page.locator('.browser-tab.active').click({ button: 'right' });
  await page.getByRole('button', { name: 'Add tab to new group' }).click();
  await page.locator('.tab-group-label').waitFor({ state: 'visible' });
  await page.getByLabel('Tab group name').fill('Research');
  await page.keyboard.press('Escape');
  await page.locator('.browser-tab').first().click({ button: 'right' });
  await page.getByRole('button', { name: 'Add to Research' }).click();
  if (await page.locator('.browser-tab.grouped').count() !== 2) throw new Error('Existing tab group did not accept a second tab.');
  await page.locator('.tab-group-label').click();
  await page.locator('.tab-group-label.collapsed').waitFor({ state: 'visible' });
  await page.locator('.tab-group-label').click();
  await page.getByText('Research', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'artifacts/screenshots/tabs-and-groups.png', fullPage: true });

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.locator('.agent-toggle.active').waitFor({ state: 'visible' });
  const agentModeEnabled = true;
  await page.locator('.browser-tab.active .tab-x').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 2);
  await page.locator('.add-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 3);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/screenshots/welcome.png', fullPage: true });

  await page.locator('.browser-tab').filter({ hasText: 'OpenAI ChatGPT Atlas' }).click();
  await page.getByRole('button', { name: 'Ask ChatGPT' }).click();
  await page.evaluate(() => {
    for (const listener of window.__atlasProgressListeners) listener({ state: 'acting', step: 2, action: 'click', message: 'Opening the best result', cursor: { x: 520, y: 285 } });
  });
  await page.locator('.agent-live-cursor').waitFor({ state: 'visible' });
  const agentFieldAnimation = await page.locator('.agent-blue-field').evaluate((element) => getComputedStyle(element).animationName);
  const cursorTransition = await page.locator('.agent-live-cursor').evaluate((element) => getComputedStyle(element).transitionDuration);
  if (agentFieldAnimation !== 'agent-field-breathe' || !cursorTransition.includes('0.52s')) {
    throw new Error(`Agent motion styling is missing: ${JSON.stringify({ agentFieldAnimation, cursorTransition })}`);
  }
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'artifacts/screenshots/agent-in-use.png', fullPage: true });
  console.log(JSON.stringify({
    title: await page.title(),
    tabs: await page.locator('.browser-tab').count(),
    agent_mode: agentModeEnabled,
    fallback_settings: true,
    chat_reply: true,
    google_search: true,
    tab_dragging: true,
    tab_grouping: true,
    agent_cursor: true,
    blue_agent_field: agentFieldAnimation,
    sidebar_motion: sidebarAnimation,
    tab_radius: activeTabStyle.radius,
    screenshots: ['artifacts/screenshots/welcome.png', 'artifacts/screenshots/tabs-and-groups.png', 'artifacts/screenshots/agent-in-use.png']
  }));
} finally {
  await browser.close();
}
