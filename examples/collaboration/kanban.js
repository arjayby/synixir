import { startExample } from "./example-shell.js";
import { createBoard } from "./kanban/board.js";
import "./kanban/board.css";

startExample({ createSurface: createBoard, pagePath: "/kanban.html", presenceOptions: { avatars: true } });
