"use client";

import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { DragDropProvider, useDragDropManager, useDroppable, type DragDropManager } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import { GripVertical, Plus } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { columns, type Card } from "./model.ts";

interface BoardProps {
  cards: Card[];
  readOnly: boolean;
  onOpen(id: string): void;
  onAdd(column: string): void;
  onDragStart(id: string): void;
  onDragEnd(id?: string, column?: string, beforeId?: string | null): void;
  onRender(): void;
}

function SortableCard({ card, index, readOnly, onOpen }: {
  card: Card; index: number; readOnly: boolean; onOpen(id: string): void;
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id: card.id, index, group: card.placement.column,
    type: "card", accept: "card", disabled: readOnly,
  });
  const title = card.title || "Untitled card";
  return (
    <article ref={ref} className={cn("kanban-card", `card-${card.color}`)}
      data-card-id={card.id} data-dragging={isDragging || undefined}>
      <Button type="button" variant="ghost" className="card-open" aria-label={`Open card: ${title}`}
        onClick={() => onOpen(card.id)}>
        <span className="card-title">{title}</span>
        {card.description ? <span className="card-description">{card.description}</span> : null}
        <span className="card-presence" />
      </Button>
      <Button ref={handleRef} type="button" variant="ghost" size="icon-sm"
        className="card-grip" disabled={readOnly} hidden={readOnly}
        aria-label={`Move card: ${title}`} title="Drag to reorder. Press Space, then arrow keys to move.">
        <GripVertical />
      </Button>
    </article>
  );
}

function Column({ column, cards, readOnly, onOpen, onAdd }: Pick<BoardProps, "cards" | "readOnly" | "onOpen" | "onAdd"> & {
  column: typeof columns[number];
}) {
  const { ref, isDropTarget } = useDroppable({
    id: column.id, type: "column", accept: "card", disabled: readOnly,
    // A pointer over a column beats a card's shape overlap (2), while a
    // pointer over a card still selects its precise insertion target (3).
    collisionDetector: pointerIntersection, collisionPriority: 2.5,
  });
  return (
    <section ref={ref} className={cn("kanban-column", `column-${column.id}`, isDropTarget && "drop-target")}
      data-column={column.id} aria-label={column.label}>
      <div className="column-heading"><h2>{column.label}</h2><Badge variant="secondary">{cards.length}</Badge></div>
      <div className="card-list">
        {cards.map((card, index) => <SortableCard key={card.id} card={card} index={index} readOnly={readOnly} onOpen={onOpen} />)}
        {cards.length === 0 ? <p className="column-empty">{column.id === "done" ? "Finished work lands here." : "No cards yet."}</p> : null}
      </div>
      <Button type="button" variant="outline" className="add-card" disabled={readOnly}
        aria-label={`Add card to ${column.label}`} onClick={() => onAdd(column.id)}>
        <Plus data-icon="inline-start" /> Add card
      </Button>
    </section>
  );
}

function ManagerRef({ onManager }: { onManager(manager: DragDropManager | null): void }) {
  const manager = useDragDropManager();
  useLayoutEffect(() => {
    onManager(manager);
    return () => onManager(null);
  }, [manager, onManager]);
  return null;
}

function BoardView({ onManager, ...props }: BoardProps & { onManager(manager: DragDropManager | null): void }) {
  useLayoutEffect(props.onRender);
  return (
    <DragDropProvider
      onBeforeDragStart={event => { if (props.readOnly) event.preventDefault(); }}
      onDragStart={event => {
        if (event.operation.source) props.onDragStart(String(event.operation.source.id));
      }}
      onDragEnd={event => {
        const { source, target } = event.operation;
        if (props.readOnly || event.canceled || !target || !isSortable(source)) {
          props.onDragEnd();
          return;
        }
        // Sortable properties describe the preview; IDs translate that preview
        // into one model action against the latest shared document on drop.
        const column = target.type === "column" ? String(target.id) : String(source.group);
        const items = props.cards.filter(card => card.placement.column === column && card.id !== source.id);
        const beforeId = target.type === "column" ? null : items[source.index]?.id ?? null;
        if (column === source.initialGroup && source.index === source.initialIndex && target.type !== "column") {
          props.onDragEnd();
        } else {
          props.onDragEnd(String(source.id), column, beforeId);
        }
      }}>
      <ManagerRef onManager={onManager} />
      <div className="kanban-board">
        {columns.map(column => <Column key={column.id} column={column}
          cards={props.cards.filter(card => card.placement.column === column.id)}
          readOnly={props.readOnly} onOpen={props.onOpen} onAdd={props.onAdd} />)}
      </div>
    </DragDropProvider>
  );
}

export function mountBoardView(element: HTMLElement) {
  const root = createRoot(element);
  let manager: DragDropManager | null = null;
  const onManager = (value: DragDropManager | null) => { manager = value; };
  return {
    render(props: BoardProps) { root.render(<BoardView onManager={onManager} {...props} />); },
    cancel() { manager?.actions.stop({ canceled: true }); },
    destroy() { root.unmount(); },
  };
}
