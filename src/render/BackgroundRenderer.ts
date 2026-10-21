import { Theme } from './Theme';
import trenchArt from '../assets/art/bg-trench.webp';

/**
 * 游戏画布的**风景背景层**。
 *
 * 口径：玩家看到的不是一块空画布，而是潜航器观察窗外的海沟。
 * 这一层只画"水"，不画任何地图信息：
 *
 *   1. 底色渐变（中心稍亮、四周压黑）
 *   2. AI 生成的海沟远景，带缓慢的推拉与横向漂移（视差）
 *   3. 体积光：几束从上方斜插下来的光柱，明暗呼吸
 *   4. 焦散：贴近水面的细碎光带，缓慢移动
 *   5. 暗角：把视线收到画面中心
 *
 * 全部强度压得很低（<= 0.22），保证"亮起来的部分才是信息"。
 * 系统偏好减少动态效果时，以上运动全部停在 t=0 的静态构图。
 */
export class BackgroundRenderer {
  private image: HTMLImageElement | null = null;

  /** 海雪微粒：位置由时间推导，不维护可变状态，减少动态效果时自然停在 t=0 */
  private readonly motes = Array.from({ length: 84 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.7 + Math.random() * 2.3,
    a: 0.16 + Math.random() * 0.42,
    rise: 0.004 + Math.random() * 0.012,
    sway: 0.008 + Math.random() * 0.02,
    ph: Math.random() * Math.PI * 2,
    depth: 0.35 + Math.random() * 0.65
  }));

  /** 生物荧光团：三处缓慢呼吸的冷光，让纯深蓝的水体有生命感 */
  private readonly blooms = [
    { x: 0.24, y: 0.7, r: 0.3, ph: 0 },
    { x: 0.79, y: 0.34, r: 0.22, ph: 2.1 },
    { x: 0.58, y: 0.88, r: 0.34, ph: 4.2 }
  ];

  constructor() {
    const img = new Image();
    img.decoding = 'async';
    img.src = trenchArt;
    img.onload = () => {
      this.image = img;
    };
  }

  /** 绘制背景；时间单位为秒 */
  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    time: number,
    reduceMotion: boolean
  ): void {
    const t = reduceMotion ? 0 : time;

    this.drawGradient(ctx, width, height);
    this.drawVista(ctx, width, height, t);
    this.drawBlooms(ctx, width, height, t);
    this.drawRays(ctx, width, height, t);
    this.drawCaustics(ctx, width, height, t);
    this.drawMotes(ctx, width, height, t);
    this.drawVignette(ctx, width, height);
  }

  private drawGradient(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w / 2;
    const cy = h * 0.44;
    const gradient = ctx.createRadialGradient(
      cx,
      cy,
      30,
      cx,
      h / 2,
      Math.max(w, h) * 0.8
    );
    gradient.addColorStop(0, Theme.backgroundInner);
    gradient.addColorStop(0.5, Theme.backgroundMid);
    gradient.addColorStop(1, Theme.backgroundOuter);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * 远景：等比铺满（cover）并放大 14%，留出推拉的余量。
   * 用 cover 而不是拉伸，是因为竖屏下画布又高又窄，
   * 直接拉伸会把海沟拉成一缕缕竖条；cover 只做裁切，画面比例始终正确。
   * 缩放按 0.5% 呼吸、横向按 1.2% 漂移——幅度小到不会干扰读图，但足以让画面"活"。
   */
  private drawVista(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    const img = this.image;
    if (!img) return;
    const ratio = img.naturalWidth / img.naturalHeight;
    const baseW = w / h > ratio ? w : h * ratio;
    const baseH = w / h > ratio ? w / ratio : h;
    const scale = 1.14 + Math.sin(t * 0.045) * 0.006;
    const dw = baseW * scale;
    const dh = baseH * scale;
    const driftX = Math.sin(t * 0.021) * w * 0.012;
    const driftY = Math.cos(t * 0.017) * h * 0.008;

    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.drawImage(img, (w - dw) / 2 + driftX, (h - dh) / 2 + driftY, dw, dh);
    // 第二层：镜像错位，压成极淡的"水汽"，让远景有纵深而不是一张贴图
    if (t > 0) {
      ctx.globalAlpha = 0.09;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(img, (w - dw) / 2 - driftX * 3, (h - dh) / 2 - driftY * 3, dw, dh);
    }
    ctx.restore();
  }

  /** 体积光：自左上方斜插的光柱，逐束呼吸 */
  private drawRays(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    const beams = 7;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < beams; i += 1) {
      const seed = i * 1.7;
      const sway = Math.sin(t * 0.06 + seed) * w * 0.05;
      const topX = w * (0.01 + i * 0.048) + sway;
      const bottomX = topX + w * (0.26 + i * 0.05) + Math.sin(t * 0.045 + seed) * w * 0.03;
      const beamW = w * (0.05 + (i % 3) * 0.02);
      const alpha = 0.11 + 0.06 * Math.sin(t * 0.22 + seed * 2.1);

      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `rgba(168, 233, 246, ${Math.max(0.04, alpha * 1.6)})`);
      g.addColorStop(0.55, `rgba(111, 211, 230, ${Math.max(0.02, alpha * 0.7)})`);
      g.addColorStop(1, 'rgba(111, 211, 230, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(topX, -h * 0.05);
      ctx.lineTo(topX + beamW, -h * 0.05);
      ctx.lineTo(bottomX + beamW * 2.2, h * 1.02);
      ctx.lineTo(bottomX, h * 1.02);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** 焦散：贴近水面的细碎光纹，用正弦叠加画出不规则的亮带 */
  private drawCaustics(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.max(1.4, h * 0.0024);
    ctx.strokeStyle = 'rgba(185, 240, 248, 0.085)';
    for (let band = 0; band < 5; band += 1) {
      const baseY = h * (0.06 + band * 0.1);
      ctx.beginPath();
      for (let x = -20; x <= w + 20; x += 14) {
        const y =
          baseY +
          Math.sin(x * 0.011 + t * 0.24 + band * 1.3) * h * 0.022 +
          Math.sin(x * 0.027 - t * 0.15 + band) * h * 0.01;
        if (x <= -20) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 生物荧光：三团极淡的冷光，各自以不同周期呼吸 */
  private drawBlooms(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const base = Math.max(w, h);
    for (const b of this.blooms) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.16 + b.ph);
      const radius = base * b.r * (0.92 + pulse * 0.12);
      const g = ctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, radius);
      g.addColorStop(0, `rgba(120, 226, 214, ${0.05 + pulse * 0.06})`);
      g.addColorStop(0.55, `rgba(96, 190, 210, ${0.02 + pulse * 0.025})`);
      g.addColorStop(1, 'rgba(96, 190, 210, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 海雪：缓慢上浮的微粒。
   * 位置全部由 t 推导（y 取模 1 循环），因此既不累积状态，也能在
   * prefers-reduced-motion 下停在 t=0 的静止构图。
   */
  private drawMotes(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) {
      const y = ((m.y - t * m.rise * m.depth) % 1 + 1) % 1;
      const x = m.x + Math.sin(t * 0.18 * m.depth + m.ph) * m.sway;
      const px = ((x % 1) + 1) % 1 * w;
      const py = y * h;
      const r = m.r * (0.55 + m.depth * 0.85);
      const alpha = m.a * (0.5 + 0.5 * Math.sin(t * 0.5 + m.ph)) * m.depth;
      if (alpha <= 0.01) continue;
      ctx.fillStyle = `rgba(198, 236, 246, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const g = ctx.createRadialGradient(
      w / 2,
      h * 0.46,
      Math.min(w, h) * 0.32,
      w / 2,
      h * 0.5,
      Math.max(w, h) * 0.78
    );
    g.addColorStop(0, 'rgba(2, 6, 9, 0)');
    g.addColorStop(1, 'rgba(2, 6, 9, 0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}
