const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

function fixture(standalone = false) {
  const { window } = new JSDOM('<body></body>');
  const doc = window.document;
  window.HTMLElement.prototype.createDiv = function(o = {}) { return this.createEl('div', o); };
  window.HTMLElement.prototype.createEl = function(tag, o = {}) {
    const el = doc.createElement(tag); el.className = o.cls || ''; el.textContent = o.text || ''; this.append(el); return el;
  };
  window.createDiv = o => { const el = doc.createElement('div'); if (o?.cls) el.className = o.cls; return el; };
  doc.win = window;
  window.HTMLElement.prototype.empty = function() { this.replaceChildren(); };
  const timers = new Map(); let nextTimer = 0;
  window.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  window.clearTimeout = id => timers.delete(id);
  window.setInterval = () => 5000; window.clearInterval = () => {};
  const opened = []; window.open = url => opened.push(url);
  class Component {
    callbacks = []; children = [];
    register(fn) { this.callbacks.push(fn); }
    registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); this.register(() => el.removeEventListener(type, fn, options)); }
    addChild(child) { this.children.push(child); return child; }
    unload() { this.callbacks.splice(0).reverse().forEach(fn => fn()); this.children.forEach(child => child.unload()); }
    load() {}
  }
  class Plugin extends Component { addSettingTab() {} async loadData() { return null; } async saveData(data) { this.saved = data; } }
  const notices = []; let requests = 0;
  const obsidian = { Plugin, Component, Platform: { isDesktopApp: true }, displayTooltip: (el, text) => el.dataset.visibleTooltip = text, PluginSettingTab: class {}, setIcon() {}, setTooltip: (el, text) => el.setAttribute('aria-label', text),
    Notice: class { constructor(text) { notices.push(text); } },
    requestUrl: async () => { requests++; return { json: [{ id: 'alpha', repo: 'author/alpha' }, { id: 'unsafe', repo: '../bad/path' }] }; },
  };
  const context = vm.createContext({ console, window, document: doc, activeDocument: doc, MutationObserver: window.MutationObserver, Event: window.Event });
  function load(file) {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
    const exports = {}; vm.runInContext('(function(require,exports){' + code + '\n})', context)(id => id === 'obsidian' ? obsidian : load(id + '.ts'), exports); return exports;
  }
  const p = new (load('main.ts').default)();
  const wrapper = doc.createElement('div'); wrapper.className = standalone ? '' : 'modal-container';
  const root = doc.createElement('div'); root.className = 'modal';
  root.innerHTML = '<div class="vertical-tab-header"><div class="vertical-tab-header-group-title">Community plugins</div><div class="vertical-tab-nav-item is-active" data-id="community-plugins">Community plugins</div></div><div class="vertical-tab-content"></div>';
  wrapper.append(root); doc.body.append(wrapper);
  const content = root.querySelector('.vertical-tab-content');
  const setting = { containerEl: root, activeTab: { id: 'community-plugins', containerEl: content },
    openTab(tab) {
      this.activeTab = { id: tab.id, containerEl: content };
      root.querySelector('.vertical-tab-nav-item.is-active')?.classList.remove('is-active');
      [...root.querySelectorAll('.vertical-tab-nav-item')].find(el => el.dataset.id === tab.id)?.classList.add('is-active');
      content.replaceChildren();
      if (['community-plugins', 'hotkeys'].includes(tab.id)) content.innerHTML = '<div class="search-input-container"><input type="search"></div>';
    },
    openTabById(id) { const tab = { id }; this.openTab(tab); return tab; },
  };
  setting.openTabById('community-plugins'); const core = {};
  p.app = { setting, workspace: { onLayoutReady: fn => fn() }, plugins: { manifests: { alpha: { id: 'alpha', name: 'Alpha', version: '1', author: 'a', description: '' } } }, internalPlugins: { plugins: core, getPluginById: id => core[id] || null } };
  p.manifest = { id: 'settings-navigator' }; p.updateButtonStates = () => {};
  function flush() { for (let n = 0; timers.size && n < 60; n++) { const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn()); } assert.equal(timers.size, 0); }
  const input = () => content.querySelector('input'); const edit = value => { input().value = value; p.captureSearchEdit(input()); };
  return { p, doc, window, root, content, setting, core, flush, input, edit, opened, notices, requests: () => requests };
}

