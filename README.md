# Udodi for Visual Studio Code

[![License: MIT](https://img.shields.io/github/license/udodi-js/udodi-vscode)](https://github.com/udodi-js/udodi-vscode/blob/main/LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/udodi-js/udodi-vscode/ci.yml?branch=main)](https://github.com/udodi-js/udodi-vscode/actions)

Language support for Udodi templates in JavaScript, JSX, TypeScript, and TSX files.

## Features

- HTML and CSS syntax embedding in **html\``** and **css\``** tagged templates.
- Udodi directive highlighting and snippets.
- An LSP server for CSS property/value completion and documentation hover in `css` templates, plus Udodi directive, event, component-member completion, hover, and conservative event-binding diagnostics in `html` templates.
- Ordinary JavaScript template literals are left to the host language service.

```js
const Counter = createComponent({
  template: html`
    <button @on="click=increment"><span @text="count"></span></button>
  `,

  style: css`
    .counter { padding: 1rem; }
  `
});
```

The template DSL uses Udodi syntax such as `user.name`, `formatDate:createdAt`, `name | capitalise`, and `isActive=>'active'`. Event bindings use `event.modifier=handler` when a modifier is needed, for example `click.prevent=save`. Handler names are not treated as JavaScript calls.

## Install

Install **Udodi** from the Visual Studio Marketplace after publication, or package this repository locally with `npm run package` and install the generated VSIX. Marketplace publication is not configured by this repository.

## Compatibility and limitations

The extension targets JavaScript and TypeScript host documents on VS Code `^1.146.0`. It does not resolve component state or method types, and it does not run Udodi's compiler against templates. Diagnostics are limited to clearly malformed event binding entries.

The extension models the public Udodi template and form documentation. The runtime parser under `packages/core` is implementation code from the separate Udodi repository, so this extension does not import it or depend on private source paths.

## Development

```sh
npm ci
npm test
npm run build
```

Press F5 to launch an Extension Development Host. The extension starts its language server over IPC. The server's scanner recognizes only `html` and `css` tagged templates, so other template literals retain normal JavaScript or TypeScript behavior.

See [docs/architecture.md](docs/architecture.md) for the grammar and LSP design. Report issues at [github.com/udodi-js/udodi-vscode/issues](https://github.com/udodi-js/udodi-vscode/issues).

See [docs/testing.md](docs/testing.md) for the automated test commands and manual TextMate scope-inspection checklist.

## License

MIT. See [LICENSE](LICENSE).
