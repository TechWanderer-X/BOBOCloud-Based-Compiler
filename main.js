const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let watchers = new Map();
let win;
let workspaceRoot = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder...', accelerator: 'Ctrl+O', click: pickAndOpenWorkspace },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Server Settings',
          click: () => {
            win.webContents.send('open-server-settings');
          }
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}



app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const watcher of watchers.values()) {
    try { watcher.close(); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function pickAndOpenWorkspace() {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths[0]) {
    openWorkspace(result.filePaths[0]);
  }
}

function openWorkspace(folderPath) {
  workspaceRoot = folderPath;
  const tree = readTree(folderPath);
  win.webContents.send('workspace-opened', { rootPath: folderPath, tree });
  watchFolderRecursive(folderPath);
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Read directory recursively
function readTree(dirPath) {
  const stat = safeStat(dirPath);
  if (!stat || !stat.isDirectory()) return null;

  const node = {
    name: path.basename(dirPath),
    path: dirPath,
    type: 'folder',
    children: []
  };

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      node.children.push(readTree(full));
    } else if (entry.isFile()) {
      node.children.push({
        name: entry.name,
        path: full,
        type: 'file'
      });
    }
  }
  return node;
}

// Watch folder recursively and notify renderer
function watchFolderRecursive(root) {
  // clear existing watchers first
  for (const [p, w] of [...watchers]) {
    if (p.startsWith(root)) {
      try { w.close(); } catch {}
      watchers.delete(p);
    }
  }
  attachWatcher(root);
}

function attachWatcher(dir) {
  if (watchers.has(dir)) return;
  const watcher = fs.watch(dir, { recursive: false }, (_eventType, filename) => {
    // Emit a lightweight change signal; renderer will rebuild tree but preserve expansion state
    const rootPath = workspaceRoot || dir;
    const fullTree = readTree(rootPath);
    win.webContents.send('workspace-refresh', { rootPath, tree: fullTree });
    // Add watcher for new subfolder
    const subPath = filename ? path.join(dir, filename) : null;
    const st = subPath ? safeStat(subPath) : null;
    if (st && st.isDirectory()) {
      attachWatcher(subPath);
    }
  });
  watchers.set(dir, watcher);

  // Attach watchers to subfolders
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      attachWatcher(path.join(dir, entry.name));
    }
  }
}

// IPC handlers

ipcMain.handle('pick-workspace', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = result.filePaths[0];
  const tree = readTree(folder);
  watchFolderRecursive(folder);
  workspaceRoot = folder;
  return { rootPath: folder, tree };
});

ipcMain.handle('read-file', async (_e, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('save-file', async (_e, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('create-file', async (_e, { parentDir, name }) => {
  const full = path.join(parentDir, name);
  fs.writeFileSync(full, '', 'utf-8');
  return { path: full };
});

ipcMain.handle('create-folder', async (_e, { parentDir, name }) => {
  const full = path.join(parentDir, name);
  fs.mkdirSync(full, { recursive: true });
  return { path: full };
});

ipcMain.handle('rename-entry', async (_e, { oldPath, newName }) => {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  fs.renameSync(oldPath, newPath);
  return { path: newPath };
});

ipcMain.handle('delete-entry', async (_e, { entryPath }) => {
  const stat = safeStat(entryPath);
  if (!stat) return false;
  if (stat.isDirectory()) {
    fs.rmSync(entryPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(entryPath);
  }
  return true;
});