test('history restores each installed-plugins visit without changing the latest saved memory', () => {
  const { p, input, edit, flush } = fixture();
  p.recordTabChange('community-plugins'); edit('first');
  p.recordTabChange('editor'); p.performNavigation('editor'); flush();
  p.recordTabChange('community-plugins'); p.performNavigation('community-plugins'); edit('second'); flush();
  p.navigateBack(); flush(); p.navigateBack(); flush();
  assert.equal(input().value, 'first'); assert.equal(p.savedSearchQueries['community-plugins'], 'second');
  p.navigateForward(); flush(); p.navigateForward(); flush(); assert.equal(input().value, 'second');
});
test('puzzle lookup and same-tab heading keep normal and empty search memory', () => {
  for (const query of ['remembered', '']) {
    const { p, input, root, flush } = fixture(); p.savedSearchQueries['community-plugins'] = query;
    p.openInstalledPlugin({ id: 'alpha', name: 'Alpha' }); flush(); assert.equal(input().value, 'Alpha');
    p.injectXButtons(); root.querySelector('.vertical-tab-header-group-title').click(); flush(); assert.equal(input().value, query);
    p.navigateBack(); flush(); assert.equal(input().value, 'Alpha'); assert.equal(p.savedSearchQueries['community-plugins'], query);
  }
});
test('one restore per input; replacement is restored before paint; paste and clear remain', async () => {
  const { p, input, edit, content, flush } = fixture(); p.bindDocument(content.ownerDocument);
  p.savedSearchQueries['community-plugins'] = 'saved'; p.beginSearchVisit('community-plugins');
  let events = 0; input().addEventListener('input', () => events++);
  p.syncSearchBar(); p.syncSearchBar(); flush(); assert.equal(events, 1);
  edit('paste'); flush(); assert.equal(input().value, 'paste');
  content.innerHTML = '<div class="search-input-container"><input type="search" value="stale"></div>';
  await Promise.resolve(); assert.equal(input().value, 'paste'); edit(''); flush(); assert.equal(input().value, ''); p.unload();
});
test('rapid history clicks cancel stale callbacks', () => {
  const { p, input, edit, flush } = fixture(); p.recordTabChange('community-plugins'); edit('query');
  p.recordTabChange('editor'); p.performNavigation('editor'); p.recordTabChange('hotkeys'); p.performNavigation('hotkeys');
  p.navigateBack(); p.navigateBack(); flush(); assert.equal(p.detectTabIdFromDOM(), 'community-plugins'); assert.equal(input().value, 'query');
});
test('unrelated text fields and a stacked prompt are excluded', () => {
  const { p, content, setting, doc } = fixture(); setting.openTabById('other'); content.innerHTML = '<input type="text" value="private setting">';
  p.savedSearchQueries['community-plugins'] = 'filter'; p.syncSearchBar(); assert.equal(content.querySelector('input').value, 'private setting');
  const prompt = doc.createElement('div'); prompt.className = 'modal-container'; prompt.innerHTML = '<div class="modal"><div class="prompt"></div></div>'; doc.body.append(prompt); assert.equal(p.getNavigationModal(), null);
});
test('all six core labels get working disable buttons using the actual IDs', async () => {
  const { p, root, core } = fixture(); const disabled = [];
  const labels = { 'page-preview': 'Page preview', bases: 'Bases', 'note-composer': 'Note composer', 'file-recovery': 'File recovery', 'daily-notes': 'Daily notes', switcher: 'Quick switcher' };
  for (const [id, name] of Object.entries(labels)) {
    core[id] = { enabled: true, instance: { id, name }, disable: persist => disabled.push([id, persist]) };
    const item = root.querySelector('.vertical-tab-header').createDiv({ cls: 'vertical-tab-nav-item', text: name });
    p.injectXButtons(); const button = item.querySelector('.settings-nav-x-button'); assert.ok(button, name); button.click();
  }
  await Promise.resolve(); assert.deepEqual(disabled, Object.keys(labels).map(id => [id, true]));
});
test('mouse down/up/aux navigates once and aux-only works in both settings layouts', async () => {
  for (const standalone of [false, true]) {
    const { p, doc, window } = fixture(standalone); await p.onload(); let back = 0, forward = 0; p.navigateBack = () => back++; p.navigateForward = () => forward++;
    for (const type of ['mousedown', 'mouseup', 'auxclick']) doc.dispatchEvent(new window.MouseEvent(type, { button: 3, bubbles: true, cancelable: true }));
    assert.equal(back, 1); doc.dispatchEvent(new window.MouseEvent('auxclick', { button: 4, bubbles: true, cancelable: true })); assert.equal(forward, 1);
    doc.dispatchEvent(new window.MouseEvent('auxclick', { button: 4, bubbles: true, cancelable: true })); assert.equal(forward, 2);
    p.onunload(); p.unload(); doc.dispatchEvent(new window.MouseEvent('mousedown', { button: 3, bubbles: true })); assert.equal(back, 1);
  }
});
test('Ctrl puzzle option opens GitHub on demand, caches lookup, and preserves Shift', async () => {
  const { p, window, opened, requests } = fixture(); const info = { id: 'alpha', name: 'Alpha' }; const ctrl = new window.MouseEvent('click', { ctrlKey: true });
  await p.handlePuzzleClick(info, ctrl); assert.equal(requests(), 0); assert.match(opened.pop(), /^obsidian:/);
  p.settings.ctrlClickOpensGithub = true; await p.handlePuzzleClick(info, ctrl); await p.handlePuzzleClick(info, ctrl);
  assert.equal(requests(), 1); assert.equal(opened.pop(), 'https://github.com/author/alpha');
  let installed = 0; p.openInstalledPlugin = () => installed++; await p.handlePuzzleClick(info, new window.MouseEvent('click', { shiftKey: true })); assert.equal(installed, 1);
});
test('reinjection removes duplicate heading handlers', () => {
  const { p, root } = fixture(); let count = 0; p.performNavigation = () => count++;
  for (let i = 0; i < 4; i++) { p.injectXButtons(); p.removeAllXButtons(); }
  p.injectXButtons(); root.querySelector('.vertical-tab-header-group-title').click(); assert.equal(count, 1);
  p.removeAllXButtons(); root.querySelector('.vertical-tab-header-group-title').click(); assert.equal(count, 1);
});
test('Style Settings paths distinguish repeated child IDs and retain collapsed descendants', () => {
  const { p, setting, content } = fixture(); setting.openTabById('obsidian-style-settings'); p.lastActiveTabId = 'obsidian-style-settings';
  content.innerHTML = '<div class="style-settings-heading" data-id="a"></div><div class="style-settings-container"><div class="style-settings-heading" data-id="same"></div></div><div class="style-settings-heading" data-id="b"></div><div class="style-settings-container"><div class="style-settings-heading is-collapsed" data-id="same"></div></div>';
  p.saveFoldState('obsidian-style-settings'); const saved = p.foldStateCache.get('obsidian-style-settings'); assert.equal(saved['a/same'], true); assert.equal(saved['b/same'], false);
  content.firstElementChild.classList.add('is-collapsed'); content.firstElementChild.nextElementSibling.replaceChildren(); p.saveFoldState('obsidian-style-settings');
  assert.equal(p.foldStateCache.get('obsidian-style-settings')['a/same'], true);
});
test('Style Settings restores dynamically rendered descendants without overwriting the cache', () => {
  const { p, setting, content, flush } = fixture(); setting.openTabById('obsidian-style-settings'); p.lastActiveTabId = 'obsidian-style-settings';
  function heading(container, id, child) {
    const el = container.createDiv({ cls: 'style-settings-heading is-collapsed' }); el.dataset.id = id; const children = container.createDiv({ cls: 'style-settings-container' });
    el.addEventListener('click', () => { el.classList.toggle('is-collapsed'); if (!el.classList.contains('is-collapsed') && child) child(children); else children.replaceChildren(); });
  }
  heading(content, 'root', child => heading(child, 'nested', inner => heading(inner, 'deep')));
  const state = { root: true, 'root/nested': true, 'root/nested/deep': true }; p.foldStateCache.set('obsidian-style-settings', state);
  p.restoreFoldState('obsidian-style-settings'); p.saveFoldState('obsidian-style-settings'); flush();
  assert.equal(content.querySelectorAll('.is-collapsed').length, 0); assert.equal(p.foldStateCache.get('obsidian-style-settings'), state);
});

