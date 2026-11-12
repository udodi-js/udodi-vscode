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
			definitionProvider: true
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
		const valuePrefix = text.slice(context.valueStart, start);
		const path = `${valuePrefix}${word}`.match(/([\w$]+(?:\.[\w$]*)*)$/)?.[1]?.split('.').filter(Boolean);
		const member = path?.length > 1 ? nestedMember(members, path) : members.find(item => item.name === word);
		
		if (member) {
			const result = member.returnType ? ` Returns \`${member.returnType}\`.` : '';
			return { range, contents: { kind: MarkupKind.Markdown, value: `**${member.signature}**  \nComponent ${member.kind}.${result}` } };
		}
	}

	if (context.kind === 'value' && EXPRESSION_DIRECTIVES.has(context.directive)) {
		const helper = stdlib.find(item => item.name === word);
		const valuePrefix = text.slice(context.valueStart, start);
		
		if (helper && !/[\w$]+\.$/.test(valuePrefix)) return { range, contents: { kind: MarkupKind.Markdown, value: `**${helper.signature}**  \n${helper.description}` } };
	}

	return null;
}

/**
 * Finds the static component declaration targeted by an identifier in an
 * Udodi template expression.
 *
 * @param {TextDocument} document Open JavaScript or TypeScript document.
 * @param {import('vscode-languageserver/node').Position} position LSP cursor position.
 * @returns {import('vscode-languageserver/node').Location | null} Definition location, when statically resolvable.
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
				return { uri: document.uri, range: { start: document.positionAt(start), end: document.positionAt(start + name.length) } };
			}
		}
	}

	if (context.directive === '@on') {
		const bindingStart = value.lastIndexOf('=', relativeOffset);
		if (bindingStart < 0) return null;
	}

	let reference;
	let referenceStart;

	for (const match of value.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
		if (relativeOffset >= match.index && relativeOffset < match.index + match[0].length) {
			reference = match[0].split('.');
			referenceStart = match.index;
			break;
		}
	}

	if (!reference) return null;

	const activeLoops = forScopesAt(source, offset);
	const loop = [...activeLoops].reverse().find(item => item.item === reference[0] || item.index === reference[0]);
	let targetPath = reference;

	if (loop) {
		const onRoot = relativeOffset < referenceStart + reference[0].length;

		if (loop.index === reference[0] && onRoot) {
			return { uri: document.uri, range: { start: document.positionAt(loop.indexStart), end: document.positionAt(loop.indexStart + loop.index.length) } };
		}

		if (loop.item === reference[0] && onRoot) {
			return { uri: document.uri, range: { start: document.positionAt(loop.itemStart), end: document.positionAt(loop.itemStart + loop.item.length) } };
		}

		if (loop.item === reference[0]) {
			const sourcePath = loop.expression.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/)?.[1];
			if (!sourcePath) return null;

			targetPath = [...sourcePath.split('.'), ...reference.slice(1)];
		}
	}

	const target = componentDefinitions(source)
		.filter(item => item.path.join('.') === targetPath.join('.') && offset > item.componentStart && offset < item.componentEnd)
		.sort((left, right) => right.componentStart - left.componentStart)[0];
	
	if (!target) return null;

	return {
		uri: document.uri,
		range: { start: document.positionAt(target.start), end: document.positionAt(target.end) }
	};
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

documents.onDidChangeContent(validateChangedDocument);
documents.onDidOpen(validateOpenedDocument);
connection.onCompletion(handleCompletion);
connection.onHover(handleHover);
connection.onDefinition(handleDefinition);
documents.listen(connection);
connection.listen();
