const stdlib = require('./stdlib');

/**
 * Splits expression text on a top-level operator while preserving operand offsets.
 *
 * @param {string} text Expression text.
 * @param {string} operator Top-level operator to split on.
 * @returns {Array<{text: string, start: number}>} Operand segments.
 */
function splitTopLevel(text, operator) {
	const parts = [];
	let start = 0;
	let quote = '';
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === quote) quote = '';
			continue;
		}
		if (char === '"' || char === "'") { quote = char; continue; }
		if (text.startsWith(operator, i)) {
			const part = text.slice(start, i).trim();
			if (part) parts.push({ text: part, start: start + text.slice(start, i).search(/\S/) });
			i += operator.length - 1;
			start = i + 1;
		}
	}
	const tail = text.slice(start).trim();
	if (tail) parts.push({ text: tail, start: start + text.slice(start).search(/\S/) });
	return parts;
}

/**
 * Looks up a component, loop, or standard-library symbol.
 *
 * @param {string} name Root identifier.
 * @param {Array<object>} members Visible component and loop members.
 * @returns {object | undefined} Symbol metadata.
 */
function findSymbol(name, members) {
	return members.find(member => member.name === name) || stdlib.find(helper => helper.name === name);
}

/**
 * Resolves a path and reports known missing properties or invalid traversal.
 *
 * @param {string} path Udodi path expression.
 * @param {Array<object>} members Visible symbols.
 * @param {number} sourceStart Absolute start offset of the path.
 * @param {(diagnostic: object) => void} report Diagnostic collector.
 * @returns {{type: string, symbol?: object, callable: boolean, returnType?: string} | undefined} Inferred path type.
 */
function resolvePath(path, members, sourceStart, report) {
	const segments = path.split('.');
	let symbol = findSymbol(segments[0], members);
	if (!symbol) {
		report({ code: 'unknown-reference', severity: 'warning', start: sourceStart, end: sourceStart + segments[0].length, message: `Unknown Udodi reference "${segments[0]}".` });
		return undefined;
	}
	if (symbol.kind === 'method' && symbol.returnType) {
		symbol = { ...symbol, type: symbol.returnType };
	}
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i];
		if (symbol.type === 'array' && /^\d+$/.test(segment) && symbol.element) {
			symbol = symbol.element;
			continue;
		}
		const children = symbol.children || [];
		if (symbol.shapeKnown && !children.some(child => child.name === segment)) {
			const prefix = segments.slice(0, i).join('.');
			const start = sourceStart + prefix.length + 1;
			report({ code: 'unknown-property', severity: 'error', start, end: start + segment.length, message: `Property "${segment}" does not exist on "${prefix}".` });
			return undefined;
		}
		if (['string', 'number', 'boolean', 'bigint', 'null'].includes(symbol.type)) {
			const prefix = segments.slice(0, i).join('.');
			const start = sourceStart + prefix.length + 1;
			report({ code: 'invalid-property-access', severity: 'error', start, end: start + segment.length, message: `Cannot access "${segment}" on a value of type ${symbol.type}.` });
			return undefined;
		}
		const child = children.find(item => item.name === segment);
		if (!child) return { type: 'unknown', callable: false };
		symbol = child;
	}
	const callable = symbol.kind === 'method' || symbol.type === 'function';
	const type = callable ? symbol.returnType || 'unknown' : symbol.type || 'unknown';
	return { type, symbol, callable, returnType: symbol.returnType };
}

/**
 * Infers a simple Udodi expression, validating paths and function calls.
 *
 * @param {string} text Expression source.
 * @param {Array<object>} members Visible component and loop members.
 * @param {number} sourceStart Absolute expression start offset.
 * @param {(diagnostic: object) => void} report Diagnostic collector.
 * @param {{eventInjected?: boolean}} [options] Event-handler call context.
 * @returns {{type: string, symbol?: object, callable: boolean} | undefined} Best-effort inferred result.
 */
function inferExpression(text, members, sourceStart, report, options = {}) {
	const source = text.trim();
	const trimOffset = text.indexOf(source);
	const offset = sourceStart + Math.max(0, trimOffset);
	if (!source) return undefined;
	if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(source)) return { type: 'string', callable: false };
	if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?n?$/i.test(source)) return { type: source.endsWith('n') ? 'bigint' : 'number', callable: false };
	if (source === 'true' || source === 'false') return { type: 'boolean', callable: false };
	if (source === 'null') return { type: 'null', callable: false };

	const pipeline = splitTopLevel(source, '|');
	if (pipeline.length > 1) {
		let result = inferExpression(pipeline[0].text, members, offset + pipeline[0].start, report, options);
		for (const step of pipeline.slice(1)) {
			let call = inferCall(step.text, members, offset + step.start, report, false);
			if (!call) {
				const resolved = resolvePath(step.text, members, offset + step.start, report);
				call = resolved ? { ...resolved, returnType: resolved.type } : undefined;
			}
			if (call && !call.callable) report({ code: 'non-callable-pipeline', severity: 'error', start: offset + step.start, end: offset + step.start + step.text.length, message: `Pipeline step "${step.text}" must be a function.` });
			result = call ? { type: call.returnType || 'unknown', symbol: call.symbol, callable: false } : result;
		}
		return result;
	}

	const conditional = splitTopLevel(source, '=>');
	if (conditional.length > 1) {
		const condition = inferExpression(conditional[0].text, members, offset + conditional[0].start, report, options);
		if (condition && condition.type !== 'unknown' && condition.type !== 'boolean') {
			report({ code: 'condition-not-boolean', severity: 'error', start: offset + conditional[0].start, end: offset + conditional[0].start + conditional[0].text.length, message: `Conditional expression requires a boolean condition; found ${condition.type}.` });
		}
		return inferExpression(conditional.slice(1).map(part => part.text).join('=>'), members, offset + conditional[1].start, report, options);
	}

	const call = inferCall(source, members, offset, report, options.eventInjected === true);
	if (call) return { type: call.returnType || 'unknown', symbol: call.symbol, callable: false };
	if (/^[\w$]+(?:\.[\w$]+)*$/.test(source)) return resolvePath(source, members, offset, report);
	return { type: 'unknown', callable: false };
}

