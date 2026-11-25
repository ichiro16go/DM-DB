import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { FORMAT_LABEL } from "../lib/deck";
import { useAsync } from "../lib/hooks";
import type { DeckSource, Format, PlacementRow } from "../types";
import { fmtPeriod, StatusPill } from "./MetaPage";
import type { NewDeckState } from "./DeckEditorPage";

/** One archetype of one week: its placements (with organiser photos) and registered lists. */
export function ArchetypePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const format: Format = params.get("format") === "advance" ? "advance" : "original";
  const name = params.get("name") ?? "";
  const week = params.get("week");
  const { data, error } = useAsync(() => api.entry(format, name, week), [format, name, week]);

  const register = (p: PlacementRow) => {
    const source: DeckSource = {
      eventId: p.eventId,
      placementIdx: p.idx,
      url: p.url,
      image: p.images[0] ?? null,
      eventName: p.eventName,
      date: p.date,
      rank: p.rankLabel,
      player: p.player,
      archetype: p.archetype,
    };
    const state: NewDeckState = {
      kind: "meta",
      format,
      archetype: name,
      name: `${p.archetype}（${p.eventName ?? ""} ${p.rankLabel}）`.slice(0, 80),
      source,
      images: p.images,
    };
    navigate("/decks/new", { state });
  };

  return (
    <section>
      <div className="page-head">
        <Link to={`/meta?${new URLSearchParams({ format, ...(week ? { week } : {}) })}`}>← 環境デッキ一覧</Link>
      </div>
      {error && <div className="error">{error.message}</div>}
      {data && (
        <>
          <h1>
            {data.entry.name} <span className="muted small">{FORMAT_LABEL[format]}</span>
          </h1>
          <div className="panel">
            {fmtPeriod(data.snapshot.periodStart, data.snapshot.periodEnd)}: <b>{data.entry.rank}位</b> 入賞 {data.entry.count} 回 / シェア{" "}
            <b>{data.entry.share}%</b>
            {data.entry.note && <div className="muted small">内訳: {data.entry.note}</div>}
          </div>

          <h2>登録済みのデッキリスト（{data.decks.length}）</h2>
          {data.decks.length === 0 && <p className="muted">まだありません。下の入賞結果から画像を見て登録できます。</p>}
          <div className="deck-cards">
            {data.decks.map((d) => (
              <Link key={d.id} to={`/decks/${d.id}`} className="deck-card">
                <div className="nm">{d.name}</div>
                <div className="small muted">
                  {d.source?.date} {d.source?.player && `${d.source.player}さん`} · {d.cardCount}枚 <StatusPill status={d.status} />
                </div>
              </Link>
            ))}
          </div>

          <h2>入賞結果（{data.placements.length}）</h2>
          <p className="muted small">田園補完計画の CS 結果記事から取得した上位入賞。画像は主催者の投稿です。</p>
          <table className="data placements">
            <thead>
              <tr>
                <th>日付</th>
                <th>大会</th>
                <th>順位</th>
                <th>プレイヤー</th>
                <th>表記</th>
                <th>画像</th>
                <th>リスト</th>
              </tr>
            </thead>
            <tbody>
              {data.placements.map((p) => (
                <tr key={`${p.eventId}-${p.idx}`}>
                  <td className="small">{p.date?.slice(5).replace("-", "/")}</td>
                  <td className="small">
                    <a href={p.url} target="_blank" rel="noopener">
                      {p.eventName ?? `記事 ${p.eventId}`}
                    </a>
                    <div className="muted">{[p.store, p.region, p.players && `${p.players}人`].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>{p.rankLabel}</td>
                  <td className="small">{p.player}</td>
                  <td className="small">{p.archetype}</td>
                  <td>
                    <span className="thumbs">
                      {p.images.map((src, i) => (
                        <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                          <img src={src} alt={`デッキ画像${i + 1}`} loading="lazy" referrerPolicy="no-referrer" />
                        </a>
                      ))}
                      {p.images.length === 0 && <span className="muted small">なし</span>}
                    </span>
                  </td>
                  <td>
                    {p.deckId ? (
                      <Link to={`/decks/${p.deckId}`}>表示・修正</Link>
                    ) : (
                      <button type="button" className="small-btn" onClick={() => register(p)}>
                        ＋登録
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
