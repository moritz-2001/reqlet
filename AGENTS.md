# High level rules
- I am an experienced software engineer
- In ARCHITECTURE.md you can read the high level architecture
- Write human readable code
- Try to test the interface not implementation
- Use 3 slashes for rust documentation
- if you design the code, i am especially interested in the interface and abstraction. Thus, discuss them with me. 
- Try to not have too much mutable state. Most functions should be pure. However, if the mutable version is a lot simpler, then use it.
- Create and maintain a high level architecture design document with code references (ARCHITECTURE.md)
- Create and maintain a high level architecture design document with code references for complex subsystems like a renderer
- Document non-obvious fields or function relationships directly in the source code. Explain their purpose,
  ownership, and relationship to other fields, especially when the representation
  uses shared storage, indices, ranges, caches, or lifetime workarounds.
  Explain why the field exists rather than restating its name or type
- If you add an essential interface that is widely used, then add documentation on how to use it and examples for it
- Add docs to public structs and enums; explain their purpose
- For every struct declared with `pub`, `pub(crate)`, or `pub(super)`, add `///`
  documentation to every field, including private fields and tuple fields,
  even when its name or type seems self-explanatory. The struct's visibility
  determines whether this rule applies; the field's visibility is irrelevant.
- When checking field documentation, inspect the entire struct declaration.
  Searching only for fields marked `pub` is not sufficient.
- Explain each field's meaning and intended use. For `Option` fields, explain
  what `None` means.
- For state fields, describe when they are set, updated, and cleared.
- Explain relationships between similar fields, such as `hovered`, `pressed`,
  and `captured`, so callers understand their differences.
- Describe semantics rather than repeating the field name or type.
- Within functions, use a single blank line to separate distinct logical steps, such as validation, preparation, processing, and returning a result. Keep closely related statements together, avoid blank lines between every statement, and do not add empty lines immediately inside function boundaries. Wrap long expressions at natural boundaries and follow the project’s formatter and existing style.
- Write code that a human can read well
- Put docs into a doc folder



### Files should be readable from the top to the bottom
  - Every file should have at the top a comment that describes it purpose and what the most important struct in it is
  - The most important structs, enums, trait and functions, ...,  should be at the beginning of a file
  - Start with the main interface and flow, then introduce supporting details.
  - Keep a type and its implementation together when they form one coherent section.
  - Put helpers below the higher-level operations that use them; keep public operations before private implementation details.
  - In test files, present the tested behavior before fixture implementations and assertion helpers.



### Accessors
- Do not add trivial getters, setters, or `_mut` accessors unless they
  provide a concrete abstraction boundary or protect an invariant.
- For plain data, prefer direct field access with the narrowest necessary
  visibility (`private`, `pub(super)`, `pub(crate)`, or `pub`).
- Read-only access to otherwise private state is a valid reason for a
  getter. Do not automatically add a matching mutable accessor.
- If mutation must preserve invariants, provide operations that enforce
  them rather than returning unrestricted `&mut` access.
- Speculative future flexibility and “encapsulation” alone do not justify
  accessor boilerplate. Identify the specific boundary being protected.

