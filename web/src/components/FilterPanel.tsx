import { useState } from "react";
import { useCardMeta } from "../lib/cardMeta";
import { emptyFilters, type Filters } from "../lib/query";

const CIVS: [string, string][] = [
  ["光", "light"],
  ["水", "water"],
  ["闇", "dark"],
  ["火", "fire"],
  ["自然", "nature"],
  ["無色", "zero"],
];

/** Structured filters; every change is turned into a query by the parent. */
export function FilterPanel({ value: f, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const meta = useCardMeta();
  const [kwInput, setKwInput] = useState("");
  // Text inputs are applied on Enter / blur, everything else immediately.
  const [text, setText] = useState<Partial<Filters>>({});
  const set = (patch: Partial<Filters>) => onChange({ ...f, ...patch });
  const textField = (key: keyof Filters, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => ({
    value: (text[key] as string | undefined) ?? (f[key] as string),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText({ ...text, [key]: e.target.value }),
    onBlur: () => commit(key),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(key);
      }
    },
    ...props,
  });
  const commit = (key: keyof Filters) => {
    if (text[key] === undefined || text[key] === f[key]) return;
    const { [key]: v, ...rest } = text;
    setText(rest);
    set({ [key]: v } as Partial<Filters>);
  };
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addKw = () => {
    const v = kwInput.trim();
    if (!v) return;
    setKwInput("");
    set({ keywords: [...f.keywords, v] });
  };

  return (
    <aside className="filters">
      <div className="filters-head">
        <strong>条件</strong>
        <button
          type="button"
          className="link"
          onClick={() => {
            setText({});
            onChange(emptyFilters());
          }}
        >
          クリア
        </button>
      </div>

      <label className="f">
        カード名
        <input type="text" placeholder="部分一致（かな/カナ/・無視）" {...textField("name")} />
      </label>
      <label className="f">
        テキスト
        <input type="text" placeholder="能力テキストの部分一致" {...textField("text")} />
      </label>

      <fieldset className="f">
        <legend>文明</legend>
        <div className="civs">
          {CIVS.map(([c, cls]) => (
            <label key={c} className={`civ civ-${cls}`}>
              <input type="checkbox" checked={f.civs.includes(c)} onChange={() => set({ civs: toggle(f.civs, c) })} />
              {c}
            </label>
          ))}
        </div>
        <select value={f.civMode} onChange={(e) => set({ civMode: e.target.value as Filters["civMode"] })}>
          <option value=":">選んだ文明をすべて含む</option>
          <option value="any">選んだ文明のどれかを含む</option>
          <option value="=">ちょうどその文明</option>
          <option value="<=">その文明だけで組める（無色も）</option>
        </select>
        <select value={f.civCount} onChange={(e) => set({ civCount: e.target.value as Filters["civCount"] })}>
          <option value="">単色/多色 指定なし</option>
          <option value="単色">単色のみ</option>
          <option value="多色">多色のみ</option>
        </select>
      </fieldset>

      <div className="f range">
        <span>コスト</span>
        <input type="number" min={0} placeholder="min" {...textField("costMin")} />〜
        <input type="number" min={0} placeholder="max" {...textField("costMax")} />
      </div>
      <div className="f range">
        <span>パワー</span>
        <input type="number" min={0} step={500} placeholder="min" {...textField("powMin")} />〜
        <input type="number" min={0} step={500} placeholder="max" {...textField("powMax")} />
      </div>

      <label className="f">
        カードの種類
        <select value={f.type} onChange={(e) => set({ type: e.target.value })}>
          <option value="">指定なし</option>
          {meta?.types
            .filter((t) => t.cardCount >= 3)
            .map((t) => (
              <option key={t.type} value={t.type}>
                {t.type}（{t.cardCount}）
              </option>
            ))}
        </select>
      </label>
      <label className="f">
        種族
        <input type="text" list="dl-races" placeholder="部分一致（例: ドラゴン）" {...textField("race")} />
      </label>

      <fieldset className="f">
        <legend>キーワード能力</legend>
        <div className="chip-input">
          <input
            type="text"
            list="dl-keywords"
            value={kwInput}
            onChange={(e) => setKwInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKw();
              }
            }}
            placeholder="例: ジャストダイバー / パワーアタッカー>=2000"
          />
          <button type="button" onClick={addKw}>
            追加
          </button>
        </div>
        <div className="chips">
          {f.keywords.map((k, i) => (
            <span className="chip" key={i}>
              {k}
              <button type="button" aria-label="削除" onClick={() => set({ keywords: f.keywords.filter((_, j) => j !== i) })}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <label>
            <input type="radio" checked={f.kwMode === "and"} onChange={() => set({ kwMode: "and" })} /> すべて (AND)
          </label>
          <label>
            <input type="radio" checked={f.kwMode === "or"} onChange={() => set({ kwMode: "or" })} /> どれか (OR)
          </label>
        </div>
        <label className="small">
          <input type="checkbox" checked={f.kwAlways} onChange={(e) => set({ kwAlways: e.target.checked })} /> 条件付きで得るものを除外
        </label>
      </fieldset>

      <fieldset className="f">
        <legend>
          効果タグ <span className="muted small">(テキストからの推定)</span>
        </legend>
        <div className="tag-grid">
          {meta?.tags.map((t) => (
            <label key={t.tag} title={t.description}>
              <input type="checkbox" checked={f.tags.includes(t.tag)} onChange={() => set({ tags: toggle(f.tags, t.tag) })} />
              {t.label} <span className="muted">{t.cardCount}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <label>
            <input type="radio" checked={f.tagMode === "and"} onChange={() => set({ tagMode: "and" })} /> AND
          </label>
          <label>
            <input type="radio" checked={f.tagMode === "or"} onChange={() => set({ tagMode: "or" })} /> OR
          </label>
        </div>
      </fieldset>

      <label className="f">
        収録弾
        <input type="text" list="dl-sets" placeholder="例: DM26-RP1 / dm26*" {...textField("set")} />
      </label>
      <label className="f small" style={{ marginTop: -6 }}>
        <input type="checkbox" checked={f.setFirst} onChange={(e) => set({ setFirst: e.target.checked })} /> その弾が初登場のカードだけ（再録を除く）
      </label>
      <label className="f">
        イラストレーター
        <input type="text" list="dl-illust" placeholder="部分一致" {...textField("illust")} />
      </label>
      <label className="f">
        レアリティ
        <select value={f.rarity} onChange={(e) => set({ rarity: e.target.value })}>
          <option value="">指定なし</option>
          {meta?.rarities.map((r) => (
            <option key={r.rarity} value={r.rarity}>
              {r.rarity}（{r.n}）
            </option>
          ))}
        </select>
      </label>
      <label className="f">
        フォーマット
        <select value={f.format} onChange={(e) => set({ format: e.target.value as Filters["format"] })}>
          <option value="">指定なし</option>
          <option value="original">オリジナルで使用可</option>
          <option value="advance">アドバンスで使用可</option>
        </select>
      </label>
      <label className="f">
        殿堂
        <select value={f.reg} onChange={(e) => set({ reg: e.target.value as Filters["reg"] })}>
          <option value="">指定なし</option>
          <option value="none">無制限</option>
          <option value="restricted">殿堂入り</option>
          <option value="premium">プレミアム殿堂</option>
        </select>
      </label>
      <label className="f">
        その他
        <select value={f.is} onChange={(e) => set({ is: e.target.value })}>
          <option value="">指定なし</option>
          <option value="twinpact">ツインパクト</option>
          <option value="psychic">超次元のカード</option>
          <option value="gr">GRクリーチャー</option>
          <option value="evolution">進化</option>
          <option value="vanilla">バニラ（能力なし）</option>
          <option value="reprint">再録あり</option>
        </select>
      </label>
      <p className="muted small">条件を変えると上の検索欄にクエリが生成されます。クエリを直接書き換えてもOK。</p>

      <datalist id="dl-keywords">
        {meta?.families.map((x) => (
          <option key={`f-${x.name}`} value={x.name}>
            {x.name}（系統・{x.members}種）
          </option>
        ))}
        {meta?.keywords.map((k) => (
          <option key={k.name} value={k.name}>
            {k.name}（{k.cardCount}）
          </option>
        ))}
      </datalist>
      <datalist id="dl-races">
        {meta?.races.slice(0, 2000).map((r) => (
          <option key={r.race} value={r.race}>
            {r.race}（{r.cardCount}）
          </option>
        ))}
      </datalist>
      <datalist id="dl-sets">
        {meta?.sets.map((s) => (
          <option key={s.code} value={s.displayCode || s.code}>
            {s.label}
          </option>
        ))}
      </datalist>
      <datalist id="dl-illust">
        {meta?.illustrators.map((i) => (
          <option key={i.name} value={i.name}>
            {i.name}（{i.printingCount}）
          </option>
        ))}
      </datalist>
    </aside>
  );
}
