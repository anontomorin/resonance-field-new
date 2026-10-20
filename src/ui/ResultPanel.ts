/** 暂停面板、通关面板与最终结算面板 */

import { paintStars, renderStars } from './stars';
import { OceanKnowledgeCard } from '../content/oceanKnowledge';

/** 知识卡在通关面板与最终结算面板上共用的元素引用 */
interface KnowledgeCardElements {
  root: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  source: HTMLElement;
  link: HTMLAnchorElement;
}

/**
 * 渲染「深海声景档案」卡片。
 *
 * 用 textContent 写入文本，链接只能是本地静态资料表里的 URL：
 * 因此外部关卡即使复用了主线 id，也不会被误匹配到别的卡片。
 * 未传入卡片时明确隐藏并清空，避免重玩 / 下一关 / 切换模式后残留上一张。
 */
function paintKnowledgeCard(els: KnowledgeCardElements, card?: OceanKnowledgeCard): void {
  if (!card) {
    els.root.classList.add('hidden');
    els.root.removeAttribute('data-card');
    els.title.textContent = '';
    els.body.textContent = '';
    els.source.textContent = '';
    els.link.removeAttribute('href');
    return;
  }
  els.root.dataset.card = card.id;
  els.title.textContent = card.title;
  els.body.textContent = card.body;
  els.source.textContent = `来源：${card.sourceName} · ${card.sourceTitle}`;
  els.link.href = card.sourceUrl;
  els.root.classList.remove('hidden');
}

export interface PauseCallbacks {
  onResume: () => void;
  onRestart: () => void;
  onBackToTitle: () => void;
}

export interface FinalCallbacks {
  onBackToTitle: () => void;
  onReplayAll: () => void;
}

/**
 * 力竭面板：生命耗尽时的失败结算。
 * 措辞刻意保持"再来一次你更强"而非"你失败了"——
 * 因为已发现的陷阱记忆会保留，重开确实会明显更快。
 */
export class ExhaustedPanel {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private descEl: HTMLElement;
  private nodesEl: HTMLElement;
  private timeEl: HTMLElement;
  private hitsEl: HTMLElement;
  private actionsEl: HTMLElement;

  constructor() {
    this.root = requireEl('overlay-exhausted');
    this.titleEl = requireEl('exhausted-title');
    this.descEl = requireEl('exhausted-desc');
    this.nodesEl = requireEl('exhausted-nodes');
    this.timeEl = requireEl('exhausted-time');
    this.hitsEl = requireEl('exhausted-hits');
    this.actionsEl = requireEl('exhausted-actions');
  }

  show(data: {
    levelTitle: string;
    activated: number;
    required: number;
    seconds: number;
    spikesHit: number;
    jammersHit: number;
    keepTrapMemory: boolean;
    actions: CompleteAction[];
  }): void {
    this.titleEl.textContent = `${data.levelTitle} · 力竭`;
    this.descEl.textContent = data.keepTrapMemory
      ? '生命耗尽，本次探索到此为止。已发现的陷阱位置会保留下来，再来一次会快很多。'
      : '生命耗尽，本次探索到此为止。';
    this.nodesEl.textContent = `${data.activated} / ${data.required}`;
    this.timeEl.textContent = formatTime(data.seconds);
    this.hitsEl.textContent = `${data.spikesHit} 次尖刺 · ${data.jammersHit} 次干扰`;

    this.actionsEl.innerHTML = '';
    for (const action of data.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const kind = action.kind ?? 'normal';
      btn.className = kind === 'normal' ? 'btn' : `btn ${kind}`;
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      this.actionsEl.appendChild(btn);
    }

    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少界面元素 #${id}`);
  return el;
}

export class PausePanel {
  private root: HTMLElement;

