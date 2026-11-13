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
 * Splits an object literal into top-level entries with source offsets.
 *
 * @param {string} source Source text.
 * @param {number} open Opening-brace offset.
 * @param {number} close Closing-brace offset.
 * @returns {Array<{text: string, start: number}>} Property text and its start offset.
 */
function splitPropertyEntries(source, open, close) {
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
			const text = source.slice(start, i).trim();
			if (text) entries.push({ text, start: start + source.slice(start, i).search(/\S/) });
			start = i + 1;
		}
	}

	const text = source.slice(start, close).trim();
	if (text) entries.push({ text, start: start + source.slice(start, close).search(/\S/) });

	return entries;
}

/**
 * Reads a statically named property key from a JavaScript object entry.
 *
 * @param {string} entry One top-level object property entry.
 * @returns {string | undefined} Identifier or quoted key; undefined for dynamic keys.
 */
/**
 * Skips whitespace and leading JavaScript comments before an object member.
 *
 * @param {string} entry Object property source.
 * @returns {number} Offset of the first non-comment character.
 */
function skipLeadingComments(entry) {
	let index = 0;
	while (index < entry.length) {
		const rest = entry.slice(index);
		const whitespace = rest.match(/^\s+/);

		if (whitespace) { index += whitespace[0].length; continue; }

		if (rest.startsWith('/*')) {
			const end = entry.indexOf('*/', index + 2);
			if (end < 0) return entry.length;
			index = end + 2;
			continue;
		}

		if (rest.startsWith('//')) {
			const end = entry.indexOf('\n', index + 2);
			index = end < 0 ? entry.length : end + 1;
			continue;
		}

		break;
	}

	return index;
}

function keyOf(entry) {
	return keyInfo(entry)?.name;
}

/**
 * Returns a property key and its entry-relative start offset.
 *
 * @param {string} entry JavaScript object property entry.
 * @returns {{name: string, start: number} | undefined} Static property key metadata.
 */
