const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { llmConfig, runBrowserAgent } = require('./browser-agent.cjs');
const { fallbackReason, scriptedAssistantResponse } = require('./scripted-fallback.cjs');

const CDP_PORT = Number(process.env.ATLAS_CDP_PORT || 9333);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
app.userAgentFallback = `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

let mainWindow;
let agentRunToken = 0;

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload?.output)) return null;
  return payload.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim() || null;
}

async function requestAssistant(input) {
  const config = llmConfig();
  const prompt = typeof input === 'string' ? input : input?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (!config.apiKey) return scriptedAssistantResponse(input, 'no_key');
  const pageContext = typeof input?.pageContext === 'string' ? input.pageContext.slice(0, 14000) : '';
  const history = Array.isArray(input?.history)
    ? input.history.slice(-12).map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 6000) }))
    : [];
  try {
    const response = await fetch(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        instructions: pageContext
          ? `You are the assistant inside Atlas. Answer using the visible page context when relevant. Page context:\n${pageContext}`
          : 'You are the assistant inside Atlas. Be clear, useful, and concise.',
        input: [...history, { role: 'user', content: prompt.trim() }]
      })
    });
    if (!response.ok) return scriptedAssistantResponse(input, fallbackReason({ status: response.status }));
    const text = extractResponseText(await response.json());
    return text ? { text, fallback: false, mode: 'live' } : scriptedAssistantResponse(input, 'unavailable');
  } catch (error) {
    return scriptedAssistantResponse(input, fallbackReason({ error }));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#f7f7f4',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (process.env.ATLAS_ELECTRON_SMOKE === '1') {
    const timeout = setTimeout(() => {
      process.stderr.write('ATLAS_ELECTRON_SMOKE:renderer timeout\n');
      app.exit(1);
    }, 15000);
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        let result;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          result = await mainWindow.webContents.executeJavaScript(`({
            title: document.title,
            tabs: document.querySelectorAll('.browser-tab').length,
            composer: Boolean(document.querySelector('.universal-box')),
            atlas: Boolean(document.querySelector('.atlas-app'))
          })`);
          if (result.composer && result.atlas) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const passed = result.title === 'Atlas Desk' && result.tabs === 1 && result.composer && result.atlas;
        process.stdout.write(`ATLAS_ELECTRON_SMOKE:${JSON.stringify({ ...result, passed })}\n`);
        clearTimeout(timeout);
        app.exit(passed ? 0 : 1);
      } catch (error) {
        clearTimeout(timeout);
        process.stderr.write(`ATLAS_ELECTRON_SMOKE:${error instanceof Error ? error.message : String(error)}\n`);
        app.exit(1);
      }
    });
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timeout);
      process.stderr.write(`ATLAS_ELECTRON_SMOKE:load failed ${code} ${description}\n`);
      app.exit(1);
    });
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:open-tab', { url });
      }
      return { action: 'deny' };
    });
    contents.on('context-menu', (_menuEvent, params) => {
      if (!params.selectionText?.trim() || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('browser:text-selected', {
        text: params.selectionText.trim().slice(0, 4000),
        pageUrl: params.pageURL
      });
    });
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('system:open-external', (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });
  ipcMain.handle('assistant:respond', async (_event, input) => {
    try {
      return await requestAssistant(input);
    } catch (error) {
      return scriptedAssistantResponse(input, fallbackReason({ error }));
    }
  });
  ipcMain.handle('assistant:status', () => {
    const config = llmConfig();
    return {
      configured: Boolean(config.apiKey),
      mode: config.apiKey ? 'live' : 'scripted',
      model: config.apiKey ? config.model : 'Built-in scripted fallback',
      baseUrl: config.baseUrl
    };
  });
  ipcMain.handle('browser:run-agent-task', async (_event, input) => {
    const token = ++agentRunToken;
    const progress = (payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('browser:agent-progress', payload);
    };
    try {
      return await runBrowserAgent({
        goal: input?.goal,
        preferredUrl: input?.preferredUrl,
        port: CDP_PORT,
        onProgress: progress,
        shouldStop: () => token !== agentRunToken
      });
    } catch (error) {
      const failure = { state: 'error', message: error instanceof Error ? error.message : String(error) };
      progress(failure);
      return failure;
    }
  });
  ipcMain.handle('browser:stop-agent-task', () => {
    agentRunToken += 1;
    return true;
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
