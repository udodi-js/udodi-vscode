const { createConnection, ProposedFeatures, TextDocuments, CompletionItemKind, DiagnosticSeverity, MarkupKind } = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { getCSSLanguageService } = require('vscode-css-languageservice');
const directives = require('../language/directives');
const { events, modifiers } = require('../language/events');
const { HOST_LANGUAGES, findTemplates, cursorContext, forScopesAt, parseForAttribute, cssTemplateContext } = require('../language/context');
const stdlib = require('../language/stdlib');
const { componentForTemplate, componentDeclarations, componentDefinitions, arrayItemForExpression } = require('../language/components');
const { checkExpression, checkEventHandler } = require('../language/type-checker');

const EXPRESSION_DIRECTIVES = new Set(['@text', '@if', '@elseif', '@show', '@key', '@class', '@style', '@attr']);
const HOVER_EXPRESSION_DIRECTIVES = new Set([...EXPRESSION_DIRECTIVES, '@bind', '@submit', '@validate']);
const RESERVED_COMPONENT_KEYS = new Set([
	'name', 'state', 'computed', 'interceptors', 'methods', 'watch', 'template',
	'onMount', 'onUnmount', 'refs', 'style', 'ud'
]);

/**
 * Resolves a dotted path in the statically inferred component member tree.
 *
 * @param {Array<object>} members Inferred root component members.
 * @param {string[]} path Property path segments.
 * @returns {Array<object>} Child members at the end of the path.
 */
function nestedMembers(members, path) {
	let current = members;

	for (const segment of path) {
		const parent = current.find(member => member.name === segment);
		if (!parent) return [];

		current = parent.children || [];
	}

	return current;
}

/**
 * Resolves a dotted member name in the inferred component state tree.
 *
 * @param {Array<object>} members Inferred root component members.
 * @param {string[]} path Property path segments.
 * @returns {object | undefined} Matching component member.
 */
function nestedMember(members, path) {
	let current = members;
	let member;

	for (const segment of path) {
		member = current.find(item => item.name === segment);
		if (!member) return undefined;
		
		current = member.children || [];
	}

	return member;
}

/**
 * Adds lexical variables introduced by enclosing `@for` directives to the
 * component members available at a template position.
 *
 * @param {string} source Host document text.
 * @param {number} offset Cursor offset.
 * @returns {Array<object>} Component and active loop-scope members.
 */
function membersAt(source, offset) {
	const members = componentForTemplate(source, offset) || [];
	for (const loop of forScopesAt(source, offset)) {
		const element = arrayItemForExpression(members, loop.expression) || { type: 'unknown', children: [] };
		
		members.push({
			name: loop.item, kind: 'loop-item', type: element.type, children: element.children || [], shapeKnown: element.shapeKnown === true,
			signature: `${loop.item}: ${element.type}`
		});

		if (loop.index) members.push({
			name: loop.index, kind: 'loop-index', type: 'number', children: [],
			signature: `${loop.index}: number`
		});
	}

	const visible = new Map();
	for (const member of members) visible.set(member.name, member);
	
	return [...visible.values()];
}

/**
 * Completes a statically recognizable source expression in an `@for` value.
 * Array sources and functions known to return arrays sort before other paths.
 *
 * @param {TextDocument} document Open source document.
 * @param {import('../language/context').cursorContext} context Template cursor context.
 * @param {import('vscode-languageserver/node').Position} position Cursor position.
 * @param {number} offset Cursor offset.
 * @returns {import('vscode-languageserver/node').CompletionList} Loop source completions.
 */
function completeForSource(document, context, position, offset) {
	const tokens = [...context.value.matchAll(/\S+/g)];
	const trailingSpace = /\s$/.test(context.value);

	if (!tokens.length || (tokens.length === 1 && !trailingSpace)) return { isIncomplete: false, items: [] };
	
	const token = trailingSpace ? '' : tokens.at(-1)[0];
	if (/[:|=>]/.test(token)) {
		return completeExpression(document, token, offset - token.length, position, membersAt(document.getText(), offset));
	}
	
	const dot = token.lastIndexOf('.');
	let prefix = token;
	let candidates = membersAt(document.getText(), offset);

	if (dot >= 0) {
		const parentPath = token.slice(0, dot).split('.');
		prefix = token.slice(dot + 1);
		candidates = nestedMembers(candidates, parentPath);

	} else {
		const separator = Math.max(token.lastIndexOf(':'), token.lastIndexOf('|'));
		if (separator >= 0) prefix = token.slice(separator + 1);
	}

	const range = { start: document.positionAt(offset - prefix.length), end: position };
	const memberItems = candidates.filter(member => member.name.startsWith(prefix)).map(member => ({
		label: member.name,
		kind: member.kind === 'method' ? CompletionItemKind.Method : CompletionItemKind.Field,
		detail: member.signature,
		documentation: member.returnType === 'array' || member.type === 'array' ? 'Array source for an Udodi @for loop.' : 'Component expression that may produce an array.',
		sortText: arrayItemForExpression(candidates, member.name) ? `0-${member.name}` : `1-${member.name}`,
		textEdit: { range, newText: member.kind === 'method' && member.params ? `${member.name}:` : member.name }
	}));
	const helperItems = dot < 0 ? stdlib.filter(helper => helper.name.startsWith(prefix)).map(helper => ({
		label: helper.name,
		kind: CompletionItemKind.Function,
		detail: helper.signature,
		documentation: helper.description,
		sortText: `2-${helper.name}`,
		textEdit: { range, newText: `${helper.name}:` }
	})) : [];
	
	return { isIncomplete: false, items: [...memberItems, ...helperItems] };
}

