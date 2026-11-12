# Udodi for Visual Studio Code

[![License: MIT](https://img.shields.io/github/license/udodi-js/udodi-vscode)](https://github.com/udodi-js/udodi-vscode/blob/main/LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/udodi-js/udodi-vscode/ci.yml?branch=main)](https://github.com/udodi-js/udodi-vscode/actions)

Language support for Udodi templates in JavaScript, JSX, TypeScript, and TSX files.

## Features

- HTML and CSS syntax embedding in `html` and `css` tagged templates.
- Udodi directive highlighting and HTML/CSS snippets.
- CSS property, value, selector, and at-rule completion, plus CSS documentation hovers in `css` templates.
- Udodi directive, DOM event, and event modifier completion and hover in `html` templates.
- Component state, computed value, and method completion and hover for declarations in the same file.
- Go to Definition from template references to same-file component members, nested state properties, and `@for` item or index declarations.
- Nested object-state completion and hover. For example, typing `user.` can suggest properties declared in the component's `user` state object.
- `@for` source completion for component paths and functions. Loop item and index variables are suggested and described inside the repeated element; object item properties are available when the array shape can be inferred.
- Diagnostics for reserved and duplicate component names, missing properties on known object paths, non-callable values, likely argument-count mistakes, and expressions with the wrong known type for `@if`, `@show`, and `@for`.
- Hover documentation for each supported DOM event and `@on` modifier, plus completion through function arguments such as `save:user.name`.
- A warning when a completed `@on` binding omits `=`, such as `@on="click"`.
- Ordinary JavaScript template literals are left to the host language service.

```js
const Counter = createComponent({
  state() {
    return {
      count: 0,
      user: { name: 'Ada' }
    };
  },

  methods: {
    increment() { this.count += 1; }
  },

  template: html`
    <button @on="click=increment">
      <span @text="count"></span>
      <span @text="user.name"></span>
    </button>
  `,

  style: css`
    .counter { padding: 1rem; }
  `
});
```

The template DSL uses Udodi syntax such as `user.name`, `formatDate:createdAt`, `name | capitalise`, and `isActive=>'active'`. Event bindings use `event.modifier=handler` when a modifier is needed, for example `click.prevent=save`. Handler names are not treated as JavaScript calls.

## Install and publish

When published, install **Udodi** from the Visual Studio Marketplace. To install a local build, run `npm ci` followed by `npm run package`, then install the generated `.vsix` from the Extensions view using **Install from VSIX...**.

The release workflow publishes on version tags such as `v1.0.0`. It runs the test and build checks, creates a versioned VSIX, submits it to the Visual Studio Marketplace using OIDC, and attaches the VSIX to the GitHub Release for direct download. Marketplace publishing requires a matching Trusted Publisher policy for this repository and the `release.yml` workflow.

## Compatibility and limitations

The extension targets JavaScript and TypeScript host documents on VS Code `^1.145.0`. Component member inference and Go to Definition are static and limited to same-file declarations the extension can read. Definition navigation supports component state, computed values, methods, nested state properties, statically declared array-item properties, and loop item/index declarations. It does not resolve imported or cross-file symbols, dynamic expressions, or STDLIB helpers to their runtime implementation. It supports object-literal state properties, including nested objects, and infers broad display types from simple initializers. `@for` item-property inference works for statically readable array literals and function return values; loop variables remain available when the source type is unknown. This is not a full JavaScript/TypeScript type checker and the extension does not run Udodi's compiler against templates.

Diagnostics cover reserved and duplicate component keys, statically known missing object properties, non-callable values, likely function argument-count mistakes, expected boolean and array results, and completed event bindings that omit `=`. Unknown references are warnings because props and other dynamic values may not be visible to the extension. The analysis is best-effort and does not replace Udodi runtime validation.

The extension models the public Udodi template and form documentation. The runtime parser under `packages/core` is implementation code from the separate Udodi repository, so this extension does not import it or depend on private source paths.

## Development

```sh
npm ci
npm run test:all
npm run build
```

`npm run test:all` runs the unit suite and the VS Code Extension Host suite. Press F5 to launch an Extension Development Host for manual checks. The extension starts its language server over IPC. The server's scanner recognizes only `html` and `css` tagged templates, so other template literals retain normal JavaScript or TypeScript behavior. GitHub Actions runs the Extension Host tests under Xvfb so Linux runners have a virtual display.

See [docs/architecture.md](docs/architecture.md) for the grammar and LSP design. Report issues at [github.com/udodi-js/udodi-vscode/issues](https://github.com/udodi-js/udodi-vscode/issues).

See [docs/testing.md](docs/testing.md) for the automated test commands and manual TextMate scope-inspection checklist.

## License

MIT. See [LICENSE](LICENSE).
