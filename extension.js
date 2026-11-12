const path = require('node:path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

/** @type {LanguageClient | undefined} */
let client;

/**
 * Starts the Udodi language client and registers it with the extension host.
 * The client launches the bundled language server over Node.js IPC.
 *
 * @param {import('vscode').ExtensionContext} context Extension lifecycle context.
 * @returns {void}
 */
function activate(context) {
	const serverModule = context.asAbsolutePath(path.join('server', 'server.js'));
	const serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
	};
	const clientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'javascriptreact' },
			{ scheme: 'file', language: 'typescript' },
			{ scheme: 'file', language: 'typescriptreact' }
		],
		initializationOptions: { diagnostics: true }
	};
	client = new LanguageClient('udodi', 'Udodi Language Server', serverOptions, clientOptions);
	context.subscriptions.push(client.start());
}

/**
 * Stops the language client when VS Code deactivates the extension.
 *
 * @returns {Promise<void> | undefined} The stop operation, if the client started.
 */
function deactivate() {
	return client?.stop();
}

module.exports = { activate, deactivate };
