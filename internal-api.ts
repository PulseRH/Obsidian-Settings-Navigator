import type { App, PluginManifest } from 'obsidian';

// Obsidian does not expose settings navigation or plugin management in its public
// API. Keep these optional capabilities at one boundary and check before use.
export interface InternalTab {
  id: string;
  name?: string;
  containerEl?: HTMLElement;
}

export interface CorePlugin {
  enabled: boolean;
  instance?: { id: string; name: string };
  settingTab?: InternalTab | null;
  disable(userInitiated?: boolean): void;
  enable(userInitiated?: boolean): Promise<void>;
}

export interface InternalApp extends App {
	customCss?: { snippets: string[]; getSnippetPath(name: string): string };
	openWithDefaultApp?(path: string): Promise<void>;
  setting?: {
    activeTab?: InternalTab | null;
    containerEl?: HTMLElement;
    settingTabs?: InternalTab[];
    pluginTabs?: InternalTab[];
    openTabById(id: string): InternalTab | null;
    openTab?(tab: InternalTab): void;
  };
  plugins?: {
    manifests: Record<string, PluginManifest>;
    disablePlugin(id: string): Promise<void>;
    disablePluginAndSave(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean>;
    uninstallPlugin(id: string): Promise<void>;
  };
  internalPlugins?: {
    plugins?: Record<string, CorePlugin>;
    getPluginById(id: string): CorePlugin | null;
  };
}

export function corePluginId(app: InternalApp, labelOrId: string): string | null {
  const key = labelOrId.trim().toLowerCase();
  const manager = app.internalPlugins;
  if (!manager) return null;
  if (manager.getPluginById(key)) return key;
  for (const [id, plugin] of Object.entries(manager.plugins ?? {})) {
    const labels = [plugin.instance?.name, plugin.settingTab?.name, plugin.settingTab?.id];
    if (labels.some(label => label?.toLowerCase() === key)) return id;
  }
  // Fallback for older versions whose sidebar labels are not plugin IDs.
  const aliases: Record<string, string> = {
    'page preview': 'page-preview', 'bases': 'bases', 'note composer': 'note-composer',
    'file recovery': 'file-recovery', 'daily notes': 'daily-notes', 'quick switcher': 'switcher',
  };
  const id = aliases[key] ?? key.replace(/\s+/g, '-');
  return manager.getPluginById(id) ? id : null;
}
