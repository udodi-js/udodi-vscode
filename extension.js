const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

/** @type {LanguageClient | undefined} */
let client;

const documentSelector = [
	{ scheme: 'file', language: 'javascript' },
	{ scheme: 'file', language: 'javascriptreact' },
	{ scheme: 'file', language: 'typescript' },
	{ scheme: 'file', language: 'typescriptreact' }
];

/**
 * Starts the Udodi language client and registers it with the extension host.
 * The client launches the bundled language server over Node.js IPC.
 *
 * A dedicated RenameProvider is also registered so Udodi-aware renames
 * (component members and @for variables, including template references) take
 * effect even when the built-in JavaScript/TypeScript rename provider is active
 * on the same document.
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
		documentSelector,
		initializationOptions: { diagnostics: true }
	};

	client = new LanguageClient('udodi', 'Udodi Language Server', serverOptions, clientOptions);

	// LanguageClient is disposable in vscode-languageclient v9+.
	context.subscriptions.push(client);
	client.start();

	// Prefer Udodi rename when the server can resolve the symbol (template
	// references and createComponent member declarations). Returning null
	// defers to the built-in JS/TS rename provider for ordinary code.
	context.subscriptions.push(
		vscode.languages.registerRenameProvider(documentSelector, {
			async prepareRename(document, position, token) {
				if (!client?.isRunning()) return null;

				try {
					const result = await client.sendRequest(
						'textDocument/prepareRename',
						{
							textDocument: { uri: document.uri.toString() },
							position: { line: position.line, character: position.character }
						},
						token
					);

					if (!result) return null;

					// Normalize { range, placeholder } | Range
					if (result.range) return { range: result.range, placeholder: result.placeholder };

					return result;

				} catch {
					return null;
				}
			},
			
			async provideRenameEdits(document, position, newName, token) {
				if (!client?.isRunning()) return null;

				try {
					const result = await client.sendRequest(
						'textDocument/rename',
						{
							textDocument: { uri: document.uri.toString() },
							position: { line: position.line, character: position.character },
							newName
						},
						token
					);

					return result || null;

				} catch {
					return null;
				}
			}
		})
	);
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
