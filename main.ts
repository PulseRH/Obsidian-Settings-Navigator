import { Plugin, PluginSettingTab, Setting, setIcon, App } from 'obsidian';

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
}

interface PluginData {
	lastTabId?: string;
	history?: SettingsHistory[];
	currentIndex?: number;
	enableXButtons?: boolean;
	enableBrowseButtons?: boolean;
	browseDefaultInstalled?: boolean;
	transparentNavBar?: boolean;
	cacheScrollPositions?: boolean;
	cacheSearchBar?: boolean;
	enableFirstLetterNav?: boolean;
	letterNavMode?: 'tab' | 'shift';
	savedSearchQuery?: string;
}

interface PluginSettings {
	enableXButtons: boolean;
	enableBrowseButtons: boolean;
	browseDefaultInstalled: boolean;
	transparentNavBar: boolean;
	cacheScrollPositions: boolean;
	cacheSearchBar: boolean;
	enableFirstLetterNav: boolean;
	letterNavMode: 'tab' | 'shift';
}

export default class SettingsBackAndForthPlugin extends Plugin {
	private history: SettingsHistory[] = [];
	private currentIndex: number = -1;
	private isNavigatingProgrammatically: boolean = false;
	private lastActiveTabId: string | null = null;
	private lastRecordTime: number = 0;
	private floatingPane: HTMLElement | null = null;
	private pollInterval: number | null = null;
	private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
	private mouseHandler: ((e: MouseEvent) => void) | null = null;
	settings: PluginSettings = { enableXButtons: true, enableBrowseButtons: true, browseDefaultInstalled: false, transparentNavBar: false, cacheScrollPositions: true, cacheSearchBar: true, enableFirstLetterNav: true, letterNavMode: 'tab' };
	private injectedXButtons: WeakSet<HTMLElement> = new WeakSet();
	private scrollCache: Map<string, number> = new Map();
	private foldStateCache: Map<string, string[]> = new Map();
	savedSearchQuery: string = '';
	private searchBarRestored: boolean = false;
	private searchBarRestoring: boolean = false;
	private modalWasClosed: boolean = false;
	private lastLetterPressed: string = '';
	private lastLetterIndex: number = -1;
	private lastLetterTime: number = 0;
	private letterNavFocusSidebar: boolean = true;

	private isCommunityPluginsTab(tabId: string | null): boolean {
		if (!tabId) return false;
		return tabId === 'community-plugins' || tabId === 'community plugins';
	}

	async onload() {
		console.log('[Settings Nav] Plugin loading...');
		await this.loadSavedData();
		this.addSettingTab(new SettingsNavigatorSettingTab(this.app, this));

		// Direct keydown listener for Ctrl+Z/Ctrl+X and first-letter navigation
		this.keydownHandler = (e: KeyboardEvent) => {
			const settingsOpen = document.querySelector('.modal-container .modal');
			if (!settingsOpen) return;

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
			const active = document.activeElement;
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
		document.addEventListener('keydown', this.keydownHandler, true);

		// Mouse 4/5 (back/forward) buttons for navigation
		this.mouseHandler = (e: MouseEvent) => {
			// button 3 = Mouse4 (back), button 4 = Mouse5 (forward)
			if (e.button !== 3 && e.button !== 4) return;
			const settingsOpen = document.querySelector('.modal-container .modal');
			if (!settingsOpen) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.button === 3) {
				this.navigateBack();
			} else if (e.button === 4) {
				this.navigateForward();
			}
		};
		document.addEventListener('mousedown', this.mouseHandler, true);
		document.addEventListener('mouseup', this.mouseHandler, true);
		document.addEventListener('auxclick', this.mouseHandler, true);

		this.app.workspace.onLayoutReady(() => {
			this.ensureFloatingPane();
			this.setupNavigationTracking();
		});

		this.ensureFloatingPane();
	}