function keyInfo(entry) {
	const prefixLength = skipLeadingComments(entry);
	const match = entry.slice(prefixLength).match(/^(?:async\s+)?(?:get\s+|set\s+)?(?:(?<identifier>[\w$]+)|(?<quote>["'])(?<quoted>.*?)\k<quote>)\s*(?=:|\()/s);
	
	if (!match) return undefined;

	const raw = match.groups.identifier || match.groups.quoted;
	return { name: raw, start: prefixLength + match.index + match[0].indexOf(raw) };
}

/**
 * Locates the object literal assigned to a component option such as `methods`
 * or `computed`.
 *
 * @param {string} source Full source text containing the option.
 * @param {string} entry Option property entry.
 * @param {number} [entryStart=source.indexOf(entry)] Entry start offset in source.
 * @returns {{open: number, close: number} | undefined} Object delimiter offsets.
 */
function objectRangeFromOption(source, entry, entryStart = source.indexOf(entry)) {
	const arrow = entry.indexOf('=>');
	const localOpen = arrow >= 0 ? entry.indexOf('{', arrow + 2) : entry.indexOf('{');
	const objectOpen = localOpen < 0 ? -1 : entryStart + localOpen;

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
 * @param {number} [entryStart=source.indexOf(entry)] Entry start offset in source.
 * @returns {{open: number, close: number} | undefined} Returned object offsets.
 */
function stateObjectRange(source, entry, entryStart = source.indexOf(entry)) {
	const arrow = entry.indexOf('=>');
	let objectOpen;

	if (arrow >= 0) {
		const localOpen = entry.indexOf('{', arrow + 2);
		objectOpen = localOpen < 0 ? -1 : entryStart + localOpen;

	} else {
		const returned = entry.match(/\breturn\s*\{/);
		const localOpen = returned ? returned.index + returned[0].lastIndexOf('{') : -1;
		const literalOpen = entry.match(/^\s*(?:[\w$]+|["'][^"']+["'])\s*:\s*\{/);
		const localStateOpen = localOpen >= 0 ? localOpen : literalOpen ? literalOpen[0].lastIndexOf('{') : -1;
		objectOpen = localStateOpen < 0 ? -1 : entryStart + localStateOpen;
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
 * Infers the element shape of an array literal.
 *
 * @param {string} value Array expression source.
 * @returns {{type: string, children: Array<object>} | undefined} Element metadata when the literal is statically readable.
 */
function arrayElement(value) {
	const text = value.trim();
	if (!text.startsWith('[')) return undefined;

	const close = matching(text, 0, '[', ']');
	if (close < 0) return undefined;

	const first = splitProperties(text, 0, close)[0];
	if (!first) return { type: 'unknown', children: [], shapeKnown: false };

	if (first.trim().startsWith('{')) {
		const objectClose = matching(first.trim(), 0);
		const children = objectClose > 0 ? splitProperties(first.trim(), 0, objectClose).map(stateMember).filter(Boolean) : [];
		
		return { type: 'object', children, shapeKnown: true };
	}

	return { type: inferType(first), children: [], shapeKnown: false };
}

/**
 * Reads a simple returned expression from a method, computed getter, or arrow.
 *
 * @param {string} entry Function-valued object property.
 * @returns {string | undefined} Return expression source when it is a simple expression.
 */
function returnedExpression(entry) {
	const arrow = entry.indexOf('=>');
	let text;

	if (arrow >= 0 && !entry.slice(arrow + 2).trimStart().startsWith('{')) {
		text = entry.slice(arrow + 2).trim();

	} else {
		const bodyStart = entry.indexOf('{', arrow >= 0 ? arrow + 2 : 0);
		if (bodyStart < 0) return undefined;

		const returned = entry.slice(bodyStart + 1).match(/\breturn\s+/);
		if (!returned) return undefined;

		text = entry.slice(bodyStart + 1 + returned.index + returned[0].length).trim();
	}

	if (text.startsWith('[') || text.startsWith('{')) {
		const close = matching(text, 0, text[0], text[0] === '[' ? ']' : '}');
		return close < 0 ? undefined : text.slice(0, close + 1);
	}

	return text.split(/[;\n}]/, 1)[0].trim() || undefined;
}

/**
 * Builds completion metadata for a state property, recursively reading object
 * literal children so expressions such as `user.` can offer nested members.
 *
 * @param {string} entry State property entry.
 * @returns {{name: string, kind: 'state', type: string, signature: string, children: Array<object>}} Member metadata.
 */
function stateMember(entry) {
	const key = keyInfo(entry);
	if (!key) return undefined;
	
	const valueStart = entry.indexOf(':') + 1;
	const value = entry.slice(valueStart).trim().replace(/,\s*$/, '');
	let children = [];

	if (value.startsWith('{')) {
		const close = matching(value, 0);
		if (close > 0) children = splitProperties(value, 0, close).map(stateMember).filter(Boolean);
	}

	const element = arrayElement(value);
	const returned = value.includes('=>') || value.includes('function') ? returnedExpression(value) : undefined;
	const returnElement = returned ? arrayElement(returned) : undefined;
	const type = value.startsWith('{') ? 'object' : stateValueType(entry);
	
	return {
		name: key.name, kind: 'state', type, signature: `${key.name}: ${type}`, children, shapeKnown: value.startsWith('{'),
		element, returnType: returnElement ? 'array' : undefined, returnElement
	};
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
	const declaration = entry.slice(skipLeadingComments(entry));
	const params = declaration.match(/^[\s\S]*?\(([^)]*)\)/)?.[1]?.trim() || '';
	const returned = returnedExpression(declaration);
	const returnType = returned ? inferType(returned) : 'unknown';
	const returnElement = returned ? arrayElement(returned) : undefined;
	let returnChildren = [];

	if (returned?.startsWith('{')) {
		const close = matching(returned, 0);
		if (close > 0) returnChildren = splitProperties(returned, 0, close).map(stateMember).filter(Boolean);
	}

	let type = 'function';
	if (kind === 'computed') {
		type = returnType;
	}
	
	return {
		name, kind, type, returnType, returnElement, returnExpression: returned, params,
		children: returnType === 'object' ? returnChildren : [],
		shapeKnown: returnType === 'object',
		signature: `${name}(${params}): ${type}`
	};
}

/**
 * Infers the item metadata produced by a supported `@for` source expression.
 * Paths, direct function paths, and colon calls use the declared return shape.
 *
 * @param {Array<object>} members Component members.
 * @param {string} expression Udodi expression used as the loop source.
 * @returns {{type: string, children: Array<object>} | undefined} Inferred item metadata.
 */
function arrayItemForExpression(members, expression) {
	let source = expression.trim();
	if (source.includes('=>')) source = source.slice(source.lastIndexOf('=>') + 2).trim();
	if (source.includes('|')) source = source.split('|').at(-1).trim();

	source = source.replace(/^this\./, '');
	const root = source.match(/^([\w$]+)/)?.[1];
	if (!root) return undefined;

	let member = members.find(item => item.name === root);
	if (!member) return undefined;

	const path = source.slice(root.length).match(/^(?:\.[\w$]+)*/)?.[0] || '';
	if (path) {
		for (const segment of path.slice(1).split('.')) {
			member = (member.children || []).find(item => item.name === segment);
			if (!member) return undefined;
		}
	}

	if (member.type === 'array' && member.element) return member.element;
	if (member.returnType === 'array' && member.returnElement) return member.returnElement;
	if (member.type === 'array') return { type: 'unknown', children: [] };

	return undefined;
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
			const member = stateMember(entry);
			if (member) members.push(member);
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

	for (const member of members) {
		if (member.returnType && member.returnType !== 'array') continue;

		if (member.returnExpression && !member.returnElement) {
			const item = arrayItemForExpression(members, member.returnExpression);
			if (item) {
				member.returnType = 'array';
				member.returnElement = item;
			}
		}
	}

	return members;
}

/**
 * Describes root-level state, computed, and method declarations for every
 * statically analyzable `createComponent({ ... })` call in a source document.
 *
 * @param {string} source JavaScript or TypeScript source text.
 * @returns {Array<{name: string, namespace: string, componentStart: number, start: number, end: number}>} Component declaration keys.
 */
function componentDeclarations(source) {
	const declarations = [];
	const pattern = /\bcreateComponent\s*\(/g;
	let match;

	while ((match = pattern.exec(source))) {
		const callOpen = source.indexOf('(', match.index);
		const objectOpen = source.indexOf('{', callOpen + 1);
		if (objectOpen < 0) continue;

		const objectClose = matching(source, objectOpen);
		if (objectClose < 0) continue;

		const options = splitPropertyEntries(source, objectOpen, objectClose);
		for (const option of options) {
			const optionKey = keyInfo(option.text);
			if (!optionKey || !['state', 'computed', 'methods'].includes(optionKey.name)) continue;

			const optionEntry = option.text;
			let range;

			if (optionKey.name === 'state') range = stateObjectRange(source, optionEntry, option.start);
			else range = objectRangeFromOption(source, optionEntry, option.start);
			if (!range) continue;

			for (const property of splitPropertyEntries(source, range.open, range.close)) {
				const key = keyInfo(property.text);
				if (!key) continue;
				const start = property.start + key.start;
				declarations.push({ name: key.name, namespace: optionKey.name, componentStart: objectOpen, start, end: start + key.name.length });
			}
		}
	}

	return declarations;
}

/**
 * Collects source locations for template-visible component members, including
 * statically declared nested state properties.
 *
 * @param {string} source JavaScript or TypeScript source text.
 * @returns {Array<{name: string, path: string[], namespace: string, componentStart: number, componentEnd: number, start: number, end: number}>} Member definitions.
 */
function componentDefinitions(source) {
	const definitions = [];
	const pattern = /\bcreateComponent\s*\(/g;
	let match;

	while ((match = pattern.exec(source))) {
		const callOpen = source.indexOf('(', match.index);
		const objectOpen = source.indexOf('{', callOpen + 1);
		if (objectOpen < 0) continue;

		const objectClose = matching(source, objectOpen);
		if (objectClose < 0) continue;

		const addState = (open, close, path = []) => {
			for (const property of splitPropertyEntries(source, open, close)) {
				const key = keyInfo(property.text);
				if (!key) continue;

				const memberPath = [...path, key.name];
				const start = property.start + key.start;

				// entryStart/entryEnd cover the full property entry so Peek Definition
				// can show multi-line object/function bodies, not only the name line.
				const entryStart = property.start;
				const entryEnd = property.start + property.text.length;
				
				definitions.push({
					name: key.name, path: memberPath, namespace: 'state',
					componentStart: objectOpen, componentEnd: objectClose,
					start, end: start + key.name.length, entryStart, entryEnd
				});
				
				const colon = property.text.indexOf(':', key.start + key.name.length);
				if (colon < 0) continue;

				const value = property.text.slice(colon + 1);
				const leading = value.search(/\S/);
				if (leading < 0) continue;

				const valueStart = property.start + colon + 1 + leading;
				let nestedOpen = valueStart;
				let nestedClose = source[nestedOpen] === '{' ? matching(source, nestedOpen) : -1;

				if (source[nestedOpen] === '[') {
					const arrayClose = matching(source, nestedOpen, '[', ']');

					if (arrayClose > nestedOpen) {
						for (let cursor = nestedOpen + 1; cursor < arrayClose; cursor++) {
							if (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === '`') { cursor = skipQuoted(source, cursor, source[cursor]) - 1; continue; }
							if (source[cursor] === '/' && source[cursor + 1] === '*') { const end = source.indexOf('*/', cursor + 2); cursor = end < 0 ? arrayClose : end + 1; continue; }
							if (source[cursor] === '/' && source[cursor + 1] === '/') { const end = source.indexOf('\n', cursor + 2); cursor = end < 0 ? arrayClose : end; continue; }
							if (source[cursor] === '{') { nestedOpen = cursor; nestedClose = matching(source, nestedOpen); break; }
						}
					}
				}

				if (nestedClose > nestedOpen) addState(nestedOpen, nestedClose, memberPath);
			}
		};

		for (const option of splitPropertyEntries(source, objectOpen, objectClose)) {
			const optionKey = keyInfo(option.text);
			if (!optionKey || !['state', 'computed', 'methods'].includes(optionKey.name)) continue;

			const range = optionKey.name === 'state'
				? stateObjectRange(source, option.text, option.start)
				: objectRangeFromOption(source, option.text, option.start);
			
			if (!range) continue;

			if (optionKey.name === 'state') {
				addState(range.open, range.close);
				continue;
			}

			for (const property of splitPropertyEntries(source, range.open, range.close)) {
				const key = keyInfo(property.text);
				if (!key) continue;

				const start = property.start + key.start;
				const entryStart = property.start;
				const entryEnd = property.start + property.text.length;
				
				definitions.push({
					name: key.name, path: [key.name], namespace: optionKey.name,
					componentStart: objectOpen, componentEnd: objectClose,
					start, end: start + key.name.length, entryStart, entryEnd
				});
			}
		}
	}
	
	return definitions;
}

module.exports = { componentForTemplate, componentDeclarations, componentDefinitions, arrayItemForExpression, inferType };
