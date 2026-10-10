import { expect, test } from "bun:test";
import app from "../src/server";

const documentationNavigationPattern = /<nav aria-label="Documentation">([\s\S]*?)<\/nav>/;

test("visitors can read the landing page and follow its documentation link", async () => {
  const response = await app.handle(new Request("http://localhost/"));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Your downloads.");
  expect(html).toContain('href="/docs"');
  expect(html).toContain('lang="en"');
});

test("documentation navigation leads to readable server-rendered pages", async () => {
  const response = await app.handle(new Request("http://localhost/docs"));
  const html = await response.text();
  const navigation = html.match(documentationNavigationPattern)?.[1];
  expect(navigation).toBeDefined();
  const paths = [...(navigation ?? "").matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  expect(paths.length).toBeGreaterThan(1);
  const pages = await Promise.all(
    paths.map(async (path) => {
      const page = await app.handle(new Request(`http://localhost${path}`));
      return { html: await page.text(), status: page.status };
    })
  );
  for (const page of pages) {
    expect(page.status).toBe(200);
    expect(page.html).toContain('<article class="docs-article">');
    expect(page.html).toContain("<h1>");
    expect(page.html).not.toContain("swarm-scene");
  }
});
