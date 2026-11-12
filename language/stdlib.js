// Public helpers exported by packages/stdlib/index.js in the Udodi runtime.
module.exports = [
	{ name: 'trim', signature: 'trim(value)', params: 'value', returnType: 'string', description: 'Trims whitespace from the beginning and end of a value.' },
	{ name: 'get', signature: 'get(collection, key)', params: 'collection, key', returnType: 'unknown', description: 'Returns a value from an Array, Map, Set, or Object using the provided key.' },
	{ name: 'upper', signature: 'upper(value)', params: 'value', returnType: 'string', description: 'Converts a value to uppercase.' },
	{ name: 'lower', signature: 'lower(value)', params: 'value', returnType: 'string', description: 'Converts a value to lowercase.' },
	{ name: 'capitalise', signature: 'capitalise(value)', params: 'value', returnType: 'string', description: 'Capitalizes the first character of every whitespace-delimited word.' },
	{ name: 'size', signature: 'size(collection)', params: 'collection', returnType: 'number', description: 'Returns the size of an Array, Map, Set, or Object.' },
	{ name: 'negate', signature: 'negate(value)', params: 'value', returnType: 'boolean', description: 'Returns the boolean negation of a value.' },
	{ name: 'n', signature: 'n(value)', params: 'value', returnType: 'boolean', description: 'Alias for negate(value).' }
];
