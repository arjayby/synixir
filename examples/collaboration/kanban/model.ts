import * as Y from "yjs";

export const columns = [
  { id: "backlog", label: "Backlog" },
  { id: "in-progress", label: "In progress" },
  { id: "done", label: "Done" },
];
export const colors = ["neutral", "blue", "green", "amber", "rose"];

export interface Card {
  id: string;
  title: string;
  description: string;
  color: string;
  placement: { column: string; order: number; rank?: number[] };
}

// Lexicographic paths leave room between equal legacy numeric orders without
// rewriting other cards. Include the stable ID so concurrent equal ranks also
// have a deterministic order, with room to insert between them later.
const position = (card: Card) => [
  ...(card.placement.rank ?? [card.placement.order]),
  ...Array.from(card.id, char => char.charCodeAt(0)),
];
function compare(a: number[], b: number[]) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}
function between(a: number[] | undefined, b: number[] | undefined): number[] {
  if (!a) return b ? [b[0] - 1] : [1];
  if (!b) return a[0] + 1 > a[0] && Number.isFinite(a[0] + 1) ? [a[0] + 1] : [...a, 0];
  let index = 0;
  while (index < a.length && a[index] === b[index]) index++;
  if (index === a.length) return [...a, b[index] - 1];
  const middle = a[index] / 2 + b[index] / 2;
  if (a[index] < middle && middle < b[index]) return [...a.slice(0, index), middle];
  // No representable float between these digits. Extend the lower path.
  return [...a, 0];
}

// One map entry per card. Column and order change together, so concurrent
// moves choose one placement instead of inserting the card into two lists.
export function createBoardModel(doc: Y.Doc) {
  const cards = doc.getMap("kanban:cards:v1");
  const origin = {};
  const history = new Y.UndoManager(cards, { trackedOrigins: new Set([origin]) });
  const validColumn = (id: string) => columns.some(column => column.id === id);
  const list = (): Card[] => [...cards.entries()]
    .filter((entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map)
    .map(([id, card]) => ({ id, title: String(card.get("title") ?? ""),
      description: String(card.get("description") ?? ""),
      color: colors.includes(String(card.get("color"))) ? String(card.get("color")) : "neutral",
      placement: card.get("placement") as Card["placement"] | undefined }))
    .filter((card): card is Card => !!card.placement && validColumn(card.placement.column) && Number.isFinite(card.placement?.order) &&
      (card.placement.rank === undefined || (Array.isArray(card.placement.rank) && card.placement.rank.length > 0 && card.placement.rank.every(Number.isFinite))))
    .sort((a, b) => compare(position(a), position(b)));
  function placement(column: string, items: Card[], index = items.length) {
    const rank = between(items[index - 1] && position(items[index - 1]), items[index] && position(items[index]));
    return { column, order: rank[0], rank };
  }
  function action(fn: () => void) {
    history.stopCapturing();
    doc.transact(fn, origin);
    history.stopCapturing();
  }
  return {
    cards, history, list,
    add(column: string) {
      if (!validColumn(column)) return;
      const id = crypto.randomUUID();
      action(() => cards.set(id, new Y.Map([
        ["title", "Untitled card"], ["description", ""], ["color", "neutral"],
        ["placement", placement(column, list().filter(card => card.placement.column === column))],
      ])));
      return id;
    },
    edit(id: string|undefined, field: string, value: string) {
      const card = cards.get(id ?? "");
      if (!(card instanceof Y.Map) || !["title", "description", "color"].includes(field)) return;
      if (field === "color" && !colors.includes(value)) return;
      if (card.get(field) === value) return;
      doc.transact(() => card.set(field, value), origin);
    },
    move(id: string|undefined, column: string, beforeId?: string | null) {
      const card = cards.get(id ?? "");
      if (!(card instanceof Y.Map) || !validColumn(column) || beforeId === id) return;
      const current = list().filter(item => item.placement.column === column);
      const items = current.filter(item => item.id !== id);
      const before = beforeId ? items.findIndex(item => item.id === beforeId) : -1;
      const index = before < 0 ? items.length : before;
      // Status controls keep the order when their selected column is unchanged.
      if (card.get("placement")?.column === column &&
        (beforeId === undefined || current[index]?.id === id)) return;
      action(() => card.set("placement", placement(column, items, index)));
    },
    remove(id: string|undefined) { action(() => cards.delete(id ?? "")); },
    destroy() { history.destroy(); },
  };
}
