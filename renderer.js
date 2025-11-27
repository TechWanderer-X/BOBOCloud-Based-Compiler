require.config({ paths: { 'vs': './node_modules/monaco-editor/min/vs' } });

let editor;

// Workspace and explorer state
let workspaceRoot = null;
let expandedPaths = new Set();
const ALWAYS_COLLAPSED = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);

// Tabs state
let tabs = []; // { path, name, model, language, dirty }
let activeTabPath = null;

// UI references
let contextMenuEl = null;

require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(document.getElementById('container'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true
  });

  registerCompletionProviders();

  monaco.editor.onDidCreateModel((model) => {
    model.onDidChangeContent(() => {
      const t = tabs.find(t => t.model === model);
      if (t && !t.dirty) {
        t.dirty = true;
        updateTabbar();
        updateTitlebar();
      }
    });
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveActiveTab();
  });

  document.getElementById('open-folder').addEventListener('click', async () => {
    const res = await window.api.pickWorkspace();
    if (!res) return;
    applyWorkspace(res.rootPath, res.tree);
  });

  document.getElementById('save-file').addEventListener('click', () => {
    saveActiveTab();
  });

  // Run 按钮
  document.getElementById('run-code').addEventListener('click', () => {
    const active = tabs.find(t => t.path === activeTabPath);
    if (!active) return;
    runCodeOnServer(active.path, active.model.getValue());
  });

  // Server Settings 弹窗
  window.api.onOpenServerSettings(() => {
    document.getElementById('server-modal').style.display = 'block';
  });

  document.getElementById('server-save').onclick = () => {
    const config = {
      ip: document.getElementById('server-ip').value,
      user: document.getElementById('server-user').value,
      pass: document.getElementById('server-pass').value
    };
    connectServer(config);
    syncWorkspace();
    document.getElementById('server-modal').style.display = 'none';
  };

  document.getElementById('server-close').onclick = () => {
    document.getElementById('server-modal').style.display = 'none';
  };

  window.api.onWorkspaceOpened(({ rootPath, tree }) => applyWorkspace(rootPath, tree));
  window.api.onWorkspaceRefresh(({ rootPath, tree }) => {
    if (rootPath === workspaceRoot) renderTree(tree);
  });

  document.getElementById('workspace-label').textContent = 'No folder opened';
});

// ===== Workspace & Tree =====
function applyWorkspace(rootPath, tree) {
  workspaceRoot = rootPath;
  document.getElementById('workspace-label').textContent = rootPath;
  expandedPaths.clear();
  expandedPaths.add(rootPath);
  renderTree(tree);
}

function renderTree(tree) {
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  const rootUl = document.createElement('ul');
  container.appendChild(rootUl);
  rootUl.appendChild(createTreeItem(tree));
  document.addEventListener('click', closeContextMenu);
}

function createTreeItem(node) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'item ' + (node.type === 'folder' ? 'folder' : 'file');

  const icon = document.createElement('span');
  const name = document.createElement('span');
  name.textContent = node.name;

  const isAlwaysCollapsed = node.type === 'folder' && ALWAYS_COLLAPSED.has(node.name);
  const isExpanded = node.type === 'folder'
    ? expandedPaths.has(node.path) && !isAlwaysCollapsed
    : false;

  icon.textContent = node.type === 'folder'
    ? (isExpanded ? '▾' : '▸')
    : '•';

  row.appendChild(icon);
  row.appendChild(name);
  li.appendChild(row);

  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  };

  if (node.type === 'file') {
    row.onclick = () => openFile(node.path, node.name);
  } else {
    row.onclick = () => {
      const expanded = expandedPaths.has(node.path);
      if (expanded && !isAlwaysCollapsed) {
        expandedPaths.delete(node.path);
      } else {
        expandedPaths.add(node.path);
      }
      const updated = createTreeItem(node);
      li.replaceWith(updated);
    };

    const childrenContainer = document.createElement('ul');
    childrenContainer.style.paddingLeft = '14px';
    li.appendChild(childrenContainer);

    if (isExpanded && node.children && node.children.length) {
      for (const child of node.children) {
        childrenContainer.appendChild(createTreeItem(child));
      }
    }
  }

  return li;
}

