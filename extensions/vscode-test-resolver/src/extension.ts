/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { downloadAndUnzipVSCodeServer } from './download';

let startPromise: Thenable<vscode.ResolvedAuthority> | undefined = void 0;
let extHostProcess: cp.ChildProcess | undefined;
const enum CharCode {
	Backspace = 8,
	LineFeed = 10
}

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {

	function doResolve(_authority: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<vscode.ResolvedAuthority> {
		return new Promise(async (res, rej) => {
			progress.report({ message: 'Starting Test Resolver' });
			outputChannel = vscode.window.createOutputChannel('TestResolver');

			let isResolved = false;
			async function processError(message: string) {
				outputChannel.appendLine(message);
				if (!isResolved) {
					isResolved = true;
					outputChannel.show();

					const result = await vscode.window.showErrorMessage(message, { modal: true }, ...getActions());
					if (result) {
						await result.execute();
					}
					rej(vscode.RemoteAuthorityResolverError.NotAvailable(message, true));
				}
			}

			let lastProgressLine = '';
			function processOutput(output: string) {
				outputChannel.append(output);
				for (let i = 0; i < output.length; i++) {
					const chr = output.charCodeAt(i);
					if (chr === CharCode.LineFeed) {
						const match = lastProgressLine.match(/Extension host agent listening on (\d+)/);
						if (match) {
							isResolved = true;
							res(new vscode.ResolvedAuthority('localhost', parseInt(match[1], 10))); // success!
						}
						lastProgressLine = '';
					} else if (chr === CharCode.Backspace) {
						lastProgressLine = lastProgressLine.substr(0, lastProgressLine.length - 1);
					} else {
						lastProgressLine += output.charAt(i);
					}
				}
			}
			const delay = vscode.workspace.getConfiguration('testresolver').get('startupDelay');
			if (typeof delay === 'number') {
				let remaining = Math.ceil(delay);
				outputChannel.append(`Delaying startup by ${remaining} seconds (configured by "testresolver.startupDelay").`);
				while (remaining > 0) {
					progress.report({ message: `Delayed resolving: Remaining ${remaining}s` });
					await (sleep(1000));
					remaining--;
				}
			}

			if (vscode.workspace.getConfiguration('testresolver').get('startupError') === true) {
				processError('Test Resolver failed for testing purposes (configured by "testresolver.startupError").');
				return;
			}

			const { updateUrl, commit, quality, serverDataFolderName, dataFolderName } = getProductConfiguration();
			const serverCommand = process.platform === 'win32' ? 'server.bat' : 'server.sh';
			const commandArgs = ['--port=0', '--disable-telemetry'];
			const env = getNewEnv();
			const remoteDataDir = process.env['TESTRESOLVER_DATA_FOLDER'] || path.join(os.homedir(), serverDataFolderName || `${dataFolderName}-testresolver`);
			env['VSCODE_AGENT_FOLDER'] = remoteDataDir;
			outputChannel.appendLine(`Using data folder at ${remoteDataDir}`);

			if (!commit) { // dev mode
				const vscodePath = path.resolve(path.join(context.extensionPath, '..', '..'));
				const serverCommandPath = path.join(vscodePath, 'resources', 'server', 'bin-dev', serverCommand);
				extHostProcess = cp.spawn(serverCommandPath, commandArgs, { env, cwd: vscodePath, detached: true });
			} else {
				const serverBin = path.join(remoteDataDir, 'bin');
				progress.report({ message: 'Installing VSCode Server' });
				const serverLocation = await downloadAndUnzipVSCodeServer(updateUrl, commit, quality, serverBin);
				outputChannel.appendLine(`Using server build at ${serverLocation}`);

				extHostProcess = cp.spawn(path.join(serverLocation, serverCommand), commandArgs, { env, cwd: serverLocation, detached: true });
			}
			extHostProcess.stdout.on('data', (data: Buffer) => processOutput(data.toString()));
			extHostProcess.stderr.on('data', (data: Buffer) => processOutput(data.toString()));
			extHostProcess.on('error', (error: Error) => {
				processError(`server failed with error:\n${error.message}`);
				extHostProcess = undefined;
			});
			extHostProcess.on('close', (code: number) => {
				processError(`server closed unexpectedly.\nError code: ${code}`);
				extHostProcess = undefined;
			});
			context.subscriptions.push({
				dispose: () => {
					if (extHostProcess) {
						process.kill(-extHostProcess.pid);
					}
				}
			});
		});
	}

	vscode.workspace.registerRemoteAuthorityResolver('test', {
		resolve(_authority: string): Thenable<vscode.ResolvedAuthority> {
			if (!startPromise) {
				startPromise = vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: 'Open TestResolver Remote ([details](command:remote-testresolver.showLog))',
					cancellable: false
				}, (progress) => doResolve(_authority, progress));
			}
			return startPromise;
		}
	});

	vscode.commands.registerCommand('vscode-testresolver.newWindow', () => {
		return vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: 'test+test' });
	});
	vscode.commands.registerCommand('vscode-testresolver.newWindowWithError', () => {
		return vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: 'test+error' });
	});
	vscode.commands.registerCommand('vscode-testresolver.showLog', () => {
		if (outputChannel) {
			outputChannel.show();
		}
	});
}

type ActionItem = (vscode.MessageItem & { execute: () => void; });

function getActions(): ActionItem[] {
	const actions: ActionItem[] = [];
	const isDirty = vscode.workspace.textDocuments.some(d => d.isDirty) || vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme === 'untitled';

	actions.push({
		title: 'Retry',
		execute: async () => {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
	if (!isDirty) {
		actions.push({
			title: 'Close Remote',
			execute: async () => {
				await vscode.commands.executeCommand('vscode.newWindow', { reuseWindow: true });
			}
		});
	}
	actions.push({
		title: 'Ignore',
		isCloseAffordance: true,
		execute: async () => {
			vscode.commands.executeCommand('vscode-testresolver.showLog'); // no need to wait
		}
	});
	return actions;
}

export interface IProductConfiguration {
	updateUrl: string;
	commit: string;
	quality: string;
	dataFolderName: string;
	serverDataFolderName?: string;
}

function getProductConfiguration(): IProductConfiguration {
	const content = fs.readFileSync(path.join(vscode.env.appRoot, 'product.json')).toString();
	return JSON.parse(content) as IProductConfiguration;
}

function getNewEnv(): { [x: string]: string | undefined } {
	const env = { ...process.env };
	delete env['ELECTRON_RUN_AS_NODE'];
	return env;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}
