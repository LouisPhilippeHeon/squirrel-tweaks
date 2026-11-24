// Move operation and changes applicator adapted from obsidian-outliner (MIT, Viacheslav Slinko).
import type { EditorDoc } from "./editor-doc";
import { type List, type Position, type Root, isRangesIntersects, recalculateNumericBullets } from "./list";

export type WhereToMove = "before" | "after" | "inside";

/** Moves `listToMove` relative to `placeToMove` and writes the result into the editor. */
export function moveList(
	editor: EditorDoc,
	root: Root,
	listToMove: List,
	placeToMove: List,
	whereToMove: WhereToMove,
	indentUnit: string,
) {
	if (listToMove === placeToMove) {
		return;
	}

	const prevRoot = root.clone();
	const cursorAnchor = calculateCursorAnchor(root, listToMove, placeToMove);

	listToMove.getParent()?.removeChild(listToMove);
	switch (whereToMove) {
		case "before":
			placeToMove.getParent()?.addBefore(placeToMove, listToMove);
			break;
		case "after":
			placeToMove.getParent()?.addAfter(placeToMove, listToMove);
			break;
		case "inside":
			placeToMove.addBeforeAll(listToMove);
			break;
	}

	const oldIndent = listToMove.getFirstLineIndent();
	const newIndent =
		whereToMove === "inside"
			? placeToMove.getFirstLineIndent() + indentUnit
			: placeToMove.getFirstLineIndent();
	listToMove.unindentContent(0, oldIndent.length);
	listToMove.indentContent(0, newIndent);

	if (cursorAnchor) {
		const start = cursorAnchor.list.getFirstLineContentStart();
		root.replaceCursor({
			line: start.line + cursorAnchor.lineDiff,
			ch: start.ch + cursorAnchor.chDiff,
		});
	} else {
		// Keep the cursor next to the moved item so the editor doesn't scroll away.
		root.replaceCursor(listToMove.getLastLineContentEnd());
	}

	recalculateNumericBullets(root);
	applyChanges(editor, prevRoot, root);
}

function calculateCursorAnchor(root: Root, listToMove: List, placeToMove: List) {
	const cursor = root.getCursor();
	const lines = [
		listToMove.getFirstLineContentStart().line,
		listToMove.getLastLineContentEnd().line,
		placeToMove.getFirstLineContentStart().line,
		placeToMove.getLastLineContentEnd().line,
	];
	if (cursor.line < Math.min(...lines) || cursor.line > Math.max(...lines)) {
		return null;
	}

	const list = root.getListUnderLine(cursor.line);
	if (!list) {
		return null;
	}
	const start = list.getFirstLineContentStart();
	return { list, lineDiff: cursor.line - start.line, chDiff: cursor.ch - start.ch };
}

/** Replaces only the lines that changed, and keeps folded items folded. */
function applyChanges(editor: EditorDoc, prevRoot: Root, newRoot: Root) {
	const changes = calculateChanges(editor, prevRoot, newRoot);
	if (!changes) {
		editor.setSelections(newRoot.getSelections());
		return;
	}

	const { replacement, changeFrom, changeTo } = changes;
	const changedRange: [Position, Position] = [changeFrom, changeTo];
	const newLists = getAllLists(newRoot);
	const unfold: number[] = [];
	const fold: number[] = [];

	for (const prevList of getAllLists(prevRoot).values()) {
		const newList = newLists.get(prevList.getID());
		if (!prevList.isFoldRoot() || !newList) {
			continue;
		}
		const prevListRange: [Position, Position] = [
			prevList.getFirstLineContentStart(),
			prevList.getContentEndIncludingChildren(),
		];
		if (isRangesIntersects(prevListRange, changedRange)) {
			unfold.push(prevList.getFirstLineContentStart().line);
			fold.push(newList.getFirstLineContentStart().line);
		}
	}

	unfold.sort((a, b) => b - a).forEach((line) => editor.unfold(line));
	editor.replaceRange(replacement, changeFrom, changeTo);
	fold.sort((a, b) => b - a).forEach((line) => editor.fold(line));
	editor.setSelections(newRoot.getSelections());
}

function calculateChanges(editor: EditorDoc, prevRoot: Root, newRoot: Root) {
	const [rootStart, rootEnd] = prevRoot.getContentRange();
	const changeFrom = { ...rootStart };
	const changeTo = { ...rootEnd };
	let oldTmp = editor.getRange(rootStart, rootEnd);
	let newTmp = newRoot.print();

	// Trim identical trailing lines.
	while (true) {
		const nlIndex = oldTmp.lastIndexOf("\n");
		if (nlIndex < 0) {
			break;
		}
		const oldLine = oldTmp.slice(nlIndex);
		if (oldLine !== newTmp.slice(-oldLine.length)) {
			break;
		}
		oldTmp = oldTmp.slice(0, -oldLine.length);
		newTmp = newTmp.slice(0, -oldLine.length);
		const nlIndex2 = oldTmp.lastIndexOf("\n");
		changeTo.ch = nlIndex2 >= 0 ? oldTmp.length - nlIndex2 - 1 : oldTmp.length;
		changeTo.line--;
	}

	// Trim identical leading lines.
	while (true) {
		const nlIndex = oldTmp.indexOf("\n");
		if (nlIndex < 0) {
			break;
		}
		const oldLine = oldTmp.slice(0, nlIndex + 1);
		if (oldLine !== newTmp.slice(0, oldLine.length)) {
			break;
		}
		changeFrom.line++;
		oldTmp = oldTmp.slice(oldLine.length);
		newTmp = newTmp.slice(oldLine.length);
	}

	if (oldTmp === newTmp) {
		return null;
	}
	return { replacement: newTmp, changeFrom, changeTo };
}

function getAllLists(root: Root): Map<number, List> {
	const lists = new Map<number, List>();
	const visit = (list: List) => {
		lists.set(list.getID(), list);
		list.getChildren().forEach(visit);
	};
	root.getChildren().forEach(visit);
	return lists;
}