/**
 * Completes a Udodi expression path or call argument at the cursor.
 *
 * @param {TextDocument} document Open source document.
 * @param {string} expression Expression text from its value start to the cursor.
 * @param {number} expressionStart Absolute start offset for the expression.
 * @param {import('vscode-languageserver/node').Position} position Cursor position.
 * @param {Array<object>} members Visible component and loop members.
 * @returns {import('vscode-languageserver/node').CompletionList} Expression completion results.
 */
function completeExpression(document, expression, expressionStart, position, members) {
	const separators = [expression.lastIndexOf(':'), expression.lastIndexOf('|'), expression.lastIndexOf('=>')];
	const separator = Math.max(...separators);
	const separatorLength = expression.slice(separator, separator + 2) === '=>' ? 2 : 1;
	const fragmentStart = separator < 0 ? 0 : separator + separatorLength;
	let fragment = expression.slice(fragmentStart);
	const leadingSpace = fragment.match(/^\s*/)?.[0].length || 0;

	fragment = fragment.slice(leadingSpace);

	const dot = fragment.lastIndexOf('.');
	let prefix = fragment;
	let candidates = members;

	if (dot >= 0) {
		candidates = nestedMembers(members, fragment.slice(0, dot).split('.'));
		prefix = fragment.slice(dot + 1);
	}

	const range = {
		start: document.positionAt(expressionStart + fragmentStart + leadingSpace + (dot >= 0 ? dot + 1 : 0)),
		end: position
	};
	const isPipeline = expression.slice(0, separator + 1).includes('|');
	const memberItems = candidates.filter(member => member.name.startsWith(prefix)).map(member => ({
		label: member.name,
		kind: member.kind === 'method' ? CompletionItemKind.Method : CompletionItemKind.Field,
		detail: member.signature,
		documentation: `Component ${member.kind}.`,
		textEdit: { range, newText: member.name }
	}));
	const helperItems = dot < 0 ? stdlib.filter(helper => helper.name.startsWith(prefix)).map(helper => ({
		label: helper.name,
		kind: CompletionItemKind.Function,
		detail: helper.signature,
		documentation: helper.description,
		textEdit: { range, newText: isPipeline ? helper.name : `${helper.name}:` }
	})) : [];

	return { isIncomplete: false, items: [...memberItems, ...helperItems] };
}

/**
 * Reads the complete quoted value for the attribute under the cursor.
 *
 * @param {string} source Host document text.
 * @param {{valueStart: number, value: string}} context Attribute cursor context.
 * @returns {{value: string, start: number}} Full attribute value and its source offset.
 */
function fullAttributeValue(source, context) {
	const quote = source[context.valueStart - 1];
	const close = quote === '"' || quote === "'" ? source.indexOf(quote, context.valueStart) : -1;
	
	return { value: close < 0 ? context.value : source.slice(context.valueStart, close), start: context.valueStart };
}

/**
 * Returns hover documentation for a Udodi string, number, or boolean literal.
 * Literal forms and number restrictions follow the Udodi core lexer.
 *
 * @param {TextDocument} document Open source document.
 * @param {string} value Full directive value.
 * @param {number} valueStart Absolute start offset of the value.
 * @param {number} offset Hover offset.
 * @returns {import('vscode-languageserver/node').Hover | null} Literal hover, if the cursor is on a literal.
 */
function literalHover(document, value, valueStart, offset) {
	const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<![\w$])-?\d+(?:\.\d+)?(?![\w$])|\b(?:true|false)\b/g;
	
	for (const match of value.matchAll(literalPattern)) {
		const start = valueStart + match.index;
		const end = start + match[0].length;

		if (offset < start || offset >= end) continue;

		let title;
		let description;

		if (match[0][0] === '"' || match[0][0] === "'") {
			title = 'String literal';
			description = 'A quoted text value evaluated as a string.';

		} else if (match[0] === 'true' || match[0] === 'false') {
			title = 'Boolean literal';
			description = 'A boolean value: `true` or `false`.';

		} else {
			title = 'Number literal';
			description = 'A numeric value. Udodi supports integers and decimals with digits on both sides of the decimal point.';
		}

		return {
			range: { start: document.positionAt(start), end: document.positionAt(end) },
			contents: { kind: MarkupKind.Markdown, value: `**${title}**  \n${description}` }
		};
	}

	return null;
}

/**
 * Splits whitespace-separated directive expressions without splitting quoted
 * strings or nested call arguments.
 *
 * @param {string} value Directive value.
 * @returns {Array<{text: string, start: number}>} Expression segments and offsets.
 */
function splitDirectiveExpressions(value) {
	const expressions = [];
	let start = -1;
	let quote = '';
	let depth = 0;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];

		if (quote) {
			if (char === '\\') i++;
			else if (char === quote) quote = '';
			continue;
		}

		if (char === '"' || char === "'") { quote = char; if (start < 0) start = i; continue; }
		if ('([{'.includes(char)) { depth++; if (start < 0) start = i; continue; }
		if (')]}'.includes(char)) { depth = Math.max(0, depth - 1); continue; }
		if (/\s/.test(char) && depth === 0) {
			if (start >= 0) expressions.push({ text: value.slice(start, i), start });
			start = -1;
		} else if (start < 0) start = i;
	}

	if (start >= 0) expressions.push({ text: value.slice(start), start });
	
	return expressions;
}