  constructor(callbacks: PauseCallbacks) {
    this.root = requireEl('overlay-pause');
    requireEl('btn-resume').addEventListener('click', callbacks.onResume);
    requireEl('btn-pause-restart').addEventListener('click', callbacks.onRestart);
    requireEl('btn-pause-title').addEventListener('click', callbacks.onBackToTitle);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

export class CompletePanel {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private starsEl: HTMLElement;
  private starCommentEl: HTMLElement;
  private nodesEl: HTMLElement;
  private timeEl: HTMLElement;
  private pulsesEl: HTMLElement;
  private parEl: HTMLElement;
  private knowledge: KnowledgeCardElements;
  private actionsEl: HTMLElement;

  constructor() {
    this.root = requireEl('overlay-complete');
    this.titleEl = requireEl('complete-title');
    this.starsEl = requireEl('complete-stars');
    this.starCommentEl = requireEl('complete-star-comment');
    this.nodesEl = requireEl('complete-nodes');
    this.timeEl = requireEl('complete-time');
    this.pulsesEl = requireEl('complete-pulses');
    this.parEl = requireEl('complete-par');
    this.knowledge = {
      root: requireEl('complete-knowledge'),
      title: requireEl('kc-title'),
      body: requireEl('kc-body'),
      source: requireEl('kc-source'),
      link: requireEl('kc-link') as HTMLAnchorElement
    };
    this.actionsEl = requireEl('complete-actions');
  }

  /**
   * 展示通关结算。
   * 按钮完全由调用方决定：主线是"下一关"，随机关卡是"换一张"，
   * 自定义关卡是"返回编辑器"。
   */
  show(data: {
    levelTitle: string;
    activated: number;
    required: number;
    seconds: number;
    pulses: number;
    /** 本关理论最少脉冲数（评分基准） */
    par: number;
    /** 换算出的星级（0~3） */
    stars: number;
    /** 星级评语 */
    comment: string;
    /** 是否刷新了历史最佳星级 */
    newRecord?: boolean;
    /**
     * 可选知识卡：主线关卡传入对应卡片，随机 / 自定义关卡传通用卡。
     * 不传则明确隐藏卡片，避免重玩、下一关或切换模式后残留上一张。
     */
    knowledgeCard?: OceanKnowledgeCard;
    actions: CompleteAction[];
  }): void {
    this.titleEl.textContent = `${data.levelTitle} · 完成`;

    // 星级是本面板的主角：先按星数给整行上色，再逐颗点亮，
    // 让"这次打得好不好"在一眼之内就能读到，而不是埋在数据表里。
    paintStars(this.starsEl, data.stars);
    this.starsEl.classList.toggle('record', data.newRecord === true);
    this.starCommentEl.textContent = data.newRecord
      ? `新纪录！${data.comment}`
      : data.comment;
    this.starCommentEl.classList.toggle('record', data.newRecord === true);

    this.nodesEl.textContent = `${data.activated} / ${data.required}`;
    this.timeEl.textContent = formatTime(data.seconds);
    this.pulsesEl.textContent = String(data.pulses);
    this.parEl.textContent = String(data.par);

    paintKnowledgeCard(this.knowledge, data.knowledgeCard);

    this.actionsEl.innerHTML = '';
    for (const action of data.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const kind = action.kind ?? 'normal';
      btn.className = kind === 'normal' ? 'btn' : `btn ${kind}`;
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      this.actionsEl.appendChild(btn);
    }

    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

export class FinalPanel {
  private root: HTMLElement;
  private stats: HTMLElement;
  private totalEl: HTMLElement;
  private knowledge: KnowledgeCardElements;

  constructor(callbacks: FinalCallbacks) {
    this.root = requireEl('overlay-final');
    this.stats = requireEl('final-stats');
    this.totalEl = requireEl('final-total');
    this.knowledge = {
      root: requireEl('final-knowledge'),
      title: requireEl('fkc-title'),
      body: requireEl('fkc-body'),
      source: requireEl('fkc-source'),
      link: requireEl('fkc-link') as HTMLAnchorElement
    };
    requireEl('btn-final-title').addEventListener('click', callbacks.onBackToTitle);
    requireEl('btn-final-replay').addEventListener('click', callbacks.onReplayAll);
  }

  /**
   * 最终结算面板。
   * @param knowledgeCard 主线最后一关的知识卡；不传则隐藏卡片。
   */
  show(
    levelStats: Array<{ title: string; seconds: number; pulses: number; stars: number }>,
    knowledgeCard?: OceanKnowledgeCard
  ): void {
    this.stats.innerHTML = '';
    let got = 0;
    for (const item of levelStats) {
      got += item.stars;
      const col = document.createElement('div');
      col.className = 'final-row';

      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.title;

      // 星级放在标题右边同一行：扫一眼就能看出哪关还差一颗
      const stars = document.createElement('span');
      stars.className = 'final-stars';
      stars.innerHTML = renderStars(item.stars);

      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = `${formatTime(item.seconds)} · ${item.pulses} 次脉冲`;

      col.appendChild(label);
      col.appendChild(stars);
      col.appendChild(value);
      this.stats.appendChild(col);
    }

    // 总星数是"重玩有没有意义"的唯一量化指标，所以必须显式给出来
    const max = levelStats.length * 3;
    this.totalEl.innerHTML = `总计 <strong>${got}</strong> / ${max} 星`;
    this.totalEl.classList.toggle('perfect', max > 0 && got === max);

    paintKnowledgeCard(this.knowledge, knowledgeCard);

    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

/** 通关 / 力竭面板上的按钮；按关卡来源（主线 / 随机 / 自定义）动态生成 */
export interface CompleteAction {
  label: string;
  kind?: 'primary' | 'normal' | 'ghost';
  onClick: () => void;
}