/**
 * Checks a colon call and its path arguments.
 *
 * @param {string} text Call source.
 * @param {Array<object>} members Visible component and loop members.
 * @param {number} sourceStart Absolute call start offset.
 * @param {(diagnostic: object) => void} report Diagnostic collector.
 * @param {boolean} eventInjected Whether `@on` supplies the first argument.
 * @returns {{symbol?: object, callable: boolean, returnType?: string} | undefined} Call metadata; undefined when this is not a call.
 */
function inferCall(text, members, sourceStart, report, eventInjected) {
	const parts = splitTopLevel(text, ':');
	if (parts.length < 2) return undefined;
	const callee = parts[0];
	if (!/^[\w$]+(?:\.[\w$]+)*$/.test(callee.text)) return undefined;
	const rootName = callee.text.split('.')[0];
	const symbol = callee.text.includes('.') ? undefined : findSymbol(rootName, members);
	const calleeStart = sourceStart + callee.start;
	const resolvedCallee = callee.text.includes('.') ? resolvePath(callee.text, members, calleeStart, report) : undefined;
	let callable = Boolean((symbol && (symbol.kind === 'method' || symbol.type === 'function')) || resolvedCallee?.callable);
	if (!symbol) {
		if (!resolvedCallee) report({ code: 'unknown-function', severity: 'warning', start: calleeStart, end: calleeStart + callee.text.length, message: `Unknown Udodi function "${callee.text}".` });
		else if (!callable) report({ code: 'non-callable', severity: 'error', start: calleeStart, end: calleeStart + callee.text.length, message: `"${callee.text}" is a ${resolvedCallee.type}, not a function.` });
	} else if (!callable) {
		report({ code: 'non-callable', severity: 'error', start: calleeStart, end: calleeStart + callee.text.length, message: `"${callee.text}" is a ${symbol.type || 'value'}, not a function.` });
	}
	const args = parts.slice(1);
	for (const arg of args) inferExpression(arg.text, members, sourceStart + arg.start, report);
	if (callable && symbol.params !== undefined) {
		const params = symbol.params.split(',').map(param => param.trim()).filter(Boolean);
		const injected = eventInjected && symbol.kind === 'method' ? 1 : 0;
		const min = params.filter(param => param && !param.includes('=') && !param.startsWith('...')).length - injected;
		const max = params.some(param => param.startsWith('...')) ? Infinity : params.length - injected;
		if (args.length < Math.max(0, min) || args.length > Math.max(0, max)) {
			report({ code: 'argument-count', severity: 'warning', start: calleeStart, end: calleeStart + callee.text.length, message: `"${callee.text}" expects ${Math.max(0, min)}${max === min ? '' : `–${max === Infinity ? 'many' : Math.max(0, max)}`} explicit argument(s); received ${args.length}.` });
		}
	}
	return { symbol: symbol || resolvedCallee?.symbol, callable, returnType: symbol?.returnType || resolvedCallee?.returnType || (symbol?.kind === 'method' ? 'unknown' : symbol?.type) };
}

/**
 * Checks an expression's known result against a directive's expected type.
 *
 * @param {string} expression Udodi expression source.
 * @param {Array<object>} members Visible symbols.
 * @param {number} sourceStart Absolute expression offset.
 * @param {string | undefined} expectedType Optional expected result type.
 * @param {boolean} eventInjected True when checking an `@on` handler.
 * @returns {Array<{code: string, severity: string, start: number, end: number, message: string}>} Diagnostics.
 */
function checkExpression(expression, members, sourceStart, expectedType, eventInjected = false) {
	const diagnostics = [];
	const report = diagnostic => diagnostics.push(diagnostic);
	const result = inferExpression(expression, members, sourceStart, report, { eventInjected });
	if (expectedType && result && result.type !== 'unknown' && result.type !== expectedType) {
		diagnostics.push({
			code: 'expression-type-mismatch', severity: 'error', start: sourceStart, end: sourceStart + expression.length,
			message: `Expected an expression of type ${expectedType}; found ${result.type}.`
		});
	}
	return diagnostics;
}

/**
 * Checks whether an event-handler expression resolves to a callable function.
 *
 * @param {string} expression Event handler expression.
 * @param {Array<object>} members Visible symbols.
 * @param {number} sourceStart Absolute expression offset.
 * @returns {Array<object>} Handler diagnostics.
 */
function checkEventHandler(expression, members, sourceStart) {
	const diagnostics = [];
	const report = diagnostic => diagnostics.push(diagnostic);
	const text = expression.trim();

	if (!text) return diagnostics;
	
	if (splitTopLevel(text, '|').length > 1) {
		inferExpression(text, members, sourceStart, report, { eventInjected: true });
		return diagnostics;
	}

	const call = inferCall(text, members, sourceStart, report, true);
	if (call) {
		if (!call.callable) report({ code: 'non-callable-handler', severity: 'error', start: sourceStart, end: sourceStart + text.length, message: `Event handler "${text}" must call a function.` });
		return diagnostics;
	}

	const path = resolvePath(text, members, sourceStart, report);
	if (path && !path.callable) report({ code: 'non-callable-handler', severity: 'error', start: sourceStart, end: sourceStart + text.length, message: `Event handler "${text}" must resolve to a function.` });
	
	return diagnostics;
}

module.exports = { checkExpression, checkEventHandler };
