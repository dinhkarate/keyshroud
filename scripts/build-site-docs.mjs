// keyshroud.dev/docs: renders the public pages of docs/ into site/docs/ (one HTML page and one
// Markdown copy per page, plus the index). The output is committed, because the site is served
// as static files; `npm run site` rewrites it and `--check` (run by the tests) fails when it is stale.
// A link to a page or heading that does not exist stops the build.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Marked, Renderer } from "marked";

const SITE = "https://keyshroud.dev";
const REPO = "https://github.com/dinhkarate/keyshroud";
const OUT = "site/docs";
const GROUPS = [
  ["Guides", [
    ["migrate-from-dotenv", "Move a project off .env", "Import the values into the vault, commit .env.refs, delete the plaintext."],
    ["ci-and-docker", "CI and Docker", "A passphrase vault in GitHub Actions, in a Docker build and in a container."],
    ["rotate-a-key", "Rotate a key that leaked", "Find the copies, store the new value, and what picks it up."],
    ["troubleshooting", "Troubleshooting", "Unresolved names, a locked vault, a value that printed unmasked."],
  ]],
  ["Where secrets live", [
    ["local-vault", "The local vault", "Key modes, Touch ID, sessions, backup and restore."],
    ["vaultwarden", "Vaultwarden or Bitwarden", "Sync between machines, sessions, a separate agent account."],
    ["team-secret-managers", "Team secret managers", "HashiCorp Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure."],
    ["project-scope", "Project scope", ".keyshroud.json: which names a project may use."],
  ]],
  ["Agents", [
    ["claude-code", "Claude Code", "The plugin's hooks, claude-setup, and the guard for failed commands."],
    ["agents", "pi, omp and other agents", "The pi/omp extension, the skill, the MCP server."],
  ]],
  ["Reference", [
    ["cli", "CLI reference", "Every command, reference form, exit code and environment variable."],
    ["how-it-works", "How it works", "Wiring, unlocking, resolving, injecting, redacting."],
    ["security", "Security model", "The guarantees we test for, and the known limits."],
    ["faq", "FAQ", "Short answers: servers, CI, Windows, upgrading."],
  ]],
];
const PAGES = GROUPS.flatMap(([, pages]) => pages.map(([slug, title, description]) => ({ slug, title, description })));

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The anchor GitHub gives a heading, so links written for GitHub work here too.
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}
const plain = (tokens) => tokens.map((token) => token.tokens ? plain(token.tokens) : token.text ?? "").join("");

// Where a link in docs/<page>.md points on the site: another page, a file of the repository, or as written.
function target(href, from, links) {
  if (/^(https?:|mailto:|#)/.test(href)) { if (href.startsWith("#")) links.push({ from, slug: from, anchor: href.slice(1) }); return href; }
  const [path, anchor] = href.split("#");
  if (path.startsWith("../")) {
    const file = path.slice(3);
    if (!existsSync(file)) throw new Error(`docs/${from}.md links to ${path}, which does not exist`);
    return `${REPO}/${/\.\w+$/.test(file) ? "blob" : "tree"}/main/${file}${anchor ? `#${anchor}` : ""}`;
  }
  const slug = path.replace(/\.md$/, "");
  if (!PAGES.some((page) => page.slug === slug)) throw new Error(`docs/${from}.md links to ${path}, which is not a public page`);
  links.push({ from, slug, anchor });
  return `/docs/${slug}${anchor ? `#${anchor}` : ""}`;
}

function render(page, links) {
  const source = readFileSync(`docs/${page.slug}.md`, "utf8");
  const slug = slugger();
  const headings = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const id = slug(plain(tokens));
        const html = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${html}</h1>\n`;
        headings.push({ id, depth, html });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${depth}>\n`;
      },
      link({ href, tokens }) { return `<a href="${escape(target(href, page.slug, links))}">${this.parser.parseInline(tokens)}</a>`; },
      code({ text, lang }) { return `<pre${lang ? ` data-lang="${escape(lang)}"` : ""}><code>${escape(text)}</code></pre>\n`; },
      table(token) { return `<div class="table">${Renderer.prototype.table.call(this, token)}</div>\n`; },
    },
  });
  const body = marked.parse(source);
  if (!/^<h1>/.test(body)) throw new Error(`docs/${page.slug}.md must start with a # heading`);
  // The Markdown copy: the same text, with the links that leave docs/ made absolute.
  const markdown = source.replace(/\]\(\.\.\/([^)#\s]+)(#[^)\s]*)?\)/g, (_, file, anchor = "") => `](${REPO}/${/\.\w+$/.test(file) ? "blob" : "tree"}/main/${file}${anchor})`);
  return { ...page, body, headings, markdown };
}

const sidebar = (current) => GROUPS.map(([group, pages]) =>
  `<h4>${group}</h4>\n<ul>\n${pages.map(([slug, title]) => `<li><a href="/docs/${slug}"${slug === current ? ' aria-current="page"' : ""}>${escape(title)}</a></li>`).join("\n")}\n</ul>`).join("\n");

function layout({ path, title, description, current, article, aside = "" }) {
  const nav = sidebar(current);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · keyshroud docs</title>
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)} · keyshroud docs">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${SITE}${path}">
${current ? `<link rel="alternate" type="text/markdown" href="/docs/${current}.md">\n` : ""}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="/docs/docs.css">
</head>
<body>
<header class="bar">
  <div class="wrap">
    <a class="brand" href="/">
      <picture>
        <source srcset="/logo-dark.svg" media="(prefers-color-scheme: dark)">
        <img src="/logo.svg" alt="keyshroud">
      </picture>
    </a>
    <nav>
      <a href="/docs/" aria-current="${current ? "true" : "page"}">Docs</a>
      <a href="/#quickstart">Quickstart</a>
      <a class="opt" href="/#demo">Demo</a>
      <a class="opt" href="/#compare">Compare</a>
      <a class="gh" href="${REPO}">GitHub</a>
    </nav>
  </div>
