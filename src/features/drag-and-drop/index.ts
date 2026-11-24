// Drag and drop of list items adapted from obsidian-outliner (MIT, Viacheslav Slinko).
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { Notice, Platform, type Plugin } from "obsidian";
import { type Feature, getOpenDocuments } from "../feature";
import { EditorDoc } from "./editor-doc";
import { type List, type Root, cmpPos } from "./list";
import { type WhereToMove, moveList } from "./move";
import { parseList } from "./parser";

const ENABLED_CLASS = "squirrel-dnd";
const DRAGGING_CLASS = "squirrel-dnd-dragging";

interface PreStart {
	x: number;
	y: number;
	view: EditorView;
	document: Document;
}

interface ClickGesture {
	document: Document;
	released: boolean;
	timeout?: number;
}

export class DragAndDrop implements Feature {
	private enabled = false;
	private registeredDocuments = new WeakSet<Document>();
	private preStart: PreStart | null = null;
	private state: DragState | null = null;
	// Escape cancels the move, but releasing the mouse must still not click
	// the bullet. Click suppression is armed once that document gets mouseup.
	private clickGesture: ClickGesture | null = null;

	constructor(private plugin: Plugin) {
		const { workspace } = plugin.app;
		plugin.registerEditorExtension([draggingLinesField, droppingLinesField]);
		plugin.registerEvent(
			workspace.on("window-open", (win) => {
				if (this.enabled) {
					this.registerDocument(win.doc);
				}
			}),
		);
		plugin.registerEvent(
			workspace.on("window-close", (win) => {
				const doc = win.doc;
				if (
					this.preStart?.document === doc ||
					this.state?.document === doc ||
					this.clickGesture?.document === doc
				) {
					this.cancelDragging();
				}
			}),
		);
	}

	enable() {
		if (!Platform.isDesktop) {
			return;
		}
		this.enabled = true;
		for (const doc of getOpenDocuments(this.plugin.app)) {
			this.registerDocument(doc);
		}
	}

	disable() {
		this.enabled = false;
		this.cancelDragging();
		for (const doc of getOpenDocuments(this.plugin.app)) {
			doc.body.classList.remove(ENABLED_CLASS, DRAGGING_CLASS);
		}
	}

	/** Listeners stay registered until the plugin unloads and do nothing while disabled. */
	private registerDocument(doc: Document) {
		doc.body.classList.add(ENABLED_CLASS);
		// Obsidian may copy body classes when creating a new window.
		doc.body.classList.remove(DRAGGING_CLASS);

		if (this.registeredDocuments.has(doc)) {
			return;
		}
		this.registeredDocuments.add(doc);

		const plugin = this.plugin;
		plugin.registerDomEvent(doc, "mousedown", this.handleMouseDown, { capture: true });
		plugin.registerDomEvent(doc, "click", this.handleClick, { capture: true });
		plugin.registerDomEvent(doc, "mousemove", this.handleMouseMove);
		plugin.registerDomEvent(doc, "mouseup", this.handleMouseUp, { capture: true });
		plugin.registerDomEvent(doc, "keydown", this.handleKeyDown);
		if (doc.defaultView) {
			plugin.registerDomEvent(doc.defaultView, "blur", this.handleWindowBlur);
		}
	}

	private handleMouseDown = (e: MouseEvent) => {
		// A new gesture must never overwrite another document's drag owner.
		this.cancelDragging();
		if (!this.enabled || e.button !== 0 || !isClickOnBullet(e)) {
			return;
		}

		const view = getEditorView(e.target);
		if (!view) {
			return;
		}

		e.preventDefault();
		e.stopPropagation();
		this.preStart = { x: e.clientX, y: e.clientY, view, document: view.dom.ownerDocument };
	};

	private handleMouseMove = (e: MouseEvent) => {
		if ((e.buttons & 1) === 0) {
			this.cancelDragging();
			return;
		}

		const doc = getEventDocument(e);
		if (this.preStart && doc === this.preStart.document) {
			this.startDragging(this.preStart);
		}
		if (this.state && doc === this.state.document) {
			this.state.calculateNearestDropVariant(e.clientX, e.clientY);
			this.state.drawDropZone();
		}
	};