const EVENT_DESCRIPTIONS = {
	click: 'Fires when the user activates the element.',
	dblclick: 'Fires when the user double-clicks the element.',
	input: 'Fires when the value of a form control changes.',
	change: 'Fires when a form control value is committed.',
	submit: 'Fires when a form is submitted.',
	reset: 'Fires when a form is reset.',
	focus: 'Fires when the element receives focus.',
	blur: 'Fires when the element loses focus.',
	keydown: 'Fires when a keyboard key is pressed.',
	keyup: 'Fires when a keyboard key is released.',
	keypress: 'Fires when a key that produces a character is pressed.',
	mouseover: 'Fires when the pointer enters the element or one of its descendants.',
	mouseout: 'Fires when the pointer leaves the element or one of its descendants.',
	mouseenter: 'Fires when the pointer enters the element.',
	mouseleave: 'Fires when the pointer leaves the element.',
	pointerdown: 'Fires when a pointer becomes active.',
	pointerup: 'Fires when an active pointer is released.',
	touchstart: 'Fires when a touch point contacts the screen.',
	touchend: 'Fires when a touch point is removed from the screen.'
};

const MODIFIER_DESCRIPTIONS = {
	prevent: 'Prevents the browser’s default action for this event.',
	stop: 'Stops this event from bubbling to parent elements.',
	self: 'Runs the handler only when the event target is this element.',
	enter: 'Runs the handler only when Enter is pressed.',
	esc: 'Runs the handler only when Escape is pressed.',
	space: 'Runs the handler only when Space is pressed.',
	tab: 'Runs the handler only when Tab is pressed.',
	passive: 'Uses a passive listener. The handler cannot prevent the default action.',
	nonpassive: 'Uses a non-passive listener, allowing the handler to prevent the default action.',
	once: 'Runs the handler once, then removes the listener.'
};

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
			completionProvider: { triggerCharacters: ['@', '.', '|', '=', '"', ':', '-', '#', '{', ';', '(', ' '], resolveProvider: false },
			hoverProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			// Rename is advertised from the client (extension.js) so it can take
			// precedence over the built-in JS/TS rename provider on the same document.
			// Handlers remain registered below for textDocument/prepareRename and rename.
			renameProvider: { prepareProvider: true }
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
 * Gets the identifier or directive range around a source offset for hover responses.
 * Path segments such as `user` and `name` in `user.name` are treated as separate
 * words so each segment can report its own type and range.
 *
 * @param {TextDocument} document Open LSP document.
 * @param {number} offset Cursor offset in document text.
 * @returns {import('vscode-languageserver/node').Range} Start and end positions of the word.
 */
function wordRange(document, offset) {
	const text = document.getText();
	let start = offset;
	let end = offset;

	while (start > 0 && /[@\w$]/.test(text[start - 1])) start--;

	while (end < text.length && /[\w$]/.test(text[end])) end++;

	return { start: document.positionAt(start), end: document.positionAt(end) };
}

/**
 * Locates the dotted path under the cursor and the specific segment being hovered.
 *
 * @param {string} value Attribute or expression text.
 * @param {number} relativeOffset Offset relative to the start of `value`.
 * @returns {{path: string[], segmentIndex: number, segmentStart: number, segmentEnd: number} | undefined}
 */
