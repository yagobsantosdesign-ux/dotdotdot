// Types shared between the main thread (code.ts) and the UI iframe (ui.ts).

export type Shape = {
  kind: "pill" | "dot";
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number; // uniform corner radius in px (0 = square, min(w,h)/2 = fully round)
  cr?: [number, number, number, number]; // modular mode: per-corner radii [tl, tr, br, bl]
};

// UI -> main
export type GenerateMsg = {
  type: "generate";
  shapes: Shape[];
  canvasW: number;
  canvasH: number;
};

export type ResizeMsg = { type: "resize"; width: number; height: number };

export type UiToMain =
  | GenerateMsg
  | ResizeMsg
  | { type: "cancel" }
  | { type: "request-image" };

// main -> UI
export type ImageMsg = {
  type: "image";
  bytes: Uint8Array;
  name: string;
};

export type MainToUi =
  | ImageMsg
  | { type: "no-image" }
  | { type: "progress"; done: number; total: number }
  | { type: "generated" };
