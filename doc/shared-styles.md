# Shared styles

[src/styles/index.css](../src/styles/index.css) loads the shared theme, document
defaults, and opt-in native controls. It is imported by
[main.ts](../src/main.ts) and [tests/setup.ts](../tests/setup.ts), so component
presentation does not depend on mounting App.

## Native control interface

```html
<button type="button" class="ui-button">Cancel</button>
<button type="button" class="ui-button ui-button--primary">Send</button>
<button type="button" class="ui-button ui-button--danger">Delete</button>
<button type="button" class="ui-button ui-button--subtle">Find</button>
<button type="button" class="ui-button ui-button--link">Edit environment</button>
<button type="button" class="ui-button ui-button--compact">New request</button>
<input type="text" class="ui-input" />
<select class="ui-input ui-input--compact">...</select>
```

`ui-button` owns neutral appearance, typography, padding, radius, hover, active,
keyboard focus, and disabled presentation. Choose at most one appearance modifier:
`--primary` for prominent actions, `--danger` for destructive actions, `--subtle`
for transparent bordered toolbar actions, or `--link` for contextual text actions.
`--compact` adjusts density and can combine with any appearance. Always retain
the base class. Native attributes own behavior; specify `type="button"` unless
form submission is intended. Disabled actions receive no enabled hover/active
appearance. Send retains its local running cursor.

`ui-input` styles text/password/search/number inputs, selects, and textareas.
`ui-input--compact` supplies smaller metrics. Width, textarea resize behavior,
and content-specific typography belong to the component. Checkboxes, radio
buttons, and file inputs retain native styling. ImportExport's file label uses
the button appearance while retaining its label and input association.

[VariableInput.vue](../src/components/VariableInput.vue) applies `ui-input` to
its native input and forwards caller attributes there. For a compact field,
pass `class="ui-input--compact"` to VariableInput; Vue merges it with the base
class. Preserve this forwarding for validation, accessible names, and input
attributes. Avoid parent `:deep(input)` rules for the shared foundation.

`ui-visually-hidden` retains text for assistive technology while hiding its
visual box. Apply it directly to labels, announcements, or captions. Local
styles must not override its padding, margin, border, or positioning.

## Tokens and local styling

[tokens.css](../src/styles/tokens.css) defines semantic custom properties at
`:root`, making them available to native dialogs and menus teleported to body.
Change shared control appearance in [controls.css](../src/styles/controls.css).
Document defaults and the hidden-text utility live in
[base.css](../src/styles/base.css).

Use `--color-background` for the canvas, `--color-panel` for grouped surfaces,
and `--color-control` for inputs and neutral buttons. `--color-surface` remains
an alias of the panel surface for existing body themes. Use `--color-border`
for decorative edges and separators; `--color-control-border` retains that
quiet appearance for existing specialized surfaces. `--color-interactive-border`
provides the stronger outline for editable controls and buttons without
brightening every panel boundary. BodyText continues to respect explicit
`--body-text-border` overrides for its toolbar controls.

`--color-selected` and `--color-selected-border` pair a selected fill with an
accent edge across tabs and navigation. `--color-focus` is the focus accent;
`--color-primary` is the filled
action background. Control metrics, compact metrics, focus ring dimensions,
and disabled opacity are tokens too. One-off layout values stay local.

Standard controls use 13px text and compact controls use 12px. With the default
palette, interactive outlines have at least 3.14:1 contrast across enabled
control states. The darker CodeMirror selection background preserves at least
4.53:1 contrast for default JSON syntax colors.

Components own layout, responsive arrangement, widths, truncation, and popup
positioning. They can override shared appearance only for a concrete contextual
need, such as monospace cURL text or BodyText's existing `--body-text-*` theme.
Keep such overrides next to their purpose in the component. Remove the old scoped
foundation when adopting a shared class; scoped element selectors otherwise
override shared classes. Do not add global element styling or `!important`.

Tabs, request settings tabs, tree rows, history cards, menu rows, suggestion
options, and CodeMirror retain their specialized geometry and interaction
presentation. They consume common palette tokens. BodyText and textEditor keep
their existing body theme variables with shared-token fallbacks; syntax colors
and editor layout remain in the editor subsystem. Inset focus rings remain local
where pane clipping requires them.

Essential request labels use at least 12px text: method badges in the collection
tree, request address labels, settings tabs, and content-type context. Tree names
use 13px text while retaining the existing row spacing. These component-specific
sizes leave compact auxiliary controls available without shrinking the information
needed to choose or send a request.

[RequestTarget.vue](../src/components/RequestTarget.vue) separates the environment
from a full-width destination line. The resolved URL uses 13px monospace text in
the main text color. Long URLs scroll horizontally, and the URL itself accepts
keyboard focus so its complete value remains reachable in narrow panes.
Environment names and validation messages wrap instead of being truncated.

## Verification

Run `pnpm test` for behavior contracts and `pnpm build` for Vue/TypeScript and
stylesheet bundling. Use a real browser for computed appearance, focus rings,
hover/active/disabled states, responsive layout, and teleported menus; jsdom
does not verify visual layout. Avoid tests that merely enumerate CSS classes.
