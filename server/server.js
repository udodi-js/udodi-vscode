const { createConnection, ProposedFeatures, TextDocuments, CompletionItemKind, DiagnosticSeverity, MarkupKind } = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { getCSSLanguageService } = require('vscode-css-languageservice');
const directives = require('../language/directives');
const { events, modifiers } = require('../language/events');
const { HOST_LANGUAGES, findTemplates, cursorContext, cssTemplateContext } = require('../language/context');
const stdlib = require('../language/stdlib');
const { componentForTemplate } = require('../language/components');

const EXPRESSION_DIRECTIVES = new Set(['@text', '@if', '@elseif', '@show', '@key', '@class', '@style', '@attr']);

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const cssLanguageService = getCSSLanguageService();
cssLanguageService.configure({ validate: false });
let config = { diagnostics: true };


/**
 * Declares the text synchronization, completion, and hover features supported
 * by this language server.
 *
 * @returns {import('vscode-languageserver/node').InitializeResult} LSP capabilities.
 */
function initializeServer() {
	return {
		capabilities: {
			textDocumentSync: { openClose: true, change: 1 },
			completionProvider: { triggerCharacters: ['@', '.', '|', '=', '"', ':', '-', '#', '{', ';', '('], resolveProvider: false },
			hoverProvider: true
		}
	};
}

/**
 * Loads Udodi settings after the client has initialized, retaining defaults
 * when the client does not provide configuration support.
 *
 * @returns {Promise<void>} Resolves after the settings lookup completes.
 */
async function loadConfiguration() {
	try {
		const values = await connection.workspace.getConfiguration('udodi');
		config.diagnostics = values.enableDiagnostics !== false;
	} catch { /* Keep useful defaults when the client has no configuration provider. */ }
}

connection.onInitialize(initializeServer);
connection.onInitialized(loadConfiguration);

/**
 * Gets the full word range around a source offset for hover responses.
 *
 * @param {TextDocument} document Open LSP document.
 * @param {number} offset Cursor offset in document text.
 * @returns {import('vscode-languageserver/node').Range} Start and end positions of the word.
 */
function wordRange(document, offset) {
	const text = document.getText();
	let start = offset;
	let end = offset;
	while (start > 0 && /[@\w.-]/.test(text[start - 1])) start--;
	while (end < text.length && /[\w.-]/.test(text[end])) end++;
	return { start: document.positionAt(start), end: document.positionAt(end) };
}

/**
 * Creates a CSS virtual document for a tagged-template body and translates CSS
 * language-service ranges back to positions in the host source document.
 *
 * @param {TextDocument} hostDocument Open JavaScript or TypeScript document.
 * @param {{template: {start: number}, text: string}} context CSS template context.
 * @returns {TextDocument} Virtual CSS document with offsets aligned to the template body.
 */
function createCssDocument(hostDocument, context) {
	return TextDocument.create(`${hostDocument.uri}#udodi-css`, 'css', hostDocument.version, context.text);
}

/**
 * Converts a CSS virtual-document range into a range in the host document.
 *
 * @param {TextDocument} hostDocument Open source document.
 * @param {TextDocument} cssDocument Virtual CSS document.
 * @param {{start: number}} template CSS tagged-template source range.
 * @param {import('vscode-languageserver/node').Range} range CSS language-service range.
 * @returns {import('vscode-languageserver/node').Range} Corresponding host-document range.
 */
function toHostRange(hostDocument, cssDocument, template, range) {
	return {
		start: hostDocument.positionAt(template.start + cssDocument.offsetAt(range.start)),
		end: hostDocument.positionAt(template.start + cssDocument.offsetAt(range.end))
	};
}

/**
 * Requests CSS completions and maps edit ranges from the virtual CSS document
 * into the containing JavaScript or TypeScript document.
 *
 * @param {TextDocument} hostDocument Open host document.
 * @param {{template: {start: number}, text: string, offset: number}} context CSS template context.
 * @returns {import('vscode-languageserver/node').CompletionList} CSS completion response.
 */
function completeCss(hostDocument, context) {
	const cssDocument = createCssDocument(hostDocument, context);
	const position = cssDocument.positionAt(context.offset);
	const stylesheet = cssLanguageService.parseStylesheet(cssDocument);
	const result = cssLanguageService.doComplete(cssDocument, position, stylesheet);
	for (const item of result.items) {
		if (item.textEdit?.range) item.textEdit.range = toHostRange(hostDocument, cssDocument, context.template, item.textEdit.range);
		else if (item.textEdit?.insert && item.textEdit?.replace) {
			item.textEdit.insert = toHostRange(hostDocument, cssDocument, context.template, item.textEdit.insert);
			item.textEdit.replace = toHostRange(hostDocument, cssDocument, context.template, item.textEdit.replace);
		}
		if (item.additionalTextEdits) item.additionalTextEdits = item.additionalTextEdits.map(edit => ({
			...edit,
			range: toHostRange(hostDocument, cssDocument, context.template, edit.range)
		}));
	}
	return result;
}

