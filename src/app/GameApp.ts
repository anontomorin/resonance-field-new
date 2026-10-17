import { AppState, ProgressStorage } from '../core/GameState';
import { GameLoop } from '../core/GameLoop';
import { InputController } from '../core/InputController';
import { GamepadController, shortPadName } from '../core/GamepadController';
import { CustomLevelStore, CustomLevelRecord } from '../core/CustomLevelStore';
import { LevelManager } from '../levels/LevelManager';
import { LevelDefinition } from '../levels/levelData';
import { LevelSession } from '../game/LevelSession';
import { TutorialGuide } from '../game/TutorialGuide';
import { CanvasRenderer } from '../render/CanvasRenderer';
import { AudioManager } from '../audio/AudioManager';
import { HUD } from '../ui/HUD';
import { HomeScreen } from '../ui/HomeScreen';
import { LevelCenter, TabKey } from '../ui/LevelSelect';
import { PausePanel, CompletePanel, ExhaustedPanel, FinalPanel } from '../ui/ResultPanel';
import { TouchControls } from '../ui/TouchControls';
import { MenuNavigator } from '../ui/MenuNavigator';
import { ShareDialog } from '../ui/ShareDialog';
import { ArchiveWall } from '../ui/ArchiveWall';
import { EditorScreen } from '../editor/EditorScreen';
import { buildRandomLevel } from '../gen/LevelGenerator';
import { RandomLevelParams, randomSeed } from '../gen/randomParams';
import { analyzeRows, firstError, normalizeTitle } from '../levels/mapAnalysis';
import { decodeShareCode, encodeMapCode, encodeMapShareText, encodeRandomCode } from '../levels/shareCode';
import { starsFor, starComment, Stars } from '../game/StarRating';
import { campaignKnowledgeCard, GENERIC_KNOWLEDGE_CARD } from '../content/oceanKnowledge';

interface LevelStat {
  title: string;
  seconds: number;
  pulses: number;
  stars: Stars;
}

/** 当前正在游玩的非主线关卡来源 */
interface ExternalRun {
  kind: 'random' | 'custom';
  level: LevelDefinition;
  /** 自定义关卡：试玩来自编辑器时，通关后回到编辑器 */
  fromEditor: boolean;
}

/**
 * 应用控制器：状态机 + 模块装配。
 *
 * 状态：title → levelSelect / editor → playing ⇄ paused → levelComplete → gameComplete
 * 关卡来源分三类：主线（写进度）、随机（种子可复现）、自定义（可编辑可分享）。
 * 切换到任意界面、重开关卡、进入下一关时都会取消活动脉冲并清理会话状态。
 */
export class GameApp {
  private state: AppState = 'title';
  private storage: ProgressStorage;
  private store: CustomLevelStore;
  private manager: LevelManager;
  private input: InputController;
  private gamepad: GamepadController;
  private menus: MenuNavigator;
  private renderer: CanvasRenderer;
  private audio: AudioManager;
  private loop: GameLoop;

  private hud: HUD;
  private home: HomeScreen;
  private archive: ArchiveWall;
  private levelCenter: LevelCenter;
  private editor: EditorScreen;
  private share: ShareDialog;
  private pausePanel: PausePanel;
  private completePanel: CompletePanel;
  private exhaustedPanel: ExhaustedPanel;
  private finalPanel: FinalPanel;
  private touchControls: TouchControls;

  private session: LevelSession | null = null;
  private tutorial: TutorialGuide | null = null;
  private external: ExternalRun | null = null;
  private stats = new Map<number, LevelStat>();
  /**
   * 挂起的"手柄已连接"提示。
   * 在标题页插手柄时 HUD 不可见，直接弹 toast 玩家看不到，
   * 所以先存下来，等进入游玩（setState('playing')）再补发。
   */
  private pendingPadToast: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.storage = new ProgressStorage();
    this.store = new CustomLevelStore();
    this.manager = new LevelManager(this.storage);
    this.input = new InputController();
    // 手柄必须在 setState 之前建好：setState 会重置菜单焦点
    this.gamepad = new GamepadController((name) => this.handleGamepadChange(name));
    this.menus = new MenuNavigator();
    this.renderer = new CanvasRenderer(canvas);
    this.audio = new AudioManager(this.storage.muted);
    this.touchControls = new TouchControls();
    this.touchControls.applyDeviceMode();
    this.touchControls.enableOnFirstTouch();
    this.share = new ShareDialog();

