import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { renderMarkdownPreview } from "./markdown-preview";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe("Markdown preview", () => {
  test("renders the built-in Markdown structures", () => {
    const preview = renderMarkdownPreview(`
# Guide

| Name | Value |
| --- | --- |
| mode | preview |

~~old~~ and \`code\`
`);

    expect(preview.querySelector("h1")?.textContent).toBe("Guide");
    expect(preview.querySelector("table td")?.textContent).toBe("mode");
    expect(preview.querySelector("s")?.textContent).toBe("old");
    expect(preview.querySelector("code")?.textContent).toBe("code");
  });

  test("escapes raw HTML and hardens links", () => {
    const preview = renderMarkdownPreview(
      '<script data-test="raw">alert(1)</script> [site](https://example.com)',
    );

    expect(preview.querySelector("script")).toBeNull();
    expect(preview.textContent).toContain('<script data-test="raw">');
    expect(preview.querySelector("a")?.target).toBe("_blank");
    expect(preview.querySelector("a")?.rel).toBe("noopener noreferrer");
  });

  test("allows web, email, and relative links", () => {
    const preview = renderMarkdownPreview(`
[web](https://example.com)
[email](mailto:hello@example.com)
[relative](docs/guide.md)
`);

    expect(
      [...preview.querySelectorAll("a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([
      "https://example.com",
      "mailto:hello@example.com",
      "docs/guide.md",
    ]);
  });

  test("rejects links outside the explicit protocol allowlist", () => {
    const preview = renderMarkdownPreview(`
[javascript](javascript:alert(1))
[settings](ms-settings:privacy)
[search](search-ms:query=test)
[editor](vscode://file/example)
[shell](shell:AppsFolder)
[ssh](ssh://example.com)
[protocol-relative](//example.com/path)
`);

    expect(preview.querySelector("a")).toBeNull();
    expect(preview.textContent).toContain("settings");
    expect(preview.textContent).toContain("ssh");
  });

  test("renders image alt text without loading image sources", () => {
    const preview = renderMarkdownPreview(`
![remote tracker](https://example.com/pixel.png)
![loopback service](http://127.0.0.1:3000/private)
![local service](http://localhost:8080/status)
`);

    expect(preview.querySelector("img")).toBeNull();
    expect(preview.textContent).toContain("[Image: remote tracker]");
    expect(preview.textContent).toContain("[Image: loopback service]");
    expect(preview.textContent).toContain("[Image: local service]");
  });
});
