/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import opn = require('opn');
import { Command } from '../commandManager';
import { isHTMLFile } from '../util/file';

export class ShowInBrowserCommand implements Command {
    public readonly id = 'html.showInBrowser';

    public execute() {
        if (vscode.window.activeTextEditor && isHTMLFile(vscode.window.activeTextEditor.document)) {
            opn(vscode.window.activeTextEditor.document.fileName);
        }
    }
}