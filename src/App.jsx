import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleStop,
  Clock3,
  Eye,
  EyeOff,
  FileText,
  Globe2,
  History,
  Home,
  Image,
  LockKeyhole,
  Menu,
  Mic,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Square,
  User,
  WandSparkles,
  X
} from 'lucide-react';

const homeSuggestions = [
  { icon: '🧠', label: 'Find holiday recipes', detail: 'Can you suggest some gluten-free recipes for the holidays' },
  { icon: '🌐', label: 'Research holiday gifts', detail: 'I want you to research holiday gift ideas for a country music fan' },
  { icon: '🛩️', label: 'Agent mode', detail: 'Add my holiday meal grocery list to my shopping cart', agent: true },
  { icon: '🗂️', label: 'Finish holiday shopping', detail: 'Pull up product links from recent holiday gift shopping research' }
];

const createTab = () => ({
  id: `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  title: 'New Tab',
  url: '',
  kind: 'new',
  messages: []
});

const initialTab = { id: 'new-tab', title: 'New Tab', url: '', kind: 'new', messages: [] };

function normaliseUrl(value) {
  const clean = value.trim();
  if (/^https?:\/\//i.test(clean)) return clean;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:].*)?$/i.test(clean)) return `https://${clean}`;
  return '';
}

function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function loadMemory() {
  try {
    return JSON.parse(localStorage.getItem('atlas-browser-memory') || '[]');
  } catch {
    return [];
  }
}

function App() {
  const [tabs, setTabs] = useState([initialTab]);
  const [activeTabId, setActiveTabId] = useState(initialTab.id);
  const [address, setAddress] = useState('');
  const [homeQuery, setHomeQuery] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideChatClosing, setSideChatClosing] = useState(false);
  const [sideMessages, setSideMessages] = useState([]);
  const [sideInput, setSideInput] = useState('');
  const [agentMode, setAgentMode] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentActivity, setAgentActivity] = useState([]);
  const [agentStatus, setAgentStatus] = useState('');
  const [siteVisible, setSiteVisible] = useState(true);
  const [loading, setLoading] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memory, setMemory] = useState(loadMemory);
  const [selectedText, setSelectedText] = useState('');
  const [selectionPrompt, setSelectionPrompt] = useState('Make this sound more professional');
  const [llmStatus, setLlmStatus] = useState({ configured: false, mode: 'scripted', model: 'Built-in scripted fallback', baseUrl: '' });
  const [toast, setToast] = useState('');
  const webviewRefs = useRef(new Map());
  const homeInputRef = useRef(null);
  const sideInputRef = useRef(null);
  const sideCloseTimerRef = useRef(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) || tabs[0],
    [tabs, activeTabId]
  );

  useEffect(() => {
    setAddress(activeTab?.url || '');
  }, [activeTabId, activeTab?.url]);

  useEffect(() => {
    localStorage.setItem('atlas-browser-memory', JSON.stringify(memory.slice(0, 200)));
  }, [memory]);

  useEffect(() => {
    window.atlas?.assistant?.status?.().then(setLlmStatus).catch(() => {});
    const removeProgress = window.atlas?.browser?.onAgentProgress?.((progress) => {
      setAgentStatus(progress.message || '');
      if (progress.scripted || progress.fallback_reason) {
        setLlmStatus((current) => ({ ...current, mode: 'scripted', fallbackReason: progress.fallback_reason || current.fallbackReason }));
      }
      if (progress.action || progress.reason) {
        setAgentActivity((current) => [...current, progress].slice(-12));
      }
      setAgentRunning(!['complete', 'stopped', 'error'].includes(progress.state));
      if (progress.state === 'error') notify(progress.message);
    });
    const removeSelection = window.atlas?.browser?.onTextSelected?.((selection) => {
      setSelectedText(selection.text || '');
    });
    const removeOpenTab = window.atlas?.browser?.onOpenTab?.(({ url }) => {
      if (/^https?:\/\//i.test(url || '')) addTab({ kind: 'web', url, title: shortHost(url) });
    });
    return () => {
      removeProgress?.();
      removeSelection?.();
      removeOpenTab?.();
    };
  }, []);

  useEffect(() => () => window.clearTimeout(sideCloseTimerRef.current), []);

  useEffect(() => {
    function handleShortcut(event) {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        document.getElementById('address-field')?.focus();
      }
      if (modifier && event.key.toLowerCase() === 't') {
        event.preventDefault();
        addTab();
      }
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        activeTab.kind === 'new' ? homeInputRef.current?.focus() : openSideChat();
      }
      if (event.key === 'Escape') {
        setProfileOpen(false);
        setMemoryOpen(false);
        setSettingsOpen(false);
        setSelectedText('');
        if (sideChatOpen) closeSideChat();
      }
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  useEffect(() => {
    const view = webviewRefs.current.get(activeTab.id);
    if (!view || activeTab.kind !== 'web') return undefined;
    const tabId = activeTab.id;
    const start = () => setLoading(true);
    const stop = () => setLoading(false);
    const navigate = (event) => {
      setAddress(event.url);
      updateTab(tabId, { url: event.url });
    };
    const title = (event) => {
      const nextTitle = event.title || shortHost(view.getURL());
      updateTab(tabId, { title: nextTitle });
      rememberPage(nextTitle, view.getURL());
    };
    view.addEventListener('did-start-loading', start);
    view.addEventListener('did-stop-loading', stop);
    view.addEventListener('did-navigate', navigate);
    view.addEventListener('did-navigate-in-page', navigate);
    view.addEventListener('page-title-updated', title);
    return () => {
      view.removeEventListener('did-start-loading', start);
      view.removeEventListener('did-stop-loading', stop);
      view.removeEventListener('did-navigate', navigate);
      view.removeEventListener('did-navigate-in-page', navigate);
      view.removeEventListener('page-title-updated', title);
    };
  }, [activeTab.id, activeTab.kind]);

  function notify(message) {
    setToast(message);
    window.setTimeout(() => setToast(''), 2400);
  }

  function animateState(update) {
    if (!document.startViewTransition) {
      update();
      return;
    }
    document.startViewTransition(() => flushSync(update));
  }

  function activeWebview() {
    return webviewRefs.current.get(activeTab.id) || null;
  }

  function registerWebview(tabId, node) {
    if (node) webviewRefs.current.set(tabId, node);
    else webviewRefs.current.delete(tabId);
  }

  function openSideChat() {
    window.clearTimeout(sideCloseTimerRef.current);
    setSideChatClosing(false);
    setSideChatOpen(true);
    window.setTimeout(() => sideInputRef.current?.focus(), 100);
  }

  function closeSideChat() {
    if (!sideChatOpen || sideChatClosing) return;
    setSideChatClosing(true);
    sideCloseTimerRef.current = window.setTimeout(() => {
      setSideChatOpen(false);
      setSideChatClosing(false);
    }, 240);
  }

  function updateTab(id, patch) {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab));
  }

  function rememberPage(title, url) {
    if (!/^https?:\/\//i.test(url)) return;
    setMemory((current) => [
      { id: `memory-${Date.now()}`, title: title || shortHost(url), url, visitedAt: new Date().toISOString() },
      ...current.filter((item) => item.url !== url)
    ].slice(0, 200));
  }

  function addTab(patch = {}) {
    const normalizedPatch = patch.kind === 'web' && patch.url && !patch.src ? { ...patch, src: patch.url } : patch;
    const tab = { ...createTab(), ...normalizedPatch };
    animateState(() => {
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      setSideChatOpen(false);
      setSideChatClosing(false);
    });
    window.setTimeout(() => homeInputRef.current?.focus(), 80);
    return tab.id;
  }

  function closeTab(id, event) {
    event?.stopPropagation();
    const index = tabs.findIndex((tab) => tab.id === id);
    const nextTabs = tabs.length === 1
      ? [{ ...initialTab, id: `tab-${Date.now()}` }]
      : tabs.filter((tab) => tab.id !== id);
    const nextActiveId = id === activeTabId
      ? nextTabs[Math.max(0, Math.min(index - 1, nextTabs.length - 1))].id
      : activeTabId;
    animateState(() => {
      setTabs(nextTabs);
      setActiveTabId(nextActiveId);
    });
  }

  function switchTab(id) {
    if (id === activeTabId) return;
    animateState(() => setActiveTabId(id));
  }

  function openUrl(url, title = shortHost(url), inNewTab = false) {
    if (inNewTab) return addTab({ kind: 'web', url, title });
    const view = activeWebview();
    if (activeTab.kind === 'web' && view) {
      updateTab(activeTab.id, { url, title, messages: [] });
      view.loadURL(url).catch(() => {});
    } else {
      updateTab(activeTab.id, { kind: 'web', url, src: url, title, messages: [] });
    }
    setAddress(url);
    if (sideChatOpen) closeSideChat();
    return activeTab.id;
  }

  function searchGoogle(query) {
    const clean = query.trim();
    if (!clean) return;
    openUrl(`https://www.google.com/search?q=${encodeURIComponent(clean)}`, `${clean} - Google Search`);
  }

  async function submitUniversal(value = homeQuery) {
    const clean = value.trim();
    if (!clean) return;
    const url = normaliseUrl(clean);
    setHomeQuery('');
    if (url) {
      openUrl(url);
      return;
    }
    if (agentMode) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(clean)}`;
      openUrl(searchUrl, 'Agent task');
      openSideChat();
      setAgentRunning(true);
      setAgentActivity([]);
      setAgentStatus('Opening the web…');
      window.setTimeout(() => runAgent(clean, searchUrl), 1400);
      return;
    }
    await startChat(clean);
  }

  async function requestAssistant(prompt, pageContext = '', history = []) {
    const response = await window.atlas?.assistant?.respond?.({ prompt, pageContext, history });
    if (response?.fallback) {
      setLlmStatus((current) => ({ ...current, mode: 'scripted', fallbackReason: response.reason }));
      notify(response.reason === 'credits' ? 'LLM credits unavailable · scripted mode active' : 'Scripted mode active');
    }
    return response?.text || 'Scripted mode is ready. Ask for a page summary, plan, comparison, or draft.';
  }

  async function startChat(prompt) {
    const tabId = activeTab.id;
    const user = { id: `u-${Date.now()}`, role: 'user', content: prompt };
    const waiting = { id: `a-${Date.now()}`, role: 'assistant', content: '', pending: true };
    updateTab(tabId, { kind: 'chat', title: prompt.slice(0, 34), messages: [user, waiting] });
    const reply = await requestAssistant(prompt);
    setTabs((current) => current.map((tab) => tab.id === tabId ? {
      ...tab,
      messages: tab.messages.map((message) => message.id === waiting.id ? { ...message, content: reply, pending: false } : message)
    } : tab));
  }

  async function continueChat() {
    const prompt = chatInput.trim();
    if (!prompt || activeTab.kind !== 'chat') return;
    const tabId = activeTab.id;
    const user = { id: `u-${Date.now()}`, role: 'user', content: prompt };
    const waiting = { id: `a-${Date.now()}`, role: 'assistant', content: '', pending: true };
    const history = [...activeTab.messages, user];
    setChatInput('');
    updateTab(tabId, { messages: [...activeTab.messages, user, waiting] });
    const reply = await requestAssistant(prompt, '', history);
    setTabs((current) => current.map((tab) => tab.id === tabId ? {
      ...tab,
      messages: tab.messages.map((message) => message.id === waiting.id ? { ...message, content: reply, pending: false } : message)
    } : tab));
  }

  async function sendSideMessage(value = sideInput) {
    const prompt = value.trim();
    if (!prompt) return;
    setSideInput('');
    const user = { id: `side-u-${Date.now()}`, role: 'user', content: prompt };
    const waiting = { id: `side-a-${Date.now()}`, role: 'assistant', content: '', pending: true };
    const history = [...sideMessages, user];
    setSideMessages((current) => [...current, user, waiting]);
    let pageContext = '';
    const view = activeWebview();
    if (siteVisible && view) {
      pageContext = await view.executeJavaScript(
        `({title: document.title, url: location.href, text: document.body.innerText.slice(0, 14000)})`,
        true
      ).then((result) => JSON.stringify(result)).catch(() => '');
    }
    const reply = await requestAssistant(prompt, pageContext, history);
    setSideMessages((current) => current.map((message) => message.id === waiting.id ? { ...message, content: reply, pending: false } : message));
  }

  async function runAgent(goal, preferredUrl = activeTab.url) {
    if (!goal.trim()) return;
    setAgentMode(true);
    openSideChat();
    setAgentRunning(true);
    setAgentStatus('Connecting Playwright to this tab…');
    await window.atlas?.browser?.runAgentTask?.({ goal: goal.trim(), preferredUrl });
  }

  function stopAgent() {
    window.atlas?.browser?.stopAgentTask?.();
    setAgentRunning(false);
    setAgentStatus('You have control.');
  }

  async function submitSelection() {
    if (!selectedText) return;
    const prompt = `${selectionPrompt}\n\nSelected text:\n${selectedText}`;
    openSideChat();
    setSideMessages((current) => [...current, { id: `selection-${Date.now()}`, role: 'user', content: selectionPrompt }]);
    setSelectedText('');
    const reply = await requestAssistant(prompt);
    setSideMessages((current) => [...current, { id: `selection-reply-${Date.now()}`, role: 'assistant', content: reply }]);
  }

  function navigateAddress() {
    const url = normaliseUrl(address);
    if (url) openUrl(url);
    else searchGoogle(address);
  }

  const showAskButton = activeTab.kind === 'web' && !sideChatOpen;

  return (
    <div className="atlas-app">
      <header className="browser-top">
        <div className="browser-drag" />
        <div className="traffic-lights">
          <button className="traffic red" aria-label="Close" onClick={() => window.atlas?.window.close()} />
          <button className="traffic yellow" aria-label="Minimize" onClick={() => window.atlas?.window.minimize()} />
          <button className="traffic green" aria-label="Maximize" onClick={() => window.atlas?.window.toggleMaximize()} />
        </div>
        <div className="tabs-row">
          {tabs.map((tab) => (
            <button key={tab.id} style={{ viewTransitionName: `atlas-${tab.id.replace(/[^a-z0-9-]/gi, '-')}` }} className={`browser-tab ${tab.id === activeTabId ? 'active' : ''}`} onClick={() => switchTab(tab.id)}>
              <span className="tab-icon">{tab.kind === 'new' ? <Aperture size={13} /> : tab.kind === 'chat' ? <Aperture size={13} /> : <Globe2 size={12} />}</span>
              <span>{tab.title}</span>
              <span className="tab-x" onClick={(event) => closeTab(tab.id, event)}><X size={12} /></span>
            </button>
          ))}
          <button className="add-tab" onClick={() => addTab()} aria-label="New tab"><Plus size={17} /></button>
        </div>
        <button className="profile-button" onClick={() => setProfileOpen((value) => !value)}><User size={13} /></button>
        {profileOpen && (
          <div className="profile-menu">
            <div className="profile-heading"><span className="profile-circle">A</span><div><strong>Personal</strong><small>{llmStatus.mode === 'live' ? llmStatus.model : 'Scripted fallback'}</small></div></div>
            <button onClick={() => { setMemoryOpen(true); setProfileOpen(false); }}><History size={15} /> History & memories</button>
            <button onClick={() => { setSettingsOpen(true); setProfileOpen(false); }}><Settings size={15} /> Settings</button>
          </div>
        )}
      </header>

      <div className="nav-bar">
        <div className="nav-left">
          <button title="Sidebar"><PanelLeft size={16} /></button>
          <button title="Back" onClick={() => activeWebview()?.goBack()} disabled={activeTab.kind !== 'web'}><ArrowLeft size={16} /></button>
          <button title="Forward" onClick={() => activeWebview()?.goForward()} disabled={activeTab.kind !== 'web'}><ArrowRight size={16} /></button>
          <button title="Reload" onClick={() => activeWebview()?.reload()} disabled={activeTab.kind !== 'web'}><RefreshCw className={loading ? 'spin' : ''} size={15} /></button>
        </div>
        <form className={`address-field ${activeTab.kind === 'new' ? 'new-address' : ''}`} onSubmit={(event) => { event.preventDefault(); navigateAddress(); }}>
          {activeTab.kind === 'web' && <button type="button" className="visibility-button" title={siteVisible ? 'ChatGPT can see this page' : 'Page hidden from ChatGPT'} onClick={() => setSiteVisible((value) => !value)}>{siteVisible ? <Eye size={13} /> : <EyeOff size={13} />}</button>}
          <input id="address-field" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} placeholder={activeTab.kind === 'new' ? '' : 'Search Google or enter address'} />
        </form>
        <div className="nav-right">
          {showAskButton && <button className="ask-button" onClick={openSideChat}><Aperture size={14} /> Ask ChatGPT</button>}
          <button className="nav-more"><MoreHorizontal size={17} /></button>
        </div>
      </div>

      <main className={`browser-stage ${sideChatOpen ? 'with-sidechat' : ''}`}>
        <div className="page-area">
          {activeTab.kind === 'new' && (
            <div className="page-view page-view-active"><NewTabPage
              query={homeQuery}
              agentMode={agentMode}
              inputRef={homeInputRef}
              onQueryChange={setHomeQuery}
              onSubmit={submitUniversal}
              onToggleAgent={() => setAgentMode((value) => !value)}
            /></div>
          )}
          {activeTab.kind === 'chat' && <div className="page-view page-view-active"><FullChatPage tab={activeTab} input={chatInput} onInputChange={setChatInput} onSend={continueChat} /></div>}
          {tabs.filter((tab) => tab.kind === 'web').map((tab) => (
            <div key={tab.id} className={`web-page-shell ${tab.id === activeTabId ? 'active' : ''}`} aria-hidden={tab.id !== activeTabId}>
              <webview ref={(node) => registerWebview(tab.id, node)} src={tab.src || tab.url} partition="persist:atlas-browser" className="browser-webview" allowpopups="true" />
              {tab.id === activeTabId && loading && <div className="load-line" />}
              {tab.id === activeTabId && agentRunning && (
                <div className="agent-control-pill">
                  <span className="agent-site"><Globe2 size={13} /> {shortHost(tab.url)}</span>
                  <span className="agent-task">{agentStatus || 'Working on your task'}</span>
                  <button onClick={stopAgent}>Take control</button>
                  <button className="stop-agent" onClick={stopAgent}>Stop</button>
                </div>
              )}
            </div>
          ))}

          {selectedText && (
            <div className="cursor-assist">
              <span className="cursor-logo"><Aperture size={17} /></span>
              <span className="drag-dots">⠿</span>
              <input value={selectionPrompt} onChange={(event) => setSelectionPrompt(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submitSelection()} />
              <button onClick={submitSelection}><ArrowUp size={19} /></button>
              <button className="dismiss-cursor" onClick={() => setSelectedText('')}><X size={14} /></button>
            </div>
          )}
        </div>

        {sideChatOpen && (
          <SideChat
            closing={sideChatClosing}
            messages={sideMessages}
            input={sideInput}
            inputRef={sideInputRef}
            activeTab={activeTab}
            agentMode={agentMode}
            agentRunning={agentRunning}
            agentActivity={agentActivity}
            agentStatus={agentStatus}
            onClose={closeSideChat}
            onInputChange={setSideInput}
            onSend={() => agentMode ? runAgent(sideInput) : sendSideMessage()}
            onToggleAgent={() => setAgentMode((value) => !value)}
            onStopAgent={stopAgent}
          />
        )}
      </main>

      {memoryOpen && <MemoryDialog memory={memory} onClose={() => setMemoryOpen(false)} onOpen={(item) => { openUrl(item.url, item.title, true); setMemoryOpen(false); }} onClear={() => setMemory([])} />}
      {settingsOpen && <SettingsDialog status={llmStatus} onClose={() => setSettingsOpen(false)} />}
      {toast && <div className="atlas-toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}

function NewTabPage({ query, agentMode, inputRef, onQueryChange, onSubmit, onToggleAgent }) {
  return (
    <section className="new-tab-page">
      <button className="model-selector">ChatGPT 5 <ChevronDown size={15} /></button>
      <div className="new-tab-center">
        <Aperture className="new-tab-logo" size={47} strokeWidth={1.45} />
        <form className="universal-box" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          <button type="button" className="universal-plus"><Plus size={20} /></button>
          <input ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Ask ChatGPT or type URL" />
          <button type="button" className={`agent-toggle ${agentMode ? 'active' : ''}`} onClick={onToggleAgent}><WandSparkles size={15} /> Agent</button>
          <button className="universal-mic" type="button"><Mic size={18} /></button>
          <button className="universal-go" type="submit"><ArrowUp size={17} /></button>
        </form>
        <div className="home-suggestions">
          {homeSuggestions.map((suggestion) => (
            <button key={suggestion.label} onClick={() => { if (suggestion.agent && !agentMode) onToggleAgent(); onSubmit(suggestion.detail); }}>
              <span>{suggestion.icon}</span><strong className={suggestion.agent ? 'agent-label' : ''}>{suggestion.label}</strong><em>—</em><small>{suggestion.detail}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function FullChatPage({ tab, input, onInputChange, onSend }) {
  return (
    <section className="full-chat-page">
      <div className="chat-page-top">
        <button className="model-selector inline">ChatGPT 5 <ChevronDown size={15} /></button>
        <div className="chat-sections"><button className="active"><Home size={20} /></button><button><Globe2 size={20} /></button><button><Image size={20} /></button><button><ShoppingBag size={20} /></button><button><FileText size={20} /></button></div>
      </div>
      <div className="chat-thread">
        {tab.messages.map((message) => (
          <div key={message.id} className={`full-message ${message.role}`}>
            {message.role === 'assistant' && <Aperture size={20} />}
            <div>{message.pending ? <span className="typing-pulse">Thinking</span> : <FormattedText text={message.content} />}</div>
          </div>
        ))}
      </div>
      <div className="full-chat-composer-wrap">
        <div className="full-chat-composer"><button><Plus size={19} /></button><textarea value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder="Ask anything" /><button><Mic size={17} /></button><button className="full-chat-send" onClick={onSend}><ArrowUp size={17} /></button></div>
      </div>
    </section>
  );
}

function SideChat({ closing, messages, input, inputRef, activeTab, agentMode, agentRunning, agentActivity, agentStatus, onClose, onInputChange, onSend, onToggleAgent, onStopAgent }) {
  return (
    <aside className={`side-chat ${closing ? 'closing' : ''}`}>
      <div className="side-chat-header"><button onClick={onClose}><ChevronLeft size={17} /></button><span>ChatGPT</span><button><Menu size={18} /></button></div>
      <div className="side-chat-scroll">
        <div className="source-pill"><Globe2 size={13} /> {activeTab.kind === 'web' ? shortHost(activeTab.url) : 'Current tab'}</div>
        {messages.length === 0 && !agentRunning && (
          <div className="side-empty"><Aperture size={31} /><h2>Ask about this page</h2><p>Summarize, explain, compare, or turn on agent mode to take action.</p></div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`side-message ${message.role}`}>
            {message.pending ? <span className="typing-pulse">Thinking</span> : <FormattedText text={message.content} />}
          </div>
        ))}
        {(agentRunning || agentActivity.length > 0) && (
          <div className="agent-activity">
            <div className="agent-activity-title"><Globe2 size={14} /><span>{agentStatus || 'Agent activity'}</span></div>
            {agentActivity.map((item, index) => <div key={`${item.step}-${index}`} className="agent-step"><span>{item.step}</span><p>{item.message || item.reason}</p></div>)}
            {agentRunning && <button className="take-control" onClick={onStopAgent}>Take control</button>}
          </div>
        )}
      </div>
      <div className="side-composer">
        <div className="source-chip"><Globe2 size={12} /> {activeTab.kind === 'web' ? shortHost(activeTab.url) : 'ChatGPT'}</div>
        <textarea ref={inputRef} value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={agentMode ? 'Describe a task' : 'Ask ChatGPT'} />
        <div className="side-composer-actions"><button><Plus size={19} /></button><button className={agentMode ? 'active-agent' : ''} onClick={onToggleAgent}><WandSparkles size={15} /> Agent</button><button><Globe2 size={15} /> Sources <ChevronDown size={13} /></button><button className="side-send" onClick={onSend}>{agentRunning ? <Square size={13} fill="currentColor" /> : <ArrowUp size={17} />}</button></div>
      </div>
    </aside>
  );
}

function FormattedText({ text }) {
  return String(text || '').split('\n').map((line, index) => line ? <p key={index}>{line}</p> : <div key={index} className="text-gap" />);
}

function MemoryDialog({ memory, onClose, onOpen, onClear }) {
  return (
    <div className="modal-shade" onMouseDown={onClose}>
      <section className="memory-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p>Browser memories</p><h2>History</h2></div><button onClick={onClose}><X size={18} /></button></header>
        <div className="memory-list">
          {memory.length === 0 && <div className="empty-memory"><History size={28} /><p>Pages you visit will appear here.</p></div>}
          {memory.map((item) => <button key={item.id} onClick={() => onOpen(item)}><span className="memory-favicon"><Globe2 size={14} /></span><span><strong>{item.title}</strong><small>{item.url}</small></span><ArrowRight size={15} /></button>)}
        </div>
        <footer><p>Deleting history also removes its browser memories.</p><button onClick={onClear}>Clear history</button></footer>
      </section>
    </div>
  );
}

function SettingsDialog({ status, onClose }) {
  const live = status.mode === 'live';
  return (
    <div className="modal-shade" onMouseDown={onClose}>
      <section className="settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p>Atlas settings</p><h2>LLM connection</h2></div><button onClick={onClose}><X size={18} /></button></header>
        <div className={`connection-status ${live ? 'connected' : 'scripted'}`}><span>{live ? <Check size={17} /> : <WandSparkles size={17} />}</span><div><strong>{live ? 'LLM ready' : 'Scripted fallback ready'}</strong><p>{live ? `${status.model} via ${status.baseUrl}` : status.fallbackReason === 'credits' ? 'The LLM ran out of credits. Atlas switched automatically.' : 'Atlas works without a key for page summaries, basic writing, and bounded browser actions.'}</p></div></div>
        <div className="settings-note"><ShieldCheck size={17} /><p>The credential stays in Electron’s main process. Page context and agent snapshots are sent only when you ask ChatGPT or start agent mode.</p></div>
        <div className="env-list"><code>ATLAS_LLM_API_KEY</code><code>ATLAS_LLM_MODEL</code><code>ATLAS_LLM_BASE_URL</code></div>
      </section>
    </div>
  );
}

export default App;
