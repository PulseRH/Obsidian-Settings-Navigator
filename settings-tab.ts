import { App, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingDefinitionRender } from 'obsidian';
import type SettingsNavigatorPlugin from './main';

type ToggleKey = 'enableXButtons' | 'enableBrowseButtons' | 'browseDefaultInstalled' | 'ctrlClickOpensGithub' | 'transparentNavBar' | 'cacheScrollPositions' | 'cacheSearchBar' | 'enableFirstLetterNav';

export class SettingsNavigatorSettingTab extends PluginSettingTab {
  constructor(app: App, private navigator: SettingsNavigatorPlugin) { super(app, navigator); }

  private toggle(key: ToggleKey, name: string, desc: string): SettingDefinitionRender {
    return {
      name, desc,
      render: row => {
        row.addToggle(toggle => toggle.setValue(this.navigator.settings[key]).onChange(async value => {
          this.navigator.settings[key] = value;
          if (key === 'cacheSearchBar' && !value) this.navigator.savedSearchQueries = {};
          if (key === 'enableXButtons' || key === 'enableBrowseButtons') this.navigator.removeAllXButtons();
          if (key === 'transparentNavBar') this.navigator.applyNavBarStyle();
          await this.navigator.savePluginData();
        }));
      },
    };
  }

  private groups(): { heading: string; items: SettingDefinitionRender[] }[] {
    return [
      { heading: 'Navigation bar', items: [
        { name: 'Show tab name', desc: 'Font size for the current tab name. Set to zero to hide it.', render: row => {
          row.addSlider(slider => slider.setLimits(0, 24, 1).setValue(this.navigator.settings.showTabLabel).onChange(async value => {
            this.navigator.settings.showTabLabel = value;
            this.navigator.updateButtonStates();
            await this.navigator.savePluginData();
          }));
        } },
        this.toggle('transparentNavBar', 'Transparent navigation bar', 'Show individual buttons with a transparent bar background.'),
      ] },
      { heading: 'Sidebar buttons', items: [
        this.toggle('enableXButtons', 'Quick disable, reload and delete buttons', 'Hover a plugin name to show its X button. Click to disable, control-click to reload, or shift-click to uninstall a community plugin.'),
        this.toggle('enableBrowseButtons', 'Puzzle buttons', 'Show a puzzle button next to community plugins in the sidebar.'),
        this.toggle('browseDefaultInstalled', 'Puzzle button defaults to installed plugins', 'Open the installed plugin list on click and the community browser on shift-click. Turn off to reverse these actions.'),
        this.toggle('ctrlClickOpensGithub', 'Control-click opens GitHub', 'Use control-click (command-click on macOS) on a puzzle button to open the plugin repository. Fetches the public community directory from GitHub only when used.'),
      ] },
      { heading: 'Persistence', items: [
        this.toggle('cacheScrollPositions', 'Remember scroll positions and expanded sections', 'Restore scroll positions and nested sections in the Style Settings plugin when returning to a settings tab.'),
        this.toggle('cacheSearchBar', 'Remember search filters', 'Remember installed-plugin and hotkey searches across settings sessions. History restores the query saved for each visit.'),
      ] },
      { heading: 'First-letter navigation', items: [
        this.toggle('enableFirstLetterNav', 'Enable first-letter navigation', 'Press a letter to jump to matching items; repeat it to cycle through matches.'),
        { name: 'Navigation mode', desc: 'Choose how to switch between the sidebar and content.', render: row => {
          row.addDropdown(dropdown => dropdown.addOption('tab', 'Control-tab toggles focus').addOption('shift', 'Shift-letter selects sidebar')
            .setValue(this.navigator.settings.letterNavMode).onChange(async value => {
              this.navigator.settings.letterNavMode = value === 'tab' ? 'tab' : 'shift';
              await this.navigator.savePluginData();
            }));
        } },
      ] },
    ];
  }

  // Obsidian 1.13 indexes these definitions in settings search.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.groups().map(group => ({ type: 'group', heading: group.heading, items: group.items }));
  }

  // Older supported releases call display instead of the declarative renderer.
  display(): void {
    this.containerEl.empty();
    for (const group of this.groups()) {
      new Setting(this.containerEl).setName(group.heading).setHeading();
      for (const item of group.items) {
        const row = new Setting(this.containerEl).setName(item.name).setDesc(item.desc ?? '');
        // These renderers use only the row; no group API is needed on 1.12.
        const render = item.render as (row: Setting) => void;
        render(row);
      }
    }
  }
}
