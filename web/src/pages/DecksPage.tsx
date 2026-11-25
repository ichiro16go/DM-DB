import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { fmtDate, FORMAT_LABEL } from "../lib/deck";
import { useAsync } from "../lib/hooks";
import type { DeckSummary } from "../types";
import { StatusPill } from "./MetaPage";

/** All registered decks: my decks and meta (CS placement) lists, filterable. */
export function DecksPage() {
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") ?? "";
  const format = params.get("format") ?? "";
  const [text, setText] = useState("");
  const { data, error, loading } = useAsync(() => api.decks({ fresh: true }), []);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    setParams(next);
  };
  const list = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (data?.decks ?? [])
      .filter((d) => (!kind || d.kind === kind) && (!format || d.format === format))
      .filter((d) => !t || `${d.name} ${d.archetype ?? ""} ${d.source?.eventName ?? ""} ${d.source?.player ?? ""}`.toLowerCase().includes(t))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [data, kind, format, text]);

  return (
    <section>
      <div className="page-head">
        <h1>デッキ</h1>
        <Link className="button primary" to={`/decks/new${format ? `?format=${format}` : ""}`}>
          ＋ 新しいデッキ
        </Link>
      </div>
      <div className="toolbar">
        <span className="seg">
          {[
            ["", "すべて"],
            ["user", "マイデッキ"],
            ["meta", "環境デッキ"],
          ].map(([v, l]) => (
            <button key={v} type="button" className={kind === v ? "active" : ""} onClick={() => set("kind", v!)}>
              {l}
            </button>
          ))}
        </span>
        <select value={format} onChange={(e) => set("format", e.target.value)}>
          <option value="">全フォーマット</option>
          <option value="original">{FORMAT_LABEL.original}</option>
          <option value="advance">{FORMAT_LABEL.advance}</option>
        </select>
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="名前・デッキタイプ・大会・プレイヤーで絞り込み" />
      </div>
      {error && <div className="error">{error.message}</div>}
      {loading && !data && <p className="muted">読み込み中…</p>}
      {data && list.length === 0 && <p className="muted">デッキがありません。</p>}
      <table className="data decks">
        <tbody>
          {list.map((d: DeckSummary) => (
            <tr key={d.id}>
              <td>
                <span className={`kind-badge ${d.kind}`}>{d.kind === "meta" ? "環境" : "マイ"}</span>
              </td>
              <td>
                <Link to={`/decks/${d.id}`}>
                  <b>{d.name}</b>
                </Link>
                <div className="muted small">
                  {d.archetype}
                  {d.source && ` · ${d.source.date ?? ""} ${d.source.rank} ${d.source.player ? `${d.source.player}さん` : ""}`}
                </div>
              </td>
              <td className="small">{FORMAT_LABEL[d.format]}</td>
              <td className="num small">{d.cardCount}枚</td>
              <td>
                <StatusPill status={d.status} />
              </td>
              <td className="small muted">{fmtDate(d.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
