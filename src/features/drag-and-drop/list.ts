// List model adapted from obsidian-outliner (MIT, Viacheslav Slinko).

export interface Position {
	line: number;
	ch: number;
}

export interface Selection {
	anchor: Position;
	head: Position;
}

export function cmpPos(a: Position, b: Position) {
	return a.line - b.line || a.ch - b.ch;
}

export function isRangesIntersects(a: [Position, Position], b: [Position, Position]) {
	return cmpPos(a[1], b[0]) >= 0 && cmpPos(a[0], b[1]) <= 0;
}

let idSeq = 0;

export class List {
	private id = idSeq++;
	private parent: List | null = null;
	private children: List[] = [];
	private notesIndent: string | null = null;
	private lines: string[];

	constructor(
		private root: Root,
		private indent: string,
		private bullet: string,
		private spaceAfterBullet: string,
		firstLine: string,
		private foldRoot: boolean,
	) {
		this.lines = [firstLine];
	}

	getID() {
		return this.id;
	}

	getNotesIndent() {
		return this.notesIndent;
	}

	setNotesIndent(notesIndent: string) {
		this.notesIndent = notesIndent;
	}

	addLine(text: string) {
		this.lines.push(text);
	}

	getLineCount() {
		return this.lines.length;
	}

	getChildren() {
		return this.children.slice();
	}

	isEmpty() {
		return this.children.length === 0;
	}

	getParent() {
		return this.parent;
	}

	getLevel(): number {
		return this.parent ? this.parent.getLevel() + 1 : 0;
	}

	isFoldRoot() {
		return this.foldRoot;
	}

	getFirstLineIndent() {
		return this.indent;
	}

	getBullet() {
		return this.bullet;
	}

	replaceBullet(bullet: string) {
		this.bullet = bullet;
	}

	getFirstLineContentStart(): Position {
		return { line: this.getLinesRange()[0], ch: this.getContentStartCh() };
	}

	getLastLineContentEnd(): Position {
		const lastLine = this.lines[this.lines.length - 1];
		const ch =
			this.lines.length === 1
				? this.getContentStartCh() + lastLine.length
				: (this.notesIndent ?? "").length + lastLine.length;
		return { line: this.getLinesRange()[1], ch };
	}

	getContentEndIncludingChildren(): Position {
		let last: List = this;
		while (!last.isEmpty()) {
			last = last.children[last.children.length - 1];
		}
		return last.getLastLineContentEnd();
	}

	private getLinesRange(): [number, number] {
		const range = this.root.getContentLinesRangeOf(this);
		if (!range) {
			throw new Error("List is not attached to its root");
		}
		return range;
	}

	private getContentStartCh() {
		return this.indent.length + this.bullet.length + 1;
	}

	unindentContent(from: number, till: number) {
		this.indent = this.indent.slice(0, from) + this.indent.slice(till);
		if (this.notesIndent !== null) {
			this.notesIndent = this.notesIndent.slice(0, from) + this.notesIndent.slice(till);
		}
		for (const child of this.children) {
			child.unindentContent(from, till);
		}
	}

	indentContent(pos: number, chars: string) {
		this.indent = this.indent.slice(0, pos) + chars + this.indent.slice(pos);
		if (this.notesIndent !== null) {
			this.notesIndent = this.notesIndent.slice(0, pos) + chars + this.notesIndent.slice(pos);
		}
		for (const child of this.children) {
			child.indentContent(pos, chars);
		}
	}

	addBeforeAll(list: List) {
		this.children.unshift(list);
		list.parent = this;
	}

	addAfterAll(list: List) {
		this.children.push(list);
		list.parent = this;
	}

	addBefore(before: List, list: List) {
		this.children.splice(this.children.indexOf(before), 0, list);
		list.parent = this;
	}

	addAfter(after: List, list: List) {
		this.children.splice(this.children.indexOf(after) + 1, 0, list);
		list.parent = this;
	}

	removeChild(list: List) {
		this.children.splice(this.children.indexOf(list), 1);
		list.parent = null;
	}

	print(): string {
		let res = "";
		this.lines.forEach((line, i) => {
			res += i === 0 ? this.indent + this.bullet + this.spaceAfterBullet : this.notesIndent;
			res += line + "\n";
		});
		for (const child of this.children) {
			res += child.print();
		}
		return res;
	}

	clone(newRoot: Root): List {
		const clone = new List(newRoot, this.indent, this.bullet, this.spaceAfterBullet, "", this.foldRoot);
		clone.id = this.id;
		clone.lines = this.lines.slice();
		clone.notesIndent = this.notesIndent;
		for (const child of this.children) {
			clone.addAfterAll(child.clone(newRoot));
		}
		return clone;
	}
}

/** A contiguous block of list items in the document. */
export class Root {
	private rootList = new List(this, "", "", "", "", false);

	constructor(
		private start: Position,
		private end: Position,
		private selections: Selection[],
	) {}

	getRootList() {
		return this.rootList;
	}

	getChildren() {
		return this.rootList.getChildren();
	}

	getContentStart(): Position {
		return { ...this.start };
	}

	getContentRange(): [Position, Position] {
		return [{ ...this.start }, { ...this.end }];
	}

	getSelections(): Selection[] {
		return this.selections.map((s) => ({ anchor: { ...s.anchor }, head: { ...s.head } }));
	}

	getCursor(): Position {
		return { ...this.selections[this.selections.length - 1].head };
	}

	replaceCursor(cursor: Position) {
		this.selections = [{ anchor: cursor, head: cursor }];
	}

	getListUnderLine(line: number): List | null {
		if (line < this.start.line || line > this.end.line) {
			return null;
		}
		let found: List | null = null;
		this.walk((list, from, till) => {
			if (line >= from && line <= till) {
				found = list;
				return true;
			}
			return false;
		});
		return found;
	}

	getContentLinesRangeOf(target: List): [number, number] | null {
		let found: [number, number] | null = null;
		this.walk((list, from, till) => {
			if (list === target) {
				found = [from, till];
				return true;
			}
			return false;
		});
		return found;
	}

	/** Visits lists in document order with their own line span; stops when `visit` returns true. */
	private walk(visit: (list: List, from: number, till: number) => boolean) {
		let line = this.start.line;
		const visitAll = (lists: List[]): boolean => {
			for (const list of lists) {
				const from = line;
				const till = from + list.getLineCount() - 1;
				line = till + 1;
				if (visit(list, from, till) || visitAll(list.getChildren())) {
					return true;
				}
			}
			return false;
		};
		visitAll(this.rootList.getChildren());
	}

	print() {
		return this.getChildren()
			.map((child) => child.print())
			.join("")
			.replace(/\n$/, "");
	}

	clone() {
		const clone = new Root({ ...this.start }, { ...this.end }, this.getSelections());
		clone.rootList = this.rootList.clone(clone);
		return clone;
	}
}

/** Renumbers ordered list items after a move. */
export function recalculateNumericBullets(root: Root) {
	const visit = (parent: List) => {
		let index = 1;
		for (const child of parent.getChildren()) {
			if (/\d+\./.test(child.getBullet())) {
				child.replaceBullet(`${index++}.`);
			}
			visit(child);
		}
	};
	visit(root.getRootList());
}
