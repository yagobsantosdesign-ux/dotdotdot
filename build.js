// Build script: bundles the main thread (code.ts) and the UI (ui.ts),
// then inlines the UI JS into a single self-contained dist/ui.html that Figma loads.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const outdir = path.join(__dirname, "dist");
fs.mkdirSync(outdir, { recursive: true });

const htmlTemplate = () => fs.readFileSync(path.join(__dirname, "src", "ui.html"), "utf8");

// esbuild plugin that, after the UI JS is bundled, injects it inline into ui.html.
const inlineHtmlPlugin = {
  name: "inline-html",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const jsPath = path.join(outdir, "ui.js");
      const js = fs.readFileSync(jsPath, "utf8");
      const html = htmlTemplate().replace(
        "<!-- INLINE_SCRIPT -->",
        `<script>\n${js}\n</script>`
      );
      fs.writeFileSync(path.join(outdir, "ui.html"), html);
      fs.rmSync(jsPath, { force: true });
      console.log("[build] ui.html written");
    });
  },
};

const codeCtx = {
  entryPoints: [path.join(__dirname, "src", "code.ts")],
  bundle: true,
  target: "es2017",
  outfile: path.join(outdir, "code.js"),
  logLevel: "info",
};

const uiCtx = {
  entryPoints: [path.join(__dirname, "src", "ui.ts")],
  bundle: true,
  target: "es2017",
  outfile: path.join(outdir, "ui.js"),
  plugins: [inlineHtmlPlugin],
  logLevel: "info",
};

async function run() {
  if (watch) {
    const c1 = await esbuild.context(codeCtx);
    const c2 = await esbuild.context(uiCtx);
    await Promise.all([c1.watch(), c2.watch()]);
    console.log("[build] watching for changes...");
  } else {
    await esbuild.build(codeCtx);
    await esbuild.build(uiCtx);
    console.log("[build] done");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
