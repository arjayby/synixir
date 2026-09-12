import { startExample } from "./example-shell.js";
import { createWhiteboard } from "./whiteboard/canvas.js";
import "./whiteboard/canvas.css";

startExample({ createSurface: createWhiteboard, pagePath: "/whiteboard.html", presenceOptions: { avatars: true } });
