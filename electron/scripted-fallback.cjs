const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'do', 'for', 'from', 'in', 'it', 'me', 'my', 'of', 'on',
  'please', 'the', 'this', 'to', 'with', 'you'
]);

function fallbackReason({ status, error, missingKey = false } = {}) {
  if (missingKey) return 'no_key';
  if (status === 402 || status === 429) return 'credits';
  if (status === 401 || status === 403) return 'access';
  const message = String(error?.message || error || '').toLowerCase();
  if (/quota|credit|billing|rate.?limit/.test(message)) return 'credits';
  if (/fetch|network|connect|timed? ?out|offline/.test(message)) return 'offline';
  return 'unavailable';
}

function parsePageContext(pageContext) {
  if (!pageContext) return { title: '', url: '', text: '' };
  try {
    const parsed = JSON.parse(pageContext);
    return {
      title: String(parsed?.title || '').trim(),
      url: String(parsed?.url || '').trim(),
      text: String(parsed?.text || '').replace(/\s+/g, ' ').trim()
    };
  } catch {
    return { title: '', url: '', text: String(pageContext).replace(/\s+/g, ' ').trim() };
  }
}

function sentences(text, limit = 3) {
  const parts = String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 24);
  return parts.slice(0, limit).map((part) => part.slice(0, 280));
}

function scriptedAssistantResponse(input, reason = 'no_key') {
  const prompt = String(typeof input === 'string' ? input : input?.prompt || '').trim();
  const context = parsePageContext(typeof input === 'object' ? input?.pageContext : '');
  const lower = prompt.toLowerCase();
  const label = reason === 'credits'
    ? 'The connected LLM has no available credits, so Atlas switched to scripted mode.'
    : reason === 'no_key'
      ? 'No LLM is connected, so Atlas is using its built-in scripted mode.'
      : 'The LLM is unavailable, so Atlas switched to its built-in scripted mode.';

  let body;
  if (context.text && /summari[sz]e|summary|what.+page|key points|tldr|tl;dr/.test(lower)) {
    const points = sentences(context.text, 3);
    body = [
      context.title ? `Page: ${context.title}` : 'Page summary',
      ...points.map((point) => `• ${point}`),
      context.url ? `Source: ${context.url}` : ''
    ].filter(Boolean).join('\n');
  } else if (context.text && /explain|meaning|understand/.test(lower)) {
    const excerpt = sentences(context.text, 2).join(' ');
    body = `The visible page is about ${context.title || 'the current topic'}. Based on the page text: ${excerpt || context.text.slice(0, 420)}`;
  } else if (/plan|steps|how (?:do|can|should)|research/.test(lower)) {
    const subject = prompt.replace(/^(please\s+)?(make|create|give me|research)\s+/i, '').slice(0, 180);
    body = [
      `A practical scripted plan for “${subject || prompt}”:`,
      '1. Define the exact result and any limits.',
      '2. Gather the required facts or inputs.',
      '3. Complete the smallest useful version.',
      '4. Check the result against the original request and refine it.'
    ].join('\n');
  } else if (/compare|versus|\bvs\b|difference/.test(lower)) {
    body = [
      `Scripted comparison outline for “${prompt.slice(0, 180)}”:`,
      '• Compare the options on purpose, cost, ease of use, limits, and support.',
      '• Test the deciding workflow with the same input.',
      '• Choose the option whose tradeoffs fit the actual use case.'
    ].join('\n');
  } else if (/write|rewrite|draft|professional|email|message/.test(lower)) {
    const selected = prompt.match(/Selected text:\s*([\s\S]+)/i)?.[1]?.trim();
    body = selected
      ? `Suggested revision:\n${selected.replace(/\s+/g, ' ').replace(/^./, (character) => character.toUpperCase())}`
      : `Scripted drafting mode is ready for “${prompt.slice(0, 180)}”. Add the audience, desired tone, and facts that must be included for a more specific draft.`;
  } else if (context.text) {
    const excerpt = sentences(context.text, 2).join(' ');
    body = `From ${context.title || 'the visible page'}: ${excerpt || context.text.slice(0, 420)}`;
  } else {
    body = `I can keep the interface usable in scripted mode. For “${prompt.slice(0, 220) || 'this request'}”, connect an OpenAI-compatible Responses API for a generated answer; until then, the built-in mode can summarize visible pages and create basic plans, comparisons, and drafts.`;
  }

  return {
    text: `${label}\n\n${body}`,
    fallback: true,
    mode: 'scripted',
    reason
  };
}

