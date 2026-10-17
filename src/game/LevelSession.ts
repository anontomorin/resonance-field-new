import { LevelDefinition } from '../levels/levelData';
import { TileMap } from '../world/TileMap';
import { Player } from '../world/Player';
import { Resonator } from '../world/Resonator';
import { PulseSystem } from '../sonar/PulseSystem';
import { VisibilitySystem } from '../sonar/VisibilitySystem';
import { SonarConfig } from '../sonar/SonarConfig';
import { HazardConfig, resolveHazardConfig } from './HazardConfig';
import { minPulsesToClear } from '../levels/mapAnalysis';
import { starsFor, Stars } from './StarRating';
import { Effects } from '../render/Effects';
import { Theme } from '../render/Theme';

/** 会话对外事件（供 UI 与音效使用） */
export interface SessionEvents {
  onPulseEmitted?: (remainingCooldown: number) => void;
  /** 玩家成功移动一格 */
  onMoved?: () => void;
  onResonatorActivated?: (activated: number, total: number) => void;
  onExitOpened?: () => void;
  onLevelCompleted?: () => void;
  /** 撞上墙：无法进入 */
  onBump?: (reason: 'wall') => void;
  /** 走到尚未开启的出口格上：走得过去，但还不能离开调查区 */
  onExitLocked?: () => void;
  onReveal?: (newTiles: number) => void;
  /** 踩中尖刺受伤 */
  onHurt?: (health: number, maxHealth: number) => void;
  /** 踩中回声干扰器，探索记忆被清除 */
  onJammed?: (forgottenTiles: number) => void;
  /** 生命耗尽 */
  onExhausted?: () => void;
}

/**
 * 单局关卡会话：持有地图、玩家、节点、可见性与脉冲状态。
 *
 * 所有关卡规则都在这里判定：
 * - 移动：墙不可进入；出口格本身走得上去（不再挡路），
 *   只有**已开启**的出口才会在踩上去时结束本局；
 * - 脉冲：由 PulseSystem 按 BFS 到达时间逐个回调；
 * - 节点：脉冲抵达节点所在格时激活，且只激活一次；
 * - 通关：玩家进入已开启的出口格。
 */
export class LevelSession {
  readonly level: LevelDefinition;
  readonly map: TileMap;
  readonly player: Player;
  readonly resonators: Resonator[];
  readonly visibility: VisibilitySystem;
  readonly pulseSystem: PulseSystem;
  readonly effects: Effects;

  exitOpen = false;
  completed = false;
  /** 生命耗尽（力竭）。与 completed 互斥，二者任一为真即本局结束 */
  exhausted = false;
  /** 当前生命值 */
  health: number;
  /** 本关累计用时（秒，暂停时不增长） */
  elapsed = 0;
  /** 已发射脉冲次数 */
  pulsesUsed = 0;
  /** 已探索格子数 */
  exploredCount = 0;
  /** 受伤后的剩余无敌时间（秒），渲染层用它做闪烁 */
  invulnerableTimer = 0;
  /** 受伤后的剩余屏幕震动时间（秒），渲染层用它做抖动 */
  shakeTimer = 0;
  /** 本关累计踩中尖刺次数（结算展示用） */
  spikesHit = 0;
  /** 本关累计踩中回声干扰器次数（结算展示用） */
  jammersHit = 0;

  private events: SessionEvents;
  private config: SonarConfig;
  private hazard: HazardConfig;
  /** 本关理论最少脉冲数（评分下界），构造时算一次即可 */
  private par: number;
  /** 移动重复输入的节流计时 */
  private moveTimer = 0;
  /** 已被踩过而失效的回声干扰器（一次性装置） */
  private spentJammers = new Set<number>();

  constructor(level: LevelDefinition, config: SonarConfig, events: SessionEvents = {}) {
    this.level = level;
    this.map = TileMap.fromStrings(level.map, level.title);
    this.config = config;
    this.events = events;
    this.hazard = resolveHazardConfig(level.hazard);

    const size = this.map.width * this.map.height;
    this.player = new Player(this.map.start.x, this.map.start.y);
    this.resonators = this.map.resonators.map(
      (cell) => new Resonator(cell.x, cell.y, this.map.index(cell.x, cell.y))
    );
    this.visibility = new VisibilitySystem(size, config);
    this.pulseSystem = new PulseSystem(config);
    this.effects = new Effects();
    this.health = this.hazard.maxHealth;

    // 评分下界只跟地图与声波参数有关，构造时算一次。
    // 地图越大遍历越贵（每个可通行格都要跑一次传播），所以绝不能每帧算。
    // 注意第二个参数是整个 SonarConfig 而不是 maxRange：`par` 必须和实际
    // 玩法用同一套模型（bfs/field）与阈值，否则评分口径会和游戏悄然错位。
    this.par = minPulsesToClear(this.map, config, level.requiredResonators);

    // 起点在开局即可感知（只点亮脚下这一格）
    this.markPlayerTile();
  }

