import { Plugin } from "obsidian";
import { ColorTags } from "./features/color-tags";
import { DragAndDrop } from "./features/drag-and-drop";
import type { Feature } from "./features/feature";
import { NoDuplicateTabs } from "./features/no-duplicate-tabs";
import { PasteUrl } from "./features/paste-url";
import { PrettifySymbols } from "./features/prettify-symbols";
import {
	DEFAULT_SETTINGS,
	type FeatureKey,
	type SquirrelTweaksSettings,
	SquirrelTweaksSettingTab,
} from "./settings";

export default class SquirrelTweaksPlugin extends Plugin {
	override settings: SquirrelTweaksSettings = { ...DEFAULT_SETTINGS };
	private features!: Record<FeatureKey, Feature>;

	override async onload() {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };

		this.features = {
			dragAndDrop: new DragAndDrop(this),
			pasteUrl: new PasteUrl(this),
			prettifySymbols: new PrettifySymbols(this),
			colorTags: new ColorTags(this),
			noDuplicateTabs: new NoDuplicateTabs(this),
		};

		this.addSettingTab(new SquirrelTweaksSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			for (const key of this.featureKeys()) {
				if (this.settings[key]) {
					this.features[key].enable();
				}
			}
		});
	}

	override onunload() {
		for (const key of this.featureKeys()) {
			this.features[key].disable();
		}
	}

	async setFeatureEnabled(key: FeatureKey, enabled: boolean) {
		if (this.settings[key] === enabled) {
			return;
		}
		this.settings[key] = enabled;
		await this.saveData(this.settings);

		if (enabled) {
			this.features[key].enable();
		} else {
			this.features[key].disable();
		}
	}

	private featureKeys() {
		return Object.keys(this.features) as FeatureKey[];
	}
}
