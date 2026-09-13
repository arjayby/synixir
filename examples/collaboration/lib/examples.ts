import {
  FileText,
  Columns3,
  PencilRuler,
  Type,
  Workflow,
  Table2,
  ListChecks,
} from "lucide-react";
export const examples = [
  {
    id: "text",
    path: "/",
    title: "Text editor",
    description: "Write together, down to the last character.",
    icon: FileText,
    hint: "Live cursors and shared undo history",
  },
  {
    id: "kanban",
    path: "/kanban",
    title: "Kanban board",
    description: "Move work forward with your whole team.",
    icon: Columns3,
    hint: "Drag cards between columns",
  },
  {
    id: "whiteboard",
    path: "/whiteboard",
    title: "Whiteboard",
    description: "A shared canvas for your next idea.",
    icon: PencilRuler,
    hint: "Drag objects · Arrow keys to move",
  },
  {
    id: "rich-text",
    path: "/rich-text",
    title: "Rich text",
    description: "Turn a rough outline into something worth sharing.",
    icon: Type,
    hint: "Formatting, live cursors, and shared history",
  },
  {
    id: "multiplayer-form",
    path: "/multiplayer-form",
    title: "Project brief",
    description: "Work through the details, together.",
    icon: ListChecks,
    hint: "Shared fields with live editing presence",
  },
  {
    id: "flowchart",
    path: "/flowchart",
    title: "Flowchart",
    description: "Connect the dots in your team's thinking.",
    icon: Workflow,
    hint: "Connect steps and label your decisions",
  },
  {
    id: "table",
    path: "/table",
    title: "Table",
    description: "Give your team's information a shared home.",
    icon: Table2,
    hint: "Edit cells together or paste from a spreadsheet",
  },
] as const;
export type ExampleKind = (typeof examples)[number]["id"];
export function example(kind: ExampleKind) {
  return examples.find((item) => item.id === kind)!;
}
