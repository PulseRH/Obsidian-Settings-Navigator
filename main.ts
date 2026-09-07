import { Plugin, setIcon, setTooltip, displayTooltip, Platform, Notice, requestUrl, Component } from 'obsidian';
import { SettingsNavigatorSettingTab } from './settings-tab';
import { corePluginId, type InternalApp, type InternalTab } from './internal-api';

const CORE_TAB_IDS = new Set([
	'editor',
	'file',
	'appearance',
	'hotkeys',
	'about',
	'account',
	'core-plugins',
	'community-plugins',
]);

interface SettingsHistory {
	tabId: string;
	timestamp: number;
	installedQuery?: string; // Legacy temporary filter.
	searchQuery?: string;
}

interface PluginData {
	lastTabId?: string;
	history?: SettingsHistory[];
	currentIndex?: number;
	enableXButtons?: boolean;
	enableBrowseButtons?: boolean;
	browseDefaultInstalled?: boolean;
	transparentNavBar?: boolean;
	showTabLabel?: string | number | boolean;
	cacheScrollPositions?: boolean;
	cacheSearchBar?: boolean;
	enableFirstLetterNav?: boolean;
	letterNavMode?: 'tab' | 'shift';
	savedSearchQuery?: string; // legacy
	savedSearchQueries?: Record<string, string>;
	foldStates?: Record<string, Record<string, boolean>>;
	ctrlClickOpensGithub?: boolean;
}

interface PluginSettings {
	enableXButtons: boolean;
	enableBrowseButtons: boolean;
	browseDefaultInstalled: boolean;
	ctrlClickOpensGithub: boolean;
	transparentNavBar: boolean;
	showTabLabel: number;
	cacheScrollPositions: boolean;
	cacheSearchBar: boolean;
	enableFirstLetterNav: boolean;
	letterNavMode: 'tab' | 'shift';
}

export default class SettingsBackAndForthPlugin extends Plugin {
	private get internalApp(): InternalApp { return this.app; }
	private history: SettingsHistory[] = [];
	private currentIndex: number = -1;
	private isNavigatingProgrammatically: boolean = false;
	private lastActiveTabId: string | null = null;
	private lastRecordTime: number = 0;
	private floatingPane: HTMLElement | null = null;
	private pollInterval: number | null = null;
	private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
	private mouseHandler: ((e: MouseEvent) => void) | null = null;
	settings: PluginSettings = { enableXButtons: true, enableBrowseButtons: true, browseDefaultInstalled: false, ctrlClickOpensGithub: false, transparentNavBar: false, showTabLabel: 15, cacheScrollPositions: true, cacheSearchBar: true, enableFirstLetterNav: true, letterNavMode: 'shift' };
	private injectedXButtons: WeakSet<HTMLElement> = new WeakSet();
	private scrollCache: Map<string, number> = new Map();
	private foldStateCache = new Map<string, Record<string, boolean>>();
	private foldRestoring = new Set<string>();
	private scrollRestoring = new Set<string>();
	private viewGeneration = 0;
	private navigationGeneration = 0;
	private ui = new Component();
	private paneUi = new Component();
	private sidebarRoot: HTMLElement | null = null;
	private eventDocuments = new Set<Document>();
	private mousePress: { button: number; time: number; type: string } | null = null;
	private githubRepos: Map<string, string> | null = null;
	savedSearchQueries: Record<string, string> = {};
	private searchVisitTab = '';
	private temporaryInstalledQuery: string | undefined;
	private searchGeneration = 0;
	private searchRestoring = false;
	private restoredSearchInput: HTMLInputElement | null = null;
	private unloaded = false;
	private timers = new Set<number>();
	private saveQueue: Promise<void> = Promise.resolve();
	private modalWasClosed: boolean = false;
	private lastLetterPressed: string = '';
	private lastLetterIndex: number = -1;
	private lastLetterTime: number = 0;
	private letterNavFocusSidebar: boolean = true;
	private lastNavActionTime: number = 0;

	private isCommunityPluginsTab(tabId: string | null): boolean {
		if (!tabId) return false;
		return tabId === 'community-plugins' || tabId === 'community plugins';
	}

	private isSearchBarTab(tabId: string | null): boolean {
		if (!tabId) return false;
		return this.isCommunityPluginsTab(tabId) || tabId === 'hotkeys';
	}

	async onload() {
		await this.loadSavedData();
		this.addChild(this.ui);
		this.addChild(this.paneUi);
		this.addSettingTab(new SettingsNavigatorSettingTab(this.app, this));

		// Direct keydown listener for Ctrl+Z/Ctrl+X and first-letter navigation
		this.keydownHandler = (e: KeyboardEvent) => {
			const settingsOpen = this.getNavigationModal();
			if (!settingsOpen) return;

			const focused = activeDocument.activeElement as HTMLElement | null;
			if (focused?.matches('input, textarea, [contenteditable="true"]') || focused?.isContentEditable) return;

			// Ctrl+Z / Ctrl+X for back/forward
			if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'x')) {
				e.preventDefault();
				e.stopPropagation();
				if (e.key === 'z') this.navigateBack();
				else this.navigateForward();
				return;
			}

			// First-letter navigation
			if (!this.settings.enableFirstLetterNav) return;

			// Ctrl+Tab toggles between sidebar and content focus
			if (this.settings.letterNavMode === 'tab' && e.ctrlKey && e.key === 'Tab') {
				e.preventDefault();
				e.stopPropagation();
				this.letterNavFocusSidebar = !this.letterNavFocusSidebar;
				return;
			}

			if (e.ctrlKey || e.altKey || e.metaKey) return;
			if (!/^[a-z]$/i.test(e.key)) return;
			// Don't capture when typing in inputs
			const active = activeDocument.activeElement;
			if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return;

			// Determine if we should target sidebar or content
			let forceSidebar: boolean;
			if (this.settings.letterNavMode === 'shift') {
				forceSidebar = e.shiftKey;
			} else {
				// Tab mode
				forceSidebar = this.letterNavFocusSidebar;
			}

