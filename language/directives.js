// Directive names and descriptions checked against the Udodi template and forms docs.
module.exports = [
	['@text', 'Bind an element’s text content to a template expression.'],
	['@bind', 'Keep a form control synchronized with component data.'],
	['@on', 'Bind one or more DOM events to component handlers.'],
	['@ref', 'Register a named DOM element reference.'],
	['@if', 'Conditionally render an element.'],
	['@elseif', 'Add a conditional rendering branch.'],
	['@else', 'Add the fallback conditional branch.'],
	['@show', 'Toggle visibility while keeping the element mounted.'],
	['@for', 'Render an element for each item in a collection.'],
	['@key', 'Provide a stable key for list reconciliation.'],
	['@class', 'Apply static or reactive class values.'],
	['@style', 'Apply static or reactive inline styles.'],
	['@attr', 'Bind one or more HTML attributes reactively.'],
	['@teleport', 'Render template content at another DOM target.'],
	['@form', 'Connect a form to Udodi form state.'],
	['@validate', 'Run validation for a form field.'],
	['@submit', 'Handle a validated form submission.'],
	['@trigger', 'Configure when a form field should be validated.']
].map(([name, description]) => ({ name, description }));
