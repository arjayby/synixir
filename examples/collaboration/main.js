import { createEditor } from "./editor.js";
import { startExample } from "./example-shell.js";

startExample({ createSurface: room => createEditor(room.doc.getText("content"), room.awareness) });
