import { startExample } from "./example-shell.js";
import { createMultiplayerForm } from "./multiplayer-form/form.js";
import "./multiplayer-form/form.css";

startExample({ createSurface: createMultiplayerForm, pagePath: "/multiplayer-form.html", presenceOptions: { avatars: true } });
