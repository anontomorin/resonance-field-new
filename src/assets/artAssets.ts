/**
 * 美术资源出口。
 *
 * 所有 AI 生成的图片都在这里集中登记，TS 侧只认这个文件里的常量，
 * 不直接写 `./art/xxx.png` 这种路径——换图只改一处。
 *
 * CSS 侧不走这里：样式表用相对路径 `url('../assets/art/...')` 直接引用，
 * 由 Vite 在构建时重写。两边指向的是同一批文件。
 */

import glyphNode from './art/glyph-node.webp';
import glyphExit from './art/glyph-exit.webp';
import glyphSpike from './art/glyph-spike.webp';
import glyphJammer from './art/glyph-jammer.webp';
import glyphPlayer from './art/glyph-player.webp';
import kcSoundscape from './art/kc-01-soundscape.webp';
import kcMarineLife from './art/kc-02-marine-life.webp';
import kcRecorder from './art/kc-03-recorder.webp';
import kcNoise from './art/kc-04-noise.webp';
import kcShipping from './art/kc-05-shipping.webp';

/** 画布上的五枚金属徽记（128×128，透明底 WebP） */
export const GLYPHS = {
  node: glyphNode,
  exit: glyphExit,
  spike: glyphSpike,
  jammer: glyphJammer,
  player: glyphPlayer
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** 知识卡配图：键与 `oceanKnowledge` 里的卡片 id 一致 */
export const KNOWLEDGE_ART: Record<string, string> = {
  'ocean-soundscape': kcSoundscape,
  'sound-for-marine-life': kcMarineLife,
  'how-scientists-record': kcRecorder,
  'noise-is-multi-dimensional': kcNoise,
  'ships-as-noise-source': kcShipping
};
