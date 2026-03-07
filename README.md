# Settings Navigator

An Obsidian plugin that adds browser-style navigation, quick plugin management, and quality-of-life improvements to the Settings modal.

<img width="191" height="58" alt="image" src="https://github.com/user-attachments/assets/1e3752e3-2c2e-468a-82fc-c58927b0ecb5" /> <a href='https://ko-fi.com/Q5Q21SW0YU' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>


## Features

### Navigation
- **Back/Forward buttons** - floating navigation bar above the settings modal, works like a browser's history
- **Keyboard shortcuts** - `Ctrl+Z` (back) and `Ctrl+X` (forward) while settings are open
- **First-Letter Navigation** - use Keyboard to Type the first letter to navigate to Tab or Contents 
- **Mouse 3/4 support** - use your mouse back/forward buttons to navigate
- **History indicator** - shows your current position in the navigation history (e.g. `3/10`)
- **Clickable section headers** - click "Core plugins" or "Community plugins" headings to jump to those tabs

### Plugin Management
- **Quick disable buttons** - hover over any plugin in the sidebar to reveal an X button that disables it
- **Shift+Click to delete** - hold Shift and click the X to fully uninstall a community plugin (tooltip turns red to confirm)
- **Browse in Community Plugins** - hover to reveal a puzzle icon that opens the plugin's page in the Community Plugins browser

### Persistence
- **Scroll position caching** - remembers where you scrolled on each settings tab and restores it when you return
- **Search bar persistence** - remembers the "Search installed plugins..." filter text across tab switches
- **Remembers Style Settings** - Folding/Ufolding

### Appearance
- **Transparent navigation bar mode** - optional setting that makes the nav bar background transparent with individually styled buttons

## Settings

All features can be toggled individually in the plugin's settings tab:

| Setting | Description | Default |
|---------|-------------|---------|
| Quick disable/delete buttons | Show X buttons on plugin tabs | On |
| Browse in Community Plugins buttons | Show puzzle icon on community plugin tabs | On |
| Transparent navigation bar | Transparent bar with individual button backgrounds | Off |
| Remember scroll positions | Cache and restore scroll positions per tab | On |
| Remember plugin search filter | Persist the search bar text | On |

## Installation

1. paste url into BRAt Plugin or add archive to plugins folder manually

## Development

- `npm run dev` - Build in development mode with watch
- `npm run build` - Build for production
