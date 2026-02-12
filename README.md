# Settings Back and Forth

An Obsidian plugin that adds back and forth navigation arrows to the settings sidebar header, allowing you to easily navigate between different settings menus.

## Features

- **Back Arrow (←)**: Navigate to the previous settings tab you visited
- **Forward Arrow (→)**: Navigate to the next settings tab in your history
- **History Tracking**: Automatically tracks your navigation history through settings tabs
- **Visual Feedback**: Buttons are disabled/grayed out when navigation isn't possible

## Installation

1. Copy this folder to your `.obsidian/plugins/` directory
2. **Important**: Make sure you're in the project directory before running npm commands:
   ```powershell
   cd "C:\Code Projects\obsidian addons\Settings Back and fourth"
   ```
   Or use the helper scripts:
   - PowerShell: `.\npm-safe.ps1 install`
   - Command Prompt: `npm-safe.cmd install`
3. Run `npm install` to install dependencies
4. Run `npm run build` to build the plugin
5. Enable the plugin in Obsidian's settings under "Community plugins"

## Development

- `npm run dev` - Build in development mode with watch
- `npm run build` - Build for production

## Usage

Once enabled, you'll see back (←) and forward (→) arrows in the settings sidebar header. Click them to navigate through your settings navigation history, just like a web browser's back/forward buttons.

