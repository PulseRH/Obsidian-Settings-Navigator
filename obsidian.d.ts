// Type definitions for Obsidian
// This file provides type definitions for the Obsidian API
// The actual types are provided by Obsidian at runtime

declare module 'obsidian' {
	export class Plugin {
		app: App;
		manifest: PluginManifest;
		constructor(app: App, manifest: PluginManifest);
		onload(): void | Promise<void>;
		onunload(): void | Promise<void>;
		addSettingTab(settingTab: SettingTab): void;
		removeSettingTab(settingTab: SettingTab): void;
		loadData(): Promise<any>;
		saveData(data: any): Promise<void>;
	}

	export interface PluginManifest {
		id: string;
		name: string;
		version: string;
		minAppVersion: string;
		description?: string;
		author?: string;
		authorUrl?: string;
	}

	export class SettingTab extends Plugin {
		plugin: Plugin;
		display(): void;
	}

	export class Setting {
		constructor(containerEl: HTMLElement);
		setName(name: string): Setting;
		setDesc(desc: string): Setting;
		setHeading(): Setting;
		setClass(className: string): Setting;
		setTooltip(tooltip: string): Setting;
		setDisabled(disabled: boolean): Setting;
		addText(cb: (component: TextComponent) => void): Setting;
		addTextArea(cb: (component: TextAreaComponent) => void): Setting;
		addMomentFormat(cb: (component: MomentFormatComponent) => void): Setting;
		addDropdown(cb: (component: DropdownComponent) => void): Setting;
		addSlider(cb: (component: SliderComponent) => void): Setting;
		addToggle(cb: (component: ToggleComponent) => void): Setting;
		addColorPicker(cb: (component: ColorComponent) => void): Setting;
		addSearch(cb: (component: TextComponent) => void): Setting;
		addButton(cb: (component: ButtonComponent) => void): Setting;
		addExtraButton(cb: (component: ExtraButtonComponent) => void): Setting;
	}

	export interface App {
		workspace: Workspace;
		vault: Vault;
		metadataCache: MetadataCache;
		fileManager: FileManager;
		lastActiveFile: TFile | null;
		setting: SettingManager;
	}

	export interface Workspace {
		onLayoutReady(callback: () => void): void;
		getActiveFile(): TFile | null;
	}

	export interface Vault {
		readonly configDir: string;
		readonly adapter: DataAdapter;
	}

	export interface DataAdapter {
		basePath: string;
	}

	export interface MetadataCache {
		getFileCache(file: TFile): CachedMetadata | null;
	}

	export interface FileManager {
		createNewMarkdownFile(folder: TFolder, filename: string): Promise<TFile>;
	}

	export interface SettingManager {
		open(): void;
		openTabById(tabId: string): void;
		plugin: {
			tabs: SettingTab[];
		};
	}

	export interface TFile {
		path: string;
		name: string;
		basename: string;
		extension: string;
	}

	export interface TFolder {
		path: string;
		name: string;
	}

	export interface CachedMetadata {
		frontmatter?: any;
	}

	export interface TextComponent {
		setValue(value: string): TextComponent;
		getValue(): string;
		onChange(callback: (value: string) => void): TextComponent;
		setPlaceholder(placeholder: string): TextComponent;
	}

	export interface TextAreaComponent extends TextComponent {
		setValue(value: string): TextAreaComponent;
		getValue(): string;
		onChange(callback: (value: string) => void): TextAreaComponent;
	}

	export interface MomentFormatComponent extends TextComponent {
		setValue(value: string): MomentFormatComponent;
		getValue(): string;
		onChange(callback: (value: string) => void): MomentFormatComponent;
	}

	export interface DropdownComponent {
		addOption(value: string, display: string): DropdownComponent;
		setValue(value: string): DropdownComponent;
		getValue(): string;
		onChange(callback: (value: string) => void): DropdownComponent;
	}

	export interface SliderComponent {
		setLimits(min: number, max: number, step: number): SliderComponent;
		setValue(value: number): SliderComponent;
		getValue(): number;
		onChange(callback: (value: number) => void): SliderComponent;
	}

	export interface ToggleComponent {
		setValue(value: boolean): ToggleComponent;
		getValue(): boolean;
		onChange(callback: (value: boolean) => void): ToggleComponent;
	}

	export interface ColorComponent {
		setValue(value: string): ColorComponent;
		getValue(): string;
		onChange(callback: (value: string) => void): ColorComponent;
	}

	export interface ButtonComponent {
		setButtonText(text: string): ButtonComponent;
		setTooltip(tooltip: string): ButtonComponent;
		setWarning(warning: boolean): ButtonComponent;
		setCta(cta: boolean): ButtonComponent;
		onClick(callback: () => void): ButtonComponent;
	}

	export interface ExtraButtonComponent {
		setIcon(icon: string): ExtraButtonComponent;
		setTooltip(tooltip: string): ExtraButtonComponent;
		onClick(callback: () => void): ExtraButtonComponent;
	}
}