function pathSegmentAt(value, relativeOffset) {
	for (const match of value.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
		const pathStart = match.index;
		const pathEnd = pathStart + match[0].length;
		if (relativeOffset < pathStart || relativeOffset > pathEnd) continue;

		const segments = match[0].split('.');
		let cursor = pathStart;

		for (let i = 0; i < segments.length; i++) {
			const segmentEnd = cursor + segments[i].length;
			if (relativeOffset >= cursor && relativeOffset <= segmentEnd) {
				return {
					path: segments,
					segmentIndex: i,
					segmentStart: cursor,
					segmentEnd
				};
			}
			cursor = segmentEnd + 1;
		}
	}

	return undefined;
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

		if (equals >= 0) {
			const expressionOffset = context.value.lastIndexOf('=') + 1;
			const members = membersAt(document.getText(), offset);

			if (/[:|=>.]/.test(handler)) {
				return completeExpression(document, handler, context.valueStart + expressionOffset, position, members);
			}

			const range = { start: document.positionAt(offset - handler.length), end: position };
			
			return { isIncomplete: false, items: members.filter(member => member.kind === 'method' && member.name.startsWith(handler)).map(member => ({
				label: member.name, kind: CompletionItemKind.Method, detail: member.signature,
				documentation: 'Component event handler method.', textEdit: { range, newText: member.name }
			})) };
		}
	}

	if (context.kind === 'value' && context.directive === '@for') {
		return completeForSource(document, context, position, offset);
	}

	if (context.kind === 'value' && EXPRESSION_DIRECTIVES.has(context.directive)) {
		return completeExpression(document, context.value, context.valueStart, position, membersAt(document.getText(), offset));
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
		const { value, start: valueStart } = fullAttributeValue(text, context);

		for (const token of value.matchAll(/\S+/g)) {
			const tokenStart = valueStart + token.index;
			const tokenEnd = tokenStart + token[0].length;

			if (offset < tokenStart || offset > tokenEnd) continue;

			const equals = token[0].indexOf('=');
			const eventPart = token[0].slice(0, equals < 0 ? token[0].length : equals);
			const pieces = eventPart.split('.');
			let segmentStart = tokenStart;

			for (let i = 0; i < pieces.length; i++) {
				const segmentEnd = segmentStart + pieces[i].length;

				if (offset >= segmentStart && offset <= segmentEnd) {
					const eventRange = { start: document.positionAt(segmentStart), end: document.positionAt(segmentEnd) };
					
					if (i === 0 && events.includes(pieces[i])) {
						const description = EVENT_DESCRIPTIONS[pieces[i]] || 'DOM event accepted by the Udodi `@on` directive.';
						return { range: eventRange, contents: { kind: MarkupKind.Markdown, value: `**${pieces[i]}**  \n${description}` } };
					}

					if (i > 0 && modifiers.includes(pieces[i])) {
						return { range: eventRange, contents: { kind: MarkupKind.Markdown, value: `**.${pieces[i]}** event modifier  \n${MODIFIER_DESCRIPTIONS[pieces[i]]}` } };
					}
				}

				segmentStart = segmentEnd + 1;
			}
		}
	}

	if (context.kind === 'value' && context.directive === '@for') {
		const { value: fullValue, start: fullValueStart } = fullAttributeValue(text, context);
		const declaration = parseForAttribute(fullValue);
		const tokens = [...fullValue.matchAll(/\S+/g)];
		const itemToken = declaration ? tokens[0] : undefined;
		const indexToken = declaration?.index ? tokens[1] : undefined;
		
		if (itemToken && offset >= fullValueStart + itemToken.index && offset < fullValueStart + itemToken.index + itemToken[0].length) {
			const item = arrayItemForExpression(componentForTemplate(text, fullValueStart) || [], declaration.expression) || { type: 'unknown' };
			const tokenRange = { start: document.positionAt(fullValueStart + itemToken.index), end: document.positionAt(fullValueStart + itemToken.index + itemToken[0].length) };
			
			return { range: tokenRange, contents: { kind: MarkupKind.Markdown, value: `**${declaration.item}: ${item.type}**  \nThe current item from \`${declaration.expression}\`.` } };
		}
		
		if (indexToken && offset >= fullValueStart + indexToken.index && offset < fullValueStart + indexToken.index + indexToken[0].length) {
			const tokenRange = { start: document.positionAt(fullValueStart + indexToken.index), end: document.positionAt(fullValueStart + indexToken.index + indexToken[0].length) };
			return { range: tokenRange, contents: { kind: MarkupKind.Markdown, value: `**${declaration.index}: number**  \nZero-based position of the current item.` } };
		}
	}

	if (context.kind === 'value' && (['@on', '@for'].includes(context.directive) || HOVER_EXPRESSION_DIRECTIVES.has(context.directive))) {
		const { value: fullValue, start: valueStart } = fullAttributeValue(text, context);
		const literal = literalHover(document, fullValue, valueStart, offset);
		
		if (literal) return literal;
	}

	if ((context.kind === 'value' && ['@on', '@for'].includes(context.directive)) || (context.kind === 'value' && HOVER_EXPRESSION_DIRECTIVES.has(context.directive))) {
		const members = membersAt(text, offset);
		const { value: fullValue, start: valueStart } = fullAttributeValue(text, context);
		const relativeOffset = offset - valueStart;
		const segment = pathSegmentAt(fullValue, relativeOffset);

		if (segment) {
			const pathUpTo = segment.path.slice(0, segment.segmentIndex + 1);
			const member = pathUpTo.length > 1
				? nestedMember(members, pathUpTo)
				: members.find(item => item.name === pathUpTo[0]);

			if (member) {
				const segmentRange = {
					start: document.positionAt(valueStart + segment.segmentStart),
					end: document.positionAt(valueStart + segment.segmentEnd)
				};
				const result = member.returnType ? ` Returns \`${member.returnType}\`.` : '';
				const kindLabel = member.kind === 'loop-item' || member.kind === 'loop-index'
					? member.kind
					: `Component ${member.kind}`;
				return {
					range: segmentRange,
					contents: {
						kind: MarkupKind.Markdown,
						value: `**${member.signature}**  \n${kindLabel}.${result}`
					}
				};
			}
		}

		// Fallback for non-path tokens (e.g. bare identifiers still covered by wordRange).
		const member = members.find(item => item.name === word);
		if (member) {
			const result = member.returnType ? ` Returns \`${member.returnType}\`.` : '';
			return {
				range,
				contents: {
					kind: MarkupKind.Markdown,
					value: `**${member.signature}**  \nComponent ${member.kind}.${result}`
				}
			};
		}
	}

	if (context.kind === 'value' && EXPRESSION_DIRECTIVES.has(context.directive)) {
		const helper = stdlib.find(item => item.name === word);
		const valuePrefix = text.slice(context.valueStart, start);

		if (helper && !/[\w$]+\.$/.test(valuePrefix)) {
			return {
				range,
				contents: {
					kind: MarkupKind.Markdown,
					value: `**${helper.signature}**  \n${helper.description}`
				}
			};
		}
	}

	return null;
}

