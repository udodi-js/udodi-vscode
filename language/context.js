const HOST_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

/**
 * Advances past a quoted string, honoring backslash escapes.
 *
 * @param {string} source Source text containing the quote.
 * @param {number} index Offset of the opening quote.
 * @param {string} quote Quote character that opened the string.
 * @returns {number} Offset immediately after the closing quote, or source.length.
 */
function skipQuoted(source, index, quote) {
	for (let i = index + 1; i < source.length; i++) {
		if (source[i] === '\\') { i++; continue; }
		if (source[i] === quote) return i + 1;
	}

	return source.length;
}

/**
 * Finds the end of a template literal while skipping quoted strings inside
 * JavaScript interpolations.
 *
 * @param {string} source Host-language source text.
 * @param {number} start Offset immediately after the opening backtick.
 * @returns {number} Closing-backtick offset, or source.length if unterminated.
 */
function templateEnd(source, start) {
	let braces = 0;
	let inExpression = false;

	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (inExpression) {
			if (c === '"' || c === "'" || c === '`') { i = skipQuoted(source, i, c) - 1; continue; }
			if (c === '{') braces++;
			else if (c === '}' && --braces === 0) inExpression = false;
			continue;
		}

		if (c === '\\') { i++; continue; }
		if (c === '$' && source[i + 1] === '{') { inExpression = true; braces = 1; i++; continue; }
		if (c === '`') return i;
	}

	return source.length;
}

/**
 * Scans JavaScript or TypeScript source for `html` and `css` tagged templates.
 * Comments, ordinary strings, and unrelated template literals are ignored.
 *
 * @param {string} source Host-language source text.
 * @returns {Array<{tag: 'html' | 'css', start: number, end: number, open: number, close: number}>}
 *   Template content and delimiter offsets in the original source.
 */
function findTemplates(source) {
	const templates = [];

	for (let i = 0; i < source.length;) {
		const c = source[i];

		if (c === '/' && source[i + 1] === '/') { const n = source.indexOf('\n', i + 2); i = n < 0 ? source.length : n + 1; continue; }
		if (c === '/' && source[i + 1] === '*') { const n = source.indexOf('*/', i + 2); i = n < 0 ? source.length : n + 2; continue; }
		if (c === '"' || c === "'") { i = skipQuoted(source, i, c); continue; }
		if (/[A-Za-z_$]/.test(c)) {
			const begin = i++;
			while (i < source.length && /[\w$]/.test(source[i])) i++;

			const tag = source.slice(begin, i);
			if (tag !== 'html' && tag !== 'css') continue;

			let tick = i;
			while (/\s/.test(source[tick] || '') && tick < source.length) tick++;

			if (source[tick] !== '`') continue;

			const end = templateEnd(source, tick + 1);
			templates.push({ tag, start: tick + 1, end, open: tick, close: end });
			i = end < source.length ? end + 1 : end;

			continue;
		}

		if (c === '`') { i = templateEnd(source, i + 1) + 1; continue; }
		i++;
	}

	return templates;
}

/**
 * Classifies the cursor location in an Udodi HTML tagged template.
 * Interpolations are left to the JavaScript or TypeScript language service.
 *
 * @param {string} source Host-language source text.
 * @param {number} offset Cursor offset in source.
 * @returns {{kind: string, template: object, directive?: string, value?: string, valueStart?: number, prefix?: string, start?: number} | undefined}
 *   Template context, or undefined outside an Udodi HTML template/expression.
 */
