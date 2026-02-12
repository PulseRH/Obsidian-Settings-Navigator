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
	transparentNavBar?: boolean;
	cacheScrollPositions?: boolean;
	cacheSearchBar?: boolean;
	savedSearchQuery?: string;
}

interface PluginSettings {
	enableXButtons: boolean;
	enableBrowseButtons: boolean;
	transparentNavBar: boolean;
	cacheScrollPositions: boolean;
	cacheSearchBar: boolean;
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
	settings: PluginSettings = { enableXButtons: true, enableBrowseButtons: true, transparentNavBar: false, cacheScrollPositions: true, cacheSearchBar: true };
	private injectedXButtons: WeakSet<HTMLElement> = new WeakSet();
	private scrollCache: Map<string, number> = new Map();
	savedSearchQuery: string = '';
	private searchBarRestored: boolean = false;
	private searchBarRestoring: boolean = false;

	private isCommunityPluginsTab(tabId: string | null): boolean {
		if (!tabId) return false;
		return tabId === 'community-plugins' || tabId === 'community plugins';
	}

	async onload() {
		console.log('[Settings Nav] Plugin loading...');
		await this.loadSavedData();
		this.addSettingTab(new SettingsNavigatorSettingTab(this.app, this));

		this.addCommand({
			id: 'settings-nav-back',
			name: 'Navigate back in settings',
			checkCallback: (checking: boolean) => {
				const settingsOpen = document.querySelector('.modal-container .modal.mod-settings, .modal-container .modal.mod-community-modal');
				if (!settingsOpen) return false;
				if (!checking) this.navigateBack();
				return true;
			},
		});

		this.addCommand({
			id: 'settings-nav-forward',
			name: 'Navigate forward in settings',
			checkCallback: (checking: boolean) => {
				const settingsOpen = document.querySelector('.modal-container .modal.mod-settings, .modal-container .modal.mod-community-modal');
				if (!settingsOpen) return false;
				if (!checking) this.navigateForward();
				return true;
			},
		});

		// Direct keydown listener for Ctrl+Z/Ctrl+X inside settings modal
		this.keydownHandler = (e: KeyboardEvent) => {
			if (!e.ctrlKey || e.shiftKey || e.altKey) return;
			if (e.key !== 'z' && e.key !== 'x') return;
			const settingsOpen = document.querySelector('.modal-container .modal');
			if (!settingsOpen) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'z') {
				this.navigateBack();
			} else if (e.key === 'x') {
				this.navigateForward();
			}
		};
		document.addEventListener('keydown', this.keydownHandler, true);

		// Mouse 4/5 (back/forward) buttons for navigation
		this.mouseHandler = (e: MouseEvent) => {
			// button 3 = Mouse4 (back), button 4 = Mouse5 (forward)
			if (e.button !== 3 && e.button !== 4) return;
			console.log('[Settings Nav] Mouse button pressed:', e.button);
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
				this.settings.transparentNavBar = data.transparentNavBar ?? false;
				this.settings.cacheScrollPositions = data.cacheScrollPositions ?? true;
				this.settings.cacheSearchBar = data.cacheSearchBar ?? true;
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
				transparentNavBar: this.settings.transparentNavBar,
				cacheScrollPositions: this.settings.cacheScrollPositions,
				cacheSearchBar: this.settings.cacheSearchBar,
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
			}

			// Track tab changes only from the TOPMOST modal
			if (activeModalContainer) {
				// Skip recording if modal is in a transitional state (opening/closing)
				const modal = activeModalContainer.querySelector('.modal, .community-modal, .mod-community-modal') as HTMLElement;
				if (modal && modal.style.display === 'none') {
					return; // Modal is hidden, don't record
				}

				const tabId = this.detectTabIdFromDOM();
				// Only record valid, non-empty tab IDs that are different from current
				if (tabId && tabId.trim().length > 0 && tabId !== this.lastActiveTabId && !this.isNavigatingProgrammatically) {
					this.recordTabChange(tabId);
				}
			}

