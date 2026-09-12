import type { SynixirRoom } from "@synixir/client";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { CollaborativeTable } from "./table-view.tsx";
import { TableSession } from "./session.ts";

export function createCollaborativeTable(room: SynixirRoom) {
  const host = document.querySelector<HTMLElement>("#editor")!;
  document.querySelector<HTMLAnchorElement>("#open-peer")!.href = location.href;
  const session = new TableSession(room);
  const root = createRoot(host);
  root.render(createElement(CollaborativeTable, { session }));
  const destroy = () => {
    root.unmount();
    session.destroy();
  };
  destroy.setReadOnly = (value: boolean) => session.setReadOnly(value);
  return destroy;
}
