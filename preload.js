const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* config + system */
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:set', c),
  getMemory: () => ipcRenderer.invoke('sys:mem'),
  setOverlay: (c) => ipcRenderer.send('win:overlay', c),
  detectJava: () => ipcRenderer.invoke('java:detect'),
  managedJava: () => ipcRenderer.invoke('java:managed'),
  installJava: (c) => ipcRenderer.invoke('java:install', c),
  onJavaProgress: (cb) => ipcRenderer.on('java:progress', (_e, d) => cb(d)),
  pingServer: (a) => ipcRenderer.invoke('servers:ping', a),
  hubCurse: (o) => ipcRenderer.invoke('net:curseforge', o),
  testCurse: () => ipcRenderer.invoke('cf:test'),
  removeJava: (c) => ipcRenderer.invoke('java:remove', c),
  storageInfo: () => ipcRenderer.invoke('storage:info'),
  categories: (t) => ipcRenderer.invoke('net:categories', t),
  pickFile: () => ipcRenderer.invoke('pick:file'),
  pickDir: () => ipcRenderer.invoke('pick:dir'),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  /* window controls */
  min: () => ipcRenderer.send('win:min'),
  max: () => ipcRenderer.send('win:max'),
  close: () => ipcRenderer.send('win:close'),
  toggleFullscreen: () => ipcRenderer.send('win:fullscreen'),
  winState: () => ipcRenderer.invoke('win:state'),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),

  /* game */
  versions: () => ipcRenderer.invoke('versions:list'),
  launch: (o) => ipcRenderer.invoke('launch', o),
  kill: () => ipcRenderer.invoke('kill'),
  openCrashReport: () => ipcRenderer.invoke('crash:open-report'),
  uploadCrashLog: () => ipcRenderer.invoke('crash:upload'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('done', (_e, d) => cb(d)),

  /* instances */
  listInstances: () => ipcRenderer.invoke('instances:list'),
  createInstance: (data) => ipcRenderer.invoke('instances:create', data),
  deleteInstance: (id) => ipcRenderer.invoke('instances:delete', id),
  renameInstance: (id, name) => ipcRenderer.invoke('instances:rename', { id, name }),
  openInstanceFolder: (id) => ipcRenderer.invoke('open:instance-folder', id),

  /* dashboard data */
  stats: () => ipcRenderer.invoke('stats:get'),
  hub: (opts) => ipcRenderer.invoke('net:modrinth', opts),
  news: () => ipcRenderer.invoke('net:news'),
  installContent: (o) => ipcRenderer.invoke('content:install', o),
  cancelInstall: () => ipcRenderer.invoke('install:cancel'),
  worlds: (id) => ipcRenderer.invoke('instances:worlds', id),
  contentList: (o) => ipcRenderer.invoke('content:list', o),
  contentToggle: (o) => ipcRenderer.invoke('content:toggle', o),
  contentRemove: (o) => ipcRenderer.invoke('content:remove', o),
  contentUpdates: (o) => ipcRenderer.invoke('content:updates', o),
  contentUpdate: (o) => ipcRenderer.invoke('content:update', o),
  importMrpack: () => ipcRenderer.invoke('modpack:import-file'),
  copyInstance: (id) => ipcRenderer.invoke('instances:copy', id),
  setInstanceSettings: (id, settings) => ipcRenderer.invoke('instances:settings', { id, settings }),
  installModpack: (o) => ipcRenderer.invoke('modpack:install', o),
  onInstall: (cb) => ipcRenderer.on('install:progress', (_e, d) => cb(d))
});
