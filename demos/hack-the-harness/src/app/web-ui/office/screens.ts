import { CanvasTexture, SRGBColorSpace } from "three";

// Easter egg: hand-drawn 1990s Windows screens for the CRTs.
export type ScreenName = "bsod" | "excel" | "minesweeper" | "word";

const W = 320;
const H = 280;
const FACE = "#c0c0c0";
const TITLE = "#000080";
const DESKTOP = "#008080";

type Ctx = CanvasRenderingContext2D;

function bevel(ctx: Ctx, x: number, y: number, w: number, h: number, pressed = false) {
  ctx.fillStyle = FACE;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = pressed ? "#808080" : "#ffffff";
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = pressed ? "#ffffff" : "#808080";
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
}

function text(ctx: Ctx, value: string, x: number, y: number, color = "#000", size = 12, weight = "normal") {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "MS Sans Serif", Tahoma, Arial, sans-serif`;
  ctx.fillText(value, x, y);
}

function window95(ctx: Ctx, x: number, y: number, w: number, h: number, title: string) {
  bevel(ctx, x, y, w, h);
  ctx.fillStyle = TITLE;
  ctx.fillRect(x + 3, y + 3, w - 6, 18);
  text(ctx, title, x + 7, y + 16, "#fff", 12, "bold");
  for (let i = 0; i < 3; i++) bevel(ctx, x + w - 22 - i * 18, y + 5, 16, 14);
  text(ctx, "×", x + w - 18, y + 16, "#000", 12, "bold");
}

function taskbar(ctx: Ctx, label: string) {
  bevel(ctx, 0, H - 26, W, 26);
  bevel(ctx, 3, H - 23, 58, 20);
  ctx.fillStyle = "#f00";
  ctx.fillRect(9, H - 18, 5, 5);
  ctx.fillStyle = "#0a0";
  ctx.fillRect(15, H - 18, 5, 5);
  ctx.fillStyle = "#00f";
  ctx.fillRect(9, H - 12, 5, 5);
  ctx.fillStyle = "#fc0";
  ctx.fillRect(15, H - 12, 5, 5);
  text(ctx, "Start", 24, H - 8, "#000", 12, "bold");
  bevel(ctx, 66, H - 23, 120, 20, true);
  text(ctx, label, 72, H - 8);
  bevel(ctx, W - 58, H - 23, 55, 20, true);
  text(ctx, "4:51 PM", W - 52, H - 8, "#000", 11);
}

const draw: Record<ScreenName, (ctx: Ctx) => void> = {
  bsod(ctx) {
    ctx.fillStyle = "#0000aa";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#aaaaaa";
    ctx.fillRect(W / 2 - 40, 34, 80, 18);
    text(ctx, " Windows ", W / 2 - 34, 48, "#0000aa", 14, "bold");
    const lines = [
      "A fatal exception 0E has occurred at",
      "0028:C0011E36 in VXD VMM(01) +",
      "00010E36. The current application",
      "will be terminated.",
      "",
      "* Press any key to terminate the",
      "  current application.",
      "* Press CTRL+ALT+DEL again to restart",
      "  your computer. You will lose any",
      "  unsaved information.",
      "",
      "     Press any key to continue _",
    ];
    lines.forEach((line, i) => text(ctx, line, 18, 80 + i * 15, "#fff", 12, "bold"));
  },

  excel(ctx) {
    ctx.fillStyle = DESKTOP;
    ctx.fillRect(0, 0, W, H);
    window95(ctx, 0, 0, W, H - 26, "Microsoft Excel - Q3SALES.XLS");
    text(ctx, "File  Edit  View  Insert  Format  Tools  Data", 8, 36);
    ctx.fillStyle = "#fff";
    ctx.fillRect(4, 44, W - 8, H - 76);
    const cols = ["", "A", "B", "C", "D"];
    const rows = [
      ["Region", "Jul", "Aug", "Sep"],
      ["North", "120", "135", "160"],
      ["South", "98", "110", "104"],
      ["East", "143", "151", "170"],
      ["West", "87", "95", "121"],
    ];
    ctx.fillStyle = FACE;
    ctx.fillRect(4, 44, W - 8, 14);
    ctx.fillRect(4, 44, 22, H - 76);
    cols.forEach((c, i) => i && text(ctx, c, 26 + (i - 1) * 50 + 20, 55, "#000", 11, "bold"));
    ctx.strokeStyle = "#c0c0c0";
    for (let r = 0; r < 12; r++) {
      text(ctx, String(r + 1), 9, 70 + r * 14, "#000", 10);
      ctx.beginPath();
      ctx.moveTo(26, 58 + (r + 1) * 14);
      ctx.lineTo(226, 58 + (r + 1) * 14);
      ctx.stroke();
      rows[r]?.forEach((cell, c) => text(ctx, cell, 30 + c * 50, 70 + r * 14, "#000", 11, r === 0 ? "bold" : "normal"));
    }
    // Little bar chart beside the data.
    bevel(ctx, 232, 60, 80, 110);
    ctx.fillStyle = "#fff";
    ctx.fillRect(236, 64, 72, 102);
    [[120, 135, 160], [98, 110, 104], [143, 151, 170], [87, 95, 121]].forEach((series, s) =>
      series.forEach((v, m) => {
        ctx.fillStyle = ["#000080", "#800080", "#008080"][m];
        const h = v / 2;
        ctx.fillRect(240 + s * 17 + m * 5, 162 - h, 4, h);
      }),
    );
    taskbar(ctx, "Microsoft Excel");
  },

  minesweeper(ctx) {
    ctx.fillStyle = DESKTOP;
    ctx.fillRect(0, 0, W, H);
    window95(ctx, 70, 20, 180, 220, "Minesweeper");
    text(ctx, "Game  Help", 76, 56);
    bevel(ctx, 78, 62, 164, 36, true);
    ctx.fillStyle = "#000";
    ctx.fillRect(84, 68, 40, 24);
    ctx.fillRect(196, 68, 40, 24);
    text(ctx, "010", 87, 88, "#f00", 20, "bold");
    text(ctx, "042", 199, 88, "#f00", 20, "bold");
    bevel(ctx, 148, 68, 24, 24);
    ctx.fillStyle = "#ff0";
    ctx.beginPath();
    ctx.arc(160, 80, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.fillRect(156, 77, 2, 2);
    ctx.fillRect(162, 77, 2, 2);
    ctx.fillRect(156, 83, 8, 2);
    const grid = [
      "1 1 2 . . . . . .",
      "1 F 2 . . . . . .",
      "1 1 1 1 2 . . . .",
      "0 0 0 1 F . . . .",
      "0 0 0 1 1 2 . . .",
      "1 1 0 0 0 1 . . .",
      "F 1 0 0 0 1 2 . .",
      "1 1 0 0 0 0 1 . .",
    ].map(row => row.split(" "));
    const colors: Record<string, string> = { "1": "#00f", "2": "#080", "3": "#f00" };
    grid.forEach((row, r) =>
      row.forEach((cell, c) => {
        const x = 80 + c * 18;
        const y = 104 + r * 16;
        if (cell === "." || cell === "F") {
          bevel(ctx, x, y, 18, 16);
          if (cell === "F") text(ctx, "▶", x + 4, y + 13, "#f00", 11, "bold");
        } else {
          ctx.fillStyle = FACE;
          ctx.fillRect(x, y, 18, 16);
          ctx.strokeStyle = "#808080";
          ctx.strokeRect(x + 0.5, y + 0.5, 18, 16);
          if (cell !== "0") text(ctx, cell, x + 5, y + 13, colors[cell], 12, "bold");
        }
      }),
    );
    taskbar(ctx, "Minesweeper");
  },

  word(ctx) {
    ctx.fillStyle = DESKTOP;
    ctx.fillRect(0, 0, W, H);
    window95(ctx, 0, 0, W, H - 26, "Microsoft Word - LETTER.DOC");
    text(ctx, "File  Edit  View  Insert  Format  Tools", 8, 36);
    ctx.fillStyle = "#808080";
    ctx.fillRect(4, 44, W - 8, H - 76);
    ctx.fillStyle = "#fff";
    ctx.fillRect(20, 50, 200, H - 82);
    ["Dear Sir or Madam,", "", "I am writing to inform you", "that the quarterly TPS", "reports are now available", "in the shared drive. Please", "remember to use the new", "cover sheet._"].forEach(
      (line, i) => text(ctx, line, 30, 72 + i * 15, "#000", 11),
    );
    // The paperclip assistant and its speech bubble.
    ctx.fillStyle = "#ffffe1";
    ctx.fillRect(196, 70, 118, 62);
    ctx.strokeStyle = "#000";
    ctx.strokeRect(196.5, 70.5, 118, 62);
    ["It looks like you're", "writing a letter.", "Would you like help?"].forEach((line, i) => text(ctx, line, 202, 88 + i * 14, "#000", 10));
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(258, 220);
    ctx.lineTo(258, 160);
    ctx.arc(268, 160, 10, Math.PI, 0);
    ctx.lineTo(278, 215);
    ctx.arc(271, 215, 7, 0, Math.PI);
    ctx.lineTo(264, 170);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#fff";
    ctx.fillRect(259, 172, 8, 8);
    ctx.fillRect(271, 172, 8, 8);
    ctx.fillStyle = "#000";
    ctx.fillRect(263, 175, 3, 3);
    ctx.fillRect(275, 175, 3, 3);
    taskbar(ctx, "Microsoft Word");
  },
};

const cache = new Map<ScreenName, CanvasTexture>();

export function screenTexture(name: ScreenName) {
  let texture = cache.get(name);

  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    draw[name](canvas.getContext("2d")!);
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    cache.set(name, texture);
  }

  return texture;
}