function cursorContext(source, offset) {
	const template = findTemplates(source).find(t => offset >= t.start && offset <= t.end);
	if (!template || template.tag !== 'html') return undefined;

	const before = source.slice(template.start, offset);
	const interpolation = before.lastIndexOf('${');
	
	if (interpolation > before.lastIndexOf('}') && before.lastIndexOf('}') < interpolation) return undefined;
	
	const lastOpen = before.lastIndexOf('<');
	const lastClose = before.lastIndexOf('>');
	const inTag = lastOpen > lastClose;
	const tagText = inTag ? before.slice(lastOpen + 1) : '';

	if (inTag) {
		const openOffset = template.start + lastOpen;
		let cursor = tagText.search(/[\w:-]/);

		while (cursor >= 0 && cursor < tagText.length) {
			while (/\s/.test(tagText[cursor] || '')) cursor++;

			const nameStart = cursor;
			while (cursor < tagText.length && !/[\s=/>]/.test(tagText[cursor])) cursor++;

			if (cursor === nameStart) { cursor++; continue; }

			const name = tagText.slice(nameStart, cursor);

			while (/\s/.test(tagText[cursor] || '')) cursor++;

			if (tagText[cursor] !== '=') continue;

			cursor++;
			while (/\s/.test(tagText[cursor] || '')) cursor++;

			const quote = tagText[cursor];
			if (quote !== '"' && quote !== "'") {
				while (cursor < tagText.length && !/[\s>]/.test(tagText[cursor])) cursor++;
				continue;
			}

			const valueStart = openOffset + 1 + cursor + 1;
			const valueEnd = source.indexOf(quote, valueStart);
			const end = valueEnd < 0 || valueEnd > template.end ? template.end : valueEnd;

			if (name.startsWith('@') && offset >= valueStart && offset <= end) {
				return { kind: 'value', directive: name, value: source.slice(valueStart, Math.min(offset, end)), valueStart, template };
			}

			cursor = valueEnd < 0 ? tagText.length : valueEnd - openOffset;
		}
	}

	const directivePrefix = tagText.match(/(?:^|\s)(@[\w-]*)$/);

	if (directivePrefix && inTag) {
		const prefix = directivePrefix[1];
		return { kind: 'directive', prefix, start: offset - prefix.length, template };
	}

	return { kind: inTag ? 'tag' : 'text', template };
}

/**
 * Reads loop-variable declaration offsets from an opening HTML tag.
 *
 * @param {string} tagText Opening tag source.
 * @param {number} tagStart Absolute tag offset in the host document.
 * @returns {{item: string, index?: string, expression: string, itemStart: number, indexStart?: number} | undefined} Loop scope and declaration offsets.
 */