/**
 * Produces context-sensitive Udodi completions for a host-language document.
 *
 * @param {TextDocument} document Open JavaScript or TypeScript document.
 * @param {import('vscode-languageserver/node').Position} position LSP cursor position.
 * @returns {import('vscode-languageserver/node').CompletionList} Completion items for the current Udodi context.
 */
function completion(document, position) {
	if (!HOST_LANGUAGES.has(document.languageId)) return { isIncomplete: false, items: [] };
	const offset = document.offsetAt(position);
	const source = document.getText();
	const cssContext = cssTemplateContext(source, offset);
	if (cssContext) return completeCss(document, cssContext);
	const context = cursorContext(source, offset);
	if (!context) return { isIncomplete: false, items: [] };
	if (context.kind === 'directive') {
		const prefix = context.prefix;
		return { isIncomplete: false, items: directives.filter(d => d.name.startsWith(prefix)).map(d => ({
			label: d.name, kind: CompletionItemKind.Property, detail: 'Udodi directive', documentation: d.description,
			textEdit: { range: { start: document.positionAt(context.start), end: position }, newText: d.name }
		})) };
	}
	if (context.kind === 'value' && context.directive === '@on') {
		const tail = context.value.split(/\s+/).at(-1) || '';
		if (!tail.includes('=')) {
			const isModifier = tail.includes('.');
			const source = isModifier ? modifiers : events;
			const prefix = tail.split('.').at(-1);
			const replaceStart = offset - prefix.length;
			const range = { start: document.positionAt(replaceStart), end: position };
			return { isIncomplete: false, items: source.filter(x => x.startsWith(prefix)).map(x => ({
				label: x, kind: CompletionItemKind.EnumMember, detail: isModifier ? 'Udodi event modifier' : 'DOM event',
				textEdit: { range, newText: x }
			})) };
		}
		const binding = tail.slice(tail.lastIndexOf(' ') + 1);
		const equals = binding.indexOf('=');
		const handler = equals >= 0 ? binding.slice(equals + 1) : '';
		if (equals >= 0 && !handler.includes(':')) {
			const members = componentForTemplate(document.getText(), offset) || [];
			const range = { start: document.positionAt(offset - handler.length), end: position };
			return { isIncomplete: false, items: members.filter(member => member.kind === 'method' && member.name.startsWith(handler)).map(member => ({
				label: member.name,
				kind: CompletionItemKind.Method,
				detail: member.signature,
				documentation: 'Component event handler method.',
				textEdit: { range, newText: member.name }
			})) };
		}
	}
	if (context.kind === 'value' && EXPRESSION_DIRECTIVES.has(context.directive)) {
		const expression = context.value;
		const members = componentForTemplate(document.getText(), offset) || [];
		const pipeline = expression.match(/\|\s*([\w]*)$/);
		const head = expression.match(/^\s*([\w]*)$/);
		const match = pipeline || head;
		if (match) {
			const prefix = match[1];
			const replaceStart = offset - prefix.length;
			const range = { start: document.positionAt(replaceStart), end: position };
			const helpers = stdlib.filter(helper => helper.name.startsWith(prefix)).map(helper => ({
				label: helper.name,
				kind: CompletionItemKind.Function,
				detail: helper.signature,
				documentation: helper.description,
				textEdit: { range, newText: pipeline ? helper.name : `${helper.name}:` }
			}));
			const scoped = members.filter(member => member.name.startsWith(prefix) && (!pipeline || member.kind === 'method')).map(member => ({
				label: member.name,
			kind: member.kind === 'method' ? CompletionItemKind.Method : CompletionItemKind.Field,
				detail: member.signature,
				documentation: `Component ${member.kind}.`,
				textEdit: { range, newText: pipeline || member.kind === 'method' ? member.name : member.name + ':' }
			}));
			return { isIncomplete: false, items: [...helpers, ...scoped] };
		}
	}
	return { isIncomplete: false, items: [] };
}

/**
 * Returns documentation for Udodi directives, events, helpers, or component
 * members at the cursor.
 *
 * @param {TextDocument} document Open LSP document.
 * @param {import('vscode-languageserver/node').Position} position LSP cursor position.
 * @returns {import('vscode-languageserver/node').Hover | null} Hover contents, or null when no Udodi symbol matches.
 */
