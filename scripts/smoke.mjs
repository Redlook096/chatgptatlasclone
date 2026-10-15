import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.ATLAS_CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
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
          onAgentProgress: () => () => {},
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
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.locator('.agent-toggle.active').waitFor({ state: 'visible' });
  await page.locator('.browser-tab.active .tab-x').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 2);
  await page.locator('.add-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 3);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'preview.png', fullPage: true });
  console.log(JSON.stringify({
    title: await page.title(),
    tabs: await page.locator('.browser-tab').count(),
    agent_mode: await page.locator('.agent-toggle.active').count() === 1,
    fallback_settings: true,
    chat_reply: true,
    google_search: true,
    sidebar_motion: sidebarAnimation,
    tab_radius: activeTabStyle.radius,
    screenshot: 'preview.png'
  }));
} finally {
  await browser.close();
}
