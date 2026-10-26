# Shared CSS extraction plan

Status: implemented, 23 October 2026. This document retains the original design;
see [shared styles](shared-styles.md) for the implemented interface and usage.

Make ordinary actions and form controls consistent across the application by
giving their appearance one shared owner. Preserve the current dark theme,
compact layouts, native HTML semantics, and component behavior. Normalizing
accidental differences in ordinary controls is part of the work.

## Current structure

- [App.vue](../src/App.vue) owns global document styling and four theme variables,
  alongside application layout rules. [main.ts](../src/main.ts) currently imports
  no stylesheet.
- [EnvironmentManager.vue](../src/components/EnvironmentManager.vue),
  [ProtobufManager.vue](../src/components/ProtobufManager.vue),
  [ImportExport.vue](../src/components/ImportExport.vue), and
  [RequestEditor.vue](../src/components/RequestEditor.vue) repeat the standard
  button foundation: 12px type, approximately 7px by 9px padding, a dark surface,
  a thin border, and a 6px radius. Hover, focus, and disabled rules vary.
- [CollectionManager.vue](../src/components/CollectionManager.vue) and
  [HistoryPanel.vue](../src/components/HistoryPanel.vue) use smaller sidebar
  controls. This is a useful density distinction to represent explicitly.
- [RequestFields.vue](../src/components/RequestFields.vue),
  [AuthEditor.vue](../src/components/AuthEditor.vue), and
  [KeyValueEditor.vue](../src/components/KeyValueEditor.vue) reach through
  [VariableInput.vue](../src/components/VariableInput.vue) with `:deep(input)` to
  repeat input styling. VariableInput already forwards `$attrs` to its input.
- Link-style environment actions and visually hidden text also have duplicated
  rules. Tabs, tree rows, menus, and CodeMirror controls have specialized styling.

## Proposed interface and ownership

Use opt-in CSS classes on existing native elements. This change needs shared
appearance but introduces no shared interaction or state, so a Vue button wrapper
would add an unnecessary forwarding boundary for refs, events, and attributes.

```html
<button type="button" class="ui-button">Cancel</button>
<button type="button" class="ui-button ui-button--primary">Send</button>
<button type="button" class="ui-button ui-button--danger">Delete</button>
<button type="button" class="ui-button ui-button--subtle">Find</button>
<button type="button" class="ui-button ui-button--link">Edit environment</button>
<button type="button" class="ui-button ui-button--compact">New request</button>
<input class="ui-input" type="text" />
<select class="ui-input ui-input--compact">...</select>
```

| Interface | Contract |
| --- | --- |
| `ui-button` | Ordinary action styling, including neutral appearance, typography, padding, border, radius, hover, active, keyboard focus, and disabled states. |
| `ui-button--primary` | Prominent action, initially Send. Owns its foreground, background, border, and interaction colors. |
| `ui-button--danger` | Destructive action using the shared destructive foreground. |
| `ui-button--subtle` | Transparent background with the ordinary control border, for toolbar actions. |
| `ui-button--link` | Underlined text action without ordinary padding or border, for contextual help. |
| `ui-button--compact` | Smaller typography and padding for dense controls; independent of appearance. |
| `ui-input` | Shared text/password/search/number input, select, and textarea appearance and focus/disabled states. Excludes checkboxes, radios, and file inputs. |
| `ui-input--compact` | Dense form-control metrics matching compact actions. |
| `ui-visually-hidden` | Shared accessible visually hidden text treatment. |

Appearance modifiers are mutually exclusive; the default needs no modifier.
Compact can combine with an appearance. Keep the initial interface limited to
these observed uses. Native attributes such as `disabled`, `type`, `aria-*`, and
`tabindex` continue to define semantics and behavior. A disabled button must not
receive enabled hover or active styling. Keep Send's running cursor in its local
state rule.

The classes own visual foundations. Component-scoped CSS owns widths, flex/grid
placement, spacing between controls, responsive arrangement, text truncation,
popup positioning, and specialized selection or interaction feedback.

## Stylesheet structure

| Proposed file | Responsibility |
| --- | --- |
| `src/styles/index.css` | Single entry point importing tokens, base, and controls in that order. |
| `src/styles/tokens.css` | Semantic custom properties for shared colors, control typography, radii, padding, focus ring, and disabled opacity. |
| `src/styles/base.css` | Existing document defaults from App and the visually hidden utility. |
| `src/styles/controls.css` | The documented opt-in button and form-control classes. |

Import the entry point in main.ts before App and in
[tests/setup.ts](../tests/setup.ts) for standalone component consumers. Shared
styles must not depend on mounting App. Keep application layout styles and their
current scoping in App; this extraction does not change layout ownership.

