import { LevelSession } from '../game/LevelSession';
import { Theme } from './Theme';
import { GLYPHS, GlyphName } from '../assets/artAssets';
import { BackgroundRenderer } from './BackgroundRenderer';

/**
 * 稳定的伪随机序列：同一个下标永远得到同一个 0~1 值。
 * 氛围微粒用它定位而不是 Math.random()，否则每帧重新洗牌、微粒会乱跳。
 */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Canvas 2D 渲染器。
 *
 * 只读取会话状态并绘制，不修改任何游戏数据。
 * 地图显示分三种状态：未知（不画布局）、当前显现（明亮）、探索记忆（低透明度）。
 *
 * 另外叠了一层纯装饰的**海洋氛围**（水光 / 悬浮微粒 / 上浮气泡，见 drawOcean*）：
 * 它均匀铺满整块画布，因此读不出任何关于地图布局的信息。
 */
export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** 系统偏好"减少动态效果"时，氛围层停住漂移（微粒本身保留） */
  private reduceMotion = false;
  /** 五枚金属徽记；未加载完成时对应位置回退到矢量绘制 */
  private glyphs: Partial<Record<GlyphName, HTMLImageElement>> = {};
  /** 风景背景层：海沟远景 + 体积光 + 焦散 */
  private backdrop = new BackgroundRenderer();
  /** HUD 上下浮层占用的高度（CSS 像素），地图只画在两者之间 */
  private insetTop = 0;
  private insetBottom = 0;
  private insetCheckedAt = -Infinity;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
    this.ctx = ctx;
    this.loadGlyphs();
    this.resize();
  }

  /** 预载徽记图片；失败或尚未就绪时由调用方回退到矢量绘制 */
  private loadGlyphs(): void {
    (Object.keys(GLYPHS) as GlyphName[]).forEach((name) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = GLYPHS[name];
      this.glyphs[name] = img;
    });
  }

  private glyphReady(name: GlyphName): HTMLImageElement | null {
    const img = this.glyphs[name];
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    return img;
  }

  /**
   * 画一枚徽记：居中、正方、按格子尺寸缩放。
   * 只在格子够大时使用图片——tile 小于 18 时缩到十几像素，
   * 照片级别的细节会糊成一团，不如保留原来的矢量符号。
   */
  private drawGlyph(name: GlyphName, cx: number, cy: number, tile: number, ratio: number, filter?: string): boolean {
    if (tile < 18) return false;
    const img = this.glyphReady(name);
    if (!img) return false;
    const size = tile * ratio;
    const { ctx } = this;
    const prevFilter = ctx.filter;
    if (filter) ctx.filter = filter;
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    ctx.filter = prevFilter;
    return true;
  }

  /** 根据窗口尺寸与 DPR 调整画布分辨率 */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.width = Math.max(320, Math.floor(rect.width));
    this.height = Math.max(240, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private drawBackground(): void {
    this.backdrop.draw(this.ctx, this.width, this.height, performance.now() / 1000, this.reduceMotion);
  }

  /**
   * 测量 HUD 顶栏、教程提示条与底栏的位置，得到地图可用的中间区域。
   * 布局稳定，每 400ms 重测一次即可；逐帧读 DOM 会反复触发布局计算。
   */
  private refreshInsets(): void {
    const now = performance.now();
    if (now - this.insetCheckedAt < 400) return;
    this.insetCheckedAt = now;

    const hud = document.getElementById('hud');
    const top = hud?.querySelector<HTMLElement>('.hud-top');
    const bottom = hud?.querySelector<HTMLElement>('.hud-bottom');
    if (!hud || hud.classList.contains('hidden') || !top || !bottom) {
      this.insetTop = 0;
      this.insetBottom = this.height;
      return;
    }

    let topEdge = top.getBoundingClientRect().bottom;
    const tip = hud.querySelector<HTMLElement>('.tipbar');
    if (tip && !tip.classList.contains('hidden')) {
      const tipRect = tip.getBoundingClientRect();
      if (tipRect.height > 0) topEdge = Math.max(topEdge, tipRect.bottom);
    }

    const topInset = Math.max(0, topEdge + 8);
    const bottomInset = Math.min(this.height, bottom.getBoundingClientRect().top - 8);
    // 极端情况下（窗口很矮）浮层可能把中间挤没，此时退回整块画布
    if (bottomInset - topInset < 120) {
      this.insetTop = 0;
      this.insetBottom = this.height;
      return;
    }
    this.insetTop = topInset;
    this.insetBottom = bottomInset;
  }

  /**
   * 海洋氛围之二：悬浮微粒（海雪）与上浮气泡。
   * 画在场景之上，透明度极低；位置用 hash01 稳定生成，避免逐帧乱跳。
   */
  private drawOceanDrift(now: number): void {
    const { ctx } = this;
    const t = this.reduceMotion ? 0 : now;
    const w = this.width;
    const h = this.height;

    ctx.save();

    // 悬浮微粒：缓慢下沉 / 侧移的细小颗粒
    const snowCount = Math.min(110, Math.round((w * h) / 11000));
    ctx.fillStyle = Theme.oceanSnow;
    for (let i = 0; i < snowCount; i += 1) {
      const speed = 0.004 + hash01(i + 707) * 0.01;
      const size = 0.7 + hash01(i + 991) * 1.4;
      const x = (hash01(i) * w + t * speed * w * 0.14) % w;
      const y = (hash01(i + 1301) * h + t * speed * h) % h;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // 上浮气泡：更大、更慢，带一圈更亮的边缘
    const bubbleCount = Math.min(16, Math.round((w * h) / 52000));
    for (let i = 0; i < bubbleCount; i += 1) {
      const speed = 0.018 + hash01(i + 211) * 0.028;
      const radius = 2 + hash01(i + 401) * 3.6;
      const span = h + radius * 4;
      const up = (t * speed * h) % span;
      const x = (((hash01(i + 53) * w + Math.sin(t * 0.6 + i * 1.7) * radius * 2.2) % w) + w) % w;
      const y = h + radius * 2 - up;

      ctx.fillStyle = Theme.oceanBubbleFill;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = Theme.oceanBubbleRim;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 绘制一帧。
   * @param session 当前关卡会话（标题页时为 null，只画背景）
   */
  draw(session: LevelSession | null): void {
    this.drawBackground();
    if (!session) return;
    this.refreshInsets();

    const map = session.map;
    // 地图只在 HUD 上下的浮层之间居中，而不是整块画布：
    // 否则教程提示条、摇杆会直接压住地图中央。
    const available = Math.max(120, this.insetBottom - this.insetTop);
    const tile = Math.floor(
      Math.min(this.width / map.width, available / map.height)
    );
    const tileSize = Math.max(8, tile);
    const originX = Math.floor((this.width - tileSize * map.width) / 2);
    const originY = Math.floor(this.insetTop + (available - tileSize * map.height) / 2);
    const now = session.visibility.time;

    // 悬浮微粒与气泡夹在场景之上，悬在水里的悬浮物；
    // 水光与体积光已经由背景层（BackgroundRenderer）负责。
    const { ctx } = this;
    // 挨打时的屏幕震动：整体平移一点，给"被扎到"一个身体上的反馈
    if (session.shakeTimer > 0) {
      const strength = Math.min(1, session.shakeTimer / 0.35) * 4.5;
      const sx = Math.sin(now * 90) * strength;
      const sy = Math.cos(now * 115) * strength;
      ctx.save();
      ctx.translate(sx, sy);
      this.drawScene(session, originX, originY, tileSize, now);
      ctx.restore();
    } else {
      this.drawScene(session, originX, originY, tileSize, now);
    }

    this.drawOceanDrift(now);
  }

  private drawScene(
    session: LevelSession,
    originX: number,
    originY: number,
    tileSize: number,
    now: number
  ): void {
    const map = session.map;
    this.drawUnknownField(originX, originY, tileSize, map.width, map.height, now);
    this.drawTiles(session, originX, originY, tileSize, now);
    this.drawHazards(session, originX, originY, tileSize, now);
    this.drawExit(session, originX, originY, tileSize, now);
    this.drawResonators(session, originX, originY, tileSize, now);
    this.drawPulse(session, originX, originY, tileSize);
    this.drawPlayer(session, originX, originY, tileSize, now);
    this.drawEffects(session, originX, originY, tileSize);
  }

  /**
   * 叠加"时间包络"与"空间照度"得到最终绘制透明度。
   *
   * - `alphaFor()` 负责时间维度：刚扫到时接近 1，之后衰减到记忆值 memoryAlpha；
   * - `intensityFor()` 负责空间维度：field 模型下越远的格子能量越低。
   *
   * 两者用**加权**而非直接相乘，是因为直接相乘会把远处格子压在记忆线以下，
   * 让"已经看清过的地形"重新变得不可辨认 —— 这跟探索记忆的设计意图相反。
   * 折中做法：照度只影响"当前明亮显现"这一段的高光强度，
   * 并以 memoryAlpha 为下限兜底，保证记住的地形永远看得见。
   *
   * bfs 模型下 intensity 恒为 1，结果与改造前逐像素一致。
   */
  private litAlpha(session: LevelSession, index: number, alpha: number): number {
    const memory = session.visibility.memoryAlpha;
    if (alpha <= memory + 0.001) return alpha;
    const intensity = session.visibility.intensityFor(index);
    // 把 (memory → 1) 这段按照度缩放：照度低时贴近 memory，照度高时保持原值
    const span = alpha - memory;
    return memory + span * intensity;
  }

  /** 未知区域：只画一层均匀底噪，不泄露任何布局 */
  private drawUnknownField(
    ox: number,
    oy: number,
    tile: number,
    cols: number,
    rows: number,
    now: number
  ): void {
    const { ctx } = this;
    const w = tile * cols;
    const h = tile * rows;
    ctx.save();

    // 扫描板：不是一块平涂的暗色，而是一块微微受光的仪器底板——
    // 中心亮一点、四边压下去，地图才像"嵌在舱板里"而不是浮在空处。
    const plate = ctx.createLinearGradient(ox, oy, ox, oy + h);
    plate.addColorStop(0, 'rgba(22, 50, 65, 0.52)');
    plate.addColorStop(0.55, 'rgba(11, 29, 40, 0.46)');
    plate.addColorStop(1, 'rgba(5, 15, 22, 0.56)');
    ctx.fillStyle = plate;
    ctx.fillRect(ox, oy, w, h);

    ctx.fillStyle = Theme.unknownBase;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(ox, oy, w, h);
    ctx.globalAlpha = 1;

    // 均匀纹理点阵：间距跟着格子走，让未知区也能读出"这是一张网"，
    // 但点太密会像噪点，所以固定压到很低的透明度。
    ctx.fillStyle = Theme.unknownGrid;
    const gap = Math.max(18, tile);
    for (let x = ox + gap / 2; x < ox + w; x += gap) {
      for (let y = oy + gap / 2; y < oy + h; y += gap) {
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }

    // 扫描网格：等距的细线铺满整块底板，只表达"这里是一张待扫描的网"，
    // 与真实格子边界无关，因此不泄露任何布局。
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(150, 205, 230, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox + gap; x < ox + w; x += gap) {
      ctx.moveTo(x + 0.5, oy);
      ctx.lineTo(x + 0.5, oy + h);
    }
    for (let y = oy + gap; y < oy + h; y += gap) {
      ctx.moveTo(ox, y + 0.5);
      ctx.lineTo(ox + w, y + 0.5);
    }
    ctx.stroke();

    // 扫描光带：一道几乎看不见的冷光自上而下扫过整块底板。
    // 它均匀横贯整个区域，不携带任何格子信息；减少动态效果时停在顶部。
    const sweepT = this.reduceMotion ? 0.2 : (now * 0.12) % 1;
    const sweepY = oy - h * 0.25 + sweepT * h * 1.5;
    const band = ctx.createLinearGradient(0, sweepY - h * 0.22, 0, sweepY + h * 0.22);
    band.addColorStop(0, 'rgba(111, 211, 230, 0)');
    band.addColorStop(0.5, 'rgba(111, 211, 230, 0.055)');
    band.addColorStop(1, 'rgba(111, 211, 230, 0)');
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, w, h);
    ctx.clip();
    ctx.fillStyle = band;
    ctx.fillRect(ox, sweepY - h * 0.22, w, h * 0.44);
    ctx.restore();

    // 外框：给整张地图一个"扫描区域"的边界，避免画面显得没有尽头。
    // 内外双线 + 一圈极淡的内发光，读起来像嵌在舱板上的取景窗。
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = 'rgba(216, 220, 224, 0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, w + 1, h + 1);
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = 'rgba(111, 211, 230, 0.14)';
    ctx.strokeRect(ox - 3.5, oy - 3.5, w + 7, h + 7);

    // 四角角标：像取景框一样把扫描区扣住，画面立刻有"仪器取景"的感觉
    ctx.globalAlpha = 0.62;
    ctx.strokeStyle = 'rgba(111, 211, 230, 0.9)';
    ctx.lineWidth = 2;
    const arm = Math.min(22, Math.min(w, h) * 0.06);
    const pad = 6;
    const corners: Array<[number, number, number, number]> = [
      [ox - pad, oy - pad, 1, 1],
      [ox + w + pad, oy - pad, -1, 1],
      [ox - pad, oy + h + pad, 1, -1],
      [ox + w + pad, oy + h + pad, -1, -1]
    ];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * arm);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * arm, cy);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTiles(
    session: LevelSession,
    ox: number,
    oy: number,
    tile: number,
    now: number
  ): void {
    const { ctx } = this;
    const map = session.map;

    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const index = map.index(x, y);
        const base = session.visibility.alphaFor(index);
        // 时间包络 + 空间照度：远处格子虽然"看得见"，但更暗
        const alpha = this.litAlpha(session, index, base);
        if (alpha <= 0.001) continue;
        // 出口与节点单独绘制，避免覆盖状态表现
        const kind = map.kindAt(x, y);
        if (kind === 'resonator' || kind === 'exit' || kind === 'spike' || kind === 'jammer') continue;

        const px = ox + x * tile;
        const py = oy + y * tile;
        const flash = session.visibility.flashFor(index);

        if (kind === 'wall') {
          // 墙：近黑岩体。体积靠"上下渐变 + 粗糙颗粒 + 只在临空一侧的岸光"表达，
          // 不再给每块墙描一圈白框——那会让成片的墙读起来像线框图而不是实心障碍。
          const jitter = hash01(x * 191 + y * 37);
          const wa = Math.min(1, alpha * 1.08);
          ctx.globalAlpha = wa;
          ctx.fillStyle = `rgb(${Math.round(6 + jitter * 9)}, ${Math.round(11 + jitter * 11)}, ${Math.round(16 + jitter * 13)})`;
          ctx.fillRect(px, py, tile, tile);

          if (tile >= 10) {
            // 顶面：上方水体照亮的一条窄带
            const faceH = Math.max(2, tile * 0.16);
            ctx.globalAlpha = wa * 0.9;
            const face = ctx.createLinearGradient(0, py, 0, py + faceH);
            face.addColorStop(0, 'rgba(150, 196, 208, 0.26)');
            face.addColorStop(1, 'rgba(150, 196, 208, 0)');
            ctx.fillStyle = face;
            ctx.fillRect(px, py, tile, faceH);

            // 底部积影：让墙体有重量，压得住下面的地面
            ctx.globalAlpha = wa * 0.8;
            const shade = ctx.createLinearGradient(0, py + tile * 0.5, 0, py + tile);
            shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
            shade.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
            ctx.fillStyle = shade;
            ctx.fillRect(px, py + tile * 0.5, tile, tile * 0.5);
          }

          // 岩石颗粒：三处固定位置的细碎亮点，避免墙面是一块死黑
          if (tile >= 14) {
            ctx.globalAlpha = wa * 0.55;
            ctx.fillStyle = 'rgba(170, 205, 216, 0.18)';
            for (let k = 0; k < 3; k += 1) {
              const rx = px + (0.18 + hash01(x * 31 + y * 57 + k) * 0.64) * tile;
              const ry = py + (0.2 + hash01(x * 71 + y * 13 + k * 7) * 0.6) * tile;
              ctx.fillRect(rx, ry, 1.6, 1.6);
            }
          }

          // 轮廓只画在"临空"的边上：连续的墙因此是一整块剪影，
          // 只有与地面相接的地方才勾出一条边，墙的边界反而更清楚。
          const up = y > 0 ? map.kindAt(x, y - 1) : 'wall';
          const down = y < map.height - 1 ? map.kindAt(x, y + 1) : 'wall';
          const left = x > 0 ? map.kindAt(x - 1, y) : 'wall';
          const right = x < map.width - 1 ? map.kindAt(x + 1, y) : 'wall';

          // 岸光：上沿被水光照到，冷色一条，墙顶因此"立"起来
          if (up !== 'wall') {
            ctx.globalAlpha = Math.min(1, wa * (0.7 + flash * 0.3));
            ctx.strokeStyle = 'rgba(120, 214, 232, 0.5)';
            ctx.lineWidth = Math.max(1, tile * 0.035);
            ctx.beginPath();
            ctx.moveTo(px + 1, py + 0.5);
            ctx.lineTo(px + tile - 1, py + 0.5);
            ctx.stroke();
          }

          // 轮廓兜底：记忆层淡下去后墙仍要能被认出来（忘了墙在哪就会撞上去）
          ctx.globalAlpha = Math.min(1, Math.max(0.3, alpha * (0.7 + flash * 0.3)));
          ctx.strokeStyle = Theme.wallStroke;
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (up !== 'wall') {
            ctx.moveTo(px + 0.5, py + 0.5);
            ctx.lineTo(px + tile - 0.5, py + 0.5);
          }
          if (down !== 'wall') {
            ctx.moveTo(px + 0.5, py + tile - 0.5);
            ctx.lineTo(px + tile - 0.5, py + tile - 0.5);
          }
          if (left !== 'wall') {
            ctx.moveTo(px + 0.5, py + 0.5);
            ctx.lineTo(px + 0.5, py + tile - 0.5);
          }
          if (right !== 'wall') {
            ctx.moveTo(px + tile - 0.5, py + 0.5);
            ctx.lineTo(px + tile - 0.5, py + tile - 0.5);
          }
          ctx.stroke();
        } else {
          // 舱板：每格的底色带一点恒定抖动（同一下标永远是同一个值），
          // 再叠"左上受光 / 右下积影"的斜面，地面才像一块块压在一起的金属板。
          const jitter = hash01(x * 73 + y * 151);
          ctx.globalAlpha = Math.min(1, alpha * 0.95);
          ctx.fillStyle = `rgb(${Math.round(30 + jitter * 16)}, ${Math.round(54 + jitter * 18)}, ${Math.round(64 + jitter * 20)})`;
          ctx.fillRect(px, py, tile, tile);

          // 明亮显现时补一层青色辉光（声波扫过的"余温"，强度恢复）
          if (alpha > 0.45) {
            ctx.globalAlpha = Math.min(1, (alpha - 0.45) * 1.1);
            ctx.fillStyle = Theme.floorGlow;
            ctx.fillRect(px, py, tile, tile);
          }

          // 斜面：上沿一条冷光、下沿与右沿一道积影，像微凸的舱板
          if (tile >= 12) {
            const lip = Math.max(1, tile * 0.08);
            ctx.globalAlpha = Math.min(1, alpha * 0.55);
            ctx.fillStyle = 'rgba(214, 243, 250, 0.22)';
            ctx.fillRect(px + 1, py + 1, tile - 2, lip);
            ctx.fillStyle = 'rgba(0, 8, 12, 0.4)';
            ctx.fillRect(px + 1, py + tile - lip - 1, tile - 2, lip);
            ctx.fillRect(px + tile - lip - 1, py + 1, lip, tile - 2);
          }

          // 格子内部再画一个小一号的方框，形成"砖缝"般的细网格。
          // 只在格子够大时画，否则 tile=8 的情况下会糊成一片。
          if (tile >= 14) {
            const inset = Math.max(2, tile * 0.17);
            ctx.globalAlpha = Math.min(1, alpha * (0.45 + flash * 0.5));
            ctx.strokeStyle = Theme.floorGrid;
            ctx.lineWidth = 1;
            ctx.strokeRect(px + inset, py + inset, tile - inset * 2, tile - inset * 2);
          }

          // 四角铆钉：格子够大时才画，小图上会退化成噪点
          if (tile >= 22) {
            const rivet = Math.max(1, tile * 0.028);
            const pad = Math.max(3, tile * 0.13);
            ctx.globalAlpha = Math.min(1, alpha * 0.5);
            ctx.fillStyle = 'rgba(206, 238, 246, 0.5)';
            for (let k = 0; k < 4; k += 1) {
              const sx = k < 2 ? 1 : -1;
              const sy = k % 2 === 0 ? 1 : -1;
              ctx.beginPath();
              ctx.arc(px + tile / 2 + sx * (tile / 2 - pad), py + tile / 2 + sy * (tile / 2 - pad), rivet, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          ctx.globalAlpha = Math.min(1, alpha * (0.3 + flash * 0.6));
          ctx.strokeStyle = Theme.floorStroke;
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, tile - 1, tile - 1);
        }

        // 刚被点亮的一瞬描边闪烁（声波扫过的"点亮"反馈，恢复亮度）
        if (flash > 0) {
          ctx.globalAlpha = flash;
          ctx.strokeStyle = Theme.pulseCore;
          ctx.lineWidth = 1.8;
          ctx.strokeRect(px + 0.75, py + 0.75, tile - 1.5, tile - 1.5);
        }
        ctx.globalAlpha = 1;
      }
    }
    void now;
  }

  /**
   * 绘制陷阱格。
   *
   * 两层信息叠加：
   * 1. 地面底色 —— 永远当作可通行格来画，因为陷阱本来就踩得上去；
   * 2. 陷阱标记 —— 只在"声波扫到过"之后才出现（knownTrap），
   *    显现结束后也继续以警示色保留，这样玩家探索一次就能记住并绕开。
   *
   * 因此未知区域的陷阱与普通地面完全一样，不会提前剧透。
   */
  private drawHazards(
    session: LevelSession,
    ox: number,
    oy: number,
    tile: number,
    now: number
  ): void {
    const { ctx } = this;
    const map = session.map;

    for (const trap of map.traps) {
      const index = map.index(trap.x, trap.y);
      const known = session.visibility.isTrapKnown(index);
      const base = session.visibility.alphaFor(index);
      // 没被声波扫到过就完全不画，跟未知区域融为一体
      if (!known) continue;

      const px = ox + trap.x * tile;
      const py = oy + trap.y * tile;
      const isSpike = map.kindAt(trap.x, trap.y) === 'spike';
      const flash = session.visibility.flashFor(index);
      // 陷阱的可读性优先于照度衰减：远处陷阱也照旧暗到可辨认，
      // 所以这里对照度只做很轻的衰减（半程），而不是完全套用 litAlpha。
      const lit = this.litAlpha(session, index, base);
      const alpha = base + (lit - base) * 0.5;
      // 记忆层也要保持醒目：这是玩家唯一能依赖的危险信息
      const strength = Math.max(alpha, 0.55);

      ctx.save();

      // 地面底色，避免陷阱格看起来像个黑洞
      ctx.globalAlpha = Math.min(1, Math.max(alpha, 0.28) * 0.95);
      ctx.fillStyle = Theme.floorFill;
      ctx.fillRect(px, py, tile, tile);

      ctx.globalAlpha = Math.min(1, strength * (0.4 + flash * 0.6));
      ctx.fillStyle = isSpike ? Theme.hazardSpikeFill : Theme.hazardJammerFill;
      ctx.fillRect(px, py, tile, tile);

      // 边框：警示色描边，比普通地面的描边更实
      ctx.globalAlpha = Math.min(1, strength * (0.7 + flash * 0.3));
      ctx.strokeStyle = isSpike ? Theme.hazardSpikeStroke : Theme.hazardJammerStroke;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(px + 0.7, py + 0.7, tile - 1.4, tile - 1.4);

      // 明亮的当前显现再补一层辉光，跟记忆层拉开对比
      if (alpha > 0.5) {
        ctx.globalAlpha = (alpha - 0.5) * 0.5;
        ctx.fillStyle = isSpike ? Theme.hazardSpikeGlow : Theme.hazardJammerGlow;
        ctx.fillRect(px, py, tile, tile);
      }

      ctx.globalAlpha = Math.min(1, strength * 1.15);
      if (isSpike) this.drawSpikeGlyph(px, py, tile, flash, now);
      else this.drawJammerGlyph(px, py, tile, flash, now);

      ctx.restore();
    }
  }

  /** 尖刺：优先用金属徽记；小格子回退成朝上的三角锯齿 */
  private drawSpikeGlyph(
    px: number,
    py: number,
    tile: number,
    flash: number,
    now: number
  ): void {
    const { ctx } = this;
    const cx = px + tile / 2;
    const cy = py + tile / 2;
    const r = tile * 0.3;
    // 轻微脉动，让危险格在记忆层也能被一眼扫到
    const pulse = 1 + Math.sin(now * 3.2) * 0.06;

    if (this.drawGlyph('spike', cx, cy, tile, 0.66, `brightness(${1 + flash * 0.35})`)) return;

    ctx.strokeStyle = Theme.hazardSpike;
    ctx.lineWidth = Math.max(1.5, tile * 0.075);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 1.05 * pulse, cy + r * 0.72);
    ctx.lineTo(cx, cy - r * 0.95 * pulse);
    ctx.lineTo(cx + r * 1.05 * pulse, cy + r * 0.72);
    ctx.stroke();
    // 底座横线，让它读起来像钉在格子里的刺
    ctx.globalAlpha *= 0.75 + flash * 0.25;
    ctx.beginPath();
    ctx.moveTo(cx - r * 1.25, cy + r * 0.82);
    ctx.lineTo(cx + r * 1.25, cy + r * 0.82);
    ctx.stroke();
  }

  /** 回声干扰器：扩散波纹保留（那是"让周围遗忘"的动效），中心换成紫铜徽记 */
  private drawJammerGlyph(
    px: number,
    py: number,
    tile: number,
    flash: number,
    now: number
  ): void {
    const { ctx } = this;
    const cx = px + tile / 2;
    const cy = py + tile / 2;
    const base = tile * 0.14;

    ctx.strokeStyle = Theme.hazardJammer;
    ctx.lineWidth = Math.max(1.2, tile * 0.055);
    // 向外扩散的涟漪，暗示"忘掉周围"
    for (let ring = 0; ring < 2; ring += 1) {
      const phase = (now * 0.8 + ring * 0.5) % 1;
      const radius = base + phase * tile * 0.26;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.drawGlyph('jammer', cx, cy, tile, 0.66, `brightness(${1 + flash * 0.35})`)) return;

    ctx.globalAlpha = Math.min(1, (0.8 + flash * 0.2));
    ctx.fillStyle = Theme.hazardJammer;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1.5, tile * 0.07), 0, Math.PI * 2);
    ctx.fill();
  }

  private drawResonators(
    session: LevelSession,
    ox: number,
    oy: number,
    tile: number,
    now: number
  ): void {
    const { ctx } = this;
    for (const resonator of session.resonators) {
      const index = resonator.index;
      // 节点是硬目标，照度只轻微参与：再远也要能看出"那里有个节点"，
      // 否则玩家会误以为声波没扫到它、跑去重复发射。
      const base = session.visibility.alphaFor(index);
      const alpha = base + (this.litAlpha(session, index, base) - base) * 0.5;
      if (alpha <= 0.001) continue;

      const cx = ox + (resonator.x + 0.5) * tile;
      const cy = oy + (resonator.y + 0.5) * tile;
      const r = tile * 0.26;

      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha * 1.1);

      if (resonator.active) {
        // 激活后：暖色光晕 + 呼吸光环 + 一圈外旋刻线，读起来"已锁定"。
        // 中心符号换成铜金共鸣器徽记，并用 filter 把它推向暖色，和未激活态拉开。
        const pulse = 0.5 + 0.5 * Math.sin(now * 3.2);
        ctx.fillStyle = Theme.nodeGlow;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1.9 + pulse * 0.35), 0, Math.PI * 2);
        ctx.fill();

        const drewGlyph = this.drawGlyph(
          'node',
          cx,
          cy,
          tile,
          0.72,
          'sepia(1) saturate(2.2) brightness(1.3)'
        );
        if (!drewGlyph) {
          ctx.fillStyle = Theme.nodeActive;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();

          // 内层高光，跟玩家球体用同一套"被上方照亮"的语言
          ctx.globalAlpha = Math.min(1, alpha * 0.75);
          ctx.fillStyle = '#fff0cf';
          ctx.beginPath();
          ctx.arc(cx - r * 0.2, cy - r * 0.22, r * 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = Math.min(1, alpha * 1.1);
        }

        ctx.strokeStyle = Theme.nodeInactive;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1.35 + pulse * 0.18), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // 未激活：空心描边 + 缓慢旋转的断弧，提示"这是待激活目标"，
        // 与出口的静止圆门在形状上彻底区分开
        ctx.strokeStyle = Theme.nodeInactive;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = Math.min(1, alpha * 0.7);
        ctx.lineWidth = 2;
        const spin = now * 0.9;
        for (let i = 0; i < 3; i += 1) {
          const start = spin + (i * Math.PI * 2) / 3;
          ctx.beginPath();
          ctx.arc(cx, cy, r * 1.5, start, start + 0.5);
          ctx.stroke();
        }

        ctx.globalAlpha = Math.min(1, alpha * 1.1);
        const drewGlyph = this.drawGlyph(
          'node',
          cx,
          cy,
          tile,
          0.68,
          'grayscale(0.45) brightness(0.62)'
        );
        if (!drewGlyph) {
          ctx.globalAlpha = Math.min(1, alpha * 0.55);
          ctx.fillStyle = Theme.nodeGlow;
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  private drawExit(
    session: LevelSession,
    ox: number,
    oy: number,
    tile: number,
    now: number
  ): void {
    const { ctx } = this;
    const exit = session.map.exit;
    const index = session.map.index(exit.x, exit.y);
    // 出口和节点同理：照度只轻微参与，保证"看得见它在哪"这件事不因距离而丢。
    const base = session.visibility.alphaFor(index);
    const alpha = base + (this.litAlpha(session, index, base) - base) * 0.5;
    if (alpha <= 0.001) return;

    const px = ox + exit.x * tile;
    const py = oy + exit.y * tile;
    const cx = px + tile / 2;
    const cy = py + tile / 2;
    const r = tile * 0.3;

    ctx.save();
    // 出口格本身走得上去（未开启时不再挡路），所以先铺一层地面底色，
    // 让它读起来"站得住"，而不是一块被挖空的黑暗洞口。
    ctx.globalAlpha = Math.min(1, alpha * 0.95);
    ctx.fillStyle = Theme.floorFill;
    ctx.fillRect(px, py, tile, tile);

    ctx.globalAlpha = Math.min(1, alpha * 1.1);

    if (session.exitOpen) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 2.6);
      // 双层外扩光晕，强调"这里可以走了"
      ctx.fillStyle = Theme.exitGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (2.4 + pulse * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.6 + pulse * 0.2), 0, Math.PI * 2);
      ctx.fill();

      const drewGlyph = this.drawGlyph('exit', cx, cy, tile, 0.78, 'brightness(1.25) saturate(1.15)');
      if (!drewGlyph) {
        ctx.fillStyle = Theme.exitOpen;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = Math.min(1, alpha * 0.8);
        ctx.fillStyle = '#eafff5';
        ctx.beginPath();
        ctx.arc(cx - r * 0.2, cy - r * 0.22, r * 0.36, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, alpha * 1.1);
      }

      ctx.strokeStyle = Theme.exitOpen;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.45 + pulse * 0.2), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // 未开启：暗色圆门 + 一圈"锁扣"，明确表示"还不能进"
      const drewGlyph = this.drawGlyph('exit', cx, cy, tile, 0.78, 'grayscale(0.7) brightness(0.52)');
      if (!drewGlyph) {
        ctx.strokeStyle = Theme.exitClosed;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.stroke();

        // 内层小菱形，让"锁"的感觉更具体
        ctx.globalAlpha = Math.min(1, alpha * 0.5);
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.42);
        ctx.lineTo(cx + r * 0.42, cy);
        ctx.lineTo(cx, cy + r * 0.42);
        ctx.lineTo(cx - r * 0.42, cy);
        ctx.closePath();
        ctx.stroke();
      }

      ctx.globalAlpha = Math.min(1, alpha * 0.4);
      ctx.strokeStyle = Theme.exitClosed;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.55, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 声波装饰波纹：只是视觉，显现判定由 BFS 完成 */
  private drawPulse(session: LevelSession, ox: number, oy: number, tile: number): void {
    const pulse = session.pulseSystem.pulse;
    if (!pulse) return;
    const { ctx } = this;

    const cx = ox + (pulse.originX + 0.5) * tile;
    const cy = oy + (pulse.originY + 0.5) * tile;
    const progress = Math.min(1, pulse.elapsed / Math.max(0.0001, pulse.travelDuration));
    const maxDist = (session.pulseSystem.pulse?.maxDistance ?? 8) * tile;
    const radius = progress * maxDist + tile * 0.5;
    const fade =
      pulse.elapsed <= pulse.travelDuration
        ? 1
        : 1 - (pulse.elapsed - pulse.travelDuration) / Math.max(0.0001, pulse.totalDuration - pulse.travelDuration);
    const a = Math.max(0, fade);

    ctx.save();

    // 原来的多层声波：雾带 / 主波前 / 拖尾 / 核心闪光。
    // "去 AI 味"那一轮把亮度压得太低，声波几乎看不见了——这里把强度全部调回来。
    // 声波是唯一的高饱和色，本来就该是最抢眼的东西，克制应该用在界面上而不是玩法反馈上。

    // 1. 宽而淡的雾带：负责"能量经过"的体积感。
    //    用青色而不是纯白，否则叠起来会变成一道灰环而不是"雾"。
    ctx.globalAlpha = a * 0.18;
    ctx.strokeStyle = Theme.pulseRing + '1)';
    ctx.lineWidth = Math.max(6, tile * 0.55);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.94, 0, Math.PI * 2);
    ctx.stroke();

    // 1.5 波壳：从波前向内衰减的径向渐变，让声波有"一层壳"而不是一条线
    if (a > 0.02 && radius > tile) {
      const shell = ctx.createRadialGradient(
        cx, cy, Math.max(0, radius - tile * 1.15), cx, cy, radius
      );
      shell.addColorStop(0, 'rgba(111, 211, 230, 0)');
      shell.addColorStop(0.75, `rgba(111, 211, 230, ${0.1 * a})`);
      shell.addColorStop(1, 'rgba(200, 242, 250, 0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = shell;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 主波前：最亮的一圈，代表"正在扫描的边界"
    ctx.globalAlpha = a * 1.0;
    ctx.strokeStyle = Theme.pulseCore;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 3. 拖尾第二圈：落后一点，制造"回声"的读感
    const trail = Math.max(0, radius - tile * 1.1);
    if (trail > 0) {
      ctx.globalAlpha = a * 0.5;
      ctx.strokeStyle = Theme.pulseCore;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, trail, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 4. 发射瞬间的核心闪光
    if (pulse.elapsed < 0.3) {
      const k = 1 - pulse.elapsed / 0.3;
      ctx.globalAlpha = k * 0.9;
      ctx.fillStyle = Theme.pulseCore;
      ctx.beginPath();
      ctx.arc(cx, cy, tile * (0.3 + (1 - k) * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPlayer(
    session: LevelSession,
    ox: number,
    oy: number,
    tile: number,
    now: number
  ): void {
    const { ctx } = this;
    const player = session.player;
    const bumpOffset =
      player.bumpTimer > 0 ? Math.sin((player.bumpTimer / 0.22) * Math.PI * 2) * tile * 0.12 : 0;
    const cx = ox + (player.visualX + 0.5) * tile + player.bumpDirX * bumpOffset;
    const cy = oy + (player.visualY + 0.5) * tile + player.bumpDirY * bumpOffset;
    const r = tile * 0.3;

    ctx.save();
    // 外圈呼吸光晕：告诉玩家"这是我"，同时暗示脉冲从本体发出
    const breathe = 0.5 + 0.5 * Math.sin(now * 2.2);
    ctx.globalAlpha = 0.2 + breathe * 0.14;
    ctx.fillStyle = Theme.playerHalo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1.9 + breathe * 0.3), 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    // 本体优先用 AI 徽记；图片未就绪时回退到原来的球体 + 高光
    const drewGlyph = this.drawGlyph('player', cx, cy, tile, 0.74);
    if (!drewGlyph) {
      ctx.fillStyle = Theme.player;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // 高光小圆点做偏左上，让球体看起来是被光从上方照亮的
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = Theme.playerCore;
      ctx.beginPath();
      ctx.arc(cx - r * 0.18, cy - r * 0.2, r * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 细描边把玩家从同色系的地板上拎出来（仅矢量回退时用，
    // 徽记本身已带暗部轮廓，再套一圈圆环会压住细节）
    if (!drewGlyph) {
      ctx.strokeStyle = 'rgba(2, 9, 14, 0.55)';
      ctx.lineWidth = Math.max(1, tile * 0.045);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 无敌帧：玩家本体闪烁 + 一圈红环，明确告诉玩家"这段时间不会再掉血"
    if (session.invulnerableTimer > 0) {
      const blink = 0.5 + Math.sin(now * 34) * 0.5;
      ctx.globalAlpha = 0.35 + blink * 0.5;
      ctx.strokeStyle = Theme.hazardSpike;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.5 + blink * 0.22), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (player.bumpTimer > 0) {
      ctx.globalAlpha = player.bumpTimer / 0.22 * 0.8;
      ctx.strokeStyle = '#ff8080';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawEffects(session: LevelSession, ox: number, oy: number, tile: number): void {
    const { ctx } = this;
    ctx.save();
    for (const p of session.effects.particleList) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(ox + p.x * tile, oy + p.y * tile, (p.size / 10) * tile * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const r of session.effects.rippleList) {
      ctx.globalAlpha = Math.max(0, r.life / r.maxLife) * 0.6;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox + r.x * tile, oy + r.y * tile, r.radius * tile, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}
