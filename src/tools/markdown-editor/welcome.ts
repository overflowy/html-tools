// What a first visit shows: a short document that doubles as a tour, with
// enough headings to give Contents something to list.

export function welcome(mod: string): string {
  return `# Markdown Editor

Everything on this page happens in your browser. The file you open, the text you type, and the document you save never go anywhere else.

## First steps

1. Open a \`.md\` file with **Open**, or drop one anywhere on this page
2. Read it in **Preview**, edit it in **Edit**, or do both in **Split**
3. **Save** writes back to the file you opened (Chrome and Edge); other browsers download a copy
4. **Export PDF** sends the rendered page to the print dialog

What you type is kept as a draft in this browser, and the page's address carries the whole document while it is short enough, so a copied link opens the same text elsewhere.

## Formatting

The usual GitHub flavor, plus a few extras.

| Write | Get |
| ----- | --- |
| \`*emphasis*\` | *emphasis* |
| \`**strong**\` | **strong** |
| \`~~struck~~\` | ~~struck~~ |
| \`[text](url)\` | [text](https://example.org) |

- [x] Ordered and unordered lists
- [ ] Task lists, checked or not

### Code

Fenced blocks are highlighted by language:

\`\`\`ts
export function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^\\w]+/g, "-");
}
\`\`\`

### Math

Inline expressions such as $e^{i\\pi} + 1 = 0$ sit in the text, and a block of its own is set apart:

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

### Diagrams

A \`mermaid\` fence becomes a diagram:

\`\`\`mermaid
sequenceDiagram
  participant You
  participant Editor
  You->>Editor: type or drop a file
  Editor-->>You: rendered preview
  You->>Editor: Save
  Editor-->>You: written back to disk
\`\`\`

The math and diagram engines are fetched the first time a document needs them, then kept in this browser.

### Callouts

> [!TIP]
> The list button toggles **Contents**, the half-filled circle switches the page to light, the sparkle formats the Markdown, and ${mod}F opens find and replace.

> [!WARNING]
> A renamed file is saved as a new one: Save asks where to put it.

### Footnotes

Numbered on first use[^why], gathered at the end.

[^why]: So a reference near the top and one near the bottom stay in reading order.

---

Keys: **${mod}S** save, **${mod}⇧S** save as, **${mod}O** open, **${mod}E** edit or preview, **${mod}F** find, **Tab** and **⇧Tab** indent and outdent.
`;
}
