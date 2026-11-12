# Testing the extension

Run the fast checks first, then the VS Code Extension Host tests:

```sh
npm run test:unit
npm run build
npm test
```

`npm run test:unit` checks tagged-template and cursor-context detection, including CSS interpolation masking. `npm test` opens VS Code 1.146.0 as an Extension Development Host and checks activation, HTML directive/event completion, component-member completion, CSS property completion and hover, ordinary-template isolation, and event-binding diagnostics. The first run downloads the VS Code test runtime. On Windows, a sandbox may need permission to run the downloaded host because Electron's renderer subprocesses use AppContainer isolation.

## Inspect highlighting and embedding manually

Automated Extension Host tests cannot assert TextMate token scopes through the public extension API. Verify those in VS Code itself:

1. Run `npm install`, open this repository in VS Code, and press **F5** to start the Extension Development Host.
2. Open `test/fixtures/scope-inspection.js` in the new window.
3. Run **Developer: Inspect Editor Tokens and Scopes** on the `html` tag, an HTML element name, `@text`, `|`, the `css` tag, a CSS property, and the `${ordinaryMessage}` interpolation.
4. Confirm the HTML and CSS sections have their embedded-language scopes, Udodi directive names/operators have Udodi scopes, and the interpolation returns to JavaScript scopes.
5. Inspect the ordinary `ordinaryMessage` template too; it should have normal JavaScript template scopes and no Udodi-specific completion.
6. In the same fixture, try HTML tag completion/Emmet, matching brackets, HTML comment toggling, and CSS property completion inside their respective tagged templates.
7. Repeat with a `.ts` fixture and a `.tsx` fixture before changing language grammars.

## Manual language-server smoke checks

In the Extension Development Host, verify these editing actions:

- Type `<div @` inside `html` and invoke completion; Udodi directive names should appear.
- Type `@on="cl` and invoke completion; event names including `click` should appear.
- Type `@on="click.pr`; `prevent` should be offered. Check the other core-supported modifiers as well.
- Hover `@text`, `click`, and `.prevent` for their descriptions.
- In `style: css\`...\``, type `displ` in a rule and confirm `display` is suggested; hover `display` in a completed declaration to read its CSS documentation.
- In a CSS template containing `${...}`, confirm CSS completion works around the interpolation while JavaScript completion works inside it.
- Use `@on="click"` to see the conservative missing-`=` warning, then change it to `@on="click=save"` and confirm the warning clears.
- Put the same `@` inside an ordinary JavaScript template literal; Udodi completion should not appear.
- Place the cursor in `${...}` within `html`; JavaScript completion should take over.

## Ready-to-advance gate

Before adding component-aware semantic features, require the unit suite, Extension Host suite, build checks, and the manual scope/embedding inspection above to pass. Record any unsupported syntax from a real Udodi project as a fixture so the parser and editor behavior can be extended from examples that are known to be valid.