			// Continuously save scroll position for current tab
			if (this.lastActiveTabId && this.settings.cacheScrollPositions) {
				// Don't overwrite while a restore is in progress for this tab
				const restoreKey = `__restoring_${this.lastActiveTabId}`;
				if (!(this as any)[restoreKey]) {
					const contentEl = this.getSettingsContentEl();
					if (contentEl && contentEl.scrollTop > 0) {
						this.scrollCache.set(this.lastActiveTabId, contentEl.scrollTop);
					}
				}
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

		// Restore scroll position for the tab we just navigated to
		this.restoreScrollPosition(normalizedId);
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

				let topmostModal = getTopmostModal();

				// Check if we're already in the community browse modal
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

				// Check if we're currently in a details view - if so, go back to browse first
				const detailsView = topmostModal?.querySelector('.community-modal-details, .community-plugin-details');
				if (detailsView && !isQuery) {
					const backBtn = topmostModal.querySelector('.modal-title-back, .setting-editor-back-button') as HTMLElement;
					if (backBtn) {
						backBtn.click();
						// Wait for browse view to load, then navigate
						setTimeout(() => this.performNavigation(tabId), 500);
						return;
					}
				}

				let browseModal = topmostModal?.querySelector('.community-modal-search-container, .community-plugin-search') || isCommunityModal;

				const attemptClick = (modal: HTMLElement, name: string, id?: string | null) => {
					// First try to find by plugin ID
					if (id) {
						const idElement = modal.querySelector(`[data-plugin-id="${id}"], a[href*="${id}"]`) as HTMLElement;
						if (idElement) {
							idElement.click();
							return true;
						}
					}

					// Try to find plugin by name using current Obsidian classes
					const nameElements = Array.from(modal.querySelectorAll('.community-item-name, .community-plugin-name'));
					console.log('[Settings Nav] attemptClick - nameElements count:', nameElements.length, 'looking for:', JSON.stringify(name));
					if (nameElements.length === 0) {
						// Dump all text-leaf elements that contain the name
						const allEls = Array.from(modal.querySelectorAll('*'));
						const matches = allEls.filter(el => el.textContent?.trim().toLowerCase().includes(name) && el.children.length === 0);
						console.log('[Settings Nav] attemptClick - text matches:', matches.map(el => ({tag: el.tagName, class: el.className, text: el.textContent?.trim().substring(0, 50)})));
					} else {
						console.log('[Settings Nav] attemptClick - nameElement texts:', nameElements.map(el => el.textContent?.trim().toLowerCase()));
					}
					const nameEl = nameElements.find(el => el.textContent?.trim().toLowerCase() === name) as HTMLElement;
					if (nameEl) {
						const container = nameEl.closest('.community-item, .community-plugin-item') as HTMLElement;
						// Debug: log what we found and what we're clicking
						const clickTarget = container || nameEl;
						console.log('[Settings Nav] attemptClick - found nameEl:', nameEl.textContent);
						console.log('[Settings Nav] attemptClick - container:', container?.className);
						console.log('[Settings Nav] attemptClick - container children:', Array.from(clickTarget.children).map(c => c.className));
						console.log('[Settings Nav] attemptClick - container HTML (first 500):', clickTarget.outerHTML.substring(0, 500));
						if (container) {
							container.click();
							return true;
						}
						nameEl.click();
						return true;
					}

					return false;
				};

				if (browseModal) {
					// We are in the browse window
					if (!isQuery) {
						console.log('[Settings Nav] In browse window, attempting click for target:', target, 'pluginId:', pluginId);
						if (!attemptClick(topmostModal, target, pluginId)) {
							console.log('[Settings Nav] attemptClick failed, searching...');
							// Search for it if not immediately visible
							const searchInput = topmostModal.querySelector('.community-modal-search-container input, .mod-community-modal input[type="search"], .mod-community-modal input[type="text"], .mod-community-plugin input[type="search"], .mod-community-plugin input[type="text"]') as HTMLInputElement;
							console.log('[Settings Nav] searchInput found:', !!searchInput, searchInput?.tagName, searchInput?.type, searchInput?.className);
							if (!searchInput) {
								// Try broader search for any input in the modal
								const allInputs = topmostModal.querySelectorAll('input');
								console.log('[Settings Nav] All inputs in modal:', Array.from(allInputs).map(i => ({tag: i.tagName, type: i.type, class: i.className, placeholder: i.placeholder})));
							}
							if (searchInput) {
								// Use pluginId for search if available, strip common prefixes
								let searchTerm = target;
								if (pluginId) {
									searchTerm = pluginId.replace(/^obsidian-/, '').replace(/-plugin$/, '').replace(/-/g, ' ');
								} else {
									searchTerm = target.replace(/^obsidian\s+/, '').replace(/\s+plugin$/, '');
								}
								searchInput.value = searchTerm;
								searchInput.dispatchEvent(new Event('input', { bubbles: true }));
								setTimeout(() => {
									const updatedModal = getTopmostModal();
									attemptClick(updatedModal, target, pluginId);
								}, 1500);
							}
						}
					} else {
						// It's a search query, just update the search
						const searchInput = topmostModal.querySelector('.community-modal-search-container input, .mod-community-modal input[type="search"], .mod-community-modal input[type="text"], .mod-community-plugin input[type="search"], .mod-community-plugin input[type="text"]') as HTMLInputElement;
						if (searchInput) {
							searchInput.value = target;
							searchInput.dispatchEvent(new Event('input', { bubbles: true }));
						}
					}
				} else {
					// We are in settings, need to click "Browse"
					const browseBtn = Array.from(topmostModal?.querySelectorAll('.mod-cta') || [])
						.find(el => el.textContent?.trim().toLowerCase() === 'browse') as HTMLElement;
					if (browseBtn) {
						browseBtn.click();
						setTimeout(() => this.performNavigation(tabId), 500);
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

		// Restore scroll position and search bar for the tab we navigated to
		this.restoreScrollPosition(tabId);
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

		const positionTooltip = () => {
			if (!tooltip) return;
			const rect = browseBtn.getBoundingClientRect();
			const tipRect = tooltip.getBoundingClientRect();
			tooltip.style.left = `${rect.left + rect.width / 2 - tipRect.width / 2}px`;
			tooltip.style.top = `${rect.top - tipRect.height - 4}px`;
		};

		browseBtn.addEventListener('mouseenter', () => {
			tooltip = document.createElement('div');
			tooltip.className = 'tooltip mod-top';
			tooltip.textContent = 'View in Community Plugins';
			tooltip.style.cssText = 'position: fixed; z-index: 2147483647; pointer-events: none;';
			document.body.appendChild(tooltip);
			positionTooltip();
		});

		browseBtn.addEventListener('mouseleave', () => {
			if (tooltip) { tooltip.remove(); tooltip = null; }
		});

		browseBtn.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			if (tooltip) { tooltip.remove(); tooltip = null; }

			const pluginInfo = this.getPluginInfoForTab(tabId);
			if (!pluginInfo) return;

			const navTarget = `plugin:${pluginInfo.name}:${pluginInfo.id}`;
			this.recordTabChange(navTarget);
			this.performNavigation(navTarget);
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
	}
}