test('reopening a Style Settings parent restores its nested expansion', () => {
  const { p, setting, content, flush } = fixture(); setting.openTabById('obsidian-style-settings'); p.lastActiveTabId = 'obsidian-style-settings';
  const root = content.createDiv({ cls: 'style-settings-heading is-collapsed' }); root.dataset.id = 'root';
  const children = content.createDiv({ cls: 'style-settings-container' });
  root.addEventListener('click', () => {
    root.classList.toggle('is-collapsed'); children.replaceChildren();
    if (!root.classList.contains('is-collapsed')) {
      const nested = children.createDiv({ cls: 'style-settings-heading is-collapsed' }); nested.dataset.id = 'nested';
      nested.addEventListener('click', () => nested.classList.toggle('is-collapsed'));
    }
  });
  p.foldStateCache.set('obsidian-style-settings', { root: false, 'root/nested': true });
  p.rememberHeadingToggle(root); root.click(); flush();
  assert.equal(children.querySelector('.style-settings-heading').classList.contains('is-collapsed'), false);
});

test('fold states and per-visit search snapshots survive save/load', async () => {
  const { p, edit } = fixture(); p.recordTabChange('community-plugins'); edit('persisted query');
  p.foldStateCache.set('obsidian-style-settings', { root: false, 'root/child': true });
  p.settings.ctrlClickOpensGithub = true; await p.savePluginData();
  const { p: restored } = fixture(); restored.loadData = async () => JSON.parse(JSON.stringify(p.saved)); await restored.loadSavedData();
  assert.equal(restored.history[0].searchQuery, 'persisted query'); assert.equal(restored.foldStateCache.get('obsidian-style-settings')['root/child'], true);
  assert.equal(restored.settings.ctrlClickOpensGithub, true);
});