Start tokens from the existing palette. Distinguish the shell border (`#263142`)
from the control border (`#2b3545`), and focus accent (`#8baaff`) from the filled
primary action (`#9bb8ff`). Use semantic names such as `--color-text`,
`--color-muted`, `--color-surface`, `--color-control-border`, `--color-focus`, and
`--control-radius`. Replace the old App variable names during migration.
Do not turn every one-off spacing or illustration color into a token.

Use class selectors with low specificity. Remove old scoped element rules when
adopting shared classes, since Vue's scoped selectors can otherwise override the
new foundation. Avoid global button/input element styling, `!important`, and
component-name selectors inside the shared stylesheets.

## Migration sequence

1. **Establish the baseline and foundation.** Record representative current
   screens and control states. Add the shared files and imports. Move document
   defaults and existing theme variables out of App, then define the shared
   control classes. Agree on the ordinary and compact appearances using existing
   controls as references.
2. **Migrate ordinary actions.** Start with EnvironmentManager, ImportExport,
   and ProtobufManager because their foundations already match. Continue with
   RequestEditor Send/Cancel, App header/draft/history/recovery actions, and
   KeyValueEditor Add/Remove. Apply primary and destructive variants where the
   current action already has that meaning. Remove their duplicate visual rules
   in the same change. Keep ImportExport's file-selection label and native file
   input association intact when sharing its button-like appearance.
3. **Migrate form controls at their owning element.** Put `ui-input` on
   VariableInput's native input, retaining `$attrs` forwarding and invalid-state
   feedback. Callers can supply a compact modifier through the existing class
   forwarding. Migrate native inputs/selects/textareas in managers, authentication,
   history filters, QuickOpen, and ProtobufBindingPicker. Remove repeated parent
   `:deep(input)` foundations, retaining URL/method-specific sizing, method color,
   and disabled-row presentation.
4. **Cover compact and contextual actions.** Migrate collection/history action
   controls to the compact size, BodyText toolbar actions to the subtle appearance,
   and both environment-help actions to the link appearance. Use the shared
   visually hidden class where semantics match. Keep BodyText's responsive
   toolbar sizing and segmented Pretty/Raw geometry and selection rules local.
5. **Connect specialized surfaces and remove leftovers.** Reuse semantic tokens
   in tabs, tree/history rows, menus, response metadata, and editor themes where
   they represent the same meaning. Preserve their custom geometry and behavior.
   Search for duplicate migrated declarations and inspect any remaining visual
   overrides. Preserve cross-component layout rules such as RequestEditor's
   compact response presentation and App's sidebar scrollport relationship.
6. **Document the finished boundary.** Add `doc/shared-styles.md` with examples,
   variants, import requirements, and rules for local overrides. Add a styling
   section to [doc/architecture.md](architecture.md); the root architecture file
   already points there. Record deliberate specialized exceptions and link this
   proposal to the implemented documentation.

Each migration group should leave its controls fully functional and remove the
old foundation immediately, so there is one effective owner of migrated styles.

## Boundaries requiring care

- Preserve tab keyboard navigation, reordering, selection, and close controls;
  tree rows, history cards, menu items, and suggestion options remain specialized
  controls. Their shared colors can come from tokens without adopting ordinary
  button padding or borders.
- BodyText and CollectionManager teleport menus to `body`. Shared tokens must be
  available at `:root`; shared classes must work outside a component ancestor.
- Preserve the existing `--body-text-*` customization interface. Use shared tokens
  as its fallback values in BodyText and
  [textEditor.ts](../src/components/textEditor.ts), keeping editor-specific
  selectors, syntax colors, and layout in the editor subsystem.
- Keep focus offsets local where clipping requires inset rings, especially tabs
  and tree rows. Ordinary controls share a visible default focus ring.
- Retain ImportExport's monospace cURL/JSON textarea typography, line height, and
  resize behavior when adopting the input foundation. Content-specific typography
  remains a local responsibility.
- Preserve input attributes, accessible names, refs, form submission, completion,
  validation, and focus restoration. Avoid introducing style-only component props
  or new mutable state.

## Verification and completion criteria

Run `pnpm test` and `pnpm build` after migration. Existing component contracts
already exercise Send/Cancel, disabled controls, forms, menus, dialogs, and focus
restoration. Add interface tests only if a changed boundary exposes a behavior
gap; avoid tests that merely assert CSS class strings or duplicate declarations.

Use real-browser visual checks because the current Vitest environment is jsdom.
Compare standard and compact controls in their default, hover, active,
focus-visible, and disabled states, including primary/destructive actions and
invalid inputs. Cover the request composer, collection/history sidebars,
environment/import/protobuf panels, QuickOpen, BodyText menus, and editor Find.
Check normal and narrow/short windows, keyboard traversal, long labels, native
dialogs, and teleported menus for clipping, overflow, and visible focus.

The extraction is complete when ordinary controls share the documented classes,
changing a shared visual value updates all intended consumers, migrated
components contain only justified contextual overrides, and existing interaction
contracts and browser checks pass. Runtime behavior, persistence, and native Rust
interfaces require no changes.
