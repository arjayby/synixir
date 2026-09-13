import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const packageEntry = import.meta.resolve("@excalidraw/excalidraw");
const source = new URL("fonts/", packageEntry);
const destination = new URL("../public/excalidraw-assets/fonts/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(fileURLToPath(source), fileURLToPath(destination), { recursive: true });