/**
 * Builds an LSP LocationLink so Peek Definition can highlight both the origin
 * identifier and the target declaration.
 *
 * @param {TextDocument} document Open document.
 * @param {number} originStart Absolute origin start offset.
 * @param {number} originEnd Absolute origin end offset.
 * @param {number} targetStart Absolute target start offset.
 * @param {number} targetEnd Absolute target end offset.
 * @param {number} [contextStart] Optional wider target context start.
 * @param {number} [contextEnd] Optional wider target context end.
 * @returns {import('vscode-languageserver/node').LocationLink}
 */
function locationLink(document, originStart, originEnd, targetStart, targetEnd, contextStart = targetStart, contextEnd = targetEnd) {
	return {
		originSelectionRange: {
			start: document.positionAt(originStart),
			end: document.positionAt(originEnd)
		},
		targetUri: document.uri,
		targetRange: {
			start: document.positionAt(contextStart),
			end: document.positionAt(contextEnd)
		},
		targetSelectionRange: {
			start: document.positionAt(targetStart),
			end: document.positionAt(targetEnd)
		}
	};
}

/**
 * Finds the static component declaration targeted by an identifier in an
 * Udodi template expression. Returns a LocationLink so Peek Definition shows
 * the declaration with the origin segment highlighted.
 *
 * @param {TextDocument} document Open JavaScript or TypeScript document.
 * @param {import('vscode-languageserver/node').Position} position LSP cursor position.
 * @returns {import('vscode-languageserver/node').LocationLink | null} Definition link, when statically resolvable.
 */
function definition(document, position) {
	const source = document.getText();
	const offset = document.offsetAt(position);
	const context = cursorContext(source, offset);

	if (context?.kind !== 'value') return null;

	const { value, start: valueStart } = fullAttributeValue(source, context);
	const relativeOffset = offset - valueStart;
	const literalRanges = [...value.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)];

	if (literalRanges.some(item => relativeOffset >= item.index && relativeOffset < item.index + item[0].length)) return null;

	const declaration = context.directive === '@for' ? parseForAttribute(value) : undefined;
	if (declaration) {
		const tokens = [...value.matchAll(/\S+/g)];

		for (const [name, tokenIndex] of [[declaration.item, 0], [declaration.index, 1]]) {
			const token = tokens[tokenIndex];

			if (name && token && relativeOffset >= token.index && relativeOffset < token.index + token[0].length) {
				const start = valueStart + token.index;
				const end = start + name.length;
				// Declaration site of the loop variable — peek shows the variable itself.
				return locationLink(document, start, end, start, end);
			}
		}
	}

	if (context.directive === '@on') {
		const bindingStart = value.lastIndexOf('=', relativeOffset);
		if (bindingStart < 0) return null;
	}

	const segment = pathSegmentAt(value, relativeOffset);
	if (!segment) return null;

	const reference = segment.path;
	const pathToSegment = reference.slice(0, segment.segmentIndex + 1);
	const originStart = valueStart + segment.segmentStart;
	const originEnd = valueStart + segment.segmentEnd;

	const activeLoops = forScopesAt(source, offset);
	const loop = [...activeLoops].reverse().find(item => item.item === reference[0] || item.index === reference[0]);
	let targetPath = pathToSegment;

	if (loop) {
		const onRoot = segment.segmentIndex === 0;

		if (loop.index === reference[0] && onRoot) {
			return locationLink(document, originStart, originEnd, loop.indexStart, loop.indexStart + loop.index.length);
		}

		if (loop.item === reference[0] && onRoot) {
			return locationLink(document, originStart, originEnd, loop.itemStart, loop.itemStart + loop.item.length);
		}

		if (loop.item === reference[0]) {
			const sourcePath = loop.expression.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/)?.[1];
			if (!sourcePath) return null;

			targetPath = [...sourcePath.split('.'), ...pathToSegment.slice(1)];
		}
	}

	const target = componentDefinitions(source)
		.filter(item => item.path.join('.') === targetPath.join('.') && offset > item.componentStart && offset < item.componentEnd)
		.sort((left, right) => right.componentStart - left.componentStart)[0];

	if (!target) return null;

	// Peek shows the full property entry (multi-line object/method body when present).
	// targetSelectionRange stays on the identifier; targetRange spans the whole entry.
	const contextStart = target.entryStart != null ? target.entryStart : target.start;
	const contextEnd = target.entryEnd != null ? target.entryEnd : target.end;

	return locationLink(document, originStart, originEnd, target.start, target.end, contextStart, contextEnd);
}

/**
 * Resolves the rename target for a symbol under the cursor.
 * Supports root-level component members (state/computed/methods) and @for loop variables.
 * Nested property segments (the `name` in `user.name`) are not renamable as a unit.
 *
 * @param {TextDocument} document Open document.
 * @param {import('vscode-languageserver/node').Position} position Cursor position.
 * @returns {{range: import('vscode-languageserver/node').Range, path: string[], componentStart: number, componentEnd: number, name: string, isLoop: boolean, loopKind?: 'item' | 'index'} | null}
 */
