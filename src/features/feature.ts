import type { App } from "obsidian";

/** A feature that can be turned on and off at runtime from the settings. */
export interface Feature {
	enable(): void;
	disable(): void;
}

/** Documents of the main window and of every popout window. */
export function getOpenDocuments(app: App): Set<Document> {
	const docs = new Set<Document>([app.workspace.containerEl.ownerDocument]);
	app.workspace.iterateAllLeaves((leaf) => {
		docs.add(leaf.getContainer().doc);
	});
	return docs;
}
