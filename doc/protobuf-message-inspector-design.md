# Protobuf message inspector

Status: proposed design, 26 October 2026. The selected direction is a field tree
first, with an original `.proto` tab. This document describes planned behavior;
the application currently provides completion and model selection only.

## User experience

A request's selected protobuf message becomes an inspectable reference beside
the JSON body. Clicking **View message** opens an inspector containing the root
message's fully qualified name, source label, relative filename, and two views:

- **Fields**, selected initially: expand fields to see nested messages, enum
  members, comments, protobuf aliases, and collection shapes.
- **Original .proto**: read the exact file used for this catalog, positioned at
  the inspected declaration. Imports, options, comments, and other declarations
  remain visible as source context.

The body toolbar keeps its existing model link for changing the binding in
Advanced and adds **View message** beside it. Advanced exposes the same action
beside the committed message selection. Both entry points open the same inspector.
An explicit label makes the new action discoverable without changing the existing
model link's behavior.

Opening from Advanced selects Body before showing the inspector. For an empty
GET/HEAD request, inspection reveals the body presentation without adding body
text or changing the method. On close, return to the original settings section
and its opener if still available; otherwise focus the visible Body **View
message** action. Modal focus handling follows the same visible-opener rule.

On a sufficiently wide body pane, the inspector sits beside the editor so the
definition remains visible while writing JSON. It occupies only the body area;
request execution controls and response inspection keep their existing roles.
Open it only on demand. Use the body area's measured width, rather than the
window width, to choose the presentation: show the split when a 360 px editor
and 360 px inspector plus their gap fit. Otherwise use a viewport-bounded dialog.
At narrow widths the dialog fills the available content area with comfortable
page margins. The prototype also offers a dialog-first alternative for comparison.

The header has **Close** and **Change message**. Changing the message closes the
inspector and focuses its existing Advanced picker. Escape closes the inspector
and returns focus to its opener. The side pane is nonmodal and does not trap
keyboard focus; the dialog is modal and does. Opening either view preserves the
body's document, caret, selection, Undo, folds, and Find state. Closing a side
pane leaves its navigation state in the cached request editor for reopening.

## Field tree

Show fields in protobuf field-number order, matching the catalog's descriptor
ordering. Each row shows its JSON name, type, and field number. Use a native
disclosure per expandable field, with normal Tab/Enter/Space behavior; avoid
implementing a treegrid keyboard model for a small read-only tree.

- A string field such as `firstName` expands to show its original `first_name`
  spelling and documentation. Canonical JSON names remain the primary labels.
- A nested message such as `address` expands in place. Its type name can open
  that declaration as the inspector root, with a breadcrumb back to the request's
  selected message. This navigation never commits another request binding.
- An enum expands to its actual symbolic names and numeric values, including
  aliases. A repeated enum is labeled as an array of that enum rather than
  presenting its first enum member as a required/default request value.
- A repeated message expands its element schema once, labeled **Array item**.
  A map shows its actual key and value types and expands its value schema once.
  An arbitrary map key is a structural placeholder, not a suggested property.
- Show real oneof membership, explicit field presence, proto2 required fields,
  deprecation, and comments when available. Ordinary proto3 fields must not be
  mislabeled as explicitly `optional`. Presence describes protobuf semantics;
  it is not an assertion that every displayed field must be sent in JSON.
- Recursive references expand lazily. If a type already occurs on the current
  ancestor chain, show **Recursive reference** with **View type**, rather than
  recursively mounting its fields. Distinct sibling occurrences remain usable.
- Well-known types show their JSON representation, such as a timestamp string
  or wrapper scalar, alongside their protobuf type. Dynamic types such as Any
  explain their open shape; the inspector does not invent embedded fields.

Initially keep rows collapsed and avoid an Expand all operation that can produce
an unbounded recursive view. An empty message has an explicit **No fields** state.
Use text and labels as well as color for status, deprecation, and group membership.

## Original source

Display the complete file in a read-only code surface and reveal the declaration
line when entering the tab or navigating to another type. Display compiler-relative
filenames, not machine-specific absolute directories. Label the view **Original
.proto**, reserving that wording for captured source text rather than generated
descriptor output.

Capture source text during the existing compilation. Both views then describe
one immutable load result. Editing a file on disk does not silently change the
source tab; the existing **Reload** operation refreshes fields and source together.
A failed reload retains both with the same **Using previous models** explanation.

Store each source file once and let declarations reference it by filename and
one-based start line. Whole-file display retains comments, imports, and file
options without duplicating text for enclosing and nested declarations. It also
avoids treating protobuf source spans' UTF-8 byte columns as JavaScript UTF-16
offsets. Highlight and reveal a line rather than inventing a character range.

Bundled Google descriptors may have no original text. Older catalogs may also
lack it. In either case the source tab explains **Original source unavailable**
and leaves Fields usable. Never reconstruct a declaration and label it original.

## Interfaces and ownership

Reuse the runtime graph in [src/protobuf.ts](../src/protobuf.ts). Keep persistent
`ProtobufSource` and `ProtobufMessageBinding` unchanged. Inspection does not add
paths, descriptors, source text, or UI state to requests, history, or collection
exports.

Extract a pure `resolveProtobufMessage(binding, sources, states)` from
`resolveProtobufAssistance`. It returns a model independent of MIME, together
with loading/recovery/freshness information. `resolveProtobufAssistance` uses that
result and applies the existing JSON/editability gate for completion. This keeps
inspection available for a selected message in a `text/plain` body without
turning on JSON tooling.

Planned boundary responsibilities:

| Boundary | Responsibility |
| --- | --- |
| Native loader | Return one immutable catalog with accurate field metadata, enum details, captured source files, and declaration lines. |
| App | Retain ownership of source configuration, load generations, successful catalogs, and reload errors. |
| RequestEditor | Own open state, selected view, expanded occurrence paths, type navigation, and adaptive presentation. Close modal presentation on KeepAlive deactivation. |
| Message inspector | Render a resolved catalog and controlled inspection state. Emit inspection-state replacements, Close, Change message, and Reload intents. |
| Pure schema helpers | Resolve type references and project display rows without mutating the catalog or recursively materializing its graph. |
| Existing text editor | Remain mounted for body editing; present captured source separately in read-only mode. |

The inspector's component contract is a resolved model and source status, rather
than workspace ownership or a filesystem path. A separate controlled inspection
state contains the selected view, the type-navigation breadcrumb, and expanded
occurrence paths. RequestEditor retains this state while a pane closes or an
adaptive dialog wrapper remounts; KeepAlive alone cannot preserve destroyed
children. Type navigation receives a fully qualified name present in that catalog.
Expansion keys identify field occurrences
along the current display path; a field number alone cannot identify the same
message used twice in different branches. An expansion Set stores only UI choices;
the catalog remains the sole schema data source.

The current `messages`, `enums`, and `messageFiles` contracts remain available to
completion and the picker. Add optional metadata for older catalog consumers:

- `ProtoField.number`: the field's protobuf tag.
- `ProtoField.mapKeyType`: present for maps; resolves information currently lost
  when the native loader normalizes synthetic map-entry messages.
- `ProtoField.presence`: implicit, explicit, or required where applicable.
- `ProtoField.deprecated`: structured status rather than parsing documentation.
- Catalog enum details: actual member names, numeric values, comments, and
  deprecation, keyed by fully qualified enum identity. Retain the existing names
  list for completion; produce both projections from the same descriptor values.
- Catalog declaration documentation and source locations for message and enum
  identities. A location contains a compiler-relative `file` and one-based `line`.
- `fileSources?: Record<string, string>`: exact text keyed by the same relative
  filenames used by declaration locations. Omission means the source was not
  captured; a missing entry means that particular file has no original text.

Use explicit unavailable labels for absent metadata in older catalogs; never
invent map key types, field numbers, enum values, or source locations. New native
loads always supply available descriptor metadata. Real implementation types
must document every field, including the meaning of omissions.

In [src-tauri/src/protobuf.rs](../src-tauri/src/protobuf.rs), `File::source()` is
available in `ProjectResolver::open_file` before the file reaches the compiler.
Capture each source once there, then return captured text only with a successful
catalog. A shared collector retained by `load` and the resolver is justified by
the compiler owning the resolver during compilation; document that ownership
directly on the collector field. Bundled Google files are descriptor-backed and
can return no text. No new command should accept an arbitrary frontend file path.

Source capture adds up to the existing 32 MiB input bound to a catalog's text
payload. Keep one source string per virtual file and share the resulting catalog
between request editors. Enforce the captured-text budget using actual UTF-8 byte
lengths as files are captured, rather than relying only on pre-read filesystem
metadata. This is an explicit first-release memory/IPC tradeoff
for exact snapshots and simple ownership. Do not introduce a persistent native
schema cache or asynchronous source-reading service before measurements justify
the additional lifetime and invalidation interface.

## Lifecycle and unavailable states

- Loading without a catalog shows a loading state and the committed identity.
- Reloading with a prior catalog preserves the tree and source with a reloading
  label; the replacement catalog updates both views atomically.
- A failed reload preserves inspection with stale feedback and Reload.
- Relinking or changing dependency directories clears the previous catalog and
  follows the existing generation protection; neither view shows old source as
  belonging to the new configuration.
- A missing/removed source, unlinked import, or removed message shows the retained
  selection and an appropriate **Manage folders** or **Choose message** action.
- A successful reload that removes the currently inspected nested type returns
  navigation to the bound root if it still exists, with a brief explanation.
  If the root is gone, show the missing-message recovery state.
- Binding/source changes reset inspector navigation to the newly selected root.
  A same-binding catalog replacement retains valid paths and drops invalid ones.
- Switching request tabs closes any modal inspector so it cannot cover another
  request. Each cached editor may retain its own nonmodal open/navigation state.
- A non-JSON Content-Type disables completion but does not disable inspection.

## First delivery and verification

Deliver the two read-only views, nested type navigation, enum details, real map
types, freshness/recovery states, and adaptive pane/dialog presentation together.
Keep sample-body generation, inserting values, live body validation, editing
`.proto` files, and response-model selection as separate future decisions.

Verify behavior through public loader and rendered component contracts:

1. A selected message opens from Body and Advanced; opening, changing views,
   expanding, and navigating leave body text, binding, caret, Undo, and prepared
   HTTP/captured inputs intact.
2. Fixtures cover custom JSON names, every map-key category supported by protobuf,
   nested/repeated messages and enums, numeric enum aliases, oneofs, proto2
   required fields, proto3 explicit presence, deprecation, and Unicode comments.
3. Exact source preserves original newlines, comments, options, imports, and
   nested declarations. Location tests verify one-based lines; fields and text
   come from the same successful load, including after an unsuccessful reload.
4. Recursive, mutually recursive, and reused sibling types remain finite and
   distinguish independently expanded occurrences.
5. Old catalogs, descriptor-only well-known types, inaccessible/unlinked sources,
   removed messages, stale results, relinks, and reload races show honest states.
6. MIME changes retain inspection; cached request switching does not leak modal
   UI or state across requests. Narrow panes, keyboard focus, Escape, and focus
   return work in the native desktop app.
