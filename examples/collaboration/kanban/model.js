import * as Y from "yjs";

export const columns = [
  { id: "backlog", label: "Backlog" },
  { id: "in-progress", label: "In progress" },
  { id: "done", label: "Done" },
];
export const colors = ["neutral", "blue", "green", "amber", "rose"];

// One map entry per card. Column and order change together, so concurrent
// moves choose one placement instead of inserting the card into two lists.
export function createBoardModel(doc) {
  const cards = doc.getMap("kanban:cards:v1");
  const origin = {};
  const history = new Y.UndoManager(cards, { trackedOrigins: new Set([origin]) });
  const validColumn = id => columns.some(column => column.id === id);
  const list = () => [...cards.entries()]
    .filter(([, card]) => card instanceof Y.Map)
    .map(([id, card]) => ({ id, title: String(card.get("title") ?? ""),
      description: String(card.get("description") ?? ""),
      color: colors.includes(card.get("color")) ? card.get("color") : "neutral",
      placement: card.get("placement") }))
    .filter(card => validColumn(card.placement?.column) && Number.isFinite(card.placement?.order))
    .sort((a, b) => a.placement.order - b.placement.order || a.id.localeCompare(b.id));
  const nextOrder = column => Math.max(0, ...list().filter(card => card.placement.column === column)
    .map(card => card.placement.order)) + 1;
  function action(fn) {
    history.stopCapturing();
    doc.transact(fn, origin);
    history.stopCapturing();
  }
  return {
    cards, history, list,
    add(column) {
      if (!validColumn(column)) return;
      const id = crypto.randomUUID();
      action(() => cards.set(id, new Y.Map([
        ["title", "Untitled card"], ["description", ""], ["color", "neutral"],
        ["placement", { column, order: nextOrder(column) }],
      ])));
      return id;
    },
    edit(id, field, value) {
      const card = cards.get(id);
      if (!(card instanceof Y.Map) || !["title", "description", "color"].includes(field)) return;
      if (field === "color" && !colors.includes(value)) return;
      if (card.get(field) === value) return;
      doc.transact(() => card.set(field, value), origin);
    },
    move(id, column) {
      const card = cards.get(id);
      if (!(card instanceof Y.Map) || !validColumn(column) || card.get("placement")?.column === column) return;
      action(() => card.set("placement", { column, order: nextOrder(column) }));
    },
    remove(id) { action(() => cards.delete(id)); },
    destroy() { history.destroy(); },
  };
}
