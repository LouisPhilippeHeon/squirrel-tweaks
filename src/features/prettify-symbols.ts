// Adapted from obsidian-symbols-prettifier (MIT, Florian Woelki).
import { syntaxTree, tokenClassNodeProp } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { MarkdownView, type Plugin, editorLivePreviewField } from "obsidian";
import type { NodeProp } from "@lezer/common";
import type { Feature } from "./feature";

// Only exported by Obsidian's fork of @codemirror/language, which is the one loaded at runtime.
declare module "@codemirror/language" {
	const tokenClassNodeProp: NodeProp<string>;
}

const SYMBOLS: Record<string, string> = {
	"->": "→",
	"<-": "←",
	"<->": "↔",
	"<=>": "⇔",
	"<=": "⇐",
	"=>": "⇒",
	"--": "–",
	"!=": "≠",
	"===": "≡",
	"=/=": "≠",
	"=<": "≤",
	">=": "≥",
	"+-": "±",
	"-+": "∓",
};

// Longest first, so that "<->" wins over "<-".
const SYMBOLS_PATTERN = Object.keys(SYMBOLS)
	.sort((a, b) => b.length - a.length)
	.map((s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
	.join("|");
const symbolsRe = () => new RegExp(SYMBOLS_PATTERN, "g");

export class PrettifySymbols implements Feature {
	private enabled = false;
	private editorExtensions: Extension[] = [];

	constructor(private plugin: Plugin) {
		plugin.registerEditorExtension(this.editorExtensions);
		plugin.registerMarkdownPostProcessor((el) => {
			if (this.enabled) {
				prettifyRenderedMarkdown(el);
			}
		});
	}

	enable() {
		this.setEnabled(true);
	}

	disable() {
		this.setEnabled(false);
	}

	private setEnabled(enabled: boolean) {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;

		this.editorExtensions.length = 0;
		if (enabled) {
			this.editorExtensions.push(symbolsViewPlugin);
		}

		const { workspace } = this.plugin.app;
		workspace.updateOptions();
		for (const leaf of workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) {
				leaf.view.previewMode.rerender(true);
			}
		}
	}
}

// Syntax token classes in which symbols are prettified, and the ones in which they never are.
const ALLOWED_TOKENS = new Set([
	"link-alias", "comment", "header", "strong", "em", "strikethrough", "quote", "link",
	"list-1", "list-2", "list-3", "highlight", "hmd-footref2", "footref",
]);
const EXCLUDED_TOKENS = new Set(["formatting", "comment-start", "comment-end", "inline-code"]);

class SymbolWidget extends WidgetType {
	constructor(private symbol: string) {
		super();
	}

	override eq(other: SymbolWidget) {
		return other.symbol === this.symbol;
	}

	override toDOM() {
		return createSpan({ cls: "squirrel-symbol", text: this.symbol });
	}

	override ignoreEvent() {
		return false;
	}
}

const symbolsViewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
		}

		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet ||
				syntaxTree(update.state) !== syntaxTree(update.startState) ||
				update.state.field(editorLivePreviewField) !== update.startState.field(editorLivePreviewField)
			) {
				this.decorations = buildDecorations(update.view);
			}
		}
	},
	{
		decorations: (v) => v.decorations,
		provide: (plugin) =>
			EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
	},
);

function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	if (!state.field(editorLivePreviewField)) {
		return Decoration.none;
	}

	const decorations: Range<Decoration>[] = [];
	for (const visible of view.visibleRanges) {
		forEachSymbol(state, visible.from, visible.to, (from, to, symbol) => {
			// Show the raw text when the cursor or a selection touches the symbol.
			const touched = state.selection.ranges.some((r) => r.from <= to && r.to >= from);
			if (!touched) {
				decorations.push(Decoration.replace({ widget: new SymbolWidget(symbol) }).range(from, to));
			}
		});
	}
	return Decoration.set(decorations, true);
}

function forEachSymbol(
	state: EditorState,
	rangeFrom: number,
	rangeTo: number,
	callback: (from: number, to: number, symbol: string) => void,
) {
	const scan = (from: number, to: number) => {
		from = Math.max(from, rangeFrom);
		to = Math.min(to, rangeTo);
		if (from >= to) {
			return;
		}
		const text = state.doc.sliceString(from, to);
		for (const match of text.matchAll(symbolsRe())) {
			const start = from + match.index;
			callback(start, start + match[0].length, SYMBOLS[match[0]]);
		}
	};

	// Plain text lies between syntax nodes; inside nodes, only some token types qualify.
	let prevTo = rangeFrom;
	syntaxTree(state).iterate({
		from: rangeFrom,
		to: rangeTo,
		enter: ({ type, from, to }) => {
			if (type.isTop) {
				return;
			}
			scan(prevTo, from);
			prevTo = Math.max(prevTo, to);

			const tokens = type.prop(tokenClassNodeProp)?.split(" ") ?? [];
			if (tokens.some((t) => ALLOWED_TOKENS.has(t)) && !tokens.some((t) => EXCLUDED_TOKENS.has(t))) {
				scan(from, to);
			}
			return false; // Nested nodes (e.g. code in fenced blocks) belong to their parent.
		},
	});
	scan(prevTo, rangeTo);
}

/** Reading view: replaces symbols in text nodes, outside code and math. */
function prettifyRenderedMarkdown(el: HTMLElement) {
	const walker = el.doc.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			if (node.nodeName === "CODE" || node.nodeName === "MJX-CONTAINER") {
				return NodeFilter.FILTER_REJECT;
			}
			return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});

	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.nodeValue;
		if (text) {
			const prettified = text.replace(symbolsRe(), (symbol) => SYMBOLS[symbol]);
			if (prettified !== text) {
				node.nodeValue = prettified;
			}
		}
	}
}