	private handleMouseUp = (e: MouseEvent) => {
		this.preStart = null;
		const doc = getEventDocument(e);
		const gesture = this.clickGesture;

		if (e.button === 0 && gesture?.document === doc) {
			gesture.released = true;
			// The native click is dispatched right after mouseup, before the next task.
			// If there is no click, don't leave suppression armed for later input.
			gesture.timeout = doc.defaultView?.setTimeout(() => {
				if (this.clickGesture === gesture) {
					this.clearClickGesture();
				}
			}, 0);
		} else {
			this.clearClickGesture();
		}

		if (this.state && doc === this.state.document) {
			this.stopDragging(true);
		} else {
			// Releasing in another window cancels; it is not a cross-window drop.
			// An Escape-cancelled gesture still needs its matching click suppressed.
			this.cancelDragging(true);
		}
	};

	private handleClick = (e: MouseEvent) => {
		const gesture = this.clickGesture;
		if (
			!gesture?.released ||
			gesture.document !== getEventDocument(e) ||
			!e.isTrusted ||
			e.button !== 0 ||
			e.detail === 0
		) {
			return;
		}
		this.clearClickGesture();
		e.preventDefault();
		e.stopImmediatePropagation();
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		if (e.code === "Escape") {
			this.cancelDragging(true);
		}
	};

	private handleWindowBlur = (e: Event) => {
		const owner = this.state?.document ?? this.preStart?.document ?? this.clickGesture?.document;
		if (owner?.defaultView === e.currentTarget) {
			this.cancelDragging();
		}
	};

	private startDragging({ x, y, view, document }: PreStart) {
		this.preStart = null;

		const offset = view.posAtCoords({ x, y });
		if (offset === null) {
			return;
		}

		const editor = new EditorDoc(view);
		const root = parseList(editor, editor.offsetToPos(offset).line);
		const list = root?.getListUnderLine(editor.offsetToPos(offset).line);
		if (!root || !list) {
			return;
		}

		const state = new DragState(document, view, editor, root, list);
		if (!state.hasDropVariants()) {
			state.destroy();
			return;
		}

		this.state = state;
		this.clickGesture = { document, released: false };
		state.highlightDraggingLines();
	}

	private clearClickGesture() {
		const gesture = this.clickGesture;
		if (gesture?.timeout !== undefined) {
			gesture.document.defaultView?.clearTimeout(gesture.timeout);
		}
		this.clickGesture = null;
	}

	private cancelDragging(preserveClickGesture = false) {
		if (!preserveClickGesture) {
			this.clearClickGesture();
		}
		this.stopDragging(false);
	}

	private stopDragging(applyChanges: boolean) {
		const state = this.state;
		this.preStart = null;
		this.state = null;
		if (!state) {
			return;
		}

		// Release the DOM even if dispatch fails on a closing editor.
		state.destroy();
		if (applyChanges) {
			state.applyMove();
		}
	}
}

interface DropVariant {
	level: number;
	left: number;
	top: number;
	placeToMove: List;
	whereToMove: WhereToMove;
}

class DragState {
	private dropVariants = new Map<string, DropVariant>();
	private dropVariant: DropVariant | null = null;
	private dropZone: HTMLDivElement;
	private dropZonePadding: HTMLDivElement;
	private leftPadding: number;
	private tabWidth: number;

	constructor(
		readonly document: Document,
		readonly view: EditorView,
		private editor: EditorDoc,
		private root: Root,
		private list: List,
	) {
		this.collectDropVariants();
		this.leftPadding = view.dom.querySelector(".cm-line")?.getBoundingClientRect().left ?? 0;
		this.tabWidth = this.calculateTabWidth();

		this.dropZone = document.body.createDiv({ cls: "squirrel-dnd-drop-zone" });
		this.dropZonePadding = this.dropZone.createDiv({ cls: "squirrel-dnd-drop-zone-padding" });
		this.dropZone.hide();
	}

	hasDropVariants() {
		return this.dropVariants.size > 0;
	}

	destroy() {
		this.document.body.classList.remove(DRAGGING_CLASS);
		this.dropZone.remove();
		this.view.dispatch({ effects: dndEnded.of(null) });
	}

