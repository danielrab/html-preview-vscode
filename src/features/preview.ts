/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

import { Logger } from '../logger';
import { HTMLContentProvider } from './previewContentProvider';
import { disposeAll } from '../util/dispose';

import * as nls from 'vscode-nls';
import { getVisibleLine, HTMLFileTopmostLineMonitor } from '../util/topmostLineMonitor';
import { HTMLPreviewConfigurationManager } from './previewConfig';
import { isHTMLFile } from '../util/file';
import { getExtensionPath } from '../extension';
import { transformHtml } from './htmlTransformer';
const localize = nls.loadMessageBundle();

export class HTMLPreview {

	public static viewType = 'html.preview';

	private _resource: vscode.Uri;
	private _locked: boolean;

	private readonly editor: vscode.WebviewPanel;
	private throttleTimer: any;
	private line: number | undefined = undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private firstUpdate = true;
	private currentVersion?: { resource: vscode.Uri, version: number };
	private forceUpdate = false;
	private isScrolling = false;
	private _disposed: boolean = false;

	public static async revive(
		webview: vscode.WebviewPanel,
		state: any,
		contentProvider: HTMLContentProvider,
		previewConfigurations: HTMLPreviewConfigurationManager,
		logger: Logger,
		topmostLineMonitor: HTMLFileTopmostLineMonitor,
	): Promise<HTMLPreview> {
		const resource = vscode.Uri.parse(state.resource);
		const locked = state.locked;
		const line = state.line;

		const preview = new HTMLPreview(
			webview,
			resource,
			locked,
			contentProvider,
			previewConfigurations,
			logger,
			topmostLineMonitor,);

		preview.editor.webview.options = HTMLPreview.getWebviewOptions(resource);

		if (!isNaN(line)) {
			preview.line = line;
		}
		await preview.doUpdate();
		return preview;
	}

	public static create(
		resource: vscode.Uri,
		previewColumn: vscode.ViewColumn,
		locked: boolean,
		contentProvider: HTMLContentProvider,
		previewConfigurations: HTMLPreviewConfigurationManager,
		logger: Logger,
		topmostLineMonitor: HTMLFileTopmostLineMonitor,
	): HTMLPreview {
		const webview = vscode.window.createWebviewPanel(
			HTMLPreview.viewType,
			HTMLPreview.getPreviewTitle(resource, locked),
			previewColumn, {
				enableFindWidget: true,
				...HTMLPreview.getWebviewOptions(resource)
			});

		return new HTMLPreview(
			webview,
			resource,
			locked,
			contentProvider,
			previewConfigurations,
			logger,
			topmostLineMonitor,);
	}