function renameTarget(document, position) {
	const source = document.getText();
	const offset = document.offsetAt(position);
	const context = cursorContext(source, offset);
	const defs = componentDefinitions(source);

	// Declaration site inside createComponent({ state/computed/methods }).
	// Only root-level members (path length 1) so template root references stay in sync.
	for (const def of defs) {
		if (offset >= def.start && offset <= def.end && def.path.length === 1) {
			return {
				range: { start: document.positionAt(def.start), end: document.positionAt(def.end) },
				path: def.path,
				componentStart: def.componentStart,
				componentEnd: def.componentEnd,
				name: def.name,
				isLoop: false
			};
		}
	}

	if (context?.kind !== 'value') return null;

	const { value, start: valueStart } = fullAttributeValue(source, context);
	const relativeOffset = offset - valueStart;

	// @for item / index declaration tokens.
	if (context.directive === '@for') {
		const declaration = parseForAttribute(value);
		if (declaration) {
			const tokens = [...value.matchAll(/\S+/g)];
			const itemToken = tokens[0];
			const indexToken = declaration.index ? tokens[1] : undefined;

			if (itemToken && relativeOffset >= itemToken.index && relativeOffset < itemToken.index + itemToken[0].length) {
				const start = valueStart + itemToken.index;
				return {
					range: { start: document.positionAt(start), end: document.positionAt(start + declaration.item.length) },
					path: [declaration.item],
					componentStart: 0,
					componentEnd: source.length,
					name: declaration.item,
					isLoop: true,
					loopKind: 'item'
				};
			}

			if (indexToken && relativeOffset >= indexToken.index && relativeOffset < indexToken.index + indexToken[0].length) {
				const start = valueStart + indexToken.index;
				return {
					range: { start: document.positionAt(start), end: document.positionAt(start + declaration.index.length) },
					path: [declaration.index],
					componentStart: 0,
					componentEnd: source.length,
					name: declaration.index,
					isLoop: true,
					loopKind: 'index'
				};
			}
		}
	}

	// For @on, only the handler after "=" is a renamable component symbol.
	if (context.directive === '@on') {
		const equals = value.lastIndexOf('=', relativeOffset);
		if (equals < 0 || relativeOffset < equals) return null;
	}

	const segment = pathSegmentAt(value, relativeOffset);
	if (!segment || segment.segmentIndex !== 0) return null;

	const name = segment.path[0];
	const range = {
		start: document.positionAt(valueStart + segment.segmentStart),
		end: document.positionAt(valueStart + segment.segmentEnd)
	};

	// Active @for loop variable at this position.
	const activeLoops = forScopesAt(source, offset);
	const loop = [...activeLoops].reverse().find(item => item.item === name || item.index === name);
	if (loop) {
		return {
			range,
			path: [name],
			componentStart: 0,
			componentEnd: source.length,
			name,
			isLoop: true,
			loopKind: loop.index === name ? 'index' : 'item'
		};
	}

	// Root component member reference inside a template expression.
	const target = defs
		.filter(item => item.path.length === 1 && item.path[0] === name && offset > item.componentStart && offset < item.componentEnd)
		.sort((a, b) => b.componentStart - a.componentStart)[0];

	if (!target) return null;

	return {
		range,
		path: target.path,
		componentStart: target.componentStart,
		componentEnd: target.componentEnd,
		name: target.name,
		isLoop: false
	};
}

/**
 * Collects every same-file occurrence of a rename target that should be rewritten.
 *
 * @param {TextDocument} document Open document.
 * @param {{path: string[], componentStart: number, componentEnd: number, name: string, isLoop: boolean, loopKind?: 'item' | 'index'}} target Resolved rename target.
 * @returns {Array<{start: number, end: number}>} Absolute source ranges to replace.
 */
