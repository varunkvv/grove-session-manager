// what grove chat can attach, decided the way the vs code extension decides it (webview `vm1` /
// `Ad0`): the image types the api takes, a pdf, and text - by its mime type, or by its name when
// chromium gives a code file an empty or wrong type (.ts comes as video/mp2t). anything else goes
// into the message as its path.

export type AttachKind = "image" | "pdf" | "text" | "unsupported";

const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  "application/x-typescript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/graphql",
  "application/toml",
  "application/x-toml",
]);

const TEXT_NAMES = new Set(
  (
    "json yaml yml toml ini cfg conf config env properties js jsx ts tsx mjs cjs mts cts py pyw rb " +
    "go rs java kt kts scala c h cpp hpp cc cxx cs fs fsx swift php pl pm lua r jl ex exs erl hrl " +
    "clj cljs cljc elm hs ml mli v sv vhd vhdl asm s html htm xhtml xml svg css scss sass less vue " +
    "svelte astro sh bash zsh fish ps1 psm1 psd1 bat cmd csv tsv sql graphql gql prisma md mdx " +
    "markdown rst txt text rtf tex latex org adoc asciidoc makefile cmake gradle dockerfile " +
    "containerfile vagrantfile rakefile gemfile podfile fastfile brewfile procfile lock sum log " +
    "diff patch gitignore gitattributes editorconfig prettierrc eslintrc babelrc npmrc nvmrc yarnrc"
  ).split(" "),
);
const BARE_NAMES = new Set([
  "license",
  "readme",
  "changelog",
  "authors",
  "contributors",
  "copying",
]);

function isText(type: string, name: string): boolean {
  if (type.startsWith("text/") || TEXT_TYPES.has(type)) return true;
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return TEXT_NAMES.has(ext) || TEXT_NAMES.has(lower) || BARE_NAMES.has(lower);
}

export function attachKind(type: string, name: string): AttachKind {
  const t = type.toLowerCase();
  if (IMAGES.includes(t)) return "image";
  if (t === "application/pdf") return "pdf";
  return isText(t, name) ? "text" : "unsupported";
}

/** 220 KB, 3.4 MB: a chip's size */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
