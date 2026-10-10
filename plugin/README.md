# Diff view

Generated from the `panel-basic` template.

## Contributions

- Command `plugin.open` opening a panel from `renderer/index.html`

## Develop

1. Open the Plugins page and use **Load development plugin**, pointing at this
   directory. PI-Desktop reloads the plugin whenever you save a file here.
2. Verify the contributions from the command palette.
3. Validate and package:

```bash
pnpm pi-plugin check .
pnpm pi-plugin pack .
# writes dist/local.diff-view-0.1.0.piplug
```

Install the resulting `.piplug` from the Plugins page to test it the way a
user would.

### Panel top drag band

PI-Desktop reserves exactly a transparent 46px frameless drag band above panel
content and renders a minimal fixed three-button window-control capsule in its
top-right corner. Normal-flow content is offset automatically. The panel title,
toolbar, and every other visible surface belong to the plugin. Development
panels show a reminder that the top 46px is not clickable outside the capsule.
For `position: fixed` or `position: sticky` content, use
`top: var(--pi-plugin-titlebar-height, 46px)` and account for the same value
in viewport-height calculations. Add `-webkit-app-region: drag` to a
plugin-owned toolbar when it should move the window, and
`-webkit-app-region: no-drag` to controls inside it.