	async loadSavedData() {
		try {
			const data = await this.loadData() as PluginData;
			if (data) {
				this.settings.enableXButtons = data.enableXButtons ?? true;
				this.settings.enableBrowseButtons = data.enableBrowseButtons ?? true;
				this.settings.browseDefaultInstalled = data.browseDefaultInstalled ?? false;
				this.settings.transparentNavBar = data.transparentNavBar ?? false;
				this.settings.cacheScrollPositions = data.cacheScrollPositions ?? true;
				this.settings.cacheSearchBar = data.cacheSearchBar ?? true;
				this.settings.enableFirstLetterNav = data.enableFirstLetterNav ?? true;
				this.settings.letterNavMode = data.letterNavMode ?? 'tab';
				this.savedSearchQuery = data.savedSearchQuery ?? '';
			}
			if (data && data.history) {
				// Clean up invalid history entries (empty strings, null, undefined)
				this.history = data.history.filter(entry =>
					entry &&
					entry.tabId &&
					typeof entry.tabId === 'string' &&
					entry.tabId.trim().length > 0
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
				history: this.history,
				currentIndex: this.currentIndex,
				lastTabId: this.history.length > 0 ? this.history[this.currentIndex]?.tabId : undefined,
				enableXButtons: this.settings.enableXButtons,
				enableBrowseButtons: this.settings.enableBrowseButtons,
				browseDefaultInstalled: this.settings.browseDefaultInstalled,
				transparentNavBar: this.settings.transparentNavBar,
				cacheScrollPositions: this.settings.cacheScrollPositions,
				cacheSearchBar: this.settings.cacheSearchBar,
				enableFirstLetterNav: this.settings.enableFirstLetterNav,
				letterNavMode: this.settings.letterNavMode,
				savedSearchQuery: this.savedSearchQuery,
			};
			await this.saveData(data);
		} catch (error) {
			console.error('[Settings Nav] Error saving data:', error);
		}
	}

	private isCommunityPluginTab(tabId: string): boolean {
		if (!tabId || tabId.startsWith('plugin:') || tabId === 'browse') return false;
		if (CORE_TAB_IDS.has(tabId)) return false;
		const plugins = (this.app as any).plugins?.manifests;
		if (!plugins) return false;
		// Direct ID match
		if (tabId in plugins) return true;
		// Match by display name (for tabs that use textContent instead of data-id)
		return Object.values(plugins).some(
			(m: any) => m.name?.toLowerCase() === tabId
		);
	}

	private getPluginInfoForTab(tabId: string): { name: string; id: string } | null {
		const plugins = (this.app as any).plugins?.manifests;
		if (!plugins) return null;
		// Direct ID match
		if (tabId in plugins) {
			return { name: plugins[tabId].name.toLowerCase(), id: tabId };
		}
		// Match by display name
		for (const [id, manifest] of Object.entries(plugins)) {
			if ((manifest as any).name?.toLowerCase() === tabId) {
				return { name: (manifest as any).name.toLowerCase(), id };
			}
		}
		return null;
	}

	private openPluginInBrowse() {
		const doc = activeDocument || document;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
		if (!modalContainer) return;

		const modal = modalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return;

		const activeTab = modal.querySelector('.vertical-tab-nav-item.is-active');
		const tabId = (activeTab?.getAttribute('data-id') || activeTab?.textContent || '').trim().toLowerCase();

		if (!tabId || !this.isCommunityPluginTab(tabId)) return;

		const pluginInfo = this.getPluginInfoForTab(tabId);
		if (!pluginInfo) return;

		const navTarget = `plugin:${pluginInfo.name}:${pluginInfo.id}`;
		this.recordTabChange(navTarget);
		this.performNavigation(navTarget);
	}

	private ensureFloatingPane() {
		const doc = activeDocument || document;
		const targetParent = doc.body;

		if (this.floatingPane && this.floatingPane.parentElement === targetParent) {
			return;
		}

		if (this.floatingPane) this.floatingPane.remove();

		this.floatingPane = doc.createElement('div');
		this.floatingPane.className = 'settings-nav-floating-pane';

		this.applyNavBarStyle();

		// Stop propagation on the pane itself to prevent modal closing
		this.floatingPane.addEventListener('mousedown', (e) => e.stopPropagation());
		this.floatingPane.addEventListener('click', (e) => e.stopPropagation());

		const backBtn = doc.createElement('div');
		backBtn.className = 'settings-nav-float-button clickable-icon';
		backBtn.setAttribute('aria-label', 'Go back');
		setIcon(backBtn, 'arrow-left');
		backBtn.onclick = (e) => {
			e.stopPropagation();
			this.navigateBack();
		};

		const forwardBtn = doc.createElement('div');
		forwardBtn.className = 'settings-nav-float-button clickable-icon';
		forwardBtn.setAttribute('aria-label', 'Go forward');
		setIcon(forwardBtn, 'arrow-right');
		forwardBtn.onclick = (e) => {
			e.stopPropagation();
			this.navigateForward();
		};

		const indicator = doc.createElement('div');
		indicator.className = 'settings-nav-indicator';

		const separator = doc.createElement('div');
		separator.className = 'settings-nav-separator';

		const pluginInfoBtn = doc.createElement('div');
		pluginInfoBtn.className = 'settings-nav-float-button settings-nav-plugin-info-btn clickable-icon';
		pluginInfoBtn.setAttribute('aria-label', 'View in Community Plugins');
		setIcon(pluginInfoBtn, 'puzzle');
		pluginInfoBtn.onclick = (e) => {
			e.stopPropagation();
			this.openPluginInBrowse();
		};

		this.floatingPane.appendChild(backBtn);
		this.floatingPane.appendChild(forwardBtn);
		this.floatingPane.appendChild(indicator);
		this.floatingPane.appendChild(separator);
		this.floatingPane.appendChild(pluginInfoBtn);

		targetParent.appendChild(this.floatingPane);
		this.updateButtonStates();
	}

	applyNavBarStyle() {
		if (!this.floatingPane) return;

		if (this.settings.transparentNavBar) {
			this.floatingPane.style.cssText = `
				display: flex !important;
				flex-direction: row !important;
				align-items: center !important;
				gap: 6px !important;
				padding: 0 !important;
				background: transparent !important;
				border: none !important;
				box-shadow: none !important;
				z-index: 2147483647 !important;
				pointer-events: auto !important;
				position: fixed !important;
				visibility: visible !important;
				opacity: 1 !important;
			`;
			this.floatingPane.classList.add('mod-transparent');
		} else {
			this.floatingPane.style.cssText = `
				display: flex !important;
				flex-direction: row !important;
				align-items: center !important;
				gap: 8px !important;
				padding: 6px 10px !important;
				background: var(--background-secondary) !important;
				border: 1px solid var(--background-modifier-border) !important;
				border-radius: 8px !important;
				box-shadow: var(--shadow-l) !important;
				z-index: 2147483647 !important;
				pointer-events: auto !important;
				position: fixed !important;
				visibility: visible !important;
				opacity: 1 !important;
			`;
			this.floatingPane.classList.remove('mod-transparent');
		}
	}

	private setupNavigationTracking() {
		const plugin = this;
		const setting = (this.app as any).setting;
		if (setting) {
			const originalOpenTabById = setting.openTabById;
			setting.openTabById = function (tabId: string) {
				const result = originalOpenTabById.apply(this, arguments);
				if (!plugin.isNavigatingProgrammatically) {
					setTimeout(() => {
						const effectiveTabId = tabId || plugin.detectTabIdFromDOM();
						// Only record if we have a valid, non-empty tab ID
						if (effectiveTabId && effectiveTabId.trim().length > 0) {
							plugin.recordTabChange(effectiveTabId);
						}
					}, 50);
				}
				return result;
			};
		}

		this.pollInterval = window.setInterval(() => {
			const doc = activeDocument || document;
			this.ensureFloatingPane();

			if (!this.floatingPane) return;

			// ALWAYS look for the LAST (topmost) modal
			const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
			const activeModalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;

			if (activeModalContainer) {
				// Hide bar if the topmost modal is a command palette / quick switcher (prompt)
				if (activeModalContainer.querySelector('.prompt')) {
					this.floatingPane.style.display = 'none';
				} else {
					let modal = activeModalContainer.querySelector('.modal, .community-modal, .mod-community-modal, .community-plugin-details, .community-plugin-search, .community-modal-details') as HTMLElement;

					if (!modal) {
						// Fallback: use the first child that isn't the background overlay
						modal = Array.from(activeModalContainer.children).find(el => !el.classList.contains('modal-bg')) as HTMLElement;
					}

					if (modal) {
						// Position logic...
						const rect = modal.getBoundingClientRect();
						const paneHeight = this.floatingPane.offsetHeight || 40;

						const targetLeft = Math.round(rect.left / 10) * 10;
						const targetTop = Math.round((rect.top - paneHeight - 10) / 10) * 10;

						const currentLeft = parseInt(this.floatingPane.style.left) || 0;
						const currentTop = parseInt(this.floatingPane.style.top) || 0;

						if (Math.abs(currentLeft - targetLeft) > 5 || Math.abs(currentTop - targetTop) > 5) {
							this.floatingPane.style.left = `${targetLeft}px`;
							this.floatingPane.style.top = `${targetTop}px`;
						}

						this.floatingPane.style.display = 'flex';
						this.floatingPane.style.opacity = '1';
						this.floatingPane.style.zIndex = '2147483647';
					} else {
						this.floatingPane.style.display = 'none';
					}
				}
			} else {
				this.floatingPane.style.display = 'none';
				this.searchBarRestored = false;
				this.modalWasClosed = true;
			}

			// Track tab changes only from the TOPMOST modal
			if (activeModalContainer) {
				// Skip recording if modal is in a transitional state (opening/closing)
				const modal = activeModalContainer.querySelector('.modal, .community-modal, .mod-community-modal') as HTMLElement;
				if (modal && modal.style.display === 'none') {
					return; // Modal is hidden, don't record
				}

				const tabId = this.detectTabIdFromDOM();

				// If modal just reopened, restore fold state then scroll for the current tab
				if (this.modalWasClosed && tabId) {
					this.modalWasClosed = false;
					this.restoreFoldState(tabId, () => {
						this.restoreScrollPosition(tabId);
					});
				}

				// Only record valid, non-empty tab IDs that are different from current
				if (tabId && tabId.trim().length > 0 && tabId !== this.lastActiveTabId && !this.isNavigatingProgrammatically) {
					this.recordTabChange(tabId);
				}
			}

			// Continuously save scroll position and fold state for current tab
			// Only save when the modal is actually open (not during close animation)
			if (activeModalContainer && this.lastActiveTabId && this.settings.cacheScrollPositions) {
				// Don't overwrite while a restore is in progress for this tab
				const restoreKey = `__restoring_${this.lastActiveTabId}`;
				if (!(this as any)[restoreKey]) {
					const contentEl = this.getSettingsContentEl();
					if (contentEl && contentEl.scrollTop > 0) {
						this.scrollCache.set(this.lastActiveTabId, contentEl.scrollTop);
					}
				}
				this.saveFoldState(this.lastActiveTabId);
			}

			// Search bar: save when on community-plugins, restore on first visit
			if (this.isCommunityPluginsTab(this.lastActiveTabId)) {
				if (!this.searchBarRestored) {
					this.searchBarRestored = true;
					if (this.savedSearchQuery) {
						this.searchBarRestoring = true;
						this.restoreSearchBarContent();
					}
				} else if (!this.searchBarRestoring) {
					this.saveSearchBarContent();
				}
			} else {
				this.searchBarRestored = false;
				this.searchBarRestoring = false;
			}

			this.injectXButtons();
			this.updateButtonStates();
		}, 150);
	}

	private detectTabIdFromDOM(): string {
		const doc = activeDocument || document;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;

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

		if (browseSearch || detailsView) {
			// ONLY return a plugin name if we have a DETAILS VIEW with actual content
			// Check if details view has meaningful content (not just empty)
			if (detailsView) {
				const detailsText = (detailsView as HTMLElement).innerText.trim();
				const hasContent = detailsText.length > 50; // Must have substantial content

				if (hasContent) {
					// Try to find plugin ID from shareable link or data attributes
					const shareLink = modalContainer.querySelector('a[href*="obsidian://"], button[data-plugin-id], [data-plugin-id]') as HTMLElement;
					const pluginId = shareLink?.getAttribute('data-plugin-id') || shareLink?.getAttribute('href')?.match(/plugin[\/=]([^&]+)/)?.[1];

					let name = "";
					const nameEl = modalContainer.querySelector('.community-modal-details-name')
						|| modalContainer.querySelector('.setting-item-info-name')
						|| modalContainer.querySelector('.community-modal-details h1, .community-modal-details h2')
						|| modalContainer.querySelector('.modal-title');

					if (nameEl && nameEl.textContent && !nameEl.textContent.toLowerCase().includes('community plugins')) {
						name = nameEl.textContent.trim().toLowerCase();
						// Store plugin ID if found for better navigation
						if (pluginId) {
							return `plugin:${name}:${pluginId}`;
						}
						return `plugin:${name}`;
					}
				}
			}

			// If it's a modal with search but no specific name/details yet, it's 'browse'
			return 'browse';
		}

		// Fallback to regular settings tabs
		const modal = modalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return "";

		const activeTab = modal.querySelector('.vertical-tab-nav-item.is-active');
		const baseTabId = (activeTab?.getAttribute('data-id') || activeTab?.textContent || "").trim().toLowerCase();

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

	private recordTabChange(tabId: string) {
		// Don't record empty or invalid tab IDs
		if (!tabId || typeof tabId !== 'string') {
			return;
		}

		const normalizedId = tabId.trim().toLowerCase();

		// Don't record empty strings
		if (!normalizedId) {
			return;
		}

		if (this.isNavigatingProgrammatically) {
			return;
		}

		// Prevent rapid-fire duplicate recordings (debounce)
		const now = Date.now();
		if (now - this.lastRecordTime < 300) {
			return; // Too soon after last recording
		}

		const currentEntry = this.history[this.currentIndex];
		const currentTabId = currentEntry?.tabId;

		// 1. Strict De-duplication
		// If the new ID is exactly the same as the current history tip, ignore it.
		if (currentTabId === normalizedId) {
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
					console.log(`[Settings Nav] Refinement detected: ${currentTabId} -> ${normalizedId}. Replacing entry.`);
					this.history[this.currentIndex].tabId = normalizedId;
					this.lastActiveTabId = normalizedId;
					this.lastRecordTime = now;
					this.savePluginData();
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

		// Update tracking before recording
		this.lastActiveTabId = normalizedId;
		this.lastRecordTime = now;

		if (this.currentIndex < this.history.length - 1) {
			// If we are in the middle of history and navigate, chop off the future
			this.history = this.history.slice(0, this.currentIndex + 1);
		}

		this.history.push({ tabId: normalizedId, timestamp: Date.now() });
		if (this.history.length > 50) this.history.shift();
		this.currentIndex = this.history.length - 1;

		this.savePluginData();
		this.updateButtonStates();

		// Restore fold state first, then scroll position after folds have expanded
		this.restoreFoldState(normalizedId, () => {
			this.restoreScrollPosition(normalizedId);
		});
	}

	private navigateBack() {
		if (this.currentIndex <= 0) return;

		const currentTabId = this.detectTabIdFromDOM() || this.lastActiveTabId || '';
		const startIndex = this.currentIndex;

		// Skip back past invalid entries and entries matching current tab
		while (this.currentIndex > 0) {
			this.currentIndex--;
			const entry = this.history[this.currentIndex];
			if (!entry || !entry.tabId || entry.tabId.trim().length === 0) continue;
			// Skip if it's the same tab we're already on
			if (entry.tabId === currentTabId) continue;
			// Found a different, valid entry
			this.updateButtonStates();
			this.performNavigation(entry.tabId);
			return;
		}

		// Couldn't find a different entry — restore original position
		this.currentIndex = startIndex;
		this.updateButtonStates();
	}

	private navigateForward() {
		if (this.currentIndex >= this.history.length - 1) return;

		const currentTabId = this.detectTabIdFromDOM() || this.lastActiveTabId || '';
		const startIndex = this.currentIndex;

		// Skip forward past invalid entries and entries matching current tab
		while (this.currentIndex < this.history.length - 1) {
			this.currentIndex++;
			const entry = this.history[this.currentIndex];
			if (!entry || !entry.tabId || entry.tabId.trim().length === 0) continue;
			// Skip if it's the same tab we're already on
			if (entry.tabId === currentTabId) continue;
			// Found a different, valid entry
			this.updateButtonStates();
			this.performNavigation(entry.tabId);
			return;
		}

		// Couldn't find a different entry — restore original position
		this.currentIndex = startIndex;
		this.updateButtonStates();
	}

	private handleFirstLetterNav(letter: string, forceSidebar: boolean = true) {
		const doc = activeDocument || document;
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
			target.element.style.transition = 'background 0.3s';
			target.element.style.background = 'var(--background-modifier-hover)';
			setTimeout(() => {
				target.element.style.background = '';
				setTimeout(() => { target.element.style.transition = ''; }, 300);
			}, 800);
		}
	}

	private performNavigation(tabId: string) {
		// Validate tabId before attempting navigation
		if (!tabId || typeof tabId !== 'string' || tabId.trim().length === 0) {
			console.warn('[Settings Nav] Invalid tabId for navigation:', tabId);
			// Update button states even if navigation fails
			this.updateButtonStates();
			return;
		}

		this.isNavigatingProgrammatically = true;
		const setting = (this.app as any).setting;
		const doc = activeDocument || document;

		const getTopmostModal = () => {
			const all = Array.from(doc.querySelectorAll('.modal-container'));
			return all[all.length - 1] as HTMLElement;
		};

		try {
			if (tabId.startsWith('plugin:') || tabId.startsWith('browse:')) {
				const isQuery = tabId.startsWith('browse:');
				const fullTarget = isQuery ? tabId.substring(7) : tabId.substring(7);
				// Handle plugin:name:id format
				const parts = fullTarget.split(':');
				const target = parts[0]; // Plugin name
				const pluginId = parts.length > 1 ? parts[1] : null; // Plugin ID if available

				if (!isQuery && pluginId) {
					// Use Obsidian's native URI to open the plugin info modal
					window.open(`obsidian://show-plugin?id=${pluginId}`);
				} else if (isQuery) {
					// For search queries, we need to interact with the browse modal search
					let topmostModal = getTopmostModal();
					const isCommunityModal = topmostModal?.querySelector('.mod-community-modal, .community-modal, .mod-community-plugin');
					if (!topmostModal || !isCommunityModal) {
						setting.openTabById('community-plugins');
						setTimeout(() => {
							const newTop = getTopmostModal();
							const browseBtn = Array.from(newTop?.querySelectorAll('.mod-cta') || [])
								.find(el => el.textContent?.trim().toLowerCase() === 'browse') as HTMLElement;
							if (browseBtn) {
								browseBtn.click();
								setTimeout(() => this.performNavigation(tabId), 500);
							}
						}, 300);
						return;
					}
					const searchInput = topmostModal.querySelector('.community-modal-search-container input, .mod-community-modal input[type="search"], .mod-community-modal input[type="text"], .mod-community-plugin input[type="search"], .mod-community-plugin input[type="text"]') as HTMLInputElement;
					if (searchInput) {
						searchInput.value = target;
						searchInput.dispatchEvent(new Event('input', { bubbles: true }));
					}
				}
			} else if (tabId === 'browse') {
				let topmostModal = getTopmostModal();
				if (topmostModal) {
					// Check if we are in details view, if so click back
					const backBtn = topmostModal.querySelector('.modal-title-back') as HTMLElement;
					if (backBtn) {
						backBtn.click();
					} else {
						// If we are already in Browse but not in details, nothing to do
						const browseSearch = topmostModal.querySelector('.community-modal-search-container');
						if (!browseSearch) {
							const browseBtn = Array.from(topmostModal?.querySelectorAll('.mod-cta') || [])
								.find(el => el.textContent?.trim().toLowerCase() === 'browse') as HTMLElement;
							if (browseBtn) browseBtn.click();
						}
					}
				} else {
					setting.openTabById('community-plugins');
					setTimeout(() => {
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
				setTimeout(() => {
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
						(match as HTMLElement).click();
					}
				}, 100);
			}
		} catch (e) {
			console.warn('[Settings Nav] Navigation failed', e);
		}

		this.lastActiveTabId = tabId;
		this.updateButtonStates();

		// Restore fold state first, then scroll position after folds have expanded
		this.restoreFoldState(tabId, () => {
			this.restoreScrollPosition(tabId);
		});
		if (this.isCommunityPluginsTab(tabId)) {
			this.restoreSearchBarContent();
		}

		// Increased timeout and reset flag to prevent re-opening loops
		setTimeout(() => { this.isNavigatingProgrammatically = false; }, 1500);
	}

	private updateButtonStates() {
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
			const doc = activeDocument || document;
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
			pluginInfoBtn.style.display = isPluginTab ? 'flex' : 'none';
			if (separatorEl) separatorEl.style.display = isPluginTab ? '' : 'none';
		}
	}

	private getSettingsContentEl(): HTMLElement | null {
		const doc = activeDocument || document;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
		if (!modalContainer) return null;
		const modal = modalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return null;
		return modal.querySelector('.vertical-tab-content') as HTMLElement;
	}

	private saveScrollPosition(tabId: string) {
		if (!this.settings.cacheScrollPositions || !tabId) return;
		const contentEl = this.getSettingsContentEl();
		if (contentEl) {
			this.scrollCache.set(tabId, contentEl.scrollTop);
		}
	}

	private restoreScrollPosition(tabId: string) {
		if (!this.settings.cacheScrollPositions || !tabId) return;
		const savedScroll = this.scrollCache.get(tabId);
		if (savedScroll === undefined || savedScroll === 0) return;

		// Temporarily stop the poll loop from overwriting this tab's cached scroll
		// while we're trying to restore it
		const restoreKey = `__restoring_${tabId}`;
		(this as any)[restoreKey] = true;

		const tryRestore = (attempts: number) => {
			const contentEl = this.getSettingsContentEl();
			if (contentEl && contentEl.scrollHeight > contentEl.clientHeight) {
				contentEl.scrollTop = savedScroll;
				// Verify it took — browser may clamp to max scroll
				if (contentEl.scrollTop > 0) {
					(this as any)[restoreKey] = false;
					return; // Success
				}
			}
			if (attempts > 0) {
				setTimeout(() => tryRestore(attempts - 1), 100);
			} else {
				(this as any)[restoreKey] = false;
			}
		};
		setTimeout(() => tryRestore(15), 50);
	}

	private getHeadingPath(heading: HTMLElement): string {
		// Build a path key from heading text, walking up the DOM to build ancestry
		const text = heading.querySelector('.setting-item-name')?.textContent?.trim()
			|| heading.textContent?.trim() || '';
		const level = heading.getAttribute('data-level') || '0';
		return `${level}:${text}`;
	}

	private saveFoldState(tabId: string) {
		if (!this.settings.cacheScrollPositions || !tabId) return;
		const contentEl = this.getSettingsContentEl();
		if (!contentEl) return;

		const headings = contentEl.querySelectorAll('.style-settings-heading');
		if (headings.length === 0) return;

		// Save ALL heading states (both collapsed and expanded) so we can
		// detect which ones the user explicitly expanded vs default state
		const states: { key: string; collapsed: boolean }[] = [];
		const keyCounts = new Map<string, number>();
		headings.forEach((h) => {
			const baseKey = this.getHeadingPath(h as HTMLElement);
			const count = keyCounts.get(baseKey) || 0;
			keyCounts.set(baseKey, count + 1);
			const key = count > 0 ? `${baseKey}#${count}` : baseKey;
			states.push({ key, collapsed: h.classList.contains('is-collapsed') });
		});
		this.foldStateCache.set(tabId, states.filter(s => !s.collapsed).map(s => s.key));
	}

	private restoreFoldState(tabId: string, onComplete?: () => void) {
		if (!this.settings.cacheScrollPositions || !tabId) {
			onComplete?.();
			return;
		}
		const expandedKeys = this.foldStateCache.get(tabId);
		if (!expandedKeys) {
			onComplete?.();
			return;
		}

		const expandedSet = new Set(expandedKeys);

		// Restore level by level: expand top-level headings first,
		// wait for children to render, then process the next level
		const restoreLevel = (level: number, attempts: number) => {
			const contentEl = this.getSettingsContentEl();
			if (!contentEl) {
				if (attempts > 0) setTimeout(() => restoreLevel(level, attempts - 1), 100);
				else onComplete?.();
				return;
			}

			const headings = contentEl.querySelectorAll('.style-settings-heading');
			if (headings.length === 0) {
				if (attempts > 0) setTimeout(() => restoreLevel(level, attempts - 1), 100);
				else onComplete?.();
				return;
			}

			let clickedAny = false;
			const keyCounts = new Map<string, number>();

			headings.forEach((h) => {
				const el = h as HTMLElement;
				const headingLevel = parseInt(el.getAttribute('data-level') || '0');
				if (headingLevel !== level) return;

				const baseKey = this.getHeadingPath(el);
				const count = keyCounts.get(baseKey) || 0;
				keyCounts.set(baseKey, count + 1);
				const key = count > 0 ? `${baseKey}#${count}` : baseKey;

				const shouldExpand = expandedSet.has(key);
				const isCollapsed = el.classList.contains('is-collapsed');

				if (shouldExpand && isCollapsed) {
					el.click();
					clickedAny = true;
				} else if (!shouldExpand && !isCollapsed) {
					el.click();
					clickedAny = true;
				}
			});

			// If we expanded any headings, wait for children to render, then do next level
			if (clickedAny && level < 6) {
				setTimeout(() => restoreLevel(level + 1, 5), 150);
			} else if (level < 6) {
				// Check if there are deeper levels to process
				const hasDeeper = Array.from(headings).some(h =>
					parseInt((h as HTMLElement).getAttribute('data-level') || '0') > level
				);
				if (hasDeeper) {
					restoreLevel(level + 1, 5);
				} else {
					onComplete?.();
				}
			} else {
				onComplete?.();
			}
		};

		setTimeout(() => restoreLevel(0, 10), 100);
	}

	private findSearchInput(): HTMLInputElement | null {
		const doc = activeDocument || document;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const modalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
		if (!modalContainer) return null;
		const modal = modalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return null;

		const contentEl = modal.querySelector('.vertical-tab-content');
		if (!contentEl) return null;

		const inputs = Array.from(contentEl.querySelectorAll('input')) as HTMLInputElement[];
		return inputs.find(i =>
			i.type === 'text' || i.type === 'search' || i.type === ''
		) || null;
	}

	private saveSearchBarContent() {
		if (!this.settings.cacheSearchBar) return;
		const searchInput = this.findSearchInput();
		if (searchInput) {
			const newValue = searchInput.value;
			if (newValue !== this.savedSearchQuery) {
				this.savedSearchQuery = newValue;
				this.savePluginData();
			}
		}
	}

	private restoreSearchBarContent() {
		if (!this.settings.cacheSearchBar || !this.savedSearchQuery) {
			this.searchBarRestoring = false;
			return;
		}

		const queryToRestore = this.savedSearchQuery;

		// Keep trying to set the value until it sticks.
		// Obsidian re-renders the plugin list on input events, recreating the input element.
		// We repeatedly check and re-apply until stable.
		let stableCount = 0;
		const ensureValue = (attempts: number) => {
			const input = this.findSearchInput();
			if (!input) {
				if (attempts > 0) setTimeout(() => ensureValue(attempts - 1), 100);
				else this.searchBarRestoring = false;
				return;
			}

			if (input.value === queryToRestore) {
				stableCount++;
				// Consider it stable after 3 consecutive checks (~450ms)
				if (stableCount >= 3) {
					this.searchBarRestoring = false;
					return;
				}
			} else {
				stableCount = 0;
				input.value = queryToRestore;
				input.dispatchEvent(new Event('input', { bubbles: true }));
			}

			if (attempts > 0) {
				setTimeout(() => ensureValue(attempts - 1), 150);
			} else {
				this.searchBarRestoring = false;
			}
		};
		setTimeout(() => ensureValue(20), 100);
	}

	private injectXButtons() {
		const doc = activeDocument || document;
		const allModalContainers = Array.from(doc.querySelectorAll('.modal-container'));
		const activeModalContainer = allModalContainers[allModalContainers.length - 1] as HTMLElement;
		if (!activeModalContainer) return;

		const modal = activeModalContainer.querySelector('.modal') as HTMLElement;
		if (!modal) return;

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
				headerEl.style.cursor = 'pointer';
				const tabId = targetTabId;
				headerEl.addEventListener('click', (e) => {
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

			// If it's not a community plugin and has no data-id, check if it's actually
			// a core plugin by verifying it exists in internalPlugins
			const isCorePlugin = !isCommunity && !dataId
				? !!(this.app as any).internalPlugins?.getPluginById(tabId)
				: !isCommunity && !CORE_TAB_IDS.has(tabId);

			// Only add buttons for actual plugin tabs
			if (!isCommunity && !isCorePlugin) return;

			navItem.style.position = 'relative';

			// Add browse button (to the left of X) for community plugins
			if (isCommunity && this.settings.enableBrowseButtons) {
				this.createBrowseButton(navItem, tabId);
			}

			// Add X button
			if (this.settings.enableXButtons) {
				this.createXButton(navItem, tabId, isCommunity);
			}

			this.injectedXButtons.add(navItem);
		});
	}

	private createXButton(navItem: HTMLElement, tabId: string, isCommunity: boolean) {
		const xButton = document.createElement('div');
		xButton.className = 'settings-nav-x-button';
		setIcon(xButton, 'x');

		// Custom tooltip element that we control directly
		let tooltip: HTMLElement | null = null;

		const positionTooltip = () => {
			if (!tooltip) return;
			const rect = xButton.getBoundingClientRect();
			const tipRect = tooltip.getBoundingClientRect();
			tooltip.style.left = `${rect.left + rect.width / 2 - tipRect.width / 2}px`;
			tooltip.style.top = `${rect.top - tipRect.height - 4}px`;
		};

		const showTooltip = (text: string, isDelete: boolean = false) => {
			if (tooltip) {
				// Just update text and reposition if already showing
				if (tooltip.textContent !== text) {
					tooltip.textContent = text;
					tooltip.style.color = isDelete ? 'var(--text-error)' : '';
					positionTooltip();
				}
				return;
			}
			tooltip = document.createElement('div');
			tooltip.className = 'tooltip mod-top';
			tooltip.textContent = text;
			tooltip.style.cssText = 'position: fixed; z-index: 2147483647; pointer-events: none;';
			if (isDelete) tooltip.style.color = 'var(--text-error)';
			document.body.appendChild(tooltip);
			positionTooltip();
		};

		const hideTooltip = () => {
			if (tooltip) {
				tooltip.remove();
				tooltip = null;
			}
		};

		const getTooltipText = (shiftHeld: boolean) => {
			if (shiftHeld && isCommunity) return 'Delete plugin';
			return 'Disable plugin';
		};

		let isHoveringX = false;
		let currentShift = false;

		xButton.addEventListener('mouseenter', () => {
			isHoveringX = true;
			showTooltip(getTooltipText(currentShift), currentShift && isCommunity);
		});

		xButton.addEventListener('mouseleave', () => {
			isHoveringX = false;
			hideTooltip();
		});

		xButton.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			hideTooltip();
			if (e.shiftKey && isCommunity) {
				this.handleDeletePlugin(tabId);
			} else {
				this.handleDisablePlugin(tabId, isCommunity);
			}
		});

		// Track shift key for visual feedback and tooltip update
		const updateShiftState = (e: KeyboardEvent) => {
			if (!isCommunity) return;
			currentShift = e.shiftKey;
			xButton.classList.toggle('shift-held', currentShift);
			if (isHoveringX) {
				showTooltip(getTooltipText(currentShift), currentShift && isCommunity);
			}
		};

		navItem.addEventListener('mouseenter', () => {
			document.addEventListener('keydown', updateShiftState);
			document.addEventListener('keyup', updateShiftState);
		});

		navItem.addEventListener('mouseleave', () => {
			document.removeEventListener('keydown', updateShiftState);
			document.removeEventListener('keyup', updateShiftState);
			xButton.classList.remove('shift-held');
			currentShift = false;
			hideTooltip();
		});

		navItem.appendChild(xButton);
	}

	private createBrowseButton(navItem: HTMLElement, tabId: string) {
		const browseBtn = document.createElement('div');
		browseBtn.className = 'settings-nav-browse-button';
		setIcon(browseBtn, 'puzzle');

		// Custom tooltip
		let tooltip: HTMLElement | null = null;
		let isHovering = false;
		let currentShift = false;

		const positionTooltip = () => {
			if (!tooltip) return;
			const rect = browseBtn.getBoundingClientRect();
			const tipRect = tooltip.getBoundingClientRect();
			tooltip.style.left = `${rect.left + rect.width / 2 - tipRect.width / 2}px`;
			tooltip.style.top = `${rect.top - tipRect.height - 4}px`;
		};

		const getTooltipText = (shiftHeld: boolean) => {
			const swapped = this.settings.browseDefaultInstalled;
			const showInstalled = swapped ? !shiftHeld : shiftHeld;
			return showInstalled ? 'View in installed plugins' : 'View in Community Plugins';
		};

		const showTooltip = (text: string) => {
			if (tooltip) {
				if (tooltip.textContent !== text) {
					tooltip.textContent = text;
					positionTooltip();
				}
				return;
			}
			tooltip = document.createElement('div');
			tooltip.className = 'tooltip mod-top';
			tooltip.textContent = text;
			tooltip.style.cssText = 'position: fixed; z-index: 2147483647; pointer-events: none;';
			document.body.appendChild(tooltip);
			positionTooltip();
		};

		const hideTooltip = () => {
			if (tooltip) { tooltip.remove(); tooltip = null; }
		};

		browseBtn.addEventListener('mouseenter', () => {
			isHovering = true;
			showTooltip(getTooltipText(currentShift));
		});

		browseBtn.addEventListener('mouseleave', () => {
			isHovering = false;
			hideTooltip();
		});

		const updateShiftState = (e: KeyboardEvent) => {
			currentShift = e.shiftKey;
			if (isHovering) {
				showTooltip(getTooltipText(currentShift));
			}
		};

		navItem.addEventListener('mouseenter', () => {
			document.addEventListener('keydown', updateShiftState);
			document.addEventListener('keyup', updateShiftState);
		});

		navItem.addEventListener('mouseleave', () => {
			document.removeEventListener('keydown', updateShiftState);
			document.removeEventListener('keyup', updateShiftState);
			currentShift = false;
			hideTooltip();
		});

		browseBtn.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			hideTooltip();

			const pluginInfo = this.getPluginInfoForTab(tabId);
			if (!pluginInfo) return;

			const swapped = this.settings.browseDefaultInstalled;
			const goToInstalled = swapped ? !e.shiftKey : e.shiftKey;

			if (goToInstalled) {
				// Navigate to community-plugins tab and search for the plugin
				// Set the search override BEFORE navigating so the poll loop
				// doesn't fight us with the old saved query
				const manifests = (this.app as any).plugins?.manifests;
				const manifest = manifests?.[pluginInfo.id];
				const displayName = manifest?.name || pluginInfo.name;
				this.savedSearchQuery = displayName;
				this.searchBarRestoring = true;
				this.searchBarRestored = true;
				this.recordTabChange('community-plugins');
				this.performNavigation('community-plugins');
			} else {
				// Open in Community Plugins browser
				const navTarget = `plugin:${pluginInfo.name}:${pluginInfo.id}`;
				this.recordTabChange(navTarget);
				this.performNavigation(navTarget);
			}
		});

