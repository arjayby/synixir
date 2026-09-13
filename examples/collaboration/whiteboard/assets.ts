declare global { interface Window { EXCALIDRAW_ASSET_PATH: string } }
export {};
// The predev/prebuild step copies the package fonts into the static export.
window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
