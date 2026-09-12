import type { SynixirRoom } from "@synixir/client";
import type { EditorView } from "@codemirror/view";
declare global {
  interface Window {
    synixirTest: { room?: SynixirRoom; editor?: EditorView };
  }
}
// Compiled out of production builds. Browser tests inspect public SDK/editor APIs.
export function inspectForTest(values: Window["synixirTest"]) {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_SYNIXIR_BROWSER_TEST === "true"
  )
    window.synixirTest = { ...window.synixirTest, ...values };
}
