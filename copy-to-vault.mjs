import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Correct Vault Path provided by user
const VAULT_PATH = 'C:\\Users\\Loz\\Sync\\Everything';

const PLUGIN_NAME = 'settings-back-and-forth';
const PLUGIN_DIR = join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_NAME);

console.log('Copying plugin files to:', PLUGIN_DIR);

// Create plugin directory if it doesn't exist
if (!existsSync(PLUGIN_DIR)) {
	mkdirSync(PLUGIN_DIR, { recursive: true });
	console.log('Created plugin directory');
}

// Files to copy
const files = ['main.js', 'manifest.json', 'styles.css'];

files.forEach(file => {
	const source = join(process.cwd(), file);
	const dest = join(PLUGIN_DIR, file);
	
	if (existsSync(source)) {
		copyFileSync(source, dest);
		console.log(`Copied ${file}`);
	} else {
		console.warn(`Warning: ${file} not found`);
	}
});

console.log('Done! Plugin files copied to vault.');

