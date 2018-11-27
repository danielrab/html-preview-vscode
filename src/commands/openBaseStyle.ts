/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { Command } from '../commandManager';

export class OpenBaseStyleCommand implements Command {
	public readonly id = 'html.openBaseStyle';

	public constructor(
		private readonly context: vscode.ExtensionContext
	) { }

	public execute() {
		const resource = vscode.Uri.file(this.context.asAbsolutePath(path.join('media', 'basestyle.css')));
		return vscode.commands.executeCommand('vscode.open', resource);
	}
}