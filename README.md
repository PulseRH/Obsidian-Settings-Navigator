# Settings Navigator

Navigate Obsidian settings with Back and Forward, manage plugins from the sidebar, and remember searches and expanded sections.

## Usage

- Use the floating arrows or mouse side buttons to move through settings history.
- Ctrl+Z and Ctrl+X navigate while settings are open and you are not editing a text field.
- Hover a core or community plugin name for its X button. Click to disable, Ctrl+click to reload, or Shift+click to uninstall a community plugin.
- Click a puzzle button to open the community plugin browser. Shift+click shows that plugin in the installed list. The default action can be reversed in this plugin's settings.
- Enable **Control-click opens GitHub** to open a plugin's repository with Ctrl+click (Cmd+click on macOS) on either puzzle button.
- Click a CSS snippet name in Appearance settings to edit it in the default desktop app. Snippet toggles retain their normal action.
- Modifier tooltips update immediately, and Shift highlights only the hovered X.
- Click the Core plugins or Community plugins sidebar heading to return to that list.
- First-letter navigation cycles matching items. Shift+letter targets the sidebar by default; an optional mode uses Ctrl+Tab to switch focus.

## Persistence

Installed-plugin and hotkey searches are remembered separately. History entries retain the text for each visit, including an empty search. A temporary plugin lookup does not replace your normal remembered filter. Editing a search updates the current history entry and remembered filter.

History captured by older versions may lack the original query; that information cannot be reconstructed. New visits record it.

Expanded sections in the Style Settings plugin are remembered by section ID and ancestry, including nested sections removed from the screen when their parent collapses. Fold states are saved across plugin reloads. Scroll positions are remembered for the current plugin session.

## Compatibility

Requires Obsidian 1.12.7 or later. On 1.13+, this plugin's own options also appear in settings search. It uses browser APIs and does not require Node.js or Electron APIs at runtime.

Settings navigation and plugin management currently require internal Obsidian interfaces. These are isolated and checked before use, but future Obsidian changes may require an update. DOM regression tests cover modal and standalone settings layouts; a real desktop/mobile compatibility pass is still required before Community submission.

Style Settings is optional. Its expanded-section restoration is used only when its headings are present.

## Privacy and network use

Navigation, history, search filters, and fold states work locally. Data is stored in the plugin's `data.json` inside the vault; vault sync tools may sync that file. There is no telemetry, advertising, payment, or account requirement for this plugin. It does not read files outside the vault or install or update itself.

The optional GitHub action downloads Obsidian's public plugin directory from `raw.githubusercontent.com/obsidianmd/obsidian-releases` only when used. The directory is cached in memory for the session. It opens the selected repository on `github.com` in your browser. Plugins absent from that directory cannot be resolved automatically.

Opening Obsidian's community plugin browser uses Obsidian's own network features to retrieve plugin information from its directory/GitHub. No note contents, search text, or fold states are sent by Settings Navigator.

## Manual installation

1. Close Obsidian or disable Settings Navigator.
2. Copy `main.js`, `manifest.json`, and `styles.css` from the release into `<vault>/<config directory>/plugins/settings-navigator/`.
3. Enable Settings Navigator in Community plugins. When updating, preserve `data.json`.

If an older installation uses the folder name `settings-back-and-forth`, update that existing folder rather than creating a second installation. The plugin ID remains `settings-navigator`.

## Development

Use Node.js 22 or later:

```sh
npm ci
npm run build:check
```

This runs type checking against the official Obsidian types, the official recommended guideline checker (with no warnings allowed), DOM regression tests, and the production build. `npm run dev` watches for source changes.

See [publication notes](docs/PUBLICATION.md) for release preparation and the remaining submission steps.

## License

[MIT](LICENSE), copyright PulseRH.


