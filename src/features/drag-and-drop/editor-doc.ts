import { foldEffect, foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorSelection, type StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Position, Selection } from "./list";

/** Line/ch based access to a CodeMirror view (lines are 0-based). */
export class EditorDoc {
	constructor(readonly view: EditorView) {}

	private get doc() {
		return this.view.state.doc;
	}

	getLine(n: number): string {
		return this.doc.line(n + 1).text;
	}

	lastLine(): number {
		return this.doc.lines - 1;
	}

	posToOffset(pos: Position): number {
		const line = this.doc.line(pos.line + 1);
		return Math.min(line.from + pos.ch, line.to);
	}

	offsetToPos(offset: number): Position {
		const line = this.doc.lineAt(offset);
		return { line: line.number - 1, ch: offset - line.from };
	}

	getRange(from: Position, to: Position): string {
		return this.doc.sliceString(this.posToOffset(from), this.posToOffset(to));
	}

	listSelections(): Selection[] {
		return this.view.state.selection.ranges.map((r) => ({
			anchor: this.offsetToPos(r.anchor),
			head: this.offsetToPos(r.head),
		}));
	}

	getAllFoldedLines(): number[] {
		const lines: number[] = [];
		foldedRanges(this.view.state).between(0, this.doc.length, (from) => {
			lines.push(this.offsetToPos(from).line);
		});
		return lines;
	}

	fold(line: number) {
		const block = this.view.lineBlockAt(this.doc.line(line + 1).from);
		const range = foldable(this.view.state, block.from, block.to);
		if (range && range.from !== range.to) {
			this.dispatchEffect(foldEffect.of(range));
		}
	}

	unfold(line: number) {
		const block = this.view.lineBlockAt(this.doc.line(line + 1).from);
		let found: { from: number; to: number } | null = null;
		foldedRanges(this.view.state).between(block.from, block.to, (from, to) => {
			if (!found || found.from > from) {
				found = { from, to };
			}
		});
		if (found) {
			this.dispatchEffect(unfoldEffect.of(found));
		}
	}

	replaceRange(text: string, from: Position, to: Position) {
		this.view.dispatch({
			changes: { from: this.posToOffset(from), to: this.posToOffset(to), insert: text },
			userEvent: "move.drop",
		});
	}

	setSelections(selections: Selection[]) {
		this.view.dispatch({
			selection: EditorSelection.create(
				selections.map((s) => EditorSelection.range(this.posToOffset(s.anchor), this.posToOffset(s.head))),
			),
		});
	}

	private dispatchEffect(effect: StateEffect<unknown>) {
		this.view.dispatch({ effects: effect });
	}
}