		navItem.appendChild(browseBtn);
	}

	private async handleDisablePlugin(tabId: string, isCommunity: boolean) {
		const plugins = (this.app as any).plugins;
		const setting = (this.app as any).setting;

		if (isCommunity) {
			const pluginInfo = this.getPluginInfoForTab(tabId);
			if (pluginInfo) {
				try {
					await plugins.disablePlugin(pluginInfo.id);
					setting.openTabById('community-plugins');
				} catch (error) {
					console.error('[Settings Nav] Failed to disable plugin:', error);
				}
			}
		} else {
			// Core plugin — disable by tab ID
			try {
				await (this.app as any).internalPlugins?.getPluginById(tabId)?.disable();
				setting.openTabById('core-plugins');
			} catch (error) {
				console.error('[Settings Nav] Failed to disable core plugin:', error);
			}
		}
	}

	private async handleDeletePlugin(tabId: string) {
		const pluginInfo = this.getPluginInfoForTab(tabId);
		if (!pluginInfo) return;

		try {
			const plugins = (this.app as any).plugins;
			await plugins.uninstallPlugin(pluginInfo.id);
			(this.app as any).setting.openTabById('community-plugins');
		} catch (error) {
			console.error('[Settings Nav] Failed to uninstall plugin:', error);
		}
	}

	removeAllXButtons() {
		const doc = activeDocument || document;
		doc.querySelectorAll('.settings-nav-x-button').forEach(btn => btn.remove());
		doc.querySelectorAll('.settings-nav-browse-button').forEach(btn => btn.remove());
		this.injectedXButtons = new WeakSet();
	}

	onunload() {
		if (this.pollInterval) clearInterval(this.pollInterval);
		if (this.floatingPane) this.floatingPane.remove();
		if (this.keydownHandler) document.removeEventListener('keydown', this.keydownHandler, true);
		if (this.mouseHandler) {
			document.removeEventListener('mousedown', this.mouseHandler, true);
			document.removeEventListener('mouseup', this.mouseHandler, true);
			document.removeEventListener('auxclick', this.mouseHandler, true);
		}
		this.removeAllXButtons();
	}
}

