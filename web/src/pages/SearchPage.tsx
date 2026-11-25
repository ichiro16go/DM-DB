import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { CardModal, CardRow, CardTile, Pager } from "../components/Card";
import { FilterPanel } from "../components/FilterPanel";
import { emptyFilters, filtersToQuery, type Filters } from "../lib/query";
import type { SearchResult } from "../types";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const unique = params.get("unique") ?? "cards";
  const order = params.get("order") ?? "release";
  const dir = params.get("dir") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;

  const [draft, setDraft] = useState(q);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem("dm.view") as "grid" | "list") ?? "grid");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: number; printingId?: string } | null>(null);

  useEffect(() => setDraft(q), [q]);
  useEffect(() => localStorage.setItem("dm.view", view), [view]);

  useEffect(() => {
    let live = true;
    setError(null);
    api.search({ q, page, pageSize: 60, unique, order, dir }).then(
      (r) => live && setResult(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [q, page, unique, order, dir]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page");
    setParams(next);
  };
  const runQuery = (query: string) => update({ q: query });
  const onFilters = (f: Filters) => {
    setFilters(f);
    runQuery(filtersToQuery(f));
  };

  return (
    <section>
      <form
        className="querybar"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          runQuery(draft);
        }}
      >
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="例: kw:ブロッカー (c:光 or c:水) cost<=3 pow>=2000"
          spellCheck={false}
        />
        <select value={unique} onChange={(e) => update({ unique: e.target.value })} title="表示単位">
          <option value="cards">カード単位</option>
          <option value="prints">絵柄（収録）単位</option>
        </select>
        <select value={order} onChange={(e) => update({ order: e.target.value })} title="並び順">
          <option value="release">新しい順</option>
          <option value="first">初登場順</option>
          <option value="cost">コスト順</option>
          <option value="power">パワー順</option>
          <option value="name">名前順</option>
          <option value="printings">再録数順</option>
        </select>
        <select value={dir} onChange={(e) => update({ dir: e.target.value })} title="昇順/降順">
          <option value="">標準</option>
          <option value="asc">昇順</option>
          <option value="desc">降順</option>
        </select>
        <button type="submit" className="primary">
          検索
        </button>
      </form>
      {error && <div className="error">{error}</div>}

      <div className="layout">
        <FilterPanel value={filters} onChange={onFilters} />
        <div className="results-wrap">
          <div className="results-head">
            <span>{result && `${result.total.toLocaleString()} 件${result.unique === "prints" ? "（絵柄単位）" : ""}`}</span>
            <span className="view-toggle">
              <button type="button" className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>
                画像
              </button>
              <button type="button" className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
                テキスト
              </button>
            </span>
          </div>
          {result && result.items.length === 0 && <p className="muted">該当するカードはありません。</p>}
          {result && (
            <div className={view}>
              {result.items.map((c) =>
                view === "grid" ? (
                  <CardTile key={`${c.id}-${c.printing?.id ?? ""}`} c={c} onClick={() => setOpen({ id: c.id, printingId: c.printing?.id })} />
                ) : (
                  <CardRow key={`${c.id}-${c.printing?.id ?? ""}`} c={c} onClick={() => setOpen({ id: c.id, printingId: c.printing?.id })} />
                ),
              )}
            </div>
          )}
          {result && (
            <Pager
              total={result.total}
              page={result.page}
              pageSize={result.pageSize}
              onPage={(p) => {
                update({ page: String(p) });
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          )}
        </div>
      </div>
      {open && <CardModal id={open.id} printingId={open.printingId} onClose={() => setOpen(null)} onQuery={runQuery} />}
    </section>
  );
}
