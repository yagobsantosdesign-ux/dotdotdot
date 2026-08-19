"use strict";
(() => {
  // src/code.ts
  var WHITE = { r: 1, g: 1, b: 1 };
  var BLACK = { r: 0, g: 0, b: 0 };
  var BATCH = 500;
  figma.showUI(__html__, { width: 360, height: 680, themeColors: true });
  function post(msg) {
    figma.ui.postMessage(msg);
  }
  function findImagePaint() {
    const nodes = figma.currentPage.selection;
    for (const node of nodes) {
      const found = imageHashOf(node);
      if (found) return { hash: found, name: node.name };
    }
    return null;
  }
  function imageHashOf(node) {
    if ("fills" in node && Array.isArray(node.fills)) {
      for (const paint of node.fills) {
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
  async function generate(shapes, canvasW, canvasH) {
    const nodes = [];
    const bg = figma.createRectangle();
    bg.resize(canvasW, canvasH);
    bg.fills = [{ type: "SOLID", color: BLACK }];
    bg.name = "Background";
    nodes.push(bg);
    let done = 0;
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      const r = figma.createRectangle();
      const w = Math.max(0.01, s.w);
      const h = Math.max(0.01, s.h);
      r.resize(w, h);
      if (s.rot) {
        const cx = s.x + w / 2;
        const cy = s.y + h / 2;
        const cos = Math.cos(s.rot);
        const sin = Math.sin(s.rot);
        r.relativeTransform = [
          [cos, -sin, cx - (cos * (w / 2) - sin * (h / 2))],
          [sin, cos, cy - (sin * (w / 2) + cos * (h / 2))]
        ];
      } else {
        r.x = s.x;
        r.y = s.y;
      }
      const maxR = Math.min(w, h) / 2;
      if (s.cr) {
        r.topLeftRadius = Math.max(0, Math.min(s.cr[0], maxR));
        r.topRightRadius = Math.max(0, Math.min(s.cr[1], maxR));
        r.bottomRightRadius = Math.max(0, Math.min(s.cr[2], maxR));
        r.bottomLeftRadius = Math.max(0, Math.min(s.cr[3], maxR));
      } else {
        r.cornerRadius = Math.max(0, Math.min(s.radius, maxR));
      }
      r.fills = [{ type: "SOLID", color: WHITE }];
      nodes.push(r);
      done++;
      if (done % BATCH === 0) {
        post({ type: "progress", done, total: shapes.length });
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    const dotsGroup = figma.group(nodes.slice(1), figma.currentPage);
    dotsGroup.name = "Dots";
    const root = figma.group([bg, dotsGroup], figma.currentPage);
    root.name = "Dot Matrix";
    root.x = Math.round(figma.viewport.center.x - canvasW / 2);
    root.y = Math.round(figma.viewport.center.y - canvasH / 2);
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    post({ type: "generated" });
    figma.notify(`Dot Matrix criado (${shapes.length} formas).`);
  }
  figma.ui.onmessage = async (msg) => {
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
  sendSelectedImage();
})();
