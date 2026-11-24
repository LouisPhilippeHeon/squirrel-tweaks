// Adapted from obsidian-url-into-selection (MIT), using its default settings:
// only acts when text is selected, never produces image embeds.
import type { Editor, Plugin } from "obsidian";
import type { Feature } from "./feature";

export class PasteUrl implements Feature {
	private enabled = false;

	constructor(plugin: Plugin) {
		plugin.registerEvent(
			plugin.app.workspace.on("editor-paste", (evt, editor) => {
				if (!this.enabled || evt.defaultPrevented || !evt.clipboardData) {
					return;
				}
				if (pasteUrlIntoSelection(editor, evt.clipboardData.getData("text/plain"))) {
					evt.preventDefault();
				}
			}),
		);

		plugin.addCommand({
			id: "paste-url-into-selection",
			name: "Paste URL into selection",
			editorCheckCallback: (checking, editor) => {
				if (!this.enabled || !editor.somethingSelected()) {
					return false;
				}
				if (!checking) {
					void navigator.clipboard
						.readText()
						.then((text) => pasteUrlIntoSelection(editor, text));
				}
				return true;
			},
		});
	}

	enable() {
		this.enabled = true;
	}

	disable() {
		this.enabled = false;
	}
}

/** Returns true when the selection was turned into a link. */
function pasteUrlIntoSelection(editor: Editor, clipboard: string): boolean {
	if (!editor.somethingSelected()) {
		return false;
	}

	const clipboardText = stripSurroundingQuotes(clipboard.trim());
	const selectedText = editor.getSelection();
	const replacement = getReplaceText(
		clipboardText,
		selectedText,
		isInMarkdownLinkTarget(editor.getLine(editor.getCursor("from").line), editor.getCursor("from").ch),
	);
	if (replacement === null) {
		return false;
	}

	editor.replaceSelection(replacement);
	return true;
}

function getReplaceText(clipboardText: string, selectedText: string, inLinkTarget: boolean): string | null {
	let linkText: string;
	let url: string;

	if (isUrl(clipboardText)) {
		linkText = selectedText;
		url = clipboardText;
	} else if (isUrl(selectedText.trim())) {
		linkText = clipboardText;
		url = selectedText.trim();
	} else {
		return null;
	}

	if (inLinkTarget) {
		return url;
	}
	if (isWikilink(url)) {
		return linkText === "" ? url : `[[${url.slice(2, -2)}|${linkText}]]`;
	}
	return `[${linkText}](${processUrl(url)})`;
}

/** True when `ch` is inside the parentheses of `[text](...)` or `![alt](...)`. */
function isInMarkdownLinkTarget(line: string, ch: number): boolean {
	let depth = 0;
	let openParen = -1;
	for (let i = ch - 1; i >= 0; i--) {
		if (line[i] === ")") {
			depth++;
		} else if (line[i] === "(") {
			if (depth === 0) {
				openParen = i;
				break;
			}
			depth--;
		}
	}
	if (openParen <= 0 || line[openParen - 1] !== "]") {
		return false;
	}

	let bracketDepth = 0;
	for (let i = openParen - 2; i >= 0; i--) {
		if (line[i] === "]") {
			bracketDepth++;
		} else if (line[i] === "[") {
			if (bracketDepth === 0) {
				return true;
			}
			bracketDepth--;
		}
	}
	return false;
}

/** Strips matching quotes that file managers add around paths. */
function stripSurroundingQuotes(text: string): string {
	const first = text[0];
	if (text.length >= 2 && (first === '"' || first === "'") && text[text.length - 1] === first) {
		return text.slice(1, -1);
	}
	return text;
}

// https://www.oreilly.com/library/view/regular-expressions-cookbook/9781449327453/ch08s18.html
const win32PathRe = /^[a-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*$/i;
const unixPathRe = /^(?:\/[^/]+)+\/?$/i;
const fallbackUrlRe = /^[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)$/;

// Recognized schemes only, so that e.g. "font-style: italic" isn't a URL.
const URL_SCHEMES = new Set([
	"http", "https", "ftp", "ftps", "file", "mailto", "tel", "sms", "data", "blob",
	"obsidian", "zotero", "notion", "slack", "discord", "teams", "ssh", "git", "svn",
	"ldap", "ldaps", "ws", "wss", "magnet", "x-devonthink-item",
]);

function isFilePath(text: string): boolean {
	// "/command args" is a command, not a path.
	if (/^\/\w+\s/.test(text)) {
		return false;
	}
	return win32PathRe.test(text) || unixPathRe.test(text);
}

function isWikilink(text: string): boolean {
	return /^\[\[.+\]\]$/.test(text.trim());
}

function isUrl(text: string): boolean {
	if (text === "") {
		return false;
	}
	if (isWikilink(text)) {
		return true;
	}

	if (URL.canParse(text)) {
		const protocol = new URL(text).protocol.slice(0, -1);
		// Windows drive letters (C:, D:) parse as a protocol.
		return /^[a-z]$/i.test(protocol) ? isFilePath(text) : URL_SCHEMES.has(protocol);
	}
	// Allows URLs without protocol, like "example.com/page".
	return isFilePath(text) || fallbackUrlRe.test(text);
}

/** Converts file paths to file URLs and escapes characters that break markdown links. */
function processUrl(src: string): string {
	let url = isFilePath(src) ? toFileUrl(src) : src;
	if (/^<.*>$/.test(url)) {
		return url;
	}
	url = url.replace(/</g, "%3C").replace(/>/g, "%3E");
	return /[() ]/.test(url) ? `<${url}>` : url;
}

/** Same as `file-url` with `resolve: false`. */
function toFileUrl(path: string): string {
	let pathName = path.replace(/\\/g, "/");
	if (!pathName.startsWith("/")) {
		pathName = `/${pathName}`; // Windows drive letters must be prefixed with a slash.
	}
	return encodeURI(`file://${pathName}`).replace(/[?#]/g, encodeURIComponent);
}
