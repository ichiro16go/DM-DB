import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, type DeckWrite } from "../api";
import { CardModal } from "../components/Card";
import { DeckList, visibleZones, ZoneTabs } from "../components/DeckList";
import { DeckSearchPanel } from "../components/DeckSearchPanel";
import { AnalysisPanels, ProblemSummary } from "../components/DeckStats";
import { MainCounter } from "../components/MainCounter";
import { FORMAT_ZONES, ZONE_LABEL, ZONES, zonesOf } from "../../../src/deck/rules";
import { Revisions } from "../components/Revisions";
import { addCard, deckToText, fmtDate, FORMAT_LABEL, normalize, STATUS_LABEL, total } from "../lib/deck";
import { useBeforeUnload, useDebounced } from "../lib/hooks";
import type { Deck, DeckAnalysis, DeckCard, DeckKind, DeckSource, DeckStatus, Format, Zone } from "../types";

/** Router state for /decks/new (from the meta page's "＋登録" or "コピーして新規"). */
export interface NewDeckState {
  kind?: DeckKind;
  format?: Format;
  archetype?: string | null;
  name?: string;
  source?: DeckSource | null;
  images?: string[];
  cards?: DeckCard[];
  note?: string;
}

interface Form {
  name: string;
  format: Format;
  archetype: string;
  status: DeckStatus;
  note: string;
  cards: DeckCard[];
}

const toForm = (d: Pick<Deck, "name" | "format" | "archetype" | "status" | "note" | "cards">): Form => ({
  name: d.name,
  format: d.format,
  archetype: d.archetype ?? "",
  status: d.status,
  note: d.note,
  cards: d.cards,
});
const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