function openContextMenu(x, y, node) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const addAction = (label, handler) => {
    const a = document.createElement('div');
    a.className = 'action';
    a.textContent = label;
    a.onclick = () => { handler(); closeContextMenu(); };
    menu.appendChild(a);
  };

  if (node.type === 'folder') {
    addAction('New File', () => promptCreate(node.path, 'file'));
    addAction('New Folder', () => promptCreate(node.path, 'folder'));
  }
  addAction('Rename', () => promptRename(node.path));
  addAction('Delete', () => promptDelete(node.path, node.type));

  document.body.appendChild(menu);
  contextMenuEl = menu;
}

function closeContextMenu() {
  if (contextMenuEl && contextMenuEl.parentNode) {
    contextMenuEl.parentNode.removeChild(contextMenuEl);
  }
  contextMenuEl = null;
}

function promptCreate(parentDir, type) {
  const container = document.getElementById('file-tree');
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.placeholder = type === 'file' ? 'newFile.py' : 'NewFolder';
  container.prepend(input);
  input.focus();

  input.onkeydown = async (e) => {
    if (e.key === 'Enter') {
      const name = input.value.trim();
      if (!name) return cleanup();
      try {
        if (type === 'file') {
          await window.api.createFile({ parentDir, name });
        } else {
          await window.api.createFolder({ parentDir, name });
        }
      } finally {
        cleanup();
        const res = await window.api.pickWorkspace();
        if (res && res.rootPath === workspaceRoot) renderTree(res.tree);
      }
    } else if (e.key === 'Escape') {
      cleanup();
    }
  };

  function cleanup() {
    if (input && input.parentNode) input.parentNode.removeChild(input);
  }
}

function promptRename(oldPath) {
  const base = oldPath.split(/[/\\]/).pop();
  const container = document.getElementById('file-tree');
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.value = base;
  container.prepend(input);
  input.focus();

  input.onkeydown = async (e) => {
    if (e.key === 'Enter') {
      const newName = input.value.trim();
      if (!newName || newName === base) return cleanup();
      try {
        await window.api.renameEntry({ oldPath, newName });
      } finally {
        cleanup();
        const res = await window.api.pickWorkspace();
        if (res && res.rootPath === workspaceRoot) renderTree(res.tree);
      }
    } else if (e.key === 'Escape') {
      cleanup();
    }
  };

  function cleanup() {
    if (input && input.parentNode) input.parentNode.removeChild(input);
  }
}

async function promptDelete(entryPath, type) {
  const ok = confirm(`Delete ${type}:\n${entryPath}\nThis cannot be undone.`);
  if (!ok) return;
  await window.api.deleteEntry({ entryPath });
  const res = await window.api.pickWorkspace();
  if (res && res.rootPath === workspaceRoot) renderTree(res.tree);
}

// ===== Tabs =====
async function openFile(filePath, name) {
  const existing = tabs.find(t => t.path === filePath);
  if (existing) {
    activateTab(existing.path);
    return;
  }

  const content = await window.api.readFile(filePath);
  const language = detectLanguage(name, content);
  const uri = monaco.Uri.file(filePath);

  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(content, language, uri);
  } else {
    model.setValue(content);
    monaco.editor.setModelLanguage(model, language);
  }

  const tab = { path: filePath, name, model, language, dirty: false };
  tabs.push(tab);
  activateTab(filePath);
  updateTabbar();
}

// Activate tab
function activateTab(filePath) {
  const tab = tabs.find(t => t.path === filePath);
  if (!tab) return;
  activeTabPath = filePath;
  editor.setModel(tab.model);
  updateTabbar();
  updateTitlebar();
  bindGlobalKeys();
}