function loopDeclaration(tagText, tagStart) {
	const attribute = tagText.match(/@for\s*=\s*(["'])(.*?)\1/s);
	if (!attribute) return undefined;

	const loop = parseForAttribute(tagText);
	if (!loop) return undefined;

	const valueStart = attribute.index + attribute[0].indexOf(attribute[2]);
	const tokens = [...attribute[2].matchAll(/\S+/g)];

	return {
		...loop,
		itemStart: tagStart + valueStart + tokens[0].index,
		indexStart: loop.index ? tagStart + valueStart + tokens[1].index : undefined
	};
}

/**
 * Finds active `@for` lexical scopes at a cursor in an HTML template.
 *
 * The scanner walks complete HTML tags up to the cursor and follows their
 * nesting, so loop variables are visible only inside the repeated element.
 *
 * @param {string} source JavaScript or TypeScript document text.
 * @param {number} offset Cursor offset in the document.
 * @returns {Array<{item: string, index?: string, expression: string}>} Active loop declarations, outermost first.
 */
function forScopesAt(source, offset) {
	const template = findTemplates(source).find(item => item.tag === 'html' && offset >= item.start && offset <= item.end);
	if (!template) return [];

	const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
	const stack = [];
	let cursor = template.start;

	while (cursor < offset) {
		const open = source.indexOf('<', cursor);

		if (open < 0 || open >= offset) break;

		if (source.startsWith('<!--', open)) {
			const commentEnd = source.indexOf('-->', open + 4);
			if (commentEnd < 0 || commentEnd >= offset) break;
			cursor = commentEnd + 3;
			continue;
		}

		let quote = '';
		let end = open + 1;

		for (; end < source.length && end < template.end; end++) {
			const char = source[end];
			
			if (quote) {
				if (char === quote) quote = '';
			} else if (char === '"' || char === "'") quote = char;
			else if (char === '>') break;
		}

		if (end >= offset) {
			const partial = source.slice(open, offset);
			const name = partial.match(/^<\s*([\w:-]+)/)?.[1]?.toLowerCase();
			const loop = loopDeclaration(partial, open);
			const attr = partial.match(/@for\s*=\s*(["'])(.*?)\1/s);

			if (name && loop && attr && open + attr.index + attr[0].length < offset) {
				stack.push({ tag: name, loop });
			}

			break;
		}

		const tagText = source.slice(open, end + 1);
		const closing = tagText.match(/^<\s*\/\s*([\w:-]+)/);

		if (closing) {
			const name = closing[1].toLowerCase();

			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].tag === name) {
					stack.length = i;
					break;
				}
			}

		} else {
			const name = tagText.match(/^<\s*([\w:-]+)/)?.[1]?.toLowerCase();
			const loop = loopDeclaration(tagText, open);

			if (name && !voidTags.has(name) && !/\/\s*>$/.test(tagText)) stack.push({ tag: name, loop });
		}

		cursor = end + 1;
	}

	return stack.map(entry => entry.loop).filter(Boolean);
}

/**
 * Parses the public two-token or three-token `@for` declaration from either
 * an opening tag/attribute or the attribute value itself.
 *
 * @param {string} tagText Opening tag text.
 * @returns {{item: string, index?: string, expression: string} | undefined} Loop variables and source expression.
 */
function parseForAttribute(tagText) {
	const attributeValue = tagText.match(/@for\s*=\s*(["'])(.*?)\1/s)?.[2];
	const value = attributeValue === undefined ? tagText : attributeValue;
	const tokens = value.trim().split(/\s+/).filter(Boolean);

	if (tokens.length < 2 || tokens.length > 3) return undefined;

	const identifier = /^[A-Za-z_$][\w$]*$/;
	if (!identifier.test(tokens[0])) return undefined;
	if (tokens.length === 2) return { item: tokens[0], expression: tokens[1] };
	if (!identifier.test(tokens[1])) return undefined;

	return { item: tokens[0], index: tokens[1], expression: tokens.slice(2).join(' ') };
}

/**
 * Masks JavaScript interpolations in CSS template content without changing its
 * line and character offsets, and identifies whether the cursor is in one.
 *
 * @param {string} cssText Raw content of a `css` tagged template.
 * @param {number} cursorOffset Cursor offset relative to the CSS template body.
 * @returns {{text: string, inInterpolation: boolean}} CSS text with interpolation
 *   regions blanked out and a flag indicating whether the cursor is in one.
 */
function maskCssInterpolations(cssText, cursorOffset) {
	const chars = cssText.split('');
	let inInterpolation = false;

	for (let i = 0; i < cssText.length; i++) {
		if (cssText[i] !== '$' || cssText[i + 1] !== '{' || (i > 0 && cssText[i - 1] === '\\')) continue;
		
		const start = i;
		let depth = 1;
		let end = i + 2;

		for (; end < cssText.length && depth > 0; end++) {
			const char = cssText[end];

			if (char === '"' || char === "'" || char === '`') { end = skipQuoted(cssText, end, char) - 1; continue; }
			if (char === '{') depth++;
			else if (char === '}') depth--;
		}

		const after = depth === 0 ? end : cssText.length;
		if (cursorOffset >= start && cursorOffset < after) inInterpolation = true;
		
		for (let j = start; j < after; j++) if (cssText[j] !== '\n' && cssText[j] !== '\r') chars[j] = ' ';
		i = after - 1;
	}

	return { text: chars.join(''), inInterpolation };
}

/**
 * Returns CSS language-service context when the cursor is in a `css` template.
 * JavaScript interpolation regions are masked to preserve source positions.
 *
 * @param {string} source Host-language source text.
 * @param {number} offset Cursor offset in the host document.
 * @returns {{kind: 'css', template: object, text: string, offset: number} | undefined}
 *   CSS virtual-document context, or undefined outside CSS template content and
 *   within JavaScript interpolation expressions.
 */
function cssTemplateContext(source, offset) {
	const template = findTemplates(source).find(item => item.tag === 'css' && offset >= item.start && offset <= item.end);
	if (!template) return undefined;
	
	const raw = source.slice(template.start, template.end);
	const masked = maskCssInterpolations(raw, offset - template.start);

	if (masked.inInterpolation) return undefined;
	
	return { kind: 'css', template, text: masked.text, offset: offset - template.start };
}

module.exports = { HOST_LANGUAGES, findTemplates, cursorContext, forScopesAt, parseForAttribute, cssTemplateContext, maskCssInterpolations };
