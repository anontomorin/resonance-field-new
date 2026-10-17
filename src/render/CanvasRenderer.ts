import { LevelSession } from '../game/LevelSession';
import { Theme } from './Theme';

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
    this.ctx = ctx;
    this.resize();
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
    const { ctx } = this;
    // 三层径向渐变：中心一圈稍亮，中段过渡，四周压到近黑。
    // 只用一个中心 + 一个边缘会让画面显得"平板"，中间那层负责制造纵深。
    const cx = this.width / 2;
    const cy = this.height * 0.44;
    const gradient = ctx.createRadialGradient(cx, cy, 30, cx, this.height / 2, Math.max(this.width, this.height) * 0.8);
    gradient.addColorStop(0, Theme.backgroundInner);
    gradient.addColorStop(0.5, Theme.backgroundMid);
    gradient.addColorStop(1, Theme.backgroundOuter);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * 海洋氛围之一：水光。
   * 两团极淡的光斑缓慢掠过水面，均匀铺满画布，压在场景最底层制造"在水下"的体积感。
   */
  private drawOceanHaze(now: number): void {
    const { ctx } = this;
    const w = this.width;
    const h = this.height;
    const t = this.reduceMotion ? 0 : now;
    const driftX = (t * 0.013) % 1;
    const driftY = (t * 0.009) % 1;

    ctx.save();
    ctx.fillStyle = Theme.oceanHaze;
    for (let i = 0; i < 2; i += 1) {
      const cx = ((driftX + i * 0.5) % 1) * (w * 1.5) - w * 0.25;
      const cy = ((driftY + i * 0.35) % 1) * (h * 1.4) - h * 0.2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.34, h * 0.24, 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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

    const map = session.map;
    const tile = Math.floor(
      Math.min(this.width / map.width, this.height / map.height)
    );
    const tileSize = Math.max(8, tile);
    const originX = Math.floor((this.width - tileSize * map.width) / 2);
    const originY = Math.floor((this.height - tileSize * map.height) / 2);
    const now = session.visibility.time;

    // 海洋氛围分两层夹住场景：水光在下（水体的体积感），
    // 悬浮微粒与气泡在上（悬在水里的悬浮物）。
    // 两层都放在震动平移之外，否则"水"会跟着屏幕一起抖。
    this.drawOceanHaze(now);

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
    this.drawUnknownField(originX, originY, tileSize, map.width, map.height);
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
    rows: number
  ): void {
    const { ctx } = this;
    const w = tile * cols;
    const h = tile * rows;
    ctx.save();
    ctx.fillStyle = Theme.unknownBase;
    ctx.globalAlpha = 0.62;
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

    // 外框：给整张地图一个"扫描区域"的边界，避免画面显得没有尽头
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = 'rgba(216, 220, 224, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, w + 1, h + 1);
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
          // 墙：近黑实心填充 + 斜纹质感 + 亮描边。
          // 必须和地面拉开明度，否则玩家分不清"能不能走"（重绘时的教训）。
          ctx.fillStyle = Theme.wallFill;
          ctx.globalAlpha = Math.min(1, alpha * 1.1);
          ctx.fillRect(px, py, tile, tile);

          // 斜纹：给墙一层"砌体"读感，和地面的方格细网格在**纹理**上区分，
          // 这样即使缩小到 tile=9 也能一眼分清墙与地面（只靠颜色不够稳）。
          if (tile >= 9) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(px, py, tile, tile);
            ctx.clip();
            ctx.globalAlpha = Math.min(1, alpha * 0.85);
            ctx.strokeStyle = Theme.wallHatch;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let d = -tile; d < tile * 2; d += Math.max(5, tile * 0.34)) {
              ctx.moveTo(px + d, py);
              ctx.lineTo(px + d - tile, py + tile);
            }
            ctx.stroke();
            ctx.restore();
          }

          // 顶部亮边：做出"墙有厚度、光从上方来"的体积感
          if (tile >= 10) {
            ctx.globalAlpha = Math.min(1, alpha * 0.95);
            ctx.fillStyle = Theme.wallHighlight;
            ctx.fillRect(px + 1, py + 1, tile - 2, Math.max(1.5, tile * 0.1));
          }

          // 描边是墙的主轮廓：比地面亮一档，让它从周围格子里"立起来"。
          // 用最低 0.35 的地板线兜底，这样记忆层淡下去之后墙的轮廓不会一起消失——
          // 忘了墙在哪，玩家就会一头撞上去。
          ctx.globalAlpha = Math.min(1, Math.max(0.35, alpha * (0.8 + flash * 0.2)));
          ctx.strokeStyle = Theme.wallStroke;
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, tile - 1, tile - 1);
        } else {
          ctx.fillStyle = Theme.floorFill;
          ctx.globalAlpha = Math.min(1, alpha * 0.95);
          ctx.fillRect(px, py, tile, tile);

          // 明亮显现时补一层青色辉光（声波扫过的"余温"，强度恢复）
          if (alpha > 0.45) {
            ctx.globalAlpha = Math.min(1, (alpha - 0.45) * 1.1);
            ctx.fillStyle = Theme.floorGlow;
            ctx.fillRect(px, py, tile, tile);
          }

          // 格子内部再画一个小一号的方框，形成"砖缝"般的细网格。
          // 只在格子够大时画，否则 tile=8 的情况下会糊成一片。
          if (tile >= 14) {
            const inset = Math.max(2, tile * 0.14);
            ctx.globalAlpha = Math.min(1, alpha * (0.5 + flash * 0.5));
            ctx.strokeStyle = Theme.floorGrid;
            ctx.lineWidth = 1;
            ctx.strokeRect(px + inset, py + inset, tile - inset * 2, tile - inset * 2);
          }

          ctx.globalAlpha = Math.min(1, alpha * (0.32 + flash * 0.6));
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

  /** 尖刺：一个朝上的三角锯齿 */
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

  /** 回声干扰器：一圈扩散的波纹 + 中心点 */
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
      ctx.globalAlpha *= 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
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
        // 激活后：实心暖黄 + 呼吸光环 + 一圈外旋刻线，读起来"已锁定"
        const pulse = 0.5 + 0.5 * Math.sin(now * 3.2);
        ctx.fillStyle = Theme.nodeGlow;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1.9 + pulse * 0.35), 0, Math.PI * 2);
        ctx.fill();

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

        ctx.strokeStyle = Theme.nodeInactive;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1.35 + pulse * 0.18), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // 未激活：空心描边 + 缓慢旋转的断弧，提示"这是待激活目标"，
        // 与出口的静止菱形在形状上彻底区分开
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

        ctx.globalAlpha = Math.min(1, alpha * 0.55);
        ctx.fillStyle = Theme.nodeGlow;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
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

      ctx.strokeStyle = Theme.exitOpen;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.45 + pulse * 0.2), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // 未开启：暗色菱形 + 锁扣感描边，明确表示"还不能进"
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

      ctx.globalAlpha = Math.min(1, alpha * 0.4);
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

    // 细描边把玩家从同色系的地板上拎出来
    ctx.strokeStyle = 'rgba(2, 9, 14, 0.55)';
    ctx.lineWidth = Math.max(1, tile * 0.045);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

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
