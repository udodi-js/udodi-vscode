/**
 * Returns the offset after a quoted JavaScript string, accounting for escapes.
 *
 * @param {string} source Source text.
 * @param {number} index Opening-quote offset.
 * @param {string} quote Opening quote character.
 * @returns {number} Offset after the closing quote, or source.length.
 */
function skipQuoted(source, index, quote) {
	for (let i = index + 1; i < source.length; i++) {
		if (source[i] === '\\') { i++; continue; }
		if (source[i] === quote) return i + 1;
	}
	return source.length;
}

/**
 * Finds a matching delimiter while ignoring strings and comments.
 *
 * @param {string} source Source text.
 * @param {number} open Offset of the opening delimiter.
 * @param {string} [left='{'] Opening delimiter.
 * @param {string} [right='}'] Closing delimiter.
 * @returns {number} Matching closing-delimiter offset, or -1 when unmatched.
 */
function matching(source, open, left = '{', right = '}') {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === '"' || char === "'" || char === '`') { i = skipQuoted(source, i, char) - 1; continue; }
		if (char === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue; }
		if (char === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
		if (char === left) depth++;
		else if (char === right && --depth === 0) return i;
	}
	return -1;
}

/**
 * Splits an object literal into comma-separated top-level property entries.
 * Nested arrays, objects, calls, strings, and comments remain within an entry.
 *
 * @param {string} source Source text.
 * @param {number} open Opening-brace offset.
 * @param {number} close Matching closing-brace offset.
 * @returns {string[]} Trimmed top-level property entries.
 */
function splitProperties(source, open, close) {
	const entries = [];
	let start = open + 1;
	const stack = [];
	for (let i = start; i < close; i++) {
		const char = source[i];
		if (char === '"' || char === "'" || char === '`') { i = skipQuoted(source, i, char) - 1; continue; }
		if (char === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i + 2); i = end < 0 ? close : end; continue; }
		if (char === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? close : end + 1; continue; }
		if ('([{'.includes(char)) stack.push(char);
		else if (')]}'.includes(char)) stack.pop();
		else if (char === ',' && stack.length === 0) {
			entries.push(source.slice(start, i).trim());
			start = i + 1;
		}
	}
	const last = source.slice(start, close).trim();
	if (last) entries.push(last);
	return entries;
}

/**
 * Reads a statically named property key from a JavaScript object entry.
 *
 * @param {string} entry One top-level object property entry.
 * @returns {string | undefined} Identifier or quoted key; undefined for dynamic keys.
 */
