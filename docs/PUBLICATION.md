# Community publication preparation — 1.1.2

## Changes

- Restrict modifier feedback to hovered controls, open known CSS snippets in the default desktop app, and reject unrelated plugin dialogs when displaying navigation.
- Resolve core plugin names to their actual IDs, including Page preview, Bases, Note composer, File recovery, Daily notes and Quick switcher.
- Restore mouse navigation in modal and standalone settings; accept auxiliary-click-only sequences and avoid duplicate steps.
- Store a search snapshot for each history visit, including cleared searches. Restore when rendering changes the input, without a repeating value-reset timer.
- Remember Style Settings headings by ID and ancestry, preserve removed descendants, and cancel restoration when navigation or user input changes the view.
- Add an optional control-click repository action to both puzzle buttons, with on-demand GitHub directory lookup and network disclosure.
- Isolate internal APIs, remove unsafe type casts, clean up timers, observers and host-element handlers, and move static styles to CSS.
- Supply searchable setting definitions on Obsidian 1.13, with a 1.12 display fallback.

## Release files

The GitHub tag must be exactly `1.1.2`, matching `manifest.json` and `package.json`. Attach `main.js`, `manifest.json`, and `styles.css` as individual assets. A ZIP is convenient for manual installation but does not replace these attachments. Commit the source, license, README and `versions.json` to the default branch.

The source is MIT licensed. Runtime code has no telemetry or automatic installer/updater. Network use is optional and documented in the README. Development dependencies are excluded from the bundle.

## Validation

Run `npm ci` and `npm run build:check`. The lint script enables the official recommended Obsidian rules and treats warnings as failures. One narrowly documented `unbound-method` exception preserves a wrapped host method's identity so it can be restored exactly on unload; it is invoked with its original receiver.

Automated DOM tests exercise history snapshots, cleared/temporary searches, input replacement, rapid navigation, core plugin controls, mouse event sequences, GitHub modifiers, handler cleanup, nested Style Settings headings, and consecutive snippet clicks. These are simulations of the host interfaces, not live Obsidian UI verification.

Live Windows checks on Obsidian 1.13.7 passed for per-visit installed-plugin searches, hover-only Shift feedback, immediate tooltip changes, toolbar positioning, and mouse event sequences. Clicking a real CSS snippet opened its file in the configured VS Code editor. The toolbar stayed hidden on Notebook Navigator 3.3.5 release notes and returned after unrelated dialogs closed. Mouse events were injected into the live DOM; physical mouse hardware and mobile remain manual checks.

## Remaining before submitting

1. Verify in a test vault on supported Obsidian versions, including desktop settings windows and mobile. Check the six core X buttons, nested Style Settings folding, repeated Back/Forward searches, and real mouse buttons. Confirm disabling/reloading this plugin removes the toolbar and leaves no duplicate handlers.
2. Create a GitHub release tagged `1.1.2` and attach the three individual assets from `release/1.1.2/`.
3. Submit through the Obsidian Community directory with the owner's linked GitHub account. Address the directory scanner/reviewer feedback; passing local lint does not guarantee acceptance.

## Official references

- [Submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Official guideline checker](https://github.com/obsidianmd/eslint-plugin)
