# Architecture

The extension keeps JavaScript and TypeScript as the host languages. Two TextMate injections recognize `html` and `css` tagged templates and embed HTML or CSS. Ordinary template literals are not registered as Udodi regions.

The extension starts `server/server.js` as an IPC language server through `vscode-languageclient`. It uses Microsoft's `vscode-css-languageservice` for CSS completion and documentation hover inside `css` tagged templates. CSS template interpolation is masked without shifting offsets, and JavaScript interpolation positions are left to the host language service. The same server provides Udodi-aware completion, hover, and diagnostics in HTML template values.

## DSL model

Directive names and descriptions are centralized in `language/directives.js`. Event names and runtime-supported modifiers are listed in `language/events.js`; the modifier list follows `packages/core/modifiers.js` in the Udodi runtime. The public event form (`click.prevent=save`) is also the form the LSP completes and checks. The runtime adapts that shorthand in `packages/runtime/bindDOM.js` before passing `on[click.prevent]=save` to the core parser. DSL forms follow the public template docs: paths (`user.name`), colon calls (`formatDate:createdAt`), pipelines (`name | capitalise`), conditionals (`active=>'yes'`), named bindings, and list declarations.

The extension does not load files from the runtime repository. The core parser and evaluator are private implementation modules and are not a supported editor API. The metadata is therefore checked against public documentation and the runtime's documented modifier set, avoiding an extension that only works when both repositories are checked out side by side.

## Current server features

- Directive completions after `@` in an HTML tag.
- Event names and modifiers in `@on` values.
- CSS property, value, selector, and at-rule completion plus CSS documentation hover in `css` templates.
- Hover descriptions for directives, known DOM events, and supported modifiers.
- Completion and hover for same-file component state, computed values, and methods.
- Warning for a completed `@on` binding without `=`.

Cross-file component member resolution and full Udodi expression type checking are outside the current server scope. Incomplete templates do not receive syntax diagnostics.
