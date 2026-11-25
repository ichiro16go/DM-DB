import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useCardMeta } from "../lib/cardMeta";
import { thumb } from "../lib/deck";
import type { CardDetail, CardItem, PrintingBrief, Zone } from "../types";

export function CivBar({ civs }: { civs: string[] }) {
  const list = civs.length ? civs : ["無色"];
  return (
    <div className="civbar">
      {list.map((c, i) => (
        <span key={i} className={`cb-${c}`} />
      ))}
    </div>
  );
}

export function CivDots({ civs }: { civs: string[] }) {
  const list = civs.length ? civs : ["無色"];
  return (
    <span className="civdots" title={list.join("/")}>
      {list.map((c, i) => (
        <span key={i} className={`dot cb-${c}`} />
      ))}
    </span>
  );
}

export function RegBadge({ regulation }: { regulation: CardItem["regulation"] }) {
  if (regulation === "premium") return <span className="badge premium">プレ殿</span>;
  if (regulation === "restricted") return <span className="badge restricted">殿堂</span>;
  return null;
}

const yearText = (p: PrintingBrief) => (p.releaseYear ? `${p.releaseYear}年${p.releaseEstimated ? "頃" : ""}` : "");

function PrintingMeta({ p }: { p: PrintingBrief }) {
  return (
    <>
      {p.setLabel ?? p.setCode ?? ""} {yearText(p)}
      <br />
      {p.number ?? ""} · {p.rarity ?? ""} · illust. {p.illustrator ?? "-"}
      {p.flavor ? (
        <>
          <br />
          <i>{p.flavor}</i>
        </>
      ) : null}
    </>
  );
}

const ZONE_NAME: Record<Zone, string> = { main: "メインデッキ", hyperspatial: "超次元ゾーン", gr: "超GRゾーン" };

/**
 * Card detail dialog. `onQuery` turns keyword/tag pills into searches; `onAdd` (deck builder)
 * shows an "add to deck" button.
 */
