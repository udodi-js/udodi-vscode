const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

suite('Udodi extension host', () => {
	let extension;
	const files = [];

	setup(async () => {
		extension = vscode.extensions.getExtension('udodi-js.udodi');
		assert.ok(extension, 'Udodi extension should be present in the test host');
		await extension.activate();
	});

	teardown(async () => {
		for (const file of files.splice(0)) {
			await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: false }).then(() => {}, () => {});
		}
	});

	/**
	 * Writes source to a temporary file and opens it in the Extension Host.
	 *
	 * @param {string} content JavaScript or TypeScript source to open.
	 * @param {string} [extension='js'] File extension that determines the VS Code language mode.
	 * @returns {Promise<import('vscode').TextDocument>} Opened editor document.
	 */
	async function openJavaScript(content, extension = 'js') {
		const file = path.join(os.tmpdir(), `udodi-test-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);
		files.push(file);
		await fs.writeFile(file, content, 'utf8');
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		await vscode.window.showTextDocument(document);
		return document;
	}

	/**
	 * Requests Udodi completions at the end of a marker substring in a document.
	 *
	 * @param {import('vscode').TextDocument} document Open editor document.
	 * @param {string} marker Unique source substring locating the cursor.
	 * @returns {Promise<import('vscode').CompletionItem[]>} Completion items returned by VS Code.
	 */
	async function completionsAt(document, marker) {
		const offset = document.getText().indexOf(marker) + marker.length;
		const position = document.positionAt(offset);
		const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, '@');
		return Array.isArray(result) ? result : (result?.items || []);
	}

	test('activates for JavaScript documents', async () => {
		assert.strictEqual(extension.isActive, true);
		const document = await openJavaScript('const template = html`<div></div>`;');
		assert.strictEqual(document.languageId, 'javascript');
	});

	test('offers Udodi directives inside html templates only', async function () {
		this.timeout(10000);
		const template = await openJavaScript('const view = html`<div @`;');
		let labels = [];
		for (let attempt = 0; attempt < 30 && !labels.includes('@text'); attempt++) {
			const items = await completionsAt(template, '<div @');
			labels = items.map(item => typeof item.label === 'string' ? item.label : item.label.label);
			if (!labels.includes('@text')) await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(labels.includes('@text'), `expected @text directive; received ${labels.join(', ')}`);

		const ordinary = await openJavaScript('const message = `<div @`;');
		const ordinaryItems = await completionsAt(ordinary, '<div @');
		const ordinaryLabels = ordinaryItems.map(item => typeof item.label === 'string' ? item.label : item.label.label);
		assert.ok(!ordinaryLabels.includes('@text'), 'ordinary template literals must not receive Udodi completions');
	});

	test('completes documented events and core-supported modifiers in TypeScript', async () => {
		const eventTemplate = await openJavaScript('const view = html`<button @on="cl"></button>`;', 'ts');
		assert.strictEqual(eventTemplate.languageId, 'typescript');
		let eventLabels = [];
		for (let attempt = 0; attempt < 30 && !eventLabels.includes('click'); attempt++) {
			const items = await completionsAt(eventTemplate, '@on="cl');
			eventLabels = items.map(item => typeof item.label === 'string' ? item.label : item.label.label);
			if (!eventLabels.includes('click')) await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(eventLabels.includes('click'), `expected click event; received ${eventLabels.join(', ')}`);

		const modifierTemplate = await openJavaScript('const view = html`<button @on="click.pr"></button>`;', 'ts');
		const modifiers = await completionsAt(modifierTemplate, '@on="click.pr');
		const modifierLabels = modifiers.map(item => typeof item.label === 'string' ? item.label : item.label.label);
		assert.ok(modifierLabels.includes('prevent'), `expected prevent modifier; received ${modifierLabels.join(', ')}`);
	});

	test('suggests STDLIB helpers at expression start and in pipelines, with hover docs', async function () {
		this.timeout(10000);
		const expression = await openJavaScript('const view = html`<p @text="up"></p>`;');
		let items = [];
		for (let attempt = 0; attempt < 30 && !items.some(item => item.label === 'upper'); attempt++) {
			items = await completionsAt(expression, '@text="up');
			if (!items.some(item => item.label === 'upper')) await new Promise(resolve => setTimeout(resolve, 100));
		}
		const upper = items.find(item => item.label === 'upper');
		assert.ok(upper, 'expected upper helper completion');
		assert.strictEqual(upper.detail, 'upper(value)');
		assert.strictEqual(upper.textEdit.newText, 'upper:');

		const pipeline = await openJavaScript('const view = html`<p @text="name | ca"></p>`;');
		const pipelineItems = await completionsAt(pipeline, '@text="name | ca');
		const capitalise = pipelineItems.find(item => item.label === 'capitalise');
		assert.ok(capitalise, 'expected capitalise helper in pipeline completion');
		assert.strictEqual(capitalise.textEdit.newText, 'capitalise');

		const helperDocument = await openJavaScript('const view = html`<p @text="upper:name"></p>`;');
		const source = helperDocument.getText();
		const helperOffset = source.indexOf('upper') + 1;
		let hovers = [];
		for (let attempt = 0; attempt < 30; attempt++) {
			hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', helperDocument.uri, helperDocument.positionAt(helperOffset));
			if (hovers?.some(hover => JSON.stringify(hover.contents).includes('upper(value)'))) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(hovers?.some(hover => hover.contents.map(item => typeof item === 'string' ? item : item.value).join('\n').includes('upper(value)')), 'expected helper signature and docs on hover');
	});

	test('shows @for item and index hover descriptions in scope-inspection fixture', async function () {
		this.timeout(10000);
		const fixture = await fs.readFile(path.join(__dirname, 'fixtures', 'scope-inspection.js'), 'utf8');
		const document = await openJavaScript(fixture);
		const source = document.getText();
		const loopStart = source.indexOf('@for="item index');
		assert.notStrictEqual(loopStart, -1, 'expected @for declaration in scope-inspection fixture');

		async function hoverTextAt(token) {
			const offset = source.indexOf(token, loopStart) + 1;
			let hovers = [];
			for (let attempt = 0; attempt < 30; attempt++) {
				hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, document.positionAt(offset));
				const text = hovers?.flatMap(hover => hover.contents).map(item => typeof item === 'string' ? item : item.value).join('\n') || '';
				if (text) return text;
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			return '';
		}

		assert.match(await hoverTextAt('item'), /item: object/);
		assert.match(await hoverTextAt('index'), /index: number/);
	});

	test('does not split quoted @on arguments containing spaces', async function () {
		this.timeout(10000);
		const fixture = await fs.readFile(path.join(__dirname, 'fixtures', 'scope-inspection.js'), 'utf8');
		const document = await openJavaScript(fixture);
		let diagnostics = [];
		for (let attempt = 0; attempt < 30; attempt++) {
			diagnostics = vscode.languages.getDiagnostics(document.uri);
			if (diagnostics.length) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(!diagnostics.some(diagnostic => diagnostic.code === 'event-binding-equals'), 'quoted handler arguments must remain part of the event binding');
		assert.ok(!diagnostics.some(diagnostic => diagnostic.code === 'non-callable-handler'), 'a documented component method with a quoted argument must be recognized as callable');
	});

	test('completes component state and computed values plus event handler methods', async () => {
		const source = `const Counter = createComponent({
			state() { return { count: 0 }; },
			computed: { total(ctx) { return ctx.count * 2; } },
			methods: { increment(event, step = 1) { this.count += step; } },
			template: html\`<button @on="click=inc" @text=""></button>\`,
		});`;
		const document = await openJavaScript(source);
		const expressionItems = await completionsAt(document, '@text="');
		const count = expressionItems.find(item => item.label === 'count');
		const total = expressionItems.find(item => item.label === 'total');
		assert.strictEqual(count?.detail, 'count: number');
		assert.strictEqual(total?.detail, 'total(ctx): number');

		const methodItems = await completionsAt(document, '@on="click=inc');
		const increment = methodItems.find(item => item.label === 'increment');
		assert.strictEqual(increment?.detail, 'increment(event, step = 1): function');
	});

	test('goes to component, nested state, and loop-variable definitions', async function () {
		this.timeout(10000);
		const source = `const View = createComponent({
			state: { user: { name: 'Ada' }, items: [{ label: 'One' }] },
			methods: { save(event, message) {} },
			template: html\`<p @text="user.name"></p><button @on="click=save:'hello'"></button><li @for="item index items"><span @text="item.label"></span><span @text="index"></span></li>\`,
		});`;
		const document = await openJavaScript(source);
		async function definitionAt(marker, positionInMarker = 0) {
			const markerOffset = source.lastIndexOf(marker) + positionInMarker;
			for (let attempt = 0; attempt < 30; attempt++) {
				const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, document.positionAt(markerOffset));
				const location = Array.isArray(result) ? result[0] : result;
				if (location) return location.targetRange ? location.targetRange.start : location.range.start;
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			return undefined;
		}
		const cases = [
			['user.name', 5, source.indexOf('name:')],
			['=save', 1, source.indexOf('save(')],
			['item.label', 0, source.indexOf('item index')],
			['item.label', 5, source.indexOf('label:')],
			['index"></span>', 0, source.indexOf('item index') + 'item '.length]
		];
		for (const [marker, positionInMarker, targetOffset] of cases) {
			assert.deepEqual(await definitionAt(marker, positionInMarker), document.positionAt(targetOffset), `expected ${marker} to resolve to its declaration`);
		}
	});

	test('provides CSS property completion and documentation hover in css templates', async function () {
		this.timeout(10000);
		const source = `const Card = createComponent({
			style: css\`
				.card {
					displ
				}
			\`,
			template: html\`<article class="card"></article>\`,
		});`;
		const document = await openJavaScript(source);
		const items = await completionsAt(document, 'displ');
		const display = items.find(item => item.label === 'display');
		assert.ok(display, `expected CSS display completion; received ${items.map(item => item.label).join(', ')}`);

		const hoverSource = `const Card = createComponent({
			style: css\`.card { display: flex; }\`,
			template: html\`<article class="card"></article>\`,
		});`;
		const hoverDocument = await openJavaScript(hoverSource);
		const cssPropertyOffset = hoverSource.indexOf('display') + 2;
		let hovers = [];
		for (let attempt = 0; attempt < 30; attempt++) {
			hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', hoverDocument.uri, hoverDocument.positionAt(cssPropertyOffset));
			const content = hovers?.flatMap(hover => hover.contents).map(item => typeof item === 'string' ? item : item.value).join('\n') || '';
			if (content.toLowerCase().includes('display')) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		const content = hovers?.flatMap(hover => hover.contents).map(item => typeof item === 'string' ? item : item.value).join('\n') || '';
		assert.ok(content.toLowerCase().includes('display'), 'expected CSS property documentation on hover');
	});

	test('warns about completed event bindings without equals and accepts valid bindings', async () => {
		const invalid = await openJavaScript('const view = html`<button @on="click"></button>`;');
		let invalidDiagnostics = [];
		for (let attempt = 0; attempt < 30 && !invalidDiagnostics.length; attempt++) {
			invalidDiagnostics = vscode.languages.getDiagnostics(invalid.uri);
			if (!invalidDiagnostics.length) await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(invalidDiagnostics.some(diagnostic => diagnostic.code === 'event-binding-equals'));

		const valid = await openJavaScript('const view = html`<button @on="click.prevent=save"></button>`;');
		await new Promise(resolve => setTimeout(resolve, 300));
		const validDiagnostics = vscode.languages.getDiagnostics(valid.uri);
		assert.ok(!validDiagnostics.some(diagnostic => diagnostic.code === 'event-binding-equals'));
	});
});
