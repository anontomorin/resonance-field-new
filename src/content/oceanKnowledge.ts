/**
 * 深海声景知识卡（静态内容）。
 *
 * 事实依据 NOAA / NOAA Fisheries / IMO 的公开资料，均为简短转述而非逐字引用。
 * 这里只保存已经确认过的静态文本与官方链接，不做任何网络请求——
 * 游戏离线也必须能完整运行，通关卡不能在断网时变成空白或死链接。
 *
 * 边界：游戏里的脉冲、墙体遮挡与信号干扰都是玩法抽象，
 * 不是真实声场或声呐模型；节点也只是游戏目标，不代表已识别的物种或海域。
 *
 * 卡片编号（A~E）与来源对应《权威参考资料表》[1]~[4]：
 * A/B/E -> [1] NOAA Fisheries，C -> [2] NOAA，D -> [3] IMO 主题页 + [4] IMO 2023 新闻（背景参考）。
 * 其余三条官方来源（NOAA Fisheries 鱼类与无脊椎动物、NOAA 公众解释、NOAA Ocean Noise Strategy）
 * 不在卡片里单独成卡，而是列在首页「资料来源」区，避免为了凑数把事实塞进关卡情境。
 */

export interface OceanKnowledgeCard {
  id: string;
  title: string;
  body: string;
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
}

/** 主线五关各自对应的知识卡，键为关卡 id */
export const OCEAN_KNOWLEDGE_CARDS: Record<number, OceanKnowledgeCard> = {
  // id 1 → 卡片 A｜海洋并非无声
  1: {
    id: 'ocean-soundscape',
    title: '海洋并非无声',
    body: '海洋声景可能包含海洋动物的声音、风雨与海冰等环境声音，以及船舶等人类活动声音。声音记录能帮助研究人员了解某个地点正在发生什么。',
    sourceName: 'NOAA Fisheries',
    sourceTitle: 'Environmental and Anthropogenic Ocean Sounds',
    sourceUrl:
      'https://www.fisheries.noaa.gov/national/science-data/sounds-ocean-environmental-and-anthropogenic'
  },
  // id 2 → 卡片 B｜声音能帮助海洋动物感知环境
  2: {
    id: 'sound-for-marine-life',
    title: '声音能帮助海洋动物感知环境',
    body: '许多海洋动物依靠声音进行交流、寻找食物、导航或了解周围环境。声音的节奏、音高与结构变化也可能传递不同信息。',
    sourceName: 'NOAA Fisheries',
    sourceTitle: 'Environmental and Anthropogenic Ocean Sounds',
    sourceUrl:
      'https://www.fisheries.noaa.gov/national/science-data/sounds-ocean-environmental-and-anthropogenic'
  },
  // id 3 → 卡片 E｜科学家如何记录水下声音
  3: {
    id: 'how-scientists-record',
    title: '科学家如何记录水下声音',
    body: '被动声学记录器可以由船只拖曳、搭载在水下机器人上，或放置在固定水下地点，连续记录一段时间的声景。游戏中的主动脉冲探索与真实的被动声学监测并不是同一方法；这一关的墙体遮挡规则同样是游戏里的简化模型。',
    sourceName: 'NOAA Fisheries',
    sourceTitle: 'Environmental and Anthropogenic Ocean Sounds',
    sourceUrl:
      'https://www.fisheries.noaa.gov/national/science-data/sounds-ocean-environmental-and-anthropogenic'
  },
  // id 4 → 卡片 C｜水下噪声的影响并不只有一个维度
  4: {
    id: 'noise-is-multi-dimensional',
    title: '水下噪声的影响并不只有一个维度',
    body: '噪声影响会受到声音强度、持续时间和频率等因素影响。不同声音、物种和环境的影响并不完全相同，不能只用“声音大或小”解释全部问题。',
    sourceName: 'NOAA',
    sourceTitle: 'Marine Mammals: Underwater Noise',
    sourceUrl: 'https://www.noaa.gov/marine-mammals-underwater-noise'
  },
  // id 5 → 卡片 D｜船舶也是水下声源之一（来源 [3] 主题页 + [4] 2023 新闻作背景参考）
  5: {
    id: 'ships-as-noise-source',
    title: '船舶也是水下声源之一',
    body: '国际海事组织指出，商业航运是水下辐射噪声的重要来源之一；这种噪声可能对多种海洋生物的重要生命活动产生不利影响。研究和降低噪声需要科学评估与行业协作。',
    sourceName: '国际海事组织（IMO）',
    // 权威资料表提醒：指南的当前状态以主题页 [3] 为准，[4] 只作背景参考，
    // 所以正文不写"已生效/已通过"，链接也只指向主题页。
    sourceTitle: 'Ship noise（背景参考：Addressing underwater noise from ships, 2023）',
    sourceUrl: 'https://www.imo.org/en/mediacentre/hottopics/pages/noise.aspx'
  }
};

/**
 * 通用卡：随机 / 自定义关卡没有固定的科学情境，
 * 显示与具体物种、海域无关的卡片，避免把外部关卡误当成某个主线关卡。
 */
export const GENERIC_KNOWLEDGE_CARD: OceanKnowledgeCard = OCEAN_KNOWLEDGE_CARDS[1];

/** 按主线关卡 id 取卡；只有内置主线关卡才会命中 */
export function campaignKnowledgeCard(levelId: number): OceanKnowledgeCard | undefined {
  return OCEAN_KNOWLEDGE_CARDS[levelId];
}
