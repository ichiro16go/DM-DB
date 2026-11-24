import { nfkc, stripReminder } from "../lib/normalize.js";

/**
 * Rule-based effect tags ("roles") for deck building and AI search.
 * These are heuristics over ability text (source = "rule"): good recall for the
 * common templated wordings, not a substitute for reading the card. Each tag has
 * a Japanese label for the UI.
 */
export interface TagRule {
  tag: string;
  label: string;
  description: string;
  patterns: RegExp[];
  /** If any of these match the same ability line, the tag is not applied. */
  exclude?: RegExp[];
}

const OPP = "(相手の|相手は|相手が)";

export const TAG_RULES: TagRule[] = [
  {
    tag: "draw",
    label: "ドロー",
    description: "カードを引く",
    patterns: [/カードを\d+枚(まで)?引/, /カードを\d+枚引いてもよい/, /カードを引く/, /\d+枚まで引/],
  },
  {
    tag: "removal_destroy",
    label: "除去:破壊",
    description: "相手のクリーチャー等を破壊する",
    patterns: [
      new RegExp(`${OPP}.{0,40}(クリーチャー|カード|エレメント).{0,30}(破壊する|破壊してもよい)`),
      /(クリーチャー|エレメント)を(すべて|\d+体)?破壊する/,
    ],
    exclude: [/^自分の(クリーチャー|エレメント)を\d+体破壊する/],
  },
  {
    tag: "removal_bounce",
    label: "除去:バウンス",
    description: "相手のカードを手札に戻す",
    patterns: [new RegExp(`${OPP}.{0,40}(クリーチャー|カード|エレメント).{0,30}(持ち主の)?手札に戻`)],
  },
  {
    tag: "removal_mana",
    label: "除去:マナ送り",
    description: "相手のカードをマナゾーンに置く",
    patterns: [new RegExp(`${OPP}.{0,40}(クリーチャー|エレメント).{0,30}(持ち主の)?マナゾーンに置`)],
  },
  {
    tag: "removal_shield",
    label: "除去:シールド送り",
    description: "相手のカードをシールドゾーンに置く",
    patterns: [new RegExp(`${OPP}.{0,40}(クリーチャー|エレメント).{0,30}(持ち主の)?シールド(ゾーンに|化)`)],
  },
  {
    tag: "removal_deck",
    label: "除去:山札送り",
    description: "相手のカードを山札に送る",
    patterns: [new RegExp(`${OPP}.{0,40}(クリーチャー|エレメント).{0,30}(持ち主の)?山札の(下|上)に`)],
  },
  {
    tag: "removal_graveyard",
    label: "除去:墓地送り",
    description: "相手のカードを墓地に置く",
    patterns: [new RegExp(`${OPP}.{0,40}(クリーチャー|エレメント).{0,30}(持ち主の)?墓地に置`)],
    exclude: [/シールド/],
  },
  { tag: "power_minus", label: "パワー低下", description: "パワーをマイナスする", patterns: [/パワーを-\d+/, /パワーは-\d+/] },
  { tag: "tap", label: "タップ", description: "相手のクリーチャーをタップする", patterns: [new RegExp(`${OPP}.{0,30}クリーチャー.{0,20}タップする`)] },
  { tag: "freeze", label: "フリーズ", description: "相手のクリーチャーを次のターンにアンタップさせない", patterns: [/アンタップしない/, /アンタップされない/] },
  {
    tag: "mana_boost",
    label: "マナ加速",
    description: "自分のマナを増やす",
    patterns: [
      /(自分の)?山札の上から\d+枚(目)?を.{0,20}マナゾーンに置/,
      /(自分の)?(手札|墓地)から.{0,30}自分のマナゾーンに置/,
      /自分の山札.{0,30}マナゾーンに置/,
      /マナゾーンに置いてもよい/,
    ],
  },
  {
    tag: "hand_disruption",
    label: "ハンデス",
    description: "相手の手札を捨てさせる",
    patterns: [/相手の手札を.{0,20}(捨て|墓地に)/, /相手は(自身の)?手札を.{0,20}捨て/, /相手の手札.{0,20}見ないで.{0,20}選/],
  },
  { tag: "tutor", label: "サーチ", description: "山札から手札に加える", patterns: [/山札(の上から\d+枚)?を見.{0,60}手札に加え/, /山札から.{0,40}手札に加え/] },
  { tag: "recursion", label: "墓地回収", description: "墓地から手札に戻す", patterns: [/墓地から.{0,40}手札に(戻|加え)/] },
  { tag: "reanimate", label: "リアニメイト", description: "墓地から出す", patterns: [/墓地から.{0,50}(出す|出してもよい|バトルゾーンに出)/] },
  { tag: "cheat", label: "踏み倒し", description: "コストを支払わずに出す/唱える", patterns: [/コストを支払わずに/] },
  {
    tag: "cost_reduction",
    label: "コスト軽減",
    description: "コストを少なくする",
    patterns: [/コストを\d+少なく/, /コストを.{0,10}少なくする/, /召喚コストを.{0,10}少なく/],
  },
  { tag: "cost_increase", label: "コスト加重", description: "相手のコストを多くする", patterns: [/コストを\d+多く/] },
  {
    tag: "shield_add",
    label: "シールド追加",
    description: "自分のシールドを増やす",
    patterns: [/自分の山札の上から\d+枚(目)?を.{0,10}シールド化/, /自分の.{0,20}シールド化/, /シールドを\d+つ追加/],
    exclude: [new RegExp(OPP)],
  },
  {
    tag: "shield_burn",
    label: "シールド焼却",
    description: "相手のシールドを直接墓地などへ",
    patterns: [/相手のシールドを\d+つ(選び|まで).{0,20}(墓地|マナゾーン|手札)/, /シールドをブレイクする時.{0,30}墓地に置/],
  },
  { tag: "unblockable", label: "ブロックされない", description: "ブロックされない", patterns: [/ブロックされない/] },
  {
    tag: "attack_lock",
    label: "攻撃制限",
    description: "相手のクリーチャーの攻撃を制限する",
    patterns: [/相手の.{0,30}(クリーチャー).{0,30}攻撃(できない|しない)/, /相手は.{0,20}攻撃できない/],
  },
  {
    tag: "summon_lock",
    label: "召喚/出す制限",
    description: "相手の召喚・出すことを制限する",
    patterns: [/相手は.{0,40}(召喚|出せない|出すことはできない|バトルゾーンに出せない)/, /相手の.{0,30}(召喚|出す)(こと)?(は|が)?できない/],
  },
  {
    tag: "spell_lock",
    label: "呪文制限",
    description: "相手の呪文を制限する",
    patterns: [/相手は.{0,30}呪文を唱えられない/, /相手は.{0,30}呪文を.{0,10}唱えることはできない/, /呪文を唱えるコストを.{0,10}多く/],
  },
  {
    tag: "trigger_lock",
    label: "トリガー封じ",
    description: "S・トリガー等を封じる",
    patterns: [/S・トリガー.{0,20}(使えない|使うことはできない|唱えられない)/, /シールド・トリガー.{0,20}(使えない|使うことはできない)/],
  },
  {
    tag: "protection",
    label: "耐性",
    description: "選ばれない・離れない・破壊されない等",
    patterns: [/(相手に)?選ばれない/, /離れない/, /破壊されない/, /かわりに.{0,20}(とどまる|墓地に置くかわりに)/],
  },
  { tag: "untap", label: "アンタップ", description: "自分のカードをアンタップする", patterns: [/(この|自分の).{0,20}(を|は)アンタップする/] },
  { tag: "extra_turn", label: "追加ターン", description: "追加ターンを得る", patterns: [/追加ターン/, /このターンの後に自分のターンを追加/] },
  { tag: "win_condition", label: "特殊勝利", description: "ゲームに勝つ", patterns: [/ゲームに勝利/, /このゲームに勝つ/, /自分はゲームに勝つ/] },
  { tag: "speed", label: "速攻", description: "召喚したターンに攻撃できる", patterns: [/スピードアタッカー/, /召喚酔いしない/, /出たターンに攻撃できる/] },
  { tag: "anti_attack", label: "防御", description: "攻撃を止める・ブロック・攻撃中止", patterns: [/ブロッカー/, /攻撃を中止/, /その攻撃を止め/] },
  { tag: "graveyard_fill", label: "墓地肥やし", description: "山札から墓地に置く", patterns: [/山札の上から\d+枚(目)?(まで)?を.{0,10}墓地に置/] },
  { tag: "evolution", label: "進化", description: "進化クリーチャー", patterns: [/^進化/, /進化:/] },
  {
    tag: "lethal_extra",
    label: "打点追加",
    description: "T・ブレイカー以上・追加攻撃など",
    patterns: [
      /(T|Q|G|ワールド|パワード|クルー|エイジ|マスター・T|ドラゴン・T)・ブレイカー/,
      /∞ ?ブレイカー/,
      /もう一度攻撃/,
      /(攻撃の(後|終わり)|攻撃の終わりに).{0,30}アンタップ/,
    ],
  },
];

export const TAG_LABELS: Record<string, string> = Object.fromEntries(TAG_RULES.map((r) => [r.tag, r.label]));

/** Tags for one face, given its ability lines. */
export function tagAbilities(abilities: string[]): string[] {
  const out = new Set<string>();
  for (const raw of abilities) {
    const line = stripReminder(nfkc(raw));
    if (!line) continue;
    for (const rule of TAG_RULES) {
      if (out.has(rule.tag)) continue;
      if (rule.exclude?.some((r) => r.test(line))) continue;
      if (rule.patterns.some((r) => r.test(line))) out.add(rule.tag);
    }
  }
  return [...out];
}
