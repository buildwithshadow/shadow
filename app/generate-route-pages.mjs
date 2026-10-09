import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SHADOW_ORIGIN } from "./shadowUrls.js";

const routeMetadata = JSON.parse(
  await readFile(new URL("./routeMetadata.json", import.meta.url), "utf8"),
);
const template = await readFile(new URL("./dist/index.html", import.meta.url), "utf8");

const homeTitle = routeMetadata.routeTitles["/"];
const templateTitle = template.match(/<title>([^<]*)<\/title>/)?.[1];
if (templateTitle !== escapeHtml(homeTitle)) {
  throw new Error("Template title does not match route title for /");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function replaceTitle(html, title) {
  const pattern = /<title>[^<]*<\/title>/;
  if (!pattern.test(html)) throw new Error("Missing title tag in build output");
  return html.replace(pattern, () => `<title>${escapeHtml(title)}</title>`);
}

function replaceMeta(html, name, value) {
  const attribute = name.startsWith("og:") ? "property" : "name";
  const pattern = new RegExp(`<meta\\s+${attribute}="${name}"[^>]*>`);
  const tag = html.match(pattern)?.[0];
  if (!tag) throw new Error(`Missing ${name} tag in build output`);
  const updated = tag.replace(/\bcontent="[^"]*"/, () => `content="${escapeHtml(value)}"`);
  if (updated === tag) throw new Error(`Missing ${name} content in build output`);
  return html.replace(tag, () => updated);
}

for (const [route, description] of Object.entries(routeMetadata.socialDescriptions)) {
  const title = routeMetadata.routeTitles[route];
  if (!title) throw new Error(`Missing route title for ${route}`);
  const url = `${SHADOW_ORIGIN}${route}`;
  let html = replaceTitle(template, title);
  html = replaceMeta(html, "description", description);
  html = replaceMeta(html, "og:title", title);
  html = replaceMeta(html, "og:description", description);
  html = replaceMeta(html, "og:url", url);
  html = replaceMeta(html, "twitter:title", title);
  html = replaceMeta(html, "twitter:description", description);

  const destination = fileURLToPath(new URL(`./dist${route}/index.html`, import.meta.url));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, html);
}
