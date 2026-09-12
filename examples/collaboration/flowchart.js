import { startExample } from "./example-shell.js";
import { createFlowchart } from "./flowchart/canvas.js";
import "./whiteboard/canvas.css";
import "./flowchart/canvas.css";

startExample({ createSurface: createFlowchart, pagePath: "/flowchart.html", presenceOptions: { avatars: true } });