function keyOf(entry) {
	const match = entry.match(/^\s*(?:async\s+)?(?:get\s+|set\s+)?(?:([\w$]+)|(["'])(.*?)\2)\s*(?=:|\()/s);
	return match ? (match[1] || match[3]) : undefined;
}

/**
 * Locates the object literal assigned to a component option such as `methods`
 * or `computed`.
 *
 * @param {string} source Full source text containing the option.
 * @param {string} entry Option property entry.
 * @returns {{open: number, close: number} | undefined} Object delimiter offsets.
 */
function objectRangeFromOption(source, entry) {
	const arrow = entry.indexOf('=>');
	const localOpen = arrow >= 0 ? entry.indexOf('{', arrow + 2) : entry.indexOf('{');
	const objectOpen = localOpen < 0 ? -1 : source.indexOf(entry) + localOpen;
	if (objectOpen < 0) return undefined;
	const close = matching(source, objectOpen);
	return close < 0 ? undefined : { open: objectOpen, close };
}

/**
 * Locates the object returned by a component's `state` factory.
 * Supports method and arrow-function state factories.
 *
 * @param {string} source Full source text containing the state option.
 * @param {string} entry `state` property entry.
 * @returns {{open: number, close: number} | undefined} Returned object offsets.
 */
function stateObjectRange(source, entry) {
	const arrow = entry.indexOf('=>');
	let objectOpen;
	if (arrow >= 0) {
		const localOpen = entry.indexOf('{', arrow + 2);
		objectOpen = localOpen < 0 ? -1 : source.indexOf(entry) + localOpen;
	} else {
		const returned = entry.match(/\breturn\s*\{/);
		const localOpen = returned ? returned.index + returned[0].lastIndexOf('{') : -1;
		objectOpen = localOpen < 0 ? -1 : source.indexOf(entry) + localOpen;
	}
	if (objectOpen < 0) return undefined;
	const close = matching(source, objectOpen);
	return close < 0 ? undefined : { open: objectOpen, close };
}

/**
 * Infers a broad display type from a literal or simple expression.
 * This is intentionally heuristic and returns `unknown` when the expression
 * cannot be classified safely.
 *
 * @param {string} value JavaScript initializer or return expression.
 * @returns {'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'array' | 'object' | 'function' | 'unknown'}
 *   Best-effort type label for completion and hover details.
 */
function inferType(value) {
	const text = value.trim();
	if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(text)) return 'string';
	if (/^(?:`[\s\S]*\$\{[\s\S]*\}[\s\S]*`|[\s\S]*\s\+\s*["'`])/.test(text)) return 'string';
	if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?n?$/i.test(text)) return text.endsWith('n') ? 'bigint' : 'number';
	if (/^(?:true|false)$/.test(text)) return 'boolean';
	if (/^null$/.test(text)) return 'null';
	if (/^(?:!|[\s\S]+\s(?:===?|!==?|<=?|>=?|&&|\|\|)\s[\s\S]+)$/.test(text)) return 'boolean';
	if (/^[\s\S]+\s(?:\*|\/|%|-)\s[\s\S]+$/.test(text)) return 'number';
	if (/^\[/.test(text)) return 'array';
	if (/^\{/.test(text)) return 'object';
	if (/^(?:async\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)/.test(text)) return 'function';
	return 'unknown';
}

/**
 * Infers the display type of a state property initializer.
 *
 * @param {string} entry State object property entry.
 * @returns {string} Inferred broad type, or `unknown` for unsupported syntax.
 */
function stateValueType(entry) {
	const match = entry.match(/^\s*(?:[\w$]+|(["']).*?\1)\s*:\s*([\s\S]*)$/);
	return match ? inferType(match[2].replace(/,\s*$/, '')) : 'unknown';
}

/**
 * Builds completion metadata for a method or computed-property definition.
 * Computed return types are inferred from a simple explicit return expression.
 *
 * @param {string} entry Object property containing the function.
 * @param {string} name Property name exposed on the component context.
 * @param {'method' | 'computed'} kind Component member category.
 * @returns {{name: string, kind: 'method' | 'computed', type: string, params: string, signature: string}}
 *   Member name, inferred display type, parameter text, and signature.
 */
function methodInfo(entry, name, kind) {
	const params = entry.match(/^[\s\S]*?\(([^)]*)\)/)?.[1]?.trim() || '';
	let type = 'function';
	if (kind === 'computed') {
		const bodyStart = entry.indexOf('{');
		const body = bodyStart < 0 ? entry : entry.slice(bodyStart + 1);
		const returned = body.match(/\breturn\s+([^;\n}]+)/)?.[1];
		type = returned ? inferType(returned) : 'unknown';
	}
	return { name, kind, type, params, signature: `${name}(${params}): ${type}` };
}

/**
 * Extracts template-visible state, computed values, and methods from the
 * `createComponent` call whose options object contains the given template offset.
 *
 * @param {string} source JavaScript or TypeScript document text.
 * @param {number} offset Cursor offset inside the component template.
 * @returns {Array<{name: string, kind: 'state' | 'computed' | 'method', type: string, signature: string, params?: string}> | undefined}
 *   Component members, or undefined when the template is not inside a supported
 *   `createComponent({ ... })` options object.
 */
function componentForTemplate(source, offset) {
	const pattern = /\bcreateComponent\s*\(/g;
	let match;
	let selected;
	while ((match = pattern.exec(source)) && match.index < offset) {
		const callOpen = source.indexOf('(', match.index);
		const objectOpen = source.indexOf('{', callOpen + 1);
		if (objectOpen < 0 || objectOpen >= offset) continue;
		const close = matching(source, objectOpen);
		if (close > offset && (!selected || objectOpen > selected.open)) selected = { open: objectOpen, close };
	}
	if (!selected) return undefined;

	const options = splitProperties(source, selected.open, selected.close);
	const stateEntry = options.find(entry => keyOf(entry) === 'state');
	const methodsEntry = options.find(entry => keyOf(entry) === 'methods');
	const computedEntry = options.find(entry => keyOf(entry) === 'computed');
	const members = [];

	if (stateEntry) {
		const range = stateObjectRange(source, stateEntry);
		if (range) for (const entry of splitProperties(source, range.open, range.close)) {
			const name = keyOf(entry);
			if (name) members.push({ name, kind: 'state', type: stateValueType(entry), signature: `${name}: ${stateValueType(entry)}` });
		}
	}

	for (const [entry, kind] of [[computedEntry, 'computed'], [methodsEntry, 'method']]) {
		if (!entry) continue;
		const range = objectRangeFromOption(source, entry);
		if (!range) continue;
		for (const property of splitProperties(source, range.open, range.close)) {
			const name = keyOf(property);
			if (name) members.push(methodInfo(property, name, kind));
		}
	}
	return members;
}

module.exports = { componentForTemplate, inferType };