    this.home = new HomeScreen({
      onCampaign: () => this.gotoLevelCenter('campaign'),
      onRandom: () => this.gotoLevelCenter('random'),
      onCustom: () => this.gotoLevelCenter('custom'),
      onToggleSound: () => this.toggleSound()
    });

    this.archive = new ArchiveWall(this.manager);

    this.levelCenter = new LevelCenter(this.manager, this.store, {
      onBack: () => this.gotoHome(),
      onPickCampaign: (index) => this.startCampaign(index),
      onResetProgress: () => {
        this.storage.reset();
        this.levelCenter.show('campaign');
        this.refreshHomeStats();
      },
      onRandomPlay: (params) => this.startRandom(params),
      onCustomNew: () => this.openEditorNew(),
      onCustomPlay: (id) => this.playCustom(id),
      onCustomEdit: (id) => this.openEditorRecord(id),
      onCustomShare: (id) => this.shareCustom(id),
      onCustomDelete: (id) => {
        this.store.remove(id);
        this.refreshHomeStats();
      },
      onImportCode: (code, play) => this.importCode(code, play)
    });

    this.editor = new EditorScreen(
      {
        onBack: () => this.gotoLevelCenter('custom'),
        onTest: (level) => this.startExternal(level, 'custom', true),
        onSaved: (record) => this.saveCustom(record)
      },
      this.share
    );

    this.hud = new HUD({
      onPause: () => this.pause(),
      onRestart: () => this.restartLevel(),
      onToggleSound: () => this.toggleSound()
    });

    this.pausePanel = new PausePanel({
      onResume: () => this.resume(),
      onRestart: () => {
        this.pausePanel.hide();
        this.restartLevel();
      },
      onBackToTitle: () => this.gotoLevelCenter(this.external ? this.externalTab() : 'campaign')
    });

    this.completePanel = new CompletePanel();
    this.exhaustedPanel = new ExhaustedPanel();

    this.finalPanel = new FinalPanel({
      onBackToTitle: () => {
        this.finalPanel.hide();
        this.gotoHome();
      },
      onReplayAll: () => {
        this.finalPanel.hide();
        this.stats.clear();
        this.storage.reset();
        this.startCampaign(0);
      }
    });

    this.loop = new GameLoop(
      (dt) => this.update(dt),
      () => this.render()
    );

