# Architecture

The extension keeps JavaScript and TypeScript as the host languages. Two TextMate injections recognize `html` and `css` tagged templates and embed HTML or CSS. Ordinary template literals are not registered as Udodi regions.

The extension starts `server/server.js` as an IPC language server through `vscode-languageclient`. It uses Microsoft's `vscode-css-languageservice` for CSS completion and documentation hover inside `css` tagged templates. CSS template interpolation is masked without shifting offsets, and JavaScript interpolation positions are left to the host language service. The same server provides Udodi-aware completion, hover, definition, and diagnostics in HTML template values.

## DSL model

Directive names and descriptions are centralized in `language/directives.js`. Event names and runtime-supported modifiers are listed in `language/events.js`; the modifier list follows `packages/core/modifiers.js` in the Udodi runtime. The public event form (`click.prevent=save`) is also the form the LSP completes and checks. The runtime adapts that shorthand in `packages/runtime/bindDOM.js` before passing `on[click.prevent]=save` to the core parser. DSL forms follow the public template docs: paths (`user.name`), colon calls (`formatDate:createdAt`), pipelines (`name | capitalise`), conditionals (`active=>'yes'`), named bindings, and list declarations.

The extension does not load files from the runtime repository. The core parser and evaluator are private implementation modules and are not a supported editor API. The metadata is therefore checked against public documentation and the runtime's documented modifier set, avoiding an extension that only works when both repositories are checked out side by side.

## Current server features

- Directive completions after `@` in an HTML tag.
- Event names and modifiers in `@on` values.
- CSS property, value, selector, and at-rule completion plus CSS documentation hover in `css` templates.
- Hover descriptions for directives, known DOM events, and supported modifiers.
- Completion and hover for same-file component state, computed values, and methods.
- Go to Definition for same-file component members and nested statically declared state properties.
- Go to Definition from loop item and index references to their `@for` declarations, and from statically inferred item properties to array-literal object fields.
- Nested object-state completion and hover, such as `user.` suggesting the declared properties of `user`.
- `@for` source completions for component paths and functions, with array sources ranked first; loop item and index names are available for completion and hover inside the repeated element.
- Loop item property completion and hover when a source array or array-returning function has a statically readable object element shape.
- Error diagnostics for root component keys that collide across state, computed values, and methods, or use a runtime-reserved name.
- Static expression diagnostics for known missing object properties, non-callable values, likely function arity errors, and incompatible known result types for boolean and array directives.
- Warning for a completed `@on` binding without `=`.
- Event and modifier hover descriptions, plus completion and hover inside colon-call arguments.

Component and loop analysis is static and limited to declarations, array literals, and return expressions the server can read. Loop variables remain available even when the source type is unknown, but their item properties cannot be suggested or navigated to without a readable item shape. Go to Definition does not resolve imported or cross-file component members, dynamic expressions, or STDLIB helper implementations. Static expression checks report definite errors when the source shape is known and warnings for unresolved references that may be dynamic. Cross-file component member resolution and full Udodi expression type checking are outside the current server scope. Incomplete templates do not receive template syntax diagnostics; component key diagnostics are reported for statically analyzable component declarations.
