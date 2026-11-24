// List parser adapted from obsidian-outliner (MIT, Viacheslav Slinko).
import type { EditorDoc } from "./editor-doc";
import { List, Root } from "./list";

const bulletRe = String.raw`(?:[-*+]|\d+\.)`;
const listItemWithoutSpacesRe = new RegExp(`^${bulletRe}( |\t)`);
const listItemRe = new RegExp(`^[ \t]*${bulletRe}( |\t)`);
const lineWithIndentRe = /^[ \t]+/;
const parseListItemRe = new RegExp(`^([ \t]*)(${bulletRe})( |\t)(.*)$`);

const isListItem = (line: string) => listItemRe.test(line);
const isListItemWithoutSpaces = (line: string) => listItemWithoutSpacesRe.test(line);
const isLineWithIndent = (line: string) => lineWithIndentRe.test(line);

/** Parses the whole list containing `startLine`, or returns null if it isn't in a well-formed list. */
export function parseList(editor: EditorDoc, startLine: number): Root | null {
	const lastLine = editor.lastLine();
	const line = editor.getLine(startLine);

	// Find a list item at or above the start line (notes are indented lines).
	let lookingPos: number | null = null;
	if (isListItem(line)) {
		lookingPos = startLine;
	} else if (isLineWithIndent(line)) {
		for (let l = startLine - 1; l >= 0; l--) {
			const text = editor.getLine(l);
			if (isListItem(text)) {
				lookingPos = l;
				break;
			}
			if (!isLineWithIndent(text)) {
				break;
			}
		}
	}
	if (lookingPos === null) {
		return null;
	}

	let listStartLine: number | null = null;
	for (let l = lookingPos; l >= 0; l--) {
		const text = editor.getLine(l);
		if (!isListItem(text) && !isLineWithIndent(text)) {
			break;
		}
		if (isListItemWithoutSpaces(text)) {
			listStartLine = l;
		}
	}
	if (listStartLine === null) {
		return null;
	}

	let listEndLine = lookingPos;
	for (let l = lookingPos; l <= lastLine; l++) {
		const text = editor.getLine(l);
		if (!isListItem(text) && !isLineWithIndent(text)) {
			break;
		}
		if (text.length > 0) {
			listEndLine = l;
		}
	}

	// Whitespace-only lines that cannot be notes separate lists.
	for (const boundary of findWhitespaceBoundaries(editor, listStartLine, listEndLine)) {
		if (boundary === startLine) {
			return null;
		}
		if (boundary < startLine) {
			listStartLine = boundary + 1;
		} else {
			listEndLine = boundary - 1;
			break;
		}
	}

	// A list must start with a top-level item, not orphaned notes/children.
	while (listStartLine <= startLine && !isListItemWithoutSpaces(editor.getLine(listStartLine))) {
		listStartLine++;
	}
	if (listStartLine > startLine || listEndLine < startLine) {
		return null;
	}

	const root = new Root(
		{ line: listStartLine, ch: 0 },
		{ line: listEndLine, ch: editor.getLine(listEndLine).length },
		editor.listSelections(),
	);

	let currentParent: List = root.getRootList();
	let currentList: List | null = null;
	let currentIndent = "";
	const foldedLines = new Set(editor.getAllFoldedLines());

	for (let l = listStartLine; l <= listEndLine; l++) {
		const text = editor.getLine(l);
		const matches = parseListItemRe.exec(text);

		if (matches) {
			const [, indent, bullet, spaceAfterBullet, content] = matches;
			const compareLength = Math.min(currentIndent.length, indent.length);
			if (indent.slice(0, compareLength) !== currentIndent.slice(0, compareLength)) {
				return null; // Mixed tabs and spaces.
			}

			if (indent.length > currentIndent.length) {
				currentParent = currentList ?? currentParent;
				currentIndent = indent;
			} else if (indent.length < currentIndent.length) {
				let parent: List | null = currentParent;
				while (parent && parent.getFirstLineIndent().length >= indent.length && parent.getParent()) {
					parent = parent.getParent();
				}
				currentParent = parent ?? root.getRootList();
				currentIndent = indent;
			}

			currentList = new List(root, indent, bullet, spaceAfterBullet, content, foldedLines.has(l));
			currentParent.addAfterAll(currentList);
		} else if (isLineWithIndent(text)) {
			if (!currentList) {
				return null;
			}

			const indentToCheck = currentList.getNotesIndent() ?? currentIndent;
			if (!text.startsWith(indentToCheck)) {
				return null;
			}

			let notesIndent = currentList.getNotesIndent();
			if (notesIndent === null) {
				const indent = text.match(lineWithIndentRe)?.[0] ?? "";
				if (indent.length <= currentIndent.length) {
					return null;
				}
				notesIndent = indent;
				currentList.setNotesIndent(notesIndent);
			}

			currentList.addLine(text.slice(notesIndent.length));
		} else {
			return null;
		}
	}

	return root;
}

function findWhitespaceBoundaries(editor: EditorDoc, fromLine: number, toLine: number): number[] {
	const boundaries: number[] = [];
	let itemIndent = "";
	let notesIndent: string | null = null;

	for (let l = fromLine; l <= toLine; l++) {
		const text = editor.getLine(l);
		const item = parseListItemRe.exec(text);
		if (item) {
			itemIndent = item[1];
			notesIndent = null;
		} else if (isLineWithIndent(text)) {
			const indent = text.match(lineWithIndentRe)?.[0] ?? "";
			if (
				/^\s+$/.test(text) &&
				(!text.startsWith(notesIndent ?? itemIndent) ||
					(notesIndent === null && indent.length <= itemIndent.length))
			) {
				boundaries.push(l);
				itemIndent = "";
				notesIndent = null;
			} else if (notesIndent === null) {
				notesIndent = indent;
			}
		}
	}

	return boundaries;
}