  /**
   * 理论最少脉冲数（评分基准）。
   * 达成"几乎最优"的路线才能拿三星，详见 StarRating。
   */
  get parPulses(): number {
    return this.par;
  }

  /** 本局按脉冲次数换算出的星级（未通关时也返回当前会拿到的星级，供 HUD 预览） */
  get stars(): Stars {
    return starsFor(this.pulsesUsed, this.par);
  }

  get maxHealth(): number {
    return this.hazard.maxHealth;
  }

  /** 力竭重开时是否应保留已发现的陷阱标记 */
  get keepTrapMemoryOnDeath(): boolean {
    return this.hazard.rememberTrapsOnDeath;
  }

  /** 本关结束（通关或力竭） */
  get finished(): boolean {
    return this.completed || this.exhausted;
  }

  /**
   * 重开本关，并取消活动脉冲与所有计时。
   * @param keepTrapMemory 力竭重开时保留"已发现的陷阱"标记，降低挫败感
   */
  reset(keepTrapMemory = false): void {
    this.player.setTo(this.map.start.x, this.map.start.y);
    for (const resonator of this.resonators) resonator.reset();
    this.visibility.reset(keepTrapMemory);
    this.pulseSystem.cancel();
    this.effects.clear();
    this.exitOpen = false;
    this.completed = false;
    this.exhausted = false;
    this.health = this.hazard.maxHealth;
    this.elapsed = 0;
    this.pulsesUsed = 0;
    this.exploredCount = 0;
    this.moveTimer = 0;
    this.invulnerableTimer = 0;
    this.shakeTimer = 0;
    this.spikesHit = 0;
    this.jammersHit = 0;
    this.spentJammers.clear();
    this.markPlayerTile();
  }

  get activatedCount(): number {
    let n = 0;
    for (const r of this.resonators) if (r.active) n += 1;
    return n;
  }

  get requiredCount(): number {
    return this.level.requiredResonators;
  }

  get cooldownRatio(): number {
    return this.pulseSystem.cooldownRatio;
  }

  private markPlayerTile(): void {
    if (!this.config.revealPlayerTile) return;
    const index = this.map.index(this.player.x, this.player.y);
    if (!this.visibility.isExplored(index)) {
      this.visibility.markExplored(index);
      this.exploredCount += 1;
    } else {
      this.visibility.markExplored(index);
    }
    // 已经站在上面了，这个陷阱自然算"已发现"
    if (this.map.isTrap(this.player.x, this.player.y)) {
      this.visibility.markTrapKnown(index);
    }
  }

  /** 玩家踏入一格后结算该格的陷阱效果 */
  private checkTrap(x: number, y: number): void {
    const kind = this.map.kindAt(x, y);
    const index = this.map.index(x, y);

    if (kind === 'spike') {
      this.visibility.markTrapKnown(index);
      // 无敌帧内不重复扣血，避免连踩陷阱瞬间暴毙
      if (this.invulnerableTimer > 0) return;
      this.applyDamage(this.hazard.spikeDamage, x, y);
      return;
    }

    if (kind === 'jammer') {
      this.visibility.markTrapKnown(index);
      // 干扰器是一次性装置：踩过就失效，不会再被反复触发
      if (this.spentJammers.has(index)) return;
      this.spentJammers.add(index);
      this.jammersHit += 1;
      this.applyJam(x, y);
    }
  }

  private applyDamage(amount: number, x: number, y: number): void {
    this.health = Math.max(0, this.health - amount);
    this.spikesHit += 1;
    this.invulnerableTimer = this.hazard.invulnerableTime;
    this.shakeTimer = this.hazard.shakeDuration;
    this.effects.burst(x + 0.5, y + 0.5, Theme.hazardSpike, 20, 2.8);
    this.effects.ripple(x + 0.5, y + 0.5, Theme.hazardSpike, 3, 0.6);
    this.events.onHurt?.(this.health, this.hazard.maxHealth);
    if (this.health <= 0) this.exhaust();
  }