export function CardModal({
  id,
  printingId,
  onClose,
  onQuery,
  onAdd,
}: {
  id: number | string;
  printingId?: string;
  onClose: () => void;
  onQuery?: (q: string) => void;
  onAdd?: (card: CardDetail) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const meta = useCardMeta();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | undefined>(printingId);

  useEffect(() => {
    ref.current?.showModal();
    api.card(id).then(setCard, (e: Error) => setError(e.message));
  }, [id]);

  const tagLabel = Object.fromEntries((meta?.tags ?? []).map((t) => [t.tag, t.label]));
  const p = card ? (card.printings.find((x) => x.id === sel) ?? card.printings[0]) : undefined;
  const premium = card?.regulation === "premium";
  const legal = (ok: boolean, label: string) => <span className={`badge ${ok ? "ok" : "no"}`}>{`${label}${ok ? "可" : "不可"}`}</span>;
  const query = (q: string) => {
    if (!onQuery) return;
    ref.current?.close();
    onQuery(q);
  };

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <form method="dialog" className="dialog-close">
        <button aria-label="閉じる">×</button>
      </form>
      <div id="card-detail">
        {error && <div className="error">{error}</div>}
        {!card && !error && <p className="muted">読み込み中…</p>}
        {card && (
          <div className="detail">
            <div>
              <div className="main-img">{p?.image && <img src={p.image} alt={card.name} />}</div>
              <div className="muted small">{p && <PrintingMeta p={p} />}</div>
              {onAdd && (
                <button className="primary" style={{ marginTop: 10, width: "100%" }} onClick={() => onAdd(card)}>
                  デッキに追加
                </button>
              )}
            </div>
            <div>
              <h2>{card.name}</h2>
              <div>
                <RegBadge regulation={card.regulation} />
                {legal(card.legalOriginal && !premium, "オリジナル")}
                {legal(card.legalAdvance && !premium, "アドバンス")}
                <span className="badge">{ZONE_NAME[card.zone]}</span>
                {card.deckLimit === null && <span className="badge">枚数制限なし</span>}
              </div>
              {card.faces.map((f, i) => (
                <div className="face" key={i}>
                  <h3>{f.name}</h3>
                  <div className="stats">
                    <div>
                      <b>種類</b>
                      {f.type}
                    </div>
                    <div>
                      <b>文明</b>
                      {f.civs.join("/") || "-"}
                    </div>
                    <div>
                      <b>コスト</b>
                      {f.costText || "-"}
                    </div>
                    <div>
                      <b>パワー</b>
                      {f.powerText || "-"}
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <b>種族</b>
                      {f.races.join(" / ") || "-"}
                    </div>
                  </div>
                  <ul className="abilities">
                    {f.abilities.length ? f.abilities.map((a, j) => <li key={j}>{a}</li>) : <li className="muted">（能力なし）</li>}
                  </ul>
                </div>
              ))}
              <div className="section-title">キーワード能力（抽出）</div>
              <div className="kw-list">
                {card.keywords.length === 0 && <span className="muted small">なし</span>}
                {card.keywords.map((k, i) => {
                  const v = k.value != null ? (k.value >= 1e9 ? "∞" : String(k.value)) : "";
                  const cls = k.scope === "others" ? "others" : k.conditional ? "cond" : "";
                  const title = k.scope === "others" ? "他のカードに与える" : k.conditional ? "条件付きで得る" : "常に持つ";
                  return (
                    <span
                      key={i}
                      className={`kw ${cls}`}
                      title={`${title}${k.valueText ? `：${k.valueText}` : ""}`}
                      onClick={() => query(`${k.scope === "others" ? "grant" : "kw"}:${k.keyword}`)}
                    >
                      {k.keyword}
                      {v ? ` ${v}` : ""}
                      {k.scope === "others" ? "（付与）" : k.conditional ? "（条件）" : ""}
                    </span>
                  );
                })}
              </div>
              {card.officialKeywords.length > 0 && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  公式の特殊能力分類: {card.officialKeywords.join(" / ")}
                </div>
              )}
              <div className="section-title">効果タグ（推定）</div>
              <div className="kw-list">
                {card.tags.length === 0 && <span className="muted small">なし</span>}
                {card.tags.map((t) => (
                  <span key={t} className="tagpill" onClick={() => query(`tag:${t}`)}>
                    {tagLabel[t] ?? t}
                  </span>
                ))}
              </div>
              <div className="section-title">収録・絵柄（{card.printings.length}）</div>
              <div className="printings">
                {card.printings.map((x) => (
                  <div key={x.id} className={`printing ${x.id === p?.id ? "sel" : ""}`} onClick={() => setSel(x.id)}>
                    {x.image && <img loading="lazy" src={thumb(x.image)!} alt="" />}
                    <div>
                      {x.setLabel?.split(" ")[0] ?? x.setCode ?? ""} {x.number ?? ""} <span className="muted">{yearText(x)}</span>
                    </div>
                    <div>
                      {x.rarity ?? ""} · {x.illustrator ?? ""}
                    </div>
                  </div>
                ))}
              </div>
              <div className="section-title">リンク</div>
              <div className="small">
                {p && (
                  <a href={`https://dm.takaratomy.co.jp/card/detail/?id=${encodeURIComponent(p.id)}`} target="_blank" rel="noopener">
                    公式カードページ
                  </a>
                )}
                {card.qaUrl && (
                  <>
                    {" · "}
                    <a href={card.qaUrl} target="_blank" rel="noopener">
                      公式Q&amp;A
                    </a>
                  </>
                )}
                {" · "}
                <a href={`https://dmwiki.net/${encodeURIComponent(`《${card.name.replace(" / ", "／")}》`)}`} target="_blank" rel="noopener">
                  DMwiki
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

/** Result tile (grid view). */
export function CardTile({ c, onClick, extra }: { c: CardItem; onClick: () => void; extra?: React.ReactNode }) {
  const img = thumb(c.printing?.image ?? c.image);
  const sub = c.printing ? `${c.printing.setLabel?.split(" ")[0] ?? ""} ${c.printing.rarity ?? ""}` : `${c.civs.join("/") || "無色"} · ${c.minCost ?? "-"}`;
  return (
    <div className="card-tile" onClick={onClick}>
      <div className="img">{img ? <img loading="lazy" src={img} alt={c.name} /> : <div className="noimg">{c.name}</div>}</div>
      <CivBar civs={c.civs} />
      <div className="cap">
        <div className="nm">{c.name}</div>
        <div className="muted">
          {sub} <RegBadge regulation={c.regulation} />
        </div>
      </div>
      {extra}
    </div>
  );
}

export const statLine = (c: CardItem) =>
  c.faces
    .map((f) => [f.type, f.costText && `コスト${f.costText}`, f.powerText && `パワー${f.powerText}`, f.races.join("/")].filter(Boolean).join(" · "))
    .join("  ／  ");

/** Result row (text view). */
export function CardRow({ c, onClick }: { c: CardItem; onClick: () => void }) {
  const img = thumb(c.printing?.image ?? c.image);
  const text = c.faces.map((f) => (c.faces.length > 1 ? `【${f.name}】\n` : "") + f.abilities.join("\n")).join("\n");
  return (
    <div className="list-item" onClick={onClick}>
      <div>{img && <img loading="lazy" src={img} alt="" />}</div>
      <div>
        <div className="nm">
          {c.name} <RegBadge regulation={c.regulation} />
        </div>
        <div className="meta">
          {c.civs.join("/") || "無色"} · {statLine(c)}
          {c.printing ? ` · ${c.printing.setLabel ?? ""} ${c.printing.number ?? ""} · ${c.printing.illustrator ?? ""}` : ""}
        </div>
        <div className="txt">{text}</div>
      </div>
    </div>
  );
}

export function Pager({ total, page, pageSize, onPage }: { total: number; page: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const nums = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pages))].sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  let prev = 0;
  for (const p of nums) {
    if (p - prev > 1)
      out.push(
        <span key={`gap${p}`} className="muted">
          …
        </span>,
      );
    out.push(
      <button key={p} className={p === page ? "active" : ""} onClick={() => onPage(p)}>
        {p}
      </button>,
    );
    prev = p;
  }
  return <div className="pager">{out}</div>;
}