	private constructor(
		webview: vscode.WebviewPanel,
		resource: vscode.Uri,
		locked: boolean,
		private readonly _contentProvider: HTMLContentProvider,
		private readonly _previewConfigurations: HTMLPreviewConfigurationManager,
		private readonly _logger: Logger,
		topmostLineMonitor: HTMLFileTopmostLineMonitor,
	) {
		this._resource = resource;
		this._locked = locked;
		this.editor = webview;

		this.editor.onDidDispose(() => {
			this.dispose();
		}, null, this.disposables);

		this.editor.onDidChangeViewState(e => {
			this._onDidChangeViewStateEmitter.fire(e);
		}, null, this.disposables);

		this.editor.webview.onDidReceiveMessage(e => {
			if (e.source !== this._resource.toString()) {
				return;
			}

			switch (e.type) {
				case 'command':
					vscode.commands.executeCommand(e.body.command, ...e.body.args);
					break;

				case 'revealLine':
					this.onDidScrollPreview(e.body.line);
					break;

				case 'didClick':
					this.onDidClickPreview(e.body.line);
					break;

			}
		}, null, this.disposables);

		vscode.workspace.onDidChangeTextDocument(event => {
			if (this.isPreviewOf(event.document.uri)) {
				this.refresh();
			}
		}, null, this.disposables);

		topmostLineMonitor.onDidChangeTopmostLine(event => {
			if (this.isPreviewOf(event.resource)) {
				this.updateForView(event.resource, event.line);
			}
		}, null, this.disposables);

		vscode.window.onDidChangeTextEditorSelection(event => {
			if (this.isPreviewOf(event.textEditor.document.uri)) {
				this.postMessage({
					type: 'onDidChangeTextEditorSelection',
					line: event.selections[0].active.line,
					source: this.resource.toString()
				});
			}
		}, null, this.disposables);

		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && isHTMLFile(editor.document) && !this._locked) {
				this.update(editor.document.uri);
			}
		}, null, this.disposables);
	}

	private readonly _onDisposeEmitter = new vscode.EventEmitter<void>();
	public readonly onDispose = this._onDisposeEmitter.event;

	private readonly _onDidChangeViewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
	public readonly onDidChangeViewState = this._onDidChangeViewStateEmitter.event;

	public get resource(): vscode.Uri {
		return this._resource;
	}

	public get state() {
		return {
			resource: this.resource.toString(),
			locked: this._locked,
			line: this.line
		};
	}

	public dispose() {
		if (this._disposed) {
			return;
		}

		this._disposed = true;
		this._onDisposeEmitter.fire();

		this._onDisposeEmitter.dispose();
		this._onDidChangeViewStateEmitter.dispose();
		this.editor.dispose();

		disposeAll(this.disposables);
	}

	// handle all html updates
	public update(resource: vscode.Uri) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.fsPath === resource.fsPath) {
			this.line = getVisibleLine(editor);
		}

		// If we have changed resources, cancel any pending updates
		const isResourceChange = resource.fsPath !== this._resource.fsPath;
		if (isResourceChange) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}

		this._resource = resource;

		// Schedule update if none is pending
		if (!this.throttleTimer) {
			if (isResourceChange || this.firstUpdate) {
				this.doUpdate();
			} else {
				this.throttleTimer = setTimeout(() => this.doUpdate(), 300);
			}
		}

		this.firstUpdate = false;
	}

	public refresh() {
		this.forceUpdate = true;
		this.update(this._resource);
	}

	public updateConfiguration() {
		if (this._previewConfigurations.hasConfigurationChanged(this._resource)) {
			this.refresh();
		}
	}

	public get position(): vscode.ViewColumn | undefined {
		return this.editor.viewColumn;
	}

	public matchesResource(
		otherResource: vscode.Uri,
		otherPosition: vscode.ViewColumn | undefined,
		otherLocked: boolean
	): boolean {
		if (this.position !== otherPosition) {
			return false;
		}

		if (this._locked) {
			return otherLocked && this.isPreviewOf(otherResource);
		} else {
			return !otherLocked;
		}
	}

	public matches(otherPreview: HTMLPreview): boolean {
		return this.matchesResource(otherPreview._resource, otherPreview.position, otherPreview._locked);
	}

	public reveal(viewColumn: vscode.ViewColumn) {
		this.editor.reveal(viewColumn);
	}

	public toggleLock() {
		this._locked = !this._locked;
		this.editor.title = HTMLPreview.getPreviewTitle(this._resource, this._locked);
	}

	private get iconPath() {
		const root = path.join(getExtensionPath(), 'media');
		return {
			light: vscode.Uri.file(path.join(root, 'Preview.svg')),
			dark: vscode.Uri.file(path.join(root, 'Preview_inverse.svg'))
		};
	}

	private isPreviewOf(resource: vscode.Uri): boolean {
		return this._resource.fsPath === resource.fsPath;
	}

	private static getPreviewTitle(resource: vscode.Uri, locked: boolean): string {
		return locked
			? localize('lockedPreviewTitle', '[Preview] {0}', path.basename(resource.fsPath))
			: localize('previewTitle', 'Preview {0}', path.basename(resource.fsPath));
	}

	private updateForView(resource: vscode.Uri, topLine: number | undefined) {
		if (!this.isPreviewOf(resource)) {
			return;
		}

		if (this.isScrolling) {
			this.isScrolling = false;
			return;
		}

		if (typeof topLine === 'number') {
			this._logger.log('updateForView', { htmlFile: resource });
			this.line = topLine;
			this.postMessage({
				type: 'updateView',
				line: topLine,
				source: resource.toString()
			});
		}
	}

	private postMessage(msg: any) {
		if (!this._disposed) {
			this.editor.webview.postMessage(msg);
		}
	}

	private async doUpdate(): Promise<void> {
		const resource = this._resource;

		clearTimeout(this.throttleTimer);
		this.throttleTimer = undefined;

		const document = await vscode.workspace.openTextDocument(resource);
		if (!this.forceUpdate && this.currentVersion && this.currentVersion.resource.fsPath === resource.fsPath && this.currentVersion.version === document.version) {
			if (this.line) {
				this.updateForView(resource, this.line);
			}
			return;
		}
		this.forceUpdate = false;

		this.currentVersion = { resource, version: document.version };
		const content: string = this._contentProvider.provideTextDocumentContent(document, this._previewConfigurations, this.line, this.state);
		if (this._resource === resource) {
			this.editor.title = HTMLPreview.getPreviewTitle(this._resource, this._locked);
			this.editor.iconPath = this.iconPath;
			this.editor.webview.options = HTMLPreview.getWebviewOptions(resource);
			this.editor.webview.html = content;
		}
	}

	private static getWebviewOptions(
		resource: vscode.Uri,
	): vscode.WebviewOptions {
		return {
			enableScripts: true,
			enableCommandUris: true,
			localResourceRoots: HTMLPreview.getLocalResourceRoots(resource)
		};
	}

	private static getLocalResourceRoots(
		resource: vscode.Uri,
	): vscode.Uri[] {
		const baseRoots: vscode.Uri[] = [vscode.Uri.file(getExtensionPath() + "/media")];

		const folder = vscode.workspace.getWorkspaceFolder(resource);
		if (folder) {
			return baseRoots.concat(folder.uri);
		}

		if (!resource.scheme || resource.scheme === 'file') {
			return baseRoots.concat(vscode.Uri.file(path.dirname(resource.fsPath)));
		}

		return baseRoots;
	}

	private onDidScrollPreview(line: number) {
		this.line = line;
		for (const editor of vscode.window.visibleTextEditors) {
			if (!this.isPreviewOf(editor.document.uri)) {
				continue;
			}

			this.isScrolling = true;
			const sourceLine = Math.floor(line);
			const fraction = line - sourceLine;
			const text = editor.document.lineAt(sourceLine).text;
			const start = Math.floor(fraction * text.length);
			editor.revealRange(
				new vscode.Range(sourceLine, start, sourceLine + 1, 0),
				vscode.TextEditorRevealType.AtTop);
		}
	}

	private async onDidClickPreview(line: number): Promise<void> {
		for (const visibleEditor of vscode.window.visibleTextEditors) {
			if (this.isPreviewOf(visibleEditor.document.uri)) {
				const editor = await vscode.window.showTextDocument(visibleEditor.document, visibleEditor.viewColumn);
				const position = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(position, position);
				return;
			}
		}

		vscode.workspace.openTextDocument(this._resource).then(vscode.window.showTextDocument);
	}
}

export interface PreviewSettings {
	readonly resourceColumn: vscode.ViewColumn;
	readonly previewColumn: vscode.ViewColumn;
	readonly locked: boolean;
}