	highlightDraggingLines() {
		const lines: number[] = [];
		const fromLine = this.list.getFirstLineContentStart().line;
		const tillLine = this.list.getContentEndIncludingChildren().line;
		for (let i = fromLine; i <= tillLine; i++) {
			lines.push(this.editor.posToOffset({ line: i, ch: 0 }));
		}
		this.view.dispatch({ effects: dndStarted.of(lines) });
		this.document.body.classList.add(DRAGGING_CLASS);
	}

	applyMove() {
		const { dropVariant, editor, root, list } = this;
		if (!dropVariant) {
			return;
		}

		const newRoot = parseList(editor, root.getContentStart().line);
		if (!newRoot || !isSameRoots(root, newRoot)) {
			new Notice("The item cannot be moved. The page content changed during the move.", 5000);
			return;
		}

		moveList(
			editor,
			root,
			list,
			dropVariant.placeToMove,
			dropVariant.whereToMove,
			this.view.state.facet(indentUnit),
		);
	}

	calculateNearestDropVariant(x: number, y: number) {
		const { view, editor } = this;
		const candidates: DropVariant[] = [];

		for (const v of this.dropVariants.values()) {
			const afterList = v.whereToMove !== "before";
			const line = afterList
				? v.placeToMove.getContentEndIncludingChildren().line
				: v.placeToMove.getFirstLineContentStart().line;
			const linePos = editor.posToOffset({ line, ch: 0 });
			const coords = view.coordsAtPos(linePos, -1);
			if (!coords) {
				continue;
			}

			v.left = this.leftPadding + (v.level - 1) * this.tabWidth;
			v.top = coords.top;
			if (afterList) {
				v.top += view.lineBlockAt(linePos).height;
			}
			v.top -= 8; // Better vertical alignment.
			candidates.push(v);
		}

		const nearestTop = minBy(candidates, (v) => Math.abs(y - v.top))?.top;
		if (nearestTop === undefined) {
			this.dropVariant = null;
			return;
		}
		const onNearestLine = candidates.filter((v) => Math.abs(v.top - nearestTop) <= 4);
		this.dropVariant = minBy(onNearestLine, (v) => Math.abs(x - v.left)) ?? null;
	}

	drawDropZone() {
		const { view, editor, dropVariant, dropZone, dropZonePadding } = this;
		if (!dropVariant) {
			dropZone.hide();
			view.dispatch({ effects: dndMoved.of(null) });
			return;
		}

		const newParent =
			dropVariant.whereToMove === "inside"
				? dropVariant.placeToMove
				: dropVariant.placeToMove.getParent();
		const newParentIsRootList = !newParent?.getParent();

		dropZone.show();
		dropZone.setCssStyles({
			top: `${dropVariant.top}px`,
			left: `${dropVariant.left}px`,
			width: `${Math.round(view.contentDOM.offsetWidth - (dropVariant.left - this.leftPadding))}px`,
		});

		// Dashed line showing the indentation levels of the new parent.
		const width = this.tabWidth * (newParent?.getLevel() ?? 0);
		const dashPadding = 3;
		const dashWidth = this.tabWidth - dashPadding;
		const color = getComputedStyle(this.document.body).getPropertyValue("--color-accent");
		const svg =
			`<svg viewBox="0 0 ${width} 4" xmlns="http://www.w3.org/2000/svg">` +
			`<line x1="0" y1="0" x2="${width}" y2="0" stroke="${color}" stroke-width="8" stroke-dasharray="${dashWidth} ${dashPadding}"/>` +
			`</svg>`;
		dropZonePadding.setCssStyles({
			width: `${width}px`,
			marginLeft: `-${width}px`,
			backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
		});

		view.dispatch({
			effects: dndMoved.of(
				newParentIsRootList || !newParent
					? null
					: editor.posToOffset({ line: newParent.getFirstLineContentStart().line, ch: 0 }),
			),
		});
	}

	private addDropVariant(line: number, v: Omit<DropVariant, "left" | "top">) {
		this.dropVariants.set(`${line} ${v.level}`, { ...v, left: 0, top: 0 });
	}

