// Make the copy of the page that gets hosted: site/.share/pq-vault-demo/,
// with only the files a browser asks for. The folder keeps its link to the
// Vercel project between runs.
//
// Run: node site/share.mjs
// Then: vercel deploy site/.share/pq-vault-demo --yes
//
// Do not pass --prod. A preview deployment is behind sign-in to the Vercel
// account. The project's production address is public and holds a placeholder.

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const here = new URL("./", import.meta.url), out = new URL(".share/pq-vault-demo/", here);
const SERVED = ["index.html", "styles.css", "app.js", "clarity.js", "ledger.js", "amounts.js", "vercel.json", "data"];

mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (name !== ".vercel") rmSync(new URL(name, out), { recursive: true, force: true });
for (const name of SERVED) cpSync(new URL(name, here), new URL(name, out), { recursive: true });
console.log(`hosted copy in site/.share/pq-vault-demo: ${SERVED.join(", ")}`);
