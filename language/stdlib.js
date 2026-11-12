// Public helpers exported by packages/stdlib/index.js in the Udodi runtime.
module.exports = [
	{ name: 'trim', signature: 'trim(value)', description: 'Trims whitespace from the beginning and end of a value.' },
	{ name: 'get', signature: 'get(collection, key)', description: 'Returns a value from an Array, Map, Set, or Object using the provided key.' },
	{ name: 'upper', signature: 'upper(value)', description: 'Converts a value to uppercase.' },
	{ name: 'lower', signature: 'lower(value)', description: 'Converts a value to lowercase.' },
	{ name: 'capitalise', signature: 'capitalise(value)', description: 'Capitalizes the first character of every whitespace-delimited word.' },
	{ name: 'size', signature: 'size(collection)', description: 'Returns the size of an Array, Map, Set, or Object.' },
	{ name: 'negate', signature: 'negate(value)', description: 'Returns the boolean negation of a value.' },
	{ name: 'n', signature: 'n(value)', description: 'Alias for negate(value).' }
];