export function DeckEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const init = (location.state ?? {}) as NewDeckState;

  const [deck, setDeck] = useState<Deck | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [form, setForm] = useState<Form>(() => ({
    name: init.name ?? "新しいデッキ",
    format: init.format ?? (params.get("format") === "advance" ? "advance" : "original"),
    archetype: init.archetype ?? "",
    status: init.kind === "meta" ? "partial" : "complete",
    note: init.note ?? "",
    cards: init.cards ?? [],
  }));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<DeckAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "conflict"; text: string } | null>(null);
  const [modal, setModal] = useState<number | null>(null);
  const [panel, setPanel] = useState<"search" | "photo" | "import" | "export">(init.images?.length ? "photo" : "search");
  const [importText, setImportText] = useState("");
  const [activeZone, setActiveZone] = useState<Zone>("main");

  const isNew = !id;
  const kind: DeckKind = deck?.kind ?? init.kind ?? "user";
  const source = deck?.source ?? init.source ?? null;
  const images = useMemo(() => [...new Set([...(init.images ?? []), ...(source?.image ? [source.image] : [])])], [init.images, source?.image]);
  const dirty = isNew ? form.cards.length > 0 : saved !== null && !same(form, saved);
  useBeforeUnload(dirty);

  const applyLoaded = useCallback((r: { deck: Deck; version: string; analysis?: DeckAnalysis }) => {
    setDeck(r.deck);
    setVersion(r.version);
    const f = toForm(r.deck);
    setSaved(f);
    setForm(f);
    if (r.analysis) setAnalysis(r.analysis);
  }, []);

  const load = useCallback(() => {
    if (!id) return;
    setLoadError(null);
    api.deck(id).then(applyLoaded, (e: Error) => setLoadError(e.message));
  }, [id, applyLoaded]);
  useEffect(load, [load]);

  // Live analysis (name resolution + construction rules) while editing.
  const dCards = useDebounced(form.cards, 350);
  const lastAnalyzed = useRef<string>("");
  useEffect(() => {
    const k = JSON.stringify([form.format, dCards]);
    if (k === lastAnalyzed.current) return;
    lastAnalyzed.current = k;
    let live = true;
    setAnalyzing(true);
    api.analyze(form.format, dCards).then(
      (a) => live && (setAnalysis(a), setAnalyzing(false)),
      () => live && setAnalyzing(false),
    );
    return () => {
      live = false;
    };
  }, [dCards, form.format]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const setCards = (cards: DeckCard[]) => set({ cards });
  const add = (zone: Zone, name: string, n = 1) => setForm((f) => ({ ...f, cards: addCard(f.cards, zone, name, n) }));
  /** From search / card dialog: the card goes to the zone it belongs to, and that tab opens. */
  const addFromSearch = (zone: Zone, name: string) => {
    add(zone, name);
    if (zone !== activeZone) setActiveZone(zone);
  };

  // Per-card problems (copy limits, wrong zone …) are shown on the card's row.
  const rowProblems = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of analysis?.report.problems ?? []) {
      if (!p.card || /^カードが見つかりません/.test(p.message)) continue;
      m.set(p.card, [
        ...(m.get(p.card) ?? []),
        p.message
          .replace(/[:：]?\s*《[^》]*》(×\d+)?/g, "")
          .replace(/^は/, "")
          .trim(),
      ]);
    }
    return m;
  }, [analysis]);
  // Rows with a warning: cards with a rule problem + names the DB could not identify.
  const rowWarnCount = rowProblems.size + (analysis?.cards.filter((c) => !c.cardId).length ?? 0);

  const body = (): DeckWrite => ({
    name: form.name.trim() || "無題のデッキ",
    format: form.format,
    archetype: form.archetype.trim() || null,
    status: form.status,
    note: form.note,
    cards: form.cards,
  });

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setMessage({ kind: "conflict", text: e.message });
    else setMessage({ kind: "error", text: (e as Error).message });
  };

  const save = async (overwrite = false) => {
    setBusy(true);
    setMessage(null);
    try {
      if (isNew) {
        const r = await api.createDeck({ ...body(), kind, source });
        applyLoaded(r);
        navigate(`/decks/${r.deck.id}`, { replace: true });
      } else {
        // overwrite: re-read the latest version and save this form over it (the other edit stays in history)
        const v = overwrite ? (await api.deck(id!)).version : version!;
        applyLoaded(await api.updateDeck(id!, v, body()));
      }
      setMessage({ kind: "ok", text: "保存しました" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!busy) void save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const restore = async (index: number) => {
    setBusy(true);
    try {
      applyLoaded(await api.restoreDeck(id!, version!, index));
      setMessage({ kind: "ok", text: "以前の版に戻しました" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`「${form.name}」を削除しますか？（元に戻せません）`)) return;
    try {
      await api.deleteDeck(id!, version!);
      navigate("/decks", { replace: true });
    } catch (e) {
      fail(e);
    }
  };

  const copy = () => {
    const state: NewDeckState = {
      kind: "user",
      format: form.format,
      archetype: form.archetype || null,
      name: `${form.name}のコピー`.slice(0, 80),
      cards: form.cards,
    };
    navigate("/decks/new", { state });
  };

  const doImport = async (mode: "replace" | "append") => {
    try {
      const { cards } = await api.parse(importText);
      setCards(mode === "replace" ? cards : normalize([...form.cards, ...cards]));
      setImportText("");
      setPanel("search");
    } catch (e) {
      fail(e);
    }
  };

  if (loadError) return <div className="error">{loadError}</div>;
  if (!isNew && !deck) return <p className="muted">読み込み中…</p>;

  const liveCounts = Object.fromEntries(ZONES.map((z) => [z, total(form.cards, z)])) as Record<Zone, number>;
  const zones = visibleZones(form.format, form.cards);
  const tab = zones.includes(activeZone) ? activeZone : "main";
  const ownZones = zonesOf(form.format);

  return (
    <section className="deck-editor">
      <div className="editor-bar">
        <Link className="back" to={kind === "meta" && form.archetype ? `/meta?format=${form.format}` : "/decks"}>
          ← {kind === "meta" ? "環境デッキ" : "デッキ一覧"}
        </Link>
        <label className="name-field">
          <span>デッキ名</span>
          <input value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <span className="seg" role="group" aria-label="フォーマット">
          {(["original", "advance"] as Format[]).map((f) => (
            <button key={f} type="button" className={form.format === f ? "active" : ""} onClick={() => set({ format: f })}>
              {FORMAT_LABEL[f]}
            </button>
          ))}
        </span>
        <span className="spacer" />
        <MainCounter n={liveCounts.main} />
        <span className="zone-counts">
          {ownZones
            .filter((z) => z !== "main")
            .map((z) => (
              <span key={z} className={liveCounts[z] > (FORMAT_ZONES[form.format][z]?.max ?? Infinity) ? "over" : ""}>
                {ZONE_LABEL[z]} <b>{liveCounts[z]}</b>/{FORMAT_ZONES[form.format][z]?.max}
              </span>
            ))}
        </span>
        {dirty && <span className="unsaved">未保存</span>}
        {!isNew && dirty && (
          <button type="button" onClick={() => saved && setForm(saved)} disabled={busy}>
            破棄
          </button>
        )}
        <button type="button" className="primary" onClick={() => save()} disabled={busy || (!isNew && !dirty)} title="Ctrl+S">
          {isNew ? "作成" : "保存"}
        </button>
      </div>

      {message && (
        <div className={message.kind === "ok" ? "notice ok" : "error"} role="status">
          {message.text}
          {message.kind === "conflict" && (
            <span className="conflict-actions">
              <button type="button" onClick={() => (setMessage(null), load())}>
                最新を読み込む（自分の変更は破棄）
              </button>
              <button type="button" onClick={() => save(true)}>
                自分の内容で上書き保存
              </button>
            </span>
          )}
        </div>
      )}

      <div className="deck-meta">
        <span className={`kind-badge ${kind}`}>{kind === "meta" ? "環境デッキ（入賞リスト）" : "マイデッキ"}</span>
        <label>
          デッキタイプ
          <input value={form.archetype} maxLength={80} placeholder="例: 赤零ジョーカーズ" onChange={(e) => set({ archetype: e.target.value })} />
        </label>
        <label>
          リストの状態
          <select value={form.status} onChange={(e) => set({ status: e.target.value as DeckStatus })}>
            {(Object.keys(STATUS_LABEL) as DeckStatus[]).map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        </label>
        {deck && (
          <span className="muted small">
            最終更新 {fmtDate(deck.updatedAt)} {deck.updatedBy && `by ${deck.updatedBy}`}
          </span>
        )}
      </div>

      {source && (
        <div className="panel source small">
          入賞: <b>{source.rank}</b> {source.player && `${source.player}さん`} ／{" "}
          <a href={source.url} target="_blank" rel="noopener">
            {source.eventName ?? "CS結果記事"}
          </a>{" "}
          {source.date} ／ 表記「{source.archetype}」
          {images.length > 0 && (
            <button type="button" className="link" onClick={() => setPanel("photo")}>
              デッキ画像を見ながら編集
            </button>
          )}
        </div>
      )}

      <div className={`editor-grid ${panel === "photo" ? "wide-side" : ""}`}>
        <div className={`deck-col ${analyzing ? "pending" : ""}`}>
          <ProblemSummary analysis={analysis} rowCount={rowWarnCount} />
          <ZoneTabs zones={zones} active={tab} counts={liveCounts} onSelect={setActiveZone} format={form.format} />
          <DeckList zone={tab} cards={form.cards} analysis={analysis} rowProblems={rowProblems} onChange={setCards} onOpen={setModal} />
          <AnalysisPanels analysis={analysis} />
          <label className="f note">
            メモ
            <textarea
              rows={3}
              value={form.note}
              maxLength={2000}
              onChange={(e) => set({ note: e.target.value })}
              placeholder="採用理由・不明カードの補足など"
            />
          </label>
          {deck && (
            <>
              <div className="section-title">編集履歴（{deck.revisions.length}）</div>
              <Revisions deck={deck} onRestore={restore} busy={busy || dirty} />
              {dirty && deck.revisions.length > 0 && <p className="muted small">未保存の変更があるときは履歴から戻せません。</p>}
              <div className="danger-zone">
                <button type="button" onClick={copy}>
                  コピーしてマイデッキを作る
                </button>
                <button type="button" className="danger" onClick={remove}>
                  このデッキを削除
                </button>
              </div>
            </>
          )}
        </div>

        <div className="side">
          <div className="seg">
            <button type="button" className={panel === "search" ? "active" : ""} onClick={() => setPanel("search")}>
              カード検索
            </button>
            {images.length > 0 && (
              <button type="button" className={panel === "photo" ? "active" : ""} onClick={() => setPanel("photo")}>
                デッキ画像
              </button>
            )}
            <button type="button" className={panel === "import" ? "active" : ""} onClick={() => setPanel("import")}>
              テキスト取込
            </button>
            <button type="button" className={panel === "export" ? "active" : ""} onClick={() => setPanel("export")}>
              書き出し
            </button>
          </div>
          {panel === "search" && <DeckSearchPanel format={form.format} cards={form.cards} onAdd={addFromSearch} onOpen={setModal} />}
          {panel === "photo" && (
            <div className="photos">
              <p className="muted small">主催者のデッキ画像（クリックで原寸）。画像とリストを見比べて修正してください。</p>
              {images.map((src) => (
                <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                  <img src={src} alt="デッキ画像" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
          )}
          {panel === "import" && (
            <div className="import">
              <p className="muted small">
                1行に「枚数 カード名」。<code>超次元</code> / <code>GR</code> / <code>特殊枠</code> の行以降はそのゾーン。
              </p>
              <textarea
                rows={16}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                spellCheck={false}
                placeholder={"4 カード名\n4 カード名\n\n超次元\n1 カード名"}
              />
              <div className="row">
                <button type="button" className="primary" disabled={!importText.trim()} onClick={() => doImport("replace")}>
                  置き換え
                </button>
                <button type="button" disabled={!importText.trim()} onClick={() => doImport("append")}>
                  追加
                </button>
              </div>
            </div>
          )}
          {panel === "export" && (
            <div className="import">
              <textarea rows={16} readOnly value={deckToText(form.cards)} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(deckToText(form.cards)).then(() => setMessage({ kind: "ok", text: "コピーしました" }))}
              >
                クリップボードにコピー
              </button>
            </div>
          )}
        </div>
      </div>
      {modal !== null && (
        <CardModal
          id={modal}
          onClose={() => setModal(null)}
          onAdd={(c) => {
            addFromSearch(c.startsInBattleZone ? "special" : c.zone, c.name);
            setMessage({ kind: "ok", text: `${c.name} を追加しました` });
          }}
        />
      )}
    </section>
  );
}