			e.preventDefault();
			this.handleFirstLetterNav(e.key.toLowerCase(), forceSidebar);
		};


		// Mouse 4/5 (back/forward) buttons for navigation
		this.mouseHandler = (e: MouseEvent) => {
			// button 3 = Mouse4 (back), button 4 = Mouse5 (forward)
			if (e.button !== 3 && e.button !== 4) return;
			const settingsOpen = this.getNavigationModal();
			if (!settingsOpen) return;
			e.preventDefault();
			e.stopPropagation();
			if (this.shouldHandleMouseNavigation(e)) {
				if (e.button === 3) this.navigateBack();
				else this.navigateForward();
			}
		};

		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			this.ensureFloatingPane();
			this.setupNavigationTracking();
		});

		this.ensureFloatingPane();
		this.bindDocument(activeDocument);
	}

	private shouldHandleMouseNavigation(e: MouseEvent): boolean {
		const now = Date.now();
		if (e.type === 'mousedown') {
			this.mousePress = { button: e.button, time: now, type: e.type };
			return true;
		}
		const duplicate = this.mousePress?.button === e.button && this.mousePress.type !== e.type && now - this.mousePress.time < 600;
		this.mousePress = { button: e.button, time: now, type: e.type };
		if (duplicate) return false;
		return true;
	}

	private bindDocument(doc: Document) {
		if (this.eventDocuments.has(doc)) return;
		this.eventDocuments.add(doc);
		if (this.keydownHandler) this.registerDomEvent(doc, 'keydown', this.keydownHandler, true);
		// Claim settings navigation before the host and other plugins' document
		// handlers can consume the same side-button press.
		if (this.mouseHandler && doc.defaultView) for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) this.registerDomEvent(doc.defaultView, type, this.mouseHandler, true);
		this.registerDomEvent(doc, 'input', e => {
			if (e.isTrusted) this.captureSearchEdit(e.target);
		}, true);
		this.registerDomEvent(doc, 'click', e => {
			const target = e.target as HTMLElement | null;
			const snippet = target?.closest<HTMLElement>('.setting-item-name');
			if (snippet && !target?.closest('a, button, input') && this.isSnippetName(snippet)) {
				e.preventDefault();
				void this.openSnippet(snippet.textContent?.trim() ?? '');
			}
			const clear = target?.closest('.search-input-clear-button');
			const input = this.findSearchInput();
			if (clear && input && clear.parentElement === input.parentElement) {
				const tab = this.detectTabIdFromDOM();
				this.defer(() => { if (this.detectTabIdFromDOM() === tab) this.captureSearchEdit(this.findSearchInput(tab)); }, 0);
			}
			const heading = target?.closest<HTMLElement>('.style-settings-heading');
			if (e.isTrusted && heading && !target?.closest('button, a, input, .extra-setting-button')) this.rememberHeadingToggle(heading);
		}, true);
		// Rendering can replace inputs after openTab returns. Observe before the next
		// paint, rather than repeatedly forcing old values from a timer.
		const observer = new MutationObserver(() => { if (!this.unloaded) this.syncSearchBar(); });
		observer.observe(doc.body, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
	}

	async loadSavedData() {
		try {
			const data = await this.loadData() as PluginData;
			if (data) {
				this.settings.enableXButtons = data.enableXButtons ?? true;
				this.settings.enableBrowseButtons = data.enableBrowseButtons ?? true;
				this.settings.browseDefaultInstalled = data.browseDefaultInstalled ?? false;
				this.settings.ctrlClickOpensGithub = data.ctrlClickOpensGithub ?? false;
				this.foldStateCache = new Map(Object.entries(data.foldStates ?? {}));
				this.settings.transparentNavBar = data.transparentNavBar ?? false;
				const rawLabel = data.showTabLabel;
				if (typeof rawLabel === 'number') this.settings.showTabLabel = rawLabel;
				else if (rawLabel === 'off' || rawLabel === false) this.settings.showTabLabel = 0;
				else if (rawLabel === 'small' || rawLabel === true) this.settings.showTabLabel = 15;
				else if (rawLabel === 'medium') this.settings.showTabLabel = 17;
				else if (rawLabel === 'large') this.settings.showTabLabel = 19;
				else this.settings.showTabLabel = 15;
				this.settings.cacheScrollPositions = data.cacheScrollPositions ?? true;
				this.settings.cacheSearchBar = data.cacheSearchBar ?? true;
				this.settings.enableFirstLetterNav = data.enableFirstLetterNav ?? true;
				this.settings.letterNavMode = data.letterNavMode ?? 'shift';
				// Load search queries (with legacy support)
				this.savedSearchQueries = data.savedSearchQueries ?? {};
				if (data.savedSearchQuery && this.savedSearchQueries['community-plugins'] === undefined) {
					this.savedSearchQueries['community-plugins'] = data.savedSearchQuery;
				}
				// Migration: older builds split the cache across two keys for the
				// community-plugins tab — 'community-plugins' (from data-id) and
				// 'community plugins' (from textContent fallback). Merge any stale
				// space-form entry into the canonical hyphen-form key.
				if (this.savedSearchQueries['community plugins'] !== undefined) {
					if (this.savedSearchQueries['community-plugins'] === undefined) {
						this.savedSearchQueries['community-plugins'] = this.savedSearchQueries['community plugins'];
					}
					delete this.savedSearchQueries['community plugins'];
				}
			}
			if (data && Array.isArray(data.history)) {
				// Clean up invalid history entries (empty strings, null, undefined)
				// and normalize the old textContent-fallback 'community plugins' key.
				const cleaned = data.history
					.filter(entry =>
						entry &&
						entry.tabId &&
						typeof entry.tabId === 'string' &&
						entry.tabId.trim().length > 0
					)
					.map(entry => ({
						...entry,
						tabId: entry.tabId === 'community plugins' ? 'community-plugins' : entry.tabId,
					}));
				// Collapse consecutive duplicates created by the normalization
				this.history = cleaned.filter((entry, i) =>
					i === 0 || entry.tabId !== cleaned[i - 1].tabId || entry.searchQuery !== cleaned[i - 1].searchQuery || entry.installedQuery !== cleaned[i - 1].installedQuery
				);

				// Ensure currentIndex is valid
				if (this.history.length > 0) {
					this.currentIndex = Math.min(data.currentIndex ?? this.history.length - 1, this.history.length - 1);
					this.currentIndex = Math.max(0, this.currentIndex);
				} else {
					this.currentIndex = -1;
				}
			}
		} catch (error) {
			console.error('[Settings Nav] Error loading data:', error);
		}
	}

	async savePluginData() {
		try {
			const data: PluginData = {
				history: this.history.map(entry => ({ ...entry })),
				currentIndex: this.currentIndex,
				lastTabId: this.history.length > 0 ? this.history[this.currentIndex]?.tabId : undefined,
				enableXButtons: this.settings.enableXButtons,
				enableBrowseButtons: this.settings.enableBrowseButtons,
				browseDefaultInstalled: this.settings.browseDefaultInstalled,
				ctrlClickOpensGithub: this.settings.ctrlClickOpensGithub,
				foldStates: Object.fromEntries(this.foldStateCache),
				transparentNavBar: this.settings.transparentNavBar,
				showTabLabel: this.settings.showTabLabel,
				cacheScrollPositions: this.settings.cacheScrollPositions,
				cacheSearchBar: this.settings.cacheSearchBar,
				enableFirstLetterNav: this.settings.enableFirstLetterNav,
				letterNavMode: this.settings.letterNavMode,
				savedSearchQueries: { ...this.savedSearchQueries },
			};
			this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.saveData(data));
			await this.saveQueue;
		} catch (error) {
			console.error('[Settings Nav] Error saving data:', error);
		}
	}

	private isCommunityPluginTab(tabId: string): boolean {
		if (!tabId || tabId.startsWith('plugin:') || tabId === 'browse' || tabId.startsWith('browse:')) return false;
		if (CORE_TAB_IDS.has(tabId)) return false;
		const plugins = this.internalApp.plugins?.manifests;
		if (!plugins) return false;
		// Direct ID match
		if (tabId in plugins) return true;
		// Match by display name (for tabs that use textContent instead of data-id)
		return Object.values(plugins).some(
			(m) => m.name?.toLowerCase() === tabId
		);
	}

	private getPluginInfoForTab(tabId: string): { name: string; id: string } | null {
		const plugins = this.internalApp.plugins?.manifests;
		if (!plugins) return null;
		// Direct ID match
		if (tabId in plugins) {
			return { name: plugins[tabId].name.toLowerCase(), id: tabId };
		}
		// Match by display name
		for (const [id, manifest] of Object.entries(plugins)) {
			if (manifest.name?.toLowerCase() === tabId) {
				return { name: manifest.name.toLowerCase(), id };
			}
		}
		return null;
	}

	private openPluginInBrowse(e?: MouseEvent) {
		const doc = activeDocument;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
		if (!modalContainer) return;

		const modal = (modalContainer.matches('.modal') ? modalContainer : modalContainer.querySelector('.modal')) as HTMLElement;
		if (!modal) return;

		const activeTab = modal.querySelector('.vertical-tab-nav-item.is-active');
		const tabId = (activeTab?.getAttribute('data-id') || activeTab?.textContent || '').trim().toLowerCase();

		if (!tabId || !this.isCommunityPluginTab(tabId)) return;

		const pluginInfo = this.getPluginInfoForTab(tabId);
		if (!pluginInfo) return;

		void this.handlePuzzleClick(pluginInfo, e);
	}

	private ensureFloatingPane() {
		const doc = activeDocument;
		const targetParent = doc.body;

		if (this.floatingPane && this.floatingPane.parentElement === targetParent) {
			return;
		}

		if (this.floatingPane) this.floatingPane.remove();
		this.paneUi.unload();
		this.paneUi.load();

		this.floatingPane = targetParent.createDiv();
		this.floatingPane.className = 'settings-nav-floating-pane';

		this.applyNavBarStyle();

		// Stop propagation on the pane itself to prevent modal closing
		this.floatingPane.addEventListener('mousedown', (e) => e.stopPropagation());
		this.floatingPane.addEventListener('click', (e) => e.stopPropagation());

		const backBtn = this.floatingPane.createDiv();
		backBtn.className = 'settings-nav-float-button clickable-icon';
		backBtn.setAttribute('aria-label', 'Go back');
		setIcon(backBtn, 'arrow-left');
		backBtn.onclick = (e) => {
			e.stopPropagation();
			this.navigateBack();
		};

		const forwardBtn = this.floatingPane.createDiv();
		forwardBtn.className = 'settings-nav-float-button clickable-icon';
		forwardBtn.setAttribute('aria-label', 'Go forward');
		setIcon(forwardBtn, 'arrow-right');
		forwardBtn.onclick = (e) => {
			e.stopPropagation();
			this.navigateForward();
		};

		const indicator = this.floatingPane.createDiv();
		indicator.className = 'settings-nav-indicator';

		const separator = this.floatingPane.createDiv();
		separator.className = 'settings-nav-separator';

		const pluginInfoBtn = this.floatingPane.createDiv();
		pluginInfoBtn.className = 'settings-nav-float-button settings-nav-plugin-info-btn clickable-icon';
		setIcon(pluginInfoBtn, 'puzzle');

		this.attachPuzzleTooltip(pluginInfoBtn, this.paneUi);
		pluginInfoBtn.onclick = (e) => {
			e.stopPropagation();
			this.openPluginInBrowse(e);
		};

		const tabLabel = this.floatingPane.createDiv();
		tabLabel.className = 'settings-nav-tab-label';

		this.floatingPane.appendChild(backBtn);
		this.floatingPane.appendChild(forwardBtn);
		this.floatingPane.appendChild(indicator);
		this.floatingPane.appendChild(separator);
		this.floatingPane.appendChild(pluginInfoBtn);
		this.floatingPane.appendChild(tabLabel);

		targetParent.appendChild(this.floatingPane);
		this.updateButtonStates();
	}

	applyNavBarStyle() {
		this.floatingPane?.classList.toggle('mod-transparent', this.settings.transparentNavBar);
	}

	private setupNavigationTracking() {
		const setting = this.internalApp.setting;
		if (setting?.openTab) {
			// eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the exact method for restoration; invoke with its owning settings object.
			const original = setting.openTab;
			const wrapped = (tab: InternalTab) => {
				const automatic = this.isNavigatingProgrammatically;
				if (!automatic) {
					this.saveCurrentView();
					this.navigationGeneration++;
					this.beginSearchVisit(tab.id);
				}
				original.call(setting, tab);
				if (!automatic) this.recordTabChange(tab.id);
				this.syncSearchBar();
			};
			setting.openTab = wrapped;
			this.register(() => { if (setting.openTab === wrapped) setting.openTab = original; });
		}

		this.pollInterval = window.setInterval(() => {
			this.bindDocument(activeDocument);
			this.ensureFloatingPane();
			const modal = this.getNavigationModal();
			this.floatingPane?.classList.toggle('is-visible', !!modal);
			if (!modal) {
				if (this.searchVisitTab) this.beginSearchVisit('');
				if (this.sidebarRoot) this.removeAllXButtons();
				this.modalWasClosed = true;
				return;
			}
			if (this.floatingPane) {
				const rect = modal.getBoundingClientRect();
				this.floatingPane.style.left = Math.max(0, rect.left) + 'px';
				this.floatingPane.style.top = Math.max(0, rect.top - (this.floatingPane.offsetHeight || 40) - 10) + 'px';
			}
			this.syncSearchBar();
			const tabId = this.detectTabIdFromDOM();
			if (tabId && tabId !== this.lastActiveTabId && !this.isNavigatingProgrammatically) this.recordTabChange(tabId);
			if (this.modalWasClosed && tabId) {
				this.modalWasClosed = false;
				this.restoreFoldState(tabId, () => this.restoreScrollPosition(tabId));
			}
			this.saveCurrentView();
			this.injectXButtons();
			this.updateButtonStates();
		}, 150);
	}

	private detectTabIdFromDOM(): string {
		const doc = activeDocument;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = (allModalContainers[allModalContainers.length - 1] as HTMLElement | undefined) ?? this.getNavigationModal();

		if (!modalContainer) return "";

		// A "Browse" window is a community plugin browse modal (NOT the main settings search)
		// Check both old and new Obsidian class names
		const communityModal = modalContainer.querySelector('.modal.mod-community-modal, .modal.mod-community-plugin');
		const hasSettingsSidebar = modalContainer.querySelector('.vertical-tab-header, .vertical-tab-nav-item');
		const browseSearch = modalContainer.querySelector('.community-modal-search-container')
			|| modalContainer.querySelector('.community-plugin-search')
			|| (communityModal && !hasSettingsSidebar);

		// A "Details" window is any modal that has a plugin details section
		const detailsView = modalContainer.querySelector('.community-modal-details')
			|| modalContainer.querySelector('.community-plugin-details')
			|| modalContainer.querySelector('.modal-content .community-plugin-info');

		if (communityModal || browseSearch || detailsView) {
			// We're in the community plugins modal — never fall through to regular tab detection
			if (detailsView) {
				const detailsText = (detailsView as HTMLElement).innerText.trim();
				const hasContent = detailsText.length > 50;

				if (hasContent) {
					// Try to find plugin ID from share link, data attributes, or install button
					const shareLink = modalContainer.querySelector('a[href*="obsidian://show-plugin"]') as HTMLAnchorElement;
					let pluginId = shareLink?.href?.match(/[?&]id=([^&]+)/)?.[1] || '';

					if (!pluginId) {
						const dataEl = modalContainer.querySelector('[data-plugin-id]') as HTMLElement;
						pluginId = dataEl?.getAttribute('data-plugin-id') || '';
					}

					let name = "";
					// Prefer the selected sidebar item name — it's the most reliable source
					// (detail view headings can pick up README content like "👋 Overview")
					const selectedItem = modalContainer.querySelector('.community-item.is-selected .community-item-name');
					const nameEl = selectedItem
						|| modalContainer.querySelector('.community-modal-details-name')
						|| modalContainer.querySelector('.setting-item-info-name');

					if (nameEl && nameEl.textContent && !nameEl.textContent.toLowerCase().includes('community plugins')) {
						// Strip "Installed"/"Updated" flair badges from sidebar item names
						let rawName = nameEl.textContent.trim();
						const flair = nameEl.querySelector('.flair');
						if (flair) {
							rawName = rawName.replace(flair.textContent || '', '').trim();
						}
						name = rawName.toLowerCase();
						if (pluginId) {
							return `plugin:${name}:${pluginId}`;
						}
						return `plugin:${name}`;
					}
				}
			}

			// In the browse list view, or details still loading — return 'browse'
			// but don't change from a plugin entry to 'browse' during transition
			if (this.lastActiveTabId?.startsWith('plugin:')) {
				// Details might be loading — keep current state to avoid phantom entries
				return this.lastActiveTabId;
			}
			// Capture the search query as part of the browse entry,
			// but only when the search input is not focused (user finished typing)
			const searchInput = modalContainer.querySelector('.search-input-container input[type="search"], .community-modal-search-container input') as HTMLInputElement;
			const query = searchInput?.value?.trim();
			if (searchInput && doc.activeElement === searchInput && query) {
				// Still typing a search — keep current state to avoid recording every keystroke
				return this.lastActiveTabId || 'browse';
			}
			if (query) {
				return `browse:${query.toLowerCase()}`;
			}
			return 'browse';
		}

		// Fallback to regular settings tabs
		const modal = modalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return "";

		const activeTab = modal.querySelector('.vertical-tab-nav-item.is-active');
		let baseTabId = (this.internalApp.setting?.activeTab?.id || activeTab?.getAttribute('data-id') || activeTab?.textContent || "").trim().toLowerCase();

		// Normalize: textContent fallback gives "community plugins" (space),
		// data-id gives "community-plugins" (hyphen). Canonicalize to hyphen form
		// so cache entries don't split across two keys.
		if (baseTabId === 'community plugins') {
			baseTabId = 'community-plugins';
		}

		if (baseTabId.includes('community-plugins') || baseTabId.includes('community plugins')) {
			const backButton = modal.querySelector('.setting-editor-back-button');
			if (backButton) {
				const titleEl = modal.querySelector('.modal-title') || modal.querySelector('.setting-item-name');
				if (titleEl?.textContent && !titleEl.textContent.toLowerCase().includes('community plugins')) {
					return `plugin:${titleEl.textContent.trim().toLowerCase()}`;
				}
			}
		}

		return baseTabId;
	}

	private recordTabChange(tabId: string, installedQuery?: string) {
		// Don't record empty or invalid tab IDs
		if (!tabId || typeof tabId !== 'string') {
			return;
		}

		const normalizedId = this.normalizeTabId(tabId);

		// Don't record empty strings
		if (!normalizedId) {
			return;
		}

		if (this.isNavigatingProgrammatically) {
			return;
		}

		// Prevent rapid-fire duplicate recordings (debounce)
		const now = Date.now();

		const currentEntry = this.history[this.currentIndex];
		const currentTabId = currentEntry?.tabId;
		const searchQuery = this.isSearchBarTab(normalizedId) ? installedQuery ?? this.savedSearchQueries[normalizedId] ?? '' : undefined;

		// 1. Strict De-duplication
		// If the new ID is exactly the same as the current history tip, ignore it.
		if (currentTabId === normalizedId && currentEntry?.searchQuery === searchQuery) {
			this.lastActiveTabId = normalizedId;
			return;
		}

		// 2. Handle Refinement & Redundancy for "plugin:name" vs "plugin:name:id"
		if (currentTabId && currentTabId.startsWith('plugin:') && normalizedId.startsWith('plugin:')) {
			const currentParts = currentTabId.split(':');
			const newParts = normalizedId.split(':');

			// Check if they refer to the same plugin name
			if (currentParts[1] === newParts[1]) {
				const currentHasId = currentParts.length > 2;
				const newHasId = newParts.length > 2;

				// Refinement: Current is "plugin:name", New is "plugin:name:id" -> REPLACE current
				if (!currentHasId && newHasId) {
					this.history[this.currentIndex].tabId = normalizedId;
					this.lastActiveTabId = normalizedId;
					this.lastRecordTime = now;
					void this.savePluginData();
					return;
				}

				// Redundancy: Current is "plugin:name:id", New is "plugin:name" -> IGNORE new
				if (currentHasId && !newHasId) {
					// We already have the specific ID, don't revert to generic
					this.lastActiveTabId = normalizedId;
					return;
				}
			}
		}

		// When clicking a plugin in the community modal, ensure a browse entry
		// (with search query if any) exists before the first plugin entry so back
		// navigation returns to the correct browse state with search preserved
		if (normalizedId.startsWith('plugin:')) {
			const doc = activeDocument;
			const communityModal = doc.querySelector('.mod-community-modal, .mod-community-plugin');
			if (communityModal) {
				const searchInput = communityModal.querySelector('.search-input-container input[type="search"], .community-modal-search-container input') as HTMLInputElement;
				const query = searchInput?.value?.trim()?.toLowerCase();
				const browseEntry = query ? `browse:${query}` : 'browse';
				if (currentTabId?.startsWith('browse:') && browseEntry === currentTabId) {
					// Same browse:query — nothing to do
				} else if (currentTabId === 'browse' && query) {
					// Had plain browse, now have a search — add browse:query as new entry
					// (keep plain browse so back can return to the no-search state)
					if (this.currentIndex < this.history.length - 1) {
						this.history = this.history.slice(0, this.currentIndex + 1);
					}
					this.history.push({ tabId: browseEntry, timestamp: Date.now() });
					if (this.history.length > 50) this.history.shift();
					this.currentIndex = this.history.length - 1;
				} else if (currentTabId?.startsWith('browse:') && browseEntry !== currentTabId) {
					// Different search query — update in place
					this.history[this.currentIndex].tabId = browseEntry;
				} else if (!currentTabId?.startsWith('plugin:') && !currentTabId?.startsWith('browse')) {
					// Transitioning from a non-plugin, non-browse state — insert a browse entry
					if (this.currentIndex < this.history.length - 1) {
						this.history = this.history.slice(0, this.currentIndex + 1);
					}
					this.history.push({ tabId: browseEntry, timestamp: Date.now() });
					if (this.history.length > 50) this.history.shift();
					this.currentIndex = this.history.length - 1;
				}
			}
		}

		// Update tracking before recording
		this.lastActiveTabId = normalizedId;
		this.lastRecordTime = now;


		if (this.currentIndex < this.history.length - 1) {
			// If we are in the middle of history and navigate, chop off the future
			this.history = this.history.slice(0, this.currentIndex + 1);
		}

		this.history.push({ tabId: normalizedId, timestamp: Date.now(), installedQuery, searchQuery });
		if (this.history.length > 50) this.history.shift();
		this.currentIndex = this.history.length - 1;

		void this.savePluginData();
		this.updateButtonStates();

		// Restore fold state first, then scroll position after folds have expanded
		this.restoreFoldState(normalizedId, () => {
			this.restoreScrollPosition(normalizedId);
		});
	}

	private navigateBack() {
		if (this.currentIndex <= 0) return;

		const currentTabId = this.detectTabIdFromDOM() || this.lastActiveTabId || '';
		this.saveCurrentView();
		const startIndex = this.currentIndex;

		// Skip back past invalid entries and entries matching current tab
		while (this.currentIndex > 0) {
			this.currentIndex--;
			const entry = this.history[this.currentIndex];
			if (!entry || !entry.tabId || entry.tabId.trim().length === 0) continue;
			// Skip if it's the same tab we're already on
			if (entry.tabId === currentTabId && (entry.searchQuery ?? entry.installedQuery) === this.findSearchInput()?.value) continue;
			// Found a different, valid entry
			this.lastNavActionTime = Date.now();
			this.updateButtonStates();
			this.performNavigation(entry.tabId, entry.searchQuery ?? entry.installedQuery);
			void this.savePluginData();
			return;
		}

		// Couldn't find a different entry — restore original position
		this.currentIndex = startIndex;
		this.updateButtonStates();
	}

	private navigateForward() {
		if (this.currentIndex >= this.history.length - 1) return;

		const currentTabId = this.detectTabIdFromDOM() || this.lastActiveTabId || '';
		this.saveCurrentView();
		const startIndex = this.currentIndex;

		// Skip forward past invalid entries and entries matching current tab
		while (this.currentIndex < this.history.length - 1) {
			this.currentIndex++;
			const entry = this.history[this.currentIndex];
			if (!entry || !entry.tabId || entry.tabId.trim().length === 0) continue;
			// Skip if it's the same tab we're already on
			if (entry.tabId === currentTabId && (entry.searchQuery ?? entry.installedQuery) === this.findSearchInput()?.value) continue;
			// Found a different, valid entry
			this.lastNavActionTime = Date.now();
			this.updateButtonStates();
			this.performNavigation(entry.tabId, entry.searchQuery ?? entry.installedQuery);
			void this.savePluginData();
			return;
		}

		// Couldn't find a different entry — restore original position
		this.currentIndex = startIndex;
		this.updateButtonStates();
	}

	private handleFirstLetterNav(letter: string, forceSidebar: boolean = true) {
		const doc = activeDocument;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
		if (!modalContainer) return;

		const modal = modalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return;

		// Collect navigable items: sidebar items + content area plugin list items
		interface NavItem { element: HTMLElement; text: string; isSidebar: boolean; }
		const items: NavItem[] = [];

		// Sidebar items
		const sidebarItems = modal.querySelectorAll('.vertical-tab-nav-item');
		sidebarItems.forEach((el) => {
			const htmlEl = el as HTMLElement;
			// Skip section headers
			if (htmlEl.classList.contains('vertical-tab-nav-header') ||
				htmlEl.classList.contains('mod-settings-section-header') ||
				htmlEl.classList.contains('settings-tab-header')) return;
			const text = (htmlEl.textContent || '').trim().toLowerCase();
			if (text) items.push({ element: htmlEl, text, isSidebar: true });
		});

		// Content area items (installed plugins, core plugins, CSS snippets, themes, etc.)
		const contentEl = modal.querySelector('.vertical-tab-content') as HTMLElement;
		if (contentEl) {
			// Standard setting items (core plugins toggles, most settings lists)
			const settingItems = contentEl.querySelectorAll('.setting-item');
			settingItems.forEach((el) => {
				const htmlEl = el as HTMLElement;
				const nameEl = htmlEl.querySelector('.setting-item-name');
				const text = (nameEl?.textContent || '').trim().toLowerCase();
				if (text) items.push({ element: htmlEl, text, isSidebar: false });
			});

			// Installed plugins list (community-plugins tab uses .installed-plugins-container)
			const pluginItems = contentEl.querySelectorAll('.installed-plugins-container .setting-item, .community-plugin-item');
			pluginItems.forEach((el) => {
				const htmlEl = el as HTMLElement;
				if (items.some(i => i.element === htmlEl)) return; // Skip duplicates
				const nameEl = htmlEl.querySelector('.setting-item-name, .community-plugin-name, .community-item-name');
				const text = (nameEl?.textContent || '').trim().toLowerCase();
				if (text) items.push({ element: htmlEl, text, isSidebar: false });
			});

			// CSS snippets on appearance page
			const snippetItems = contentEl.querySelectorAll('.installed-snippet-item, .setting-item-heading');
			snippetItems.forEach((el) => {
				const htmlEl = el as HTMLElement;
				if (items.some(i => i.element === htmlEl)) return;
				const text = (htmlEl.querySelector('.setting-item-name')?.textContent || htmlEl.textContent || '').trim().toLowerCase();
				if (text) items.push({ element: htmlEl, text, isSidebar: false });
			});
		}

		// Filter items starting with the pressed letter
		const allMatches = items.filter(item => item.text.startsWith(letter));
		if (allMatches.length === 0) return;

		// Only match items in the targeted area — no fallback
		const matches = allMatches.filter(item => item.isSidebar === forceSidebar);
		if (matches.length === 0) return;

		// Cycle logic
		const now = Date.now();
		if (letter === this.lastLetterPressed && (now - this.lastLetterTime) < 1500) {
			this.lastLetterIndex = (this.lastLetterIndex + 1) % matches.length;
		} else {
			this.lastLetterIndex = 0;
		}
		this.lastLetterPressed = letter;
		this.lastLetterTime = now;

		const target = matches[this.lastLetterIndex];
		if (target.isSidebar) {
			target.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			target.element.click();
		} else {
			target.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
			// Brief highlight
			target.element.classList.add('settings-nav-highlight');
			this.defer(() => {
				target.element.classList.remove('settings-nav-highlight');
			}, 800);
		}
	}

	private performNavigation(tabId: string, installedQuery?: string) {
		// Validate tabId before attempting navigation
		if (!tabId || typeof tabId !== 'string' || tabId.trim().length === 0) {
			console.warn('[Settings Nav] Invalid tabId for navigation:', tabId);
			// Update button states even if navigation fails
			this.updateButtonStates();
			return;
		}

		this.saveCurrentView();
		const navigation = ++this.navigationGeneration;
		this.isNavigatingProgrammatically = true;
		this.beginSearchVisit(tabId, installedQuery);
		const setting = this.internalApp.setting;
		if (!setting) { this.isNavigatingProgrammatically = false; return; }
		const doc = activeDocument;

		const getTopmostModal = () => {
			const all = Array.from(doc.querySelectorAll('.modal-container'));
			return all[all.length - 1] as HTMLElement;
		};

		try {
			if (tabId.startsWith('plugin:')) {
				const fullTarget = tabId.substring(7);
				// Handle plugin:name:id format
				const parts = fullTarget.split(':');
				const target = parts[0]; // Plugin name
				const pluginId = parts.length > 1 ? parts[1] : null; // Plugin ID if available

				{
					// Navigate to a specific community plugin's details by clicking its sidebar item
					const topmostModal = getTopmostModal();
					const communityModal = topmostModal?.querySelector('.mod-community-modal, .mod-community-plugin');

					if (communityModal) {
						// Community modal is open — find and click the plugin by name in the sidebar
						// Names may differ between detail view and sidebar (e.g. "Plugin for Obsidian" vs "Plugin")
						const items = communityModal.querySelectorAll('.community-item');
						let clicked = false;
						// First try exact match, then substring match
						for (let i = 0; i < items.length; i++) {
							const itemName = items[i].querySelector('.community-item-name')?.textContent?.trim()?.toLowerCase();
							if (itemName === target) {
								(items[i] as HTMLElement).click();
								clicked = true;
								break;
							}
						}
						if (!clicked) {
							for (let i = 0; i < items.length; i++) {
								const itemName = items[i].querySelector('.community-item-name')?.textContent?.trim()?.toLowerCase();
								if (itemName && (target.includes(itemName) || itemName.includes(target))) {
									(items[i] as HTMLElement).click();
									clicked = true;
									break;
								}
							}
						}
						if (!clicked && pluginId) {
							// Fallback: use obsidian:// URI if item not found in list
							window.open('obsidian://show-plugin?id=' + encodeURIComponent(pluginId));
						}
					} else {
						// Community modal not open — open browse first, then navigate
						setting?.openTabById('community-plugins');
						this.defer(() => {
							const newTop = getTopmostModal();
							const browseBtn = Array.from(newTop?.querySelectorAll('.mod-cta') || [])
								.find(el => el.textContent?.trim().toLowerCase() === 'browse') as HTMLElement;
							if (browseBtn) {
								browseBtn.click();
								this.defer(() => this.performNavigation(tabId), 500);
							}
						}, 300);
						return;
					}
				}
			} else if (tabId === 'browse' || tabId.startsWith('browse:')) {
				const browseQuery = tabId.startsWith('browse:') ? tabId.substring(7) : '';
				let topmostModal = getTopmostModal();
				const communityModal = topmostModal?.querySelector('.mod-community-modal, .mod-community-plugin');
				if (communityModal) {
					// Community modal is open — remove details pane and deselect
					// to restore the full-width browse grid
					const selected = communityModal.querySelector('.community-item.is-selected');
					if (selected) selected.classList.remove('is-selected');
					const details = communityModal.querySelector('.community-modal-details');
					if (details) details.remove();
					// Restore or clear the search query
					const searchInput = communityModal.querySelector('.search-input-container input[type="search"], .community-modal-search-container input') as HTMLInputElement;
					if (searchInput) {
						searchInput.value = browseQuery;
						searchInput.dispatchEvent(new Event('input', { bubbles: true }));
					}
				} else if (topmostModal) {
					// Settings modal open but no browse modal — click Browse button
					const browseBtn = Array.from(topmostModal.querySelectorAll('.mod-cta') || [])
						.find(el => el.textContent?.trim().toLowerCase() === 'browse') as HTMLElement;
					if (browseBtn) browseBtn.click();
				} else {
					// No modals — open settings, community plugins, then browse
					setting?.openTabById('community-plugins');
					this.defer(() => {
						const newTop = getTopmostModal();
						const browseBtn = Array.from(newTop?.querySelectorAll('.mod-cta') || [])
							.find(el => el.textContent?.trim().toLowerCase() === 'browse') as HTMLElement;
						if (browseBtn) browseBtn.click();
					}, 300);
				}
			} else {
				// Regular settings tab
				// Close the community plugins modal if it's open
				const topmostModal = getTopmostModal();
				if (topmostModal && (topmostModal.querySelector('.community-modal, .mod-community-modal, .mod-community-plugin') || topmostModal.querySelector('.community-plugin-details'))) {
					const closeBtn = topmostModal.querySelector('.modal-close-button') as HTMLElement;
					if (closeBtn) closeBtn.click();
				}
				// openTabById works for core Options tabs (editor, appearance, etc.)
				// For core plugin and community plugin tabs that lack data-id,
				// we need to click the sidebar item by text content
				setting.openTabById(tabId);

				// Check if openTabById worked by seeing if the active tab changed
				this.defer(() => {
					if (navigation !== this.navigationGeneration) return;
					const topmostModal = getTopmostModal();
					if (!topmostModal) return;
					const activeTab = topmostModal.querySelector('.vertical-tab-nav-item.is-active');
					const currentId = (activeTab?.getAttribute('data-id') || activeTab?.textContent || '').trim().toLowerCase();
					if (currentId === tabId) return; // Already navigated

					// openTabById failed — find and click the sidebar item by text
					const allItems = Array.from(topmostModal.querySelectorAll('.vertical-tab-nav-item'));
					const tabIdSpaces = tabId.replace(/-/g, ' ');
					const match = allItems.find(el => {
						const elText = el.textContent?.trim().toLowerCase() || '';
						return elText === tabId || elText === tabIdSpaces;
					});
					if (match) {
						this.isNavigatingProgrammatically = true;
						try { (match as HTMLElement).click(); this.syncSearchBar(); } finally { this.isNavigatingProgrammatically = false; }
					}
				}, 100);
			}
		} catch (e) {
			console.warn('[Settings Nav] Navigation failed', e);
		} finally { this.isNavigatingProgrammatically = false; }

		this.lastActiveTabId = tabId;
		this.updateButtonStates();

		// Restore fold state first, then scroll position after folds have expanded
		this.restoreFoldState(tabId, () => {
			this.restoreScrollPosition(tabId);
		});
		this.syncSearchBar();

		this.isNavigatingProgrammatically = false;
	}

	updateButtonStates() {
		if (!this.floatingPane) return;
		const canBack = this.currentIndex > 0;
		const canForward = this.currentIndex < this.history.length - 1;

		const back = this.floatingPane.querySelector('.settings-nav-float-button:first-child') as HTMLElement;
		const forward = this.floatingPane.querySelector('.settings-nav-float-button:nth-child(2)') as HTMLElement;
		const indicator = this.floatingPane.querySelector('.settings-nav-indicator') as HTMLElement;

		if (back) back.classList.toggle('is-disabled', !canBack);
		if (forward) forward.classList.toggle('is-disabled', !canForward);
		if (indicator) indicator.textContent = `${this.currentIndex + 1}/${this.history.length}`;

		const pluginInfoBtn = this.floatingPane.querySelector('.settings-nav-plugin-info-btn') as HTMLElement;
		const separatorEl = this.floatingPane.querySelector('.settings-nav-separator') as HTMLElement;
		if (pluginInfoBtn) {
			const doc = activeDocument;
			const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
			const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
			let isPluginTab = false;

			if (modalContainer) {
				const modal = modalContainer.querySelector('.modal') as HTMLElement;
				if (modal) {
					const activeTab = modal.querySelector('.vertical-tab-nav-item.is-active');
					const tabId = (activeTab?.getAttribute('data-id') || activeTab?.textContent || '').trim().toLowerCase();
					isPluginTab = this.isCommunityPluginTab(tabId);
				}
			}

			// Hide button and separator when not on a community plugin tab
			pluginInfoBtn.classList.toggle('settings-nav-hidden', !isPluginTab);
			if (separatorEl) separatorEl.classList.toggle('settings-nav-hidden', !isPluginTab);
		}

		// Update tab label
		const tabLabel = this.floatingPane.querySelector('.settings-nav-tab-label') as HTMLElement;
		if (tabLabel) {
			if (this.settings.showTabLabel > 0) {
				tabLabel.style.fontSize = this.settings.showTabLabel + 'px';
				const doc = activeDocument;
				const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
				const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
				let tabName = '';
				if (modalContainer) {
					const modal = modalContainer.querySelector('.modal') as HTMLElement;
					if (modal) {
						const activeTab = modal.querySelector('.vertical-tab-nav-item.is-active');
						tabName = activeTab?.textContent?.trim() || '';
					}
				}
				tabLabel.textContent = tabName;
				tabLabel.classList.toggle('settings-nav-hidden', !tabName);
			} else {
				tabLabel.classList.add('settings-nav-hidden');
			}
		}
	}

	private getSettingsContentEl(): HTMLElement | null {
		const root = this.getNavigationModal();
		if (!root || !root.querySelector('.vertical-tab-nav-item, .vertical-tab-header')) return null;
		const activeContent = this.internalApp.setting?.activeTab?.containerEl;
		if (activeContent?.isConnected && root.contains(activeContent)) return activeContent;
		return root.querySelector<HTMLElement>('.vertical-tab-content');
	}


	private saveCurrentView() {
		const tab = this.detectTabIdFromDOM();
		if (!tab || tab !== this.lastActiveTabId || !this.settings.cacheScrollPositions) return;
		const content = this.getSettingsContentEl();
		if (content && !this.scrollRestoring.has(tab) && !this.foldRestoring.has(tab)) this.scrollCache.set(tab, content.scrollTop);
		this.saveFoldState(tab);
	}

	private restoreScrollPosition(tabId: string) {
		if (!this.settings.cacheScrollPositions) return;
		const position = this.scrollCache.get(tabId);
		if (position === undefined) return;
		const generation = this.viewGeneration;
		this.scrollRestoring.add(tabId);
		const restore = (attempts: number) => {
			if (generation !== this.viewGeneration || this.detectTabIdFromDOM() !== tabId) { this.scrollRestoring.delete(tabId); return; }
			const content = this.getSettingsContentEl();
			if (content) content.scrollTop = position;
			if (content && Math.abs(content.scrollTop - position) < 1 || attempts <= 0) this.scrollRestoring.delete(tabId);
			else this.defer(() => restore(attempts - 1), 50);
		};
		restore(10);
	}

	private getHeadingPath(heading: HTMLElement): string {
		const parts = [heading.dataset.id || heading.querySelector('.setting-item-name')?.textContent?.trim() || ''];
		for (let parent = heading.parentElement; parent; parent = parent.parentElement) {
			if (parent.classList.contains('style-settings-container')) {
				const owner = parent.previousElementSibling as HTMLElement | null;
				if (owner?.matches('.style-settings-heading')) parts.unshift(owner.dataset.id || owner.querySelector('.setting-item-name')?.textContent?.trim() || '');
			}
		}
		return parts.map(encodeURIComponent).join('/');
	}

	private saveFoldState(tabId: string) {
		if (!this.settings.cacheScrollPositions || this.foldRestoring.has(tabId) || this.detectTabIdFromDOM() !== tabId) return;
		if (this.getSettingsContentEl()?.querySelector<HTMLInputElement>('.search-input-container input')?.value) return;
		const headings = this.getSettingsContentEl()?.querySelectorAll<HTMLElement>('.style-settings-heading');
		if (!headings?.length) return;
		// Collapsing a section removes its descendants from the DOM. Preserve their
		// states so opening the parent later can recover the same nested layout.
		const state = { ...this.foldStateCache.get(tabId) };
		for (const heading of Array.from(headings)) state[this.getHeadingPath(heading)] = !heading.classList.contains('is-collapsed');
		this.foldStateCache.set(tabId, state);
	}

	private rememberHeadingToggle(heading: HTMLElement) {
		const tab = this.detectTabIdFromDOM();
		if (!this.settings.cacheScrollPositions || !this.getSettingsContentEl()?.contains(heading)) return;
		if (this.getSettingsContentEl()?.querySelector<HTMLInputElement>('.search-input-container input')?.value) return;
		this.viewGeneration++;
		this.foldRestoring.delete(tab);
		this.saveFoldState(tab);
		const state = this.foldStateCache.get(tab) ?? {};
		// The capture listener runs before Style Settings changes the heading.
		state[this.getHeadingPath(heading)] = heading.classList.contains('is-collapsed');
		this.foldStateCache.set(tab, state);
		this.foldRestoring.add(tab);
		this.defer(() => this.restoreFoldState(tab, () => { this.saveFoldState(tab); void this.savePluginData(); }), 0);
	}

	private restoreFoldState(tabId: string, onComplete?: () => void) {
		const saved = this.foldStateCache.get(tabId);
		if (!saved || !this.settings.cacheScrollPositions) { onComplete?.(); return; }
		if (this.getSettingsContentEl()?.querySelector<HTMLInputElement>('.search-input-container input')?.value) { onComplete?.(); return; }
		const generation = this.viewGeneration;
		this.foldRestoring.add(tabId);
		const restore = (attempts: number) => {
			if (generation !== this.viewGeneration || this.detectTabIdFromDOM() !== tabId || !this.foldRestoring.has(tabId)) return;
			const content = this.getSettingsContentEl();
			const headings = Array.from(content?.querySelectorAll<HTMLElement>('.style-settings-heading') ?? []);
			let changed = false;
			for (const heading of headings) {
				if (!heading.isConnected) continue;
				const expanded = saved[this.getHeadingPath(heading)];
				if (expanded !== undefined && expanded === heading.classList.contains('is-collapsed')) { heading.click(); changed = true; }
			}
			if (attempts > 0 && (changed || !headings.length)) this.defer(() => restore(attempts - 1), changed ? 0 : 50);
			else { this.foldRestoring.delete(tabId); onComplete?.(); }
		};
		restore(20);
	}

	private normalizeTabId(tabId: string): string {
		const id = tabId.trim().toLowerCase();
		return id === 'community plugins' ? 'community-plugins' : id === 'core plugins' ? 'core-plugins' : id;
	}

	private getNavigationModal(): HTMLElement | null {
		const settings = this.internalApp.setting?.containerEl;
		const settingsModal = settings?.matches('.modal') ? settings : settings?.querySelector<HTMLElement>('.modal') ?? settings;
		const containers = Array.from(activeDocument.querySelectorAll<HTMLElement>('.modal-container'));
		const top = containers[containers.length - 1];
		if (top) {
			if (top.querySelector('.prompt')) return null;
			if (settingsModal?.isConnected && top.contains(settingsModal)) return settingsModal;
			const modal = top.querySelector<HTMLElement>(':scope > .modal');
			return modal?.matches('.mod-community-modal, .mod-community-plugin') ? modal : null;
		}
		// Obsidian 1.13 may open settings in its own window.
		return settingsModal?.isConnected && settingsModal.ownerDocument === activeDocument ? settingsModal : null;
	}

	private isSnippetName(el: HTMLElement): boolean {
		return Platform.isDesktopApp && this.detectTabIdFromDOM() === 'appearance'
			&& !!this.getSettingsContentEl()?.contains(el)
			&& !!this.internalApp.customCss?.snippets.includes(el.textContent?.trim() ?? '');
	}

	private async openSnippet(name: string) {
		const css = this.internalApp.customCss;
		if (!Platform.isDesktopApp || !css?.snippets.includes(name) || !this.internalApp.openWithDefaultApp) return;
		try { await this.internalApp.openWithDefaultApp(css.getSnippetPath(name)); }
		catch { new Notice('Could not open the snippet in the default app.'); }
	}

	private openInstalledPlugin(info: { name: string; id: string }) {
		const query = this.internalApp.plugins?.manifests[info.id]?.name || info.name;
		this.isNavigatingProgrammatically = false;
		this.recordTabChange('community-plugins', query);
		this.performNavigation('community-plugins', query);
	}

	private beginSearchVisit(tabId: string, query?: string) {
		this.searchGeneration++;
		this.viewGeneration++;
		this.foldRestoring.clear();
		this.scrollRestoring.clear();
		this.restoredSearchInput = null;
		this.searchVisitTab = this.normalizeTabId(tabId);
		this.temporaryInstalledQuery = query;
	}

	private findSearchInput(tabId = this.detectTabIdFromDOM()): HTMLInputElement | null {
		if (!this.isSearchBarTab(tabId) || this.detectTabIdFromDOM() !== tabId) return null;
		const content = this.getSettingsContentEl();
		return content?.querySelector<HTMLInputElement>('.installed-plugins-container .search-input-container input, .setting-group-search input, .hotkey-filter input, .search-input-container input, input[type="search"]') ?? null;
	}

	private captureSearchEdit(target: EventTarget | null) {
		const tab = this.detectTabIdFromDOM();
		const input = this.findSearchInput(tab);
		if (!input || input !== target) return;
		this.searchGeneration++;
		this.searchVisitTab = tab;
		this.restoredSearchInput = input;
		this.temporaryInstalledQuery = input.value;
		const entry = this.history[this.currentIndex];
		if (entry?.tabId === tab) { entry.searchQuery = input.value; delete entry.installedQuery; }
		if (this.settings.cacheSearchBar) this.savedSearchQueries[tab] = input.value;
		void this.savePluginData();
	}

	private syncSearchBar() {
		if (this.unloaded) return;
		const tab = this.detectTabIdFromDOM();
		if (tab !== this.searchVisitTab) {
			if (this.isNavigatingProgrammatically) return;
			this.beginSearchVisit(tab);
		}
		const input = this.findSearchInput(tab);
		if (!input || input === this.restoredSearchInput) return;
		this.restoredSearchInput = input;
		const query = this.temporaryInstalledQuery ?? (this.settings.cacheSearchBar ? this.savedSearchQueries[tab] : undefined);
		if (query !== undefined && input.value !== query) {
			input.value = query;
			input.dispatchEvent(new (input.ownerDocument.defaultView ?? window).Event('input', { bubbles: true }));
		}
	}

	private attachPuzzleTooltip(button: HTMLElement, scope: Component) {
		this.attachModifierTooltip(button, scope, e => this.settings.ctrlClickOpensGithub && (e.ctrlKey || e.metaKey) ? 'Open plugin on GitHub'
			: (this.settings.browseDefaultInstalled !== e.shiftKey ? 'View in installed plugins' : 'View in community plugins'));
	}

	private attachModifierTooltip(button: HTMLElement, scope: Component, label: (e: MouseEvent | KeyboardEvent) => string, destructive = false) {
		let hovered = false;
		const update = (e: MouseEvent | KeyboardEvent) => {
			if (!hovered && button.ownerDocument.activeElement !== button) return;
			const text = label(e);
			button.classList.toggle('shift-held', destructive && text === 'Delete plugin');
			setTooltip(button, text, { delay: 0 });
			displayTooltip(button, text, { delay: 0 });
		};
		scope.registerDomEvent(button, 'mouseenter', e => { hovered = true; update(e); });
		scope.registerDomEvent(button, 'mouseleave', () => { hovered = false; button.classList.remove('shift-held'); });
		scope.registerDomEvent(button, 'blur', () => button.classList.remove('shift-held'));
		scope.registerDomEvent(button.ownerDocument, 'keydown', update);
		scope.registerDomEvent(button.ownerDocument, 'keyup', update);
	}

	private async handlePuzzleClick(info: { name: string; id: string }, e?: MouseEvent) {
		if (this.settings.ctrlClickOpensGithub && (e?.ctrlKey || e?.metaKey)) { await this.openPluginGithub(info.id); return; }
		if (this.settings.browseDefaultInstalled !== !!e?.shiftKey) this.openInstalledPlugin(info);
		else window.open('obsidian://show-plugin?id=' + encodeURIComponent(info.id));
	}

	private async openPluginGithub(id: string) {
		try {
			if (!this.githubRepos) {
				const response = await requestUrl('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json');
				const entries: unknown = response.json;
				if (!Array.isArray(entries)) throw new Error('Invalid community plugin directory');
				this.githubRepos = new Map();
				for (const item of entries as unknown[]) {
					if (!item || typeof item !== 'object') continue;
					const entry = item as { id?: unknown; repo?: unknown };
					if (typeof entry.id === 'string' && typeof entry.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entry.repo)) this.githubRepos.set(entry.id, entry.repo);
				}
			}
			if (this.unloaded) return;
			const repo = this.githubRepos.get(id);
			if (!repo) { new Notice('This plugin has no repository in the community directory.'); return; }
			window.open('https://github.com/' + repo);
		} catch (error) { console.error('Settings Navigator: repository lookup failed', error); new Notice('Could not look up the plugin repository. Check your connection and try again.'); }
	}

	private defer(callback: () => void, delay: number): number {
		const timer = window.setTimeout(() => {
			this.timers.delete(timer);
			if (!this.unloaded) callback();
		}, delay);
		this.timers.add(timer);
		return timer;
	}

	private injectXButtons() {
		const modal = this.getNavigationModal();
		const sidebar = modal?.querySelector<HTMLElement>('.vertical-tab-header');
		if (!modal || !sidebar) return;
		if (this.sidebarRoot !== sidebar) {
			this.removeAllXButtons();
			this.sidebarRoot = sidebar;
		}

		// Make "Core plugins" and "Community plugins" section headers clickable
		const headers = modal.querySelectorAll('.vertical-tab-header-group-title');
		headers.forEach((header: Element) => {
			const headerEl = header as HTMLElement;
			if (this.injectedXButtons.has(headerEl)) return;
			const text = (headerEl.textContent || '').trim().toLowerCase();
			let targetTabId: string | null = null;
			if (text.includes('core plugins')) targetTabId = 'core-plugins';
			else if (text.includes('community plugins')) targetTabId = 'community-plugins';
			if (targetTabId) {
				headerEl.classList.add('settings-nav-clickable-heading');
				this.ui.register(() => headerEl.classList.remove('settings-nav-clickable-heading'));
				const tabId = targetTabId;
				this.ui.registerDomEvent(headerEl, 'click', (e) => {
					e.stopPropagation();
					this.recordTabChange(tabId);
					this.performNavigation(tabId);
				});
				this.injectedXButtons.add(headerEl);
			}
		});

		const navItems = modal.querySelectorAll('.vertical-tab-nav-item');
		navItems.forEach((item: Element) => {
			const navItem = item as HTMLElement;
			if (this.injectedXButtons.has(navItem)) return;

			// Skip section headers (e.g. "Options", "Core plugins", "Community plugins")
			if (navItem.classList.contains('vertical-tab-nav-header') ||
				navItem.classList.contains('mod-settings-section-header') ||
				navItem.classList.contains('settings-tab-header')) return;

			const dataId = (navItem.getAttribute('data-id') || '').trim().toLowerCase();
			const textContent = (navItem.textContent || '').trim().toLowerCase();

			// Skip core settings tabs by data-id
			if (dataId && CORE_TAB_IDS.has(dataId)) return;
			if (dataId === 'general') return;

			// Skip known section header text that may not have a distinguishing class
			const skipTexts = new Set([
				'options', 'general', 'core plugins', 'community plugins',
				'files & links', 'files and links',
			]);
			if (!dataId && skipTexts.has(textContent)) return;

			const tabId = (dataId || textContent);
			if (!tabId) return;

			// Check if it's a core plugin or community plugin
			const isCommunity = this.isCommunityPluginTab(tabId);

			const coreId = !isCommunity ? corePluginId(this.internalApp, tabId) : null;
			const isCorePlugin = coreId !== null;

			// Only add buttons for actual plugin tabs
			if (!isCommunity && !isCorePlugin) return;

			navItem.classList.add('settings-nav-plugin-item');
			this.ui.register(() => navItem.classList.remove('settings-nav-plugin-item'));

			// Add browse button (to the left of X) for community plugins
			if (isCommunity && this.settings.enableBrowseButtons) {
				this.createBrowseButton(navItem, tabId);
			}

			// Add X button
			if (this.settings.enableXButtons) {
				this.createXButton(navItem, coreId ?? tabId, isCommunity);
			}

			this.injectedXButtons.add(navItem);
		});
	}

	private createXButton(navItem: HTMLElement, tabId: string, isCommunity: boolean) {
		const button = navItem.createDiv({ cls: 'settings-nav-x-button clickable-icon' });
		button.setAttribute('role', 'button'); button.tabIndex = 0;
		setIcon(button, 'x'); setTooltip(button, 'Disable plugin');
		this.attachModifierTooltip(button, this.ui, e => e.ctrlKey ? 'Reload plugin' : e.shiftKey && isCommunity ? 'Delete plugin' : 'Disable plugin', true);
		this.ui.registerDomEvent(button, 'click', (e) => {
			e.stopPropagation(); e.preventDefault();
			if (e.ctrlKey) void this.reloadPlugin(tabId, isCommunity);
			else if (e.shiftKey && isCommunity) void this.handleDeletePlugin(tabId);
			else void this.handleDisablePlugin(tabId, isCommunity);
		});
		this.ui.registerDomEvent(button, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); button.click(); } });
		this.ui.register(() => button.remove());
	}

	private createBrowseButton(navItem: HTMLElement, tabId: string) {
		const button = navItem.createDiv({ cls: 'settings-nav-browse-button clickable-icon' });
		button.setAttribute('role', 'button'); button.tabIndex = 0;
		setIcon(button, 'puzzle'); this.attachPuzzleTooltip(button, this.ui);
		this.ui.registerDomEvent(button, 'click', e => {
			e.stopPropagation(); e.preventDefault();
			const info = this.getPluginInfoForTab(tabId);
			if (info) void this.handlePuzzleClick(info, e);
		});
		this.ui.registerDomEvent(button, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); button.click(); } });
		this.ui.register(() => button.remove());
	}

	private async reloadPlugin(tabId: string, isCommunity: boolean) {
		try {
			if (isCommunity) {
				const info = this.getPluginInfoForTab(tabId);
				const plugins = this.internalApp.plugins;
				if (!info || !plugins) return;
				await plugins.disablePlugin(info.id);
				await plugins.enablePlugin(info.id);
			} else {
				const plugin = this.internalApp.internalPlugins?.getPluginById(tabId);
				plugin?.disable(false);
				await plugin?.enable(false);
			}
		} catch (error) { console.error('Settings Navigator: reload failed', error); new Notice('Could not reload the plugin.'); }
	}

	private async handleDisablePlugin(tabId: string, isCommunity: boolean) {
		const plugins = this.internalApp.plugins;
		const setting = this.internalApp.setting;

		if (isCommunity) {
			const pluginInfo = this.getPluginInfoForTab(tabId);
			if (pluginInfo) {
				try {
					await plugins?.disablePluginAndSave(pluginInfo.id);
					setting?.openTabById('community-plugins');
				} catch (error) {
					console.error('[Settings Nav] Failed to disable plugin:', error);
				}
			}
		} else {
			// Core plugin — disable by tab ID
			try {
				this.internalApp.internalPlugins?.getPluginById(tabId)?.disable(true);
				setting?.openTabById('core-plugins');
			} catch (error) {
				console.error('[Settings Nav] Failed to disable core plugin:', error);
			}
		}
	}

	private async handleDeletePlugin(tabId: string) {
		const pluginInfo = this.getPluginInfoForTab(tabId);
		if (!pluginInfo) return;

		try {
			const plugins = this.internalApp.plugins;
			await plugins?.uninstallPlugin(pluginInfo.id);
			this.internalApp.setting?.openTabById('community-plugins');
		} catch (error) {
			console.error('[Settings Nav] Failed to uninstall plugin:', error);
		}
	}

	removeAllXButtons() {
		this.ui.unload();
		this.ui.load();
		this.sidebarRoot = null;
		this.injectedXButtons = new WeakSet();
	}

	onunload() {
		this.unloaded = true;
		this.searchGeneration++;
		for (const timer of this.timers) window.clearTimeout(timer);
		this.timers.clear();
		if (this.pollInterval) window.clearInterval(this.pollInterval);
		if (this.floatingPane) this.floatingPane.remove();
		this.eventDocuments.clear();
		this.ui.unload();
		this.paneUi.unload();
	}
}
