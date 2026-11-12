const assert = require('node:assert/strict');
const test = require('node:test');
const { componentForTemplate, componentDefinitions } = require('../../language/components');

test('collects state, computed, and method members from the component enclosing a template', () => {
	const source = `const Counter = createComponent({
		state() {
			return { count: 0, title: 'Counter', active: true, rows: [] };
		},
		computed: {
			doubled(ctx) { return ctx.count * 2; },
		},
		methods: {
			increment(event, step = 1) { this.count += step; },
		},
		template: html\`<button @on="click=incr" @text="cou"></button>\`,
	});`;
	const offset = source.indexOf('cou') + 2;
	const members = componentForTemplate(source, offset);
	assert.deepEqual(members.map(member => [member.name, member.kind, member.type]), [
		['count', 'state', 'number'],
		['title', 'state', 'string'],
		['active', 'state', 'boolean'],
		['rows', 'state', 'array'],
		['doubled', 'computed', 'number'],
		['increment', 'method', 'function']
	]);
	assert.equal(members.at(-1).signature, 'increment(event, step = 1): function');
});

test('reads arrow-function state factories and does not cross into a neighboring component', () => {
	const source = `const First = createComponent({ state: () => ({ name: 'Ada' }), template: html\`<p @text="na"></p>\` });
	const Second = createComponent({ state: () => ({ count: 2 }), template: html\`<p></p>\` });`;
	const members = componentForTemplate(source, source.indexOf('na') + 1);
	assert.deepEqual(members.map(member => member.name), ['name']);
});

test('reads component methods preceded by JSDoc comments', () => {
	const source = `const Button = createComponent({
		methods: {
			/** Handler documentation. @param {MouseEvent} event @param {string} message */
			save(event, message) { return message; },
		},
		template: html\`<button @on="click.prevent=save:'for testing'"></button>\`,
	});`;
	const members = componentForTemplate(source, source.indexOf('save:') + 2);
	assert.deepEqual(members.map(member => [member.name, member.kind, member.params]), [
		['save', 'method', 'event, message']
	]);
});

test('collects root and nested state member definition offsets', () => {
	const source = `const View = createComponent({
		state: { user: { name: 'Ada' }, items: [{ label: 'One' }] },
		template: html\`<p @text="user.name"></p>\`,
	});`;
	const definitions = componentDefinitions(source);
	assert.ok(definitions.some(item => item.path.join('.') === 'user.name' && source.slice(item.start, item.end) === 'name'));
	assert.ok(definitions.some(item => item.path.join('.') === 'items.label' && source.slice(item.start, item.end) === 'label'));
});
