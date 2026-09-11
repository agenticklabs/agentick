import * as React from "react";

export interface FormattedProps {
  readonly children?: React.ReactNode;
}

/**
 * `<Formatted>…</Formatted>` — the subtree reaches the model as ONE string,
 * rendered by the formatter in scope (inner scopes keep their own dialect) and
 * framed as a document: messages as messages, blocks in their text forms.
 */
export function Formatted({ children }: FormattedProps): React.ReactElement {
  return React.createElement("formatted", null, children);
}
