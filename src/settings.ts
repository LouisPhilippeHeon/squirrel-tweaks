import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type SquirrelTweaksPlugin from "./main";

export interface SquirrelTweaksSettings {
	dragAndDrop: boolean;
	pasteUrl: boolean;
	prettifySymbols: boolean;
	colorTags: boolean;
	noDuplicateTabs: boolean;
}

export type FeatureKey = keyof SquirrelTweaksSettings;

export const DEFAULT_SETTINGS: SquirrelTweaksSettings = {
	dragAndDrop: true,
	pasteUrl: true,
	prettifySymbols: true,
	colorTags: true,
	noDuplicateTabs: true,
};

const SETTINGS_LAYOUT: { key: FeatureKey; name: string }[] = [
	{ key: "dragAndDrop", name: "Drag and drop list items" },
	{ key: "pasteUrl", name: "Paste URL into selection" },
	{ key: "prettifySymbols", name: "Prettify symbols" },
	{ key: "colorTags", name: "Color tags" },
	{ key: "noDuplicateTabs", name: "No duplicate tabs" },
];

export class SquirrelTweaksSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SquirrelTweaksPlugin,
	) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem<FeatureKey>[] {
		return SETTINGS_LAYOUT.map(({ key, name }) => ({
			name,
			control: { type: "toggle", key, defaultValue: DEFAULT_SETTINGS[key] },
		}));
	}

	override setControlValue(key: string, value: unknown) {
		return this.plugin.setFeatureEnabled(key as FeatureKey, value === true);
	}
}