	private collectDropVariants() {
		const visit = (lists: List[]) => {
			for (const placeToMove of lists) {
				const lineBefore = placeToMove.getFirstLineContentStart().line;
				const lineAfter = placeToMove.getContentEndIncludingChildren().line + 1;
				const level = placeToMove.getLevel();

				this.addDropVariant(lineBefore, { level, placeToMove, whereToMove: "before" });
				this.addDropVariant(lineAfter, { level, placeToMove, whereToMove: "after" });

				if (placeToMove === this.list) {
					continue;
				}

				if (placeToMove.isEmpty()) {
					this.addDropVariant(lineAfter, { level: level + 1, placeToMove, whereToMove: "inside" });
				} else {
					visit(placeToMove.getChildren());
				}
			}
		};
		visit(this.root.getChildren());
	}

	private calculateTabWidth(): number {
		const { view } = this;

		const indentDom = view.dom.querySelector<HTMLElement>(".cm-indent");
		if (indentDom) {
			return indentDom.offsetWidth;
		}

		const singleIndent = view.state.facet(indentUnit);
		for (let i = 1; i <= view.state.doc.lines; i++) {
			const line = view.state.doc.line(i);
			if (line.text.startsWith(singleIndent)) {
				const a = view.coordsAtPos(line.from, -1);
				const b = view.coordsAtPos(line.from + singleIndent.length, -1);
				if (a && b) {
					return b.left - a.left;
				}
			}
		}

		return view.defaultCharacterWidth * getIndentUnit(view.state);
	}
}

const dndStarted = StateEffect.define<number[]>({
	map: (lines, change) => lines.map((l) => change.mapPos(l)),
});

const dndMoved = StateEffect.define<number | null>({
	map: (line, change) => (line !== null ? change.mapPos(line) : line),
});

const dndEnded = StateEffect.define<null>();

const draggingLineDecoration = Decoration.line({ class: "squirrel-dnd-dragging-line" });
const droppingLineDecoration = Decoration.line({ class: "squirrel-dnd-dropping-line" });

const draggingLinesField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update: (decorations, tr) => {
		decorations = decorations.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(dndStarted)) {
				decorations = decorations.update({
					add: e.value.map((l) => draggingLineDecoration.range(l, l)),
				});
			}
			if (e.is(dndEnded)) {
				decorations = Decoration.none;
			}
		}
		return decorations;
	},
	provide: (f) => EditorView.decorations.from(f),
});

const droppingLinesField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update: (decorations, tr) => {
		decorations = decorations.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(dndMoved)) {
				decorations =
					e.value === null
						? Decoration.none
						: Decoration.set(droppingLineDecoration.range(e.value, e.value));
			}
			if (e.is(dndEnded)) {
				decorations = Decoration.none;
			}
		}
		return decorations;
	},
	provide: (f) => EditorView.decorations.from(f),
});

function minBy<T>(items: T[], score: (item: T) => number): T | undefined {
	let best: T | undefined;
	let bestScore = Infinity;
	for (const item of items) {
		const s = score(item);
		if (s < bestScore) {
			best = item;
			bestScore = s;
		}
	}
	return best;
}

function getEditorView(target: EventTarget | null): EditorView | null {
	// No `instanceof HTMLElement`: popout windows have their own DOM constructors.
	const el = (target as Element | null)?.closest?.(".cm-editor");
	return el ? EditorView.findFromDOM(el as HTMLElement) : null;
}

function isClickOnBullet(e: MouseEvent) {
	const el = e.target as Element | null;
	return !!el?.closest?.(".cm-formatting-list, .cm-fold-indicator, .task-list-item-checkbox");
}

function getEventDocument(e: Event): Document | null {
	const target = e.target as Partial<Node> | null;
	if (!target) {
		return null;
	}
	if (target.nodeType === Node.DOCUMENT_NODE) {
		return target as Document;
	}
	return target.ownerDocument ?? null;
}

function isSameRoots(a: Root, b: Root) {
	const [aStart, aEnd] = a.getContentRange();
	const [bStart, bEnd] = b.getContentRange();
	return cmpPos(aStart, bStart) === 0 && cmpPos(aEnd, bEnd) === 0 && a.print() === b.print();
}