// Close tab
function closeTab(filePath) {
  const idx = tabs.findIndex(t => t.path === filePath);
  if (idx === -1) return;

  const tab = tabs[idx];
  // If dirty, ask confirmation
  if (tab.dirty) {
    const ok = confirm(`Close unsaved file?\n${tab.path}\nUnsaved changes will be lost.`);
    if (!ok) return;
  }

  tabs.splice(idx, 1);

  // If it was active, activate a neighbor
  if (activeTabPath === filePath) {
    const next = tabs[idx] || tabs[idx - 1];
    activeTabPath = next ? next.path : null;
    editor.setModel(next ? next.model : null);
  }

  updateTabbar();
  updateTitlebar();
}

// Save active tab
async function saveActiveTab() {
  const tab = tabs.find(t => t.path === activeTabPath);
  if (!tab) return;
  const content = tab.model.getValue();
  await window.api.saveFile({ filePath: tab.path, content });
  tab.dirty = false;
  updateTabbar();
  updateTitlebar();
}

// Tabbar UI
function updateTabbar() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.path === activeTabPath ? ' active' : '');
    const title = document.createElement('span');
    title.textContent = t.dirty ? `${t.name} *` : t.name;
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';

    el.onclick = () => activateTab(t.path);
    close.onclick = (e) => { e.stopPropagation(); closeTab(t.path); };

    el.appendChild(title);
    el.appendChild(close);
    bar.appendChild(el);
  }
}

// Titlebar label shows workspace and active file
function updateTitlebar() {
  const label = document.getElementById('workspace-label');
  const base = workspaceRoot ? workspaceRoot : 'No folder opened';
  const active = tabs.find(t => t.path === activeTabPath);
  label.textContent = active
    ? `${base} — ${active.path}${active.dirty ? ' *' : ''}`
    : base;
}

// Global keys: F2 rename current file, Delete delete current file
function bindGlobalKeys() {
  window.onkeydown = async (e) => {
    const active = tabs.find(t => t.path === activeTabPath);
    if (!active) return;

    if (e.key === 'F2') {
      e.preventDefault();
      promptRename(active.path);
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      promptDelete(active.path, 'file');
    }
  };
}

// Language detection: by extension + shebang
function detectLanguage(filename, content) {
  const f = filename.toLowerCase();
  if (f.endsWith('.ts')) return 'typescript';
  if (f.endsWith('.js')) return 'javascript';
  if (f.endsWith('.jsx')) return 'javascript';
  if (f.endsWith('.tsx')) return 'typescript';
  if (f.endsWith('.py')) return 'python';
  if (f.endsWith('.cpp') || f.endsWith('.cc') || f.endsWith('.cxx')) return 'cpp';
  if (f.endsWith('.c')) return 'c';
  if (f.endsWith('.java')) return 'java';
  if (f.endsWith('.json')) return 'json';
  if (f.endsWith('.md')) return 'markdown';
  if (f.endsWith('.html')) return 'html';
  if (f.endsWith('.css')) return 'css';
  if (f.endsWith('.sh')) return 'shell';
  // shebang check
  if (content && content.startsWith('#!')) {
    if (content.includes('python')) return 'python';
    if (content.includes('node')) return 'javascript';
    if (content.includes('bash') || content.includes('sh')) return 'shell';
  }
  return 'plaintext';
}

// Lightweight completion providers for non-TS/JS languages
function registerCompletionProviders() {
  // Python
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '_'],
    provideCompletionItems: () => {
      const suggestions = [
        { label: 'def', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'def ${1:name}(${2:args}):\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'class', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'print', kind: monaco.languages.CompletionItemKind.Function, insertText: 'print(${1})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'ifmain', kind: monaco.languages.CompletionItemKind.Snippet, insertText: "if __name__ == '__main__':\n\t${0}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });

  // C/C++
  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['#', '.', '>'],
    provideCompletionItems: () => {
      const suggestions = [
        { label: '#include <iostream>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <iostream>\nusing namespace std;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'int main(){\n\t${0}\n\treturn 0;\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });

  // Java
  monaco.languages.registerCompletionItemProvider('java', {
    triggerCharacters: ['.'],
    provideCompletionItems: () => {
      const suggestions = [
        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public static void main(String[] args){\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });
}
