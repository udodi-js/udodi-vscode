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
	const attr = [...tagText.matchAll(/(@[\w-]+)\s*=\s*(["'])([^"']*)$/g)].at(-1);
	if (attr && inTag) {
		const value = attr[3];
		const valueStart = offset - value.length;
		return { kind: 'value', directive: attr[1], value, valueStart, template };
	}
	const directivePrefix = tagText.match(/(?:^|\s)(@[\w-]*)$/);
	if (directivePrefix && inTag) {
		const prefix = directivePrefix[1];
		return { kind: 'directive', prefix, start: offset - prefix.length, template };
	}
	return { kind: inTag ? 'tag' : 'text', template };
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

module.exports = { HOST_LANGUAGES, findTemplates, cursorContext, cssTemplateContext, maskCssInterpolations };