    // 点击按钮后取消焦点，避免空格误触发上一次点击的按钮
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof HTMLButtonElement) target.blur();
    });

    // 玩家一旦改用鼠标 / 触摸，手柄焦点环就失去意义了，主动撤掉。
    // （手柄焦点是加 class 而不是靠 :focus，所以上面那个 blur() 不会误伤它）
    window.addEventListener('pointerdown', () => this.menus.reset());

    const handleResize = (): void => {
      this.renderer.resize();
      this.touchControls.applyDeviceMode();
      this.editor.layout();
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    this.input.attach();
    this.applySoundLabels();
    this.gotoHome();
    this.loop.start();
  }

  // ==================== 页面导航 ====================

  private setState(state: AppState): void {
    this.state = state;
    // 每次切换界面都丢弃手柄焦点：旧界面的索引套到新界面上会指向随机按钮
    this.menus.reset();
    // 进入游玩时把"插上手柄却没来得及提示"的那条补发出去
    if (state === 'playing') this.flushPadToast();
  }

  private gotoHome(): void {
    this.disposeSession();
    this.setState('title');
    this.hud.hide();
    this.pausePanel.hide();
    this.completePanel.hide();
    this.exhaustedPanel.hide();
    this.finalPanel.hide();
    this.levelCenter.hide();
    this.editor.hide();
    this.home.show();
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
    this.tutorial = null;
    this.external = null;
    this.refreshHomeStats();
  }

  private gotoLevelCenter(tab: TabKey): void {
    this.disposeSession();
    this.setState('levelSelect');
    this.hud.hide();
    this.home.hide();
    this.editor.hide();
    this.pausePanel.hide();
    this.completePanel.hide();
    this.finalPanel.hide();
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
    this.tutorial = null;
    this.external = null;
    this.levelCenter.show(tab);
  }

  private openEditorNew(): void {
    this.disposeSession();
    this.setState('editor');
    this.levelCenter.hide();
    this.hud.hide();
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
    this.editor.openNew();
  }

  private openEditorRecord(id: string): void {
    const record = this.store.get(id);
    if (!record) return;
    this.disposeSession();
    this.setState('editor');
    this.levelCenter.hide();
    this.hud.hide();
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
    this.editor.openRecord(record);
  }

  private externalTab(): TabKey {
    return this.external?.kind === 'random' ? 'random' : 'custom';
  }

  private refreshHomeStats(): void {
    this.home.setStats(this.storage.cleared.length, this.manager.count, this.store.list().length);
    // 首页档案条的「已归档」标记跟着主线进度走，所以和统计一起刷新
    this.archive.refresh();
  }

  // ==================== 开始游戏 ====================

  private startCampaign(index: number): void {
    if (!this.manager.selectCampaign(index)) return;
    this.external = null;
    this.startSession();
  }

  private startRandom(params: RandomLevelParams): void {
    const level = buildRandomLevel(params);
    level.code = encodeRandomCode(params);
    this.startExternal(level, 'random', false);
  }

  private startExternal(level: LevelDefinition, kind: 'random' | 'custom', fromEditor: boolean): void {
    this.manager.selectExternal(level);
    this.external = { kind, level, fromEditor };
    this.startSession();
  }

  private playCustom(id: string): void {
    const record = this.store.get(id);
    if (!record) return;
    this.startExternal(this.levelFromRecord(record), 'custom', false);
  }

  /** 统一的会话启动：HUD、教学引导、输入清理都在这里 */
  private startSession(): void {
    const level = this.manager.current;
    const config = this.manager.currentSonarConfig();

    this.tutorial = level.tutorial ? new TutorialGuide(level.tutorial) : null;

    this.session = new LevelSession(level, config, {
      onPulseEmitted: () => {
        this.audio.playPulse();
        this.advanceTutorial('pulse');
      },
      onMoved: () => this.advanceTutorial('move'),
      onResonatorActivated: (activated, total) => {
        this.audio.playNode();
        this.hud.showToast(`观测节点已记录 ${activated} / ${total}`);
        this.advanceTutorial('node');
      },
      onExitOpened: () => {
        this.audio.playExitOpen();
        this.hud.showToast('本区记录已完成，进入出口离开调查区');
        this.advanceTutorial('exitOpen');
      },
      onBump: () => {
        this.audio.playBump();
      },
      onExitLocked: () => {
        this.hud.showToast('出口尚未开启：先记录全部观测节点');
      },
      onHurt: (health, maxHealth) => {
        this.audio.playHurt();
        this.hud.showToast(
          health > 0
            ? `踩中尖刺：生命 ${health} / ${maxHealth}`
            : '生命耗尽……'
        );
        this.advanceTutorial('hurt');
      },
      onJammed: (forgotten) => {
        this.audio.playJammed();
        this.hud.showToast(`回声干扰：${forgotten} 格记忆被抹去`);
        this.advanceTutorial('jam');
      },
      onExhausted: () => this.handleExhausted(),
      onLevelCompleted: () => this.handleLevelCompleted()
    });

    this.home.hide();
    this.levelCenter.hide();
    this.editor.hide();
    this.pausePanel.hide();
    this.completePanel.hide();
    this.exhaustedPanel.hide();
    this.finalPanel.hide();
    this.hud.setLevel(level.title, level.subtitle);
    this.hud.setTip(this.tutorial ? this.tutorial.start() : null);
    this.hud.show();
    this.setState('playing');
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
  }

  /** 推进教学引导；若当前步骤命中该事件则更新提示条 */
  private advanceTutorial(trigger: Parameters<TutorialGuide['notify']>[0]): void {
    if (!this.tutorial) return;
    const text = this.tutorial.notify(trigger);
    if (text !== null) this.hud.setTip(text);
  }

  private restartLevel(keepTrapMemory = false): void {
    if (!this.session) return;
    this.session.reset(keepTrapMemory);
    this.tutorial?.reset();
    this.hud.setTip(this.tutorial ? this.tutorial.start() : null);
    this.setState('playing');
    this.hud.show();
    this.completePanel.hide();
    this.exhaustedPanel.hide();
    this.finalPanel.hide();
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.pausePanel.show();
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.pausePanel.hide();
    this.setState('playing');
    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
  }

  // ==================== 通关结算 ====================

  private handleLevelCompleted(): void {
    const session = this.session;
    if (!session) return;

    const level = this.manager.current;
    this.audio.playWin();
    this.advanceTutorial('complete');
    this.hud.setTip(null);

    // 星级只看脉冲次数，与理论下界比较。par 由 LevelSession 构造时算好。
    const par = session.parPulses;
    const stars = starsFor(session.pulsesUsed, par);
    const comment = starComment(stars);

    if (this.manager.isCampaign) {
      const previousStars = this.manager.starsOf(level.id);
      this.manager.markCleared(level.id, session.elapsed, session.pulsesUsed, stars);
      this.stats.set(level.id, {
        title: level.title,
        seconds: session.elapsed,
        pulses: session.pulsesUsed,
        stars
      });

      if (this.manager.isLast()) {
        this.setState('gameComplete');
        this.hud.hide();
        // 汇总时用"历史最佳"而不是本局成绩：最终面板是全局总览，
        // 拿最后一局的手感去覆盖前几关的纪录会让人以为之前白打了。
        const list = this.manager.levelList.map((l) => {
          const stat = this.stats.get(l.id);
          return {
            title: l.title,
            seconds: stat?.seconds ?? 0,
            pulses: stat?.pulses ?? 0,
            stars: (this.manager.starsOf(l.id) as Stars) ?? 0
          };
        });
        this.finalPanel.show(list, campaignKnowledgeCard(level.id));
      } else {
        this.setState('levelComplete');
        this.hud.hide();
        this.completePanel.show({
          levelTitle: level.title,
          activated: session.activatedCount,
          required: session.requiredCount,
          seconds: session.elapsed,
          pulses: session.pulsesUsed,
          par,
          stars,
          comment,
          newRecord: stars > previousStars,
          // 主线关卡：按内置关卡 id 取对应的深海声景知识卡
          knowledgeCard: campaignKnowledgeCard(level.id),
          actions: [
            { label: '下一关', kind: 'primary', onClick: () => this.gotoNextLevel() },
            { label: '重玩本关', onClick: () => this.replayCurrent() },
            {
              label: '返回关卡中心',
              kind: 'ghost',
              onClick: () => {
                this.completePanel.hide();
                this.gotoLevelCenter('campaign');
              }
            }
          ]
        });
      }
      this.refreshHomeStats();
    } else if (this.external?.kind === 'random') {
      this.setState('levelComplete');
      this.hud.hide();
      const params = level.random;
      this.completePanel.show({
        levelTitle: level.title,
        activated: session.activatedCount,
        required: session.requiredCount,
        seconds: session.elapsed,
        pulses: session.pulsesUsed,
        par,
        stars,
        comment,
        // 随机关卡没有固定的科学情境：显示通用卡，不按 id 匹配主线卡片
        knowledgeCard: GENERIC_KNOWLEDGE_CARD,
        actions: [
          {
            label: '换一张新的',
            kind: 'primary',
            onClick: () => {
              this.completePanel.hide();
              this.startRandom({ ...(params ?? { cols: 7, rows: 5, nodes: 2, braid: 0.15 }), seed: randomSeed() });
            }
          },
          { label: '再玩这张', onClick: () => this.replayCurrent() },
          {
            label: '返回随机设置',
            kind: 'ghost',
            onClick: () => {
              this.completePanel.hide();
              this.gotoLevelCenter('random');
            }
          }
        ]
      });
    } else {
      // 自定义关卡：记录成绩，通关后回到来处（编辑器 或 我的关卡列表）
      let newRecord = false;
      if (level.customId) {
        const prev = this.store.get(level.customId)?.bestStars ?? 0;
        newRecord = stars > prev;
        this.store.markCleared(level.customId, session.elapsed, session.pulsesUsed, stars);
        // 列表与首页统计都要重画：否则返回后看到的是旧星级
        this.levelCenter.refreshCustom();
        this.refreshHomeStats();
      }
      this.setState('levelComplete');
      this.hud.hide();
      const fromEditor = this.external?.fromEditor === true;
      const customId = level.customId;
      this.completePanel.show({
        levelTitle: level.title,
        activated: session.activatedCount,
        required: session.requiredCount,
        seconds: session.elapsed,
        pulses: session.pulsesUsed,
        par,
        stars,
        comment,
        // 编辑器试玩没有"历史纪录"的概念（地图可能刚改过），所以不标新纪录
        newRecord: level.customId ? newRecord : false,
        // 自定义关卡同样没有固定的科学情境：显示通用卡
        knowledgeCard: GENERIC_KNOWLEDGE_CARD,
        actions: fromEditor
          ? [
              {
                label: '回到编辑器',
                kind: 'primary',
                onClick: () => {
                  this.completePanel.hide();
                  this.disposeSession();
                  this.setState('editor');
                  this.editor.show();
                }
              },
              { label: '再玩一次', onClick: () => this.replayCurrent() }
            ]
          : [
              {
                label: '返回我的关卡',
                kind: 'primary',
                onClick: () => {
                  this.completePanel.hide();
                  this.gotoLevelCenter('custom');
                }
              },
              { label: '再玩一次', onClick: () => this.replayCurrent() },
              // "刚打完一关"是分享欲最强的时刻。以前必须先退回列表再点「分享码」，
              // 现在直接就在结算面板上——同一串码，少两次点击。
              ...(customId
                ? [{ label: '分享码', onClick: () => this.shareCustom(customId) }]
                : [])
            ]
      });
    }

    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
  }

  // ==================== 力竭结算 ====================

  /**
   * 生命耗尽：给出失败结算，而不是直接把玩家踢回列表。
   *
   * 主线关卡不计成绩、不解锁下一关（这本来就是"没打完"）；
   * 重开时保留已发现的陷阱标记，让失败变成"积累了情报"而非"白玩一次"。
   */
  private handleExhausted(): void {
    const session = this.session;
    if (!session) return;

    const level = this.manager.current;
    const keepTrapMemory = session.keepTrapMemoryOnDeath;
    this.audio.playExhausted();
    this.hud.setTip(null);
    this.setState('exhausted');
    this.hud.hide();

    const retry = (): void => this.restartLevel(keepTrapMemory);

    this.exhaustedPanel.show({
      levelTitle: level.title,
      activated: session.activatedCount,
      required: session.requiredCount,
      seconds: session.elapsed,
      spikesHit: session.spikesHit,
      jammersHit: session.jammersHit,
      keepTrapMemory,
      actions:
        this.manager.isCampaign && !this.external
          ? [
              { label: '再试一次', kind: 'primary', onClick: retry },
              {
                label: '返回关卡中心',
                kind: 'ghost',
                onClick: () => {
                  this.exhaustedPanel.hide();
                  this.gotoLevelCenter('campaign');
                }
              }
            ]
          : this.external?.kind === 'custom' && this.external.fromEditor
            ? [
                { label: '返回编辑器', kind: 'primary', onClick: () => {
                  this.exhaustedPanel.hide();
                  this.disposeSession();
                  this.setState('editor');
                  this.editor.show();
                } },
                { label: '再试一次', onClick: retry }
              ]
            : [
                { label: '再试一次', kind: 'primary', onClick: retry },
                {
                  label: this.external?.kind === 'random' ? '返回随机设置' : '返回我的关卡',
                  kind: 'ghost',
                  onClick: () => {
                    this.exhaustedPanel.hide();
                    this.gotoLevelCenter(this.external?.kind === 'random' ? 'random' : 'custom');
                  }
                }
              ]
    });

    this.input.clearAll();
    this.touchControls.reset();
    this.gamepad.reset();
  }

  private gotoNextLevel(): void {
    this.completePanel.hide();
    if (this.manager.next()) {
      this.startSession();
    } else {
      this.gotoHome();
    }
  }

  private replayCurrent(): void {
    this.completePanel.hide();
    this.restartLevel();
  }

  // ==================== 自定义关卡：保存 / 分享 / 导入 ====================

  private levelFromRecord(record: CustomLevelRecord): LevelDefinition {
    const nodes = record.map.join('').split('R').length - 1;
    return {
      id: 0,
      source: 'custom',
      customId: record.id,
      // code 是"解析用的内部格式"，不是给用户看的。
      //
      // 早期这里写死成 `code: undefined`，于是 shareCustom() / saveCustom() 里的
      // `level.code ?? ''` 永远落到空串，弹窗打开是一条空白。
      // 现在弹窗那条线改走 shareTextOf()（可读化外形），这里保留真码，
      // 供任何需要"再解析一次"的调用方使用，同时杜绝 `?? ''` 兜底再次退化成空白。
      code: this.internalCodeOf(record),
      title: record.title,
      subtitle: `${record.map[0]?.length ?? 0} × ${record.map.length} · ${nodes} 节点`,
      requiredResonators: nodes,
      hint: [],
      map: record.map
    };
  }

  /**
   * 内部格式（`RFM1~…`）。`encodeMapCode` 对空地图会抛错，
   * 而 localStorage 里的记录理论上可能被外部改坏，所以兜一层返回空串；
   * 由调用方决定"空码"该怎么提示，而不是让异常冒到主循环打断整局游戏。
   */
  private internalCodeOf(record: CustomLevelRecord): string {
    try {
      return encodeMapCode(record.title, record.map);
    } catch {
      return '';
    }
  }

  /**
   * 可读化外形（`RESO·…`）：弹窗里展示、复制给朋友的都必须是这一串。
   *
   * 失败时返回空串。失败原因有两种，都要当成"没有码"来处理：
   *   ① `encodeMapCode` 抛错（空地图、行宽不一致）—— 由 catch 兜住；
   *   ② 生成了码，但这条码**连自己的解码器都不接受**（例如历史上出现过的
   *      宽度 0 死码 `RESO·0·1··…`）。只靠 try/catch 是拦不住 ② 的，
   *      因为它在编码侧完全"合法"。
   *
   * 所以这里补一道**自检**：编出来立刻解一遍，解不开就当作没有码。
   * 这一层是防御性的 —— 它保证"弹窗里出现的码，一定是一串能被别人导入的码"，
   * 无论上游又漏了哪种非法输入。
   */
  private shareTextOf(record: CustomLevelRecord): string {
    let code = '';
    try {
      code = encodeMapShareText(record.title, record.map);
    } catch {
      return '';
    }
    if (code.length === 0) return '';
    try {
      decodeShareCode(code);
      return code;
    } catch {
      return '';
    }
  }

  /** 给"生不出码"的统一提示，避免调用方各自编文案 */
  private shareErrorText(record: CustomLevelRecord): string {
    return `《${record.title}》内容为空或已损坏，无法生成分享码。请打开编辑器确认地图至少有一行内容。`;
  }

  private saveCustom(input: { id: string; title: string; map: string[] }): void {
    const record = this.store.upsert({
      id: input.id || undefined,
      title: normalizeTitle(input.title),
      map: input.map,
      origin: 'editor'
    });
    this.refreshHomeStats();
    // 列表 DOM 由 show() 时才渲染，保存时若不主动重画，
    // 返回关卡中心看到的会是保存前的旧列表（刚存的关卡"消失"）。
    this.levelCenter.refreshCustom();
    const code = this.shareTextOf(record);
    // 保存路径理论上拿得到码（编辑器已用 report.playable 守住空地图），
    // 但"保存成功却弹出空白分享码"是最伤的一类失败，所以同样兜一层：
    // 宁可只提示"已保存"、不弹分享框，也不让用户看到一条空码。
    if (code.length === 0) {
      this.levelCenter.show('custom');
      this.levelCenter.setMessage('custom', `《${record.title}》已保存。${this.shareErrorText(record)}`, 'error');
      return;
    }
    this.share.show(
      '已保存到我的关卡',
      `《${record.title}》已保存。下面是它的分享码，发给朋友即可让他玩到这张地图。`,
      code
    );
  }

  private shareCustom(id: string): void {
    const record = this.store.get(id);
    if (!record) return;
    const code = this.shareTextOf(record);
    if (code.length === 0) {
      this.levelCenter.show('custom');
      this.levelCenter.setMessage('custom', this.shareErrorText(record), 'error');
      return;
    }
    this.share.show(
      '分享码',
      `把《${record.title}》的分享码发给朋友，对方在「我的关卡 → 导入分享码」粘贴即可。`,
      code
    );
  }

  /**
   * 导入分享码。
   * - 随机码：直接开始随机关卡；
   * - 地图码：存为自定义关卡，play 为真时立刻开玩（随机页的"导入并游玩"），
   *   为假时只入库（我的关卡页的"导入"）。
   * 返回的文案会显示在对应页面的提示区。
   */
  private importCode(code: string, play: boolean): { ok: boolean; message: string } {
    let payload;
    try {
      payload = decodeShareCode(code);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }

    if (payload.kind === 'random') {
      this.startRandom(payload.params);
      return { ok: true, message: '随机种子码已导入，开始游戏。' };
    }

    const report = analyzeRows(payload.rows);
    const error = firstError(report);
    if (error) {
      return { ok: false, message: `分享码里的地图无法游玩：${error}` };
    }

    const record = this.store.upsert({
      title: payload.title.length > 0 ? payload.title : '来自分享码的关卡',
      map: payload.rows,
      origin: 'shared'
    });
    this.refreshHomeStats();
    this.levelCenter.show('custom');
    if (play) {
      this.startExternal(this.levelFromRecord(record), 'custom', false);
      return { ok: true, message: `已导入《${record.title}》，开始游戏。` };
    }
    return { ok: true, message: `已导入《${record.title}》，可在列表中试玩。` };
  }

  // ==================== 其它 ====================

  private disposeSession(): void {
    if (this.session) {
      this.session.pulseSystem.cancel();
      this.session.effects.clear();
    }
    this.session = null;
  }

  private toggleSound(): void {
    this.audio.setMuted(!this.audio.isMuted);
    this.storage.setMuted(this.audio.isMuted);
    this.applySoundLabels();
  }

  private applySoundLabels(): void {
    this.home.setSoundLabel(this.audio.isMuted);
    this.hud.setSoundLabel(this.audio.isMuted);
  }

  /**
   * 手柄插拔回调。
   * 只在"连接状态真的变了"时被调用（判断在 GamepadController 里做），
   * 所以这里可以放心地直接改 DOM，不会每帧重写 classList。
   */
  private handleGamepadChange(name: string | null): void {
    document.body.classList.toggle('pad-connected', name !== null);
    if (name !== null) {
      // 标题页的 HUD 是隐藏的，此刻弹 toast 玩家根本看不到。
      // 于是挂一个"待提示"标记，等真正进入游玩再补发 ——
      // 否则玩家在标题页插上手柄时**得不到任何反馈**，
      // 会误判成"手柄根本没被认到"（这正是曾经报上来的症状之一）。
      this.pendingPadToast = `手柄已连接：${shortPadName(name)}`;
      if (this.state === 'playing') this.flushPadToast();
    } else {
      this.pendingPadToast = null;
    }
    this.menus.reset();
  }

  /** 把挂起的连接提示发出去（只在 HUD 可见时有效） */
  private flushPadToast(): void {
    if (!this.pendingPadToast) return;
    this.hud.showToast(this.pendingPadToast);
    this.pendingPadToast = null;
  }

  // ==================== 每帧更新 ====================

  private update(dt: number): void {
    // 手柄是轮询式的，必须每帧主动取一次快照（见 GamepadController 说明）
    this.gamepad.poll();

    if (this.state === 'playing' && this.session) {
      // 暂停 / 结算时不推进模拟：玩家、脉冲、计时、可见性全部冻结
      // 方向优先级：触摸摇杆 > 手柄 > 键盘。
      // 三者各自可能返回 null，null 表示"这一路没在输入"，交给下一路。
      const dir =
        this.touchControls.direction ??
        this.gamepad.direction ??
        this.readMoveDirection();
      this.session.update(dt, dir);

      // 每种输入都各自 consume：用 || 串联会让前一个为真时短路掉后一个，
      // 把它的按下事件留到下一帧去触发。
      const padPulse = this.gamepad.consumePress('pulse');
      const keyPulse = this.input.consumePress('pulse');
      if (this.touchControls.consumePulse() || padPulse || keyPulse) this.session.emitPulse();

      const padRestart = this.gamepad.consumePress('restart');
      const keyRestart = this.input.consumePress('restart');
      if (padRestart || keyRestart) this.restartLevel();

      const padPause = this.gamepad.consumePress('pause');
      const keyPause = this.input.consumePress('pause');
      if (padPause || keyPause) this.pause();
    } else if (this.state === 'paused') {
      const padPause = this.gamepad.consumePress('pause');
      const keyPause = this.input.consumePress('pause');
      if (padPause || keyPause) this.resume();

      const padRestart = this.gamepad.consumePress('restart');
      const keyRestart = this.input.consumePress('restart');
      if (padRestart || keyRestart) {
        this.pausePanel.hide();
        this.restartLevel();
      }
    } else if (this.state === 'exhausted' && this.session) {
      // 力竭后仍推进特效（让爆炸粒子播完），但玩家不能再操作
      this.session.update(dt, null);
      const padRestart = this.gamepad.consumePress('restart');
      const keyRestart = this.input.consumePress('restart');
      if (padRestart || keyRestart) this.restartLevel(this.session.keepTrapMemoryOnDeath);
    }

    // 非游玩状态把手柄交给菜单导航：否则打完一关就点不到"下一关"
    if (this.state !== 'playing') this.updateMenuFocus();

    this.input.endFrame();
    this.gamepad.endFrame();
  }

  /**
   * 手柄的界面焦点导航。
   *
   * 编辑器被排除在外：那是一个鼠标/触摸的"作画"界面，
   * 手柄进去只会和落笔、擦除抢同一个按键，帮不上忙。
   */
  private updateMenuFocus(): void {
    if (this.state === 'editor') return;

    const prevLeft = this.gamepad.consumePress('left');
    const prevUp = this.gamepad.consumePress('up');
    const nextRight = this.gamepad.consumePress('right');
    const nextDown = this.gamepad.consumePress('down');
    if (prevLeft || prevUp) this.menus.move(-1);
    if (nextRight || nextDown) this.menus.move(1);

    if (this.gamepad.consumePress('pulse')) this.menus.activate();
  }

  /** 把持续按住的方向键转换为移动方向（同时按下时优先最后按下的轴） */
  private readMoveDirection(): { dx: number; dy: number } | null {
    const up = this.input.isHeld('up');
    const down = this.input.isHeld('down');
    const left = this.input.isHeld('left');
    const right = this.input.isHeld('right');

    if (up && !down) return { dx: 0, dy: -1 };
    if (down && !up) return { dx: 0, dy: 1 };
    if (left && !right) return { dx: -1, dy: 0 };
    if (right && !left) return { dx: 1, dy: 0 };
    return null;
  }

  /**
   * 只读调试快照（开发与自动化测试用）。
   * 不修改任何状态，只把当前状态机的关键字段暴露出来。
   */
  getDebugSnapshot(): Record<string, unknown> {
    const session = this.session;
    return {
      state: this.state,
      source: this.external?.kind ?? (this.manager.isCampaign ? 'campaign' : 'external'),
      level: session ? session.level.title : null,
      customId: session ? (session.level.customId ?? null) : null,
      player: session ? { x: session.player.x, y: session.player.y } : null,
      activated: session ? session.activatedCount : 0,
      required: session ? session.requiredCount : 0,
      exitOpen: session ? session.exitOpen : false,
      completed: session ? session.completed : false,
      exhausted: session ? session.exhausted : false,
      health: session ? session.health : 0,
      maxHealth: session ? session.maxHealth : 0,
      invulnerable: session ? Number(Math.max(0, session.invulnerableTimer).toFixed(2)) : 0,
      spikesHit: session ? session.spikesHit : 0,
      jammersHit: session ? session.jammersHit : 0,
      explored: session ? session.exploredCount : 0,
      pulses: session ? session.pulsesUsed : 0,
      // 星级评分：验收脚本要用 par 与当前星级核对阈值是否真的生效
      parPulses: session ? session.parPulses : 0,
      stars: session ? session.stars : 0,
      elapsed: session ? Number(session.elapsed.toFixed(2)) : 0,
      activePulse: session ? session.pulseSystem.pulse !== null : false,
      cooldown: session ? Number(session.pulseSystem.cooldown.toFixed(2)) : 0,
      // 手柄：验收脚本要确认"连接后提示条换成手柄键位"以及菜单焦点落在谁身上
      gamepadConnected: this.gamepad.isConnected,
      gamepadName: this.gamepad.isConnected ? shortPadName(this.gamepad.name) : null,
      // 原始诊断：手柄"连上了却按不动"时，靠它区分是 mapping 非标准、
      // axes 顺序不同还是 pressed 恒 false —— 只看"有没有连接"是查不出来的
      gamepadDiag: this.gamepad.diagnostics(),
      menuFocus: this.menus.focused?.textContent ?? null
    };
  }

  /** 开发调试用：当前关卡的地图行（自动化测试用来复算通关路径） */
  debugMap(): string[] | null {
    if (!this.session) return null;
    return this.session.level.map.slice();
  }

  /** 开发调试用：查询某个格子是否已被探索 */
  debugIsExplored(x: number, y: number): boolean | null {
    if (!this.session) return null;
    const map = this.session.map;
    if (!map.inBounds(x, y)) return null;
    return this.session.visibility.isExplored(map.index(x, y));
  }

  /** 开发调试用：查询某个格子的陷阱是否已被识别（用于验收"陷阱能被记住"） */
  debugIsTrapKnown(x: number, y: number): boolean | null {
    if (!this.session) return null;
    const map = this.session.map;
    if (!map.inBounds(x, y)) return null;
    return this.session.visibility.isTrapKnown(map.index(x, y));
  }

  private render(): void {
    this.renderer.draw(this.session);
    if (this.state === 'playing' && this.session) {
      this.hud.update(this.session);
    }
  }
}
