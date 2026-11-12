const fs = require('node:fs');
const path = require('node:path');

const files = [
	'package.json',
	'syntaxes/udodi-html.tmLanguage.json',
	'syntaxes/udodi-css.tmLanguage.json',
	'snippets/html.json',
	'snippets/css.json'
];

for (const file of files) {
	JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
}
process.stdout.write(`Validated ${files.length} JSON files.\n`);
