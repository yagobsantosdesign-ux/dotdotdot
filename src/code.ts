// Main thread: has access to the Figma API but NO DOM/canvas.
// Responsibilities:
//   - read image bytes from the selected node's image fill and hand them to the UI
//   - receive the computed shape list and materialise it as editable vector nodes
import type { UiToMain, MainToUi, Shape } from "./shared";

const WHITE: RGB = { r: 1, g: 1, b: 1 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };
const BATCH = 500; // nodes created per tick, to keep Figma responsive

figma.showUI(__html__, { width: 360, height: 680, themeColors: true });

function post(msg: MainToUi) {
  figma.ui.postMessage(msg);
}

// Find the first image paint on the current selection (or a child, one level down).
function findImagePaint(): { hash: string; name: string } | null {
  const nodes = figma.currentPage.selection;
  for (const node of nodes) {
    const found = imageHashOf(node);
    if (found) return { hash: found, name: node.name };
  }
  return null;
}

function imageHashOf(node: SceneNode): string | null {
  if ("fills" in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as readonly Paint[]) {
      if (paint.type === "IMAGE" && paint.imageHash) return paint.imageHash;
    }
  }
  return null;
}

async function sendSelectedImage() {
  const found = findImagePaint();
  if (!found) {
    post({ type: "no-image" });
    return;
  }
  const image = figma.getImageByHash(found.hash);
  if (!image) {
    post({ type: "no-image" });
    return;
  }
  const bytes = await image.getBytesAsync();
  post({ type: "image", bytes, name: found.name });
}

async function generate(shapes: Shape[], canvasW: number, canvasH: number) {
  const nodes: SceneNode[] = [];

  // Black background sized to the output canvas.
  const bg = figma.createRectangle();
  bg.resize(canvasW, canvasH);
  bg.fills = [{ type: "SOLID", color: BLACK }];
  bg.name = "Background";
  nodes.push(bg);

  let done = 0;
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    // Every mark is a capsule (rounded rect): a square one renders as a circle, a wide
    // one as a horizontal dash — matching the live preview exactly.
    const r = figma.createRectangle();
    const w = Math.max(0.01, s.w);
    const h = Math.max(0.01, s.h);
    r.resize(w, h);
    r.x = s.x;
    r.y = s.y;
    r.cornerRadius = Math.min(w, h) / 2;
    r.fills = [{ type: "SOLID", color: WHITE }];
    nodes.push(r);

    done++;
    if (done % BATCH === 0) {
      post({ type: "progress", done, total: shapes.length });
      await new Promise((res) => setTimeout(res, 0)); // yield to keep UI alive
    }
  }

  // Group the dots/pills, then group that with the background inside a frame-like group.
  const dotsGroup = figma.group(nodes.slice(1), figma.currentPage);
  dotsGroup.name = "Dots";
  const root = figma.group([bg, dotsGroup], figma.currentPage);
  root.name = "Dot Matrix";

  // Place near viewport center and select it.
  root.x = Math.round(figma.viewport.center.x - canvasW / 2);
  root.y = Math.round(figma.viewport.center.y - canvasH / 2);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);

  post({ type: "generated" });
  figma.notify(`Dot Matrix criado (${shapes.length} formas).`);
}

figma.ui.onmessage = async (msg: UiToMain) => {
  if (msg.type === "request-image") {
    await sendSelectedImage();
  } else if (msg.type === "resize") {
    figma.ui.resize(Math.round(msg.width), Math.round(msg.height));
  } else if (msg.type === "generate") {
    await generate(msg.shapes, msg.canvasW, msg.canvasH);
  } else if (msg.type === "cancel") {
    figma.closePlugin();
  }
};

figma.on("selectionchange", () => {
  sendSelectedImage();
});

// Kick off with whatever is selected when the plugin opens.
sendSelectedImage();
