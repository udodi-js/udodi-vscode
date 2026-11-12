const assert = require('node:assert/strict');
const test = require('node:test');
const { cursorContext, cssTemplateContext, findTemplates, parseForAttribute } = require('../../language/context');

test('finds only html and css tagged templates, not ordinary literals or comments', () => {
	const source = [
		'// html`<p>@text</p>`',
		'const message = `ordinary ${name}`;',
		'const view = html`<p @text="user.name"></p>`;',
		'const style = css`.button { color: red; }`;'
	].join('\n');
	assert.deepEqual(findTemplates(source).map(template => template.tag), ['html', 'css']);
});

test('detects directive-value context and leaves template interpolation to JavaScript', () => {
	const source = 'const view = html`<p @text="user.name"></p><p>${user.name}</p>`;';
	const valueOffset = source.indexOf('user.name');
	const valueContext = cursorContext(source, valueOffset + 'user.name'.length);
	assert.equal(valueContext.kind, 'value');
	assert.equal(valueContext.directive, '@text');

	const interpolationOffset = source.lastIndexOf('user.name') + 'user.name'.length;
	assert.equal(cursorContext(source, interpolationOffset), undefined);
});

test('parses @for declarations from an attribute value or opening tag', () => {
	assert.deepEqual(parseForAttribute('item index items'), {
		item: 'item', index: 'index', expression: 'items'
	});
	assert.deepEqual(parseForAttribute('<li @for="item index items:user.name">'), {
		item: 'item', index: 'index', expression: 'items:user.name'
	});
});

test('does not return Udodi context for ordinary JavaScript template strings', () => {
	const source = 'const message = `<div @text="value"></div>`;';
	assert.equal(cursorContext(source, source.indexOf('@text')), undefined);
});

test('finds CSS template context and masks interpolations without shifting offsets', () => {
	const source = 'const style = css`\n.card { color: ${theme.color}; }\n`;';
	const propertyOffset = source.indexOf('color');
	const context = cssTemplateContext(source, propertyOffset);
	assert.equal(context.kind, 'css');
	assert.equal(context.text.includes('${theme.color}'), false);
	assert.equal(context.text.indexOf('color'), propertyOffset - context.template.start);
	assert.equal(context.text.split('\n').length, 3);

	const interpolationOffset = source.indexOf('theme') + 2;
	assert.equal(cssTemplateContext(source, interpolationOffset), undefined);
});
