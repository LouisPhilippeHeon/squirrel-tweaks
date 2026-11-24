import { type OpenViewState, type Plugin, type TFile, type Workspace, WorkspaceLeaf } from "obsidian";
import type { Feature } from "./feature";

/**
 * Opening a note that is already open in a tab focuses that tab instead of
 * opening it a second time. Opening it in a new split or a new window is still allowed.
 */
export class NoDuplicateTabs implements Feature {
	private enabled = false;
	/** Leaves just created for a split or a window: their first file may be a duplicate. */
	private allowDuplicate = new WeakSet<WorkspaceLeaf>();
	/** Leaves just created as a new tab: closed if their file is redirected elsewhere. */
	private newTabs = new WeakSet<WorkspaceLeaf>();

	constructor(plugin: Plugin) {
		const workspace = plugin.app.workspace;
		const self = this;

		plugin.register(
			patch(workspace, "getLeaf", (original) =>
				function (this: Workspace, ...args: Parameters<Workspace["getLeaf"]>) {
					if (!self.enabled) {
						return original.apply(this, args);
					}
					const before = new Set<WorkspaceLeaf>();
					this.iterateAllLeaves((leaf) => {
						before.add(leaf);
					});
					const leaf = original.apply(this, args);
					if (args[0] === "split" || args[0] === "window") {
						self.allowDuplicate.add(leaf);
					} else if (!before.has(leaf)) {
						self.newTabs.add(leaf);
					}
					return leaf;
				},
			),
		);

		for (const method of ["createLeafBySplit", "openPopoutLeaf"] as const) {
			plugin.register(
				patch(workspace, method, (original) =>
					function (this: Workspace, ...args: unknown[]) {
						const leaf = (original as (...a: unknown[]) => WorkspaceLeaf).apply(this, args);
						if (self.enabled) {
							self.allowDuplicate.add(leaf);
						}
						return leaf;
					},
				),
			);
		}

		plugin.register(
			patch(WorkspaceLeaf.prototype, "openFile", (original) =>
				async function (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState) {
					const allowDuplicate = self.allowDuplicate.has(this);
					const isNewTab = self.newTabs.has(this);
					self.allowDuplicate.delete(this);
					self.newTabs.delete(this);

					const existing = self.enabled && !allowDuplicate ? findLeafWithFile(workspace, file, this) : null;
					if (!existing) {
						return original.call(this, file, openState);
					}

					if (isNewTab && this.view.getViewType() === "empty") {
						this.detach();
					}
					await workspace.revealLeaf(existing);
					workspace.setActiveLeaf(existing, { focus: true });
					if (openState?.eState) {
						existing.setEphemeralState(openState.eState);
					}
				},
			),
		);
	}

	enable() {
		this.enabled = true;
	}

	disable() {
		this.enabled = false;
	}
}

/** Another leaf of the main area or of a popout window showing `file`. */
function findLeafWithFile(workspace: Workspace, file: TFile, exclude: WorkspaceLeaf): WorkspaceLeaf | null {
	const sameWindow: WorkspaceLeaf[] = [];
	const otherWindow: WorkspaceLeaf[] = [];
	const container = exclude.getContainer();

	workspace.iterateAllLeaves((leaf) => {
		if (leaf === exclude) {
			return;
		}
		const root = leaf.getRoot();
		if (root === workspace.leftSplit || root === workspace.rightSplit) {
			return;
		}
		// The view state also works for deferred (not yet loaded) tabs.
		if (leaf.getViewState().state?.file !== file.path) {
			return;
		}
		(leaf.getContainer() === container ? sameWindow : otherWindow).push(leaf);
	});

	return sameWindow[0] ?? otherWindow[0] ?? null;
}

/**
 * Replaces `obj[method]` with the wrapper built by `wrap`. Returns a function
 * that undoes it, or, if something else wrapped the method since, turns the
 * wrapper into a pass-through so that their wrapper keeps working.
 */
function patch<T extends object, K extends keyof T>(
	obj: T,
	method: K,
	wrap: (original: T[K]) => T[K],
): () => void {
	const hadOwn = Object.prototype.hasOwnProperty.call(obj, method);
	const original = obj[method];
	let active = true;
	const wrapped = wrap(original);
	const wrapper = function (this: unknown, ...args: unknown[]) {
		const fn = (active ? wrapped : original) as (...a: unknown[]) => unknown;
		return fn.apply(this, args);
	} as T[K];
	obj[method] = wrapper;

	return () => {
		active = false;
		if (obj[method] !== wrapper) {
			return;
		}
		if (hadOwn) {
			obj[method] = original;
		} else {
			delete obj[method];
		}
	};
}
