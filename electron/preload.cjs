const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atlas', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  assistant: {
    respond: (input) => ipcRenderer.invoke('assistant:respond', input),
    status: () => ipcRenderer.invoke('assistant:status')
  },
  browser: {
    runAgentTask: (input) => ipcRenderer.invoke('browser:run-agent-task', input),
    stopAgentTask: () => ipcRenderer.invoke('browser:stop-agent-task'),
    onAgentProgress: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('browser:agent-progress', handler);
      return () => ipcRenderer.removeListener('browser:agent-progress', handler);
    },
    onTextSelected: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('browser:text-selected', handler);
      return () => ipcRenderer.removeListener('browser:text-selected', handler);
    },
    onOpenTab: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('browser:open-tab', handler);
      return () => ipcRenderer.removeListener('browser:open-tab', handler);
    }
  },
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url)
});