function words(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) || [];
}

function fillValueFromGoal(goal) {
  const quoted = String(goal).match(/["“]([^"”]{1,160})["”]/)?.[1];
  if (quoted) return quoted;
  const directed = String(goal).match(/(?:enter|type|search(?: for)?|find)\s+(.+?)(?:\s+(?:and|then)\s+|[.!?]|$)/i)?.[1];
  return (directed || goal).trim().slice(0, 240);
}

function scoreElement(element, keywords) {
  const haystack = `${element.text || ''} ${element.role || ''} ${element.type || ''}`.toLowerCase();
  return keywords.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

function scriptedAgentAction(goal, step, snapshot, activity = [], reason = 'no_key') {
  const interactive = Array.isArray(snapshot?.interactive) ? snapshot.interactive : [];
  const last = activity.at(-1);
  const base = { scripted: true, fallback_reason: reason };
  const absoluteUrl = String(goal).match(/https?:\/\/[^\s)]+/i)?.[0]?.replace(/[.,]+$/, '');

  if (!last && absoluteUrl && snapshot?.url !== absoluteUrl) {
    return { ...base, action: 'goto', target: null, value: absoluteUrl, reason: 'Scripted mode is opening the URL from the task.', summary: '' };
  }

  if (last?.action === 'fill') {
    const submit = interactive.find((element) =>
      ['button', 'a'].includes(element.tag) && /search|submit|run|go|continue|next|send|add|apply/i.test(element.text || '')
    );
    if (submit) {
      return { ...base, action: 'click', target: submit.index, value: '', reason: `Scripted mode is activating “${submit.text || 'the next control'}”.`, summary: '' };
    }
    return { ...base, action: 'press', target: last.target, value: 'Enter', reason: 'Scripted mode is submitting the filled field.', summary: '' };
  }

  if (last && ['click', 'press'].includes(last.action)) {
    return {
      ...base,
      action: 'finish',
      target: null,
      value: '',
      reason: 'The scripted interaction completed.',
      summary: 'Scripted browser task completed. Connect LLM credits for open-ended planning and multi-step decisions.'
    };
  }

  if (last?.action === 'wait' || step >= 4) {
    return {
      ...base,
      action: 'finish',
      target: null,
      value: '',
      reason: 'Scripted mode reached its safe stopping point.',
      summary: 'Scripted preview finished. Connect LLM credits for open-ended planning on this page.'
    };
  }

  const textInputs = interactive.filter((element) =>
    element.tag === 'textarea' || element.role === 'textbox' || (element.tag === 'input' && !/button|checkbox|radio|submit|file|color|range|date/i.test(element.type || 'text'))
  );
  const keywords = words(goal);
  const input = textInputs
    .map((element) => ({ element, score: scoreElement(element, keywords) + (/search/i.test(`${element.text} ${element.type}`) ? 1 : 0) }))
    .sort((left, right) => right.score - left.score)[0]?.element;
  if (input) {
    return {
      ...base,
      action: 'fill',
      target: input.index,
      value: fillValueFromGoal(goal),
      reason: `Scripted mode is filling “${input.text || 'the visible text field'}”.`,
      summary: ''
    };
  }

  const clickable = interactive
    .filter((element) => ['a', 'button'].includes(element.tag) || element.role === 'button')
    .map((element) => ({ element, score: scoreElement(element, keywords) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0]?.element;
  if (clickable) {
    return { ...base, action: 'click', target: clickable.index, value: '', reason: `Scripted mode matched “${clickable.text || 'a visible control'}” to the task.`, summary: '' };
  }

  return { ...base, action: 'wait', target: null, value: 700, reason: 'Scripted mode is waiting for the visible page to settle.', summary: '' };
}

module.exports = {
  fallbackReason,
  scriptedAgentAction,
  scriptedAssistantResponse
};