class SettingsNavigatorSettingTab extends PluginSettingTab {
	plugin: SettingsBackAndForthPlugin;

	constructor(app: App, plugin: SettingsBackAndForthPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Quick disable/delete buttons')
			.setDesc('Show X buttons on plugin tabs in the settings sidebar. Click to disable, Shift+Click to delete.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableXButtons)
				.onChange(async (value) => {
					this.plugin.settings.enableXButtons = value;
					await this.plugin.savePluginData();
					if (!value) {
						this.plugin.removeAllXButtons();
					}
				}));

		new Setting(containerEl)
			.setName('Browse in Community Plugins buttons')
			.setDesc('Show a puzzle icon on community plugin tabs to quickly view them in the Community Plugins browser.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableBrowseButtons)
				.onChange(async (value) => {
					this.plugin.settings.enableBrowseButtons = value;
					await this.plugin.savePluginData();
					if (!value) {
						this.plugin.removeAllXButtons();
					}
				}));

		new Setting(containerEl)
			.setName('Browse button defaults to installed plugins')
			.setDesc('Swap the browse button behavior: normal click opens installed plugin settings, Shift+click opens in Community Plugins browser.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.browseDefaultInstalled)
				.onChange(async (value) => {
					this.plugin.settings.browseDefaultInstalled = value;
					await this.plugin.savePluginData();
				}));

		new Setting(containerEl)
			.setName('Transparent navigation bar')
			.setDesc('Make the navigation bar background transparent. Each button gets its own background and border.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.transparentNavBar)
				.onChange(async (value) => {
					this.plugin.settings.transparentNavBar = value;
					await this.plugin.savePluginData();
					this.plugin.applyNavBarStyle();
				}));

		new Setting(containerEl)
			.setName('Remember scroll positions')
			.setDesc('Cache scroll positions for each settings tab and restore them when navigating back.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.cacheScrollPositions)
				.onChange(async (value) => {
					this.plugin.settings.cacheScrollPositions = value;
					await this.plugin.savePluginData();
				}));

		new Setting(containerEl)
			.setName('Remember plugin search filter')
			.setDesc('Persist the "Search installed plugins..." text across settings sessions.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.cacheSearchBar)
				.onChange(async (value) => {
					this.plugin.settings.cacheSearchBar = value;
					await this.plugin.savePluginData();
					if (!value) {
						this.plugin.savedSearchQuery = '';
						await this.plugin.savePluginData();
					}
				}));

		new Setting(containerEl)
			.setName('First-letter navigation')
			.setDesc('Press a letter key to jump to matching items in the sidebar and plugin lists. Press again to cycle through matches.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableFirstLetterNav)
				.onChange(async (value) => {
					this.plugin.settings.enableFirstLetterNav = value;
					await this.plugin.savePluginData();
				}));

		new Setting(containerEl)
			.setName('First-letter navigation mode')
			.setDesc('How to switch between sidebar and content navigation.')
			.addDropdown(dropdown => dropdown
				.addOption('tab', 'Ctrl+Tab toggles focus')
				.addOption('shift', 'Shift+letter for sidebar')
				.setValue(this.plugin.settings.letterNavMode)
				.onChange(async (value) => {
					this.plugin.settings.letterNavMode = value as 'tab' | 'shift';
					await this.plugin.savePluginData();
				}));
	}
}
