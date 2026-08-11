const MAX_BROWSER_TAB_TITLE_CHARACTERS = 160;

export function browserTabTitle(pageTitle: string, url: string): string {
  const normalized = pageTitle.replace(/\s+/g, " ").trim();
  if (normalized) {
    return Array.from(normalized)
      .slice(0, MAX_BROWSER_TAB_TITLE_CHARACTERS)
      .join("");
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, "");
    if (hostname) return hostname;
  } catch {
    // The Browser host validates URLs; malformed event data falls back safely.
  }
  return "Browser";
}