test('Shift only changes the hovered X and updates its visible tooltip immediately', () => {
  const { p, root, doc, window } = fixture();
  p.createXButton(root, 'alpha', true); p.createXButton(root, 'beta', true);
  const [a, b] = root.querySelectorAll('.settings-nav-x-button');
  a.dispatchEvent(new window.MouseEvent('mouseenter'));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Shift',shiftKey:true}));
  assert.equal(a.classList.contains('shift-held'), true); assert.equal(b.classList.contains('shift-held'), false);
  assert.equal(a.dataset.visibleTooltip, 'Delete plugin');
  a.dispatchEvent(new window.MouseEvent('mouseleave')); assert.equal(a.classList.contains('shift-held'), false);
  b.dispatchEvent(new window.MouseEvent('mouseenter', {shiftKey:true})); assert.equal(b.dataset.visibleTooltip, 'Delete plugin');
  doc.dispatchEvent(new window.KeyboardEvent('keyup', {key:'Shift'})); assert.equal(b.dataset.visibleTooltip, 'Disable plugin');
});

test('plugin settings-like dialogs cannot claim the navigation bar', () => {
  const {p, doc} = fixture();
  const overlay=doc.createElement('div'); overlay.className='modal-container';
  overlay.innerHTML='<div class="modal mod-settings"><div class="vertical-tab-header">Release notes</div></div>';
  doc.body.append(overlay); assert.equal(p.getNavigationModal(),null);
  overlay.innerHTML='<div class="modal mod-community-modal"></div>'; assert.ok(p.getNavigationModal());
});

test('snippet name opens the known CSS path; other settings and controls do not', async () => {
  const {p, setting, content} = fixture(); let opened;
  p.app.customCss={snippets:['example'],getSnippetPath:n=>'custom-config/snippets/'+n+'.css'};
  p.app.openWithDefaultApp=async path=>{opened=path;};
  setting.openTabById('appearance'); content.innerHTML='<div class="setting-item-name">example</div><button>Toggle</button>';
  assert.equal(p.isSnippetName(content.firstElementChild),true);
  await p.openSnippet('example'); assert.equal(opened,'custom-config/snippets/example.css');
  await p.openSnippet('../unknown'); assert.equal(opened,'custom-config/snippets/example.css');
  setting.activeTab.id='other'; assert.equal(p.isSnippetName(content.firstElementChild),false);
});

test('native settings outer container positions the toolbar relative to its modal', () => {
 const {p,root,setting}=fixture(); setting.containerEl=root.parentElement; assert.equal(p.getNavigationModal(),root);
});

test('side-button navigation precedes competing document handlers', async () => {
 const {p,doc,window}=fixture(); let other=0;
 doc.addEventListener('mousedown',e=>{other++;e.stopImmediatePropagation();},true);
 await p.onload(); let forward=0;p.navigateForward=()=>forward++;
 for(const type of ['mousedown','mouseup','auxclick']) doc.dispatchEvent(new window.MouseEvent(type,{button:4,bubbles:true,cancelable:true}));
 assert.equal(forward,1);assert.equal(other,0);p.unload();
});
