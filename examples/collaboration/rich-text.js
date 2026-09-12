import { startExample } from "./example-shell.js";
import { createRichText } from "./rich-text/editor.js";
import "./rich-text/editor.css";

startExample({ createSurface: createRichText, pagePath: "/rich-text.html", presenceOptions: { avatars: true } });