function collectRenameRanges(document, target) {
	const source = document.getText();
	const ranges = [];
	const seen = new Set();

	const add = (start, end) => {
		if (start < 0 || end <= start) return;
		const key = `${start}:${end}`;
		if (seen.has(key)) return;
		seen.add(key);
		ranges.push({ start, end });
	};

	/**
	 * Yields absolute ranges of root identifier occurrences of `name` inside a
	 * directive attribute value. For `@on`, only the handler after `=` is considered.
	 */
	const collectInValue = (directive, value, valueOffset) => {
		let searchValue = value;
		let searchOffset = valueOffset;

		if (directive === '@on') {
			const equals = value.indexOf('=');
			if (equals < 0) return;
			searchValue = value.slice(equals + 1);
			searchOffset = valueOffset + equals + 1;
		}

		if (directive === '@for') {
			// When renaming a component member used as the loop source, only touch
			// the expression token(s), not the item/index binding names.
			const loop = parseForAttribute(value);
			if (loop && !target.isLoop) {
				const exprStartInValue = value.lastIndexOf(loop.expression);
				if (exprStartInValue >= 0) {
					searchValue = loop.expression;
					searchOffset = valueOffset + exprStartInValue;
				}
			}
		}

		for (const match of searchValue.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
			const segments = match[0].split('.');
			if (segments[0] !== target.name) continue;
			const absStart = searchOffset + match.index;
			add(absStart, absStart + target.name.length);
		}
	};

	if (target.isLoop) {
		// Declaration token(s) + every use inside an active scope that binds this name.
		for (const template of findTemplates(source)) {
			if (template.tag !== 'html') continue;
			const body = source.slice(template.start, template.end);
			const attributePattern = /(@[\w-]+)\s*=\s*(["'])(.*?)\2/gs;

			for (const attribute of body.matchAll(attributePattern)) {
				const directive = attribute[1];
				const value = attribute[3];
				const valueOffset = template.start + attribute.index + attribute[0].indexOf(value);

				if (directive === '@for') {
					const declaration = parseForAttribute(value);
					if (!declaration) continue;
					const tokens = [...value.matchAll(/\S+/g)];
					if (target.loopKind === 'item' && tokens[0] && tokens[0][0] === target.name) {
						add(valueOffset + tokens[0].index, valueOffset + tokens[0].index + target.name.length);
					}
					if (target.loopKind === 'index' && declaration.index && tokens[1] && tokens[1][0] === target.name) {
						add(valueOffset + tokens[1].index, valueOffset + tokens[1].index + target.name.length);
					}
				}

				for (const match of value.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
					if (match[0] !== target.name) continue;
					const absStart = valueOffset + match.index;
					const scopes = forScopesAt(source, absStart);
					const inScope = scopes.some(s =>
						(target.loopKind === 'index' ? s.index === target.name : s.item === target.name)
					);
					if (inScope) add(absStart, absStart + target.name.length);
				}
			}
		}

		return ranges;
	}

	// Component member: declaration site(s) + every matching template root reference.
	for (const def of componentDefinitions(source)) {
		if (def.componentStart === target.componentStart && def.path.join('.') === target.path.join('.')) {
			add(def.start, def.end);
		}
	}

	for (const template of findTemplates(source)) {
		if (template.tag !== 'html') continue;
		// Template must belong to the same createComponent options object.
		if (template.start <= target.componentStart || template.start >= target.componentEnd) continue;

		const body = source.slice(template.start, template.end);
		const attributePattern = /(@[\w-]+)\s*=\s*(["'])(.*?)\2/gs;

		for (const attribute of body.matchAll(attributePattern)) {
			const directive = attribute[1];
			const value = attribute[3];
			const valueOffset = template.start + attribute.index + attribute[0].indexOf(value);
			collectInValue(directive, value, valueOffset);
		}
	}

	return ranges;
}

/**
 * Prepares a rename operation by confirming the symbol under the cursor is renamable.
 *
 * @param {TextDocument} document Open document.
 * @param {import('vscode-languageserver/node').Position} position Cursor position.
 * @returns {import('vscode-languageserver/node').Range | {range: import('vscode-languageserver/node').Range, placeholder: string} | null}
 */
function prepareRename(document, position) {
	const target = renameTarget(document, position);
	if (!target) return null;
	return { range: target.range, placeholder: target.name };
}

/**
 * Finds all same-file references to the symbol under the cursor (declaration + template uses).
 *
 * @param {TextDocument} document Open document.
 * @param {import('vscode-languageserver/node').Position} position Cursor position.
 * @returns {import('vscode-languageserver/node').Location[] | null}
 */
function references(document, position) {
	const target = renameTarget(document, position);
	if (!target) return null;

	const ranges = collectRenameRanges(document, target);
	if (!ranges.length) return null;

	return ranges.map(({ start, end }) => ({
		uri: document.uri,
		range: { start: document.positionAt(start), end: document.positionAt(end) }
	}));
}

/**
 * Performs a same-file rename of a component member or loop variable.
 *
 * @param {TextDocument} document Open document.
 * @param {import('vscode-languageserver/node').Position} position Cursor position.
 * @param {string} newName Requested new identifier.
 * @returns {import('vscode-languageserver/node').WorkspaceEdit | null}
 */
function rename(document, position, newName) {
	if (!/^[A-Za-z_$][\w$]*$/.test(newName)) return null;

	const target = renameTarget(document, position);
	if (!target) return null;
	if (newName === target.name) return { changes: { [document.uri]: [] } };

	const ranges = collectRenameRanges(document, target);
	if (!ranges.length) return null;

	// Sort descending so offsets remain valid when applying sequential edits is not an issue
	// (LSP applies all edits as a set against the original document).
	ranges.sort((a, b) => b.start - a.start);

	const edits = ranges.map(({ start, end }) => ({
		range: { start: document.positionAt(start), end: document.positionAt(end) },
		newText: newName
	}));

	return { changes: { [document.uri]: edits } };
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
	const declarationsByComponent = new Map();

	for (const declaration of componentDeclarations(text)) {
		const declarations = declarationsByComponent.get(declaration.componentStart) || [];
		declarations.push(declaration);
		declarationsByComponent.set(declaration.componentStart, declarations);
	}

	for (const declarations of declarationsByComponent.values()) {
		const registered = new Map();

		for (const declaration of declarations) {
			const range = { start: document.positionAt(declaration.start), end: document.positionAt(declaration.end) };
			
			if (RESERVED_COMPONENT_KEYS.has(declaration.name)) {
				diagnostics.push({
					range, severity: DiagnosticSeverity.Error, source: 'Udodi', code: 'reserved-component-key',
					message: `The component ${declaration.namespace} key "${declaration.name}" is reserved by the Udodi runtime and cannot be declared.`
				});

				continue;
			}

			const existing = registered.get(declaration.name);
			if (existing) {
				diagnostics.push({
					range, severity: DiagnosticSeverity.Error, source: 'Udodi', code: 'component-key-collision',
					message: `The component key "${declaration.name}" in "${declaration.namespace}" conflicts with the same key in "${existing.namespace}". Root-level state, computed properties, and methods must have unique names.`
				});

			} else {
				registered.set(declaration.name, declaration);
			}
		}
	}

	for (const template of findTemplates(text)) {
		if (template.tag !== 'html' || template.close >= text.length || text[template.close] !== '`') continue;
		
		const body = text.slice(template.start, template.close);
		const attributePattern = /(@[\w-]+)\s*=\s*(["'])(.*?)\2/gs;

		for (const attribute of body.matchAll(attributePattern)) {
			const directive = attribute[1];
			const value = attribute[3];
			const valueOffset = template.start + attribute.index + attribute[0].indexOf(value);

			const addTypeDiagnostics = found => {
				for (const item of found) diagnostics.push({
					range: { start: document.positionAt(item.start), end: document.positionAt(item.end) },
					severity: item.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
					source: 'Udodi', code: item.code, message: item.message
				});
			};
			
			if (directive === '@on') {
				for (const binding of splitDirectiveExpressions(value)) {
					const equals = binding.text.indexOf('=');
					if (equals < 0) {
						const start = valueOffset + binding.start;

						diagnostics.push({
							range: { start: document.positionAt(start), end: document.positionAt(start + binding.text.length) },
							severity: DiagnosticSeverity.Warning, source: 'Udodi', code: 'event-binding-equals',
							message: 'Event bindings use event[.modifier]=handler, for example click.prevent=save.'
						});

						continue;
					}

					const eventHandler = binding.text.slice(equals + 1);
					const handlerStart = valueOffset + binding.start + equals + 1;
					addTypeDiagnostics(checkEventHandler(eventHandler, membersAt(text, handlerStart), handlerStart));
				}

			} else if (directive === '@submit') {
				addTypeDiagnostics(checkEventHandler(value, membersAt(text, valueOffset), valueOffset));

			} else if (directive === '@validate') {
				for (const expression of splitDirectiveExpressions(value)) {
					const expressionStart = valueOffset + expression.start;
					addTypeDiagnostics(checkExpression(expression.text, membersAt(text, expressionStart), expressionStart));
				}

			} else if (directive === '@for') {
				const loop = parseForAttribute(value);
				if (loop) {
					const expressionStart = valueOffset + value.lastIndexOf(loop.expression);
					addTypeDiagnostics(checkExpression(loop.expression, membersAt(text, expressionStart), expressionStart, 'array'));
				}

			} else if (directive === '@attr') {
				for (const binding of value.matchAll(/(?:^|\s)([^\s=]+)=((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+))/g)) {
					const expression = binding[2];
					const expressionStart = valueOffset + binding.index + binding[0].lastIndexOf(expression);
					addTypeDiagnostics(checkExpression(expression, membersAt(text, expressionStart), expressionStart));
				}

			} else if (directive === '@style' || directive === '@class') {
				for (const expression of splitDirectiveExpressions(value)) {
					const expressionStart = valueOffset + expression.start;
					addTypeDiagnostics(checkExpression(expression.text, membersAt(text, expressionStart), expressionStart));
				}

			} else if (['@text', '@if', '@elseif', '@show', '@key', '@bind'].includes(directive)) {
				const expected = ['@if', '@elseif', '@show'].includes(directive) ? 'boolean' : undefined;
				addTypeDiagnostics(checkExpression(value, membersAt(text, valueOffset), valueOffset, expected));
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

/**
 * Resolves an LSP definition request against the document's static component
 * and loop declarations.
 *
 * @param {{textDocument: {uri: string}, position: import('vscode-languageserver/node').Position}} params Definition request parameters.
 * @returns {import('vscode-languageserver/node').Location | null} Definition location, if statically resolvable.
 */
function handleDefinition({ textDocument, position }) {
	const document = documents.get(textDocument.uri);
	return document ? definition(document, position) : null;
}

/**
 * Resolves an LSP prepareRename request.
 *
 * @param {{textDocument: {uri: string}, position: import('vscode-languageserver/node').Position}} params Prepare-rename parameters.
 * @returns {import('vscode-languageserver/node').Range | {range: import('vscode-languageserver/node').Range, placeholder: string} | null}
 */
function handlePrepareRename({ textDocument, position }) {
	const document = documents.get(textDocument.uri);
	return document ? prepareRename(document, position) : null;
}

/**
 * Resolves an LSP rename request.
 *
 * @param {{textDocument: {uri: string}, position: import('vscode-languageserver/node').Position, newName: string}} params Rename parameters.
 * @returns {import('vscode-languageserver/node').WorkspaceEdit | null}
 */
function handleRename({ textDocument, position, newName }) {
	const document = documents.get(textDocument.uri);
	return document ? rename(document, position, newName) : null;
}

/**
 * Resolves an LSP references request.
 *
 * @param {{textDocument: {uri: string}, position: import('vscode-languageserver/node').Position}} params References parameters.
 * @returns {import('vscode-languageserver/node').Location[] | null}
 */
function handleReferences({ textDocument, position }) {
	const document = documents.get(textDocument.uri);
	return document ? references(document, position) : null;
}

documents.onDidChangeContent(validateChangedDocument);
documents.onDidOpen(validateOpenedDocument);
connection.onCompletion(handleCompletion);
connection.onHover(handleHover);
connection.onDefinition(handleDefinition);
connection.onPrepareRename(handlePrepareRename);
connection.onRenameRequest(handleRename);
connection.onReferences(handleReferences);
documents.listen(connection);
connection.listen();