  private applyJam(x: number, y: number): void {
    const radius = this.hazard.jammerRadius;
    let forgotten = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!this.map.inBounds(nx, ny)) continue;
        // 玩家脚下保持可见，否则"自己站的格子变黑"很怪
        if (nx === this.player.x && ny === this.player.y) continue;
        if (this.visibility.forget(this.map.index(nx, ny))) forgotten += 1;
      }
    }
    this.exploredCount = Math.max(0, this.exploredCount - forgotten);
    this.shakeTimer = Math.max(this.shakeTimer, this.hazard.shakeDuration * 0.6);
    this.effects.ripple(x + 0.5, y + 0.5, Theme.hazardJammer, radius + 1, 0.9);
    this.events.onJammed?.(forgotten);
  }

  /** 生命耗尽：本局以失败结束 */
  private exhaust(): void {
    if (this.exhausted) return;
    this.exhausted = true;
    this.effects.burst(this.player.x + 0.5, this.player.y + 0.5, Theme.hazardSpike, 30, 3.4);
    this.events.onExhausted?.();
  }

  /** 尝试朝方向移动一格 */
  tryMove(dx: number, dy: number): boolean {
    if (this.finished) return false;
    const nx = this.player.x + dx;
    const ny = this.player.y + dy;

    if (!this.map.inBounds(nx, ny) || this.map.isWall(nx, ny)) {
      this.player.bump(dx, dy);
      this.events.onBump?.('wall');
      return false;
    }

    const kind = this.map.kindAt(nx, ny);
    this.player.moveTo(nx, ny);
    this.markPlayerTile();
    this.events.onMoved?.();
    this.checkTrap(nx, ny);

    // 出口格一律可以走上去：只有已开启的出口才结束本局，
    // 未开启时踩上去只是"先来看看"，给一条提示而不是把人挡在门外。
    if (kind === 'exit') {
      if (this.exitOpen) {
        this.completed = true;
        this.effects.burst(nx + 0.5, ny + 0.5, Theme.exitOpen, 26, 3.2);
        this.effects.ripple(nx + 0.5, ny + 0.5, Theme.exitOpen, 5, 0.9);
        this.events.onLevelCompleted?.();
      } else {
        this.events.onExitLocked?.();
      }
    }
    return true;
  }

  /** 发射一次声波脉冲 */
  emitPulse(): boolean {
    if (this.finished) return false;
    const pulse = this.pulseSystem.tryEmit(this.map, this.player.x, this.player.y);
    if (!pulse) return false;

    this.pulsesUsed += 1;
    this.effects.ripple(
      pulse.originX + 0.5,
      pulse.originY + 0.5,
      Theme.pulseCore,
      this.config.maxRange + 1.2,
      this.config.stepDelay * this.config.maxRange + 0.45
    );
    this.events.onPulseEmitted?.(this.config.cooldown);
    return true;
  }

  /** 脉冲抵达某个格子时的处理 */
  private handleArrival = (index: number, _distance: number, intensity: number): void => {
    const wasExplored = this.visibility.isExplored(index);
    // 照度一路传到可见性层：field 模型下它是真实的能量值，
    // 渲染层据此做"越远越模糊"；bfs 模型下恒为 1，行为与改造前完全一致。
    this.visibility.reveal(index, true, intensity);
    if (!wasExplored) this.exploredCount += 1;

    // 声波扫到陷阱就永久记住它的位置（这是"能规避"的前提）
    if (this.map.isTrap(index % this.map.width, Math.floor(index / this.map.width))) {
      this.visibility.markTrapKnown(index);
    }

    // 节点激活：脉冲实际抵达节点所在格才触发，且只触发一次
    for (const resonator of this.resonators) {
      if (resonator.index !== index) continue;
      if (resonator.active) continue;
      resonator.activate(this.visibility.time);
      this.effects.burst(resonator.x + 0.5, resonator.y + 0.5, Theme.nodeActive, 18, 2.6);
      this.effects.ripple(resonator.x + 0.5, resonator.y + 0.5, Theme.nodeActive, 2.6, 0.7);
      if (this.hazard.healOnResonator > 0 && !this.exhausted) {
        this.health = Math.min(this.hazard.maxHealth, this.health + this.hazard.healOnResonator);
      }
      this.events.onResonatorActivated?.(this.activatedCount, this.requiredCount);
      this.refreshExitState();
    }
  };

  /** 节点全部激活后开启出口 */
  private refreshExitState(): void {
    if (this.exitOpen) return;
    if (this.activatedCount < this.requiredCount) return;
    this.exitOpen = true;
    this.effects.burst(this.map.exit.x + 0.5, this.map.exit.y + 0.5, Theme.exitOpen, 22, 3);
    this.effects.ripple(this.map.exit.x + 0.5, this.map.exit.y + 0.5, Theme.exitOpen, 4.5, 0.9);
    this.events.onExitOpened?.();
  }

  /**
   * 推进一帧。
   * @param dt 帧间隔（秒）
   * @param moveDir 本帧的持续移动输入方向，null 表示无输入
   */
  update(dt: number, moveDir: { dx: number; dy: number } | null): void {
    if (this.finished) {
      // 通关或力竭后仍推进特效，但不再计时与响应输入
      this.effects.update(dt);
      if (this.shakeTimer > 0) this.shakeTimer -= dt;
      return;
    }

    this.elapsed += dt;
    if (this.invulnerableTimer > 0) this.invulnerableTimer -= dt;
    if (this.shakeTimer > 0) this.shakeTimer -= dt;
    this.visibility.tick(dt);
    this.pulseSystem.update(dt, this.handleArrival);
    this.effects.update(dt);
    this.effects.limit();

    if (moveDir) {
      if (this.moveTimer <= 0) {
        this.tryMove(moveDir.dx, moveDir.dy);
        this.moveTimer = 0.15;
      } else {
        this.moveTimer -= dt;
      }
    } else {
      this.moveTimer = 0;
    }

    this.player.update(dt);
  }
}