function hover(document, position) {
	const offset = document.offsetAt(position);
	const source = document.getText();
	const cssContext = cssTemplateContext(source, offset);
	if (cssContext) {
		const cssDocument = createCssDocument(document, cssContext);
		const stylesheet = cssLanguageService.parseStylesheet(cssDocument);
		const cssHover = cssLanguageService.doHover(cssDocument, cssDocument.positionAt(cssContext.offset), stylesheet);
		if (!cssHover) return null;
		return {
			...cssHover,
			range: cssHover.range ? toHostRange(document, cssDocument, cssContext.template, cssHover.range) : undefined
		};
	}
	const context = cursorContext(source, offset);
	if (!context) return null;
	const text = source;
	const range = wordRange(document, offset);
	const start = document.offsetAt(range.start);
	const end = document.offsetAt(range.end);
	const word = text.slice(start, end);
	const directive = directives.find(item => item.name === word);
	if (directive) return { range, contents: { kind: MarkupKind.Markdown, value: `**${directive.name}**  \n${directive.description}` } };
	if (context.kind === 'value' && context.directive === '@on') {
		if (modifiers.includes(word)) return { range, contents: { kind: MarkupKind.Markdown, value: `Udodi event modifier **.${word}**.` } };
		if (events.includes(word)) return { range, contents: { kind: MarkupKind.Markdown, value: `DOM event **${word}** accepted by \`@on\`.` } };
	}
	if ((context.kind === 'value' && context.directive === '@on') || (context.kind === 'value' && EXPRESSION_DIRECTIVES.has(context.directive))) {
		const member = (componentForTemplate(text, offset) || []).find(item => item.name === word);
		if (member) return { range, contents: { kind: MarkupKind.Markdown, value: `**${member.signature}**  \nComponent ${member.kind}.` } };
	}
	if (context.kind === 'value' && EXPRESSION_DIRECTIVES.has(context.directive)) {
		const helper = stdlib.find(item => item.name === word);
		if (helper) return { range, contents: { kind: MarkupKind.Markdown, value: `**${helper.signature}**  \n${helper.description}` } };
	}
	return null;
}

/**
 * Reports conservative Udodi diagnostics for a host-language document.
 *
 * @param {TextDocument} document Open LSP document.
 * @returns {import('vscode-languageserver/node').Diagnostic[]} Diagnostics for recognized template syntax.
 */
function validate(document) {
	if (!config.diagnostics || !HOST_LANGUAGES.has(document.languageId)) return [];
	const text = document.getText();
	const diagnostics = [];
	for (const template of findTemplates(text)) {
		if (template.tag !== 'html' || template.close >= text.length || text[template.close] !== '`') continue;
		const body = text.slice(template.start, template.close);
		const eventPattern = /@on\s*=\s*(["'])(.*?)\1/g;
		for (const match of body.matchAll(eventPattern)) {
			for (const binding of match[2].trim().split(/\s+/).filter(Boolean)) {
				if (!binding.includes('=')) {
					const index = template.start + match.index + match[0].indexOf(match[2]) + match[2].indexOf(binding);
					diagnostics.push({
						range: { start: document.positionAt(index), end: document.positionAt(index + binding.length) },
						severity: DiagnosticSeverity.Warning, source: 'Udodi', code: 'event-binding-equals',
						message: 'Event bindings use event[.modifier]=handler, for example click.prevent=save.'
					});
				}
			}
		}
	}
	return diagnostics;
}

/**
 * Re-publishes diagnostics whenever an open document changes.
 *
 * @param {{document: TextDocument}} event Text document change event.
 * @returns {void}
 */
function validateChangedDocument({ document }) {
	connection.sendDiagnostics({ uri: document.uri, diagnostics: validate(document) });
}

/**
 * Publishes initial diagnostics when a document is opened.
 *
 * @param {{document: TextDocument}} event Text document open event.
 * @returns {void}
 */
function validateOpenedDocument({ document }) {
	connection.sendDiagnostics({ uri: document.uri, diagnostics: validate(document) });
}

/**
 * Resolves an LSP completion request against the matching open document.
 *
 * @param {{textDocument: {uri: string}, position: import('vscode-languageserver/node').Position}} params Completion request parameters.
 * @returns {import('vscode-languageserver/node').CompletionList} Completion response.
 */
function handleCompletion({ textDocument, position }) {
	return completion(documents.get(textDocument.uri), position);
}

/**
 * Resolves an LSP hover request against the matching open document.
 *
 * @param {{textDocument: {uri: string}, position: import('vscode-languageserver/node').Position}} params Hover request parameters.
 * @returns {import('vscode-languageserver/node').Hover | null} Hover response, if available.
 */
function handleHover({ textDocument, position }) {
	return hover(documents.get(textDocument.uri), position);
}

documents.onDidChangeContent(validateChangedDocument);
documents.onDidOpen(validateOpenedDocument);
connection.onCompletion(handleCompletion);
connection.onHover(handleHover);
documents.listen(connection);
connection.listen();