</header>
<div class="wrap page">
  <details class="menu">
    <summary>All docs</summary>
    <nav class="side" aria-label="Docs, short screen">
${nav}
    </nav>
  </details>
  <nav class="side wide" aria-label="Docs">
${nav}
  </nav>
  <main>
${article}
  </main>
${aside}</div>
<footer>
  <div class="wrap">
    <p>keyshroud · MIT · <a href="${REPO}">GitHub</a> · <a href="https://www.npmjs.com/package/keyshroud">npm</a> · <a href="/llms.txt">llms.txt</a> · Not affiliated with Anthropic, Bitwarden, Inc. or any vendor named here.</p>
  </div>
</footer>
<script src="/docs/docs.js" defer></script>
</body>
</html>
`;
}

function pageHtml(page) {
  const at = PAGES.findIndex((other) => other.slug === page.slug);
  const step = (other, rel, label) => other ? `<a class="${rel}" rel="${rel}" href="/docs/${other.slug}"><span>${label}</span>${escape(other.title)}</a>` : "<span></span>";
  const onPage = page.headings.filter((heading) => heading.depth === 2);
  return layout({
    path: `/docs/${page.slug}`, title: page.title, description: page.description, current: page.slug,
    article: `<article>
${page.body}</article>
<p class="edit"><a href="${REPO}/blob/main/docs/${page.slug}.md">Edit this page on GitHub</a> · <a href="/docs/${page.slug}.md">Markdown</a></p>
<div class="steps">${step(PAGES[at - 1], "prev", "Previous")}${step(PAGES[at + 1], "next", "Next")}</div>`,
    aside: onPage.length < 3 ? "" : `  <nav class="toc" aria-label="On this page">
<h4>On this page</h4>
<ul>
${onPage.map((heading) => `<li><a href="#${heading.id}">${heading.html}</a></li>`).join("\n")}
</ul>
  </nav>
`,
  });
}

const indexHtml = () => layout({
  path: "/docs/", title: "Documentation", description: "Guides and reference for keyshroud: the local vault, Vaultwarden, team secret managers, Claude Code and other agents, the CLI and the security model.",
  article: `<article>
<h1>Documentation</h1>
<p>New here? The <a href="/#quickstart">quickstart</a> takes about a minute: <code>npm install -g keyshroud</code>, add one secret, run a command through <code>keyshroud run</code>. To have an agent do the setup, give it <a href="/install.md">the agent setup guide</a>.</p>
${GROUPS.map(([group, pages]) => `<h2>${group}</h2>
<div class="cards">
${pages.map(([slug, title, description]) => `<a class="card" href="/docs/${slug}"><b>${escape(title)}</b><span>${escape(description)}</span></a>`).join("\n")}
</div>`).join("\n")}
</article>`,
});

function build() {
  const links = [];
  const pages = PAGES.map((page) => render(page, links));
  for (const link of links) {
    if (!link.anchor) continue;
    if (!pages.find((page) => page.slug === link.slug).headings.some((heading) => heading.id === link.anchor)) throw new Error(`docs/${link.from}.md links to ${link.slug}.md#${link.anchor}, and no heading there has that anchor`);
  }
  const sitemap = readFileSync("site/sitemap.xml", "utf8");
  for (const path of ["/docs/", ...PAGES.map((page) => `/docs/${page.slug}`)]) if (!sitemap.includes(`<loc>${SITE}${path}</loc>`)) throw new Error(`site/sitemap.xml does not list ${SITE}${path}`);
  const files = new Map([["index.html", indexHtml()]]);
  for (const page of pages) { files.set(`${page.slug}.html`, pageHtml(page)); files.set(`${page.slug}.md`, page.markdown); }
  return files;
}

const files = build();
// docs.css and docs.js are written by hand; every other file here comes from this script.
const stale = existsSync(OUT) ? readdirSync(OUT).filter((name) => !files.has(name) && !["docs.css", "docs.js"].includes(name)) : [];
if (process.argv.includes("--check")) {
  const differ = [...files].filter(([name, text]) => !existsSync(`${OUT}/${name}`) || readFileSync(`${OUT}/${name}`, "utf8") !== text).map(([name]) => name);
  if (differ.length || stale.length) {
    console.error(`site/docs is out of date (${[...differ, ...stale].join(", ")}): run \`npm run site\` and commit the result`);
    process.exit(1);
  }
} else {
  if (stale.length) throw new Error(`site/docs has files that no page produces: ${stale.join(", ")}`);
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of files) writeFileSync(`${OUT}/${name}`, text);
  console.log(`site/docs: ${PAGES.length} pages`);
}
