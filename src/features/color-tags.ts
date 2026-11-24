// Adapted from Colored Tags Light.
import type { Plugin } from "obsidian";
import { type Feature, getOpenDocuments } from "./feature";

const ENABLED_CLASS = "squirrel-color-tags";
const TAG_PILL_SELECTOR = "[data-property-type='tags'] .multi-select-pill";
const COLORS = ["#cc6633", "#cc3366", "#884488", "#6633cc", "#3366cc", "#3399cc", "#228866", "#668822", "#cb8f15"];

/** Colors the tags of the properties (frontmatter) with a color derived from their name. */
export class ColorTags implements Feature {
	private enabled = false;
	private observers = new Map<Document, MutationObserver>();

	constructor(private plugin: Plugin) {
		plugin.registerEvent(
			plugin.app.workspace.on("window-open", (win) => {
				if (this.enabled) {
					this.observe(win.doc);
				}
			}),
		);
		plugin.registerEvent(
			plugin.app.workspace.on("window-close", (win) => {
				this.observers.get(win.doc)?.disconnect();
				this.observers.delete(win.doc);
			}),
		);
	}

	enable() {
		this.enabled = true;
		for (const doc of getOpenDocuments(this.plugin.app)) {
			this.observe(doc);
		}
	}

	disable() {
		this.enabled = false;
		for (const [doc, observer] of this.observers) {
			observer.disconnect();
			doc.body.classList.remove(ENABLED_CLASS);
		}
		this.observers.clear();
	}

	private observe(doc: Document) {
		if (this.observers.has(doc)) {
			return;
		}

		doc.body.classList.add(ENABLED_CLASS);
		colorTagPills(doc.body);

		// Tag pills are re-rendered when properties change, so color newly added ones.
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				// The pill's text may be filled in after the pill itself is added.
				const pill = (mutation.target as Element).closest?.(TAG_PILL_SELECTOR);
				if (pill) {
					colorTagPill(pill as HTMLElement);
				}
				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						colorTagPills(node as Element);
					}
				}
			}
		});
		observer.observe(doc.body, { childList: true, subtree: true });
		this.observers.set(doc, observer);
	}
}

function colorTagPills(el: Element) {
	if (el.matches(TAG_PILL_SELECTOR)) {
		colorTagPill(el as HTMLElement);
	}
	for (const pill of el.querySelectorAll<HTMLElement>(TAG_PILL_SELECTOR)) {
		colorTagPill(pill);
	}
}

function colorTagPill(pill: HTMLElement) {
	pill.style.setProperty("--squirrel-tag-color", nameToColor(pill.textContent ?? ""));
}

/** FNV-1a hash of the name, mapped to the palette. */
function nameToColor(name: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return COLORS[(hash >>> 0) % COLORS.length];
}
