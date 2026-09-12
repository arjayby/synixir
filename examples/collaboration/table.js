import { startExample } from "./example-shell.js";
import { createCollaborativeTable } from "./table/table.js";
import "./table/table.css";

startExample({ createSurface: createCollaborativeTable, pagePath: "/table.html", presenceOptions: { avatars: true } });
