const { chromium } = require('playwright-core');
const { fallbackReason, scriptedAgentAction } = require('./scripted-fallback.cjs');

const MAX_STEPS = 12;
let browserConnection;

function llmConfig() {
  return {
    apiKey: process.env.ATLAS_LLM_API_KEY || process.env.ATLAS_OPENAI_API_KEY || '',
    baseUrl: (process.env.ATLAS_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.ATLAS_LLM_MODEL || process.env.ATLAS_OPENAI_MODEL || 'gpt-5-mini'
  };
}

function extractText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload?.output)) return '';
  return payload.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function parseAction(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return an agent action.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callAgentModel(goal, step, snapshot, activity) {
  const config = llmConfig();
  if (!config.apiKey) return scriptedAgentAction(goal, step, snapshot, activity, 'no_key');
  try {
    const response = await fetch(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        instructions: [
          'You control one visible browser page through Playwright.',
          'Choose exactly one next action that advances the user goal.',
          'Use only the indexed interactive elements from the snapshot.',
          'Return JSON only with action, target, value, reason, and summary.',
          'action must be one of click, fill, press, goto, back, wait, finish.',
          'Use finish only when the goal is complete or cannot safely continue.',
          'For goto, value must be an absolute http or https URL.',
          'For press, target is an element index and value is a Playwright key such as Enter.'
        ].join(' '),
        input: JSON.stringify({ goal, step, snapshot, recent_activity: activity.slice(-5) })
      })
    });
    if (!response.ok) {
      return scriptedAgentAction(goal, step, snapshot, activity, fallbackReason({ status: response.status }));
    }
    return parseAction(extractText(await response.json()));
  } catch (error) {
    return scriptedAgentAction(goal, step, snapshot, activity, fallbackReason({ error }));
  }
}

async function connectToElectron(port) {
  if (browserConnection?.isConnected()) return browserConnection;
  browserConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browserConnection;
}

function pageScore(page, preferredUrl) {
  const url = page.url();
  if (!/^https?:\/\//i.test(url)) return -1;
  if (preferredUrl && url === preferredUrl) return 5;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return -1;
  try {
    if (preferredUrl && new URL(url).origin === new URL(preferredUrl).origin) return 4;
  } catch {
    // Keep the page as a generic HTTP candidate.
  }
  return 1;
}

async function findVisiblePage(port, preferredUrl) {
  const browser = await connectToElectron(port);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const ranked = pages
    .map((page) => ({ page, score: pageScore(page, preferredUrl) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) throw new Error('Open a webpage in Atlas before starting agent mode.');
  return ranked[0].page;
}

async function snapshotPage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  const interactive = await page.locator('a,button,input,textarea,select,[role="button"],[contenteditable="true"]').evaluateAll((elements) => {
    const result = [];
    let index = 0;
    for (const element of elements) {
      element.removeAttribute('data-atlas-agent-id');
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || rect.width < 2 || rect.height < 2) continue;
      element.setAttribute('data-atlas-agent-id', String(index));
      result.push({
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        type: element.getAttribute('type') || '',
        text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || '').trim().slice(0, 180),
        value: 'value' in element ? String(element.value || '').slice(0, 120) : '',
        href: element instanceof HTMLAnchorElement ? element.href.slice(0, 240) : ''
      });
      index += 1;
      if (result.length >= 80) break;
    }
    return result;
  });
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: bodyText.replace(/\s+/g, ' ').slice(0, 9000),
    interactive
  };
}

async function performAction(page, action) {
  const kind = action?.action;
  if (kind === 'finish') return { finished: true, summary: action.summary || action.reason || 'Task finished.' };
  if (kind === 'wait') {
    await page.waitForTimeout(Math.min(4000, Math.max(300, Number(action.value) || 900)));
    return { finished: false };
  }
  if (kind === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
    return { finished: false };
  }
  if (kind === 'goto') {
    const url = String(action.value || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Agent navigation requires an absolute HTTP(S) URL.');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return { finished: false };
  }
  const index = Number(action.target);
  if (!Number.isInteger(index) || index < 0) throw new Error('The model selected an invalid element.');
  const locator = page.locator(`[data-atlas-agent-id="${index}"]`);
  if (kind === 'click') await locator.click({ timeout: 7000 });
  else if (kind === 'fill') await locator.fill(String(action.value || ''), { timeout: 7000 });
  else if (kind === 'press') await locator.press(String(action.value || 'Enter'), { timeout: 7000 });
  else throw new Error(`Unsupported agent action: ${String(kind)}`);
  await page.waitForTimeout(450);
  return { finished: false };
}

async function runBrowserAgent({ goal, preferredUrl, port, onProgress, shouldStop = () => false }) {
  if (typeof goal !== 'string' || !goal.trim()) throw new Error('Describe what you want the browser to do.');
  const page = await findVisiblePage(port, preferredUrl);
  const activity = [];
  let usedScriptedFallback = false;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (shouldStop()) {
      const stopped = { state: 'stopped', step, message: 'Agent stopped. You have control.', activity, url: page.url() };
      onProgress(stopped);
      return stopped;
    }
    const snapshot = await snapshotPage(page);
    onProgress({ state: 'thinking', step, message: `Reading ${snapshot.title || snapshot.url}` });
    const action = await callAgentModel(goal.trim(), step, snapshot, activity);
    usedScriptedFallback ||= Boolean(action.scripted);
    const record = {
      step,
      action: action.action,
      target: action.target,
      value: action.value,
      scripted: Boolean(action.scripted),
      fallback_reason: action.fallback_reason || '',
      reason: action.reason || '',
      message: action.reason || `${action.action} on the page`
    };
    activity.push(record);
    onProgress({ state: 'acting', ...record });
    const result = await performAction(page, action);
    if (result.finished) {
      const completed = { state: 'complete', step, message: result.summary, activity, url: page.url(), scripted: usedScriptedFallback };
      onProgress(completed);
      return completed;
    }
  }
  const stopped = { state: 'stopped', step: MAX_STEPS, message: 'Stopped after the maximum number of steps.', activity, url: page.url() };
  onProgress(stopped);
  return stopped;
}

module.exports = { llmConfig, runBrowserAgent };
