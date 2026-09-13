import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Editors mounted in their own React roots share the playground's CSS theme.
export function subscribeTheme(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, getTheme, () => "light" as const);
}
