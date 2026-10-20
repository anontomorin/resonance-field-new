/**
 * 首页「深海声景档案」条。
 *
 * 把五张由 NOAA / NOAA Fisheries / IMO 公开资料整理的知识卡直接摆在首页，
 * 每张标注来源机构；主线通关后给对应卡片打上「已归档」标记。
 *
 * 这只是**进度标记**，不是内容解锁：正文始终完整可读，不打码也不折叠。
 * 「已归档」表达的是"这一片声景你已经亲自走完"，而不是"现在才允许你看"。
 *
 * 卡片本身不可点、不可聚焦（不是 `.btn` / `.level-card` 一类），
 * 因此不会进入手柄的线性焦点序列，也就不会打乱菜单导航。
 */

import { OCEAN_KNOWLEDGE_CARDS } from '../content/oceanKnowledge';
import { LevelManager } from '../levels/LevelManager';

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少界面元素 #${id}`);
  return el;
}

export class ArchiveWall {
  private grid: HTMLElement;
  private progress: HTMLElement;
  private manager: LevelManager;

  constructor(manager: LevelManager) {
    this.manager = manager;
    this.grid = requireEl('archive-grid');
    this.progress = requireEl('archive-progress');
  }

  /** 重画档案条；在显示首页时调用（进度可能已变化） */
  refresh(): void {
    const ids = Object.keys(OCEAN_KNOWLEDGE_CARDS)
      .map(Number)
      .sort((a, b) => a - b);

    this.grid.innerHTML = '';
    let archived = 0;

    for (const id of ids) {
      const card = OCEAN_KNOWLEDGE_CARDS[id];
      const cleared = this.manager.isCleared(id);
      if (cleared) archived += 1;

      const item = document.createElement('article');
      item.className = `archive-card${cleared ? ' archived' : ''}`;

      const head = document.createElement('div');
      head.className = 'archive-head-row';
      const index = document.createElement('span');
      index.className = 'archive-index';
      index.textContent = `ARCHIVE 0${id}`;
      const org = document.createElement('span');
      org.className = 'archive-org';
      org.textContent = card.sourceName;
      head.appendChild(index);
      head.appendChild(org);

      const title = document.createElement('h3');
      title.className = 'archive-title';
      title.textContent = card.title;

      const body = document.createElement('p');
      body.className = 'archive-body';
      body.textContent = card.body;

      const foot = document.createElement('div');
      foot.className = 'archive-foot';
      const status = document.createElement('span');
      status.className = 'archive-status';
      status.textContent = cleared ? '已归档' : '未归档';
      const link = document.createElement('a');
      link.className = 'archive-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.href = card.sourceUrl;
      link.textContent = '原始资料 ↗';
      foot.appendChild(status);
      foot.appendChild(link);

      item.appendChild(head);
      item.appendChild(title);
      item.appendChild(body);
      item.appendChild(foot);
      this.grid.appendChild(item);
    }

    this.progress.textContent = `${archived} / ${ids.length} 已归档`;
  }
}
